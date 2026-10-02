import * as THREE from 'three';
import {
  CHUNK, chunkKey, keyLevel, keyX, keyZ, parentKey,
  type ChunkKey, type Directory, type Manifest,
} from './format';
import type { ChunkMesh, ChunkRef, FromWorker, Throttle, ToWorker } from './protocol';
import { selectChunks, type SelectParams } from './selection';
import { Class } from '../voxels';

/** Where a pose looks: what `selectChunks` needs, plus the time (ms from now) the pose is predicted to be current. */
export interface ViewSample {
  /** multiplies the refinement threshold: >1 accepts coarser cubes (a fast-moving camera cannot see the detail) */
  detailScale?: number;
  frustum: THREE.Frustum;
  ppm: number;
  tMs: number;
}

export interface ManagerOptions {
  chunksUrl: string;
  manifest: Manifest;
  dir: Directory;
  material: THREE.Material;
  group: THREE.Group;
  paletteId: string;
  useCache: boolean;
  throttle: Throttle | null;
  detailPx: number;
  gpuBudgetBytes: number;
  workers: number;
  /** quads of never-drawn chunks that may become visible per frame (their first draw uploads them to the GPU) */
  revealQuadsPerFrame: number;
}

interface Resident {
  key: ChunkKey;
  mesh: THREE.Mesh;
  bytes: number;
  faces: number;
  ground: Uint16Array;
  top: Uint16Array;
  topClass: Uint8Array;
  lastUsed: number;
  /** drawn at least once, i.e. already on the GPU */
  uploaded: boolean;
}

interface Job {
  key: ChunkKey;
  score: number;
  warm: boolean;
  state: 'queued' | 'inflight';
  batch: number;
}

interface Batch {
  id: number;
  keys: ChunkKey[];
  warm: boolean;
  slot: WorkerSlot;
  /** some chunks of the batch are still wanted */
  wanted: boolean;
}

interface WorkerSlot {
  worker: Worker;
  inflight: number;
}

/** The point a note about a place is drawn at, in world metres (x east, y up, z south). */
export interface Anchor {
  x: number;
  y: number;
  z: number;
  /** on the roof of a building (false: only the ground was found) */
  building: boolean;
}

export interface ManagerStats {
  resident: number;
  queued: number;
  inflight: number;
  /** geometry already drawn once, so resident on the GPU */
  gpuBytes: number;
  /** geometry built but not drawn yet: still a typed array in the JS heap */
  cpuBytes: number;
  quads: number;
  netBytes: number;
  cacheHits: number;
  requests: number;
  chunksBuilt: number;
  cancelledBatches: number;
  evicted: number;
  /** chunks whose bytes the idle warm-up has put in Cache Storage */
  warmed: number;
}

export interface UpdateResult {
  wanted: number;
  /** wanted chunks that are built */
  resident: number;
  /** wanted chunks that are drawn as themselves (not as a coarser stand-in) */
  displayed: number;
  /** the set of drawn chunks changed this frame */
  changed: boolean;
}

/** Coarse levels first: a finer level adds this many ms to a request's urgency. */
const LEVEL_PENALTY = 250;
/** Chunks whose bytes lie this close in the archive travel in one range request. */
const COALESCE_GAP = 12 * 1024;
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_BATCH_CHUNKS = 16;
const MAX_INFLIGHT = 6;
const WARM_SCORE = 1e9;
/** Boosted chunks sort ahead of everything except the pinned coarsest level. */
const BOOST_SCORE = -1e5;
/** Pinned anchor chunks: just behind a boost, ahead of every view-driven request. */
const PIN_SCORE = -5e4;
/** How far from a street-level place its building is looked for, in metres. */
const ANCHOR_RADIUS = 6;
/** Levels up to this (4 m cubes) are fine enough to say whether something stands in the way of a note. */
const OCCLUDER_MAX_LEVEL = 2;
const RETRY_MS = 3000;

