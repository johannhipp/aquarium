# Cubeworld: a cube cityscape in the river-globe style (research only)

Status: nothing in here is built. The only code that exists is the terrain prototype in `src/cubeworld/` (50 x 50 x 100 voxel heightmap, one merged mesh, 1-bit shader). Claims marked **[INFERENCE]** are my estimates, not measured or sourced.

## 1. What the prototype already proves

Measured in headless Chrome (Metal, 1600 x 1000 canvas, 300 forced redraws with a 1-pixel `readPixels` sync after each):

| | Prototype terrain |
| --- | --- |
| Cells scanned | 50 x 50 x 100 = 250,000 |
| Cubes that exist | 55,360 |
| Quads / triangles after hidden-face culling | 13,466 / 26,932 |
| Draw calls | 1 |
| Geometry in memory | 1.7 MB |
| Terrain generation / mesh build (main thread) | ~2 ms / ~20 ms |
| GPU frame time (median / p95) | 0.6 ms / 1.1 ms |

The renderer only draws when the camera moves, like the globe. The edge lines and the black-and-white shading are computed in the fragment shader from per-face UVs and a screen-space Bayer matrix, so there is no line geometry. A city will have more faces than hills (facades), but the method scales: cost follows visible faces, not the 250k cells.

## 2. Scale: what one cube means

Pick the unit so that **1 cube = 1 floor of a building**.

* OSM's documented default for 3D renderings is 3 m per level when no height is given ([`building:levels`](https://wiki.openstreetmap.org/wiki/Key:building:levels)). I would use **4 m per cube** (3 m floor plus slab, and it divides cleanly into street widths).
* One 50 x 50 world is then **200 m x 200 m**, about two to four city blocks. A 100-cube ceiling is 400 m, above every building except a handful of supertalls.
* Streets of 12-20 m are 3-5 cubes wide and a 20 m building is 5 cubes: that is still readable in 1-bit.
* Coarser (10 m cubes) turns a house into a single cube; finer (2 m) makes a block 100 cubes wide and the 50 x 50 window too small to read as a city.
* One world is too small to be a city, so cubeworld must be a **grid of 50 x 50 chunks** around the viewer (section 6). 5 x 5 chunks is 1 km x 1 km.

## 3. Data sources

