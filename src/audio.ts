import type { AudioEntry } from './data';

const FADE_IN_MS = 900;
const FADE_OUT_MS = 600;
/** `?test` lets automated runs mute elements without tripping the "sound turned off" detector. */
const IGNORE_MUTED = new URLSearchParams(location.search).has('test');

/** 8-bit mono silence at 8 kHz: inaudible, but a real, unmuted media element. */
export function silentWav(samples = 100): string {
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, s: string): void => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  tag(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  tag(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44); // 8-bit PCM silence is the midpoint
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

interface AutoplayNavigator {
  getAutoplayPolicy(type: 'mediaelement'): 'allowed' | 'allowed-muted' | 'disallowed';
}

function hasAutoplayPolicy(n: Navigator): n is Navigator & AutoplayNavigator {
  return 'getAutoplayPolicy' in n && typeof n.getAutoplayPolicy === 'function';
}

/** True when an unmuted element may start without a user gesture. */
export async function audioAllowed(): Promise<boolean> {
  if (hasAutoplayPolicy(navigator)) return navigator.getAutoplayPolicy('mediaelement') === 'allowed';
  // No policy API (Safari): ask the browser the only way it answers, by trying.
  const probe = new Audio(silentWav());
  try {
    await probe.play();
    probe.pause();
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') return false;
    throw e;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A creature's sound while it is audible: a looping buffer source behind its own gain. */
interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** ctx.currentTime when the source started, and the buffer offset it started from */
  startedAt: number;
  offset: number;
  duration: number;
}

/** Decoded buffers are ~6 MB each, so only a few stay in memory. */
const MAX_DECODED = 4;

export interface Player {
  /** Start fetching and decoding a creature's audio so the click plays without a gap. */
  preload(id: string): void;
  /** Crossfade to a creature's track; null fades everything out. */
  play(id: string | null): Promise<void>;
  /** Call inside a user gesture: records the activation and keeps one AudioContext running. */
  unlock(): Promise<void>;
  /** Register the callback for "sound was turned off". Fires at most once until `resume()`. */
  onLost(cb: () => void): void;
  /** Stop where we stand (after a loss); `resume()` continues the track. */
  suspend(): void;
  resume(): Promise<void>;
  /** Title for the OS media controls (not app UI); null clears it. */
  setTitle(title: string | null): void;
}

/**
 * Web Audio playback: each clicked track is fetched and decoded on demand and looped by an
 * AudioBufferSourceNode, which (unlike <audio loop>, measured at a ~20 ms hole per wrap) loops
 * sample-exactly with the files' gapless headers. Crossfades are gain ramps.
 *
 * "Sound turned off" is whatever the page can see: the AudioContext leaving `running` (Safari
 * reports `interrupted`), a rejected/stalled resume, a Media Session pause/stop (media keys,
 * lock screen), a pause or mute of the silent keep-alive element that makes those controls
 * route to us, or the tab coming back with autoplay blocked. OS volume and tab mute are invisible.
 */
export function createPlayer(entries: ReadonlyMap<string, AudioEntry>, host: HTMLElement): Player {
  let current: string | null = null;
  let lost = false;
  let unlocked = false;
  let lostCb: () => void = () => {};

  function signalLost(): void {
    if (lost) return;
    lost = true;
    lostCb();
  }

  // --- context ---
  let ctx: AudioContext | null = null;
  let expectRunning = false;

  function context(): AudioContext {
    if (!ctx) {
      const created = new AudioContext();
      created.addEventListener('statechange', () => {
        if (expectRunning && created.state !== 'running') signalLost();
      });
      ctx = created;
    }
    return ctx;
  }

  /** Resume the context; `resume()` stays pending while autoplay is blocked, so do not wait forever. */
  async function running(): Promise<AudioContext> {
    const c = context();
    if (c.state !== 'running') await Promise.race([c.resume(), sleep(300)]);
    return c;
  }

  // --- keep-alive: a silent looping <audio> so media keys / lock screen route to this page ---
  const keepAlive = new Audio(silentWav(8000));
  keepAlive.loop = true;
  keepAlive.dataset.keepalive = '';
  host.appendChild(keepAlive);
  let keepAlivePauses = 0;
  keepAlive.addEventListener('pause', () => {
    if (keepAlivePauses > 0) {
      keepAlivePauses--;
      return;
    }
    if (current !== null && !lost) signalLost();
  });
  keepAlive.addEventListener('volumechange', () => {
    if (current !== null && keepAlive.muted && !IGNORE_MUTED) signalLost();
  });
  function keepAliveOn(on: boolean): void {
    // If the browser refuses this silent element the music still plays; only media-key routing is lost.
    if (on && keepAlive.paused) void keepAlive.play().catch(() => {});
    if (!on && !keepAlive.paused) {
      keepAlivePauses++;
      keepAlive.pause();
    }
  }

  // --- buffers ---
  const decoded = new Map<string, Promise<AudioBuffer>>();

  function load(id: string): Promise<AudioBuffer> {
    const cached = decoded.get(id);
    if (cached) {
      decoded.delete(id); // re-insert last: Map order doubles as LRU order
      decoded.set(id, cached);
      return cached;
    }
    const entry = entries.get(id);
    if (!entry) return Promise.reject(new Error(`no audio for ${id}`));
    const promise = fetch(`/${entry.file}`)
      .then((res) => {
        if (!res.ok) throw new Error(`${entry.file}: HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((bytes) => context().decodeAudioData(bytes));
    promise.catch(() => decoded.delete(id));
    decoded.set(id, promise);
    for (const key of decoded.keys()) {
      if (decoded.size <= MAX_DECODED) break;
      if (key !== id && key !== current) decoded.delete(key);
    }
    return promise;
  }

  // --- voices ---
  const voices = new Map<string, Voice>();
  /** Where a suspended track stopped, in seconds into its buffer. */
  const parked = new Map<string, number>();

  function fadeTo(voice: Voice, c: AudioContext, level: number, ms: number): void {
    const now = c.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(level, now + ms / 1000);
  }

  function startVoice(id: string, buffer: AudioBuffer, c: AudioContext, offset: number): void {
    const entry = entries.get(id);
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.loop = entry?.loop ?? true;
    const gain = c.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(c.destination);
    const startedAt = c.currentTime;
    source.start(0, offset % buffer.duration);
    const voice: Voice = { source, gain, startedAt, offset, duration: buffer.duration };
    voices.set(id, voice);
    fadeTo(voice, c, 1, FADE_IN_MS);
  }

  function position(voice: Voice, c: AudioContext): number {
    return (voice.offset + (c.currentTime - voice.startedAt)) % voice.duration;
  }

  function releaseVoice(id: string, c: AudioContext, fadeMs: number): void {
    const voice = voices.get(id);
    if (!voice) return;
    voices.delete(id);
    fadeTo(voice, c, 0, fadeMs);
    voice.source.stop(c.currentTime + fadeMs / 1000 + 0.02);
    voice.source.addEventListener('ended', () => {
      voice.source.disconnect();
      voice.gain.disconnect();
    });
  }

  async function play(id: string | null): Promise<void> {
    const c = ctx;
    if (current !== null && current !== id && c) releaseVoice(current, c, FADE_OUT_MS);
    if (current !== id) parked.delete(current ?? '');
    current = id;
    if (id === null) {
      keepAliveOn(false);
      return;
    }
    if (voices.has(id)) return;
    keepAliveOn(true);
    const live = await running();
    if (live.state !== 'running') {
      signalLost();
      return;
    }
    const buffer = await load(id);
    // Superseded or deselected while fetching/decoding.
    if (current !== id || voices.has(id)) return;
    startVoice(id, buffer, live, parked.get(id) ?? 0);
    parked.delete(id);
  }

  // --- unlocking from a gesture ---
  async function unlock(): Promise<void> {
    const c = context();
    // Play and pause a silent clip inside the gesture too: Safari wants an element, not only a context.
    const clip = new Audio(silentWav());
    const prime = keepAlive.paused
      ? keepAlive.play().then(() => {
          keepAlivePauses++; // our own pause, not a media key
          keepAlive.pause();
        })
      : Promise.resolve();
    await Promise.all([clip.play().then(() => clip.pause()), prime, Promise.race([c.resume(), sleep(300)])]);
    expectRunning = c.state === 'running';
    unlocked = true;
  }

  // --- OS media controls count as "sound off" when they pause us ---
  if ('mediaSession' in navigator) {
    for (const action of ['pause', 'stop'] as const) {
      try {
        navigator.mediaSession.setActionHandler(action, signalLost);
      } catch (e) {
        if (!(e instanceof TypeError)) throw e; // action not supported by this browser
      }
    }
  }

  // Coming back to the tab is a cheap moment to notice that autoplay was revoked meanwhile.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !unlocked || lost) return;
    void audioAllowed().then((ok) => {
      if (!ok || (expectRunning && ctx !== null && ctx.state !== 'running')) signalLost();
    });
  });

  const player: Player = {
    preload(id) {
      if (entries.has(id)) void load(id).catch(() => {}); // a failed warm-up is retried by the click
    },
    play,
    unlock,
    onLost(cb) {
      lostCb = cb;
    },
    suspend() {
      const c = ctx;
      if (c) {
        for (const [id, voice] of voices) {
          parked.set(id, position(voice, c));
          voice.source.stop();
          voice.source.disconnect();
          voice.gain.disconnect();
        }
      }
      voices.clear();
      keepAliveOn(false);
    },
    async resume() {
      lost = false;
      const id = current;
      if (id === null) return;
      current = null;
      await play(id);
    },
    setTitle(title) {
      if (!('mediaSession' in navigator)) return;
      navigator.mediaSession.metadata = title === null ? null : new MediaMetadata({ title });
    },
  };
  return player;
}