export class ChunkManager {
  readonly #o: ManagerOptions;
  readonly #top: number;
  readonly #slots: WorkerSlot[] = [];
  readonly #resident = new Map<ChunkKey, Resident>();
  readonly #jobs = new Map<ChunkKey, Job>();
  readonly #batches = new Map<number, Batch>();
  readonly #failed = new Map<ChunkKey, number>();
  readonly #warmed = new Set<ChunkKey>();
  #plan: Map<ChunkKey, number> | null = null;
  #planStart = 0;
  #demandKeys = new Map<ChunkKey, number>();
  #boost: readonly ChunkKey[] | null = null;
  #pinned: readonly ChunkKey[] = [];
  readonly #anchors = new Map<string, Anchor>();
  #warm = new Set<ChunkKey>();
  #shown = new Set<ChunkKey>();
  #nextBatch = 1;
  #lastEvict = 0;
  #gpuBytes = 0;
  #cpuBytes = 0;
  #quads = 0;
  readonly #stats = { netBytes: 0, cacheHits: 0, requests: 0, chunksBuilt: 0, cancelledBatches: 0, evicted: 0 };
  /** called when a chunk arrives or the drawn set may have changed, so the viewer redraws */
  onChange: () => void = () => {};
  /** called when the first wave (the coarsest level) is complete */
  onRoots: () => void = () => {};
  #rootsDone = false;
  #paletteId: string;
  #material: THREE.Material;

