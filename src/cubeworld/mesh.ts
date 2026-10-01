import * as THREE from 'three';
import {
  AIR,
  GROUND,
  WATER,
  WORLD_D,
  WORLD_H,
  WORLD_W,
  cellIndex,
  hash2,
  type Voxels,
} from './terrain';

interface FaceDef {
  /** neighbour offset the face looks toward */
  d: readonly [number, number, number];
  /** four corners, counter-clockwise seen from outside */
  corners: readonly [number, number, number][];
  /** 0..1 darkness of the shaded side (the top stays light) */
  tone: number;
  top: boolean;
}

/** Light comes from the upper left: +x is the dark side, -x the bright one; the top stays white. */
const FACES: readonly FaceDef[] = [
  { d: [1, 0, 0], tone: 0.32, top: false, corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { d: [-1, 0, 0], tone: 0.1, top: false, corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { d: [0, 1, 0], tone: 0, top: true, corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { d: [0, 0, 1], tone: 0.22, top: false, corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { d: [0, 0, -1], tone: 0.15, top: false, corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];
const CORNER_UV: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [1, 1], [0, 1]];

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A face is drawn when what lies beyond it is air or the edge of the world (never the floor). */
function exposed(cells: Uint8Array, x: number, y: number, z: number, face: FaceDef): boolean {
  const nx = x + face.d[0];
  const ny = y + face.d[1];
  const nz = z + face.d[2];
  if (nx < 0 || nz < 0 || nx >= WORLD_W || nz >= WORLD_D || ny >= WORLD_H) return true;
  return cells[cellIndex(nx, ny, nz)] === AIR;
}

export interface WorldMesh {
  geometry: THREE.BufferGeometry;
  cubes: number;
  faces: number;
}

/**
 * One merged geometry of only the faces that can be seen: every solid cube whose neighbour is air
 * contributes that face as a unit quad (no merging across cubes, so each cube keeps its own edge
 * lines), hidden faces between touching cubes and the floor are never emitted. 250,000 cells are
 * scanned once; a typical landscape keeps a few tens of thousands of quads.
 */
export function buildWorldMesh(voxels: Voxels): WorldMesh {
  const { cells } = voxels;
  let faces = 0;
  let cubes = 0;
  for (let y = 0; y < WORLD_H; y++) {
    for (let z = 0; z < WORLD_D; z++) {
      for (let x = 0; x < WORLD_W; x++) {
        if (cells[cellIndex(x, y, z)] === AIR) continue;
        cubes++;
        for (const face of FACES) if (exposed(cells, x, y, z, face)) faces++;
      }
    }
  }

  const position = new Float32Array(faces * 12);
  const uv = new Float32Array(faces * 8);
  const shade = new Float32Array(faces * 8); // (tone, water) per vertex
  const index = faces * 4 > 65535 ? new Uint32Array(faces * 6) : new Uint16Array(faces * 6);
  let f = 0;
  for (let y = 0; y < WORLD_H; y++) {
    for (let z = 0; z < WORLD_D; z++) {
      for (let x = 0; x < WORLD_W; x++) {
        const cell = cells[cellIndex(x, y, z)];
        if (cell === AIR) continue;
        const water = cell === WATER;
        const jitter = hash2(x * 131 + y, z, 5) - 0.5;
        for (const face of FACES) {
          if (!exposed(cells, x, y, z, face)) continue;
          let tone: number;
          if (water) tone = face.top ? 0 : 0.5;
          else if (face.top) tone = 0.12 * (1 - smoothstep(6, 40, y)) + jitter * 0.08;
          else tone = face.tone + (1 - y / WORLD_H) * 0.08 + jitter * 0.06;
          tone = Math.min(0.9, Math.max(0, tone));
          const v = f * 4;
          for (let c = 0; c < 4; c++) {
            const [cx, cy, cz] = face.corners[c];
            const p = (v + c) * 3;
            position[p] = x + cx;
            position[p + 1] = y + cy;
            position[p + 2] = z + cz;
            const t = (v + c) * 2;
            uv[t] = CORNER_UV[c][0];
            uv[t + 1] = CORNER_UV[c][1];
            shade[t] = tone;
            shade[t + 1] = water ? 1 : 0;
          }
          const i = f * 6;
          index[i] = v;
          index[i + 1] = v + 1;
          index[i + 2] = v + 2;
          index[i + 3] = v;
          index[i + 4] = v + 2;
          index[i + 5] = v + 3;
          f++;
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('aShade', new THREE.BufferAttribute(shade, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  // fixed bounds: the world never changes, so culling needs no per-frame work
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(WORLD_W, WORLD_H, WORLD_D));
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  return { geometry, cubes, faces };
}

/**
 * The 1-bit look, all in the fragment shader (no line geometry): every face's tone is thresholded
 * against an ordered 4x4 Bayer matrix in screen space, so shading is pure black and white dots like
 * a Game Boy screen; each cube's edge is drawn from the face UVs as a line about one CSS pixel
 * wide, and fades out when cubes shrink below a few pixels so far-away terrain turns to dither
 * instead of a black smear. Water gets dashed rows instead of dots.
 */
export function createWorldMaterial(pixelRatio: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      // dither cell, in device pixels: 2 CSS px keeps the dots chunky and crisp
      uCell: { value: 2 * pixelRatio },
      // edge half-width in device pixels
      uLine: { value: 0.55 * pixelRatio },
      uInk: { value: new THREE.Vector3(11 / 255, 11 / 255, 11 / 255) },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aShade;
      varying vec2 vUv;
      varying vec2 vShade;
      void main() {
        vUv = uv;
        vShade = aShade;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uCell;
      uniform float uLine;
      uniform vec3 uInk;
      varying vec2 vUv;
      varying vec2 vShade;

      float b2(vec2 p) {
        p = mod(p, 2.0);
        return mod(2.0 * p.x + 3.0 * p.y, 4.0);
      }
      float bayer4(vec2 p) {
        return (4.0 * b2(p) + b2(floor(p / 2.0)) + 0.5) / 16.0;
      }

      void main() {
        vec2 cell = floor(gl_FragCoord.xy / uCell);
        bool ink;
        if (vShade.y > 0.5) {
          // water: brick-offset dashes
          float row = mod(cell.y, 2.0);
          float col = mod(cell.x + 2.0 * mod(floor(cell.y / 2.0), 2.0), 4.0);
          ink = row < 0.5 && col < 2.0;
        } else {
          ink = vShade.x > bayer4(cell);
        }
        // distance to the nearest cube edge, in device pixels
        vec2 fw = max(fwidth(vUv), vec2(1e-5));
        vec2 d = min(vUv, 1.0 - vUv) / fw;
        float edgePx = min(d.x, d.y);
        float cellPx = 1.0 / max(fw.x, fw.y);
        if (edgePx < uLine && cellPx > 3.0 * uLine * 2.0) ink = true;
        gl_FragColor = ink ? vec4(uInk, 1.0) : vec4(1.0);
      }
    `,
  });
}
