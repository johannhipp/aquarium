/**
 * The streamed world's wire format, produced by pipeline/cubeworld/stream_build.py. Worker-safe (no DOM).
 *
 * Three files: `manifest.json` (this module's `Manifest`), `dir.bin` (deflate-raw: for each LOD level three
 * dense arrays over its chunk grid, row-major `cz * ncx + cx`) and `chunks.bin` (every chunk as its own
 * deflate-raw blob, served with HTTP range requests; chunks that are neighbours in space are neighbours in the file).
 *
 * Level L has cubes of `2^L` metres; a chunk is `CHUNK` x `CHUNK` cells wide whatever the level, so it covers
 * `CHUNK * 2^L` metres and four chunks of level L-1 tile exactly one chunk of level L (a quadtree).
 */

export const CHUNK = 32;
/** Each chunk stores one extra ring of cells from its neighbours, so it meshes without waiting for them. */
export const PAD = 1;
export const SPAN = CHUNK + 2 * PAD;
const COLUMNS = SPAN * SPAN;

export interface ThemeDef {
  id: string;
  icon: string;
  name: string;
  /** world metres (x east, z south) of the view's centre */
  x: number;
  z: number;
  /** orbit-camera zoom on arrival (1 = 128 m tall view) */
  zoom: number;
  azimuth?: number;
}

export interface LevelInfo {
  level: number;
  /** metres per cube */
  cell: number;
  ncx: number;
  ncz: number;
}

export interface Manifest {
  format: number;
  /** content hash of the three files; part of every cache key */
  hash: string;
  source: string;
  attribution: string;
  frame: { epsg: number; gx0: number; gtop: number; nx: number; nz: number; gz: number };
  chunk: number;
  levels: LevelInfo[];
  files: { dir: string; chunks: string };
  bytes: { dir: number; chunks: number };
  counts: { chunks: number; uniqueChunks: number; byLevel: number[] };
  themes: ThemeDef[];
}

/** Per level: where each chunk's blob sits in chunks.bin, how long it is (0 = no chunk) and how tall it is in cells. */
export interface Directory {
  offsets: Uint32Array[];
  lengths: Uint32Array[];
  heights: Uint16Array[];
}

export async function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function parseDirectory(raw: Uint8Array<ArrayBuffer>, levels: readonly LevelInfo[]): Directory {
  const dir: Directory = { offsets: [], lengths: [], heights: [] };
  let at = 0;
  const take = <T extends Uint32Array | Uint16Array>(ctor: { new (b: ArrayBuffer): T; BYTES_PER_ELEMENT: number }, n: number): T => {
    const out = new ctor(raw.buffer.slice(raw.byteOffset + at, raw.byteOffset + at + n * ctor.BYTES_PER_ELEMENT));
    at += n * ctor.BYTES_PER_ELEMENT;
    at = (at + 3) & ~3; // every array starts 4-byte aligned
    return out;
  };
  for (const lv of levels) {
    const n = lv.ncx * lv.ncz;
    dir.offsets.push(take(Uint32Array, n));
    dir.lengths.push(take(Uint32Array, n));
    dir.heights.push(take(Uint16Array, n));
  }
  return dir;
}

export interface DecodedChunk {
  /** SPAN x ny x SPAN cells, index `x + SPAN * (z + SPAN * y)` */
  cells: Uint8Array<ArrayBuffer>;
  ny: number;
}

/**
 * chunk blob (after inflate): u8 version, u8 flags (bit 0: run lengths are u16), u16 ny, u32 runs,
 * then `COLUMNS` u8 run counts, `runs` u8 classes and `runs` u8/u16 lengths. A column is its runs from
 * the bottom up; whatever is above the last run is air.
 */
export function decodeChunk(blob: Uint8Array<ArrayBuffer>): DecodedChunk {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const flags = view.getUint8(1);
  const ny = view.getUint16(2, true);
  const runs = view.getUint32(4, true);
  const counts = blob.subarray(8, 8 + COLUMNS);
  const classes = blob.subarray(8 + COLUMNS, 8 + COLUMNS + runs);
  const lenAt = 8 + COLUMNS + runs;
  const wide = (flags & 1) !== 0;
  const cells = new Uint8Array(COLUMNS * ny);
  let run = 0;
  for (let col = 0; col < COLUMNS; col++) {
    let y = 0;
    for (let r = counts[col]; r > 0; r--, run++) {
      const len = wide ? view.getUint16(lenAt + run * 2, true) : blob[lenAt + run];
      const cls = classes[run];
      if (cls !== 0) {
        for (let k = 0, i = col + COLUMNS * y; k < len; k++, i += COLUMNS) cells[i] = cls;
      }
      y += len;
    }
  }
  return { cells, ny };
}

/** Chunk identity: level in the top bits so keys of different levels never collide and sort coarse-first. */
export type ChunkKey = number;

export function chunkKey(level: number, cx: number, cz: number): ChunkKey {
  return level * 0x4000000 + cz * 0x2000 + cx; // cx, cz < 8192
}

export function keyLevel(key: ChunkKey): number {
  return Math.floor(key / 0x4000000);
}

export function keyX(key: ChunkKey): number {
  return key % 0x2000;
}

export function keyZ(key: ChunkKey): number {
  return Math.floor((key % 0x4000000) / 0x2000);
}

export function parentKey(key: ChunkKey): ChunkKey {
  return chunkKey(keyLevel(key) + 1, keyX(key) >> 1, keyZ(key) >> 1);
}
