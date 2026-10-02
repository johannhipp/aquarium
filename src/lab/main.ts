import { createVoxelScene, type VoxelScene } from '../cubeworld/scene';
import { DEFAULT_PALETTE, PALETTES, classLook, type OutlineMode, type Palette } from '../cubeworld/palettes';
import { CLASS_NAMES, type VoxelGrid } from '../cubeworld/voxels';
import { loadVoxels, type LoadedVoxels } from './load';
import { poolGrid } from './pool';

/**
 * Dev-only lab viewer. Open /lab.html?v=<id>[,<id>...] (ids are files in public/lab/voxels/).
 *   ?v=a,b        side by side, camera synced (arrow keys move all)
 *   ?style=1..5   visual style (or its id: mono, gameboy, washi, night, foam); keys 1-5 switch it live
 *   ?style=1,2    the same scene in several styles side by side
 *   ?grid=1       the scene in all 5 styles in a 3+2 grid, camera synced; keys 1-5 solo one, 0 back to the grid
 *   ?scale=k      downsample k-fold with priority pooling, to preview the real 50 x 50 budget
 *   ?zoom=z       start zoom (1 fits the whole area)
 *   ?edges=cube   override the palette's outline mode (cube | outline | none)
 *   ?ui=0         hide labels and legend (clean screenshots)
 */

interface PanelSpec {
  id: string;
  style: number;
}

interface Panel {
  spec: PanelSpec;
  scene: VoxelScene;
  label: HTMLElement;
  host: HTMLElement;
}

const params = new URLSearchParams(location.search);
const ids = (params.get('v') ?? 'osm-yakkozaka').split(',').filter((s) => s.length > 0);
const scale = Math.max(1, Math.floor(Number(params.get('scale') ?? '1')) || 1);
const startZoom = Number(params.get('zoom') ?? '1.6') || 1.6;
const showUi = params.get('ui') !== '0';
const edgeOverride = ((): OutlineMode | null => {
  const e = params.get('edges');
  return e === 'cube' || e === 'outline' || e === 'none' ? e : null;
})();

/** `1`..`5` or a palette id, to an index into PALETTES. */
function parseStyle(token: string): number {
  const n = Number(token);
  if (Number.isInteger(n) && n >= 1 && n <= PALETTES.length) return n - 1;
  const byId = PALETTES.findIndex((p) => p.id === token);
  return byId >= 0 ? byId : PALETTES.indexOf(DEFAULT_PALETTE);
}

const styleTokens = (params.get('style') ?? '').split(',').filter((s) => s.length > 0);
let styles: number[] = styleTokens.length > 0 ? styleTokens.map(parseStyle) : [PALETTES.indexOf(DEFAULT_PALETTE)];
/** 'grid': all palettes in a 3+2 grid; otherwise the panels in `specs` side by side. */
let layout: 'grid' | 'panels' = params.get('grid') === '1' ? 'grid' : 'panels';

function paletteFor(style: number): Palette {
  const p = PALETTES[style];
  return edgeOverride ? { ...p, outline: { ...p.outline, mode: edgeOverride } } : p;
}

function specsNow(): PanelSpec[] {
  if (layout === 'grid') return PALETTES.map((_, i) => ({ id: ids[0], style: i }));
  const count = Math.max(ids.length, styles.length);
  return Array.from({ length: count }, (_, i) => ({ id: ids[i % ids.length], style: styles[i % styles.length] }));
}

const root = document.createElement('div');
root.style.cssText =
  'position:fixed;inset:0;display:grid;gap:2px;background:#0b0b0b;font:11px/1.35 ui-monospace,Menlo,monospace;color:#0b0b0b';
document.body.appendChild(root);

const loadedById = new Map<string, { loaded: LoadedVoxels; grid: VoxelGrid }>();
async function gridFor(id: string): Promise<{ loaded: LoadedVoxels; grid: VoxelGrid }> {
  const hit = loadedById.get(id);
  if (hit) return hit;
  const loaded = await loadVoxels(id);
  const entry = { loaded, grid: poolGrid(loaded.grid, scale) };
  loadedById.set(id, entry);
  return entry;
}

const fmt = (n: number): string => n.toLocaleString('en');

function labelText(spec: PanelSpec, loaded: LoadedVoxels, grid: VoxelGrid, scene: VoxelScene): string {
  const s = scene.stats();
  const pooled = scale > 1 ? ` (pooled /${scale})` : '';
  return `${spec.style + 1} ${scene.palette.name}\n${loaded.meta.id} ${grid.nx}x${grid.ny}x${grid.nz}${pooled}\ncubes ${fmt(s.cubes)}  quads ${fmt(s.faces)}  build ${s.buildMs.toFixed(0)} ms`;
}

function makeLabel(text: string): HTMLElement {
  const label = document.createElement('pre');
  label.style.cssText =
    'position:absolute;left:8px;top:8px;z-index:2;margin:0;padding:4px 6px;background:#fff;border:2px solid #0b0b0b;box-shadow:2px 2px 0 #0b0b0b;white-space:pre-wrap;max-width:80%;font:inherit;pointer-events:none';
  label.textContent = text;
  label.hidden = !showUi;
  return label;
}

