import type * as THREE from 'three';
import { buildWorldMesh } from '../mesh';
import { paletteById, type Palette } from '../palettes';
import { TERRAIN_CLASSES, type VoxelGrid } from '../voxels';
import { CHUNK, PAD, SPAN, decodeChunk } from './format';
import type { AttributeData, ChunkMesh, ChunkRef, FromWorker, LoadRequest, ToWorker, TypedArray, WorkerInit } from './protocol';

/**
 * Everything that costs time happens here, off the main thread: the range request (or Cache Storage hit),
 * entropy decode, face-culled meshing through the palette-aware mesh builder. Only finished typed
 * arrays travel back, as transferables, so the main thread's share is wrapping them in a BufferGeometry.
 */

let init: WorkerInit | null = null;
let palette: Palette | null = null;
let cache: Cache | null = null;
let linkFreeAt = 0;
const aborts = new Map<number, AbortController>();

const COLUMNS = SPAN * SPAN;
const TERRAIN = new Uint8Array(256);
for (const c of TERRAIN_CLASSES) TERRAIN[c] = 1;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal.aborted) {
    reject(signal.reason);
    return promise;
  }
  const timer = setTimeout(resolve, Math.max(0, ms));
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
  return promise;
}

/** The simulated link: transfers queue up one behind another, each also pays the round-trip latency. */
async function throttle(bytes: number, signal: AbortSignal): Promise<void> {
  const t = init?.throttle;
  if (!t) return;
  const now = performance.now();
  const start = Math.max(now, linkFreeAt);
  linkFreeAt = start + (bytes * 8) / t.kbps;
  await sleep(linkFreeAt + t.latencyMs - now, signal);
}

function cacheRequest(ref: ChunkRef): Request {
  return new Request(`${self.location.origin}/__stream-cache/${init?.hash}/${ref.level}/${ref.cx}/${ref.cz}`);
}

async function fetchBlobs(req: LoadRequest, signal: AbortSignal): Promise<{ blobs: Map<number, Uint8Array<ArrayBuffer>>; net: number; hits: number; requests: number }> {
  if (!init) throw new Error('worker not initialised');
  const blobs = new Map<number, Uint8Array<ArrayBuffer>>();
  const missing: ChunkRef[] = [];
  let hits = 0;
  await Promise.all(req.chunks.map(async (ref) => {
    const hit = cache ? await cache.match(cacheRequest(ref)) : undefined;
    if (hit) {
      blobs.set(ref.key, new Uint8Array(await hit.arrayBuffer()));
      hits++;
    } else {
      missing.push(ref);
    }
  }));
  let net = 0;
  let requests = 0;
  const shardSize = 2 ** init.shardBits;
  const byShard = new Map<number, ChunkRef[]>();
  for (const ref of missing) {
    const shard = Math.floor(ref.offset / shardSize);
    const list = byShard.get(shard);
    if (list) list.push(ref);
    else byShard.set(shard, [ref]);
  }
  for (const [shard, refs] of byShard) {
    const first = shard * shardSize;
    const lo = Math.min(...refs.map((r) => r.offset)) - first;
    const hi = Math.max(...refs.map((r) => r.offset + r.length)) - first;
    const res = await fetch(init.chunkUrls[shard], { headers: { Range: `bytes=${lo}-${hi - 1}` }, signal });
    if (!res.ok) throw new Error(`range ${lo}-${hi - 1} of shard ${shard}: HTTP ${res.status}`);
    const body = new Uint8Array(await res.arrayBuffer());
    net += body.byteLength;
    requests++;
    await throttle(body.byteLength, signal);
    const base = res.status === 206 ? lo : 0;
    const puts: Promise<void>[] = [];
    for (const ref of refs) {
      const at = ref.offset - first - base;
      const blob = body.slice(at, at + ref.length);
      blobs.set(ref.key, blob);
      if (cache) puts.push(cache.put(cacheRequest(ref), new Response(blob.slice())));
    }
    await Promise.all(puts);
  }
  return { blobs, net, hits, requests };
}

/**
 * The mesher emits float32 for everything. Each attribute's real domain is tiny, so it travels and lives on the GPU
 * in the smallest exact type (the shader still reads floats: WebGL converts non-normalised integers):
 * positions are integer grid coordinates (u16), uv and the outline flags are 0/1 (u8), ambient occlusion takes the
 * values k/3 and the lamp light is 0..1 (u8 normalised, k/3 is exact in 1/255 steps). `aInfo` keeps float32: its
 * last component is a per-cube hash in [0, 1). 60 bytes per vertex become 30.
 */
