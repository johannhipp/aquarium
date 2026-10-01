import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildWorldMesh, createWorldMaterial } from './mesh';
import { WORLD_D, WORLD_W, generateTerrain, type Voxels } from './terrain';

const SEED = 64;
/** Half the visible height at zoom 1, in cubes: the whole 50 x 50 footprint plus a good slice of the height fits. */
const VIEW_HALF_HEIGHT = 48;
/** Isometric start: a quarter turn from an axis, a little steeper than 45 degrees from vertical. */
const START_AZIMUTH = Math.PI / 4;
const START_POLAR = 0.95;
/** Zoom at the start: the whole landscape fits the frame. */
const START_ZOOM = 1;
/** The view's centre rides half the height of the ground under it, above a fixed base: hills pan the view without swinging it wildly. */
const EYE_BASE = 14;
const EYE_FOLLOW = 0.5;
const CAMERA_DISTANCE = 400;
/** Arrow-key speed in cubes per second at zoom 1; zoomed in, the screen speed stays the same. */
const MOVE_SPEED = 22;
const MOVE_EASE = 10;
const FOLLOW_EASE = 5;
/** How close to the edge of the world the view's centre may go. */
const EDGE_MARGIN = 0.5;

export interface CubeworldStats {
  /** cubes that exist (ground and water) out of 250,000 cells */
  cubes: number;
  /** quads actually in the geometry after hidden faces are culled */
  faces: number;
  drawCalls: number;
  triangles: number;
}

export interface Cubeworld {
  /** Show the scene and run the render loop (it only draws when something changed). */
  start(): void;
  /** Stop the loop and the key listeners; the camera stays where it was. */
  stop(): void;
  /** Free the GPU resources and remove the canvas. */
  dispose(): void;
  stats(): CubeworldStats;
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
function groundAt(voxels: Voxels, x: number, z: number): number {
  const gx = Math.min(WORLD_W - 1, Math.max(0, x - 0.5));
  const gz = Math.min(WORLD_D - 1, Math.max(0, z - 0.5));
  const x0 = Math.min(WORLD_W - 2, Math.floor(gx));
  const z0 = Math.min(WORLD_D - 2, Math.floor(gz));
  const fx = gx - x0;
  const fz = gz - z0;
  const s = voxels.surface;
  const a = s[x0 + WORLD_W * z0];
  const b = s[x0 + 1 + WORLD_W * z0];
  const c = s[x0 + WORLD_W * (z0 + 1)];
  const d = s[x0 + 1 + WORLD_W * (z0 + 1)];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/**
 * A 50 x 50 voxel landscape up to 100 cubes high, drawn as black-and-white dithered cubes with
 * outlined edges. One draw call: only the faces you can see are in the geometry and the edge
 * lines and shading come from a shader, not from line meshes.
 */
export function createCubeworld(container: HTMLElement): Cubeworld {
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0xffffff, 1);
  container.appendChild(renderer.domElement);

  const voxels = generateTerrain(SEED);
  const world = buildWorldMesh(voxels);
  const material = createWorldMaterial(pixelRatio);
  const mesh = new THREE.Mesh(world.geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, CAMERA_DISTANCE * 3);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minZoom = 0.5;
  controls.maxZoom = 10;
  controls.zoomSpeed = 1.2;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = Math.PI / 2 - 0.08;

  const target = controls.target;
  target.set(WORLD_W / 2, EYE_BASE + EYE_FOLLOW * groundAt(voxels, WORLD_W / 2, WORLD_D / 2), WORLD_D / 2);
  camera.position.set(
    target.x + CAMERA_DISTANCE * Math.sin(START_POLAR) * Math.sin(START_AZIMUTH),
    target.y + CAMERA_DISTANCE * Math.cos(START_POLAR),
    target.z + CAMERA_DISTANCE * Math.sin(START_POLAR) * Math.cos(START_AZIMUTH),
  );
  camera.zoom = START_ZOOM;
  camera.updateProjectionMatrix();
  controls.update();

  let dirty = true;
  let running = false;
  let drawCalls = 0;
  let triangles = 0;

  function resize(): void {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    const aspect = w / h;
    camera.left = -VIEW_HALF_HEIGHT * aspect;
    camera.right = VIEW_HALF_HEIGHT * aspect;
    camera.top = VIEW_HALF_HEIGHT;
    camera.bottom = -VIEW_HALF_HEIGHT;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    dirty = true;
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  controls.addEventListener('change', () => (dirty = true));

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
    const speed = MOVE_SPEED / camera.zoom;
    const k = 1 - Math.exp(-dt * MOVE_EASE);
    velocity.x += (wantX * speed - velocity.x) * k;
    velocity.y += (wantY * speed - velocity.y) * k;
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
    const nx = Math.min(WORLD_W - EDGE_MARGIN, Math.max(EDGE_MARGIN, target.x + dx));
    const nz = Math.min(WORLD_D - EDGE_MARGIN, Math.max(EDGE_MARGIN, target.z + dz));
    // the view rides the ground: ease its height toward the surface under it
    const gap = EYE_BASE + EYE_FOLLOW * groundAt(voxels, nx, nz) - target.y;
    const my = Math.abs(gap) < 0.005 ? gap : gap * (1 - Math.exp(-dt * FOLLOW_EASE));
    const mx = nx - target.x;
    const mz = nz - target.z;
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

  function frame(now: number): void {
    const dt = lastFrame === 0 ? 0 : Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    const moved = glide(dt);
    const orbited = controls.update();
    if (moved || orbited) dirty = true;
    if (!dirty) return;
    dirty = false;
    renderer.render(scene, camera);
    drawCalls = renderer.info.render.calls;
    triangles = renderer.info.render.triangles;
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastFrame = 0;
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', releaseKeys);
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
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
    stats() {
      return { cubes: world.cubes, faces: world.faces, drawCalls, triangles };
    },
  };
}
