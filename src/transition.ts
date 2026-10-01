import './transition.css';
import type { Player } from './audio';
import type * as CubeworldModule from './cubeworld';
import type { Cubeworld } from './cubeworld';
import type { Globe } from './globe';
import type { Point, World } from './wallet';

/** Ink of the wipe: the page's near-black. */
const INK = 0xff0b0b0b;
/** One block of the wipe is this many CSS pixels: chunky, like a Game Boy screen. */
const BLOCK = 8;
/** Width of the dithered rim, in blocks. */
const RIM = 3;
const CLOSE_MS = 480;
const OPEN_MS = 640;
const FADE_MS = 160;

/** Ordered 4x4 Bayer thresholds in (0, 1). */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number): number => 1 - (1 - t) ** 4;

export interface Transition {
  readonly world: World;
  /** Start loading cubeworld's code (e.g. when the wallet opens) so the click does not wait for it. */
  preload(): void;
  toCube(from: Point): Promise<void>;
  toGlobe(from: Point): Promise<void>;
}

interface Hooks {
  globe: Pick<Globe, 'setActive'>;
  player: Pick<Player, 'suspend' | 'resume'>;
  /** Called at the moment of the swap, with the world now on screen. */
  onWorld: (world: World) => void;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is unavailable');
  return context;
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Runs `draw(eased)` for `ms`, one call per frame, ending exactly on 1. */
async function tween(ms: number, ease: (t: number) => number, draw: (p: number) => void): Promise<void> {
  const start = await nextFrame();
  for (;;) {
    const t = Math.min(1, ((await nextFrame()) - start) / ms);
    draw(ease(t));
    if (t >= 1) return;
  }
}

/**
 * Swaps the globe and cubeworld behind a dithered iris: a black wipe of chunky blocks with a
 * Bayer-dithered rim closes onto the icon you clicked (about 0.5 s), the scenes swap while the
 * screen is covered, and it opens from the same spot (about 0.65 s). With reduced motion it is a
 * 160 ms fade through white instead. The other world is only paused, never torn down: the globe
 * keeps its camera and selection, and cubeworld keeps its camera, so each return lands where the
 * visitor left it.
 *
 * Audio: the river loop is paused with the globe (cubeworld has no sound of its own yet, and a
 * river bed under a landscape would belong to nothing on screen) and fades back in on return.
 */
export function createTransition(hooks: Hooks): Transition {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  const stage = document.createElement('div');
  stage.className = 'cubeworld';
  const iris = document.createElement('canvas');
  iris.className = 'world-iris';
  iris.setAttribute('aria-hidden', 'true');
  document.body.append(stage, iris);
  const context = context2d(iris);

  let world: World = 'globe';
  let busy = false;
  let loading: Promise<typeof CubeworldModule> | null = null;
  let cube: Cubeworld | null = null;

  function load(): Promise<typeof CubeworldModule> {
    loading ??= import('./cubeworld');
    return loading;
  }

  let image = new ImageData(1, 1);
  let pixels = new Uint32Array(image.data.buffer);
  /** One wipe pixel per BLOCK x BLOCK CSS pixels; the canvas is scaled up without smoothing. */
  function size(): void {
    iris.width = Math.ceil(window.innerWidth / BLOCK);
    iris.height = Math.ceil(window.innerHeight / BLOCK);
    image = new ImageData(iris.width, iris.height);
    pixels = new Uint32Array(image.data.buffer);
  }

  /** Paints the wipe: `closed` 0 shows everything, 1 covers everything; the hole is centred on `at`. */
  function drawIris(at: Point, closed: number): void {
    const cx = at.x / BLOCK;
    const cy = at.y / BLOCK;
    const reach = Math.hypot(Math.max(cx, iris.width - cx), Math.max(cy, iris.height - cy));
    const radius = (reach + RIM) * (1 - closed) - RIM * 0.5;
    for (let y = 0; y < iris.height; y++) {
      for (let x = 0; x < iris.width; x++) {
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const edge = radius + (BAYER[(y & 3) * 4 + (x & 3)] - 0.5) * RIM;
        pixels[y * iris.width + x] = dist >= edge ? INK : 0;
      }
    }
    context.putImageData(image, 0, 0);
  }

  async function wipe(at: Point, direction: 'close' | 'open'): Promise<void> {
    if (reduced.matches) {
      const [from, to] = direction === 'close' ? [0, 1] : [1, 0];
      const fade = iris.animate([{ opacity: from }, { opacity: to }], { duration: FADE_MS, easing: 'ease-out', fill: 'forwards' });
      await fade.finished;
      iris.style.opacity = String(to);
      fade.cancel();
      return;
    }
    if (direction === 'close') await tween(CLOSE_MS, easeInOut, (p) => drawIris(at, p));
    else await tween(OPEN_MS, easeOut, (p) => drawIris(at, 1 - p));
  }

  async function run(from: Point, to: World, swap: () => Promise<void>): Promise<void> {
    if (busy || world === to) return;
    busy = true;
    size();
    iris.dataset.active = 'true';
    if (reduced.matches) {
      // a veil of white: both worlds are white pages, so the fade reads as a crossfade
      pixels.fill(0xffffffff);
      context.putImageData(image, 0, 0);
      iris.style.opacity = '0';
    } else {
      drawIris(from, 0);
    }
    try {
      const ready = swap().then(
        () => true,
        (e: unknown) => {
          console.error('Could not enter the other world', e);
          return false;
        },
      );
      await wipe(from, 'close');
      if (await ready) {
        finish(to);
      }
      await wipe(from, 'open');
    } finally {
      delete iris.dataset.active;
      iris.style.opacity = '';
      busy = false;
    }
  }

  /** The swap itself, done while the screen is covered. */
  function finish(to: World): void {
    world = to;
    if (to === 'cube') {
      hooks.globe.setActive(false);
      hooks.player.suspend();
      document.documentElement.dataset.world = 'cube';
      stage.dataset.active = 'true';
      cube?.start();
    } else {
      cube?.stop();
      delete stage.dataset.active;
      delete document.documentElement.dataset.world;
      hooks.globe.setActive(true);
      void hooks.player.resume();
    }
    hooks.onWorld(to);
  }

  return {
    get world() {
      return world;
    },
    preload() {
      void load();
    },
    toCube(from) {
      return run(from, 'cube', async () => {
        const mod = await load();
        // built while the screen is covered, so the (one-off) mesh build never janks the wipe
        cube ??= mod.createCubeworld(stage);
      });
    },
    toGlobe(from) {
      return run(from, 'globe', async () => {});
    },
  };
}
