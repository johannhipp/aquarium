import * as THREE from 'three';
import { rgb, type Palette } from '../palettes';
import { CHUNK, type Directory, type LevelInfo } from './format';

/**
 * What shows where no chunk has arrived yet: a flat sheet of paper with a faint dither, under the world's floor
 * (y = 0) so any chunk that does arrive covers it, and cut to the footprint of the data (the directory says which
 * 128 m cells have chunks), so the edge of the world is where the data ends. No spinner, no text.
 */
export function createPlaceholder(dir: Directory, level: LevelInfo, palette: Palette): THREE.Mesh {
  const cover = new Uint8Array(level.ncx * level.ncz);
  const lengths = dir.lengths[level.level];
  for (let i = 0; i < cover.length; i++) cover[i] = lengths[i] > 0 ? 255 : 0;
  const texture = new THREE.DataTexture(cover, level.ncx, level.ncz, THREE.RedFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;

  const width = level.ncx * CHUNK * level.cell;
  const depth = level.ncz * CHUNK * level.cell;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCover: { value: texture },
      uSize: { value: new THREE.Vector2(width, depth) },
      uPaper: { value: new THREE.Vector3(...rgb(palette.background.bottom)) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vXZ;
      void main() {
        vXZ = (modelMatrix * vec4(position, 1.0)).xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uCover;
      uniform vec2 uSize;
      uniform vec3 uPaper;
      varying vec2 vXZ;
      void main() {
        if (texture2D(uCover, vXZ / uSize).r < 0.5) discard;
        vec2 cell = floor(gl_FragCoord.xy / 4.0);
        float dot = step(mod(cell.x + 2.0 * cell.y, 9.0), 0.5);
        gl_FragColor = vec4(mix(uPaper, uPaper * 0.82, dot), 1.0);
      }
    `,
  });
  const geometry = new THREE.PlaneGeometry(width, depth);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(width / 2, -0.5, depth / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -5;
  return mesh;
}

export function recolorPlaceholder(mesh: THREE.Mesh, palette: Palette): void {
  (mesh.material as THREE.ShaderMaterial).uniforms.uPaper.value.set(...rgb(palette.background.bottom));
}
