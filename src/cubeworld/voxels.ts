/**
 * The voxel vocabulary shared by cubeworld and the lab: one byte per cell, 0 is air.
 * Index of cell (x, y, z) is `x + nx * (z + nz * y)`: x east, y up, z south.
 */
export const Class = {
  AIR: 0,
  GROUND: 1,
  ROAD: 2,
  SIDEWALK: 3,
  BUILDING: 4,
  ROOF: 5,
  VEGETATION: 6,
  POLE: 7,
  WATER: 8,
  RAIL: 9,
  BRIDGE: 10,
  FURNITURE: 11,
  FENCE: 12,
} as const;

export const CLASS_COUNT = 13;

export const CLASS_NAMES: readonly string[] = [
  'air',
  'ground',
  'road',
  'sidewalk',
  'building',
  'roof',
  'vegetation',
  'pole',
  'water',
  'rail',
  'bridge',
  'furniture',
  'fence',
];

/** The classes that make up the walkable surface; the view glides over the highest of them. */
export const TERRAIN_CLASSES: ReadonlySet<number> = new Set([
  Class.GROUND,
  Class.ROAD,
  Class.SIDEWALK,
  Class.WATER,
  Class.RAIL,
  Class.BRIDGE,
]);

export interface VoxelGrid {
  /** nx * ny * nz class bytes */
  readonly cells: Uint8Array;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/** Per column (x + nx * z): the level just above the highest terrain cell. */
export function terrainSurface(grid: VoxelGrid): Uint8Array {
  const { cells, nx, ny, nz } = grid;
  const surface = new Uint8Array(nx * nz);
  for (let y = 0; y < ny; y++) {
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        if (TERRAIN_CLASSES.has(cells[x + nx * (z + nz * y)])) surface[x + nx * z] = y + 1;
      }
    }
  }
  return surface;
}
