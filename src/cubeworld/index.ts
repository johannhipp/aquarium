import type { ScreenPoint } from '../globe';
import { createStreamViewer, type StreamViewer } from './stream/viewer';

/** The look of the world: one of mono, gameboy, washi, night, foam (see palettes.ts). */
const PALETTE_ID = 'foam';
/** Where `pipeline/cubeworld/stream_build.py` writes the chunk archive (public/stream). */
const STREAM_BASE = '/stream/';
/** Orbit zoom on arrival: 1 is a 128 m tall view, so a place sits in its street. */
const PLACE_ZOOM = 1.1;
/** The first view: the whole spread of places, a few km across. */
const HOME_ZOOM = 0.045;
/** Give up waiting for the first chunks after this long and show whatever is there. */
const FIRST_FRAME_TIMEOUT_MS = 4000;

declare global {
  interface Window {
    /** Dev servers only: the map and its viewer, for end-to-end checks and alignment measurements. */
    __cubeworld?: Cubeworld;
    __streamViewer?: StreamViewer;
  }
}

interface MemoryHint {
  /** GiB of RAM, rounded down to a power of two and capped at 8; Chromium only */
  deviceMemory: number;
}

function hasMemoryHint(n: Navigator): n is Navigator & MemoryHint {
  return 'deviceMemory' in n && typeof n.deviceMemory === 'number';
}

/** What the viewer may spend: geometry memory (GPU plus the arrays not yet uploaded), cube size before refining, workers. */
interface Budget {
  gpuBudgetMB: number;
  detailPx: number;
  workers: number | undefined;
}

/**
 * A phone-class budget on touch-first devices and on low-RAM ones (iOS Safari gives a tab roughly 300 MB in
 * total, of which the page's own JS, decoded audio and the canvas already take about half): geometry stays
 * under about 120 MB, cubes up to 9 px are accepted before refining, two workers. Elsewhere 320 MB / 7 px.
 * `?gpuMB=<n>` overrides the geometry budget (testing).
 */
function chooseBudget(): Budget {
  const touchFirst = matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
  const lowRam = hasMemoryHint(navigator) && navigator.deviceMemory <= 4;
  const budget: Budget = touchFirst || lowRam ? { gpuBudgetMB: 120, detailPx: 9, workers: 2 } : { gpuBudgetMB: 320, detailPx: 7, workers: undefined };
  const override = Number(new URLSearchParams(location.search).get('gpuMB'));
  if (Number.isFinite(override) && override > 0) budget.gpuBudgetMB = override;
  return budget;
}

/** A point on the map as the Japan Plane Rectangular CS IX coordinates PLATEAU uses (EPSG:6677), in metres. */
export interface MapPoint {
  easting: number;
  northing: number;
}

export interface Cubeworld {
  /** Show the scene and run the render loop (it only draws when something changed). */
  start(): void;
  /** Stop the loop and the key listeners; the camera and the loaded chunks stay. */
  stop(): void;
  /** Free the GPU resources, stop the workers and remove the canvas. */
  dispose(): void;
  /** Hop to a point (zoom out, glide, zoom in) while its chunks are fetched along the way; true on arrival, false if interrupted. */
  flyTo(point: MapPoint, opts: { instant: boolean }): Promise<boolean>;
  /** CSS-pixel position of a point on the ground, for the note. */
  project(point: MapPoint, out: ScreenPoint): void;
  /** Called after every rendered frame. */
  onCameraMove(cb: () => void): void;
  /** Off while a modal dialog is up. */
  setInteractive(on: boolean): void;
  /** How many chunks the current view wants and how many of those are drawn as themselves (equal: fully loaded). */
  coverage(): { wanted: number; displayed: number };
}

function wrap(viewer: StreamViewer): Cubeworld {
  const { frame } = viewer.manifest;
  const world = (p: MapPoint): { x: number; z: number } => ({ x: p.easting - frame.gx0, z: frame.gtop - p.northing });
  return {
    start: () => viewer.start(),
    stop: () => viewer.stop(),
    dispose: () => viewer.dispose(),
    async flyTo(point, opts) {
      const { x, z } = world(point);
      if (opts.instant) {
        viewer.jump({ x, z, zoom: PLACE_ZOOM });
        return true;
      }
      const report = await viewer.flyToPose({ x, z, zoom: PLACE_ZOOM }, 'place');
      return !report.interrupted;
    },
    project(point, out) {
      const { x, z } = world(point);
      viewer.project(x, z, out);
    },
    onCameraMove: (cb) => viewer.onFrame(cb),
    setInteractive: (on) => viewer.setInteractive(on),
    coverage() {
      const { wanted, displayed } = viewer.coverage();
      return { wanted, displayed };
    },
  };
}

/**
 * Tokyo's Minato-ku as a streamed, level-of-detail voxel world (PLATEAU, about 20 MB of chunks, read with range
 * requests by module workers). Resolves once the first frame is drawn (the coarse overview is about 33 KB), so
 * the wipe between the worlds opens onto a picture; the viewer is left stopped until `start()`.
 * `focus` are the points the camera will fly to: it starts above their middle and warms their chunks at idle.
 */
export async function createCubeworld(container: HTMLElement, focus: readonly MapPoint[]): Promise<Cubeworld> {
  // the frame is only known once the manifest is in, so the start and warm poses are converted by a first, cheap read
  const manifest = (await (await fetch(`${STREAM_BASE}manifest.json`)).json()) as { frame: { gx0: number; gtop: number } };
  const poses = focus.map((p) => ({ x: p.easting - manifest.frame.gx0, z: manifest.frame.gtop - p.northing, zoom: PLACE_ZOOM }));
  const middle = poses.reduce((m, p) => ({ x: m.x + p.x / poses.length, z: m.z + p.z / poses.length }), { x: 0, z: 0 });
  const budget = chooseBudget();
  const viewer = await createStreamViewer(container, {
    base: STREAM_BASE,
    paletteId: PALETTE_ID,
    gpuBudgetMB: budget.gpuBudgetMB,
    detailPx: budget.detailPx,
    workers: budget.workers,
    // `?cache=0`: no Cache Storage and no idle warm-up (cold-network measurements)
    useCache: new URLSearchParams(location.search).get('cache') !== '0',
    home: poses.length > 0 ? { ...middle, zoom: HOME_ZOOM } : undefined,
    warm: poses,
    anchors: poses,
  });
  const deadline = performance.now() + FIRST_FRAME_TIMEOUT_MS;
  while (viewer.firstRenderMs() < 0 && performance.now() < deadline) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 40);
    await promise;
  }
  viewer.stop();
  const cube = wrap(viewer);
  if (import.meta.env.DEV) {
    window.__cubeworld = cube;
    window.__streamViewer = viewer;
  }
  return cube;
}
