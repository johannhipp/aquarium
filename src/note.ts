import type { RiverName } from './data';
import type { ScreenPoint } from './globe';

const EXIT_MS = 200;
/** Gap between the anchor dot and the text, and the screen margin the text keeps. */
const GAP = 14;
const MARGIN = 16;

/**
 * The river's native names, anchored to a point on the globe. The wrapper is positioned with
 * a transform every camera frame; the enter/exit animation lives on the inner parts via CSS
 * transitions keyed on data attributes, so retargeting mid-flight never restarts.
 */
export function createNote(host: HTMLElement) {
  const root = document.createElement('div');
  root.className = 'note';
  root.dataset.open = 'false';
  root.dataset.facing = 'false';
  root.dataset.side = 'right';
  const dot = document.createElement('span');
  dot.className = 'note-dot';
  const body = document.createElement('div');
  body.className = 'note-body';
  root.append(dot, body);
  host.appendChild(root);

  let token = 0;
  let closedAt = -Infinity;
  let textWidth = 0;

  return {
    /** Fade the names in beside the anchor; names appear one after another. */
    async show(names: readonly RiverName[]): Promise<void> {
      const mine = ++token;
      // If the previous note is still leaving, let it finish before swapping its text.
      const wait = EXIT_MS - (performance.now() - closedAt);
      if (wait > 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, wait);
        await promise;
      }
      if (mine !== token) return;
      body.replaceChildren(
        ...names.map((n, i) => {
          const line = document.createElement('p');
          line.lang = n.lang;
          line.textContent = n.name;
          line.style.setProperty('--i', String(i));
          return line;
        }),
      );
      textWidth = body.offsetWidth;
      root.dataset.open = 'true';
    },
    hide(): void {
      const mine = ++token;
      if (root.dataset.open === 'true') closedAt = performance.now();
      root.dataset.open = 'false';
      // Once the exit transition has played, leave no text in the page at all.
      setTimeout(() => {
        if (mine === token) body.replaceChildren();
      }, EXIT_MS + 100);
    },
    /** Follow the anchor's projected position; hide while it is on the far side of the globe. */
    place(p: ScreenPoint): void {
      root.dataset.facing = String(p.facing);
      root.dataset.side = p.x + GAP + textWidth > window.innerWidth - MARGIN ? 'left' : 'right';
      root.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
    },
  };
}
