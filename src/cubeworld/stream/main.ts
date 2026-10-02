import { iconCanvas } from './icons';
import type { Throttle } from './protocol';
import { createStreamViewer, type FlightReport, type StreamViewer } from './viewer';

/**
 * Dev-only streaming page (stream.html): Minato-ku as a chunked LOD pyramid, streamed on demand.
 *   ?throttle=slow3g|fast3g|4g|<kbps>   simulate a slow link (latency + shared bandwidth) inside the chunk workers
 *   ?cache=0                             do not use Cache Storage (cold-network measurements)
 *   ?palette=<id>                        look; P cycles
 *   ?detail=<px>                         cubes wider than this many CSS px are refined (default 7)
 *   ?workers=<n>  ?gpuMB=<n>  ?hud=1     worker count, GPU memory budget, numbers overlay
 *   ?fly=<themeId>                       fly to a theme as soon as the first frame is drawn
 * Everything is reachable from `window.__stream` for the measurement scripts.
 */

const PRESETS: Readonly<Record<string, Throttle>> = {
  slow3g: { latencyMs: 400, kbps: 400 },
  fast3g: { latencyMs: 150, kbps: 1600 },
  '4g': { latencyMs: 60, kbps: 9000 },
};

function parseThrottle(value: string | null): Throttle | null {
  if (!value) return null;
  const preset = PRESETS[value];
  if (preset) return preset;
  const kbps = Number(value);
  return Number.isFinite(kbps) && kbps > 0 ? { latencyMs: 100, kbps } : null;
}

const INK = '#0b0b0b';

function buildToolbar(viewer: StreamViewer): void {
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2;display:flex;gap:8px';
  const buttons = new Map<string, HTMLButtonElement>();
  for (const theme of viewer.themes) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.theme = theme.id;
    b.setAttribute('aria-label', theme.name);
    b.title = theme.name;
    b.style.cssText = `padding:4px;margin:0;cursor:pointer;background:#fff;border:2px solid ${INK};box-shadow:2px 2px 0 ${INK};line-height:0`;
    b.appendChild(iconCanvas(theme.icon));
    b.addEventListener('click', () => void viewer.flyTo(theme.id));
    bar.appendChild(b);
    buttons.set(theme.id, b);
  }
  viewer.onFlight((id) => {
    for (const [tid, b] of buttons) {
      b.style.transform = tid === id ? 'translate(2px,2px)' : '';
      b.style.boxShadow = tid === id ? 'none' : `2px 2px 0 ${INK}`;
    }
  });
  document.body.appendChild(bar);

  const credit = document.createElement('div');
  credit.textContent = '出典：国土交通省 3D都市モデル（Project PLATEAU）東京都港区を加工して作成';
  credit.style.cssText = `position:fixed;right:8px;bottom:6px;z-index:2;font:10px/1.3 ui-monospace,Menlo,monospace;color:${INK};opacity:.55;pointer-events:none`;
  document.body.appendChild(credit);
}

function buildHud(viewer: StreamViewer): void {
  const hud = document.createElement('pre');
  hud.style.cssText = `position:fixed;left:8px;top:8px;z-index:3;margin:0;padding:4px 6px;font:11px/1.35 ui-monospace,Menlo,monospace;background:#fff;color:${INK};border:2px solid ${INK};pointer-events:none`;
  document.body.appendChild(hud);
  setInterval(() => {
    const s = viewer.stats();
    const p = viewer.pose();
    hud.textContent =
      `resident ${s.resident}  queued ${s.queued}  inflight ${s.inflight}\n` +
      `quads ${(s.quads / 1000).toFixed(0)}k  gpu ${(s.gpuBytes / 1048576).toFixed(0)} MB\n` +
      `net ${(s.netBytes / 1024).toFixed(0)} KB in ${s.requests} req  cache hits ${s.cacheHits}\n` +
      `zoom ${p.zoom.toFixed(3)}  x ${p.x.toFixed(0)} z ${p.z.toFixed(0)}`;
  }, 250);
}

interface StreamDebug {
  viewer: StreamViewer;
  /** Flies to each theme in turn and returns their reports. */
  runFlights(ids: readonly string[]): Promise<FlightReport[]>;
}

declare global {
  interface Window {
    __stream?: StreamDebug;
  }
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const stage = document.getElementById('stage');
  if (!stage) throw new Error('no #stage');
  const viewer = await createStreamViewer(stage, {
    base: '/stream/',
    paletteId: params.get('palette') ?? undefined,
    throttle: parseThrottle(params.get('throttle')),
    useCache: params.get('cache') !== '0',
    detailPx: Number(params.get('detail')) || undefined,
    gpuBudgetMB: Number(params.get('gpuMB')) || undefined,
    workers: Number(params.get('workers')) || undefined,
  });
  buildToolbar(viewer);
  if (params.get('hud') === '1') buildHud(viewer);
  window.__stream = {
    viewer,
    async runFlights(ids) {
      const reports: FlightReport[] = [];
      for (const id of ids) reports.push(await viewer.flyTo(id));
      return reports;
    },
  };
  const fly = params.get('fly');
  if (fly) {
    const first = setInterval(() => {
      if (viewer.firstRenderMs() > 0) {
        clearInterval(first);
        void viewer.flyTo(fly);
      }
    }, 50);
  }
}

void main();
