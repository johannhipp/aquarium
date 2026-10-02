/*
 * Service worker: the app shell works offline after the first visit, and the map's shard files can be stored whole.
 * No build step, no precache list: the page posts the URLs it loaded (src/pwa.ts) and they are cached from there.
 *
 *  - hashed build output (/assets/...): cache first, it never changes under its name
 *  - pages, json, audio, sprites: network first, the cached copy when offline
 *  - /stream/manifest.json: network first; /stream/dir.<hash>.bin: cache first (the hash is the content)
 *  - /stream/chunks.<hash>-<n>.bin (range requests from the chunk worker): passed through to the network, unless
 *    the whole shard was stored with {type:'world'}; then the range is cut out of the stored file. A 206 is never cached.
 * The chunk worker's own per-chunk cache ('stream-<hash>') is not touched. Cache names here never start with 'stream-'.
 */
const SHELL = 'shell-v1';
const WORLD = 'world-v1';
const SHARD = /^\/stream\/chunks\.[0-9a-f]+-\d+\.bin$/;
const HASHED = /^\/assets\//;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if ((name.startsWith('shell-') && name !== SHELL) || (name.startsWith('world-') && name !== WORLD)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

/** Shard blobs cut ranges without copying the file; kept for as long as this worker instance lives. */
const blobs = new Map();

async function storedShard(url) {
  let blob = blobs.get(url);
  if (!blob) {
    const hit = await (await caches.open(WORLD)).match(url);
    if (!hit) return null;
    blob = await hit.blob();
    blobs.set(url, blob);
  }
  return blob;
}

async function shard(request) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') ?? '');
  const blob = range ? await storedShard(request.url) : null;
  if (!range || !blob) return fetch(request);
  const start = Number(range[1]);
  const end = Math.min(range[2] === '' ? blob.size - 1 : Number(range[2]), blob.size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${blob.size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (SHARD.test(url.pathname)) {
    event.respondWith(shard(request));
  } else if (request.headers.has('range')) {
    // media elements stream audio with ranges; a partial response is neither cacheable nor ours to synthesise
    return;
  } else if (HASHED.test(url.pathname) || /^\/stream\/dir\.[0-9a-f]+\.bin$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});

async function precache(urls) {
  const cache = await caches.open(SHELL);
  await Promise.all(urls.map(async (u) => {
    const url = new URL(u, self.location.origin);
    if (url.origin !== self.location.origin || SHARD.test(url.pathname) || (await cache.match(url.href))) return;
    try {
      const res = await fetch(url.href);
      if (res.ok) await cache.put(url.href, res);
    } catch {
      // offline or gone: it is only a cache
    }
  }));
}

async function storeWorld(urls, port) {
  const cache = await caches.open(WORLD);
  let done = 0;
  for (const u of urls) {
    if (!(await cache.match(u))) {
      const res = await fetch(u);
      if (!res.ok || res.status === 206) throw new Error(`${u}: HTTP ${res.status}`);
      await cache.put(u, res);
    }
    blobs.delete(new URL(u, self.location.origin).href);
    port.postMessage({ done: ++done, total: urls.length });
  }
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg?.type === 'precache') event.waitUntil(precache(msg.urls));
  else if (msg?.type === 'world') {
    const port = event.ports[0];
    event.waitUntil(storeWorld(msg.urls, port).catch((err) => port.postMessage({ error: String(err) })));
  }
});