  constructor(options: ManagerOptions) {
    this.#o = options;
    this.#top = options.manifest.levels.length - 1;
    this.#paletteId = options.paletteId;
    this.#material = options.material;
    const perWorker: Throttle | null = options.throttle
      ? { latencyMs: options.throttle.latencyMs, kbps: options.throttle.kbps / options.workers }
      : null;
    for (let i = 0; i < options.workers; i++) {
      const worker = new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<FromWorker>) => this.#onWorker(slot, e.data);
      const slot: WorkerSlot = { worker, inflight: 0 };
      const init: ToWorker = {
        type: 'init',
        chunksUrl: options.chunksUrl,
        hash: options.manifest.hash,
        paletteId: options.paletteId,
        useCache: options.useCache,
        throttle: perWorker,
      };
      worker.postMessage(init);
      this.#slots.push(slot);
    }
  }

  stats(): ManagerStats {
    let queued = 0;
    let inflight = 0;
    for (const j of this.#jobs.values()) {
      if (j.state === 'queued') queued++;
      else inflight++;
    }
    return { resident: this.#resident.size, queued, inflight, gpuBytes: this.#gpuBytes, cpuBytes: this.#cpuBytes, quads: this.#quads, warmed: this.#warmed.size, ...this.#stats };
  }

  /** Meshes currently drawn, for renderer.info-style reporting. */
  shownCount(): number {
    return this.#shown.size;
  }

  /** Every built chunk that is in `keys`; the flight report uses it to ask "was the destination ready". */
  isResident(key: ChunkKey): boolean {
    return this.#resident.has(key);
  }

  /** Ground height in metres under (x, z), from the finest built chunk there; NaN where nothing is built yet. */
  groundAt(x: number, z: number): number {
    for (let level = 0; level <= this.#top; level++) {
      const size = 1 << level;
      const cx = Math.floor(x / (CHUNK * size));
      const cz = Math.floor(z / (CHUNK * size));
      const r = this.#resident.get(chunkKey(level, cx, cz));
      if (!r) continue;
      const lx = Math.min(CHUNK - 1, Math.max(0, Math.floor(x / size) - cx * CHUNK));
      const lz = Math.min(CHUNK - 1, Math.max(0, Math.floor(z / size) - cz * CHUNK));
      return r.ground[lz * CHUNK + lx] * size;
    }
    return Number.NaN;
  }

  /**
   * Keeps the finest (1 m) chunks around each point (within ANCHOR_RADIUS) built and never evicted, so a note
   * anchored there has one position for good: coarse levels pool buildings over the ground, and their heights
   * can be metres off.
   */
  pin(points: ReadonlyArray<{ x: number; z: number }>): void {
    const keys = new Set<ChunkKey>();
    const lv = this.#o.manifest.levels[0];
    for (const p of points) {
      for (const gz of [p.z - ANCHOR_RADIUS, p.z + ANCHOR_RADIUS]) {
        for (const gx of [p.x - ANCHOR_RADIUS, p.x + ANCHOR_RADIUS]) {
          const cx = Math.floor(gx / CHUNK);
          const cz = Math.floor(gz / CHUNK);
          if (cx >= 0 && cz >= 0 && cx < lv.ncx && cz < lv.ncz && this.#o.dir.lengths[0][cz * lv.ncx + cx] > 0) keys.add(chunkKey(0, cx, cz));
        }
      }
    }
    this.#pinned = [...keys];
    this.#anchors.clear();
  }

  /** The 1 m chunk holding global column (gx, gz): undefined while it is not built, null where the archive has none. */
  #fine(gx: number, gz: number): Resident | null | undefined {
    const cx = Math.floor(gx / CHUNK);
    const cz = Math.floor(gz / CHUNK);
    const lv = this.#o.manifest.levels[0];
    if (cx < 0 || cz < 0 || cx >= lv.ncx || cz >= lv.ncz || this.#o.dir.lengths[0][cz * lv.ncx + cx] === 0) return null;
    return this.#resident.get(chunkKey(0, cx, cz));
  }

  /**
   * Where a note about the place at (x, z) is drawn: on the visible top of the building the place is in. That is
   * the roof of its own column, or, for a street-level point, of the nearest building column within
   * ANCHOR_RADIUS (ground floor and basement shops sit inside a building); with no building nearby, the ground.
   * Read from the pinned 1 m chunks only, so it never changes with zoom or level of detail. Null until they are
   * built.
   */
  anchorAt(x: number, z: number): Anchor | null {
    const memo = this.#anchors.get(`${x},${z}`);
    if (memo) return memo;
    const R = Math.ceil(ANCHOR_RADIUS);
    const gx0 = Math.floor(x);
    const gz0 = Math.floor(z);
    let best: Anchor | null = null;
    let bestDist = Infinity;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const gx = gx0 + dx;
        const gz = gz0 + dz;
        const r = this.#fine(gx, gz);
        if (r === undefined) return null;
        if (r === null) continue;
        const i = (gz - Math.floor(gz / CHUNK) * CHUNK) * CHUNK + (gx - Math.floor(gx / CHUNK) * CHUNK);
        const cls = r.topClass[i];
        if (cls !== Class.BUILDING && cls !== Class.ROOF) continue;
        const dist = Math.hypot(gx + 0.5 - x, gz + 0.5 - z);
        if (dist > ANCHOR_RADIUS || dist >= bestDist) continue;
        bestDist = dist;
        best = { x: gx + 0.5, y: r.top[i], z: gz + 0.5, building: true };
      }
    }
    if (!best) {
      const r = this.#fine(gx0, gz0);
      if (r === undefined) return null;
      const ground = r ? r.ground[(gz0 - Math.floor(gz0 / CHUNK) * CHUNK) * CHUNK + (gx0 - Math.floor(gx0 / CHUNK) * CHUNK)] : 0;
      best = { x, y: ground, z, building: false };
    }
    this.#anchors.set(`${x},${z}`, best);
    return best;
  }

  /**
   * Height of the highest solid cell above column (x, z) from the finest built level up to 4 m cubes; NaN where
   * only coarser data exists (too rough to say anything is in the way).
   */
  topAt(x: number, z: number): number {
    for (let level = 0; level <= OCCLUDER_MAX_LEVEL; level++) {
      const size = 1 << level;
      const cx = Math.floor(x / (CHUNK * size));
      const cz = Math.floor(z / (CHUNK * size));
      const r = this.#resident.get(chunkKey(level, cx, cz));
      if (!r) continue;
      const lx = Math.min(CHUNK - 1, Math.max(0, Math.floor(x / size) - cx * CHUNK));
      const lz = Math.min(CHUNK - 1, Math.max(0, Math.floor(z / size) - cz * CHUNK));
      return r.top[lz * CHUNK + lx] * size;
    }
    return Number.NaN;
  }

  /** The chunks a pose wants (before any loading). */
  wantedAt(sample: Omit<ViewSample, 'tMs'>): ChunkKey[] {
    return this.#select(sample, 0);
  }

  /** Fraction of `keys` that are built or have a built ancestor at most `slack` levels coarser. */
  readiness(keys: readonly ChunkKey[], slack: number): number {
    if (keys.length === 0) return 1;
    let ready = 0;
    for (const key of keys) {
      let k = key;
      for (let up = 0; up <= slack; up++) {
        if (this.#resident.has(k)) {
          ready++;
          break;
        }
        if (keyLevel(k) >= this.#top) break;
        k = parentKey(k);
      }
    }
    return ready / keys.length;
  }

  /** The chunks a view needs, plus every ancestor (coarse stand-ins arrive first), each with its urgency. */
  #wantedWithAncestors(keys: readonly ChunkKey[], t: number, into: Map<ChunkKey, number>): void {
    for (const key of keys) {
      for (let k = key; ; k = parentKey(k)) {
        const level = keyLevel(k);
        const score = t + LEVEL_PENALTY * (this.#top - level);
        const cur = into.get(k);
        if (cur === undefined || score < cur) into.set(k, score);
        if (level >= this.#top) break;
      }
    }
  }

  #select(sample: Omit<ViewSample, 'tMs'>, pad: number): ChunkKey[] {
    const detailPx = this.#o.detailPx * (sample.detailScale ?? 1);
    const params: SelectParams = { frustum: sample.frustum, ppm: sample.ppm, detailPx, pad };
    return selectChunks(this.#o.dir, this.#o.manifest.levels, params);
  }

  /**
   * Optimistic loading: `samples` are poses along a planned camera path. Every chunk any of them will need is
   * requested now, most urgent (earliest, coarsest) first, so the destination is built before the camera lands.
   */
  setPlan(samples: readonly ViewSample[], now: number): void {
    const plan = new Map<ChunkKey, number>();
    for (const s of samples) this.#wantedWithAncestors(this.#select(s, 24), s.tMs, plan);
    this.#plan = plan;
    this.#planStart = now;
  }

  /** The user took over (or the target changed): chunks only the old plan wanted are dropped from the queue and aborted. */
  clearPlan(): void {
    this.#plan = null;
    this.#boost = null;
  }

  /** Makes `keys` (and their ancestors) the most urgent requests after the coarsest level, or null to stop. */
  boost(keys: readonly ChunkKey[] | null): void {
    this.#boost = keys;
  }

  /** Idle warm-up: bytes of these poses' chunks go into Cache Storage, built nothing, behind every real request. */
  setWarm(samples: readonly Omit<ViewSample, 'tMs'>[], minLevel: number): void {
    if (!this.#o.useCache) return;
    const into = new Map<ChunkKey, number>();
    for (const s of samples) this.#wantedWithAncestors(this.#select(s, 24), 0, into);
    const keys = new Set(into.keys());
    // the coarse layers of the whole world are tiny and cover every flight path
    for (let level = minLevel; level <= this.#top; level++) {
      const lv = this.#o.manifest.levels[level];
      for (let cz = 0; cz < lv.ncz; cz++) {
        for (let cx = 0; cx < lv.ncx; cx++) {
          if (this.#o.dir.lengths[level][cz * lv.ncx + cx] > 0) keys.add(chunkKey(level, cx, cz));
        }
      }
    }
    this.#warm = keys;
  }

  /** True while warm-up requests remain. */
  warming(): boolean {
    for (const k of this.#warm) if (!this.#warmed.has(k) && !this.#resident.has(k)) return true;
    return false;
  }

  setPalette(paletteId: string, material: THREE.Material): void {
    if (paletteId === this.#paletteId) return;
    this.#paletteId = paletteId;
    this.#material = material;
    for (const slot of this.#slots) slot.worker.postMessage({ type: 'palette', paletteId } satisfies ToWorker);
    for (const r of this.#resident.values()) this.#dispose(r);
    this.#resident.clear();
    this.#shown.clear();
    this.#rootsDone = false;
    for (const b of this.#batches.values()) this.#cancelBatch(b);
    this.#jobs.clear();
  }

  /**
   * Per frame: pick the chunks for this view, reconcile requests with what is wanted (new ones queue, ones nobody
   * wants any more are cancelled), hand work to idle workers, and decide which built chunks to draw.
   */
  update(view: Omit<ViewSample, 'tMs'>, now: number): UpdateResult {
    const wanted = this.#select(view, 0);
    const demand = new Map<ChunkKey, number>();
    this.#wantedWithAncestors(wanted, 0, demand);
    if (this.#plan) {
      const elapsed = now - this.#planStart;
      for (const [key, t] of this.#plan) {
        const score = Math.max(0, t - elapsed) + LEVEL_PENALTY * (this.#top - keyLevel(key));
        const cur = demand.get(key);
        if (cur === undefined || score < cur) demand.set(key, score);
      }
    }
    if (this.#boost) this.#wantedWithAncestors(this.#boost, BOOST_SCORE, demand);
    for (const key of this.#pinned) demand.set(key, PIN_SCORE);
    const roots = this.#o.manifest.levels[this.#top];
    for (let cz = 0; cz < roots.ncz; cz++) {
      for (let cx = 0; cx < roots.ncx; cx++) {
        if (this.#o.dir.lengths[this.#top][cz * roots.ncx + cx] > 0) demand.set(chunkKey(this.#top, cx, cz), -1e6);
      }
    }
    this.#demandKeys = demand;
    this.#reconcile(demand, now);
    this.#dispatch(now);
    const result = this.#display(wanted, now);
    if (now - this.#lastEvict > 400) {
      this.#lastEvict = now;
      this.#evict(wanted);
    }
    if (!this.#rootsDone && this.#rootsReady()) {
      this.#rootsDone = true;
      this.onRoots();
    }
    return result;
  }

  /** Call after the frame that drew `shown` was rendered: those chunks are on the GPU now. */
  frameRendered(): void {
    for (const key of this.#shown) {
      const r = this.#resident.get(key);
      if (r && !r.uploaded) {
        r.uploaded = true;
        this.#cpuBytes -= r.bytes;
        this.#gpuBytes += r.bytes;
      }
    }
  }

  #rootsReady(): boolean {
    const roots = this.#o.manifest.levels[this.#top];
    for (let cz = 0; cz < roots.ncz; cz++) {
      for (let cx = 0; cx < roots.ncx; cx++) {
        const key = chunkKey(this.#top, cx, cz);
        if (this.#o.dir.lengths[this.#top][cz * roots.ncx + cx] > 0 && !this.#resident.has(key)) return false;
      }
    }
    return true;
  }

  #reconcile(demand: Map<ChunkKey, number>, now: number): void {
    for (const [key, score] of demand) {
      if (this.#resident.has(key)) continue;
      const job = this.#jobs.get(key);
      if (job) {
        if (job.state === 'queued') {
          job.score = score;
          job.warm = false;
        } else if (job.warm) {
          job.warm = false; // a warm-up fetch is already under way; it will be re-requested as a real load when done
        }
        continue;
      }
      const failedAt = this.#failed.get(key);
      if (failedAt !== undefined && now - failedAt < RETRY_MS) continue;
      this.#jobs.set(key, { key, score, warm: false, state: 'queued', batch: 0 });
    }
    for (const key of this.#warm) {
      if (demand.has(key) || this.#resident.has(key) || this.#warmed.has(key) || this.#jobs.has(key)) continue;
      this.#jobs.set(key, { key, score: WARM_SCORE, warm: true, state: 'queued', batch: 0 });
    }
    for (const [key, job] of this.#jobs) {
      if (demand.has(key)) continue;
      if (job.warm && this.#warm.has(key)) continue;
      if (job.state === 'queued') this.#jobs.delete(key);
    }
    for (const b of this.#batches.values()) {
      if (b.warm) continue;
      b.wanted = b.keys.some((k) => demand.has(k));
      if (!b.wanted) this.#cancelBatch(b);
    }
  }

  #cancelBatch(b: Batch): void {
    b.slot.worker.postMessage({ type: 'cancel', id: b.id } satisfies ToWorker);
    this.#stats.cancelledBatches++;
  }

  #ref(key: ChunkKey): ChunkRef {
    const level = keyLevel(key);
    const cx = keyX(key);
    const cz = keyZ(key);
    const i = cz * this.#o.manifest.levels[level].ncx + cx;
    return { key, level, cx, cz, offset: this.#o.dir.offsets[level][i], length: this.#o.dir.lengths[level][i] };
  }

  #dispatch(now: number): void {
    let free = MAX_INFLIGHT - this.#batches.size;
    if (free <= 0) return;
    const queued: Job[] = [];
    for (const j of this.#jobs.values()) if (j.state === 'queued') queued.push(j);
    if (queued.length === 0) return;
    queued.sort((a, b) => a.score - b.score);
    const realBusy = [...this.#batches.values()].some((b) => !b.warm);
    const taken = new Set<ChunkKey>();
    for (const head of queued) {
      if (free <= 0) break;
      if (taken.has(head.key)) continue;
      if (head.warm && (realBusy || queued.some((q) => !q.warm))) break; // warm-up only runs when nothing real waits
      const refs: ChunkRef[] = [this.#ref(head.key)];
      let lo = refs[0].offset;
      let hi = lo + refs[0].length;
      taken.add(head.key);
      for (const c of queued) {
        if (refs.length >= MAX_BATCH_CHUNKS) break;
        if (taken.has(c.key) || c.warm !== head.warm) continue;
        const r = this.#ref(c.key);
        const nlo = Math.min(lo, r.offset);
        const nhi = Math.max(hi, r.offset + r.length);
        if (r.offset > hi + COALESCE_GAP || r.offset + r.length < lo - COALESCE_GAP || nhi - nlo > MAX_BATCH_BYTES) continue;
        refs.push(r);
        taken.add(c.key);
        lo = nlo;
        hi = nhi;
      }
      const slot = this.#slots.reduce((a, b) => (b.inflight < a.inflight ? b : a));
      const id = this.#nextBatch++;
      const batch: Batch = { id, keys: refs.map((r) => r.key), warm: head.warm, slot, wanted: true };
      this.#batches.set(id, batch);
      slot.inflight++;
      for (const r of refs) {
        const job = this.#jobs.get(r.key);
        if (job) {
          job.state = 'inflight';
          job.batch = id;
        }
      }
      slot.worker.postMessage({ type: 'load', id, chunks: refs, warm: head.warm } satisfies ToWorker);
      free--;
    }
    void now;
  }

  #onWorker(slot: WorkerSlot, msg: FromWorker): void {
    switch (msg.type) {
      case 'ready':
        this.onChange();
        break;
      case 'chunk':
        this.#add(msg);
        break;
      case 'done': {
        const batch = this.#batches.get(msg.id);
        this.#batches.delete(msg.id);
        slot.inflight = Math.max(0, slot.inflight - 1);
        this.#stats.netBytes += msg.netBytes;
        this.#stats.cacheHits += msg.cacheHits;
        this.#stats.requests += msg.requests;
        if (batch) {
          for (const key of batch.keys) {
            const job = this.#jobs.get(key);
            if (!job || job.batch !== msg.id) continue;
            this.#jobs.delete(key);
            if (batch.warm && !msg.cancelled) this.#warmed.add(key);
          }
        }
        this.onChange();
        break;
      }
      case 'error': {
        const batch = this.#batches.get(msg.id);
        console.warn('chunk batch failed:', msg.message);
        if (batch) for (const key of batch.keys) this.#failed.set(key, performance.now());
        break;
      }
    }
  }

  #add(msg: ChunkMesh): void {
    const { ref } = msg;
    if (this.#resident.has(ref.key)) return;
    const geometry = new THREE.BufferGeometry();
    let bytes = 0;
    const drop = (attr: THREE.BufferAttribute): void => {
      // After the upload the GPU holds the data; keeping the typed array too would double the memory.
      // three types `array` as non-null but never reads it again once the buffer exists.
      const releasable = attr as unknown as { array: ArrayLike<number> | null };
      attr.onUpload(() => {
        releasable.array = null;
      });
    };
    for (const a of msg.attributes) {
      const attr = new THREE.BufferAttribute(a.array, a.itemSize, a.normalized);
      drop(attr);
      geometry.setAttribute(a.name, attr);
      bytes += a.array.byteLength;
    }
    if (msg.index) {
      const attr = new THREE.BufferAttribute(msg.index, 1);
      drop(attr);
      geometry.setIndex(attr);
      bytes += msg.index.byteLength;
    }
    const [x0, y0, z0, x1, y1, z1] = msg.box;
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(geometry, this.#material);
    const s = 1 << ref.level;
    // the builder emits grid coordinates of the padded chunk, whose cell (1, 1) is the chunk's own corner
    mesh.scale.setScalar(s);
    mesh.position.set((ref.cx * CHUNK - 1) * s, 0, (ref.cz * CHUNK - 1) * s);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    this.#o.group.add(mesh);
    this.#resident.set(ref.key, { key: ref.key, mesh, bytes, faces: msg.faces, ground: msg.ground, top: msg.top, topClass: msg.topClass, lastUsed: performance.now(), uploaded: false });
    this.#cpuBytes += bytes;
    this.#quads += msg.faces;
    this.#stats.chunksBuilt++;
    this.#jobs.delete(ref.key);
    this.onChange();
  }

  #dispose(r: Resident): void {
    r.mesh.removeFromParent();
    r.mesh.geometry.dispose();
    if (r.uploaded) this.#gpuBytes -= r.bytes;
    else this.#cpuBytes -= r.bytes;
    this.#quads -= r.faces;
  }

  /** Over budget: the least recently drawn chunks go, never the coarsest level and never anything in view. */
  #evict(wanted: readonly ChunkKey[]): void {
    if (this.#gpuBytes + this.#cpuBytes <= this.#o.gpuBudgetBytes) return;
    const keep = new Set<ChunkKey>(wanted);
    for (const k of this.#pinned) keep.add(k);
    for (const k of this.#shown) keep.add(k);
    const candidates: Resident[] = [];
    for (const r of this.#resident.values()) {
      if (keyLevel(r.key) < this.#top && !keep.has(r.key) && !this.#demandKeys.has(r.key)) candidates.push(r);
    }
    candidates.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const r of candidates) {
      if (this.#gpuBytes + this.#cpuBytes <= this.#o.gpuBudgetBytes * 0.7) break;
      this.#dispose(r);
      this.#resident.delete(r.key);
      this.#stats.evicted++;
    }
  }

  /**
   * Which built chunks to draw. A wanted chunk that is built is drawn. One that is not is stood in for by its
   * nearest built ancestor, and then nothing finer below that ancestor is drawn, so a coarse chunk is replaced
   * only when all of its wanted children are ready (no overlaps, no holes, no pop of a lone child).
   *
   * A chunk reaches the GPU the first time it is drawn, and hidden chunks are never drawn, so a built chunk that
   * must wait for its siblings would wait forever. Such chunks (within the per-frame quad budget) are therefore
   * also drawn for one frame under their stand-in, where the coarser cubes cover them, and are on the GPU by the
   * time the last sibling arrives.
   */
  #display(wanted: readonly ChunkKey[], now: number): UpdateResult {
    let reveal = this.#o.revealQuadsPerFrame;
    const admitted = new Set<ChunkKey>();
    const usable = (key: ChunkKey): boolean => {
      const r = this.#resident.get(key);
      if (!r) return false;
      if (r.uploaded || admitted.has(key)) return true;
      if (reveal <= 0) return false;
      reveal -= r.faces;
      admitted.add(key);
      return true;
    };
    const shown = new Set<ChunkKey>();
    let resident = 0;
    for (const key of wanted) {
      if (this.#resident.has(key)) resident++;
      if (usable(key)) {
        shown.add(key);
        continue;
      }
      for (let k = key; keyLevel(k) < this.#top;) {
        k = parentKey(k);
        if (usable(k)) {
          shown.add(k);
          break;
        }
      }
    }
    const warming: ChunkKey[] = [];
    for (const key of [...shown]) {
      for (let k = key; keyLevel(k) < this.#top;) {
        k = parentKey(k);
        if (shown.has(k)) {
          shown.delete(key);
          if (!this.#resident.get(key)?.uploaded) warming.push(key);
          break;
        }
      }
    }
    let displayed = 0;
    for (const key of wanted) if (shown.has(key)) displayed++;
    for (const key of warming) shown.add(key);
    let changed = shown.size !== this.#shown.size;
    for (const key of shown) {
      if (!this.#shown.has(key)) changed = true;
      const r = this.#resident.get(key);
      if (r) r.lastUsed = now;
    }
    for (const key of wanted) {
      const r = this.#resident.get(key);
      if (r) r.lastUsed = now;
    }
    if (changed) {
      for (const key of this.#shown) {
        const r = this.#resident.get(key);
        if (r && !shown.has(key)) r.mesh.visible = false;
      }
      for (const key of shown) {
        const r = this.#resident.get(key);
        if (r) r.mesh.visible = true;
      }
    }
    this.#shown = shown;
    return { wanted: wanted.length, resident, displayed, changed };
  }

  dispose(): void {
    for (const b of this.#batches.values()) this.#cancelBatch(b);
    for (const slot of this.#slots) slot.worker.terminate();
    for (const r of this.#resident.values()) this.#dispose(r);
    this.#resident.clear();
  }
}