function compactAttribute(name: string, a: THREE.BufferAttribute): AttributeData {
  const src = a.array as Float32Array;
  switch (name) {
    case 'position':
      return { name, itemSize: a.itemSize, normalized: false, array: Uint16Array.from(src) };
    case 'uv':
    case 'aEdge':
      return { name, itemSize: a.itemSize, normalized: false, array: Uint8Array.from(src) };
    case 'aAo':
    case 'aLight': {
      const out = new Uint8Array(src.length);
      for (let i = 0; i < src.length; i++) out[i] = Math.round(src[i] * 255);
      return { name, itemSize: a.itemSize, normalized: true, array: out };
    }
    default:
      return { name, itemSize: a.itemSize, normalized: a.normalized, array: src };
  }
}

function buildChunk(id: number, ref: ChunkRef, raw: Uint8Array<ArrayBuffer>): ChunkMesh {
  if (!init) throw new Error('worker not initialised');
  const { cells, ny } = decodeChunk(raw, ref.level, init.model);
  const grid: VoxelGrid = { cells, nx: SPAN, ny, nz: SPAN };
  const world = buildWorldMesh(grid, palette ?? paletteById('mono'), { x0: PAD, x1: PAD + CHUNK, y0: 0, y1: ny, z0: PAD, z1: PAD + CHUNK });
  const geometry: THREE.BufferGeometry = world.geometry;

  const ground = new Uint16Array(CHUNK * CHUNK);
  const top = new Uint16Array(CHUNK * CHUNK);
  const topClass = new Uint8Array(CHUNK * CHUNK);
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const col = (z + PAD) * SPAN + x + PAD;
      const out = z * CHUNK + x;
      for (let y = ny - 1; y >= 0; y--) {
        const c = cells[col + COLUMNS * y];
        if (c === 0) continue;
        if (top[out] === 0) {
          top[out] = y + 1;
          topClass[out] = c;
        }
        if (TERRAIN[c]) {
          ground[out] = y + 1;
          break;
        }
      }
    }
  }

  const attributes: AttributeData[] = [];
  for (const name of Object.keys(geometry.attributes)) {
    const a = geometry.attributes[name] as THREE.BufferAttribute;
    attributes.push(compactAttribute(name, a));
  }
  const index = geometry.index ? (geometry.index.array as Uint16Array | Uint32Array) : null;
  const bb = geometry.boundingBox;
  const box: ChunkMesh['box'] = bb ? [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z] : [PAD, 0, PAD, PAD + CHUNK, ny, PAD + CHUNK];
  return { type: 'chunk', id, ref, attributes, index, box, faces: world.faces, ground, top, topClass, ny };
}

async function handleLoad(req: LoadRequest): Promise<void> {
  const ac = new AbortController();
  aborts.set(req.id, ac);
  let net = 0;
  let hits = 0;
  let requests = 0;
  let cancelled = false;
  try {
    const got = await fetchBlobs(req, ac.signal);
    net = got.net;
    hits = got.hits;
    requests = got.requests;
    if (!req.warm) {
      for (const ref of req.chunks) {
        if (ac.signal.aborted) throw ac.signal.reason;
        const blob = got.blobs.get(ref.key);
        if (!blob) continue;
        const mesh = buildChunk(req.id, ref, blob);
        const transfer: Transferable[] = mesh.attributes.map((a) => a.array.buffer);
        if (mesh.index) transfer.push(mesh.index.buffer);
        transfer.push(mesh.ground.buffer, mesh.top.buffer, mesh.topClass.buffer);
        post(mesh, transfer);
      }
    }
  } catch (err) {
    if (ac.signal.aborted) cancelled = true;
    else post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  } finally {
    aborts.delete(req.id);
    post({ type: 'done', id: req.id, netBytes: net, cacheHits: hits, requests, cancelled });
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      init = msg;
      palette = paletteById(msg.paletteId);
      void (msg.useCache && 'caches' in self ? caches.open(`stream-${msg.hash}`) : Promise.resolve(null)).then((c) => {
        cache = c;
        post({ type: 'ready' });
      });
      break;
    case 'palette':
      palette = paletteById(msg.paletteId);
      break;
    case 'load':
      void handleLoad(msg);
      break;
    case 'cancel':
      aborts.get(msg.id)?.abort(new DOMException('cancelled', 'AbortError'));
      break;
  }
};
