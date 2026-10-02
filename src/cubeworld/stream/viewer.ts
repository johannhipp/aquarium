import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createBackdrop, createWorldMaterial, setWorldFocus, wantsAntialias } from '../material';
import { DEFAULT_PALETTE, paletteById, rgb, type Palette } from '../palettes';
import { inflateRaw, parseDirectory, type ChunkKey, type Manifest, type ThemeDef } from './format';
import { BASE_HALF_HEIGHT, planFlight, type FlightPlan, type FlightPose } from './flight';
import { ChunkManager, type Anchor, type ManagerStats, type ViewSample } from './manager';
import { LongTasks, jsHeapMB, summarize, type FrameStats, type LongTask } from './metrics';
import { createPlaceholder, recolorPlaceholder } from './placeholder';
import type { ScreenPoint } from '../../globe';
import type { Throttle } from './protocol';

export interface ViewerOptions {
  /** URL of the folder holding manifest.json, dir.*.bin and chunks.*.bin */
  base: string;
  paletteId?: string;
  throttle?: Throttle | null;
  useCache?: boolean;
  /** cubes wider than this many CSS pixels are refined (smaller = sharper and heavier) */
  detailPx?: number;
  gpuBudgetMB?: number;
  workers?: number;
  /** false: the loop and the key listeners wait for `start()` (default true). */
  autoStart?: boolean;
  /** Ground points (world metres) whose 1 m chunk stays built, so `project` there is exact at every zoom. */
  anchors?: ReadonlyArray<{ x: number; z: number }>;
  /** Where the camera starts (default: the first theme, zoomed out over the ward). */
  home?: FlightPose;
  /** Poses whose chunks are warmed into Cache Storage at idle (default: every theme). */
  warm?: readonly FlightPose[];
}

export interface FlightReport {
  theme: string;
  /** a drag, key or newer flight ended it before the camera arrived */
  interrupted: boolean;
  distanceM: number;
  durationMs: number;
  /** of which the flight spent crawling because the destination's coarse chunks had not arrived */
  stallMs: number;
  /** chunks the arrival view wants / of those built / of those drawn as themselves, at the moment the camera landed */
  arrival: { wanted: number; resident: number; displayed: number; complete: boolean };
  /** ms after landing until every wanted chunk was drawn (0 = already complete), null if not within the wait */
  completeAfterMs: number | null;
  chunksBuilt: number;
  netBytes: number;
  cacheHits: number;
  requests: number;
  cancelledBatches: number;
  /** ms between animation frames during the flight (16.7 = vsync) */
  frames: FrameStats;
  /** ms the page's own per-frame JS (selection, display, three's render call) took */
  frameCpu: FrameStats;
  longTasks: { supported: boolean; count: number; over50: number; maxMs: number; list: LongTask[] };
  jsHeapMB: number;
  /** geometry drawn at least once (on the GPU) / built but not drawn yet (still typed arrays in the JS heap), in MB */
  gpuMB: number;
  pendingMB: number;
  renderer: { geometries: number; drawCalls: number; triangles: number };
  residentChunks: number;
}

export interface StreamViewer {
  readonly manifest: Manifest;
  readonly themes: readonly ThemeDef[];
  /** ms from page start (performance.now) of the first frame that drew chunks */
  readonly firstRenderMs: () => number;
  readonly stats: () => ManagerStats;
  /** Flies there; resolves with the report after landing (and after the view settles, or `settleMs`). */
  flyTo(themeId: string, settleMs?: number): Promise<FlightReport>;
  cancelFlight(): void;
  flying(): boolean;
  pose(): { x: number; z: number; zoom: number; y: number };
  jump(pose: FlightPose): void;
  setPalette(id: string): void;
  onFlight(cb: (themeId: string | null) => void): void;
  /** Resolves when nothing is queued or in flight and the drawn set stopped changing. */
  settled(timeoutMs: number): Promise<boolean>;
  /** How much of what the current view wants is built and drawn (one `manager.update`). */
  coverage(): { wanted: number; resident: number; displayed: number; changed: boolean };
  /** Draw and listen for keys (a viewer starts running unless `autoStart` is false). */
  start(): void;
  /** Stop drawing and release the key listeners; the camera and the chunks stay as they are. */
  stop(): void;
  /** Flies to any pose with the hop plan; resolves at landing (settleMs 0) with `interrupted` set if a drag or a new flight cut it short. */
  flyToPose(pose: FlightPose, label: string, settleMs?: number): Promise<FlightReport>;
  /** Screen position (CSS px) of the ground point at world metres (x east, z south). */
  project(x: number, z: number, out: ScreenPoint): void;
  /** Screen position of an exact world point (x east, y up, z south), for measurements. */
  projectPoint(x: number, y: number, z: number, out: ScreenPoint): void;
  /** Where `project` puts a note about (x, z): the roof of the place's building, or null until the 1 m chunks around it are built. */
  anchorAt(x: number, z: number): Anchor | null;
  /** Ground height in metres under (x, z) from the finest built chunk there; NaN where nothing is built. */
  groundAt(x: number, z: number): number;
  /** Called after every rendered frame. */
  onFrame(cb: () => void): void;
  /** Off while a modal dialog is up, so drag and wheel never reach the world behind it. */
  setInteractive(on: boolean): void;
  dispose(): void;
}

