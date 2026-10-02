import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildWorldMesh } from './mesh';
import {
  createBackdrop,
  createGlowPoints,
  createWorldMaterial,
  setGlowScale,
  setWorldFocus,
  wantsAntialias,
} from './material';
import { DEFAULT_PALETTE, forCubeSize, rgb, type Palette } from './palettes';
import { terrainSurface, type VoxelGrid } from './voxels';

/** Cube counts the scene was tuned on: a 50-wide world. Everything below scales with the grid's width. */
const REFERENCE_SIZE = 50;
/** Half the visible height at zoom 1, in cubes, for the reference world: the whole footprint plus a slice of the height fits. */
const VIEW_HALF_HEIGHT = 48;
/** Isometric start: a quarter turn from an axis, a little steeper than 45 degrees from vertical. */
const START_AZIMUTH = Math.PI / 4;
const START_POLAR = 0.95;
const CAMERA_DISTANCE = 400;
/** Arrow-key speed in cubes per second at zoom 1 for the reference world; zoomed in, the screen speed stays the same. */
const MOVE_SPEED = 22;
const MOVE_EASE = 10;
const FOLLOW_EASE = 5;
/** How close to the edge of the world the view's centre may go. */
const EDGE_MARGIN = 0.5;

export interface SceneStats {
  /** cubes that exist (non-air cells) */
  cubes: number;
  /** quads actually in the geometry after hidden faces are culled */
  faces: number;
  facesByClass: number[];
  drawCalls: number;
  triangles: number;
  /** time spent building the merged geometry, in ms */
  buildMs: number;
}

/** A camera pose in units of the world's width, so differently sized grids can follow each other. */
export interface View {
  target: [number, number, number];
  offset: [number, number, number];
  zoom: number;
}

export interface SceneOptions {
  /** The look: colours, light, outlines, sky. Defaults to DEFAULT_PALETTE. */
  palette?: Palette;
  /** Size of a cube in metres (default 1); scales lamp halos and light pools. */
  metersPerCube?: number;
  /** Zoom at the start: 1 fits the whole landscape. */
  startZoom?: number;
  /** The view's centre rides `eyeBase + eyeFollow * ground height` (in cubes at the reference size). */
  eyeBase?: number;
  eyeFollow?: number;
  /** Arrow keys / WASD move the view (default true). Off for followers in a synced pair. */
  keys?: boolean;
}

export interface VoxelScene {
  /** The look this scene was built with. */
  readonly palette: Palette;
  /** Show the scene and run the render loop (it only draws when something changed). */
  start(): void;
  /** Stop the loop and the key listeners; the camera stays where it was. */
  stop(): void;
  /** Free the GPU resources and remove the canvas. */
  dispose(): void;
  stats(): SceneStats;
  getView(): View;
  /** Jumps to a pose without notifying `onViewChange` listeners. */
  setView(view: View): void;
  /** Called whenever the user (mouse, wheel, keys) moved the camera. */
  onViewChange(cb: () => void): void;
  /** Captures the current frame as a PNG data URL (renders first). */
  snapshot(): string;
}

type MoveKey = 'forward' | 'back' | 'left' | 'right';

const MOVE_KEYS: Readonly<Record<string, MoveKey>> = {
  ArrowUp: 'forward',
  ArrowDown: 'back',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
};

