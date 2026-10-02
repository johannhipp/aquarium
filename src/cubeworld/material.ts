import * as THREE from 'three';
import { CLASS_COUNT, Class } from './voxels';
import { classLook, rgb, type Palette } from './palettes';

/** Main-thread only: the shader side of a palette (the mesh builder in mesh.ts is worker-safe). */

const vec3 = (hex: string): THREE.Vector3 => new THREE.Vector3(...rgb(hex));

const WORLD_VERTEX = /* glsl */ `
  uniform float uFocus;
  attribute vec4 aInfo;
  attribute float aAo;
  attribute float aLight;
  attribute vec4 aEdge;
  varying vec2 vUv;
  varying vec4 vInfo;
  varying float vAo;
  varying float vLight;
  varying vec4 vEdge;
  varying vec3 vPos;
  varying float vDepth;
  void main() {
    vUv = uv;
    vInfo = aInfo;
    vAo = aAo;
    vLight = aLight;
    vEdge = aEdge;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPos = world.xyz;
    vec4 mv = viewMatrix * world;
    // distance behind the view's focus point: positive on the far side
    vDepth = -mv.z - uFocus;
    gl_Position = projectionMatrix * mv;
  }
`;

const WORLD_FRAGMENT = /* glsl */ `
  uniform vec3 uTop[${CLASS_COUNT}];
  uniform vec3 uSide[${CLASS_COUNT}];
  uniform float uJitter[${CLASS_COUNT}];
  uniform float uClassLine[${CLASS_COUNT}];
  uniform vec3 uFace[5];
  uniform float uDpr;
  uniform float uPixel;
  uniform vec3 uLineColor;
  uniform float uLineWidth;
  uniform float uLineTint;
  uniform float uLineOpacity;
  uniform float uAoStrength;
  uniform float uAoGamma;
  uniform vec3 uAoTint;
  uniform float uGrain;
  uniform float uRipple;
  uniform vec2 uWallFade;   // strength, height
  uniform vec4 uWindow;     // density, 0, 0, 0
  uniform vec3 uWindowColor;
  uniform vec3 uWindowAlt;
  uniform vec3 uLampColor;
  uniform vec4 uLamp;       // tip mix, glow, pool strength, 0
  uniform vec4 uFog;        // start, end, amount, 0
  uniform vec3 uFogColor;
  uniform float uQuantN;
  uniform vec3 uQuant[4];
  varying vec2 vUv;
  varying vec4 vInfo;
  varying float vAo;
  varying float vLight;
  varying vec4 vEdge;
  varying vec3 vPos;
  varying float vDepth;

  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    int cls = int(vInfo.x + 0.5);
    int ori = int(vInfo.y + 0.5);
    float tip = step(0.5, vInfo.z);

    // chunky-pixel palettes sample every varying at the centre of a uPixel-sized cell
    vec2 snap = vec2(0.0);
    if (uPixel > 0.0) snap = (floor(gl_FragCoord.xy / uPixel) + 0.5) * uPixel - gl_FragCoord.xy;
    vec2 uv = vUv + dFdx(vUv) * snap.x + dFdy(vUv) * snap.y;
    float ao = clamp(vAo + dFdx(vAo) * snap.x + dFdy(vAo) * snap.y, 0.0, 1.0);
    vec3 pos = vPos + dFdx(vPos) * snap.x + dFdy(vPos) * snap.y;

    vec3 col = (ori == 2 ? uTop[cls] : uSide[cls]) * uFace[ori];
    col *= 1.0 + (vInfo.w - 0.5) * 2.0 * uJitter[cls];

    // walls darken towards the ground
    if (ori != 2) col *= 1.0 - uWallFade.x * exp(-max(pos.y, 0.0) / uWallFade.y);

    // water: soft wavy bands on the surface
    if (cls == ${Class.WATER} && ori == 2) {
      float r = sin(pos.x * 2.3 + sin(pos.z * 1.4) * 1.8 + pos.z * 0.9);
      col *= 1.0 + uRipple * (smoothstep(0.45, 0.95, r) - 0.3);
    }

    // lit windows: a small pane in the middle of some wall faces, chosen by the cube's hash
    if (uWindow.x > 0.0 && cls == ${Class.BUILDING} && ori != 2) {
      float h = fract(vInfo.w * 97.13 + float(ori) * 0.37);
      float pane = step(0.22, uv.x) * step(uv.x, 0.78) * step(0.26, uv.y) * step(uv.y, 0.74);
      if (h > 1.0 - uWindow.x) {
        vec3 wc = mix(uWindowColor, uWindowAlt, step(0.8, fract(h * 53.7)));
        col = mix(col, wc * (0.75 + 0.5 * fract(h * 31.1)), pane);
      }
    }

    // corner ambient occlusion
    float occl = pow(1.0 - ao, uAoGamma) * uAoStrength;
    col *= mix(vec3(1.0), uAoTint, occl);

    // lamp tips shine; their surroundings catch some of the light
    col += uLampColor * vLight * uLamp.z * (0.1 + 1.5 * dot(col, LUMA));
    col = mix(col, uLampColor * uLamp.y, tip * uLamp.x);

    // outlines: only the sides the builder flagged, only while cubes are big enough to carry a line
    vec2 fw = max(fwidth(vUv), vec2(1e-5));
    vec4 side = vec4(uv.x / fw.x, (1.0 - uv.x) / fw.x, uv.y / fw.y, (1.0 - uv.y) / fw.y);
    vec4 drawn = mix(vec4(1e6), side, step(0.5, vEdge));
    float edgePx = min(min(drawn.x, drawn.y), min(drawn.z, drawn.w));
    float cssCell = 1.0 / max(fw.x, fw.y) / uDpr;
    float cover = 1.0 - smoothstep(uLineWidth - 0.6, uLineWidth + 0.6, edgePx);
    if (uQuantN > 0.0) cover = step(0.5, cover);
    cover *= smoothstep(1.2, 4.0, cssCell) * uLineOpacity * uClassLine[cls];
    vec3 lineCol = mix(uLineColor, col * 0.45, uLineTint);
    col = mix(col, lineCol, cover);

    // depth fade into the haze
    col = mix(col, uFogColor, smoothstep(uFog.x, uFog.y, vDepth) * uFog.z);

    // paper grain, stuck to the screen rather than the cubes
    if (uGrain > 0.0) {
      float n = hash12(gl_FragCoord.xy) * 0.65 + hash12(floor(gl_FragCoord.xy / 3.0) + 17.0) * 0.35;
      col *= 1.0 + (n - 0.5) * uGrain;
    }

    if (uQuantN > 0.0) {
      float l = dot(col, LUMA);
      int idx = int(clamp(floor(l * uQuantN), 0.0, uQuantN - 1.0));
      col = uQuant[idx];
    }
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

/**
 * The world shader for a palette. All colour, light, outline and fog decisions are uniforms, so
 * one material serves every chunk of a world. `worldSize` (in world units) scales the depth fade:
 * the palette's fog start and end are fractions of it.
 */
export function createWorldMaterial(palette: Palette, pixelRatio: number, worldSize: number): THREE.ShaderMaterial {
  const top: THREE.Vector3[] = [];
  const side: THREE.Vector3[] = [];
  const jitter: number[] = [];
  const classLine: number[] = [];
  for (let c = 0; c < CLASS_COUNT; c++) {
    const look = classLook(palette, c);
    top.push(vec3(look.top));
    side.push(vec3(look.side ?? look.top));
    jitter.push(c === 0 ? 0 : (look.jitter ?? 0));
    classLine.push(look.outline === false || palette.outline.mode === 'none' ? 0 : 1);
  }
  const f = palette.faces;
  const quant = palette.quantize?.colors ?? [];
  const lamp = palette.lamp;
  const fog = palette.fog;
  return new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: top },
      uSide: { value: side },
      uJitter: { value: jitter },
      uClassLine: { value: classLine },
      uFace: { value: [f.east, f.west, f.top, f.south, f.north].map(vec3) },
      uDpr: { value: pixelRatio },
      uPixel: { value: palette.quantize ? palette.quantize.cssPixel * pixelRatio : 0 },
      uLineColor: { value: vec3(palette.outline.color) },
      uLineWidth: { value: palette.outline.width * pixelRatio },
      uLineTint: { value: palette.outline.tint },
      uLineOpacity: { value: palette.outline.opacity },
      uAoStrength: { value: palette.ao.strength },
      uAoGamma: { value: palette.ao.gamma },
      uAoTint: { value: vec3(palette.ao.tint) },
      uGrain: { value: palette.grain },
      uRipple: { value: palette.ripple },
      uWallFade: { value: new THREE.Vector2(palette.wallFade?.strength ?? 0, palette.wallFade?.height ?? 1) },
      uWindow: { value: new THREE.Vector4(palette.windows?.density ?? 0, 0, 0, 0) },
      uWindowColor: { value: vec3(palette.windows?.color ?? '#000000') },
      uWindowAlt: { value: vec3(palette.windows?.alt ?? '#000000') },
      uLampColor: { value: vec3(lamp?.color ?? '#000000') },
      uLamp: { value: new THREE.Vector4(lamp?.tip ?? 0, lamp?.glow ?? 1, lamp?.pool ? (lamp.poolStrength ?? 1) : 0, 0) },
      uFog: { value: new THREE.Vector4((fog?.start ?? 0) * worldSize, (fog?.end ?? 1) * worldSize, fog?.amount ?? 0, 0) },
      uFogColor: { value: vec3(fog?.color ?? '#ffffff') },
      uQuantN: { value: quant.length },
      uQuant: { value: [0, 1, 2, 3].map((i) => vec3(quant[Math.min(i, quant.length - 1)] ?? '#000000')) },
      uFocus: { value: 0 },
    },
    vertexShader: WORLD_VERTEX,
    fragmentShader: WORLD_FRAGMENT,
  });
}

/** Distance from the camera to the point the depth fade is measured from (the orbit target). Call once per frame. */
export function setWorldFocus(material: THREE.ShaderMaterial, depthToTarget: number): void {
  material.uniforms.uFocus.value = depthToTarget;
}

/** True when this palette wants an antialiased canvas (everything but the pixel-snapped ones). */
export function wantsAntialias(palette: Palette): boolean {
  return !palette.quantize;
}

/** A full-screen sky: gradient, vignette, grain and stars. Drawn first, never writes depth. */
export function createBackdrop(palette: Palette): THREE.Mesh {
  const b = palette.background;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: vec3(b.top) },
      uBottom: { value: vec3(b.bottom) },
      uVignette: { value: b.vignette },
      uGrain: { value: b.grain },
      uStars: { value: b.stars },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 1.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uBottom;
      uniform float uVignette;
      uniform float uGrain;
      uniform float uStars;
      varying vec2 vUv;
      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      void main() {
        vec3 col = mix(uBottom, uTop, smoothstep(0.0, 1.0, vUv.y));
        float v = length((vUv - 0.5) * vec2(1.0, 0.85));
        col *= 1.0 - uVignette * smoothstep(0.25, 0.85, v);
        vec2 px = gl_FragCoord.xy;
        if (uStars > 0.0) {
          vec2 cell = floor(px / 3.0);
          float h = hash12(cell);
          float star = step(1.0 - uStars * smoothstep(0.35, 1.0, vUv.y), h);
          col += star * (0.35 + 0.65 * hash12(cell + 7.0)) * vec3(0.8, 0.85, 1.0);
        }
        // fibres: fine noise plus a slower mottle, both fixed to the screen
        float n = hash12(px) * 0.6 + hash12(floor(px / 4.0) + 3.0) * 0.4;
        col *= 1.0 + (n - 0.5) * uGrain;
        col += (hash12(px + 11.0) - 0.5) / 255.0; // dither the gradient so it never bands
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

/**
 * Additive round halos over the lamp tips (the one place a palette uses a second draw call).
 * Returns null when the palette has no halo or the world no lamps.
 */
export function createGlowPoints(palette: Palette, glows: Float32Array): THREE.Points | null {
  const lamp = palette.lamp;
  if (!lamp || !lamp.halo || glows.length === 0) return null;
  const positions = new Float32Array(glows);
  for (let i = 1; i < positions.length; i += 3) positions[i] += 0.7; // above the tip so its own cube never hides it
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: vec3(lamp.color) },
      uSize: { value: lamp.halo },
      uPxPerUnit: { value: 4 },
    },
    vertexShader: /* glsl */ `
      uniform float uSize;
      uniform float uPxPerUnit;
      void main() {
        gl_PointSize = clamp(uSize * uPxPerUnit, 3.0, 220.0);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() {
        float r = length(gl_PointCoord * 2.0 - 1.0);
        float a = pow(max(0.0, 1.0 - r), 2.2) * 0.55 + exp(-r * r * 30.0) * 0.6;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 5;
  return points;
}

/** Device pixels per world unit, so halo sprites keep a fixed size in cubes while zooming. */
export function setGlowScale(points: THREE.Points, pxPerUnit: number): void {
  (points.material as THREE.ShaderMaterial).uniforms.uPxPerUnit.value = pxPerUnit;
}
