import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Manifest, River } from './data';

/** Grid spacing of each bitmap's sphere patch; keeps chord sag far below the occluder gap. */
const PATCH_STEP_DEG = 1;
/** Depth-only sphere that hides far-side rivers without drawing any surface. */
const OCCLUDER_RADIUS = 0.998;
/** Camera distance (globe radius = 1) a flight settles at when it starts farther out. */
const FLIGHT_DISTANCE = 1.8;
/** Flight time: a base plus a share that grows with the angle travelled. */
const FLIGHT_BASE_MS = 2400;
const FLIGHT_PER_RAD_MS = 900 / Math.PI;
/** How far the camera backs off at mid-flight on a half-globe hop, so long trips read as an arc. */
const FLIGHT_ARC_PER_RAD = 0.6 / Math.PI;

export interface ScreenPoint {
  x: number;
  y: number;
  /** false when the point is on the far side of the globe */
  facing: boolean;
  /** true when something stands between the point and the camera (the map's notes dim slightly; the globe never sets it) */
  occluded?: boolean;
}

export interface Globe {
  /** Eased great-circle flight to a spot; resolves true on arrival, false if interrupted. */
  flyTo(lon: number, lat: number, opts: { instant: boolean }): Promise<boolean>;
  project(lon: number, lat: number, out: ScreenPoint): void;
  /**
   * Pause or resume rendering. Inactive stops the animation loop entirely (no GPU work, no
   * listeners), so another scene can own the screen; active redraws at once.
   */
  setActive(on: boolean): void;
  /** Off while a modal dialog is up, so drag and wheel never reach the globe behind it. */
  setInteractive(on: boolean): void;
  /** Called after every rendered frame (camera moved, zoomed, or the viewport resized). */
  onCameraMove(cb: () => void): void;
}

export function toSphere(lonDeg: number, latDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const lon = THREE.MathUtils.degToRad(lonDeg);
  const lat = THREE.MathUtils.degToRad(latDeg);
  return out.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
}