| Source | What you get | Fit |
| --- | --- | --- |
| **OSM via Overpass** ([Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)) | `way[building](bbox); out geom;` gives polygons with `height`, `min_height`, `building:levels`, `roof:*`, and `building:part` objects ([Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings)) | Best for an **offline bake** of a few cities. The public instances have a [usage policy](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html), and the OSMF says large or frequent users should use planet downloads ([API policy](https://operations.osmfoundation.org/policies/api/)). Do not call it from visitors' browsers. |
| **Protomaps / PMTiles** ([layers](https://docs.protomaps.com/basemaps/layers), [downloads](https://docs.protomaps.com/basemaps/downloads), [CLI](https://docs.protomaps.com/pmtiles/cli)) | `buildings` layer: z0-14 merged buildings, **z15+ individual OSM buildings**, with `height`, `min_height`, `kind=building_part`. `pmtiles extract planet.pmtiles city.pmtiles --bbox=...` cuts a city into one small static file | **Best runtime option for a static site**: ship a per-city `.pmtiles` next to the app, read it with HTTP range requests, no server. |
| **OpenFreeMap** ([quick start](https://openfreemap.org/quick_start/)) | Free hosted vector tiles in the OpenMapTiles schema, "no limits, no registration, no API keys"; the `building` layer carries `render_height`, `render_min_height` ([schema](https://openmaptiles.org/schema/#building)) | Fastest prototype (no hosting), but a donation-run public instance has no SLA. Fine for dev, mirror or extract for production. |
| **Overture Maps buildings** ([guide](https://docs.overturemaps.org/guides/buildings/), [schema](https://docs.overturemaps.org/schema/reference/buildings/building/)) | GeoParquet footprints with `height`, `num_floors`, parts (`has_parts`); each feature lists its `sources` | Good for a bake with DuckDB over the public release; merges OSM with other datasets, so check per-feature `sources` and the [licensing page](https://docs.overturemaps.org/) before shipping. |
| **City open data** (e.g. [NYC building footprints](https://data.cityofnewyork.us/City-Government/Building-Footprints/5zhs-2jue), [3D BAG](https://3dbag.nl/en/) for the Netherlands) | Measured heights, sometimes roof shapes (LoD1/LoD2) | Highest quality for one "hero" city; per-country licences, one adapter per source. |
| **Elevation** ([AWS terrain tiles](https://registry.opendata.aws/terrain-tiles/)) | Global heightmap tiles | Real ground height under the city (rivers, hills); the terrain code already takes a heightmap. |
| **Procedural** | Roads from a tensor field or grid, lots by subdivision, height from distance-to-centre plus the existing value noise | Needs no data and no attribution; deterministic from a seed; fallback for cities with poor OSM coverage. |

**Heights**, in priority order: `height` (m) / 4, else `building:levels` (+ roof levels), else Overture `height` / `num_floors`, else a default by `building=*` value (house 2, apartments 5, commercial 4, industrial 2) **[INFERENCE]**, else sampled from the neighbourhood's distribution. OSM height coverage varies a lot between cities; measure the share of tagged buildings in the chosen bbox before committing **[INFERENCE: no figure checked]**.

**Licence**: OSM-derived data is ODbL and needs "(c) OpenStreetMap contributors". Our UI has almost no text, so the credit has to live in the `?` dialog or a pixel (c) mark. This is a design constraint to settle early.

## 4. Footprints to voxels

Treat the city as a **2.5D column world**, not a free 3D grid:

1. Project lon/lat to metres around the chunk origin (Web Mercator is fine at these sizes; scale by `cos(lat)`).
2. Rasterise each footprint polygon into the 50 x 50 grid (scanline even-odd fill, a cell is covered when at least half its area is). Thin buildings (< 4 m) would vanish otherwise: keep a one-cell minimum.
3. Fill the covered columns from `min_height` to `height` (cubes). `building:part` objects overwrite the main building per cell, which gives stepped towers and podiums for free.
4. Ground material per cell from landuse / road / water / park polygons: road = flat tone, park = sparse dots, water = the existing dashed-row pattern, and the river itself comes from `waterway` / `natural=water`.
5. Store per chunk **one height byte plus one material byte per column** (5 KB). Expand to the dense `Uint8Array(250,000)` only while meshing, which the current mesher already takes as input.

Not recommended: true 3D voxelisation of triangle meshes (triangle-box overlap tests, as with Google's photorealistic tiles). Their terms restrict that use, and a city of extruded footprints already matches the look.

Roofs: pitched roofs (`roof:shape`, `roof:height`) can be approximated with one or two stepped cubes; flat roofs are the default and read best in 1-bit.

## 5. Rendering at scale

* **Keep the culled, merged mesh, not instancing.** An instanced cube is 12 triangles each; a 250k-cell tile would be 3 M triangles. The measured prototype has 27k triangles for 55k cubes. Instancing only wins for many identical objects (trees, street furniture).
* **Per-chunk meshing in a Worker.** The 250k-cell scan took ~20 ms on the main thread, so it fits a worker that returns typed arrays (transferable) with no frame hitch. One draw call per chunk: 9-25 chunks is 9-25 calls.
* **Greedy merging with UV-repeat edges (later).** Merge coplanar faces of the same tone into long quads and let the shader draw edges from `fract(uv * span)`. It would cut triangles several-fold on tall facades **[INFERENCE: not measured]** at the cost of per-cube tone jitter, which I would drop or move into a hash of the cell.
* **LOD for distant chunks.** Downsample the height grid 2x (max-pool) for chunks beyond ring 1, so far geometry is a quarter of the faces. In orthographic view the screen size of a cube is constant, so LOD is about triangle count only.
* **Outlines.** The in-shader UV method costs nothing extra and stays crisp at 1 px; edges fade out below ~3 px per cube. Alternatives (depth/normal Sobel post-pass, back-face hull) cost an extra full-screen pass or doubled geometry and I see no reason to use them here.
* **Shimmer.** A screen-space Bayer dither swims while the view moves. Pixel-snapping the camera to dither cells or using a world-anchored pattern is the known fix **[INFERENCE: to test]**.

## 6. Streaming and arrow-key navigation

The controls already translate target and camera together relative to the camera's heading. Streaming adds:

* World coordinate to chunk id (`floor(x / 50)`, `floor(z / 50)`); keep a 3 x 3 ring loaded (5 x 5 if the view is zoomed out), evict the rest, and prefetch the next ring in the direction of travel.
* A city is a few km, 4 m cubes: coordinates stay below ~50,000, well inside float32 precision, so no floating origin is needed for one city.
* Ground height under the view (the `groundAt` already used for the camera) comes from the loaded chunk, with the same half-follow easing so hills do not swing the frame.
* Clamp movement to the city's bounds instead of the 50 x 50 box.
* Data per chunk: from a PMTiles extract this is a z15 tile decode (`@mapbox/vector-tile` + `pbf`, [vector-tile-js](https://github.com/mapbox/vector-tile-js)), a polygon rasterise, and a mesh build. Cache decoded height grids (5 KB each) in memory.

## 7. Tie-in with the river globe

Every creature already has a river and a focus point (`public/creatures/creatures.json`). Natural cities on those rivers:

| River | City candidates |
| --- | --- |
| Elbe | Hamburg |
| Loire | Orleans, Tours, Nantes |
| Columbia | Portland |
| Mississippi | St. Louis, Minneapolis |
| Yangtze | Wuhan, Nanjing |
| Volga | Volgograd |
| Ganges | Patna, Varanasi |
| Nile | Cairo, Luxor |
| Congo | Kinshasa |
| Parana / Rio de la Plata | Buenos Aires |
| Mekong | Vientiane |
| Amazon / Madeira | Manaus |
| Murray | (inland towns, no large city) |

Flow: on the globe, the creature's river is selected; choosing the cube opens the **nearest city on that river**, spawns at its lon/lat, and the river itself (OSM water polygons) becomes the dashed water cubes. The river's audio loop can keep playing there (today it is paused on entering cubeworld, see `src/transition.ts`). First city: **Hamburg** (a river through the centre, harbour and bridges give height variety and strong water shapes; OSM coverage is good **[INFERENCE]**), with Cairo/Nile as the contrast case.

## 8. Performance budgets

| Item | Budget |
| --- | --- |
| GPU frame | < 4 ms at 1600 x 1000 (60 fps with margin on an integrated GPU) |
| Visible triangles | < 1.5 M (prototype: 27k) **[INFERENCE: dense mid-rise chunks ~100-200k each]** |
| Draw calls | < 30 |
| Chunk build (worker) | < 30 ms, never on the main thread |
| Download per chunk | < 100 KB, first city < 1 MB total |
| Memory | < 50 MB for 25 chunks |
| Lazy JS | cubeworld is 7.4 kB (3.4 kB gzip) today; budget < 30 kB gzip including a decoder |

Render on demand stays: no frames when nothing moves.

## 9. Phased plan

0. **Done:** terrain prototype, wallet, iris transition, one-draw-call renderer.
1. **One baked city tile** (Overpass or Overture to `pipeline/city.py`, 4 m cells, 50 x 50 chunk files, heights+materials only), loaded instead of the noise terrain, with the credit in the `?` dialog. Exit: Hamburg centre renders, 1 cube = 1 floor.
2. **Chunk streaming:** worker meshing, 3 x 3 ring, arrow keys cross chunk borders, PMTiles extract (or OpenFreeMap during development) as the source.
3. **LOD and greedy merging**, shimmer fix, material patterns for roads, parks, water.
4. **Globe link:** pick a creature, open its river city; reuse the river audio loop; add 3-4 more cities.
5. **Polish:** roofs, bridges (`layer`, `bridge=yes`), landmarks.

## 10. Risks

* **Height data gaps** make skylines flat. Mitigation: type defaults, neighbourhood sampling, or a city with open LoD data.
* **Licensing and attribution** (ODbL, Overture sources) in a UI with no text. Decide before phase 1.
* **Tile hosting:** OpenFreeMap has no SLA and is donation-run; production should use our own PMTiles extract.
* **Readability:** at 4 m a block is ~20 cubes; if the 1-bit render turns to mush at the default zoom, use a coarser LOD at the start zoom or darker side tones (tuned once already on the terrain).
* **Dither shimmer and moire** on facades while moving.
* **Mobile GPUs:** the fragment shader uses `fwidth` per pixel on a full-screen mesh; test at device pixel ratio 3.
* **Scope:** real cities invite wanting roads, traffic and interiors; the plan stops at static, silent geometry.
