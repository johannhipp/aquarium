/**
 * The streamed world's wire format, produced by pipeline/cubeworld/stream_build.py (+ stream_codec.py). Worker-safe.
 *
 * `manifest.json` (this module's `Manifest`); `dir.<hash>.bin` (deflate-raw: the chunk model, then every chunk's
 * byte length and height in file order); `chunks.<hash>-<n>.bin`, the chunks back to back in `2^shardBits`-byte
 * shard files (no chunk straddles two), served with HTTP range requests; chunks that are neighbours in space
 * are neighbours in the file. Offsets are not stored: they are the running sum of the lengths, jumping to the next
 * shard when a chunk would not fit, see `parseDirectory`.
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
  files: { dir: string; chunks: string[] };
  /** log2 of the shard size in bytes: chunk offset `o` is in file `o >>> shardBits` at `o mod 2^shardBits` */
  shardBits: number;
  bytes: { dir: number; chunks: number };
  counts: { chunks: number; byLevel: number[] };
  themes: ThemeDef[];
}

/** Per level: where each chunk's blob sits in the archive, how long it is (0 = no chunk) and how tall it is in cells. */
export interface Directory {
  offsets: Uint32Array[];
  lengths: Uint32Array[];
  heights: Uint16Array[];
  model: ChunkModel;
}

export async function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ----------------------------------------------------------------------------- chunk model

const PROB_BITS = 12;
const PROB_MASK = (1 << PROB_BITS) - 1;
const RANS_L = 1 << 23;
/** [contexts, alphabet] of each table: pattern, ground height, building height select, building height, run count, run class, run length */
const TABLES: readonly (readonly [number, number])[] = [[400, 9], [175, 25], [16, 4], [1, 25], [1, 25], [14, 13], [13, 25]];
/** the model is stored for levels 0-3 and one set shared by 4-6 */
const GROUPS = 5;

/** Static rANS tables: `groups[g][table]` holds, per context, the cumulative frequencies (alphabet + 1 entries). */
export interface ChunkModel {
  groups: Uint16Array[][];
}

export const MODEL_BYTES = GROUPS * TABLES.reduce((n, [c, a]) => n + c * a, 0) * 2;

function parseModel(raw: Uint8Array<ArrayBuffer>): ChunkModel {
  const view = new DataView(raw.buffer, raw.byteOffset, MODEL_BYTES);
  const groups: Uint16Array[][] = [];
  let at = 0;
  for (let g = 0; g < GROUPS; g++) {
    const tables: Uint16Array[] = [];
    for (const [contexts, alphabet] of TABLES) {
      const cum = new Uint16Array(contexts * (alphabet + 1));
      for (let c = 0; c < contexts; c++) {
        let sum = 0;
        for (let s = 0; s < alphabet; s++) {
          cum[c * (alphabet + 1) + s] = sum;
          sum += view.getUint16(at, true);
          at += 2;
        }
        cum[c * (alphabet + 1) + alphabet] = sum; // 4096
      }
      tables.push(cum);
    }
    groups.push(tables);
  }
  return { groups };
}

const SUPER_CHUNKS_L0 = 16; // chunks per supertile side at level 0 (a supertile is 512 m)
const FINE_LEVELS = 5;

function morton(x: number, z: number): number {
  let m = 0;
  for (let b = 0; b < 14; b++) m += (((x >> b) & 1) << (2 * b)) + (((z >> b) & 1) << (2 * b + 1));
  return m;
}

/**
 * dir body after inflate: the model, then for every chunk slot in file order a u16 length and a u16 height, as four
 * byte planes (length low, length high, height low, height high). File order is the order the builder writes
 * chunks in: the top levels (FINE_LEVELS..) coarse first and Morton-ordered, then supertile by supertile in Morton
 * order, inside one coarse levels first and each in Morton order. Absent chunks have length 0.
 */
