import { Class, CLASS_COUNT, type VoxelGrid } from '../cubeworld/voxels';

/**
 * Which class wins when a k x k x k block holds several. Thin things first, so they survive the
 * downsample: a pole beats a wall beats a road beats the ground; air only wins an empty block.
 */
const WINNERS: readonly number[] = [
  Class.POLE,
  Class.FURNITURE,
  Class.FENCE,
  Class.VEGETATION,
  Class.ROOF,
  Class.BUILDING,
  Class.BRIDGE,
  Class.RAIL,
  Class.WATER,
  Class.SIDEWALK,
  Class.ROAD,
  Class.GROUND,
  Class.AIR,
];

const RANK = (() => {
  const rank = new Uint8Array(256).fill(WINNERS.length); // unknown ids rank below everything
  WINNERS.forEach((c, i) => {
    rank[c] = i;
  });
  return rank;
})();

/** Downsamples by an integer factor with priority pooling; the result has ceil(n / k) cells per axis. */
export function poolGrid(grid: VoxelGrid, k: number): VoxelGrid {
  if (k <= 1) return grid;
  const { cells, nx, ny, nz } = grid;
  const ox = Math.ceil(nx / k);
  const oy = Math.ceil(ny / k);
  const oz = Math.ceil(nz / k);
  const out = new Uint8Array(ox * oy * oz);
  for (let y = 0; y < oy; y++) {
    for (let z = 0; z < oz; z++) {
      for (let x = 0; x < ox; x++) {
        let best: number = Class.AIR;
        let bestRank = RANK[Class.AIR];
        for (let dy = 0; dy < k && y * k + dy < ny; dy++) {
          for (let dz = 0; dz < k && z * k + dz < nz; dz++) {
            for (let dx = 0; dx < k && x * k + dx < nx; dx++) {
              const c = cells[x * k + dx + nx * (z * k + dz + nz * (y * k + dy))];
              const rank = RANK[c < CLASS_COUNT ? c : 255];
              if (rank < bestRank) {
                best = c;
                bestRank = rank;
              }
            }
          }
        }
        out[x + ox * (z + oz * y)] = best;
      }
    }
  }
  return { cells: out, nx: ox, ny: oy, nz: oz };
}
