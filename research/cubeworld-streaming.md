# Cubeworld at Tokyo scale: streaming, LOD and optimistic loading

Status: 16 central Tokyo wards (185 km² frame, Shimokitazawa to Kinshicho / Morishita, section 10) are built and stream in `stream.html`; sections 1-9 below were measured on the earlier Minato-only build (about 41 km² of tiles, 20 km² of land) and are kept as measured. Everything marked **measured** was run in headless Chrome (Metal GPU, 1400x900) against the Vite dev server on this machine. Everything marked **[INFERENCE]** is arithmetic or judgement. Cited prior art is collected, with links, in [`cubeworld-streaming-sources.md`](cubeworld-streaming-sources.md); section letters below point into it.

## 0. Result in one screen

| | |
|---|---|
| Page | `http://localhost:5199/stream.html` (dev only; `?hud=1` numbers, `?throttle=slow3g\|fast3g\|4g\|<kbps>`, `?cache=0`, `?palette=`, `?detail=`, `?fly=<theme>`) |
| Data | 16 wards of PLATEAU FY2025 (section 10): bldg LOD1/2/3 (LOD1 outside the centre), tran LOD1/2/3, frn + veg + brid (LOD3 where present, so Shimbashi keeps poles and trees), wtr, DEM TIN. 7 LODs (1, 2, 4, 8, 16, 32, 64 m cubes), 16,384 x 11,264 m box (Minato-only build: 8192 x 7680 m) |
| Archive | `public/stream/`: `chunks.<hash>.bin` 103.7 MB (**gitignored**, rebuilt by `stream_build.py`), `dir.<hash>.bin` 1.3 MB, `manifest.json`; 239,073 chunks (218,844 unique). Minato-only build was 20.1 MB, 294 KB, 54,237 chunks |
| Build time | 16-ward build: fetch 2.04 GB (678 members) over HTTP range requests about 11 min, DEM + water prep 3.5 min, raster 207 tiles about 4 min on 10 cores, merge 17 s, pack 61 s (Minato-only: 380 MB, 50 s, 38 s, 15 s) |
| First frame | 3.5 KB of data (15 chunks of 64 m cubes), 137-450 ms locally, 0.9 s on slow 3G; the 32 m overview of the whole ward is 33 KB |
| Theme flights | 5 theme buttons, pixel icons. Local network, cold cache: 6 of 6 flights landed with the destination fully drawn; 220-690 KB per flight; 0 long tasks; frame interval p95 16.8 ms; page JS per frame p95 about 2 ms |
| Slow network | coarse first, refine after. Slow 3G: overview in 3 s, the flight waits (at most 4 s) for the destination's coarse chunks, and the view is complete 3.7-4.8 s after landing |

Screenshots (all in `research/img/`): `stream-overview.webp`, `stream-hop-1..4.webp` (Shimbashi to Rainbow Bridge, 4 km), `stream-arrival-{shimbashi,tower,yakkozaka,hills,waterfront}.webp`, and the slow-3G sequence `stream-slow3g-1..6-*.webp` (first frame, overview, mid-flight, landed, refining, complete).

## 1. Scale math

### 1.1 Measured on Minato-ku

Minato is a dense ward (towers up to 325 m), so it is an upper-ish bound per km². The covered box is 40.9 km² of which 6.1 km² is bay water; building footprints are 10.5 km².

| Level | Cube | Solid cells (incl. ground fill) | Face-culled quads | Archive bytes | Chunks |
|---|---|---|---|---|---|
| L0 | 1 m | 1,280,814,038 | 103,823,423 | 12.46 MB | 40,478 |
| L1 | 2 m | 163,395,604 | 24,364,531 | 5.33 MB | 10,226 |
| L2 | 4 m | 21,065,560 | 5,701,544 | 1.85 MB | 2,615 |
| L3 | 8 m | 2,800,886 | 1,300,100 | 0.55 MB | 668 |
| L4 | 16 m | 371,639 | 286,401 | 0.13 MB | 183 |
| L5, L6 | 32, 64 m | pooled from L4 | | 0.03 MB | 52 + 15 |

Each halving of resolution divides quads by 4 (L0 to L1), then roughly by 4.3, 4.4, 4.5: surface area, not volume, drives the cost, which is why face culling (and not a dense grid) is the only sane representation. A dense L0 grid would be 8192 x 7680 x ~380 = 24 G cells; the per-column run-length form is 12.5 MB.

Quad cost in the browser, **measured** with Palettes' mesh builder: 264 B per quad (position 48, uv 32, aInfo 64, aAo 16, aLight 16, aEdge 64, index 24). The Roppongi Hills view (160 L0 chunks) is 1.1 M quads = 227 MB resident. This number, not the network, is the real ceiling (see 4.4).

