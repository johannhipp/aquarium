import './wallet.css';
import { pixelSvg } from './pixel';

export type World = 'globe' | 'cube';
export interface Point {
  x: number;
  y: number;
}

export interface Wallet {
  /** Show the icon with its entrance animation (the ? makes room by sliding left). */
  reveal(): void;
  /** Which world is on screen: that item shows pressed in, the other one is the way out. */
  setWorld(world: World): void;
  close(): void;
}

/** 9x8 pixel wallet: rounded body, a clasp tab with a stud. */
const WALLET = [
  '.XXXXXXX.',
  'X.......X',
  'X.......X',
  'X....XXXX',
  'X....X.XX',
  'X....XXXX',
  'X.......X',
  '.XXXXXXX.',
];

/** 16x8 pixel fish, forked tail: the river globe. */
const FISH = [
  '....XXXXXX......',
  '..XXXXXXXXXX..X.',
  '.XXXXXXXXXXXXXXX',
  'XXX.XXXXXXXXXXX.',
  'XXXXXXXXXXXXXX..',
  '.XXXXXXXXXXXXXXX',
  '..XXXXXXXXXX..X.',
  '....XXXXXX......',
];

/**
 * 14x16 isometric cube (2:1 pixel slopes), 1-bit shaded: the top face stays white, the left face
 * is a checkerboard, the right face is solid.
 */
const CUBE = [
  '......XX......',
  '....XX..XX....',
  '..XX......XX..',
  'XX..........XX',
  'XXXX......XXXX',
  'XX.XXX..XXXXXX',
  'XXX.X.XXXXXXXX',
  'XX.X.XXXXXXXXX',
  'XXX.X.XXXXXXXX',
  'XX.X.XXXXXXXXX',
  'XXX.X.XXXXXXXX',
  'XX.X.XXXXXXXXX',
  'XXX.X.XXXXXXXX',
  '..XX.XXXXXXX..',
  '....XXXXXX....',
  '......XX......',
];

interface Item {
  world: World;
  label: string;
  art: readonly string[];
}

const ITEMS: readonly Item[] = [
  { world: 'globe', label: 'River globe', art: FISH },
  { world: 'cube', label: 'Cubeworld', art: CUBE },
];

/**
 * A pixel wallet in the top-right cluster. Click it and a small dropdown opens below, holding a
 * pixel fish (the river globe) and a pixel isometric cube (cubeworld). No text; the items bob
 * on hover. Closes on an outside click or Esc.
 */
export function createWallet(
  corner: HTMLElement,
  handlers: { onGlobe: (from: Point) => void; onCube: (from: Point) => void; onOpen?: () => void },
): Wallet {
  const slot = document.createElement('div');
  slot.className = 'wallet-slot';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'corner-icon wallet';
  button.setAttribute('aria-label', 'Wallet');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.appendChild(pixelSvg(WALLET, 2));

  const menu = document.createElement('div');
  menu.className = 'wallet-menu';
  menu.setAttribute('role', 'menu');
  menu.inert = true;

  const buttons = new Map<World, HTMLButtonElement>();
  for (const item of ITEMS) {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'wallet-item';
    entry.dataset.world = item.world;
    entry.setAttribute('role', 'menuitem');
    entry.setAttribute('aria-label', item.label);
    const art = document.createElement('span');
    art.className = 'wallet-art';
    art.appendChild(pixelSvg(item.art, 2));
    entry.appendChild(art);
    entry.addEventListener('click', () => {
      const rect = entry.getBoundingClientRect();
      const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const current = entry.getAttribute('aria-current') === 'true';
      close(true);
      if (current) return;
      if (item.world === 'globe') handlers.onGlobe(from);
      else handlers.onCube(from);
    });
    menu.appendChild(entry);
    buttons.set(item.world, entry);
  }
  slot.append(button, menu);
  corner.appendChild(slot);

  function isOpen(): boolean {
    return slot.dataset.open === 'true';
  }

  function open(): void {
    slot.dataset.open = 'true';
    menu.inert = false;
    button.setAttribute('aria-expanded', 'true');
    handlers.onOpen?.();
  }

  function close(refocus: boolean): void {
    if (!isOpen()) return;
    delete slot.dataset.open;
    menu.inert = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus({ preventScroll: true });
  }

  button.addEventListener('click', () => (isOpen() ? close(false) : open()));
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && e.target instanceof Node && !slot.contains(e.target)) close(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      e.stopPropagation();
      close(menu.contains(document.activeElement));
    }
  });

  return {
    reveal() {
      slot.dataset.ready = 'true';
      button.dataset.ready = 'true';
    },
    setWorld(world) {
      for (const [w, entry] of buttons) entry.setAttribute('aria-current', String(w === world));
    },
    close() {
      close(false);
    },
  };
}