function legend(palette: Palette): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText =
    `display:${showUi ? 'flex' : 'none'};position:fixed;left:8px;bottom:8px;z-index:3;flex-wrap:wrap;gap:4px 10px;max-width:60vw;padding:5px 7px;background:#fff;border:2px solid #0b0b0b;box-shadow:2px 2px 0 #0b0b0b`;
  CLASS_NAMES.forEach((name, i) => {
    if (i === 0) return;
    const item = document.createElement('span');
    item.style.cssText = 'display:inline-flex;align-items:center;gap:4px';
    const swatch = document.createElement('i');
    swatch.style.cssText = `display:inline-block;width:10px;height:10px;border:1px solid #0b0b0b;background:${classLook(palette, i).top}`;
    item.append(swatch, `${i} ${name}`);
    el.appendChild(item);
  });
  return el;
}

let panels: Panel[] = [];
let legendEl: HTMLElement | null = null;
const failures: string[] = [];
let generation = 0;

function applyGridTemplate(count: number): void {
  if (layout === 'grid') {
    root.style.gridTemplateColumns = 'repeat(6, 1fr)';
    root.style.gridTemplateRows = '1fr 1fr';
    return;
  }
  root.style.gridTemplateColumns = `repeat(${count}, 1fr)`;
  root.style.gridTemplateRows = '1fr';
}

/** The sixth cell of the grid: what each style spent, side by side. */
function summaryCell(items: Panel[]): HTMLElement {
  const cell = document.createElement('pre');
  cell.style.cssText = 'grid-column:span 2;margin:0;padding:10px;background:#fff;font:inherit;white-space:pre-wrap;overflow:hidden';
  cell.hidden = !showUi;
  const rows = items.map((p) => {
    const s = p.scene.stats();
    return `${p.spec.style + 1} ${p.scene.palette.name.padEnd(16)} cubes ${fmt(s.cubes)}  quads ${fmt(s.faces)}  build ${s.buildMs.toFixed(0)} ms  draws ${s.drawCalls}`;
  });
  const same = items.every((p) => p.scene.stats().faces === items[0].scene.stats().faces && p.scene.stats().cubes === items[0].scene.stats().cubes);
  cell.textContent = `${items[0]?.spec.id ?? ''}\nsame allocation in every style: ${same ? 'yes' : 'NO'}\n\n${rows.join('\n')}\n\nkeys 1-5 solo a style, 0 grid`;
  return cell;
}

/** (Re)builds every panel for the current layout, keeping the camera where it was. */
async function mount(): Promise<void> {
  const mine = ++generation;
  const view = panels[0]?.scene.getView();
  for (const p of panels) p.scene.dispose();
  panels = [];
  root.replaceChildren();
  legendEl?.remove();
  legendEl = null;
  const specs = specsNow();
  applyGridTemplate(specs.length);

  const next: Panel[] = [];
  for (const [i, spec] of specs.entries()) {
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;min-width:0;min-height:0;overflow:hidden;background:#fff';
    if (layout === 'grid') host.style.gridColumn = 'span 2';
    root.appendChild(host);
    try {
      const { loaded, grid } = await gridFor(spec.id);
      if (mine !== generation) return;
      const stage = document.createElement('div');
      stage.style.cssText = 'position:absolute;inset:0';
      host.appendChild(stage);
      const scene = createVoxelScene(stage, grid, {
        palette: paletteFor(spec.style),
        metersPerCube: loaded.meta.metersPerCube * scale,
        eyeBase: 4 / Math.max(1, scale),
        eyeFollow: 1,
        startZoom,
        keys: i === 0,
      });
      const label = makeLabel(labelText(spec, loaded, grid, scene));
      host.appendChild(label);
      scene.start();
      next.push({ spec, scene, label, host });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push(`${spec.id}: ${message}`);
      host.appendChild(makeLabel(`${spec.id}\n${message}`));
    }
  }
  if (mine !== generation) return;
  panels = next;
  if (layout === 'grid') {
    // 3 + 2: a row of three styles, then two styles and the summary cell
    const summary = summaryCell(panels);
    root.appendChild(summary);
    // draw calls are only known once each panel has drawn a frame
    setTimeout(() => {
      if (mine === generation) summary.replaceWith(summaryCell(panels));
    }, 600);
  }
  if (view) for (const p of panels) p.scene.setView(view);

  // Dragging, wheeling or keys in any panel moves every panel.
  let applying = false;
  for (const p of panels) {
    p.scene.onViewChange(() => {
      if (applying) return;
      applying = true;
      const v = p.scene.getView();
      for (const q of panels) if (q !== p) q.scene.setView(v);
      applying = false;
    });
  }
  if (panels[0]) {
    legendEl = legend(panels[0].scene.palette);
    document.body.appendChild(legendEl);
  }
  const url = new URL(location.href);
  if (layout === 'panels') url.searchParams.set('style', specs.map((s) => s.style + 1).join(','));
  history.replaceState(null, '', url);
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Digit0' || e.code === 'KeyG') {
    if (layout !== 'grid') {
      layout = 'grid';
      void mount();
    }
    return;
  }
  const m = /^Digit([1-9])$/.exec(e.code);
  if (!m) return;
  const n = Number(m[1]) - 1;
  if (n >= PALETTES.length) return;
  styles = [n];
  layout = 'panels';
  void mount();
});

void mount();

declare global {
  interface Window {
    __lab?: {
      panels: () => Panel[];
      failures: () => string[];
      scale: number;
      /** Switches every panel to style 1..5 (same as the number keys). */
      setStyle: (n: number) => Promise<void>;
      showGrid: () => Promise<void>;
    };
  }
}
window.__lab = {
  panels: () => panels,
  failures: () => failures,
  scale,
  setStyle: (n) => {
    styles = [Math.max(0, Math.min(PALETTES.length - 1, n - 1))];
    layout = 'panels';
    return mount();
  },
  showGrid: () => {
    layout = 'grid';
    return mount();
  },
};
