import * as THREE from 'three';
import { hash2 } from './terrain';
import { CLASS_COUNT, Class, type VoxelGrid } from './voxels';

/** How a face's tone becomes black and white dots (the shader switches on this). */
export type Pattern = 'dither' | 'water' | 'solid' | 'stipple' | 'stripes';

export interface ClassStyle {
  /** 0 white .. 1 black: dot density of the top face */
  top: number;
  /** same for the sides, before the light-direction offsets */
  side: number;
  pattern: Pattern;
  /** draw each cube's outline */
  edges: boolean;
  /** random per-cube tone variation, 0..1 of the range */
  jitter: number;
}

const PATTERN_CODE: Record<Pattern, number> = { dither: 0, water: 1, solid: 2, stipple: 3, stripes: 4 };

/**
 * The 1-bit look of each class. Ground, buildings and roofs are shaded dither with outlined cubes;
 * roads are a dark flat with no outline so the street reads as one ribbon; poles are solid ink so a
 * one-cube column still reads; vegetation is a random stipple, water dashes, rail stripes.
 */
export const STYLES: readonly ClassStyle[] = (() => {
  const table: ClassStyle[] = Array.from({ length: CLASS_COUNT }, () => ({
    top: 0.2, side: 0.3, pattern: 'dither', edges: true, jitter: 0.05,
  }));
  table[Class.GROUND] = { top: 0.12, side: 0.26, pattern: 'dither', edges: true, jitter: 0.03 };
  table[Class.ROAD] = { top: 0.82, side: 0.82, pattern: 'dither', edges: false, jitter: 0 };
  table[Class.SIDEWALK] = { top: 0.04, side: 0.2, pattern: 'dither', edges: true, jitter: 0 };
  table[Class.BUILDING] = { top: 0, side: 0.2, pattern: 'dither', edges: true, jitter: 0 };
  table[Class.ROOF] = { top: 0, side: 0.2, pattern: 'dither', edges: true, jitter: 0 };
  table[Class.VEGETATION] = { top: 0.5, side: 0.5, pattern: 'stipple', edges: false, jitter: 0.08 };
  table[Class.POLE] = { top: 1, side: 1, pattern: 'solid', edges: false, jitter: 0 };
  table[Class.WATER] = { top: 0, side: 0.5, pattern: 'water', edges: true, jitter: 0 };
  table[Class.RAIL] = { top: 0.6, side: 0.6, pattern: 'stripes', edges: false, jitter: 0 };
  table[Class.BRIDGE] = { top: 0.5, side: 0.5, pattern: 'dither', edges: true, jitter: 0 };
  table[Class.FURNITURE] = { top: 0.7, side: 0.7, pattern: 'dither', edges: true, jitter: 0 };
  table[Class.FENCE] = { top: 0.35, side: 0.35, pattern: 'dither', edges: true, jitter: 0 };
  return table;
})();

