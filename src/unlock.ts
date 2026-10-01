/**
 * The wallet unlock: after a visitor has looked at UNLOCK_AFTER distinct creatures, a short
 * notification chime plays once and `onUnlock` fires. The viewed set and the unlocked flag live in
 * localStorage, so a returning visitor is unlocked straight away, silently.
 */

const UNLOCK_AFTER = 5;
const VIEWED_KEY = 'river-globe:viewed';
const UNLOCKED_KEY = 'river-globe:unlocked';
const CHIME_SRC = '/sfx/unlock.mp3';
const CHIME_VOLUME = 0.6;

export interface Unlock {
  /** Record that a creature was picked from the index; unlocks on the fifth distinct one. */
  recordView(creatureId: string): void;
  /** True once unlocked (this visit or an earlier one). */
  readonly unlocked: boolean;
}

function readViewed(): Set<string> {
  try {
    const raw = localStorage.getItem(VIEWED_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set(); // storage blocked or the value is not JSON
  }
}

function readUnlocked(): boolean {
  try {
    return localStorage.getItem(UNLOCKED_KEY) === '1';
  } catch {
    return false;
  }
}

function persist(viewed: ReadonlySet<string>, unlocked: boolean): void {
  try {
    localStorage.setItem(VIEWED_KEY, JSON.stringify([...viewed]));
    if (unlocked) localStorage.setItem(UNLOCKED_KEY, '1');
  } catch {
    // private mode or quota: the unlock just will not outlive this visit
  }
}

/**
 * Plays the chime on its own element, never inside the player's hidden div, so the player's
 * "sound turned off" detector cannot mistake it for a river track. The browser's autoplay rule is
 * the sound gate here: a blocked play() is silently dropped.
 */
function playChime(): void {
  const chime = new Audio(CHIME_SRC);
  chime.volume = CHIME_VOLUME;
  chime.play().catch((e: unknown) => {
    if (!(e instanceof DOMException) || (e.name !== 'NotAllowedError' && e.name !== 'AbortError')) throw e;
  });
}

export function createUnlock(opts: { onUnlock: () => void }): Unlock {
  const viewed = readViewed();
  let unlocked = readUnlocked();
  if (!unlocked && viewed.size >= UNLOCK_AFTER) {
    // e.g. the flag could not be written last time; the set says it was earned
    unlocked = true;
    persist(viewed, true);
  }

  return {
    get unlocked() {
      return unlocked;
    },
    recordView(creatureId) {
      if (viewed.has(creatureId)) return;
      viewed.add(creatureId);
      if (unlocked || viewed.size < UNLOCK_AFTER) {
        persist(viewed, unlocked);
        return;
      }
      unlocked = true;
      persist(viewed, true);
      playChime();
      opts.onUnlock();
    },
  };
}