/** One merged geometry per atlas page: a lon/lat grid patch per river, textured with its bitmap. */
function buildPageGeometry(rivers: River[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const p = new THREE.Vector3();
  for (const r of rivers) {
    const [west, south, east, north] = r.bbox;
    const [u0, v0, u1, v1] = r.uv;
    const nx = Math.max(1, Math.ceil((east - west) / PATCH_STEP_DEG));
    const ny = Math.max(1, Math.ceil((north - south) / PATCH_STEP_DEG));
    const base = positions.length / 3;
    for (let j = 0; j <= ny; j++) {
      const t = j / ny;
      const lat = north + (south - north) * t;
      for (let i = 0; i <= nx; i++) {
        const s = i / nx;
        toSphere(west + (east - west) * s, lat, p);
        positions.push(p.x, p.y, p.z);
        uvs.push(u0 + (u1 - u0) * s, v0 + (v1 - v0) * t);
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = base + j * (nx + 1) + i;
        const b = a + nx + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Bitmap texel 0 = river, 1 = empty. Magnified: threshold the bilinear value with
 * screen-space AA so the bitmap stays crisp. Minified: mipmaps average thin lines toward
 * white, so coverage is scaled by texels-per-pixel to keep every river ~1px black.
 */
function riverMaterial(map: THREE.Texture, pageSize: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, texSize: { value: pageSize } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform float texSize;
      varying vec2 vUv;
      void main() {
        float c = 1.0 - texture2D(map, vUv).r;
        vec2 px = vUv * texSize;
        // anisotropic filtering samples along the minor axis, so that is the footprint to undo
        float tpp = min(length(dFdx(px)), length(dFdy(px)));
        float a = tpp < 1.0
          ? clamp((c - 0.5) / max(fwidth(c), 1e-4) + 0.5, 0.0, 1.0)
          : clamp(c * tpp * 1.25, 0.0, 1.0);
        if (a < 0.02) discard;
        gl_FragColor = vec4(0.0, 0.0, 0.0, a);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

interface Flight {
  from: THREE.Vector3;
  turn: THREE.Quaternion;
  startDistance: number;
  endDistance: number;
  arc: number;
  duration: number;
  start: number;
  done: (arrived: boolean) => void;
}

/** Ease-in-out with a gentle shoulder; the camera is already on screen, so no ease-out-only curve. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export async function createGlobe(manifest: Manifest): Promise<Globe> {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0xffffff, 1);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.001, 100);
  camera.position.set(0, 0, 4);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 1.02;
  controls.maxDistance = 10;
  controls.zoomSpeed = 1.2;

  const occluder = new THREE.Mesh(
    new THREE.SphereGeometry(OCCLUDER_RADIUS, 128, 64),
    new THREE.MeshBasicMaterial({ colorWrite: false }),
  );
  occluder.renderOrder = 0;
  scene.add(occluder);

  const loader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  await Promise.all(
    Array.from({ length: manifest.pages }, async (_, page) => {
      const tex = await loader.loadAsync(`/atlas/page-${page}.png`);
      tex.format = THREE.RedFormat;
      tex.flipY = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = maxAniso;
      const mesh = new THREE.Mesh(
        buildPageGeometry(manifest.rivers.filter((r) => r.page === page)),
        riverMaterial(tex, manifest.pageSize),
      );
      mesh.renderOrder = 1;
      scene.add(mesh);
    }),
  );

  // Start looking at the length-weighted center of the mapped rivers.
  const sum = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (const r of manifest.rivers) {
    const [west, south, east, north] = r.bbox;
    sum.addScaledVector(toSphere((west + east) / 2, (south + north) / 2, p), r.length_km);
  }
  if (sum.lengthSq() > 0) camera.position.copy(sum.normalize().multiplyScalar(camera.position.length()));
  controls.update();

  let dirty = true;
  let flight: Flight | null = null;
  const moveListeners: Array<() => void> = [];

  controls.addEventListener('change', () => (dirty = true));
  // Any drag, wheel or touch hands control back to the user.
  controls.addEventListener('start', () => endFlight(false));

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    dirty = true;
  });

  function endFlight(arrived: boolean): void {
    const f = flight;
    flight = null;
    f?.done(arrived);
  }

  const tmpQ = new THREE.Quaternion();
  const identity = new THREE.Quaternion();
  const dir = new THREE.Vector3();

  /** Advances the flight; true when it moved the camera this frame. */
  function stepFlight(now: number): boolean {
    if (!flight) return false;
    const t = Math.min(1, (now - flight.start) / flight.duration);
    const e = easeInOut(t);
    tmpQ.copy(identity).slerp(flight.turn, e);
    dir.copy(flight.from).applyQuaternion(tmpQ);
    const distance =
      flight.startDistance + (flight.endDistance - flight.startDistance) * e + flight.arc * Math.sin(Math.PI * e);
    camera.position.copy(dir).multiplyScalar(distance);
    if (t >= 1) endFlight(true);
    return true;
  }

  function frame(now: number): void {
    // Slow the drag as the camera nears the surface so zoomed-in views stay controllable.
    controls.rotateSpeed = Math.min(1, (camera.position.length() - 1) * 0.6);
    const flying = stepFlight(now);
    const moved = controls.update() || flying;
    if (moved) dirty = true;
    if (!dirty) return;
    dirty = false;
    renderer.render(scene, camera);
    // Wheel zoom applies inside OrbitControls' own handler (update() then reports no change here),
    // and resizes move projections too, so listeners run for every rendered frame.
    for (const cb of moveListeners) cb();
  }
  renderer.setAnimationLoop(frame);

  const target = new THREE.Vector3();
  const ndc = new THREE.Vector3();

  return {
    flyTo(lon, lat, { instant }) {
      endFlight(false);
      const from = camera.position.clone();
      const startDistance = from.length();
      from.divideScalar(startDistance);
      toSphere(lon, lat, target);
      const turn = new THREE.Quaternion().setFromUnitVectors(from, target);
      const angle = 2 * Math.acos(Math.min(1, Math.abs(turn.w)));
      const endDistance = Math.min(startDistance, FLIGHT_DISTANCE);
      if (instant) {
        camera.position.copy(target).multiplyScalar(endDistance);
        controls.update();
        dirty = true;
        return Promise.resolve(true);
      }
      const { promise, resolve } = Promise.withResolvers<boolean>();
      flight = {
        from,
        turn,
        startDistance,
        endDistance,
        arc: angle * FLIGHT_ARC_PER_RAD,
        duration: FLIGHT_BASE_MS + angle * FLIGHT_PER_RAD_MS,
        start: performance.now(),
        done: resolve,
      };
      return promise;
    },
    project(lon, lat, out) {
      // The camera may have moved since the last render (instant jumps), so refresh its matrices.
      camera.updateMatrixWorld();
      toSphere(lon, lat, ndc);
      // On the near side of the horizon when the camera sits farther out than the tangent plane.
      out.facing = ndc.dot(camera.position) > 1.002;
      ndc.project(camera);
      out.x = (ndc.x * 0.5 + 0.5) * window.innerWidth;
      out.y = (-ndc.y * 0.5 + 0.5) * window.innerHeight;
    },
    setActive(on) {
      renderer.setAnimationLoop(on ? frame : null);
      controls.enabled = on;
      dirty = true;
    },
    setInteractive(on) {
      controls.enabled = on;
    },
    onCameraMove(cb) {
      moveListeners.push(cb);
    },
  };
}