const CAMERA_DISTANCE = 6000;
const START_AZIMUTH = Math.PI / 4;
const START_POLAR = 0.95;
const MOVE_SPEED = 30;
const MOVE_EASE = 10;
const FOLLOW_EASE = 5;
const PREFETCH_SAMPLES = 40;
/** The last stretch starts here; if the destination is still missing coarse chunks then, the flight crawls. */
const STALL_FROM = 0.5;
const STALL_RATE = 0.08;
const STALL_MAX_MS = 4000;
/** Every wanted chunk needs a built stand-in at most this many levels coarser ... */
const STALL_SLACK = 3;
/** ... for this fraction of them. */
const STALL_READY = 0.9;
/** The occlusion march: step along the view ray in metres, and the height (above the tallest building) where it stops. */
const OCCLUDER_STEP = 1.5;
const OCCLUDER_CEILING = 400;

interface ActiveFlight {
  plan: FlightPlan;
  /** flight time in ms; runs slower than the wall clock while the flight waits for the destination */
  clock: number;
  lastTick: number;
  stallMs: number;
  finalKeys: ChunkKey[];
  themeId: string;
  finish: (completed: boolean) => void;
}

type MoveKey = 'forward' | 'back' | 'left' | 'right';
const MOVE_KEYS: Readonly<Record<string, MoveKey>> = {
  ArrowUp: 'forward', ArrowDown: 'back', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
};

