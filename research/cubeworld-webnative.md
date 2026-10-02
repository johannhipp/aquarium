# Cubeworld: a smaller map and a web-native site

Round 20, part C. The question: shrink the streamed map a lot and make the site a plain static deploy (any CDN or Pages host, standard HTTP caching, offline after the first visit). Everything marked **measured** was run on this machine; **[not tested]** marks what could not be exercised here.

## 1. Result

| | before | after |
|---|---|---|
| Map archive, same chunks (levels 0-4 of the previous 16-ward build) | 103.6 MB (deflate-raw blobs) | 45.5 MB (-56 %, 2.28x) |
| Map archive as built now (18 wards, 16.4 x 12.8 km) | would be about 118 MB (the frame is 14 % larger) | 52.2 MB in four shard files of at most 16 MiB |
| Directory fetched at start | 1.30 MB (+ separate tables) | 498 KB, including the 27 KB codec tables |
| Chunk decode | inflate + run-length, 0.04-0.09 ms | static rANS, 0.09-0.23 ms (still far below meshing); `parseDirectory` 30 ms for 273 k slots |
| Bytes for the same views (Tatekawa close / mid / wide; increments after the home view, whose size the viewer changed meanwhile, so about) | about 181 / 278 / 152 KB | 91 / 134 / 79 KB |
| GPU bytes for the same views (close / mid) | 124 / 277 MB | 66 / 146 MB; pixel-identical |
| First frame, dev server (also reflects viewer changes) | 1.7 s | 0.28 s |
| Build time of `pack` | 61 s | 7 min (the coder is plain Python) |
| In git | no (gitignored, rebuilt) | yes: 52 MB, every file under 17 MB |

Decoded cells equal the old ones: 0 of 400 level-0 chunks differ, the few differences at levels 1-4 are chunks on the old frame's edge; the TypeScript decoder matches the Python reference on 1,616 chunks (every level). Three zoomed views render with 0 differing pixels between the float32 and the compacted attributes.

## 2. What was measured, and what was chosen

The data is 2.5D: 99 % of columns are one of eight shapes (ground only; ground + road / sidewalk / water; ground + building + roof; ...). At level 0 a chunk's 1,156 columns cost 397 bytes in the old format, 2.8 bits per column.

| Option | Result on real chunks | Verdict |
|---|---|---|
| Better general entropy coder on the old layout: brotli 11 / zstd 19 / lzma | 397 -> 373 / 381 / 395 B at L0; about -6 % at L1-L2 | Not worth a wasm decoder. The runtime only relies on `DecompressionStream` for deflate-raw; brotli or zstd would need a wasm decoder in the worker (I did not check whether newer browsers added brotli to `DecompressionStream`) |
| Planar layout (pattern, ground delta, building height streams) + deflate | 316 / 475 / 596 B at L0 / L1 / L2 (-24 to -31 %) | Works with the built-in decoder, but deflate cannot code below 1 bit per symbol |
| Static-table rANS over the same symbols, contexts from decoded neighbours | measured 161-176 / 272-289 / 341-372 B (-55 %) | **Chosen** |
| Mixed: tables adapted per chunk | no header-free start; a 400 B chunk cannot pay for learning | rejected |
| Drop the 1-cell padding ring (12.8 % of columns) | chunks could not be meshed alone; neighbours' edges are not available when a chunk arrives | rejected |
| Drop LOD levels | level 1 is 27 % of the bytes; removing it means 4x the quads at 2-4 m views | rejected |
| L0 predicted from L1 (hierarchical) | needs the parent before the child; the heights of a roof are not in the parent | not built |
| Vector footprints + heights instead of columns | a 10 x 10 m house is about 100 columns at about 1 bit each, a 6-vertex polygon is not much smaller | not built |
| Dedupe of identical chunks | 8 % of chunks, but with the new coder an empty or flat chunk is 7-30 bytes; dropping it made offsets implicit | dropped |

**Codec (`pipeline/cubeworld/stream_codec.py`, decoder `src/cubeworld/stream/format.ts`).** A chunk is its 34 x 34 columns in raster order. Per column: a pattern symbol (context: left, up, up-left equal to up, up-right equal to up); the ground height as a median-edge-detector residual (context: the two gradients and the pattern); the building height as "same as left / up / up-right" or a new value; trees, poles, decks and stacked roofs as an explicit run list. Values 0-11 are direct symbols, larger ones one symbol per power of two plus raw mantissa bits. Frequencies come from a training pass over every fourth supertile, are normalised to 4096, and ship inside `dir.bin` (86 KB raw, 27 KB deflated, one set per level 0-3 and one shared by 4-6). Why static: no per-chunk learning cost, no per-chunk header (3 bytes of version and height, 4 of coder state).

**Directory.** Offsets are no longer stored: chunks are written in a deterministic order (top levels coarse first, then supertile by supertile in Morton order, coarse levels first inside one), so `parseDirectory` regenerates the order and the offset is the running sum of the lengths. Only lengths and heights travel, as four byte planes, deflated. 1.30 MB -> 498 KB.

**Shards.** The archive is `chunks.<hash>-<n>.bin`, 16 MiB each (`shardBits` in the manifest); a chunk never straddles two, so file index = `offset >>> shardBits`. Reason: Cloudflare Pages refuses assets over 25 MiB, GitHub warns above 50 MiB and blocks above 100 MiB, and four files can be fetched in parallel. The worker groups a batch by shard and sends one range request each.