interface FaceDef {
  /** neighbour offset the face looks toward */
  d: readonly [number, number, number];
  /** four corners, counter-clockwise seen from outside */
  corners: readonly [number, number, number][];
  /** tone offset from the class's side tone: light comes from the upper left, so +x is darker */
  delta: number;
  top: boolean;
  /** in-plane step to the neighbouring cell across each side of the quad (u=0, u=1, v=0, v=1) */
  sides: readonly (readonly [number, number, number])[];
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

const FACE_TABLE: readonly Omit<FaceDef, 'sides'>[] = [
  { d: [1, 0, 0], delta: 0.14, top: false, corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { d: [-1, 0, 0], delta: -0.08, top: false, corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { d: [0, 1, 0], delta: 0, top: true, corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { d: [0, 0, 1], delta: 0.06, top: false, corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { d: [0, 0, -1], delta: -0.02, top: false, corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];
const FACES: readonly FaceDef[] = FACE_TABLE.map((f) => ({ ...f, sides: planeSides(f.corners) }));
const CORNER_UV: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const ALL_SIDES = new Float32Array([1, 1, 1, 1]);

/** 'cube': outline every cube; 'outline': only where the surface is not flat across a side. */
export type EdgeMode = 'cube' | 'outline';

export interface WorldMesh {
  geometry: THREE.BufferGeometry;
  /** non-air cells */
  cubes: number;
  /** quads in the geometry after hidden-face culling */
  faces: number;
  /** quads per class, to see what the budget is spent on */
  facesByClass: number[];
}

/**
 * One merged geometry of only the faces that can be seen: every solid cube whose neighbour is air
 * contributes that face as a unit quad; faces between touching cubes and on the floor are never
 * emitted. In 'cube' mode every quad gets its own outline (individual cubes read), in 'outline'
 * mode only creases, steps and class borders do (big areas stay clean). The grid is scanned twice
 * (count, then fill) so the typed arrays are allocated once at their exact size.
 */
export function buildWorldMesh(
  grid: VoxelGrid,
  styles: readonly ClassStyle[] = STYLES,
  edgeMode: EdgeMode = 'cube',
): WorldMesh {
  const { cells, nx, ny, nz } = grid;
  const layer = nx * nz;
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

  /**
   * Outline mode: a side of a quad gets a line unless the quad continues flat across it, i.e. the
   * neighbouring cell in the plane has the same class and shows its face in the same direction.
   * Flat ground and flat walls stay clean; creases, steps and class borders are drawn.
   */
  const outline = edgeMode === 'outline';
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

  for (let y = 0; y < ny; y++) {
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
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

  const position = new Float32Array(faces * 12);
  const uv = new Float32Array(faces * 8);
  const shade = new Float32Array(faces * 12); // (tone, pattern, edges) per vertex
  const edge = new Float32Array(faces * 16); // which of the quad's four sides get a line
  const index = faces * 4 > 65535 ? new Uint32Array(faces * 6) : new Uint16Array(faces * 6);
  let q = 0;
  for (let y = 0; y < ny; y++) {
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        const c = cells[x + nx * z + layer * y];
        if (c === Class.AIR) continue;
        const style = styles[c < CLASS_COUNT ? c : Class.FURNITURE];
        const jitter = (hash2(x * 131 + y, z, 5) - 0.5) * 2 * style.jitter;
        for (const f of FACES) {
          if (!exposed(x, y, z, f)) continue;
          let tone = f.top ? style.top : style.side + f.delta;
          tone = Math.min(0.95, Math.max(0, tone + jitter));
          if (style.pattern === 'solid') tone = 1;
          const flags = outline ? sideFlags(c, x, y, z, f) : ALL_SIDES;
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
            shade[p] = tone;
            shade[p + 1] = PATTERN_CODE[style.pattern];
            shade[p + 2] = style.edges ? 1 : 0;
            const e = (v + k) * 4;
            edge[e] = flags[0];
            edge[e + 1] = flags[1];
            edge[e + 2] = flags[2];
            edge[e + 3] = flags[3];
          }
          const i = q * 6;
          index[i] = v;
          index[i + 1] = v + 1;
          index[i + 2] = v + 2;
          index[i + 3] = v;
          index[i + 4] = v + 2;
          index[i + 5] = v + 3;
          q++;
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('aShade', new THREE.BufferAttribute(shade, 3));
  geometry.setAttribute('aEdge', new THREE.BufferAttribute(edge, 4));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  // fixed bounds: the world never changes, so culling needs no per-frame work
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(nx, ny, nz));
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  return { geometry, cubes, faces, facesByClass };
}

/**
 * The 1-bit look, all in the fragment shader (no line geometry): every face's tone is thresholded
 * against an ordered 4x4 Bayer matrix in screen space, so shading is pure black and white dots like
 * a Game Boy screen; each cube's edge is drawn from the face UVs as a line about one CSS pixel
 * wide, and fades out when cubes shrink below a few pixels so far-away terrain turns to dither
 * instead of a black smear. Per class the pattern switches: water gets dashed rows, vegetation a
 * random stipple, rail horizontal stripes, poles solid ink.
 */
export function createWorldMaterial(pixelRatio: number, lineCssPx = 0.55): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      // dither cell, in device pixels: 2 CSS px keeps the dots chunky and crisp
      uCell: { value: 2 * pixelRatio },
      // edge half-width in device pixels
      uLine: { value: lineCssPx * pixelRatio },
      uInk: { value: new THREE.Vector3(11 / 255, 11 / 255, 11 / 255) },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aShade;
      attribute vec4 aEdge;
      varying vec2 vUv;
      varying vec3 vShade;
      varying vec4 vEdge;
      void main() {
        vUv = uv;
        vShade = aShade;
        vEdge = aEdge;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uCell;
      uniform float uLine;
      uniform vec3 uInk;
      varying vec2 vUv;
      varying vec3 vShade;
      varying vec4 vEdge;

      float b2(vec2 p) {
        p = mod(p, 2.0);
        return mod(2.0 * p.x + 3.0 * p.y, 4.0);
      }
      float bayer4(vec2 p) {
        return (4.0 * b2(p) + b2(floor(p / 2.0)) + 0.5) / 16.0;
      }
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        vec2 cell = floor(gl_FragCoord.xy / uCell);
        float tone = vShade.x;
        float pattern = vShade.y;
        bool ink;
        if (pattern > 3.5) {
          // rail: ties and rails, horizontal stripes
          ink = mod(cell.y, 3.0) < 1.5 && tone > 0.2;
        } else if (pattern > 2.5) {
          // vegetation: random stipple, no regular grid, so it reads as foliage
          ink = tone > hash(cell);
        } else if (pattern > 1.5) {
          ink = true;
        } else if (pattern > 0.5) {
          // water: brick-offset dashes
          float row = mod(cell.y, 2.0);
          float col = mod(cell.x + 2.0 * mod(floor(cell.y / 2.0), 2.0), 4.0);
          ink = row < 0.5 && col < 2.0;
        } else {
          ink = tone > bayer4(cell);
        }
        // distance to each side of the quad, in device pixels; only flagged sides are drawn
        vec2 fw = max(fwidth(vUv), vec2(1e-5));
        vec4 side = vec4(vUv.x / fw.x, (1.0 - vUv.x) / fw.x, vUv.y / fw.y, (1.0 - vUv.y) / fw.y);
        vec4 drawn = mix(vec4(1e6), side, step(0.5, vEdge));
        float edgePx = min(min(drawn.x, drawn.y), min(drawn.z, drawn.w));
        float cellPx = 1.0 / max(fw.x, fw.y);
        if (vShade.z > 0.5 && edgePx < uLine && cellPx > 3.0 * uLine * 2.0) ink = true;
        gl_FragColor = ink ? vec4(uInk, 1.0) : vec4(1.0);
      }
    `,
  });
}