export async function createStreamViewer(container: HTMLElement, options: ViewerOptions): Promise<StreamViewer> {
  const base = options.base.endsWith('/') ? options.base : `${options.base}/`;
  const manifest = (await (await fetch(`${base}manifest.json`)).json()) as Manifest;
  const dirBytes = new Uint8Array(await (await fetch(`${base}${manifest.files.dir}`)).arrayBuffer());
  const dir = parseDirectory(await inflateRaw(dirBytes), manifest);
  const worldSize = Math.max(manifest.frame.nx, manifest.frame.nz);
  if ('caches' in window) {
    // chunks of an older build of the archive are never read again
    void caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith('stream-') && n !== `stream-${manifest.hash}`).map((n) => caches.delete(n))));
  }

  let palette: Palette = options.paletteId ? paletteById(options.paletteId) : DEFAULT_PALETTE;
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  const renderer = new THREE.WebGLRenderer({ antialias: wantsAntialias(palette), preserveDrawingBuffer: false });
  renderer.setPixelRatio(pixelRatio);
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  let material = createWorldMaterial(palette, pixelRatio, worldSize);
  let backdrop = createBackdrop(palette);
  const placeholder = createPlaceholder(dir, manifest.levels[2], palette);
  scene.add(backdrop, placeholder, group);
  renderer.setClearColor(new THREE.Color(...rgb(palette.background.bottom)), 1);

  // far enough that the ground at the far corner of the frame never clips, however wide the frame is
  const camera = new THREE.OrthographicCamera(-1, 1, BASE_HALF_HEIGHT, -BASE_HALF_HEIGHT, 1, CAMERA_DISTANCE + 2 * worldSize);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minZoom = 0.012;
  controls.maxZoom = 8;
  controls.zoomSpeed = 1.2;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = Math.PI / 2 - 0.08;
  const target = controls.target;

  const home = options.home ?? { x: manifest.themes[0].x, z: manifest.themes[0].z, zoom: 0.03 };
  target.set(home.x, 10, home.z);
  camera.position.set(
    target.x + CAMERA_DISTANCE * Math.sin(START_POLAR) * Math.sin(START_AZIMUTH),
    target.y + CAMERA_DISTANCE * Math.cos(START_POLAR),
    target.z + CAMERA_DISTANCE * Math.sin(START_POLAR) * Math.cos(START_AZIMUTH),
  );
  camera.zoom = home.zoom;
  camera.updateProjectionMatrix();
  controls.update();

  const manager = new ChunkManager({
    chunkUrls: manifest.files.chunks.map((f) => `${base}${f}`),
    manifest,
    dir,
    material,
    group,
    paletteId: palette.id,
    useCache: options.useCache ?? true,
    throttle: options.throttle ?? null,
    detailPx: options.detailPx ?? 7,
    gpuBudgetBytes: (options.gpuBudgetMB ?? 320) * 1048576,
    workers: options.workers ?? Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)),
    revealQuadsPerFrame: 60000,
  });
  manager.pin(options.anchors ?? []);

  const longTasks = new LongTasks();
  const flightListeners: Array<(id: string | null) => void> = [];
  const frameListeners: Array<() => void> = [];
  const projected = new THREE.Vector3();

  const toCamera = new THREE.Vector3();

  /**
   * True when something solid stands between the anchor and the camera: marches from just above the anchor along
   * the view direction (orthographic: the same for every point) and compares with the columns' tops. Only columns
   * known at 4 m or finer count, so a coarse stand-in never dims a note by mistake.
   */
  function isOccluded(a: Anchor): boolean {
    toCamera.copy(camera.position).sub(target).normalize();
    if (toCamera.y < 0.05) return false;
    const step = OCCLUDER_STEP;
    for (let t = step; ; t += step) {
      const y = a.y + 0.5 + toCamera.y * t;
      if (y > OCCLUDER_CEILING) return false;
      const top = manager.topAt(a.x + toCamera.x * t, a.z + toCamera.z * t);
      if (top > y) return true;
    }
  }

  /** CSS-pixel position of a world point, from the camera as it is right now (matrices refreshed, never stale). */
  function projectPoint(x: number, y: number, z: number, out: ScreenPoint): void {
    camera.updateMatrixWorld();
    projected.set(x, y, z).project(camera);
    out.x = (projected.x * 0.5 + 0.5) * container.clientWidth;
    out.y = (0.5 - projected.y * 0.5) * container.clientHeight;
    out.facing = Number.isFinite(out.x) && Number.isFinite(out.y);
  }
  let firstRender = -1;
  let dirty = true;
  let lastFrame = 0;
  let flight: ActiveFlight | null = null;
  const frameTimes: number[] = [];
  const frameCpu: number[] = [];
  let recording = false;

  manager.onChange = () => {
    dirty = true;
  };

  function resize(): void {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    const aspect = w / h;
    camera.left = -BASE_HALF_HEIGHT * aspect;
    camera.right = BASE_HALF_HEIGHT * aspect;
    camera.top = BASE_HALF_HEIGHT;
    camera.bottom = -BASE_HALF_HEIGHT;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    dirty = true;
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  controls.addEventListener('change', () => {
    dirty = true;
  });
  controls.addEventListener('start', () => cancelFlight());

  // ---- views for the selection: the real camera, and predicted ones for the prefetch
  const frustum = new THREE.Frustum();
  const matrix = new THREE.Matrix4();
  const probe = new THREE.OrthographicCamera();

  function ppmOf(zoom: number): number {
    return container.clientHeight / ((camera.top - camera.bottom) / zoom);
  }

  /**
   * While the camera is in flight the detail cannot be seen: cubes up to 3x wider are accepted until the last
   * stretch, where the scale eases back to 1 so the destination arrives at full detail.
   */
  function detailScaleAt(u: number): number {
    const t = Math.min(1, Math.max(0, (u - 0.6) / 0.32));
    return 3 - 2 * t * t * (3 - 2 * t);
  }

  function currentView(): Omit<ViewSample, 'tMs'> {
    camera.updateMatrixWorld();
    matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(matrix);
    const u = flight ? Math.min(1, flight.clock / flight.plan.durationMs) : 1;
    return { frustum, ppm: ppmOf(camera.zoom), detailScale: detailScaleAt(u) };
  }

  /** Where the eye rides at (x, z): a little above a fraction of the ground there (the same rule `follow` eases to). */
  function eyeAt(x: number, z: number, fallback: number): number {
    const g = manager.groundAt(x, z);
    return Number.isFinite(g) ? 0.6 * g + 8 : fallback;
  }

  /** The view the camera will have at `pose`, keeping the current heading and tilt. */
  function viewAt(pose: FlightPose, tMs: number, detailScale = 1): ViewSample {
    const y = eyeAt(pose.x, pose.z, target.y);
    probe.copy(camera, false);
    probe.zoom = pose.zoom;
    probe.position.set(pose.x + camera.position.x - target.x, y + camera.position.y - target.y, pose.z + camera.position.z - target.z);
    probe.up.copy(camera.up);
    probe.lookAt(pose.x, y, pose.z);
    probe.updateProjectionMatrix();
    probe.updateMatrixWorld(true);
    const m = new THREE.Matrix4().multiplyMatrices(probe.projectionMatrix, probe.matrixWorldInverse);
    return { frustum: new THREE.Frustum().setFromProjectionMatrix(m), ppm: ppmOf(pose.zoom), tMs, detailScale };
  }

  // ---- arrow keys: glide the view across the ground relative to the camera heading
  const held = new Set<MoveKey>();
  const velocity = new THREE.Vector2();
  const forward = new THREE.Vector3();

  const releaseKeys = (): void => held.clear();

  function onKeyDown(e: KeyboardEvent): void {
    if (document.querySelector('dialog[open]')) return;
    const key = MOVE_KEYS[e.code];
    if (!key || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    cancelFlight();
    held.add(key);
    dirty = true;
  }
  function onKeyUp(e: KeyboardEvent): void {
    const key = MOVE_KEYS[e.code];
    if (key) held.delete(key);
  }

  function shiftView(mx: number, my: number, mz: number): void {
    target.x += mx;
    target.y += my;
    target.z += mz;
    camera.position.x += mx;
    camera.position.y += my;
    camera.position.z += mz;
  }

  function glide(dt: number): boolean {
    const wantX = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
    const wantY = (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0);
    const speed = MOVE_SPEED / camera.zoom;
    const ease = 1 - Math.exp(-dt * MOVE_EASE);
    velocity.x += (wantX * speed - velocity.x) * ease;
    velocity.y += (wantY * speed - velocity.y) * ease;
    if (Math.abs(velocity.x) < 0.01 && Math.abs(velocity.y) < 0.01 && wantX === 0 && wantY === 0) velocity.set(0, 0);
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    const dx = (velocity.y * forward.x - velocity.x * forward.z) * dt;
    const dz = (velocity.y * forward.z + velocity.x * forward.x) * dt;
    const px = Math.min(manifest.frame.nx, Math.max(0, target.x + dx));
    const pz = Math.min(manifest.frame.nz, Math.max(0, target.z + dz));
    const moved = px !== target.x || pz !== target.z;
    if (moved) shiftView(px - target.x, 0, pz - target.z);
    return moved;
  }

  /** The eye rides the ground: ease its height toward the surface under it. */
  function follow(dt: number): boolean {
    const want = eyeAt(target.x, target.z, target.y);
    const gap = want - target.y;
    if (Math.abs(gap) < 0.01) return false;
    shiftView(0, gap * (1 - Math.exp(-dt * FOLLOW_EASE)), 0);
    return true;
  }

  // ---- flights
  function setPose(pose: FlightPose): void {
    const dx = camera.position.x - target.x;
    const dy = camera.position.y - target.y;
    const dz = camera.position.z - target.z;
    target.x = pose.x;
    target.z = pose.z;
    camera.position.set(pose.x + dx, target.y + dy, pose.z + dz);
    camera.zoom = pose.zoom;
    camera.updateProjectionMatrix();
  }

  function cancelFlight(): void {
    if (!flight) return;
    const f = flight;
    flight = null;
    manager.clearPlan();
    flightListeners.forEach((cb) => cb(null));
    f.finish(false);
  }

  function snapshotReport(): Pick<FlightReport, 'jsHeapMB' | 'gpuMB' | 'pendingMB' | 'renderer' | 'residentChunks'> {
    const s = manager.stats();
    return {
      jsHeapMB: jsHeapMB(),
      gpuMB: s.gpuBytes / 1048576,
      pendingMB: s.cpuBytes / 1048576,
      renderer: { geometries: renderer.info.memory.geometries, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles },
      residentChunks: s.resident,
    };
  }

  /** Flies to a theme of the manifest (the dev page's buttons). */
  function flyTo(themeId: string, settleMs = 6000): Promise<FlightReport> {
    const theme = manifest.themes.find((t) => t.id === themeId);
    if (!theme) throw new Error(`unknown theme ${themeId}`);
    return flyToPose({ x: theme.x, z: theme.z, zoom: theme.zoom }, themeId, settleMs);
  }

  /**
   * Flies to any pose with the hop plan and optimistic prefetch. Resolves at landing (`settleMs` 0) or once the
   * destination is completely drawn (up to `settleMs` after landing); `interrupted` tells a drag or a new flight.
   */
  async function flyToPose(to: FlightPose, themeId: string, settleMs = 0): Promise<FlightReport> {
    cancelFlight();
    const from: FlightPose = { x: target.x, z: target.z, zoom: camera.zoom };
    const plan = planFlight(from, to, {
      aspect: container.clientWidth / Math.max(1, container.clientHeight),
      azimuth: controls.getAzimuthalAngle(),
      polar: controls.getPolarAngle(),
      minZoom: controls.minZoom,
    });
    const t0 = performance.now();
    const samples: ViewSample[] = [];
    for (let i = 0; i <= PREFETCH_SAMPLES; i++) {
      const u = i / PREFETCH_SAMPLES;
      samples.push(viewAt(plan.at(u), u * plan.durationMs, detailScaleAt(u)));
    }
    manager.setPlan(samples, t0);
    const before = manager.stats();
    frameTimes.length = 0;
    frameCpu.length = 0;
    recording = true;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const finalKeys = manager.wantedAt(viewAt(plan.at(1), 0));
    const active: ActiveFlight = { plan, clock: 0, lastTick: 0, stallMs: 0, finalKeys, themeId, finish: resolve };
    flight = active;
    flightListeners.forEach((cb) => cb(themeId));
    dirty = true;
    const completed = await promise;
    const landed = performance.now();
    const interrupted = !completed;
    const arrivalView = manager.update(currentView(), landed);
    const arrival = { wanted: arrivalView.wanted, resident: arrivalView.resident, displayed: arrivalView.displayed, complete: arrivalView.displayed === arrivalView.wanted };
    const flightStats = manager.stats();
    const frames = summarize(frameTimes);
    const lt = longTasks.between(t0, landed);
    if (!flight) recording = false; // a superseding flight keeps recording
    let completeAfterMs: number | null = arrival.complete ? 0 : null;
    if (!arrival.complete && !interrupted && settleMs > 0) {
      const waited = performance.now();
      if (await settled(settleMs)) completeAfterMs = performance.now() - waited;
    }
    return {
      theme: themeId,
      interrupted,
      distanceM: Math.round(plan.distance),
      durationMs: Math.round(landed - t0),
      stallMs: Math.round(active.stallMs),
      arrival,
      completeAfterMs,
      chunksBuilt: flightStats.chunksBuilt - before.chunksBuilt,
      netBytes: flightStats.netBytes - before.netBytes,
      cacheHits: flightStats.cacheHits - before.cacheHits,
      requests: flightStats.requests - before.requests,
      cancelledBatches: flightStats.cancelledBatches - before.cancelledBatches,
      frames,
      frameCpu: summarize(frameCpu),
      longTasks: { supported: longTasks.supported, count: lt.length, over50: lt.filter((e) => e.duration > 50).length, maxMs: Math.max(0, ...lt.map((e) => e.duration)), list: lt },
      ...snapshotReport(),
    };
  }

  async function settled(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    let stableSince = performance.now();
    let lastSig = '';
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 60));
      const s = manager.stats();
      const view = manager.update(currentView(), performance.now());
      const busy = s.queued > 0 || s.inflight > 0;
      const sig = `${s.chunksBuilt}/${view.displayed}/${view.wanted}`;
      if (busy || sig !== lastSig || view.displayed !== view.wanted) {
        stableSince = performance.now();
        lastSig = sig;
      } else if (performance.now() - stableSince > 250) {
        return true;
      }
    }
    return false;
  }
  // ---- the loop
  function frame(now: number): void {
    const dt = lastFrame === 0 ? 0 : Math.min(0.05, (now - lastFrame) / 1000);
    if (recording && lastFrame !== 0) frameTimes.push(now - lastFrame);
    lastFrame = now;
    let moved = glide(dt);
    if (flight) {
      const f = flight;
      const dtMs = now - (f.lastTick || now);
      f.lastTick = now;
      // Optimistic loading must never fly into a void: when the last stretch is reached and the destination's
      // coarse chunks are still missing (slow link), time crawls until they arrive, for at most STALL_MAX_MS.
      const crawl = f.clock / f.plan.durationMs > STALL_FROM && f.stallMs < STALL_MAX_MS && manager.readiness(f.finalKeys, STALL_SLACK) < STALL_READY;
      f.clock += crawl ? dtMs * STALL_RATE : dtMs;
      if (crawl) f.stallMs += dtMs * (1 - STALL_RATE);
      manager.boost(crawl ? f.finalKeys : null);
      const u = Math.min(1, f.clock / f.plan.durationMs);
      setPose(f.plan.at(u));
      moved = true;
      if (u >= 1) {
        flight = null;
        manager.clearPlan();
        flightListeners.forEach((cb) => cb(null));
        f.finish(true);
      }
    }
    if (follow(dt)) moved = true;
    const orbited = controls.update();
    if (moved || orbited) dirty = true;
    const view = currentView();
    const result = manager.update(view, now);
    if (!dirty && !result.changed && !flight) return;
    dirty = false;
    setWorldFocus(material, camera.position.distanceTo(target));
    renderer.render(scene, camera);
    manager.frameRendered();
    if (firstRender < 0 && manager.shownCount() > 0) firstRender = performance.now();
    for (const cb of frameListeners) cb();
  }
  function loop(now: number): void {
    const began = performance.now();
    frame(now);
    if (recording) frameCpu.push(performance.now() - began);
  }
  let running = false;
  function start(): void {
    if (running) return;
    running = true;
    lastFrame = 0;
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseKeys);
    renderer.setAnimationLoop(loop);
    dirty = true;
  }
  function stop(): void {
    running = false;
    renderer.setAnimationLoop(null);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', releaseKeys);
    releaseKeys();
    velocity.set(0, 0);
  }

  const api: StreamViewer = {
    manifest,
    themes: manifest.themes,
    firstRenderMs: () => firstRender,
    stats: () => manager.stats(),
    flyTo,
    cancelFlight,
    flying: () => flight !== null,
    pose: () => ({ x: target.x, z: target.z, zoom: camera.zoom, y: target.y }),
    jump(pose) {
      cancelFlight();
      setPose(pose);
      dirty = true;
    },
    setPalette(id) {
      if (id === palette.id) return;
      palette = paletteById(id);
      const old = material;
      material = createWorldMaterial(palette, pixelRatio, worldSize);
      manager.setPalette(id, material);
      old.dispose();
      scene.remove(backdrop);
      backdrop.geometry.dispose();
      (backdrop.material as THREE.Material).dispose();
      backdrop = createBackdrop(palette);
      scene.add(backdrop);
      renderer.setClearColor(new THREE.Color(...rgb(palette.background.bottom)), 1);
      recolorPlaceholder(placeholder, palette);
      dirty = true;
    },
    onFlight(cb) {
      flightListeners.push(cb);
    },
    settled,
    coverage: () => manager.update(currentView(), performance.now()),
    start,
    stop,
    flyToPose,
    project(x, z, out) {
      const a = manager.anchorAt(x, z);
      if (a) {
        projectPoint(a.x, a.y, a.z, out);
        out.occluded = isOccluded(a);
        return;
      }
      const g = manager.groundAt(x, z);
      projectPoint(x, Number.isFinite(g) ? g : target.y, z, out);
      out.occluded = false;
    },
    anchorAt: (x, z) => manager.anchorAt(x, z),
    projectPoint,
    groundAt: (x, z) => manager.groundAt(x, z),
    onFrame(cb) {
      frameListeners.push(cb);
    },
    setInteractive(on) {
      controls.enabled = on;
      if (!on) held.clear();
    },
    dispose() {
      stop();
      observer.disconnect();
      controls.dispose();
      manager.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };

  // idle warm-up: the bytes of every destination's view, so a click finds them in Cache Storage
  const warmPoses: readonly FlightPose[] = options.warm ?? manifest.themes.map((t) => ({ x: t.x, z: t.z, zoom: t.zoom }));
  manager.onRoots = () => {
    const warm = (): void => {
      if (flight) return;
      manager.setWarm(warmPoses.map((p) => viewAt(p, 0)), 3);
    };
    if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 4000 });
    else setTimeout(warm, 1500);
  };
  if (options.autoStart ?? true) start();
  return api;
}