**GPU memory (`chunk.worker.ts compactAttribute`).** The mesher emits float32 everywhere; the true domains are tiny: position is integer grid coordinates (u16), uv and outline flags are 0/1 (u8), ambient occlusion takes the values k/3 and the lamp light is 0..1 (u8 normalised; k/3 is exact in 1/255 steps). `aInfo` stays float32 because its last component is a per-cube hash. 60 bytes per vertex became 30, about 118 B per quad including the index instead of about 252. Next step, not done: pack class, orientation and tip into one byte and the hash into another (needs a shader change), or draw one instance per quad (about 8-16 B per quad; the shader expands the corners).

## 3. Web-native checklist

**Hosting.**

| Host | Limits (source) | Range requests | Headers | Fit |
|---|---|---|---|---|
| GitHub Pages | site at most 1 GB, soft 100 GB per month, repo recommended under 1 GB; git blocks files over 100 MiB and warns over 50 MiB ([Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), [large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)) | **measured**: `206`, `Accept-Ranges: bytes` on a github.io site | fixed `Cache-Control: max-age=600`, cannot be changed | works; the app must be served from the domain root (see below) |
| Cloudflare Pages | 25 MiB per file, 20,000 files ([limits](https://developers.cloudflare.com/pages/platform/limits/)) | the Cache docs describe 206 for cached files ([range requests](https://developers.cloudflare.com/cache/reference/range-requests/)), but a Pages feature request for 206 on static assets was open without an answer ([workers-sdk #3861](https://github.com/cloudflare/workers-sdk/issues/3861)). **[not tested]** | `_headers` file (shipped in `public/_headers`) | shards fit the 25 MiB limit; test a range request first |
| Cloudflare R2 public bucket | no per-file limit | S3 semantics, ranges work | per-object `Cache-Control` | the safe home for the shards if Pages answers 200 to a range request; needs CORS for `Range` and the shards' origin set in `manifest.files` |

Check a deployment with `curl -s -o /dev/null -D - -r 0-99 https://<site>/stream/chunks.<hash>-0.bin`: it must say `206` and `Content-Range: bytes 0-99/...`. A `200` would make every chunk request download a whole 16 MiB shard (the worker tolerates it, slowly).

The app fetches `/stream/...`, `/places/...`, `/audio/...` with root-absolute paths (about a dozen sites in `src/`), so it must be served from a domain root: Cloudflare Pages, a GitHub user or organisation site, or a custom domain. A GitHub project site (`user.github.io/aquarium/`) would need those paths to go through `import.meta.env.BASE_URL`.

**Immutable hashed URLs.** Build output is hashed by Vite (`/assets/...`); the map files carry a content hash in their name (`chunks.<hash>-<n>.bin`, `dir.<hash>.bin`), `manifest.json` is the one mutable entry point. `public/_headers` marks hashed files `immutable` for a year and everything mutable `no-cache`. GitHub Pages ignores it; there the service worker's cache-first rule for hashed files does the job and the browser revalidates after 10 minutes with a cheap 304.

**Service worker (`public/sw.js`, `src/pwa.ts`).** Hand-rolled, no build step, production only (Vite dev serves source). The page tells the worker which same-origin files it loaded; hashed assets are cache-first, pages, json and audio network-first with the cached copy offline, `dir` cache-first, `manifest.json` network-first. Shard range requests are passed through, unless the whole shard was stored: `window.__downloadWorld()` (a console hook; the app has no text UI and nothing was added to it) stores the four shards (52 MB) and the worker then cuts ranges out of the stored file. A 206 is never cached. The chunk worker's own per-chunk cache (`stream-<hash>`) is untouched, and cache names here do not start with `stream-`. **Measured** in a production build: first visit caches 57 files, the page reloads offline from the cache, and an offline range request on a stored shard answers `206` with the right `Content-Range`. `manifest.webmanifest` and three pixel-art icons (the headphones fish) make it installable; installability itself was not exercised.

**First-load budget** (production build, gzip where noted): `index.html` + main bundle 578 kB (148 kB gzip) + CSS 16 kB (4 kB) + `chunk.worker` 122 kB + the cubeworld module 39 kB (15 kB) when the map is entered. Map data before the first frame: `manifest.json` 3 KB + `dir.bin` 498 KB + about 70-200 KB of chunks. The globe's own data (atlas 344 KB, `rivers.json` 52 KB, creatures) is separate. Audio loops are fetched when played (7 MB for the existing set, more for 20 places).

**Commit the data?** Yes, now: four shards of 16 MiB and one of 1.8 MB, 52 MB in all, each under GitHub's 50 MiB warning, so `git clone` + `npm run build` produces the whole site and CI needs no 25 GB download. The cost is that each rebuild (new hash) adds about 50 MB to history, so batch changes. Alternatives if that bites: Git LFS (bandwidth quota), a release asset or R2 (the manifest would list absolute shard URLs; the worker already takes full URLs), or `git filter-repo` on old hashes.

**One-command deploy.** Cloudflare Pages: `npm run build && npx wrangler pages deploy dist --project-name rivers` **[not tested: needs an account]**. GitHub Pages: a workflow with `actions/configure-pages`, `npm ci`, `npm run build`, `actions/upload-pages-artifact` (path `dist`) and `actions/deploy-pages`, on a user site or custom domain **[not written: the root-path constraint above decides the host first]**. `dist` is 60 MB (51 MB of it the map).

## 4. Rebuild

`research/cubeworld-streaming.md` section 9. `pack` trains the tables on every fourth supertile (95 s), encodes all 800 supertiles on 10 cores (about 5.5 min) and writes the shards, `dir`, `manifest.json`.
