import * as THREE from 'three';
import { DEFAULT_PALETTE, type Palette } from './palettes';
import { hash2 } from './terrain';
import { CLASS_COUNT, Class, type VoxelGrid } from './voxels';

/** Face orientation ids, as the world shader reads them from `aInfo.y`. */
export const ORIENT = { EAST: 0, WEST: 1, TOP: 2, SOUTH: 3, NORTH: 4 } as const;

interface FaceDef {
  /** neighbour offset the face looks toward */
  d: readonly [number, number, number];
  /** four corners, counter-clockwise seen from outside */
  corners: readonly [number, number, number][];
  orient: number;
  /** in-plane step to the neighbouring cell across each side of the quad (u=0, u=1, v=0, v=1) */
  sides: readonly (readonly [number, number, number])[];
  /** per corner: the three cells that occlude it (two edge neighbours, then the diagonal), as 9 ints, relative to the cube */
  aoCells: Int8Array;
}

/** Unit step in the plane for the quad's sides in UV order: u=0, u=1, v=0, v=1. */
function planeSides(corners: readonly [number, number, number][]): [number, number, number][] {
  const [c0, c1, , c3] = corners;
  const du: [number, number, number] = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
  const dv: [number, number, number] = [c3[0] - c0[0], c3[1] - c0[1], c3[2] - c0[2]];
  return [
    [-du[0], -du[1], -du[2]],
    du,
    [-dv[0], -dv[1], -dv[2]],
    dv,
  ];
}

/**
 * The classic voxel-AO neighbourhood: a corner of a face is darkened by the two cells beside it
 * and the one diagonal to it, all in the layer just in front of the face.
 */
function aoNeighbours(d: readonly [number, number, number], corners: readonly [number, number, number][]): Int8Array {
  const out = new Int8Array(36);
  const axes = [0, 1, 2].filter((i) => d[i] === 0);
  const [a, b] = axes;
  corners.forEach((p, k) => {
    const sa = p[a] * 2 - 1;
    const sb = p[b] * 2 - 1;
    const cell = (da: number, db: number): [number, number, number] => {
      const v: [number, number, number] = [d[0], d[1], d[2]];
      v[a] += da;
      v[b] += db;
      return v;
    };
    const cells = [cell(sa, 0), cell(0, sb), cell(sa, sb)];
    cells.forEach((v, i) => out.set(v, k * 9 + i * 3));
  });
  return out;
}

