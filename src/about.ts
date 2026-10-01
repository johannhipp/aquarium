import { pixelSvg } from './pixel';

const EXIT_MS = 200;

/** A 7x8 pixel question mark, one `X` per filled pixel. */
const QUESTION_MARK = [
  '.XXXXX.',
  'XX...XX',
  'XX...XX',
  '....XX.',
  '...XX..',
  '...XX..',
  '.......',
  '...XX..',
];

/** Spoken to assistive tech only; the dialog shows no text. */
/** Eighth note (5x6) and beamed pair (7x6), hand-drawn on the same grid as the sprite. */
const NOTE_SINGLE = ['..XXX', '..X.X', '..X..', '..X..', 'XXX..', 'XXX..'];
const NOTE_PAIR = ['.XXXXXX', '.X....X', '.X....X', '.X....X', 'XXX..XXX', 'XXX..XXX'];
/** Art-pixel position of each note's start, just above the fish's head, and which drawing it uses. */
const NOTES: ReadonlyArray<{ art: readonly string[]; col: number; row: number; beat: number }> = [
  { art: NOTE_SINGLE, col: 54, row: 24, beat: 0 },
  { art: NOTE_PAIR, col: 60, row: 21, beat: 1 },
  { art: NOTE_SINGLE, col: 67, row: 25, beat: 3 },
];

const DESCRIPTION = 'A fish with headphones, listening to music';

/**
 * A small pixel question mark in the top-right corner. It opens a dialog holding one picture, a
 * fish bopping to music, and nothing else: no text, no close button; it leaves on a click
 * outside the card (or Esc).
 */
export function createAbout(corner: HTMLElement, onModal: (open: boolean) => void): { reveal(): void } {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'corner-icon';
  button.setAttribute('aria-label', 'About');
  button.setAttribute('aria-haspopup', 'dialog');
  button.appendChild(pixelSvg(QUESTION_MARK, 2));

  const dialog = document.createElement('dialog');
  dialog.className = 'about';
  const card = document.createElement('div');
  card.className = 'about-card';
  const fish = new Image();
  fish.alt = '';
  fish.draggable = false;
  fish.src = '/creatures/extras/headphones-fish-gb.png';
  // The frame clips the sprite's white margin, so the bop can never paint over the card's border.
  const frame = document.createElement('div');
  frame.className = 'about-frame';
  frame.appendChild(fish);
  for (const n of NOTES) {
    // Outer span rises in whole-pixel steps; the svg inside sways sideways in whole pixels.
    const rise = document.createElement('span');
    rise.className = 'note-rise';
    rise.style.setProperty('--col', String(n.col));
    rise.style.setProperty('--row', String(n.row));
    rise.style.setProperty('--beat', String(n.beat));
    rise.style.setProperty('--cols', String(n.art[0].length));
    rise.style.setProperty('--rows', String(n.art.length));
    rise.setAttribute('aria-hidden', 'true');
    rise.appendChild(pixelSvg(n.art, 3));
    frame.appendChild(rise);
  }
  card.appendChild(frame);
  dialog.appendChild(card);
  dialog.setAttribute('aria-label', DESCRIPTION);

  let closing = 0;
  function open(): void {
    clearTimeout(closing);
    if (!dialog.open) {
      dialog.showModal();
      onModal(true);
    }
    // Two frames, so the closed state is painted once and the transition has somewhere to start.
    requestAnimationFrame(() => requestAnimationFrame(() => (dialog.dataset.open = 'true')));
  }
  function close(): void {
    if (!dialog.open || dialog.dataset.open !== 'true') return;
    dialog.dataset.open = 'false';
    closing = window.setTimeout(() => dialog.close(), EXIT_MS);
  }

  dialog.addEventListener('close', () => onModal(false));
  button.addEventListener('click', open);
  // The dialog fills the viewport and is transparent; a click that lands on it, not on the card, is "outside".
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });

  corner.appendChild(button);
  document.body.appendChild(dialog);
  return {
    reveal() {
      button.dataset.ready = 'true';
    },
  };
}
