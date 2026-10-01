import { pixelSvg } from './pixel';

/**
 * Browsers have no audio permission prompt; the gate is the autoplay policy. If audible
 * playback is not allowed (before a gesture, or because sound was turned off later), a pixel
 * speaker with a sad face blocks the page and asks for one click, and that click unlocks audio.
 * Once sound is on (or was allowed all along) a speaker with a smile holds for a moment and
 * fades away. No text.
 */

/** 13x9 speaker with sound waves. */
const SPEAKER_ON = [
  '.....X.......',
  '....XX....X..',
  'XXXXXX.....X.',
  'XXXXXX..X..X.',
  'XXXXXX..X..X.',
  'XXXXXX..X..X.',
  'XXXXXX.....X.',
  '....XX....X..',
  '.....X.......',
];

/** The same speaker, silenced with a cross. */
const SPEAKER_OFF = [
  '.....X.......',
  '....XX.......',
  'XXXXXX.X...X.',
  'XXXXXX..X.X..',
  'XXXXXX...X...',
  'XXXXXX..X.X..',
  'XXXXXX.X...X.',
  '....XX.......',
  '.....X.......',
];

const FACE_HAPPY = [
  '..XXXXX..',
  '.X.....X.',
  'X..X.X..X',
  'X..X.X..X',
  'X.......X',
  'X.X...X.X',
  'X..XXX..X',
  '.X.....X.',
  '..XXXXX..',
];

const FACE_SAD = [
  '..XXXXX..',
  '.X.....X.',
  'X..X.X..X',
  'X..X.X..X',
  'X.......X',
  'X..XXX..X',
  'X.X...X.X',
  '.X.....X.',
  '..XXXXX..',
];

const EXIT_MS = 220;
/** How long the smile holds before the gate fades out. */
const HOLD_MS = 2000;

function pair(kind: 'blocked' | 'enabled'): HTMLSpanElement {
  const wrap = document.createElement('span');
  wrap.className = 'gate-pair';
  wrap.dataset.kind = kind;
  const blocked = kind === 'blocked';
  wrap.append(pixelSvg(blocked ? SPEAKER_OFF : SPEAKER_ON, 3), pixelSvg(blocked ? FACE_SAD : FACE_HAPPY, 3));
  return wrap;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the sound gate and resolve once it has left the screen.
 * While the blocked state is up the dialog is modal (inert page, focus trap) and `onModal`
 * reports it so the globe can stop reading drag and wheel.
 */
export async function runSoundGate(opts: {
  /** True when audible playback already works: the gate then only greets, with no click. */
  allowed: boolean;
  /** Runs inside the click (or straight away when allowed) to unlock audio. */
  unlock: () => Promise<void>;
  onModal: (open: boolean) => void;
}): Promise<void> {
  const { allowed, unlock, onModal } = opts;

  const dialog = document.createElement('dialog');
  dialog.className = 'gate';
  dialog.dataset.state = allowed ? 'enabled' : 'blocked';
  dialog.dataset.modal = String(!allowed);
  dialog.setAttribute('aria-label', 'Sound');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'gate-card';
  button.setAttribute('aria-label', 'Enable sound');
  button.append(pair('blocked'), pair('enabled'));
  dialog.appendChild(button);
  // Sound is the point: Esc must not dismiss the blocked state.
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  document.body.appendChild(dialog);

  const modal = !allowed;
  if (modal) {
    dialog.showModal();
    onModal(true);
  } else {
    dialog.show();
    void unlock().catch(() => {}); // nothing to ask for; unlock quietly so the AudioContext is live
    button.tabIndex = -1;
    button.disabled = true;
  }
  // Two frames, so the closed state is painted once and the transition has somewhere to start.
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  dialog.dataset.open = 'true';

  if (modal) {
    const { promise, resolve } = Promise.withResolvers<void>();
    button.addEventListener(
      'click',
      () => {
        // Started synchronously so the gesture is still live.
        void unlock().then(resolve, resolve); // a failed unlock still lets the visitor in
      },
      { once: true },
    );
    await promise;
    dialog.dataset.state = 'enabled';
    button.setAttribute('aria-label', 'Sound on');
  }

  await sleep(HOLD_MS);
  dialog.dataset.open = 'false';
  await sleep(EXIT_MS);
  dialog.close();
  dialog.remove();
  if (modal) onModal(false);
}
