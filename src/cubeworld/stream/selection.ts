import * as THREE from 'three';
import { CHUNK, chunkKey, type ChunkKey, type Directory, type LevelInfo } from './format';

export interface SelectParams {
  frustum: THREE.Frustum;
  /** CSS pixels per metre on the ground at the current zoom (orthographic: the same everywhere on screen) */
  ppm: number;
  /** A level is fine enough when its cubes are at most this many CSS pixels wide. */
  detailPx: number;
  /** Grow every chunk's box by this many metres before the frustum test (uncertainty of a predicted pose). */
  pad: number;
}

const box = new THREE.Box3();

/**
 * The chunks to draw: a quadtree walk from the coarsest level. A node is split while its cubes would be wider
 * than `detailPx` on screen (screen-space error = cell size in pixels; with an orthographic camera it needs no
 * distance term) and it intersects the view. Children that carry no data are skipped; a node whose children are
 * all empty is kept as the leaf, so a hole in a finer level never erases land.
 */
export function selectChunks(dir: Directory, levels: readonly LevelInfo[], p: SelectParams): ChunkKey[] {
  const out: ChunkKey[] = [];
  const top = levels.length - 1;

  function exists(level: number, cx: number, cz: number): boolean {
    const lv = levels[level];
    return cx < lv.ncx && cz < lv.ncz && dir.lengths[level][cz * lv.ncx + cx] > 0;
  }

  function visit(level: number, cx: number, cz: number): void {
    const lv = levels[level];
    const size = CHUNK << level;
    const height = dir.heights[level][cz * lv.ncx + cx] << level;
    box.min.set(cx * size - p.pad, 0, cz * size - p.pad);
    box.max.set((cx + 1) * size + p.pad, height + p.pad, (cz + 1) * size + p.pad);
    if (!p.frustum.intersectsBox(box)) return;
    if (level > 0 && (1 << level) * p.ppm > p.detailPx) {
      const x = cx * 2;
      const z = cz * 2;
      const below = level - 1;
      const kids = [exists(below, x, z), exists(below, x + 1, z), exists(below, x, z + 1), exists(below, x + 1, z + 1)];
      if (kids.some(Boolean)) {
        if (kids[0]) visit(below, x, z);
        if (kids[1]) visit(below, x + 1, z);
        if (kids[2]) visit(below, x, z + 1);
        if (kids[3]) visit(below, x + 1, z + 1);
        return;
      }
    }
    out.push(chunkKey(level, cx, cz));
  }

  const roots = levels[top];
  for (let cz = 0; cz < roots.ncz; cz++) {
    for (let cx = 0; cx < roots.ncx; cx++) {
      if (exists(top, cx, cz)) visit(top, cx, cz);
    }
  }
  return out;
}