### 1.2 Extrapolation to Tokyo 23-ku (627 km²)

Scale factor from Minato's 40.9 km² of tiles: 15.3x **[INFERENCE: density of Minato is above the 23-ku average, so these are upper-ish bounds]**.

| Quantity | Minato (measured) | 23-ku **[INFERENCE]** |
|---|---|---|
| PLATEAU CityGML downloaded (zips) | about 380 MB (84 members) | 6-10 GB (the 2020 23-ku set is mostly LOD1, so smaller per km²; Minato's bldg is 57 MB unzipped per km², 10:1 zipped) |
| CityGML unzipped | 4.2 GB | 35-60 GB |
| Solid cells at 1 / 2 / 4 / 8 / 16 m | 1.28 G / 163 M / 21 M / 2.8 M / 0.37 M | 20 G / 2.5 G / 320 M / 43 M / 5.7 M |
| Face-culled quads at 1 / 2 / 4 / 8 / 16 m | 104 M / 24 M / 5.7 M / 1.3 M / 0.29 M | 1.6 G / 370 M / 87 M / 20 M / 4.4 M |
| Archive | 20 MB | about 300 MB; about 830 k L0 chunks, 1.05 M in total |
| Directory (dense, 10 B per chunk slot) | 294 KB deflated | 4-5 MB deflated: too big to fetch up front, needs leaf directories (section 3.3) |

Quads at the finest level are not the budget that matters: the view is. At any zoom a screen holds the same number of chunks (section 2.2), so the working set is about 100-200 chunks, 0.4-1.9 M quads, independent of whether the world is 20 or 627 km².

## 2. Chunking and LOD

### 2.1 What is built

- Fixed chunk: 32 x 32 columns by the column's full height (up to 361 cells at L0 here), at every level. A level-L chunk therefore covers `32 * 2^L` m and four level-(L-1) chunks tile it exactly: a quadtree, keyed `(level, cx, cz)`. Chunks that contain no voxel are absent from the directory.
- Each chunk stores a 1-cell ring from its neighbours of the same level (34 x 34 columns), so it meshes alone, in a worker, with correct face culling, AO and outline flags at its edges, and never has to wait for or re-mesh with a neighbour.
- Pyramid by priority pooling, like `src/lab/pool.ts`: a 2x2x2 block is solid when at least half its cells are (foliage: a quarter); the class is the highest-priority class present (pole, furniture, fence, vegetation, roof, building, bridge, rail, water, sidewalk, road, ground). Poles, furniture and fences survive only to 2 m cubes, otherwise they would turn into giant black cubes. Pooling counts, not max, so a coarse building does not swell.
- Levels 0-4 are cut per 512 m supertile (a 544 x 544 x ny region is composed from the 2.5D layers, then pooled four times). Levels 5-6 are pooled from one global 512 x 480 x 32 array of the 16 m voxels (that array is only 8 MB).
- Seams: coarse chunks are union-pooled, so a coarse neighbour is never lower than the fine one, and each chunk culls against its own ring; I saw no cracks, only steps at LOD borders. A fade or skirts (sources B.2) were not needed.

### 2.2 Selection: screen-space error for an orthographic camera

`pxPerMetre = viewportHeightCssPx / ((top - bottom) / zoom)`; a level is fine enough when `cell * pxPerMetre <= detailPx` (default 7 px, so the drawn cubes are 3.5-7 px). Same formula as Cesium's orthographic branch, `error = geometricError / pixelSize` (sources A.2, B.1). There is no distance term, so at one zoom every visible chunk is the same level and about `viewport / (32 * detail)` chunks are visible, about 130 for 1400x900 with tilt (**measured**: 28-176 wanted chunks per view). Chunk culling is the exact frustum test against the chunk's box (height from the directory).

### 2.3 Refinement and holes (the part that is easy to get wrong)

- A wanted chunk that is built is drawn; one that is not is replaced by its nearest built ancestor. Nothing finer under a drawn ancestor is drawn, so a parent gives way only when every wanted child is ready: no overlap, no pop of a lone child (Cesium's base traversal, sources A.3).
- A built chunk reaches the GPU the first time it is drawn, and a chunk waiting for its siblings is hidden, so naively it would wait forever (I hit this: a 90 s deadlock on slow 3G). Hidden-but-built chunks are drawn for one frame under their stand-in (where the coarser cubes cover them), within a per-frame budget of 60 k newly shown quads, so uploads are time-sliced and the first draw after landing is not a 100 ms spike.
- Level 6 (64 m) is pinned and loaded first, so there is always a stand-in; the quiet placeholder (a paper sheet with a faint dither, cut to the data footprint, under the floor) shows only where even that is missing. No spinner, no text.
- Alternatives considered, from the sources: clipmaps and CDLOD (viewer-centred, perspective, heightmap-only: wrong for an ortho cube city), Transvoxel (marching cubes: wrong tool), ADD refinement (double the quads), skip-LOD (holes). The 3D-Tiles-style REPLACE quadtree is the right fit; implicit-tiling availability bitsets are what the dense per-level directory already is.

## 3. Formats

### 3.1 Chunk blob (what is shipped)

Per chunk: `u8 version, u8 flags(bit0: u16 run lengths), u16 ny, u32 runs`, then `1156` u8 run counts (one per column of the 34 x 34 ring), `runs` u8 classes, `runs` u8/u16 lengths; a column is its runs bottom to top, trailing air is implicit. The whole blob is `deflate-raw`. Class bytes are the 13 classes of `src/cubeworld/voxels.ts`, so the "palette" is the class table. Average blob 307 B at L0, 521 B at L1; 12.5 MB for 40 k L0 chunks. Roblox does the same (32³ chunks, RLE then a generic codec, mip pyramid; sources A.4). A sparse surface-only voxel list was rejected: the face-culled quads are 5-10x more numerous than the columns' runs, and the mesher needs the interior to cull.

### 3.2 One archive with ranges vs many files

Chosen: one `chunks.bin` + a dense directory `dir.bin` (per level: u32 offsets, u32 lengths, u16 heights over the chunk grid) + `manifest.json` (frame, levels, themes, hashes). Reasons: 54 k small files is 54 k objects and requests (the PMTiles docs put uploading 300 M tiles at about $1,500; sources A.1), identical chunks (sea) are stored once (48,148 unique of 54,237), and chunks are written supertile by supertile, coarse first, in Morton order, so spatial neighbours are neighbours in the file and the client coalesces: chunks whose byte ranges are within 12 KB travel in one `Range` request (the reference PMTiles client does not merge ranges, sources A.1). Measured: 48-100 requests for 280-520 chunks per flight.

### 3.3 Compression

HTTP `Content-Encoding` and `Range` do not mix (RFC 9110 selects ranges of the encoded representation; Fetch adds `Accept-Encoding: identity` to ranged requests; Cloudflare returns the whole body when it has to decompress; sources A.6). So compress inside the archive. `deflate-raw` through `DecompressionStream` (Chrome 103, Firefox 113, Safari 16.4) runs in the worker. Brotli is still not in Chrome's `DecompressionStream`; zstd needs a WASM decoder; neither was worth it at 307 B per chunk. Worth benchmarking later: a trained zstd dictionary (small blobs share a lot of structure).

### 3.4 For Tokyo

PMTiles-shaped single archive (sources A.1): fixed header, a root directory under 16 KB, leaf directories for the rest, entries `(chunkId, offset, length, runLength)` delta/varint coded, `runLength` for repeated sea/empty chunks. Chunk id = Hilbert (or Morton) of `(level, cx, cz)`. About 1 M entries at about 10 B raw: 4-5 MB deflated in 40-70 leaf directories of 64-128 KB each, fetched on demand and cached. The dense per-level arrays used here are the right choice up to about 100 k chunks.

## 4. Browser engineering (Vite 8, three 0.186)

### 4.1 What the prototype does

- Workers: `new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' })` (Vite's documented form; sources C.1). `vite.config.ts` sets `worker.format: 'es'`. 2-4 workers (`hardwareConcurrency - 1`) each do range fetch or Cache Storage hit, inflate, run-length decode, and `buildWorldMesh(grid, palette, region)` on the padded grid, then return the typed arrays as transferables. The main thread wraps them in a `BufferGeometry`.
- The mesh builder (Palettes) is worker-safe (no DOM), emits only the 32x32 interior of the 34x34 grid but reads the ring for culling/AO, in grid coordinates; each chunk is `mesh.scale = 2^level`, `mesh.position = chunk corner - 1 cell`. One shared `ShaderMaterial`.
- Per-chunk `Mesh` (about 60-180 draw calls in view). BatchedMesh was not needed: draw calls stay under 200; frame JS is 2 ms.
- Memory: a typed array is dropped (`attribute.onUpload`) after its first upload, and bytes are accounted twice, `gpuBytes` (drawn once) and `cpuBytes` (built, not drawn yet). Budget 320 MB, LRU by last-drawn time, never evicting the coarsest level, anything wanted, or anything the active plan needs.
- `AbortController` per batch in the worker; `cancel` message from the manager; Cache Storage (`stream-<hash>`, old hashes deleted) as the persistent chunk cache, in the worker.
- `public/stream` is a dev tool like `public/lab`: `vite.config.ts` removes `dist/stream` unless `STREAM=1`, and `stream.html` is only an input with `STREAM=1`. Verified: `npx vite build` has neither; `STREAM=1 npx vite build` bundles the page and a 120 KB worker, and the production build was smoke-tested with `vite preview` (first frame, flight, no console errors).

### 4.2 Verified gaps in the browser APIs (from the sources)

`Cache.put` rejects 206 responses, so range slices are re-wrapped as 200s (done). `requestIdleCallback` is still missing in stable Safari (a `setTimeout` fallback is in the code). Long Tasks API is Chromium only (the report says `supported`, not 0). `performance.memory` is Chromium only: `jsHeapMB` is -1 elsewhere; GPU bytes are our own accounting plus `renderer.info`.

### 4.3 Hosting headers for the real deployment

- `chunks.<hash>.bin`, `dir.<hash>.bin`: `Cache-Control: public, max-age=31536000, immutable`, `Accept-Ranges: bytes`, and **no** `Content-Encoding` (they are compressed inside). If cross-origin: CORS allow `Range`, expose `Content-Range`, `Content-Length`, `ETag`. Single `Range: bytes=a-b` is CORS-safelisted (sources A.6), so no preflight; do not send `If-Match`.
- `manifest.json`, `stream.html`: `no-cache` (hash in the manifest points at the immutable files). JS/CSS: Vite's hashed names, `immutable`.
- HTTP/2 or HTTP/3 in front: a dev server on HTTP/1.1 caps at 6 connections (the manager uses 6 batches in flight, which matches); on H2 raise `MAX_INFLIGHT` to about 24. Cloudflare R2 or any CDN with Range support; verify with `curl -r 0-99 -H 'Accept-Encoding: identity' -I`.

### 4.4 Memory is the ceiling

Peak resident geometry after six flights: gpu 158-395 MB + pending 20-148 MB (budget 320 MB is soft: the plan's demand is not evicted, so it overshoots by about 100 MB), JS heap 187-500 MB (**measured**). At 264 B/quad this is the hard limit. The cheapest 5x: store positions as chunk-local `Uint16`, drop `uv` (derive the quad corner from a `Uint8` corner id), `aEdge`/`aAo`/`aLight`/`aInfo` as normalized `Uint8` (about 60 B per quad). That is a change in `mesh.ts`/`material.ts` (Palettes' files); Palettes confirmed the shader only reads `position, uv, aInfo, aAo, aLight, aEdge`, so a local-coordinate vertex shader works with the current `mesh.scale/position`. I did not do it; it needs a reopened palette task.

## 5. Optimistic loading, as built

1. **Plan before moving.** `planFlight(from, to)` is a pure function of progress u: an eased "hop" (zoom out while sliding, zoom in), duration `1300 + 650 log2(1 + d/400)` ms clamped to 1.6-4.5 s, the dip proportional to distance (peak view half-height about `0.55 d`), slide held back until the camera has risen (u 0.15-0.85).
2. **Sample and fetch.** At click, 29 poses along the plan are sampled; for each, the exact visible chunk set at that zoom is computed (ground height from built chunks, same camera heading) and unioned with every ancestor. Urgency = ms until first needed + 250 ms per level finer: coarse first, soon first. Roots (level 6) are pinned.
3. **Motion-adaptive detail.** Mid-flight the camera is moving too fast for 3.5 px cubes to matter, so cubes up to 3x wider are accepted until u = 0.6 and the scale eases back to 1 by u = 0.92, so the destination arrives at full detail. Without this a 3 km flight prefetched 5000 chunks and thrashed the budget (**measured**, then fixed).
4. **Never zoom into a void.** If, at u > 0.5, fewer than 90 % of the destination's wanted chunks have a built stand-in within 3 levels, flight time runs at 8 % speed (for at most 4 s) and those chunks are boosted ahead of the path. Reported as `stallMs`.
5. **Cancel.** A new click, a drag, the wheel or a key clears the plan; queued requests nobody wants any more are dropped, in-flight batches nobody wants are aborted (`cancelledBatches`). Verified: a second click 0.9 s into a flight aborted 6 batches and the first flight resolved as interrupted; a drag mid-flight stopped the flight at the current pose.
6. **Warm caches.** After the coarse roots are in, at `requestIdleCallback`, every theme destination's view (with ancestors) and every chunk of levels 3-6 are fetched into Cache Storage, built into nothing, behind every real request. From an empty cache: 1,886 chunks, 1.75 MB, 256 requests in under 15 s (**measured**). Reload: first frame 143 ms from cache.
7. **Progressive display, quiet gaps**: section 2.3.
8. **Anchored notes stay put, on the building.** A note (the place name beside its dot) is projected from the live camera with fresh matrices every drawn frame. Its anchor is read only from the pinned 1 m chunks around the place (always demanded, never evicted): the roof of the place's own column, or, for a street-level point, of the nearest building column within 6 m (the shops are ground-floor or basement units inside a building); the ground only when no building is near. The first version anchored to the ground height of the finest chunk that happened to be built: under memory pressure (a long zoom-out) the 1 m chunk was evicted, the pooled coarse levels' "ground" took over, and the dot slid 3 m (9.5 px, 83 frames over 1 px); and even when stable, the ground point of a shop behind a taller building slid across that building through parallax. Each frame the viewer also marches from the anchor toward the camera over the columns' tops (4 m or finer data only) and, if something stands in the way, the note dims to 45 % instead of disappearing. Measured, in Chrome, at the end of every frame: at most 0.07 px between the dot and the exact anchor in every frame that drew the canvas, 0 frames over 1 px, over big and trackpad-sized wheel deltas, ctrl-wheel pinch, arrow keys, drag with damping, window resizes and a zoom-to-minimum-and-pan-away stress.

## 6. Measurements (headless Chrome, M-series GPU, 1400x900, flights from the previous theme; `window.__stream.viewer.flyTo`)

"Wanted/drawn at landing" is the chunk set of the arrival view and how much of it is drawn as itself the moment the camera lands. Cold = `?cache=0`, no throttle.

| Run | Theme | Distance | Flight | Wanted / drawn at landing | Net KB (requests) | Cache hits | Frame p95 | JS/frame p95 (max) | Long tasks | Heap MB | GPU MB (+pending) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cold | tower | 1.1 km | 2.5 s | 81 / 81 | 305 (48) | 0 | 16.8 ms | 2.1 (2.7) | 0 | 234 | 158 (+24) |
| cold | shimbashi | 1.1 km | 2.5 s | 56 / 56 | 475 (52) | 0 | 16.8 | 1.9 (2.6) | 0 | 500 | 346 (+148) |
| cold | yakkozaka | 2.7 km | 3.2 s | 70 / 70 | 608 (100) | 0 | 16.7 | | 0 | | |
| cold | hills | 1.2 km | 2.6 s | 160 / 160 | 540 (68) | 0 | 16.7 | | 0 | 408 | 395 (+67) |
| cold | waterfront | 4.1 km | 3.6 s | 176 / 176 | 220 (89) | 0 | 16.8 | | 0 | 211 | 227 (+20) |
| cold | shimbashi | 3.2 km | 3.4 s | 56 / 56 | 690 (88) | 0 | 16.8 | | 0 | 382 | 332 (+57) |
| warm | tower | 1.1 km | 2.5 s | 81 / 81 | 107 (20) | 214 | 16.7 | | 0 | 231 | 158 |
| warm | shimbashi | 1.1 km | 2.5 s | 56 / 56 | 351 (38) | 216 | 16.8 | | 0 | 493 | 346 |
| warm | hills | 1.2 km | 2.6 s | 160 / 160 | 232 (31) | 399 | 16.8 | | 0 | 451 | 395 |
| warm | waterfront | 4.1 km | 3.6 s | 176 / 176 | 26 (25) | 470 | 16.7 | | 0 | 254 | 228 |
| warm | shimbashi | 3.2 km | 3.4 s | 56 / 56 | 44 (5) | 433 | 16.7 | | 0 | 350 | 332 |
| fast 3G (1.6 Mbps, 150 ms) | tower | 1.1 km | 2.6 s (stall 0.1) | 81 / 34 | 251 | 0 | 16.7 | 1.0 | 0 | | |
| fast 3G | yakkozaka | 2.7 km | 4.2 s (stall 0.9) | 70 / 41 | 423 | 0 | 16.8 | 0.7 | 0 | | |
| fast 3G | hills | 1.2 km | 3.0 s (stall 0.4) | 160 / 0 | 350 | 0 | 16.8 | 1.0 | 0 | | |
| slow 3G (400 kbps, 400 ms) | hills | 2.3 km | 6.1 s (stall 3.0) | 160 / 0 | 184 | 0 | 16.7 | 0.6 | 0 | | |
| slow 3G | shimbashi | 2.3 km | 5.1 s (stall 2.0) | 56 / 0 | 114 | 0 | 16.8 | 0.6 | 0 | | |

Reading it:
- On a local network, cold or warm, every destination is **fully loaded and drawn on arrival** (6/6, 5/5), with 0 long tasks (so none over 50 ms; `PerformanceObserver` `longtask`, Chromium), page JS at most 2.7 ms per frame, and a frame interval pinned at vsync (p95 16.7-16.8 ms). Headless vsync caps the frame interval, so the JS-per-frame column is the headroom number.
- Warm: the destination's bytes come from Cache Storage (up to 470 chunks served from cache, waterfront needs 26 KB), first frame 143 ms.
- Throttled, the destination is not complete at landing (that is physics), but is never empty: it lands on built coarse chunks (screenshots `stream-slow3g-4-landed.webp` to `-6-complete.webp`), and finishes 0.6-1.5 s after landing on fast 3G, 3.7-4.8 s on slow 3G. The stall is capped at 4 s, so on slow 3G the camera lands before everything is in.
- Network emulation: `tab.emulate({ network: { latency, download, upload } })` (bytes per second) throttles the page **and its workers** (checked: same coarse-first sequence as the built-in `?throttle=`). The built-in throttle is a per-worker virtual link (shared bandwidth split across workers, queued transfers, round-trip latency added) so tests are reproducible without CDP.
- First render needs 3.5 KB (the 15 level-6 chunks) and 33 KB for the 32 m overview of the whole ward: on slow 3G, 0.9 s and about 3 s.

## 7. Recommendations for all of Tokyo

**Formats.** Keep: 32x32-column chunks with a 1-cell ring, quadtree of 7-8 levels (add 128 m cubes for the 25 km city view), class-byte column RLE + `deflate-raw`. One PMTiles-shaped archive per world version: header, root directory under 16 KB, leaf directories (about 64 KB each, deflated, delta/varint columns, `runLength` for repeats), Morton or Hilbert chunk ids, supertile-major order with coarse levels first and all of levels 5-7 at the head of the file (one first request gets the overview). Version by content hash in the filename. Build per ward in parallel from the same 2.5D layers (the per-3rd-mesh raster step is embarrassingly parallel: 38 s for Minato, so about 10 min for 23 wards).

**Hosting/CDN.** R2 or any Range-capable CDN with H2/H3, `immutable` on `chunks.<hash>.bin` and `dir.<hash>.bin`, `no-cache` on manifest and HTML, CORS `Range`, expose `Content-Range`/`ETag`, no `Content-Encoding` on the archive (section 4.3). Expect about 300 MB for the archive and about 3 MB for a first visit's overview and destination view.

**Vite config.** Done: `worker: { format: 'es' }`; `STREAM=1` gates `stream.html` and drops `dist/stream` otherwise. For production: put the viewer behind a dynamic `import()` so three plus the viewer (about 550 KB, 140 KB gzipped) is not on the landing path; give it its own chunk with `build.rolldownOptions.output.codeSplitting` (`manualChunks` is deprecated in Vite 8/Rolldown), add `<link rel="modulepreload">` or `rel=prefetch` for that chunk and the worker from the globe page when the user hovers the cubeworld entry; read the archive base from `import.meta.env.VITE_WORLD_BASE_URL` per mode; keep the data out of `public/` (CDN origin), and set `Cache-Control: no-cache` on HTML so a redeploy does not leave a `vite:preloadError`. A service worker (Workbox `workbox-range-requests`) is optional: Cache Storage in the worker already does what the prototype needs, and avoids a second cache.

**Phased plan.**
1. (done) Minato pipeline, 7 levels, archive, streaming page, flights, metrics.
2. Compact vertex format (about 60 B/quad), then re-measure; this raises the visible-quad ceiling 4-5x and cuts the JS-heap and upload cost.
3. Tokyo 23-ku data: fetch the 2020 23-ku CityGML per 2nd mesh (LOD1 everywhere, LOD2 in the centre) and reuse `stream_build.py` per ward, with a mixed-source rule where Minato's FY2025 LOD3 pockets replace the 2020 data; add `luse` for parks if wanted. Measure the real archive size and directory.
4. Leaf-directory archive reader, `MAX_INFLIGHT` by protocol, `navigator.connection` / `saveData` to raise `detailPx` and skip warm-up.
5. Production hosting: R2 + CDN headers, hashed archive, manifest TTL, a smoke test that issues `curl -r` against the deployed archive.
6. Optional: BatchedMesh or merged-per-supertile meshes if draw calls ever exceed about 500; per-chunk dither cross-fade if the LOD steps bother (not needed so far); OPFS if Cache Storage quota is a problem.

## 8. Limits and known issues

- Rainbow Bridge (and any `brid` object) is a solid wall: the original lab rule fills bridge columns from the lowest to the highest sampled surface. The data pipeline is otherwise 2.5D (roof z-buffer), so overhangs, arcades and under-bridge space are lost; trees and bridges are the only non-column shapes.
- LOD3 exists only where PLATEAU has it (the Shimbashi pocket and a few meshes); elsewhere roads are LOD1/2 and there are no poles or trees (frn and veg are only in 10 and 5 meshes).
- Coverage is the frame of section 10, not a ward: meshes at its edge are cut by the frame, and the wards outside it (Ota, Bunkyo, Taito, Sumida, Nakano, Suginami) contribute only their meshes inside it. Outside the central wards the buildings are mostly LOD1 (flat roofs), see section 10.
- Memory: 264 B per quad, and GPU + JS heap peaked at about 400 + 150 MB; a laptop with 8 GB is fine, a phone is not. The budget (320 MB) is soft by roughly 100 MB while a plan is active.
- Not tested: Safari/Firefox (no Long Tasks API there, `requestIdleCallback` fallback untested), a real remote CDN, mobile GPUs, a non-headless frame rate above 60 Hz.
- `jsHeapMB` comes from non-standard `performance.memory` (Chromium).

## 9. Rebuild

```
V=pipeline/cache/cubeworld/venv/bin/python
$V pipeline/cubeworld/stream_build.py fetch     # ward zip listings, then 678 CityGML members (2.04 GB zipped) by HTTP range request
$V pipeline/cubeworld/stream_build.py prep      # DEM triangle caches per ward file + water triangles
$V pipeline/cubeworld/stream_build.py raster    # per-3rd-mesh tile layers (207 tiles)
$V pipeline/cubeworld/stream_build.py merge     # 16384 x 11264 global layers (preview: `... preview`)
$V pipeline/cubeworld/stream_build.py pack      # writes public/stream-next/ (--out DIR to change)
mv public/stream public/stream-old && mv public/stream-next public/stream   # swap in; the hash changes only if the content does
npm run dev                                     # then /stream.html
```

`chunks.<hash>.bin` (103.7 MB) is in `.gitignore` (over the 60 MB we keep in git); `manifest.json` and `dir.<hash>.bin` are committed, so a fresh clone needs the five steps above (about 20 min plus the download) before the world appears. Changing the frame or adding a ward in `stream_area.json` re-fetches only the missing members; delete `stream/dem/*.npz` and `stream/water_tris.npz` in the cache first (they are cut to the frame), and only the new 3rd-mesh tiles are rasterised.

Code: `pipeline/cubeworld/stream_build.py` (imports `plateau_voxelize.py` and `plateau_citygml.py`), `src/cubeworld/stream/` (`format.ts` wire format, `protocol.ts`, `chunk.worker.ts`, `selection.ts`, `manager.ts` queue/display/budgets, `flight.ts`, `viewer.ts`, `placeholder.ts`, `metrics.ts`, `icons.ts`, `main.ts`), `stream.html`, `vite.config.ts`.

## 10. Multi-ward build: Shimokitazawa to Morishita

The area is `pipeline/cubeworld/stream_area.json`: the EPSG:6677 frame and the list of ward zips. `stream_build.py` has no ward-specific code; adding a ward or moving the frame is an edit of that file and a rebuild.

**Frame.** `gx0 = -16800`, `gtop = -31533`, 16,384 x 11,264 cells (32 x 22 supertiles of 512 m; 8 x 5.5 top-level 2048 m chunks, 48 chunks at level 6). World `x = E - gx0 = E + 16800`, `z = gtop - N = -31533 - N`. The first version of this build (Shimokitazawa to Morishita) was `gtop -34093`, 14,336 x 8,704; a user report that Tatekawa 1-chome (Sumida, E -3080, N -34304) sat 210 m from the north edge and Ryogoku / Kinshicho were cut off moved the north edge 2,560 m up and the east edge 2,048 m out (the west and south edges are unchanged). It holds all of the old Minato frame (`gx0 -12081, gtop -35117, 8192 x 7680`, now at x 4719, z 3536), Shimokitazawa station (E -14960, N -37564: x 1840, z 6031) with 1.8 km to the west edge (Daita is also inside), Morishita (E -3243, N -34614: x 13557, z 3081), Tatekawa 1-chome (x 13720, z 2771, 2.8 km from the north edge, 2.6 km from the east edge), Ryogoku station (x 13150, z 2194), Kinshicho station (x 15050, z 2116) and Oshiage / Skytree (x 14960, z 641).

**Data.** FY2025 (令和7年度, spec 5.0) is the newest set for every ward in the catalog, so no ward needed an older year and no GSI DEM fallback was needed: each ward zip carries `dem`, `wtr`, `tran`, `bldg`. 16 wards are in `stream_area.json`: Chiyoda, Chuo, Minato, Shinjuku, Bunkyo, Taito, Sumida, Koto, Shinagawa, Meguro, Ota (DEM only), Setagaya, Shibuya, Nakano, Suginami, Edogawa (one sliver mesh at the east edge). Toshima, Kita, Arakawa and Katsushika touch the frame's 2nd-mesh DEM but carry no bldg/tran mesh in it, so they are not listed. Per ward the build takes the 3rd-mesh `bldg`, `tran`, `frn`, `veg`, `brid` files that touch the frame, and the 2nd-mesh `wtr` and `dem` files (Setagaya splits `533935` into `_00` and `_50`). Only those members are range-requested from each ward zip: 678 members, 2.04 GB zipped, mostly DEM.

- **Boundary meshes are in several zips, mostly as the same file.** Of the 235 used members that more than one ward carries, 154 are byte-identical (same name, size and CRC, read from the zip's central directory), so only the first ward's copy is fetched (1.65 GB instead of 2.23 GB); 81 differ slightly (another ward's clip or attributes) and are all read. Per tile every file of the mesh is read and one copy of each `gml:id` is kept (`plateau_citygml.Feature.gid`, `iter_unique`), so a building or road on a ward line is never doubled. Water bodies are merged by id, DEM triangles per mesh by concatenation.
- **Tiles are frame-independent.** Each 3rd-mesh tile stores its window in absolute EPSG:6677 integers; `merge` places it in the frame, so moving the frame re-merges and re-packs without re-rasterising.
- LOD: the best LOD per building, as before. Building features read by the tiles (windows overlap, so some are counted twice): LOD1 330 k, LOD2 65 k, LOD3 about 100. Chiyoda, Chuo and Minato are mostly LOD2 (LOD3 pockets at Shimbashi); Shinjuku and Koto are about 15 % LOD2; Setagaya, Meguro, Shinagawa, Shibuya, Nakano, Suginami and Sumida are LOD1 with LOD2 only in a few meshes, which is how those PLATEAU files are published (a mesh file holds `lod1Solid` for every building and `lod2*` for some). `frn` and `veg` (poles, trees) were read mainly in Chiyoda, Chuo, Minato and Shinjuku, with a few poles in Shibuya; there are none around Shimokitazawa, so low-rise areas have flat roofs and no street trees. Roads are LOD1 outlines where the ward has no LOD2 traffic areas.
- **Themes.** The five themes keep their positions (re-derived from lat/lon or EPSG:6677 for the frame: Shimbashi x 9680, z 5667). Two were added: `shimokitazawa` (x 1843, z 6034) and `morishita` (x 13557, z 3081).

**Measured** (headless Chrome, local dev server, cache off, after the Tatekawa extension): `dir.bin` 1,298,485 B (was 293,863 B), fetched whole at start with `manifest.json` (2.8 KB); the page JS heap was 65 MB with the directory loaded and about 290 MB of GPU buffers at the busiest wide view (the budget evicts). The numbers from the first (Shimokitazawa to Morishita) build, on 162 k chunks: first frame 1.7 s in the unbundled dev server with 71.5 KB of chunks in 7 requests; a 12 km flight from Shimokitazawa to Morishita took 4.5 s, landed with 80 of 80 chunks drawn, 0 long tasks, frame p95 16.7 ms, 779 KB over 139 requests. The overview at the coarsest LODs is emptier over the low-rise west than over the high-rise east, because a 64 m cell needs half of its 8 cells solid to be drawn and an 8 m building does not reach that; it fills in on zoom.

Screenshots: `research/img/stream-wide-1-overview.webp` (whole frame, first version), `stream-wide-{2,3,4}-west-shimokitazawa-*.webp` (zoom 0.08, 0.25, 1.0), `stream-wide-{5,6,7}-east-morishita-*.webp`, and for the extension `stream-wide-tatekawa-{1-close,2-mid,3-wide,4-full-frame}.webp` (Tatekawa 1-chome at zoom 1.0, 0.3, 0.1, and the whole 16 x 11 km frame).

Limits: no `luse` (parks are ground-coloured), no rail class is produced (PLATEAU's `trk` is not read), and most of the west (Setagaya, Nakano, Meguro, Shinagawa) has flat LOD1 roofs. The 104 MB archive is not in git (section 9).