const FACE_TABLE: readonly Omit<FaceDef, 'sides' | 'aoCells'>[] = [
  { d: [1, 0, 0], orient: ORIENT.EAST, corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { d: [-1, 0, 0], orient: ORIENT.WEST, corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { d: [0, 1, 0], orient: ORIENT.TOP, corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { d: [0, 0, 1], orient: ORIENT.SOUTH, corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { d: [0, 0, -1], orient: ORIENT.NORTH, corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];
const FACES: readonly FaceDef[] = FACE_TABLE.map((f) => ({
  ...f,
  sides: planeSides(f.corners),
  aoCells: aoNeighbours(f.d, f.corners),
}));
const CORNER_UV: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const ALL_SIDES = new Float32Array([1, 1, 1, 1]);
const NO_AO = new Float32Array([1, 1, 1, 1]);

/** A half-open box of cells, in grid coordinates. */
export interface MeshRegion {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export interface WorldMesh {
  geometry: THREE.BufferGeometry;
  /** non-air cells in the region */
  cubes: number;
  /** quads in the geometry after hidden-face culling */
  faces: number;
  /** quads per class, to see what the budget is spent on */
  facesByClass: number[];
  /** xyz (grid coordinates) of the centre of every lamp tip in the region, for the halo sprites */
  glows: Float32Array;
}

/**
 * One merged geometry of only the faces that can be seen: every solid cube whose neighbour is air
 * contributes that face as a unit quad; faces between touching cubes and on the floor are never
 * emitted. The palette decides only what is stored per vertex, never which quads exist: whether
 * each quad's sides carry an outline flag ('cube' every side, 'outline' only creases and steps),
 * the corner AO values, and the lamp-pool light. Colours themselves live in the shader.
 *
 * `region` limits the output to a box of cells while still reading neighbours outside it (but
 * inside `grid`) for culling, AO and outline flags, so separately built chunks stitch seamlessly.
 * Positions are in grid coordinates. Cells beyond the grid count as air. The grid is scanned twice
 * (count, then fill) so the typed arrays are allocated once at their exact size.
 *
 * Attributes: position, uv (quad corners, for outlines), aInfo = (class, orientation, lamp tip,
 * per-cube hash), aAo (1 clear .. 0 fully occluded), aEdge (outline flag per quad side), aLight.
 */
export function buildWorldMesh(grid: VoxelGrid, palette: Palette = DEFAULT_PALETTE, region?: MeshRegion): WorldMesh {
  const { cells, nx, ny, nz } = grid;
  const layer = nx * nz;
  const bx0 = Math.max(0, region?.x0 ?? 0);
  const by0 = Math.max(0, region?.y0 ?? 0);
  const bz0 = Math.max(0, region?.z0 ?? 0);
  const bx1 = Math.min(nx, region?.x1 ?? nx);
  const by1 = Math.min(ny, region?.y1 ?? ny);
  const bz1 = Math.min(nz, region?.z1 ?? nz);
  const facesByClass = new Array<number>(CLASS_COUNT).fill(0);
  let faces = 0;
  let cubes = 0;

  /** A face is drawn when what lies beyond it is air or the side of the world (never the floor). */
  const exposed = (x: number, y: number, z: number, f: FaceDef): boolean => {
    const ax = x + f.d[0];
    const ay = y + f.d[1];
    const az = z + f.d[2];
    if (ax < 0 || az < 0 || ax >= nx || az >= nz || ay >= ny) return true;
    return cells[ax + nx * az + layer * ay] === Class.AIR;
  };

  const solid = (x: number, y: number, z: number): number =>
    x >= 0 && z >= 0 && y >= 0 && x < nx && z < nz && y < ny && cells[x + nx * z + layer * y] !== Class.AIR ? 1 : 0;

  /**
   * Outline mode: a side of a quad gets a line unless the quad continues flat across it, i.e. the
   * neighbouring cell in the plane has the same class and shows its face in the same direction.
   * Flat ground and flat walls stay clean; creases, steps and class borders are drawn.
   */
  const outline = palette.outline.mode === 'outline';
  const flags = new Float32Array(4);
  const sideFlags = (c: number, x: number, y: number, z: number, f: FaceDef): Float32Array => {
    for (let s = 0; s < 4; s++) {
      const [ex, ey, ez] = f.sides[s];
      const px = x + ex;
      const py = y + ey;
      const pz = z + ez;
      let flat = false;
      if (px >= 0 && pz >= 0 && px < nx && pz < nz && py >= 0 && py < ny) {
        flat = cells[px + nx * pz + layer * py] === c && exposed(px, py, pz, f);
      }
      flags[s] = flat ? 0 : 1;
    }
    return flags;
  };

  /** 1 clear .. 0 fully enclosed per corner. */
  const useAo = palette.ao.strength > 0;
  const ao = new Float32Array(4);
  const cornerAo = (x: number, y: number, z: number, f: FaceDef): Float32Array => {
    const t = f.aoCells;
    for (let k = 0; k < 4; k++) {
      const o = k * 9;
      const s1 = solid(x + t[o], y + t[o + 1], z + t[o + 2]);
      const s2 = solid(x + t[o + 3], y + t[o + 4], z + t[o + 5]);
      const c = solid(x + t[o + 6], y + t[o + 7], z + t[o + 8]);
      ao[k] = (s1 && s2 ? 0 : 3 - (s1 + s2 + c)) / 3;
    }
    return ao;
  };

  /** A lamp tip is a pole cube with nothing above it. */
  const isTip = (c: number, x: number, y: number, z: number): boolean =>
    c === Class.POLE && (y + 1 >= ny || cells[x + nx * z + layer * (y + 1)] === Class.AIR);

  for (let y = by0; y < by1; y++) {
    for (let z = bz0; z < bz1; z++) {
      for (let x = bx0; x < bx1; x++) {
        const c = cells[x + nx * z + layer * y];
        if (c === Class.AIR) continue;
        cubes++;
        for (const f of FACES) {
          if (!exposed(x, y, z, f)) continue;
          faces++;
          facesByClass[c < CLASS_COUNT ? c : Class.FURNITURE]++;
        }
      }
    }
  }

  // Lamps for the light pool (and the halo list): tips inside the region, plus a margin of
  // pool radius so chunk borders light up the same on both sides.
  const lamp = palette.lamp;
  const radius = lamp?.pool ?? 0;
  const lampXyz: number[] = [];
  const glowXyz: number[] = [];
  if (lamp) {
    const m = Math.ceil(radius);
    const sx0 = Math.max(0, bx0 - m);
    const sy0 = Math.max(0, by0 - m);
    const sz0 = Math.max(0, bz0 - m);
    const sx1 = Math.min(nx, bx1 + m);
    const sy1 = Math.min(ny, by1 + m);
    const sz1 = Math.min(nz, bz1 + m);
    for (let y = radius > 0 ? sy0 : by0; y < (radius > 0 ? sy1 : by1); y++) {
      for (let z = radius > 0 ? sz0 : bz0; z < (radius > 0 ? sz1 : bz1); z++) {
        for (let x = radius > 0 ? sx0 : bx0; x < (radius > 0 ? sx1 : bx1); x++) {
          if (!isTip(cells[x + nx * z + layer * y], x, y, z)) continue;
          lampXyz.push(x + 0.5, y + 0.5, z + 0.5);
          if (x >= bx0 && x < bx1 && y >= by0 && y < by1 && z >= bz0 && z < bz1) glowXyz.push(x + 0.5, y + 0.5, z + 0.5);
        }
      }
    }
  }
  const bins = new Map<number, number[]>();
  const binKey = (i: number, k: number): number => i * 65536 + k;
  if (radius > 0) {
    for (let i = 0; i < lampXyz.length; i += 3) {
      const key = binKey(Math.floor(lampXyz[i] / radius), Math.floor(lampXyz[i + 2] / radius));
      const list = bins.get(key);
      if (list) list.push(i);
      else bins.set(key, [i]);
    }
  }
  /** Light pool at a vertex: each lamp within `radius` adds a squared falloff, scaled by how squarely the face looks at it. */
  const poolAt = (px: number, py: number, pz: number, f: FaceDef): number => {
    const bi = Math.floor(px / radius);
    const bk = Math.floor(pz / radius);
    let sum = 0;
    for (let di = -1; di <= 1; di++) {
      for (let dk = -1; dk <= 1; dk++) {
        const list = bins.get(binKey(bi + di, bk + dk));
        if (!list) continue;
        for (const i of list) {
          const dx = lampXyz[i] - px;
          const dy = lampXyz[i + 1] - py;
          const dz = lampXyz[i + 2] - pz;
          const dist = Math.hypot(dx, dy, dz);
          if (dist >= radius) continue;
          const facing = dist < 1e-4 ? 1 : (dx * f.d[0] + dy * f.d[1] + dz * f.d[2]) / dist;
          const w = Math.min(1, Math.max(0, facing * 0.8 + 0.35));
          const a = 1 - dist / radius;
          sum += a * a * w;
        }
      }
    }
    return Math.min(1, sum);
  };

  const position = new Float32Array(faces * 12);
  const uv = new Float32Array(faces * 8);
  const info = new Float32Array(faces * 16); // (class, orientation, lamp tip, hash) per vertex
  const aoAttr = new Float32Array(faces * 4);
  const light = new Float32Array(faces * 4);
  const edge = new Float32Array(faces * 16); // which of the quad's four sides get a line
  const index = faces * 4 > 65535 ? new Uint32Array(faces * 6) : new Uint16Array(faces * 6);
  let q = 0;
  for (let y = by0; y < by1; y++) {
    for (let z = bz0; z < bz1; z++) {
      for (let x = bx0; x < bx1; x++) {
        const c = cells[x + nx * z + layer * y];
        if (c === Class.AIR) continue;
        const cls = c < CLASS_COUNT ? c : Class.FURNITURE;
        const tip = isTip(c, x, y, z) ? 1 : 0;
        const hash = hash2(x * 131 + y, z, 5);
        for (let fi = 0; fi < FACES.length; fi++) {
          const f = FACES[fi];
          if (!exposed(x, y, z, f)) continue;
          const flags = outline ? sideFlags(c, x, y, z, f) : ALL_SIDES;
          const corner = useAo ? cornerAo(x, y, z, f) : NO_AO;
          const v = q * 4;
          for (let k = 0; k < 4; k++) {
            const [cx, cy, cz] = f.corners[k];
            const p = (v + k) * 3;
            position[p] = x + cx;
            position[p + 1] = y + cy;
            position[p + 2] = z + cz;
            const t = (v + k) * 2;
            uv[t] = CORNER_UV[k][0];
            uv[t + 1] = CORNER_UV[k][1];
            const s = (v + k) * 4;
            info[s] = cls;
            info[s + 1] = f.orient;
            info[s + 2] = tip;
            info[s + 3] = hash;
            aoAttr[v + k] = corner[k];
            if (radius > 0) light[v + k] = poolAt(x + cx, y + cy, z + cz, f);
            edge[s] = flags[0];
            edge[s + 1] = flags[1];
            edge[s + 2] = flags[2];
            edge[s + 3] = flags[3];
          }
          const i = q * 6;
          // split along the diagonal through the darker pair of corners, so AO never shows a seam
          if (corner[0] + corner[2] > corner[1] + corner[3]) {
            index[i] = v + 1;
            index[i + 1] = v + 2;
            index[i + 2] = v + 3;
            index[i + 3] = v + 1;
            index[i + 4] = v + 3;
            index[i + 5] = v;
          } else {
            index[i] = v;
            index[i + 1] = v + 1;
            index[i + 2] = v + 2;
            index[i + 3] = v;
            index[i + 4] = v + 2;
            index[i + 5] = v + 3;
          }
          q++;
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
  geometry.setAttribute('aAo', new THREE.BufferAttribute(aoAttr, 1));
  geometry.setAttribute('aLight', new THREE.BufferAttribute(light, 1));
  geometry.setAttribute('aEdge', new THREE.BufferAttribute(edge, 4));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  // fixed bounds: the world never changes, so culling needs no per-frame work
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(bx0, by0, bz0), new THREE.Vector3(bx1, by1, bz1));
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  return { geometry, cubes, faces, facesByClass, glows: new Float32Array(glowXyz) };
}
