/**
 * Offline support (public/sw.js). Production builds only: the dev server serves modules from source and a worker
 * would cache them. After the page has settled the worker is told which same-origin files it loaded, so the shell
 * works offline after the first visit without a build-time precache list. The map itself is cached in two ways:
 * the chunk worker stores every chunk it has fetched (Cache Storage, 'stream-<hash>'), and `downloadWorld` stores
 * the whole archive so the worker can answer range requests offline.
 */

interface WorkerMessage {
  type: 'precache' | 'world';
  urls: string[];
}

const sent = new Set<string>();

function post(message: WorkerMessage): void {
  navigator.serviceWorker.controller?.postMessage(message);
}

function reportLoaded(): void {
  const urls = performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .filter((u) => u.startsWith(location.origin) && !sent.has(u));
  const doc = location.origin + location.pathname;
  if (!sent.has(doc)) urls.push(doc);
  if (urls.length === 0) return;
  for (const u of urls) sent.add(u);
  post({ type: 'precache', urls });
}

export function registerOffline(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then(() => {
        // the first visit has no controller until the worker claims the page; wait for it
        const start = (): void => {
          reportLoaded();
          setInterval(reportLoaded, 15000);
        };
        if (navigator.serviceWorker.controller) setTimeout(start, 3000);
        else navigator.serviceWorker.addEventListener('controllerchange', () => setTimeout(start, 3000), { once: true });
      })
      .catch((err: unknown) => console.warn('service worker unavailable', err));
  });
}

/** Stores every shard file of the map (about 50 MB), so it works offline. Resolves when all are stored. */
export async function downloadWorld(onProgress?: (done: number, total: number) => void): Promise<void> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) throw new Error('the service worker is not active (production builds only)');
  const manifest = (await (await fetch('/stream/manifest.json')).json()) as { files: { chunks: string[] } };
  const urls = manifest.files.chunks.map((f) => `/stream/${f}`);
  const channel = new MessageChannel();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  channel.port1.onmessage = (e: MessageEvent<{ done?: number; total?: number; error?: string }>) => {
    if (e.data.error) reject(new Error(e.data.error));
    else {
      onProgress?.(e.data.done ?? 0, e.data.total ?? urls.length);
      if (e.data.done === urls.length) resolve();
    }
  };
  controller.postMessage({ type: 'world', urls } satisfies WorkerMessage, [channel.port2]);
  await promise;
}

declare global {
  interface Window {
    /** Console hook until the app has a place for an "offline map" control. */
    __downloadWorld?: typeof downloadWorld;
  }
}
window.__downloadWorld = downloadWorld;