export function parseDirectory(raw: Uint8Array<ArrayBuffer>, manifest: Pick<Manifest, 'levels' | 'shardBits'>): Directory {
  const levels = manifest.levels;
  const model = parseModel(raw);
  const dir: Directory = {
    offsets: levels.map((lv) => new Uint32Array(lv.ncx * lv.ncz)),
    lengths: levels.map((lv) => new Uint32Array(lv.ncx * lv.ncz)),
    heights: levels.map((lv) => new Uint16Array(lv.ncx * lv.ncz)),
    model,
  };
  // the slots in file order
  const slots: { level: number; i: number }[] = [];
  const top = levels.length - 1;
  for (let level = top; level >= FINE_LEVELS; level--) {
    const lv = levels[level];
    const cells: { m: number; i: number }[] = [];
    for (let cz = 0; cz < lv.ncz; cz++) for (let cx = 0; cx < lv.ncx; cx++) cells.push({ m: morton(cx, cz), i: cz * lv.ncx + cx });
    cells.sort((a, b) => a.m - b.m);
    for (const c of cells) slots.push({ level, i: c.i });
  }
  const nsx = levels[0].ncx / SUPER_CHUNKS_L0;
  const nsz = levels[0].ncz / SUPER_CHUNKS_L0;
  const supers: { m: number; sx: number; sz: number }[] = [];
  for (let sz = 0; sz < nsz; sz++) for (let sx = 0; sx < nsx; sx++) supers.push({ m: morton(sx, sz), sx, sz });
  supers.sort((a, b) => a.m - b.m);
  const local: { lx: number; lz: number }[][] = [];
  for (let level = 0; level < FINE_LEVELS; level++) {
    const per = SUPER_CHUNKS_L0 >> level;
    const cells: { m: number; lx: number; lz: number }[] = [];
    for (let lz = 0; lz < per; lz++) for (let lx = 0; lx < per; lx++) cells.push({ m: morton(lx, lz), lx, lz });
    cells.sort((a, b) => a.m - b.m);
    local.push(cells);
  }
  for (const { sx, sz } of supers) {
    for (let level = FINE_LEVELS - 1; level >= 0; level--) {
      const per = SUPER_CHUNKS_L0 >> level;
      const ncx = levels[level].ncx;
      for (const { lx, lz } of local[level]) slots.push({ level, i: (sz * per + lz) * ncx + sx * per + lx });
    }
  }
  const n = slots.length;
  const body = raw.subarray(MODEL_BYTES);
  const shard = 2 ** manifest.shardBits;
  let cursor = 0;
  for (let k = 0; k < n; k++) {
    const { level, i } = slots[k];
    const length = body[k] | (body[n + k] << 8);
    dir.lengths[level][i] = length;
    dir.heights[level][i] = body[2 * n + k] | (body[3 * n + k] << 8);
    if (length === 0) continue;
    if ((cursor % shard) + length > shard) cursor = (Math.floor(cursor / shard) + 1) * shard;
    dir.offsets[level][i] = cursor;
    cursor += length;
  }
  return dir;
}

export interface DecodedChunk {
  /** SPAN x ny x SPAN cells, index `x + SPAN * (z + SPAN * y)` */
  cells: Uint8Array<ArrayBuffer>;
  ny: number;
}

const PAT_EMPTY = 0;
const PAT_GROUND = 1;
const PAT_BLDG_ROOF = 4;
const PAT_BLDG = 6;
const PAT_ROOF = 7;
const PAT_EXOTIC = 8;
const OUTSIDE = 9;
/** surface class of the ground + surface patterns (road, sidewalk, water) */
const SURFACE_CLASS = [0, 0, 2, 3, 0, 8, 0, 0, 0];

/**
 * chunk blob: u8 version (2), u16 ny, then a rANS stream (32-bit state, 12-bit probabilities, byte renormalisation,
 * the first four bytes are the initial state, little endian). Columns come in raster order over the SPAN x SPAN
 * window; each is a pattern (empty, ground, ground + road/sidewalk/water, ground + building [+ roof], ground + roof,
 * or an explicit run list for trees, poles, decks), the ground height predicted from the left/up neighbours, and
 * the building height as "same as left / up / up-right" or a fresh value. Every symbol uses a static frequency table
 * selected by already decoded neighbours (`ChunkModel`). Mirror of pipeline/cubeworld/stream_codec.py.
 */
