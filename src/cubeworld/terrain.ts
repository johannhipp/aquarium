import { Class, type VoxelGrid } from './voxels';

/** A 50 x 50 footprint, up to 100 cubes high: 250,000 potential cubes in one flat byte array. */
export const WORLD_W = 50;
export const WORLD_D = 50;
export const WORLD_H = 100;
export const WATER_LEVEL = 8;

/** Deterministic lattice hash in [0, 1). */
export function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise with a quintic fade: smooth, cheap, good enough for hills. */
function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal sum of value noise, normalised to roughly [0, 1]. */
function fbm(x: number, z: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * f, z * f, seed + i * 101);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Column height in cubes (1..WORLD_H): rolling hills, one tall massif, and a meandering river valley. */
function columnHeight(x: number, z: number, seed: number): number {
  const hills = fbm(x * 0.06, z * 0.06, seed, 4);
  const ridge = 1 - Math.abs(2 * fbm(x * 0.08 + 17, z * 0.08 - 9, seed + 7, 3) - 1);
  // one broad massif and a lower second hill (the world allows up to WORLD_H = 100)
  const peak = Math.exp(-((x - 36) ** 2 + (z - 14) ** 2) / (2 * 9 * 9));
  const knoll = Math.exp(-((x - 11) ** 2 + (z - 40) ** 2) / (2 * 8 * 8));
  let h = 3 + hills * hills * 18 + ridge * ridge * 7 + peak ** 1.15 * 62 + knoll * 20;
  // the river: a sine-wandering channel pulled down to just under the water level
  const course = 27 + 7 * Math.sin(x * 0.14 + 1.2) + 2.5 * Math.sin(x * 0.33);
  const valley = 1 - smoothstep(1.2, 5.5, Math.abs(z - course));
  h += (WATER_LEVEL - 2 - h) * valley;
  return Math.min(WORLD_H, Math.max(1, Math.round(h)));
}

export function generateTerrain(seed: number): VoxelGrid {
  const cells = new Uint8Array(WORLD_W * WORLD_D * WORLD_H);
  for (let z = 0; z < WORLD_D; z++) {
    for (let x = 0; x < WORLD_W; x++) {
      const h = columnHeight(x, z, seed);
      for (let y = 0; y < h; y++) cells[x + WORLD_W * (z + WORLD_D * y)] = Class.GROUND;
      for (let y = h; y < WATER_LEVEL; y++) cells[x + WORLD_W * (z + WORLD_D * y)] = Class.WATER;
    }
  }
  return { cells, nx: WORLD_W, ny: WORLD_H, nz: WORLD_D };
}
