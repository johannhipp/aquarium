export interface DexItem {
  id: string;
  /** read by assistive tech only; the screen shows no text */
  label: string;
  /** pixelated black-and-white sprite, relative to the site root */
  sprite: string;
}

export interface Dex {
  /** Mark one item as selected (or none). */
  select(id: string | null): void;
  /** Reveal the row once every sprite is decoded, with a short stagger. */
  reveal(): Promise<void>;
}

/**
 * Pokédex-style index: nothing but the pixelated sprites. Names live in aria-labels only,
 * so assistive tech still gets them while the screen shows no text. One index per world
 * (`kind` is a CSS hook, so only the index of the world on screen is shown).
 */
export function createDex<T extends DexItem>(
  host: HTMLElement,
  items: readonly T[],
  opts: { kind: string; label: string; onPick: (item: T) => void; onHover: (item: T) => void },
): Dex {
  const nav = document.createElement('nav');
  nav.className = 'dex';
  nav.dataset.kind = opts.kind;
  nav.setAttribute('aria-label', opts.label);
  const grid = document.createElement('div');
  grid.className = 'dex-grid';
  nav.appendChild(grid);
  const buttons = new Map<string, HTMLButtonElement>();
  const images: HTMLImageElement[] = [];

  items.forEach((item, i) => {
    const cell = document.createElement('div');
    cell.className = 'dex-item';
    cell.style.setProperty('--i', String(i));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tile';
    button.setAttribute('aria-label', item.label);
    button.setAttribute('aria-pressed', 'false');
    const img = new Image();
    img.alt = '';
    img.draggable = false;
    img.src = `/${item.sprite}`;
    images.push(img);
    button.appendChild(img);
    button.addEventListener('click', () => opts.onPick(item));
    button.addEventListener('pointerenter', () => opts.onHover(item));
    button.addEventListener('focus', () => opts.onHover(item));
    cell.appendChild(button);
    grid.appendChild(cell);
    buttons.set(item.id, button);
  });
  host.appendChild(nav);

  return {
    select(id) {
      for (const [bid, button] of buttons) button.setAttribute('aria-pressed', String(bid === id));
    },
    async reveal() {
      await Promise.all(images.map((img) => img.decode()));
      nav.dataset.ready = 'true';
    },
  };
}
