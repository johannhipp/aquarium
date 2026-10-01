import type { Creature } from './data';

export interface Dex {
  /** Mark one creature as selected (or none). */
  select(id: string | null): void;
  /** Reveal the row once every sprite is decoded, with a short stagger. */
  reveal(): Promise<void>;
}

/**
 * Pokédex-style index: nothing but the pixelated sprites. Names live in aria-labels only,
 * so assistive tech still gets them while the screen shows no text.
 */
export function createDex(
  host: HTMLElement,
  creatures: readonly Creature[],
  handlers: { onPick: (c: Creature) => void; onHover: (c: Creature) => void },
): Dex {
  const nav = document.createElement('nav');
  nav.className = 'dex';
  nav.setAttribute('aria-label', 'Creatures');
  const grid = document.createElement('div');
  grid.className = 'dex-grid';
  nav.appendChild(grid);
  const buttons = new Map<string, HTMLButtonElement>();
  const images: HTMLImageElement[] = [];

  creatures.forEach((c, i) => {
    const item = document.createElement('div');
    item.className = 'dex-item';
    item.style.setProperty('--i', String(i));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tile';
    button.setAttribute('aria-label', c.common);
    button.setAttribute('aria-pressed', 'false');
    const img = new Image();
    img.alt = '';
    img.draggable = false;
    img.src = `/${c.sprite}`;
    images.push(img);
    button.appendChild(img);
    button.addEventListener('click', () => handlers.onPick(c));
    button.addEventListener('pointerenter', () => handlers.onHover(c));
    button.addEventListener('focus', () => handlers.onHover(c));
    item.appendChild(button);
    grid.appendChild(item);
    buttons.set(c.id, button);
  });
  host.appendChild(nav);

  return {
    select(id) {
      for (const [cid, button] of buttons) button.setAttribute('aria-pressed', String(cid === id));
    },
    async reveal() {
      await Promise.all(images.map((img) => img.decode()));
      nav.dataset.ready = 'true';
    },
  };
}
