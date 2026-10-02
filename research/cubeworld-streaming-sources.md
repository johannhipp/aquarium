# Cubeworld streaming: sourced research notes

Scope: browsing all of Tokyo (~627 km², 1 m cubes, ~100M surface voxels) in a Vite 8 + three.js r186 site with an orthographic camera. Claims carry an inline link to a page that was opened while writing. Statements marked **[INFERENCE]** are my own reasoning, not something a source says. Browser-support numbers come from MDN's browser-compat-data (BCD) JSON fetched on 2026-10-02 and will drift.

## A. Prior art for tiled/streamed formats

### A.1 PMTiles v3 (single-file archive + HTTP range requests)

- **Layout.** A fixed 127-byte header, root directory, JSON metadata, optional leaf directories, then tile data. The root directory must fit in the first 16,384 bytes, so header + compressed root ≤ 16 KiB (max compressed root 16,257 B). More than one level of leaf directories is "discouraged" ([spec v3](https://raw.githubusercontent.com/protomaps/PMTiles/main/spec/v3/spec.md)).
- **Tile ids.** `TileID` is the cumulative position along a Hilbert curve per zoom, starting at z0: z0=0, z1 = 1..4, z2 starts at 5, and z12/3423/1763 = 19078479. Hilbert order keeps spatially close tiles close in the file ([spec v3](https://raw.githubusercontent.com/protomaps/PMTiles/main/spec/v3/spec.md)).
- **Directory entry.** `(TileID, Offset, Length, RunLength)`. `RunLength` 0 means "this entry is a leaf directory". `RunLength` > 1 means the same blob serves consecutive ids, which is the dedup mechanism (ocean, empty tiles).
- **Directory encoding.** A varint count, then column-wise varints: delta-encoded TileIDs, RunLengths, Lengths, Offsets. An offset is stored as `0` when it equals the previous offset+length (contiguous blobs), otherwise `offset+1`. The whole directory is then compressed with the header's *internal* compression (none/gzip/brotli/zstd). Tile blobs have their own *tile compression* field, and a `clustered` flag says blobs are in TileID order ([spec v3](https://raw.githubusercontent.com/protomaps/PMTiles/main/spec/v3/spec.md)).
- **Read path.** The docs say readers need "at most two cacheable intermediate requests" (header+root, then leaf) before the tile range ([PMTiles concepts](https://docs.protomaps.com/pmtiles/)).
- **Reference JS client.** It first fetches `bytes=0-16383`. It shares in-flight promises for headers and directories through a `SharedPromiseCache`, which does not cache tile bodies. It ref-counts fetches with `AbortController`s. It deliberately does not send `If-Match`, because that disables Chromium caching and forces a CORS preflight. It detects ETag changes from the response ETag or a 416. It sets `cache: "no-store"` on Chromium-on-Windows; the source I read doesn't say why ([index.ts](https://raw.githubusercontent.com/protomaps/PMTiles/main/js/src/index.ts)). It does not merge adjacent tile ranges.
- **Hosting notes.**
  - Any host with Range support works, and each ranged tile request bills as one GET.
  - R2 is "recommended" (no bandwidth fees, HTTP/2). S3, Azure, B2 and DigitalOcean Spaces are listed as HTTP/1.1 only.
  - CORS must allow `range` and `if-match` and expose `etag`.
  - The docs cite ~US$1,500 in request fees for uploading 300 M individual tile files ([cloud storage](https://docs.protomaps.com/pmtiles/cloud-storage), [concepts](https://docs.protomaps.com/pmtiles/)).
  - Putting the file in a framework's `/public` folder is a documented way to serve it locally ([concepts](https://docs.protomaps.com/pmtiles/)).
- **Fit.** It is a 2D `z/x/y` keyspace. Tokyo is a heightfield-like city, so a column-tile `z/x/y` with the full vertical extent in each tile maps onto it directly **[INFERENCE]**.

### A.2 3D Tiles 1.1 (OGC/Cesium)

- **Tree and error.** The tileset is a tree with HLOD. Each tile has a `geometricError` in metres, and the client estimates screen-space error (SSE) in pixels. A tile refines to its children when SSE exceeds the maximum ([3D Tiles spec](https://raw.githubusercontent.com/CesiumGS/3d-tiles/main/specification/README.adoc)).
- **Refinement.** `REPLACE` renders the children instead of the parent. `ADD` renders parent and children together. The root must specify one, and descendants inherit it ([spec](https://raw.githubusercontent.com/CesiumGS/3d-tiles/main/specification/README.adoc)).
- **Content.** glTF is the primary format, a tile may have multiple contents, and the 1.0 formats (b3dm etc.) are deprecated ([spec](https://raw.githubusercontent.com/CesiumGS/3d-tiles/main/specification/README.adoc)).
- **Implicit tiling.**
  - `subdivisionScheme` is `QUADTREE` or `OCTREE`, with `availableLevels`, `subtreeLevels` and a `subtrees.uri` template such as `subtrees/{level}/{x}/{y}.json`.
  - Availability (`tileAvailability`, `contentAvailability`, `childSubtreeAvailability`) is 1 bit per node, ordered by Morton Z-order per level and concatenated, or a single constant if uniform.
  - Sphere bounding volumes are disallowed. Morton order makes parent/child index maths bit shifts ([Implicit Tiling spec](https://raw.githubusercontent.com/CesiumGS/3d-tiles/main/specification/ImplicitTiling/README.adoc)).
  - A 7-level quadtree subtree holds (4⁷−1)/3 = 5461 nodes, so about 683 bytes per availability bitstream **[INFERENCE: arithmetic]**.
- **CesiumJS SSE.**
  - For perspective cameras: `error = geometricError * drawingBufferHeight / (distance * frustum.sseDenominator)`.
  - For orthographic or 2D: `pixelSize = max(frustum.top-bottom, right-left) / max(width,height)`; `error = geometricError / pixelSize`.
  - The error is then divided by `pixelRatio` ([Cesium3DTile.js](https://raw.githubusercontent.com/CesiumGS/cesium/main/packages/engine/Source/Scene/Cesium3DTile.js)).
  - `maximumScreenSpaceError` defaults to **16** px ([Cesium3DTileset docs](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)).
  - The same ortho branch exists in the three.js 3D Tiles renderer (`info.pixelSize = Math.max(h/res.height, w/res.width)`, `error = geometricError / pixelSize`; `errorTarget = 16`) ([TilesRenderer.js](https://raw.githubusercontent.com/NASA-AMMOS/3DTilesRendererJS/master/src/three/renderer/tiles/TilesRenderer.js), [TilesRendererBase.js](https://raw.githubusercontent.com/NASA-AMMOS/3DTilesRendererJS/master/src/core/renderer/tiles/TilesRendererBase.js)).

### A.3 Cesium and Google Photorealistic 3D Tiles: runtime behaviour

- **Replacement traversal.** With `skipLevelOfDetail` false (the default), the base traversal refines "only if all children are loaded". Empty tiles are exempt. Otherwise the already-loaded parent keeps rendering ([BaseTraversal](https://raw.githubusercontent.com/CesiumGS/cesium/main/packages/engine/Source/Scene/Cesium3DTilesetBaseTraversal.js)).
- **Request ordering and cancellation.**
  - Requested tiles are sorted by priority before requests are issued, "less likely [that] requests will be cancelled after being issued".
  - In-flight requests not touched in the current frame are cancelled (`cancelOutOfViewRequests`) ([Cesium3DTileset.js](https://raw.githubusercontent.com/CesiumGS/cesium/main/packages/engine/Source/Scene/Cesium3DTileset.js)).
- **Tile priority.** It is a single decimal number packed from digits. Lower is more urgent, and the digits are ordered from most to least significant:
  - flight-destination preload
  - foveated defer
  - foveated factor
  - progressive-resolution flag
  - distance (non-skipLOD REPLACE) or reverse SSE
  - depth ([Cesium3DTile.js](https://raw.githubusercontent.com/CesiumGS/cesium/main/packages/engine/Source/Scene/Cesium3DTile.js)).
- **Cache.** `cacheBytes` defaults to 536,870,912 (512 MiB). It is estimated GPU memory, and it can overflow up to `maximumCacheOverflowBytes` before the SSE is raised ([Cesium3DTileset docs](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)).
- **Cache overflow in the three.js renderer.** Its caches are *hard* caps. When the needed tiles don't fit, coarser tiles show and refinement stops ([3DTilesRendererJS README](https://raw.githubusercontent.com/NASA-AMMOS/3DTilesRendererJS/master/README.md)).
- **Google Photorealistic 3D Tiles.**
  - Clients start at `root.json`. Every later URL needs the `session` and `key` query parameters.
  - A root request supports "at least three hours" of tile requests ([overview](https://developers.google.com/maps/documentation/tile/3d-tiles), [renderer guide](https://developers.google.com/maps/documentation/tile/create-renderer)).
  - The policies forbid pre-fetching, indexing, storing or caching content beyond HTTP cache semantics, and require honouring `max-age`, `stale-while-revalidate` and ETag ([policies](https://developers.google.com/maps/documentation/tile/policies)). That makes it a poor model for offline prefetch but a fine model for tile-per-request streaming.

### A.4 Voxel-specific formats

| Format | What's stored | Takeaway |
|---|---|---|
| Minecraft region (McRegion/Anvil) | One file per 32×32 chunks. Two 4 KiB header sectors: 1024 × (3-byte sector offset + 1-byte sector count) and 1024 timestamps. Per chunk: 4-byte length, 1-byte compression id (zlib default; LZ4 since 24w04a), payload. Chunks >1020 KiB spill to `c.x.z.mcc` ([wiki](https://minecraft.wiki/w/Region_file_format)). | A fixed-size locator table is the simplest random-access index. It is mutable-friendly, but it has no HTTP story. |
| MagicaVoxel `.vox` | RIFF-like chunks. `SIZE` + `XYZI` is a flat list of `(x,y,z,colorIndex)`, 4 bytes per voxel, plus a 256-entry RGBA palette ([format](https://raw.githubusercontent.com/ephtracy/voxel-model/master/MagicaVoxel-file-format-vox.txt)). | Authoring and interchange format. It has no spatial index and is too fat for 10⁸ voxels. |
| Teardown, GPU side | Each object is a 3D texture with one byte per voxel indexing a 256-entry palette ([Acko](https://acko.net/blog/teardown-frame-teardown/)). The world-scale volume is 8-bit texels packing 2×2×2 voxels, with 3 mip levels ([breakdown](https://juandiegomontoya.github.io/teardown_breakdown.html)). | The palette index per voxel works fine. A uniform grid is wasteful for sparse worlds. |
| Teardown, on disk | I found no official spec. A community converter inflates the game's compressed level file to `.tdbin`, then reads each shape as `sizeX,sizeY,sizeZ` plus pairs of `(run_length: u8, palette_index: u8)` ([parser.cpp](https://raw.githubusercontent.com/TTFH/Teardown-Converter/main/src/parser.cpp), [README](https://raw.githubusercontent.com/TTFH/Teardown-Converter/main/README.md)). | **Unverified against Teardown itself.** It is community reverse engineering, but it matches the "RLE + palette" idea. |
| Roblox voxel terrain | 32³ chunks in a hash map, with 16³/8³/4³ mip boxes used for LOD. On disk the chunk is RLE-coded then LZ4-compressed, and the author reports 2×–30× on real content. He notes RLE before LZ "significantly reduces the size of data making LZ faster" ([zeux](https://zeux.io/2017/03/27/voxel-terrain-storage/)). | The closest published precedent for chunk + mip pyramid + RLE + generic codec. |
| Arnis (OSM→Minecraft) | Pulls OSM via Overpass, prioritises/sorts elements, places blocks through a `WorldEditor`, and writes Minecraft region files ([wiki](https://github.com/louis-e/arnis/wiki/Codebase-Architecture-&-Workflow)). | It is an offline generator, not a streaming design. Useful as a data-pipeline reference only. |

### A.5 Point-cloud and sparse-voxel LOD (priority ideas)

- **Potree.**
  - Octree traversal visits nodes in order of *screen-projected size*: `projectedSize = screenHeight/2 · radius/(slope·distance)`, `slope = tan(fov/2)`.
  - It stops at a point budget or a minimum projected size, then schedules only the first X=5 unloaded nodes per frame.
  - The thesis notes the hierarchy loads lazily, so a node counted as visible can later lose budget to a more important newly-loaded subtree.
  - For orthographic profile views it uses level-order traversal, because under orthographic projection lower-level nodes already map to larger screen sizes ([Schütz 2016 thesis](https://www.cg.tuwien.ac.at/research/publications/2016/SCHUETZ-2016-POT/SCHUETZ-2016-POT-thesis.pdf); [overview](https://www.cg.tuwien.ac.at/research/publications/2016/SCHUETZ-2016-POT/)).
- **GigaVoxels** renders billions of voxels via "ray-guided streaming", where the data requested is driven by what the rays touch ([Crassin et al. 2009](https://gigavoxels.inria.fr/Publications/2009/CNLE09/)). The transferable idea is that visibility decides the request list. It is not a mesh pipeline.

### A.6 Delivery: per-chunk files vs one archive vs HTTP compression

| Option | Pros | Cons |
|---|---|---|
| One file per chunk (`/world/v3/z/x/y.bin`) | Trivial. Works with `public/`, any CDN, and `Content-Encoding: br` for free. Full HTTP caching per tile. | Object-count and request-fee costs. Needs a build step to copy 10⁴–10⁵ files. Cache invalidation is per file. |
| Single archive + `Range` (PMTiles-like) | One upload. Dedup via `RunLength`. Hilbert clustering lets neighbouring tiles share CDN cache blocks. | Needs Range + CORS config when cross-origin. Compression has to be inside the archive. |
| HTTP-level compression on the archive | – | **Does not work with Range.** See below. |

Why `Content-Encoding` and `Range` don't mix:

- RFC 9110 says `Range` selects subranges of the *selected representation data* (§14.2), and representation data is defined as `Content-Encoding(Content-Type(data))` (§8.1). A range into a gzip-encoded object therefore indexes the compressed bytes ([RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.txt)).
- The Fetch spec appends `Accept-Encoding: identity` to any request containing `Range`, "to avoid a failure when handling content codings with a part of an encoded response", and notes "many servers mistakenly ignore Range headers if a non-identity encoding is accepted" ([Fetch](https://fetch.spec.whatwg.org/)).
- Cloudflare says that if it must decompress a complete encoded response it ignores `Range` and returns the complete body as `200`. Its Origin Range Requests align origin fetches to 1 MiB cache blocks ([range behaviour](https://developers.cloudflare.com/cache/reference/range-requests/)). Its auto-compression list includes `application/json`, `application/x-protobuf` and `application/wasm`, but I found no `application/octet-stream` in it ([compression](https://developers.cloudflare.com/speed/optimization/content/compression/)).
- I did **not** find a primary doc for S3/R2 behaviour with stored `Content-Encoding`. Verify with `curl -r 0-99 -H 'Accept-Encoding: identity' -I`.

Codec comparison for small binary blobs:

| Codec | `DecompressionStream` (BCD) | HTTP `Content-Encoding` (BCD) | Notes |
|---|---|---|---|
| gzip / deflate | Chrome 80, Firefox 113, Safari 16.4 | universal | Native, streaming, usable in workers ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream), [BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/DecompressionStream.json)). |
| deflate-raw | Chrome 103, Firefox 113, Safari 16.4 | – | Skips the 18-byte gzip wrapper, which matters for hundreds of tiny blobs. |
| brotli | **Firefox 147, Safari 18.4, no Chrome** | `br`: Chrome 50, Firefox 44, Safari 11 | The spec now lists `"brotli"` ([Compression spec](https://compression.spec.whatwg.org/)). Its 122,784-byte built-in dictionary is web-text tuned ([RFC 7932 App. A](https://www.rfc-editor.org/rfc/rfc7932.txt)), so little help for voxel bytes. |
| zstd | Firefox 138 behind a flag only | `zstd`: Chrome 123, Firefox 126, Safari 26.3 ([BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/http/headers/Content-Encoding.json)) | Trained dictionaries "improve dramatically" small-data ratios ([zstd README](https://raw.githubusercontent.com/facebook/zstd/dev/README.md)), but you ship a WASM decoder. |

The premise "brotli not supported" is outdated for Firefox and Safari, but still true for Chrome.

### Recommendation for a ~100M-voxel-surface browser voxel world with a Vite site

- Use a **PMTiles-shaped single archive** per world version, with Hilbert-ordered column tiles `z/x/y`. Reuse the 127-byte header + varint-delta directory design (or literally PMTiles with a custom tile type and `tileType=0`) **[INFERENCE]**. Use per-chunk files only in dev (`public/`).
- Compress **inside** the archive. Do structure-aware encoding first (palette ids, column RLE, as Roblox/Teardown do), then `deflate-raw` through `DecompressionStream` in a worker. Benchmark zstd+dictionary against it before adding a WASM decoder.
- Never set `Content-Encoding` on the archive object. Compress the small root/leaf directories and the manifest JSON normally.
- Dedup empty tiles (river, sea, parks) with `RunLength`.
- Coalesce adjacent ranges yourself (merge if the gap is under ~16–32 KiB). The PMTiles client doesn't do this **[INFERENCE]**.

## B. LOD structure and view-dependent selection

| Scheme | Mechanism | Seam handling | Fit for cubes |
|---|---|---|---|
| 3D-Tiles-style quadtree HLOD | Tile tree with `geometricError`, SSE-driven refine, REPLACE/ADD ([spec](https://raw.githubusercontent.com/CesiumGS/3d-tiles/main/specification/README.adoc)). | Skirts or overlap, left to the client. | **Best.** Streaming-native and has a mature orthographic SSE. |
| Geometry clipmaps (Losasso & Hoppe 2004) | Nested regular grids around the viewer, shifted incrementally with toroidal addressing. A transition region morphs geometry to the next-coarser level to hide boundaries and avoid popping ([GPU Gems 2 ch. 2](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry), [paper](https://dl.acm.org/doi/10.1145/1186562.1015799)). | Geometric morph. | Viewer-centred, so it suits a perspective camera that moves. For ortho there's no "distance", and morphing cubes isn't natural. |
| CDLOD (Strugar) | A quadtree of regular grids. The LOD function is the same across the whole mesh and based on 3D distance. It morphs per vertex ([abstract](https://exa.ai/library/publication/2s29jh4v1zg)). | Morph. | Heightmap-only. |
| Octree voxel LOD | Mip pyramid per chunk (Roblox: 32³→16³→8³→4³ ([zeux](https://zeux.io/2017/03/27/voxel-terrain-storage/))). | Needs stitching. | Needed only if you want true 3D overhangs at LOD. |
| Transvoxel (Lengyel 2009) | Stitches triangle meshes from *marching cubes* at different resolutions ([terathon](https://www.terathon.com/voxels/)). | Transition cells. | Wrong tool: it targets smooth marching-cubes surfaces, not cubical faces. |

### B.1 SSE for an orthographic camera

Cesium and 3DTilesRendererJS already do this: `error = geometricError / pixelSize` (see A.2). In your terms:

```
pxPerMetre = viewportHeightPx / (2 * halfHeightM / zoom)   // 1 m voxel = pxPerMetre pixels
sse        = geometricError_m * pxPerMetre
refine if sse > tau
```

- With square pixels and `max(w,h)` replaced by the vertical extent, this equals Cesium's formula.
- There is **no distance term**, so every visible tile at a given zoom selects the **same LOD level**. The problem reduces to a slippy-map pyramid: pick one level from the zoom, cull to the ground footprint, and keep coarser ancestors as placeholders **[INFERENCE]**.
- Take `geometricError` for a cell edge of 2ᵏ m as about 2ᵏ m, which is a conservative stand-in, not a measured Hausdorff error **[INFERENCE]**. For the 1-bit dithered look, τ of about 2–4 px keeps cubes from visibly growing.
- Level selection `k = floor(log2(τ / pxPerMetre))`, using τ = 4 px and a 1080 px viewport (arithmetic, **[INFERENCE]**):

| View height | px/m | k | Cell edge |
|---|---|---|---|
| 135 m | 8 | 0 | 1 m |
| 1 080 m | 1 | 2 | 4 m |
| 4 320 m | 0.25 | 4 | 16 m |
| 10 km | 0.108 | 5 | 32 m |
| 25 km (all Tokyo) | 0.043 | 6 | 64 m |

- If every level uses the same tile size in voxels (64×64 columns), a tile is always about 64·τ = 256 screen pixels. A 1920×1080 view then shows about 7.5×4.2 ≈ 32 tiles, or about 60 with a one-tile prefetch ring, at *any* zoom **[INFERENCE: arithmetic]**.
- A tilted (isometric) ortho camera foreshortens vertical errors by `cos(elevation)` and horizontal ones by `sin`. Treating the error as isotropic is conservative **[INFERENCE]**.

### B.2 Seams in cube worlds

- Quantized-mesh already exposes edge-vertex index lists "to add skirts to hide cracks between adjacent levels of detail" ([quantized-mesh](https://raw.githubusercontent.com/CesiumGS/quantized-mesh/master/README.md)). The clipmap chapter's answer is a morph band, and Transvoxel's is transition cells.
- **[INFERENCE] for cubes:**
  1. Build coarse levels by *max*-pooling column heights, so the coarse surface is never below the fine one.
  2. Add vertical skirts down to the neighbour's minimum height on every tile edge.
  3. Because ortho has one level per view, mismatches only occur during a transition. A dither cross-fade (stochastic screen-door between parent and child) fits the existing 1-bit shader and avoids a hard pop.

### B.3 Hysteresis and "coarser ancestor as placeholder"

- **Cesium**
  - Base traversal doesn't refine until every renderable child is loaded, and the parent keeps drawing meanwhile ([BaseTraversal](https://raw.githubusercontent.com/CesiumGS/cesium/main/packages/engine/Source/Scene/Cesium3DTilesetBaseTraversal.js)).
  - It does not enable `skipLevelOfDetail` by default.
  - I saw no explicit SSE hysteresis band in the lines I read.
- **MapLibre**
  - `_updateRetainedTiles` retains loaded *children* of an ideal tile that lacks data, and otherwise walks up to a loaded *parent* (bounded by `maxUnderzooming`) "to reduce flickering" ([tile_manager.ts](https://raw.githubusercontent.com/maplibre/maplibre-gl-js/main/src/tile/tile_manager.ts)).
  - `cancelPendingTileRequestsWhileZooming` (default true) cancels tiles from outdated zooms that haven't loaded ([map.ts](https://raw.githubusercontent.com/maplibre/maplibre-gl-js/main/src/ui/map.ts)).

### Recommendation for a ~100M-voxel-surface browser voxel world with a Vite site

- Quadtree pyramid over ground columns (1 level = 1 power-of-two cell edge), selected purely from `pxPerMetre`. Do **not** build clipmaps or Transvoxel.
- Use `tau ≈ 2–4 px`. Refine at `sse > tau` and coarsen at `sse < 0.75·tau` (hysteresis) to stop thrash on trackpad zoom **[INFERENCE]**.
- Keep the old level drawn until all replacement tiles for the footprint are resident (Cesium base traversal), with a MapLibre-style fallback ancestor/descendant walk for holes.
- Use max-pooled coarse heights + skirts, and a dither cross-fade on swap.

## C. Browser best practices (Vite 8 / three.js 0.186)

### C.1 Vite 8 / Rolldown

- **Workers.**
  - `new Worker(new URL('./w.ts', import.meta.url), { type: 'module' })` is "the recommended way".
  - Detection works only if `new URL()` is directly inside `new Worker()` and option values are static literals.
  - `?worker`, `?worker&inline`, `?worker&url` are the alternatives ([Features → Web Workers](https://vite.dev/guide/features.html#web-workers)).
  - `worker.format` defaults to `'iife'` (`'es' | 'iife'`), `worker.plugins` must be a function in build, and `worker.rolldownOptions` supersedes `rollupOptions` ([worker options](https://vite.dev/config/worker-options.md)). Set `format: 'es'` if the worker imports shared modules or dynamic chunks **[INFERENCE]**.
- **Assets.** Files in `public/` are copied as-is, un-hashed, and referenced by root-absolute path. The docs say to prefer importing assets unless you need `public`'s guarantees ([Static Asset Handling](https://vite.dev/guide/assets.md)). `base` rewrites URLs, and dynamic URLs must use `import.meta.env.BASE_URL` ([Building for Production](https://vite.dev/guide/build.md)).
- **Env.**
  - Only `VITE_`-prefixed variables reach client code, so never put secrets there.
  - Load order is `.env`, `.env.local`, `.env.[mode]`, and shell variables win ([Env and Modes](https://vite.dev/guide/env-and-mode.md)). A natural fit is `VITE_WORLD_BASE_URL` per mode **[INFERENCE]**.
- **Chunking.**
  - `build.rolldownOptions.output.codeSplitting` is the documented chunking hook ([Building for Production](https://vite.dev/guide/build.md)).
  - `manualChunks` is deprecated, and ignored if both are set ([Rolldown manualChunks](https://rolldown.rs/reference/OutputOptions.manualChunks.md), [codeSplitting](https://rolldown.rs/reference/OutputOptions.codeSplitting.md)).
  - Groups take `name`, `test`, `priority`, `minSize`, `maxSize`, and `minShareCount`.
  - The module-preload polyfill is on by default, and `build.modulePreload.resolveDependencies` can filter preloads per dynamic import ([build options](https://vite.dev/config/build-options.md)).
  - Vite emits `vite:preloadError` when a chunk fetch fails (e.g. after a redeploy deleted old assets). Serve HTML with `Cache-Control: no-cache` ([Building for Production](https://vite.dev/guide/build.md)).
- **Big data.** Keep `public/` for dev only. Un-hashed names need versioned paths (`/world/v3/…`) for `immutable` caching **[INFERENCE]**.

### C.2 Platform APIs

| API | Status (BCD) | Use |
|---|---|---|
| `DecompressionStream` gzip/deflate | Baseline since May 2023 ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream)) | Tile decode in worker. |
| `OffscreenCanvas` + WebGL | Chrome 69, Firefox 105, Safari 16.4 (WebGL context 17) ([BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/OffscreenCanvas.json), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)) | Render-in-worker option. A three.js example exists (`webgl_worker_offscreencanvas`, listed in the [repo tree](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_worker_offscreencanvas.html)). Probably unnecessary: mesh in workers, render on main. |
| Transferables | `ArrayBuffer` transfer detaches the sender ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)) | Return mesh typed arrays zero-copy. |
| `AbortController` / `AbortSignal.any` | any: Chrome 116, Firefox 124, Safari 17.4 ([BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/AbortSignal.json), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)) | Per-tile cancel. |
| `requestIdleCallback` | Chrome 47, Firefox 55, **Safari only behind a preview flag** ([BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Window.json), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback)) | Don't rely on it. |
| `scheduler.postTask` (`user-blocking`/`user-visible`/`background`, abortable) | Chrome 94, Firefox 142, no Safari ([BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Scheduler.json), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/postTask)) | Prefer with a `MessageChannel` fallback **[INFERENCE]**. |
| Long Tasks / Long Animation Frames | Chrome-only, experimental (Long Tasks ≥50 ms) ([BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/PerformanceLongTaskTiming.json), [BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/PerformanceLongAnimationFrameTiming.json), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongAnimationFrameTiming)) | Dev telemetry only. |
| OPFS `createSyncAccessHandle` | Chrome 102, Firefox 111, Safari 15.2 ([BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/FileSystemFileHandle.json)) | Persistent archive-slice cache in a worker **[INFERENCE]**. |
| Memory probes | `performance.memory` deprecated, Chrome-only. `measureUserAgentSpecificMemory` is Chrome 89+, experimental, and needs cross-origin isolation ([BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Performance.json), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory)) | Don't build logic on them. Do your own byte accounting. |

### C.3 Caching layers

- `Cache-Control: public, max-age=31536000, immutable` is the documented pattern for versioned/hashed URLs ([MDN Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control)).
- `<link rel=modulepreload>` is Baseline since Sep 2023 ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/modulepreload)). `rel=prefetch` stores in the HTTP cache, but cache partitioning can defeat cross-site use ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/prefetch)).
- **Cache Storage and ranges.**
  - The Service Worker spec rejects `Cache.put` of a `206` response with a `TypeError` ([Service Workers](https://w3c.github.io/ServiceWorker/)).
  - So a range-fetched slice cannot be stored as-is. Re-wrap it as a synthetic `200` keyed by `…/tile/z/x/y`, or use OPFS.
  - Workbox's `RangeRequestsPlugin` serves ranges *from* a cached full response ([Workbox](https://developer.chrome.com/docs/workbox/modules/workbox-range-requests/)).
  - The Cache API "doesn't honor HTTP caching headers" ([MDN Cache](https://developer.mozilla.org/en-US/docs/Web/API/Cache)).
- **Response headers for the data host.**
  - `Accept-Ranges: bytes`.
  - Allow `Range` in `Access-Control-Allow-Headers` (PMTiles' CORS recipes do). Per the Fetch spec, a single `bytes=N-` or `bytes=N-M` range is itself CORS-safelisted (suffix ranges `bytes=-N` are not), so `Range` alone should not force a preflight, whereas `If-Match` does (hence the PMTiles client omits it). I did not test this in each browser ([Fetch](https://fetch.spec.whatwg.org/), [cloud storage](https://docs.protomaps.com/pmtiles/cloud-storage)).
  - Expose `ETag`. `Content-Range` isn't in the safelisted response-header set either, so expose it too if you read it ([Fetch](https://fetch.spec.whatwg.org/)).
  - Immutable `Cache-Control`.
  - Serving the archive same-origin avoids CORS configuration entirely **[INFERENCE]**.
  - Ranges: [MDN Range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests).

### C.4 three.js r186

- `BufferGeometry.dispose()` frees GPU buffers. It is not automatic. Removing a mesh from the scene does not dispose its geometry/material ([BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html), [How to dispose](https://threejs.org/manual/pages/how-to-dispose-of-objects.html)).
- `renderer.info` reports geometry/texture counts and draw stats, and is the documented leak check ([WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html), [How to dispose](https://threejs.org/manual/pages/how-to-dispose-of-objects.html)). It counts objects, not bytes. Estimate bytes yourself.
- `BatchedMesh(maxInstanceCount, maxVertexCount, maxIndexCount, material)` ([BatchedMesh](https://threejs.org/docs/pages/BatchedMesh.html)):
  - `perObjectFrustumCulled` and `sortObjects` default to true.
  - It has `addGeometry` / `deleteGeometry` / `optimize()` / `setGeometrySize` / `setInstanceCount`. Shrinking throws if the free space isn't at the tail.
  - Capacity is pre-declared. It is attractive for cutting draw calls, but fixed-capacity packing plus `optimize()` repacking costs complexity. I did not benchmark it.
  - A per-chunk `Mesh` is the simple baseline **[INFERENCE]**.
- `BufferAttribute`: `usage` cannot be changed after first use, and `addUpdateRange(start, count)` uploads partial ranges ([BufferAttribute](https://threejs.org/docs/pages/BufferAttribute.html)). Chunk meshes are write-once, so `StaticDrawUsage` with one upload per chunk suits them. Cap uploads per frame **[INFERENCE]**.
- `compileAsync` uses `KHR_parallel_shader_compile` and resolves when rendering won't stall on compilation. `initTexture` pre-uploads a texture ([WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)). One dither material means a single compile at startup.
- MDN's WebGL best-practices: "Delete objects eagerly", "Batch draw calls", prefer `KHR_parallel_shader_compile`, "Estimate a per-pixel VRAM budget", and avoid blocking calls such as `getError`/`getParameter` in production ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)).

### Recommendation for a ~100M-voxel-surface browser voxel world with a Vite site

- Workers: `new Worker(new URL('./chunk.worker.ts', import.meta.url), { type: 'module' })`, with `worker.format: 'es'`. The worker does fetch → decompress → mesh and transfers typed arrays back.
- Prefer a pool of 2–4 workers (`navigator.hardwareConcurrency` capped) **[INFERENCE]**.
- Put chunk data on a separate immutable, versioned path or origin (never hashed `public/`). Send `immutable` + `Accept-Ranges` + CORS (`Range` allowed, `ETag`/`Content-Range` exposed).
- Implement your own LRU keyed by **bytes** (Cesium: 512 MiB default) and `dispose()` on eviction.
- Don't use `requestIdleCallback` for correctness. Use `scheduler.postTask` with a fallback.
- Skip the Service Worker initially. OPFS or an in-memory LRU gives most of the benefit.

## D. Optimistic loading / prefetch scheduling

### D.1 Cesium and 3DTilesRendererJS

- **Request scheduler.** It exists "to track and constrain the number of active requests" so new requests "don't have to compete for bandwidth with requests that have expired".
  - Defaults: `maximumRequests` = 50, `maximumRequestsPerServer` = 18, `throttleRequests` = true.
  - `requestsByServer` overrides are intended for known HTTP/2 or HTTP/3 servers ([RequestScheduler](https://cesium.com/learn/cesiumjs/ref-doc/RequestScheduler.html)).
  - A `Request` has a unit-less `priority` (lower = higher priority, usually camera distance), updated every frame by a `priorityFunction`, plus `throttle` and `throttleByServer` flags. The docs note browsers allow "about 6–8" HTTP/1 connections and effectively unlimited HTTP/2 streams ([Request](https://cesium.com/learn/cesiumjs/ref-doc/Request.html)).
- **Tileset-level knobs.**
  - `preloadFlightDestinations` **exists**, default true: "Fetch tiles at the camera's flight destination while the camera is in flight".
  - `foveatedScreenSpaceError` (default true) raises the SSE at screen edges and defers edge tiles until the centre has loaded. `foveatedTimeDelay` is 0.2 s after the camera stops, and `foveatedConeSize` is 0.1.
  - `progressiveResolutionHeightFraction` is 0.3: tiles meeting SSE at 30% of screen height are prioritised, to lay down a coarse layer fast.
  - `cullRequestsWhileMoving` (true, multiplier 60) skips tiles unlikely to still be needed when they arrive.
  - `preloadWhenHidden` is false ([Cesium3DTileset docs](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html), [source options](https://raw.githubusercontent.com/CesiumGS/cesium/main/packages/engine/Source/Scene/Cesium3DTileset.js)).
- **Flight preload.** The docs and options confirm it is a tileset option. I did not trace the `camera.flyTo` integration in the source.
- **3DTilesRendererJS** (three.js):
  - The default download queue allows 25 jobs per origin, the parse queue 5, and the node queue 25 (the bare `PriorityQueue` class defaults to 6) ([TilesRendererBase.js](https://raw.githubusercontent.com/NASA-AMMOS/3DTilesRendererJS/master/src/core/renderer/tiles/TilesRendererBase.js), [DownloadPriorityQueue.js](https://raw.githubusercontent.com/NASA-AMMOS/3DTilesRendererJS/master/src/core/renderer/utilities/DownloadPriorityQueue.js)).
  - A removed or evicted tile aborts via its `AbortController`, which also drops it from the queue.
  - Cancellation is *selective*: only `QUEUED` tiles are dropped on view change, "to avoid cancelling tiles that may already be nearly downloaded".

### D.2 Other renderers

- **MapLibre.** It keeps substitutes (children, else ancestors) while ideal tiles load and can cancel stale-zoom requests (B.3).
- **Mapbox.** The native SDK has a per-source prefetch zoom delta (`Source::setPrefetchZoomDelta`), and `mapbox-gl-js` has an open request to preload lower-zoom tiles for perceived performance ([native PR 16179](https://github.com/mapbox/mapbox-gl-native/pull/16179), [gl-js #2826](https://github.com/mapbox/mapbox-gl-js/issues/2826)). I did not find a primary doc describing Google Maps' web prefetch strategy.

### D.3 HTTP-level mechanics

- HTTP/1.x browsers use about 6 parallel connections per host ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Connection_management_in_HTTP_1.x)).
  - HTTP/2 multiplexes, and domain sharding is "even detrimental" there.
  - RFC 9113 recommends `SETTINGS_MAX_CONCURRENT_STREAMS` ≥ 100 ([RFC 9113](https://www.rfc-editor.org/rfc/rfc9113.txt)). Check your actual CDN and storage ALPN.
- `fetch(url, { priority: 'low' | 'high' | 'auto' })`: Chrome 101, Firefox 132, Safari 17.2 ([BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Request.json)). Use `low` for speculative tiles. It's a hint, not a scheduler.
- **Speculation Rules** prefetch/prerender *documents*. They "don't handle subresource prefetches", for which `<link rel=prefetch>` is needed ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API)). They are irrelevant to in-page tile streaming.
- **Network adaptation.** `navigator.connection.effectiveType` is Chrome-only (`saveData` Chrome 65+) and the MDN example only disables a video preload on `slow-2g` ([BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/NetworkInformation.json), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API)). Safari has no support. Prefer measured throughput (time your own tile fetches) with `saveData` as an additional veto **[INFERENCE]**.
- **Abort semantics.**
  - `AbortController.abort()` aborts fetches, body consumption and streams ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)).
  - On HTTP/2 an abandoned stream is reset with `CANCEL`, "the stream is no longer needed" ([RFC 9113](https://www.rfc-editor.org/rfc/rfc9113.txt)), so aborts are cheap.
  - On HTTP/1.1 an abort closes the connection **[INFERENCE: not sourced]**. Prefer not aborting nearly-complete tiles, as 3DTilesRendererJS does.

### Recommendation for a ~100M-voxel-surface browser voxel world with a Vite site

- **Three priority classes** in one sorted queue, with a 6–12 request concurrency cap for HTTP/2 hosts and 6 for HTTP/1.1 **[INFERENCE]**:
  1. Tiles needed now (visible footprint at the target level).
  2. Coarse ancestors, so a placeholder always exists (Cesium's progressive-resolution idea).
  3. Speculative ring: one tile ring plus a ring ahead along the camera velocity vector, and the zoom-out ancestors (`low` priority).
- Within a class, order by projected size or distance to screen centre (Potree/Cesium). Defer edge tiles about 0.2 s after motion stops (foveated), and don't request tiles while the camera is moving fast (Cesium's `cullRequestsWhileMoving`).
- On "fly to X" (search or ward jump), prefetch the destination's footprint at its target level first (Cesium's `preloadFlightDestinations`). That is the biggest win for a Tokyo ward-picker.
- Abort queued-not-started tiles on view change; let in-flight tiles finish if >50% done **[INFERENCE]**.
- Cap total geometry bytes, and when over, raise τ (Cesium's `memoryAdjustedScreenSpaceError`) rather than stop rendering.
- Treat `saveData` as a veto on class 3.

## E. Sources

- https://raw.githubusercontent.com/protomaps/PMTiles/main/spec/v3/spec.md
- https://docs.protomaps.com/pmtiles/
- https://docs.protomaps.com/pmtiles/cloud-storage
- https://raw.githubusercontent.com/protomaps/PMTiles/main/js/src/index.ts
- https://raw.githubusercontent.com/CesiumGS/3d-tiles/main/specification/README.adoc
- https://raw.githubusercontent.com/CesiumGS/3d-tiles/main/specification/ImplicitTiling/README.adoc
- https://raw.githubusercontent.com/CesiumGS/cesium/main/packages/engine/Source/Scene/Cesium3DTile.js
- https://raw.githubusercontent.com/CesiumGS/cesium/main/packages/engine/Source/Scene/Cesium3DTileset.js
- https://raw.githubusercontent.com/CesiumGS/cesium/main/packages/engine/Source/Scene/Cesium3DTilesetBaseTraversal.js
- https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html
- https://cesium.com/learn/cesiumjs/ref-doc/RequestScheduler.html
- https://cesium.com/learn/cesiumjs/ref-doc/Request.html
- https://raw.githubusercontent.com/NASA-AMMOS/3DTilesRendererJS/master/README.md
- https://raw.githubusercontent.com/NASA-AMMOS/3DTilesRendererJS/master/src/three/renderer/tiles/TilesRenderer.js
- https://raw.githubusercontent.com/NASA-AMMOS/3DTilesRendererJS/master/src/core/renderer/tiles/TilesRendererBase.js
- https://raw.githubusercontent.com/NASA-AMMOS/3DTilesRendererJS/master/src/core/renderer/utilities/DownloadPriorityQueue.js
- https://developers.google.com/maps/documentation/tile/3d-tiles
- https://developers.google.com/maps/documentation/tile/create-renderer
- https://developers.google.com/maps/documentation/tile/policies
- https://minecraft.wiki/w/Region_file_format
- https://raw.githubusercontent.com/ephtracy/voxel-model/master/MagicaVoxel-file-format-vox.txt
- https://acko.net/blog/teardown-frame-teardown/
- https://juandiegomontoya.github.io/teardown_breakdown.html
- https://raw.githubusercontent.com/TTFH/Teardown-Converter/main/src/parser.cpp
- https://raw.githubusercontent.com/TTFH/Teardown-Converter/main/README.md
- https://zeux.io/2017/03/27/voxel-terrain-storage/
- https://github.com/louis-e/arnis/wiki/Codebase-Architecture-&-Workflow
- https://www.cg.tuwien.ac.at/research/publications/2016/SCHUETZ-2016-POT/SCHUETZ-2016-POT-thesis.pdf
- https://www.cg.tuwien.ac.at/research/publications/2016/SCHUETZ-2016-POT/
- https://gigavoxels.inria.fr/Publications/2009/CNLE09/
- https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry
- https://dl.acm.org/doi/10.1145/1186562.1015799
- https://exa.ai/library/publication/2s29jh4v1zg
- https://www.terathon.com/voxels/
- https://raw.githubusercontent.com/CesiumGS/quantized-mesh/master/README.md
- https://raw.githubusercontent.com/maplibre/maplibre-gl-js/main/src/tile/tile_manager.ts
- https://raw.githubusercontent.com/maplibre/maplibre-gl-js/main/src/ui/map.ts
- https://github.com/mapbox/mapbox-gl-native/pull/16179
- https://github.com/mapbox/mapbox-gl-js/issues/2826
- https://www.rfc-editor.org/rfc/rfc9110.txt
- https://www.rfc-editor.org/rfc/rfc9113.txt
- https://www.rfc-editor.org/rfc/rfc7932.txt
- https://fetch.spec.whatwg.org/
- https://w3c.github.io/ServiceWorker/
- https://compression.spec.whatwg.org/
- https://developers.cloudflare.com/cache/reference/range-requests/
- https://developers.cloudflare.com/speed/optimization/content/compression/
- https://raw.githubusercontent.com/facebook/zstd/dev/README.md
- https://vite.dev/guide/features.html#web-workers
- https://vite.dev/config/worker-options.md
- https://vite.dev/guide/assets.md
- https://vite.dev/guide/build.md
- https://vite.dev/config/build-options.md
- https://vite.dev/guide/env-and-mode.md
- https://rolldown.rs/reference/OutputOptions.codeSplitting.md
- https://rolldown.rs/reference/OutputOptions.manualChunks.md
- https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream
- https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
- https://developer.mozilla.org/en-US/docs/Web/API/AbortController
- https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback
- https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/postTask
- https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming
- https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongAnimationFrameTiming
- https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/modulepreload
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/prefetch
- https://developer.mozilla.org/en-US/docs/Web/API/Cache
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Connection_management_in_HTTP_1.x
- https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API
- https://developer.mozilla.org/en-US/docs/Web/API/Network_Information_API
- https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/DecompressionStream.json
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/http/headers/Content-Encoding.json
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/OffscreenCanvas.json
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/AbortSignal.json
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Window.json
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Scheduler.json
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/PerformanceLongTaskTiming.json
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/PerformanceLongAnimationFrameTiming.json
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/FileSystemFileHandle.json
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Performance.json
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Request.json
- https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/NetworkInformation.json
- https://developer.chrome.com/docs/workbox/modules/workbox-range-requests/
- https://threejs.org/docs/pages/BufferGeometry.html
- https://threejs.org/docs/pages/WebGLRenderer.html
- https://threejs.org/docs/pages/BatchedMesh.html
- https://threejs.org/docs/pages/BufferAttribute.html
- https://threejs.org/manual/pages/how-to-dispose-of-objects.html
- https://github.com/mrdoob/three.js/blob/dev/examples/webgl_worker_offscreencanvas.html
