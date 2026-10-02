import { createVoxelScene, type VoxelScene } from '../cubeworld/scene';
import { STYLES } from '../cubeworld/mesh';
import { CLASS_NAMES, type VoxelGrid } from '../cubeworld/voxels';
import { loadVoxels, type LoadedVoxels } from './load';
import { poolGrid } from './pool';

/**
 * Dev-only lab viewer. Open /lab.html?v=<id>[,<id>...] (ids are files in public/lab/voxels/).
 *   ?v=a,b      side by side, camera synced (arrow keys move both)
 *   ?scale=k    downsample k-fold with priority pooling, to preview the real 50 x 50 budget
 *   ?zoom=z     start zoom (1 fits the whole area)
 *   ?edges=cube outline every cube (default: only creases, steps and class borders)
 */

interface Panel {
  id: string;
  scene: VoxelScene;
  label: HTMLElement;
}

const params = new URLSearchParams(location.search);
const ids = (params.get('v') ?? 'osm-yakkozaka').split(',').filter((s) => s.length > 0);
const scale = Math.max(1, Math.floor(Number(params.get('scale') ?? '1')) || 1);
const edges = params.get('edges') === 'cube' ? 'cube' : 'outline';
const startZoom = Number(params.get('zoom') ?? '1.6') || 1.6;

const root = document.createElement('div');
root.style.cssText = 'position:fixed;inset:0;display:flex;gap:2px;background:#0b0b0b;font:11px/1.35 ui-monospace,Menlo,monospace;color:#0b0b0b';
document.body.appendChild(root);

function swatchColor(tone: number): string {
  const g = Math.round(255 * (1 - tone));
  return `rgb(${g},${g},${g})`;
}

function legend(): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:2;display:flex;flex-wrap:wrap;gap:4px 10px;max-width:60vw;padding:5px 7px;background:#fff;border:2px solid #0b0b0b;box-shadow:2px 2px 0 #0b0b0b';
  CLASS_NAMES.forEach((name, i) => {
    if (i === 0) return;
    const item = document.createElement('span');
    item.style.cssText = 'display:inline-flex;align-items:center;gap:4px';
    const swatch = document.createElement('i');
    const style = STYLES[i];
    swatch.style.cssText = `display:inline-block;width:10px;height:10px;border:1px solid #0b0b0b;background:${swatchColor(style.top)}`;
    item.append(swatch, `${i} ${name}`);
    el.appendChild(item);
  });
  return el;
}

function describe(loaded: LoadedVoxels, grid: VoxelGrid, scene: VoxelScene): string {
  const s = scene.stats();
  const dims = `${grid.nx}x${grid.ny}x${grid.nz}`;
  const pooled = scale > 1 ? ` (pooled /${scale} from ${loaded.meta.dims.join('x')})` : '';
  return `${loaded.meta.id}  ${dims}${pooled}\n${loaded.meta.source}\ncubes ${s.cubes.toLocaleString('en')}  quads ${s.faces.toLocaleString('en')}`;
}

function makeLabel(text: string): HTMLElement {
  const label = document.createElement('pre');
  label.style.cssText =
    'position:absolute;left:8px;top:8px;z-index:2;margin:0;padding:4px 6px;background:#fff;border:2px solid #0b0b0b;box-shadow:2px 2px 0 #0b0b0b;white-space:pre-wrap;max-width:70%;font:inherit';
  label.textContent = text;
  return label;
}

const panels: Panel[] = [];
const failures: string[] = [];

async function boot(): Promise<void> {
  for (const [i, id] of ids.entries()) {
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;flex:1;min-width:0;background:#fff';
    root.appendChild(host);
    try {
      const loaded = await loadVoxels(id);
      const grid = poolGrid(loaded.grid, scale);
      const stage = document.createElement('div');
      stage.style.cssText = 'position:absolute;inset:0';
      host.appendChild(stage);
      const scene = createVoxelScene(stage, grid, { eyeBase: 4 / Math.max(1, scale), eyeFollow: 1, startZoom, keys: i === 0, edges });
      const label = makeLabel(describe(loaded, grid, scene));
      host.appendChild(label);
      scene.start();
      panels.push({ id, scene, label });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push(`${id}: ${message}`);
      host.appendChild(makeLabel(`${id}\n${message}`));
    }
  }

  // Dragging, wheeling or keys in any panel moves every panel.
  let applying = false;
  for (const p of panels) {
    p.scene.onViewChange(() => {
      if (applying) return;
      applying = true;
      const view = p.scene.getView();
      for (const q of panels) if (q !== p) q.scene.setView(view);
      applying = false;
    });
  }
  document.body.appendChild(legend());
}

void boot();

declare global {
  interface Window {
    __lab?: { panels: () => Panel[]; failures: () => string[]; scale: number };
  }
}
window.__lab = { panels: () => panels, failures: () => failures, scale };
