import type { ChunkKey } from './format';

/** A simulated link, for `?throttle=`: every response is held back as if it crossed a pipe this slow. */
export interface Throttle {
  /** round-trip time added to each request */
  latencyMs: number;
  /** bandwidth of this worker's share of the link, in kilobits per second */
  kbps: number;
}

export interface WorkerInit {
  type: 'init';
  chunksUrl: string;
  /** manifest.hash: part of every cache key, so a rebuilt archive never serves stale chunks */
  hash: string;
  paletteId: string;
  /** Cache Storage as a persistent chunk cache (default on) */
  useCache: boolean;
  throttle: Throttle | null;
}

/** One chunk of a batch: where its compressed blob sits in the archive. */
export interface ChunkRef {
  key: ChunkKey;
  level: number;
  cx: number;
  cz: number;
  offset: number;
  length: number;
}

export interface LoadRequest {
  type: 'load';
  /** batch id, echoed back; the batch is fetched as one HTTP range request when it is not cached */
  id: number;
  chunks: ChunkRef[];
  /** true: only warm the cache (fetch and store the bytes), build nothing */
  warm: boolean;
}

export interface CancelRequest {
  type: 'cancel';
  id: number;
}

export interface PaletteRequest {
  type: 'palette';
  paletteId: string;
}

export type ToWorker = WorkerInit | LoadRequest | CancelRequest | PaletteRequest;

export type TypedArray = Float32Array | Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array;

export interface AttributeData {
  name: string;
  itemSize: number;
  normalized: boolean;
  array: TypedArray;
}

export interface ChunkMesh {
  type: 'chunk';
  id: number;
  ref: ChunkRef;
  attributes: AttributeData[];
  index: Uint16Array | Uint32Array | null;
  /** region box in grid coordinates (padded grid, so x and z start at 1) */
  box: [number, number, number, number, number, number];
  faces: number;
  /** per interior column (z * 32 + x): cells up to and including the highest terrain cell, for the camera to ride on */
  ground: Uint16Array;
  ny: number;
}

export interface BatchDone {
  type: 'done';
  id: number;
  /** bytes that crossed the network for this batch */
  netBytes: number;
  cacheHits: number;
  requests: number;
  cancelled: boolean;
}

export interface WorkerError {
  type: 'error';
  id: number;
  message: string;
}

export interface WorkerReady {
  type: 'ready';
}

export type FromWorker = ChunkMesh | BatchDone | WorkerError | WorkerReady;