export function decodeChunk(blob: Uint8Array<ArrayBuffer>, level: number, model: ChunkModel): DecodedChunk {
  if (blob[0] !== 2) throw new Error(`unknown chunk version ${blob[0]}`);
  const ny = blob[1] | (blob[2] << 8);
  const tables = model.groups[Math.min(level, GROUPS - 1)];
  let x = blob[3] | (blob[4] << 8) | (blob[5] << 16) | (blob[6] << 24);
  let pos = 7;

  const sym = (t: number, ctx: number): number => {
    const cum = tables[t];
    const base = ctx * (TABLES[t][1] + 1);
    const slot = x & PROB_MASK;
    let s = 0;
    while (cum[base + s + 1] <= slot) s++;
    const start = cum[base + s];
    x = (cum[base + s + 1] - start) * (x >>> PROB_BITS) + slot - start;
    while (x < RANS_L) x = (x << 8) | blob[pos++];
    return s;
  };
  const rawBits = (nb: number): number => {
    const shift = PROB_BITS - nb;
    const slot = x & PROB_MASK;
    const v = slot >>> shift;
    x = (1 << shift) * (x >>> PROB_BITS) + slot - (v << shift);
    while (x < RANS_L) x = (x << 8) | blob[pos++];
    return v;
  };
  const value = (t: number, ctx: number): number => {
    const s = sym(t, ctx);
    if (s < 12) return s;
    const k = s - 9;
    if (k > PROB_BITS) {
      const hi = rawBits(k - PROB_BITS);
      return 2 ** k + hi * (1 << PROB_BITS) + rawBits(PROB_BITS);
    }
    return (1 << k) + rawBits(k);
  };

  const W = SPAN + 2;
  const pat = new Uint8Array((SPAN + 1) * W).fill(OUTSIDE);
  const gs = new Int32Array((SPAN + 1) * W);
  const bh = new Int32Array((SPAN + 1) * W);
  const cells = new Uint8Array(COLUMNS * ny);
  const fill = (col: number, cls: number, y0: number, n: number): void => {
    if (cls === 0) return;
    for (let k = 0, i = col + COLUMNS * y0; k < n; k++, i += COLUMNS) cells[i] = cls;
  };

  for (let z = 0; z < SPAN; z++) {
    for (let xx = 0; xx < SPAN; xx++) {
      const at = (z + 1) * W + xx + 1;
      const pl = pat[at - 1];
      const pu = pat[at - W];
      const pid = sym(0, ((pl * 10 + pu) * 2 + (pat[at - W - 1] === pu ? 1 : 0)) * 2 + (pat[at - W + 1] === pu ? 1 : 0));
      pat[at] = pid;
      if (pid === PAT_EMPTY) continue;
      let sl: number, su: number, sul: number;
      if (xx > 0) {
        sl = gs[at - 1];
        su = z > 0 ? gs[at - W] : sl;
        sul = z > 0 ? gs[at - W - 1] : sl;
      } else if (z > 0) {
        sl = su = sul = gs[at - W];
      } else {
        sl = su = sul = 0;
      }
      const lo = Math.min(sl, su);
      const pred = Math.min(Math.max(sl + su - sul, lo), Math.max(sl, su));
      const col = z * SPAN + xx;
      if (pid === PAT_EXOTIC) {
        const runs = value(4, 0) + 1;
        let prev = 13;
        let y = 0;
        let first = true;
        for (let r = 0; r < runs; r++) {
          const cls = sym(5, prev);
          const n = value(6, cls) + 1;
          if (first) gs[at] = cls === PAT_GROUND ? n : pred;
          first = false;
          fill(col, cls, y, n);
          y += n;
          prev = cls;
        }
        continue;
      }
      const zz = value(1, (((Math.max(-2, Math.min(2, sl - sul)) + 2) * 5) + Math.max(-2, Math.min(2, su - sul)) + 2) * 7 + pid - 1);
      const s = pred + ((zz & 1) === 0 ? zz >> 1 : -((zz + 1) >> 1));
      gs[at] = s;
      fill(col, 1, 0, s);
      if (pid === PAT_BLDG_ROOF || pid === PAT_BLDG) {
        const bl = bh[at - 1];
        const bu = bh[at - W];
        const sel = sym(2, ((bl > 0 ? 2 : 0) + (bu > 0 ? 1 : 0)) * 4 + (pl === pid ? 2 : 0) + (pu === pid ? 1 : 0));
        const b = sel === 0 ? bl : sel === 1 ? bu : sel === 2 ? bh[at - W + 1] : value(3, 0) + 1;
        bh[at] = b;
        fill(col, 4, s, b);
        if (pid === PAT_BLDG_ROOF) fill(col, 5, s + b, 1);
      } else if (pid === PAT_ROOF) {
        fill(col, 5, s, 1);
      } else if (pid !== PAT_GROUND) {
        fill(col, SURFACE_CLASS[pid], s, 1);
      }
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