/** Surface level at a fractional position, bilinear between column tops so the view glides over steps. */
function groundAt(surface: Uint8Array, nx: number, nz: number, x: number, z: number): number {
  const gx = Math.min(nx - 1, Math.max(0, x - 0.5));
  const gz = Math.min(nz - 1, Math.max(0, z - 0.5));
  const x0 = Math.min(nx - 2, Math.floor(gx));
  const z0 = Math.min(nz - 2, Math.floor(gz));
  const fx = gx - x0;
  const fz = gz - z0;
  const a = surface[x0 + nx * z0];
  const b = surface[x0 + 1 + nx * z0];
  const c = surface[x0 + nx * (z0 + 1)];
  const d = surface[x0 + 1 + nx * (z0 + 1)];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/**
 * A voxel grid drawn as shaded cubes in the look of a palette (see palettes.ts). One draw call
 * for the world: only the faces you can see are in the geometry, and the shading, ambient
 * occlusion and outlines come from a shader and per-vertex attributes, not from line meshes. Drag
 * orbits, the wheel zooms, arrow keys glide the view across the ground.
 */
export function createVoxelScene(container: HTMLElement, grid: VoxelGrid, options: SceneOptions = {}): VoxelScene {
  const { nx, ny, nz } = grid;
  const size = Math.max(nx, nz);
  const k = size / REFERENCE_SIZE;
  const eyeBase = (options.eyeBase ?? 14) * k;
  const eyeFollow = options.eyeFollow ?? 0.5;
  const listenKeys = options.keys ?? true;

  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  const palette = forCubeSize(options.palette ?? DEFAULT_PALETTE, options.metersPerCube ?? 1);
  const renderer = new THREE.WebGLRenderer({ antialias: wantsAntialias(palette), preserveDrawingBuffer: false });
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(new THREE.Color(...rgb(palette.background.bottom)), 1);
  container.appendChild(renderer.domElement);

  const surface = terrainSurface(grid);
  const t0 = performance.now();
  const world = buildWorldMesh(grid, palette);
  const buildMs = performance.now() - t0;
  const material = createWorldMaterial(palette, pixelRatio, size);
  const mesh = new THREE.Mesh(world.geometry, material);
  mesh.frustumCulled = false;
  const backdrop = createBackdrop(palette);
  const glow = createGlowPoints(palette, world.glows);
  const scene = new THREE.Scene();
  scene.add(backdrop, mesh);
  if (glow) scene.add(glow);

  const distance = CAMERA_DISTANCE * k;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, distance * 3);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minZoom = 0.5;
  controls.maxZoom = 10;
  controls.zoomSpeed = 1.2;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = Math.PI / 2 - 0.08;

  const ground = (x: number, z: number): number => groundAt(surface, nx, nz, x, z);
  const target = controls.target;
  target.set(nx / 2, eyeBase + eyeFollow * ground(nx / 2, nz / 2), nz / 2);
  camera.position.set(
    target.x + distance * Math.sin(START_POLAR) * Math.sin(START_AZIMUTH),
    target.y + distance * Math.cos(START_POLAR),
    target.z + distance * Math.sin(START_POLAR) * Math.cos(START_AZIMUTH),
  );
  camera.zoom = options.startZoom ?? 1;
  camera.updateProjectionMatrix();
  controls.update();

  let dirty = true;
  let running = false;
  let drawCalls = 0;
  let triangles = 0;
  const viewListeners: Array<() => void> = [];
  const notify = (): void => {
    for (const cb of viewListeners) cb();
  };

  function resize(): void {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    const aspect = w / h;
    const half = VIEW_HALF_HEIGHT * k;
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.top = half;
    camera.bottom = -half;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    dirty = true;
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  controls.addEventListener('change', () => {
    dirty = true;
    notify();
  });

  // --- arrow keys / WASD: slide the view across the landscape, relative to the camera's heading ---
  const held = new Set<MoveKey>();
  const velocity = new THREE.Vector2(); // x: sideways, y: forward, cubes per second
  const forward = new THREE.Vector3();
  let lastFrame = 0;

  function onKeyDown(e: KeyboardEvent): void {
    const key = MOVE_KEYS[e.code];
    if (!key || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    held.add(key);
    dirty = true;
  }
  function onKeyUp(e: KeyboardEvent): void {
    const key = MOVE_KEYS[e.code];
    if (key) held.delete(key);
  }
  function releaseKeys(): void {
    held.clear();
  }

  function glide(dt: number): boolean {
    const wantX = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
    const wantY = (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0);
    const speed = (MOVE_SPEED * k) / camera.zoom;
    const ease = 1 - Math.exp(-dt * MOVE_EASE);
    velocity.x += (wantX * speed - velocity.x) * ease;
    velocity.y += (wantY * speed - velocity.y) * ease;
    if (Math.abs(velocity.x) < 0.01 && Math.abs(velocity.y) < 0.01 && wantX === 0 && wantY === 0) {
      velocity.set(0, 0);
    }
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    // right = forward x up
    const dx = (velocity.y * forward.x - velocity.x * forward.z) * dt;
    const dz = (velocity.y * forward.z + velocity.x * forward.x) * dt;
    const px = Math.min(nx - EDGE_MARGIN, Math.max(EDGE_MARGIN, target.x + dx));
    const pz = Math.min(nz - EDGE_MARGIN, Math.max(EDGE_MARGIN, target.z + dz));
    // the view rides the ground: ease its height toward the surface under it
    const gap = eyeBase + eyeFollow * ground(px, pz) - target.y;
    const my = Math.abs(gap) < 0.005 ? gap : gap * (1 - Math.exp(-dt * FOLLOW_EASE));
    const mx = px - target.x;
    const mz = pz - target.z;
    if (mx === 0 && my === 0 && mz === 0) return false;
    // translate target and camera together so the orbit offset (heading, tilt, zoom) is untouched
    target.x += mx;
    target.y += my;
    target.z += mz;
    camera.position.x += mx;
    camera.position.y += my;
    camera.position.z += mz;
    return true;
  }

  function draw(): void {
    setWorldFocus(material, camera.position.distanceTo(target));
    if (glow) setGlowScale(glow, renderer.domElement.height / ((camera.top - camera.bottom) / camera.zoom));
    renderer.render(scene, camera);
    drawCalls = renderer.info.render.calls;
    triangles = renderer.info.render.triangles;
  }

  function frame(now: number): void {
    const dt = lastFrame === 0 ? 0 : Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    const moved = listenKeys && glide(dt);
    const orbited = controls.update();
    if (moved) notify();
    if (moved || orbited) dirty = true;
    if (!dirty) return;
    dirty = false;
    draw();
  }

  return {
    palette,
    start() {
      if (running) return;
      running = true;
      lastFrame = 0;
      if (listenKeys) {
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', releaseKeys);
      }
      renderer.setAnimationLoop(frame);
      dirty = true;
    },
    stop() {
      running = false;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseKeys);
      renderer.setAnimationLoop(null);
      releaseKeys();
      velocity.set(0, 0);
    },
    dispose() {
      this.stop();
      observer.disconnect();
      controls.dispose();
      world.geometry.dispose();
      material.dispose();
      backdrop.geometry.dispose();
      (backdrop.material as THREE.Material).dispose();
      if (glow) {
        glow.geometry.dispose();
        (glow.material as THREE.Material).dispose();
      }
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
    stats() {
      return { cubes: world.cubes, faces: world.faces, facesByClass: world.facesByClass, drawCalls, triangles, buildMs };
    },
    getView() {
      return {
        target: [target.x / size, target.y / size, target.z / size],
        offset: [
          (camera.position.x - target.x) / size,
          (camera.position.y - target.y) / size,
          (camera.position.z - target.z) / size,
        ],
        zoom: camera.zoom,
      };
    },
    setView(view) {
      target.set(view.target[0] * size, view.target[1] * size, view.target[2] * size);
      camera.position.set(
        target.x + view.offset[0] * size,
        target.y + view.offset[1] * size,
        target.z + view.offset[2] * size,
      );
      camera.zoom = view.zoom;
      camera.updateProjectionMatrix();
      controls.update();
      dirty = true;
    },
    onViewChange(cb) {
      viewListeners.push(cb);
    },
    snapshot() {
      draw();
      return renderer.domElement.toDataURL('image/png');
    },
  };
}
