# Cubeworld Japan: two or three streets in our cubes (investigation)

Status: investigation with runnable prototypes, nothing here is a production feature. Sections marked
`<!-- owner: ... -->` belong to the agent named; append under your own heading only.

<!-- owner: CubeWorld -->
## Summary and recommendation

**Short answer.** For two or three streets where you must tell streets, buildings, lamp posts and trees apart, the best result per hour of work is **PLATEAU LOD3 on a street inside one of its pockets** (we have Shimbashi): it is the only source with a real carriageway/sidewalk split, real poles and real trees, it is open for commercial use with a credit, and the converter already exists (`plateau_voxelize.py`, 8 s a box). It does not exist at your reference spot (奴坂): there PLATEAU is LOD1 only, so poles and trees have to be added.

1. **Streets and buildings anywhere in Japan, least work:** OSM + GSI DEM (`osm-yakkozaka`). 0.4 s, no download beyond one API call and a DEM tile. Footprints and streets are right; heights are guesses and trees and lamps are missing.
2. **Best at 奴坂 itself:** the composite `merged-yakkozaka`: PLATEAU measured heights, OSM streets, Arnis trees and lamps (trees and lamps are inferred). Zero hand work, 3 data sources.
3. **Ready-made, no code:** Arnis (`arnis-yakkozaka`): one binary, 14 s, gets buildings, roads, canopy trees and inferred lamps in one go; relief is its own scaling, so use it for look and feel, not for measured heights.
4. **Not worth it for a street scene:** aerial LiDAR (Tokyo): no poles, no facades, no road semantics, 113 MB per tile; mobile-mapping LiDAR has real poles but exists only in Shizuoka and as one corridor.
5. **Ruled out:** Google photorealistic 3D Tiles and Street View (policy).

**Does it read in our style?** At 160 m with 1 m cubes the iso view is dense but legible (roads dark, buildings white blocks with dotted walls, trees stipple, poles solid black). At the real 50 x 50 budget (`?scale=3`, about 3 m per cube) buildings, roads and trees still read and the pooled poles stay visible as black columns in the Shimbashi set, but narrow lanes and 1 m sidewalks thin out. So for a "few streets" world, keep 1 m cubes and stream a 3 x 3 chunk window rather than shrinking the whole area into one 50 x 50 block.

**Verify yourself** (dev server `npm run dev`, then open; every link is a different technique):

| What to look at | URL |
| --- | --- |
| OSM baseline | `http://localhost:5199/lab.html?v=osm-yakkozaka&zoom=2` |
| OSM vs Arnis (synced) | `http://localhost:5199/lab.html?v=osm-yakkozaka,arnis-yakkozaka&zoom=2` |
| PLATEAU vs LiDAR at 奴坂 | `http://localhost:5199/lab.html?v=plateau-yakkozaka,pointcloud-yakkozaka&zoom=2` |
| PLATEAU LOD3, real poles and trees (pooled to the 50 x 50 budget) | `http://localhost:5199/lab.html?v=plateau-shimbashi-lod3-cap18&scale=3&zoom=2` |
| Same, 1 m cubes | `http://localhost:5199/lab.html?v=plateau-shimbashi-lod3-cap18&zoom=2` |
| Composite at 奴坂 | `http://localhost:5199/lab.html?v=merged-yakkozaka&zoom=2` |
| How 1-cube poles and trees read (fabricated) | `http://localhost:5199/lab.html?v=osm-yakkozaka-synth&zoom=4` |
| Real LiDAR poles, a Shizuoka street | `http://localhost:5199/lab.html?v=pointcloud-numazu` |
| Pooled preview of anything | add `&scale=3`; add `&edges=cube` to outline every cube |

Screenshots: `research/img/` (`lab-*.webp` from the viewer, `plateau-*.webp` and the point-cloud ones from the other agents).

<!-- owner: CubeWorld -->
## Test area and lab

* **Area:** 160 x 160 m around 奴坂 Yakkozaka (Nominatim way 120481720, centre lat 35.65013, lon 139.73083), 南麻布三丁目, 港区 Tokyo, by Arisugawa Park: a dense low-rise residential slope. `public/lab/area.json` fixes it in EPSG:6677 (JGD2011 plane IX, x = easting, y = northing, SW corner x = -9362, y = -38891), 1 m cubes, dims 160 x 100 x 160. Voxel axes: x east, z south, y up.
* **Voxel file contract** (`public/lab/voxels/<id>.json` + `<id>.bin`): `bin` is `Uint8Array(nx*ny*nz)` indexed `x + nx*(z + nz*y)`; classes 0 air, 1 ground, 2 road, 3 sidewalk, 4 building wall, 5 roof, 6 vegetation, 7 pole, 8 water, 9 rail, 10 bridge, 11 other furniture, 12 wall/fence. The json carries source, licence, attribution, method, origin and per-class counts.
* **Lab viewer** (dev only, linked from nowhere; `npm run dev` then open):
  * `/lab.html?v=<id>` one dataset; `?v=a,b` side by side with the camera synced (drag, wheel, arrow keys move both);
  * `?scale=3` downsamples 3x with priority pooling (pole, furniture, fence, vegetation, roof, wall, bridge, rail, water, sidewalk, road, ground) so a 160 m area previews at 54 x 54 cubes, roughly the 50 x 50 budget;
  * `?zoom=z` start zoom; `?edges=cube` outlines every cube (default outlines only creases, steps and class borders, which keeps 160 m legible);
  * drag orbits, wheel zooms, arrow keys / WASD glide over the ground. One draw call, renders only on change (about 80k to 170k quads for these areas).
  * Looks per class (`src/cubeworld/mesh.ts` `STYLES`): road dark flat, sidewalk pale, building and roof white with dotted shaded walls and outlines, vegetation random stipple, pole solid black, water dashes, rail stripes.
* Production builds ship neither `lab.html` nor `public/lab` (about 20 MB of voxel files): `vite.config.ts` drops them; `LAB=1 npx vite build` includes the lab.

<!-- owner: CubeWorld -->
## Comparison table

Yakkozaka box (160 m, three streets, about 140 buildings). "Real" means observed or measured in that source for this spot; "inferred" means a rule or model placed it.

| Source (lab id) | Coverage | Streets | Buildings | Lamp posts | Trees | Licence | Effort |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OSM + GSI DEM (`osm-yakkozaka`) | All Japan | Good: 19 ways, widths by class; no sidewalk/carriageway split, only 1 `footway=sidewalk` | Good footprints; heights are guesses (1 of 143 has a tag) | None mapped (0) | None mapped (0), cemetery cover only | ODbL, credit "(c) OpenStreetMap contributors"; GSI attribution | Lowest: 0.4 s, 1 API call + 1 DEM tile (about 300 KB), 800 lines of Python (done) |
| OSM + fabricated furniture (`osm-yakkozaka-synth`) | n/a | as above | as above | **Fabricated** (12 cells) | **Fabricated** (65 trees) | as above | Only to judge how 1-cube poles and stipple trees read |
| Arnis (`arnis-yakkozaka`) | Anywhere OSM exists | Good, recognisable by block mix | OSM + Overture, default heights, stylised | Inferred: lamp stacks every 25 m on `lit=yes` ways (11 cells) | Inferred from the Meta canopy-height map (1.8k cells) | ODbL + Overture + Mapterhorn + canopy terms; Arnis Apache-2.0 | 14 s, one 59 MB binary and 170 lines to convert; no GIS code |
| PLATEAU in Yakkozaka (`plateau-yakkozaka`) | Minato-ku FY2025 (LOD1 here; LOD2/3 in pockets) | Real polygons (27), no sidewalk split, narrow lanes missing | **Measured heights**, LOD1 flat-top boxes | Absent (nearest 1.2 km) | Absent (nearest 2.3 km) | PDL 1.0, CC BY 4.0 compatible, commercial OK; credit MLIT PLATEAU | 350 lines Python; HTTP range reads into a 5.3 GB zip (about 5 MB + 21 MB DEM); 8 s per box |
| PLATEAU LOD3 pocket (`plateau-shimbashi-lod3`, `-cap18`) | Shimbashi/Toranomon pocket, 2 km away | **Carriageway 7.3k and sidewalk 4.3k cells** | 15 LOD3 + 48 LOD2 buildings | **Real: 91 pole features (856 cells)** | **Real: 41 trees + 38 plant covers (4.8k cells)** | as above | same scripts; about 50 MB download; the only fully real set |
| Tokyo aerial LiDAR + OSM (`pointcloud-yakkozaka`) | Tokyo 23 wards | OSM only | Real roof heights and shapes; OSM footprints | Absent (aerial 48 pts/m2 cannot resolve them) | Partial (24k cells, trunks synthesised) | CC BY 4.0 + ODbL | 113 MB zip tile, 2 s, laspy + numpy |
| Shizuoka mobile-mapping LiDAR (`pointcloud-numazu`) | Shizuoka only, a street corridor | No semantic classes (only height bins) | Facades real | **Real: 31 columns (about two thirds match real poles)** | Weak | CC BY 4.0 / ODbL | 610 MB zip per mesh, pole detector, one corridor |
| Google 3D Tiles / Street View | n/a | n/a | n/a | n/a | n/a | **Ruled out**: Map Tiles policy forbids derived geodata and object extraction | none |
| Composite (`merged-yakkozaka`) | Needs PLATEAU + OSM + Arnis for the spot | OSM over PLATEAU | PLATEAU measured | Inferred (Arnis) | Inferred (Arnis) | union of the above | 80 lines on top of the others |

Reading the table: **streets and buildings are cheap everywhere (OSM), measured heights need PLATEAU or LiDAR, and real lamp posts and trees exist only in a PLATEAU LOD3 pocket or in mobile-mapping LiDAR.**

<!-- owner: CubeWorld -->
## Baseline: OpenStreetMap 2.5D extrusion (`osm-yakkozaka`)

The cheapest baseline, built here from scratch (about 800 lines of Python including the shared helpers, no GIS stack beyond `pyproj`, `shapely`, `lxml`):

* Data: one call to `https://api.openstreetmap.org/api/0.6/map?bbox=` (Overpass also answered, the plain API is simpler and enough) cached in `pipeline/cache/lab/osm.xml`; terrain from GSI `dem5a_png` tiles (z15, one tile covers the box, about 3.9 m/pixel, 3x3 smoothed so 1 m cells are not terraced). Files: `pipeline/cubeworld/osm_fetch.py`, `osm_voxelize.py`, `labcommon.py` (shared helpers: area, transforms, DEM, voxel writer).
* Method: buildings are extruded footprints (flat roof at the lowest terrain under the footprint plus height, walls reach the terrain on the slope); roads are `highway` lines buffered by `width` or a class default (residential 5.5 m, alley 3.2 m, footway 1.5 m); sidewalks from `footway=*`; water from `natural=water`; vegetation only from `landuse` areas; poles from `highway=street_lamp` / `power=pole` / `man_made=utility_pole`; trees from `natural=tree`.
* Output: `osm-yakkozaka` (160 x 100 x 160, runs in about 0.4 s) and `osm-yakkozaka-synth`, which adds **fabricated** lamps (every ~25 m along `lit=yes` ways) and trees only so the viewer can show how 1-cube poles and tree stipple read. It is labelled as synthetic in its json.
* Findings in this box (about 160 m, three named streets: 奴坂, 阿衡坂, 薬園坂): 143 buildings of which **only 1 has a height tag** (`building:levels=2`), so 142 heights are guesses (apartments 15 m, school 9 m, others 6 or 9 m by a stable hash); **0 trees, 0 street lamps, 0 poles** are mapped; one pond; two cemeteries; roads and alleys are well mapped (19 highway ways; only one `footway=sidewalk`, and the residential ways tag `sidewalk=no`). Streets and building footprints are good; heights, trees and lamps are not.

<!-- owner: CubeWorld -->
## Ready-made OSM voxelizer: Arnis (`arnis-yakkozaka`)

[Arnis](https://github.com/louis-e/arnis) v3.2.0 (Apache-2.0, Rust, 18k stars, pushed the day I looked) takes `--bbox` and writes a Java-edition Minecraft world from OSM, Overture buildings, Mapterhorn elevation, ESA land cover and the Meta/WRI canopy-height map. I ran the macOS release binary (59 MB, no install) on the lab box twice (`--no-3d`, and `--mode terrain-only` to recover bare ground heights), read the region file with `anvil-parser2` and mapped block names to our classes.

* Run: `uv run --with anvil-parser2 --with numpy --with requests --with pyproj --with pillow python pipeline/cubeworld/arnis_voxelize.py --arnis /path/to/arnis-mac-universal` (about 14 s end to end, mostly network). Files: `pipeline/cubeworld/arnis_voxelize.py`, `arnis_decode.py`.
* Output: `public/lab/voxels/arnis-yakkozaka.{json,bin}`, 160 x 35 x 160, 1 block = 1 m, x east, z south (Minecraft's axes equal ours).
* What it got right with no extra work: **buildings** (OSM plus 3 Overture buildings that OSM lacks), **roads** (Arnis paints its asphalt mix `gray_concrete_powder` + `cyan_terracotta`, so roads are recognisable by block name), **footways/alleys** (`gray_concrete`), **trees from LiDAR-derived canopy data** (1,782 vegetation cells, not from OSM nodes), and **street lamps** (11 pole cells: Arnis puts a lamp stack of `smooth_stone`, wall, `redstone_lamp`, `iron_trapdoor` every 25 m along `lit=yes` ways, which is inference, not a mapped object).
* Caveats: block names are a lossy channel (alleys and footways share one block; building materials are random per house; `stone_bricks` is both paving and walls), so the classifier uses the terrain-only world to split ground from structures. The relief is Arnis' own scaling (8.9 m range fit, versus 14 m from GSI dem5a in the OSM baseline), so absolute heights are not comparable (`groundZ` is null). One fetch returned an HTTP 406 (Overture) and the run completed without it; the two runs differed by a few cells because of that.
* Dependencies and weight: downloads about 60 MB once, then needs network for the data fetches (Overpass proxy, elevation tiles, canopy tiles). No Rust build needed. Inherits ODbL (OSM) and the licences of Overture, Mapterhorn and the canopy data; Arnis itself is Apache-2.0.

<!-- owner: PlateauVoxels -->
## PLATEAU (MLIT open CityGML)

Outputs: `plateau-yakkozaka` (the test box), `plateau-shimbashi-lod3` (best-case ceiling, same data source, ~2 km away) and `plateau-shimbashi-lod3-cap18` (same, towers cut at 18 m so the street level is visible). Script: `pipeline/cubeworld/plateau_voxelize.py` + `plateau_citygml.py` (`plateau_topdown.py` writes a debug top view). Screenshots: `research/img/plateau-*.webp`.

### What PLATEAU has for the box

* **Datasets.** Catalog of every dataset with direct URLs: `https://api.plateau.reearth.io/datacatalog/plateau-datasets` (7,776 entries, 9 MB json); CKAN mirror `https://www.geospatial.jp/ckan/api/3/action/package_show?id=<name>`. Tokyo 23-ku as a whole is the 2020 dataset (`plateau-tokyo23ku`, spec v2, LOD1 everywhere, LOD2 only in a few central districts). **Minato-ku has its own, newer dataset: `plateau-13103-minato-ku-2025` (FY2025 / 令和7, spec v5, built by the Tokyo Metropolitan Government; the 2023 edition `-2023` is v4)** with bldg LOD0-3, tran LOD1-3, frn LOD1+3, veg LOD1+3, brid LOD1-3, wtr, luse, dem (TIN relief). Formats: CityGML zip (5.3 GB), 3D Tiles + MVT zip, and per-layer streaming tilesets/MVT in the catalog.
* **Mesh codes.** The box is in 3rd mesh **53393588** (north ~95 m) and **53393578** (south ~65 m); both inside 2nd mesh 533935 (the DEM is delivered per 2nd mesh, 484 MB unzipped for 533935). Files are `udx/<type>/<mesh>_<type>_6697_op.gml`.
* **What actually exists in the Yakkozaka box** (measured by parsing the files, not by the data sheet):

| layer | in box | notes |
|---|---|---|
| bldg | **LOD1 only**, 141 buildings | flat-top boxes with measured heights; nearest LOD2 buildings are **786 m** away, nearest LOD3 > 2.3 km (checked the 3 x 3 meshes around) |
| tran | **LOD1 only**, 27 road polygons | one polygon per road, flat (z = 0); **no carriageway / sidewalk split**; nearest LOD2 roads 406 m, LOD3 roads 804 m |
| dem | yes | TIN relief, 3,248 vertices in the box (about 2.8 m spacing), 13.4 to 28.3 m = 15 m of slope |
| frn (lamps, poles, signs) | **none** | nearest street furniture 1.16 km away |
| veg (trees) | **none** | nearest 2.3 km away |
| brid / wtr | none | |

* **Partial access that works.** The dataset zip supports HTTP range requests, so `remotezip` pulls single members: Yakkozaka = bldg 2.2 + 2.7 MB, tran 0.2 + 0.9 MB, dem 21 MB (all zipped), about 27 MB; the Shimbashi box = bldg 27 MB, tran 5 MB, frn 14 MB, veg 1 MB, brid 1 MB, dem 9 MB (the 3rd mesh is 1 km, so you pay for the whole mesh). Listing the zip's 57k entries takes 2 s. The per-layer 3D Tiles are finer: for the box, 9 tiles / 7.1 MB for bldg LOD1 and 11 tiles / 4.1 MB for bldg LOD2 (no terrain in them); the MVT road tiles are 297 kB (z16, LOD1) and 109 kB (z15, LOD2) per tile. I probed those sizes but did not build the voxel pipeline from tiles.

### Best-case area (LOD3 roads + street furniture + LOD3 trees)

Street furniture (frn, 10 meshes) and trees (veg, 5 meshes) exist only in a handful of meshes, so I downloaded all of those, plus bldg and tran for the four meshes around the densest furniture (53393598, 599, 690, 691), counted LOD2/3 buildings, LOD3 sidewalk polygons, poles, trees and furniture in sliding 160 m windows and picked the richest one that is not all towers: **Shimbashi / Toranomon side of Minato-ku (by coordinates; I did not check street names), mesh 53393690**, box SW = (-7200, -37280) in EPSG:6677, centre lat 35.66467, lon 139.75469 (about 2 km NE of Yakkozaka; not a residential street, an office district with a tree-lined avenue). LOD3 buildings were found only in meshes 53393599 (lat 35.658-35.667, lon 139.7375-139.75) and 53393690 among the meshes I checked; mesh 53393596 (about 2.6 km west) has hundreds of LOD3 furniture items and trees but no LOD3 buildings. Inside the box: 15 LOD3 + 48 LOD2 buildings (no LOD1), 205 road areas (86 LOD3, 119 LOD2) split into carriageway / sidewalk / island / planting strip, 91 poles and signals (lamps `4200`, roadside poles `4810`, signals `4900`), 41 solitary trees + 38 plant-cover patches, 101 fences, 112 other furniture (signs `3130/3150`, `9000`, ...), plus 209 flat items I skip (manholes, lane markings, drains). Tallest building 76 m above `groundZ` (`cap18` exists for that reason; Yakkozaka's tallest is 25 m).

### How I built it, versus the alternatives

| route | tried? | result |
|---|---|---|
| **own lxml + shapely parser** (`plateau_citygml.py`, 140 lines, + 330-line voxelizer) | **yes, used** | whole box in 2.8 s (cached DEM) to 8 s; keeps LOD, feature type, function codes and per-class control |
| **nusamai / PLATEAU GIS Converter** (`nusamai` v0.1.14, aarch64 binary, 7 MB, no install) | yes, one run: `nusamai --sink obj --epsg 6677 53393588_bldg_6697_op.gml` | converts the 44 MB mesh in 0.8 s, but writes **one merged OBJ per feature type, y-up and re-centred on the file's bounding-box centre** (I checked: x spans exactly ±574.79 m = half of the 1,149.6 m east extent), without feature ids, LOD choice or classes; you would have to recover the origin and still rasterise roads yourself. Great for visual conversion (glTF, 3D Tiles, GeoJSON, GPKG, even a `minecraft` sink), not for class-aware voxels |
| **plateau2minecraft** (MIT, Python) | README read only | 1 m blocks, **everything is `stone`**, LOD2 max (LOD3 ignored), hollow buildings, EPSG:3857, "bottoms not necessarily grounded", 2D roads sit at 0 m; I would have had to rewrite its voxelizer to keep classes, so I did not run it |
| 3D Tiles via `3d-tiles-renderer` / `py3dtiles` | sizes probed only | smallest download, but glb tiles need decoding and carry no terrain or road/sidewalk semantics beyond the layer split |

Voxelization (everything is 2.5D on purpose; `trimesh.voxelized().fill()` would only matter for arcades and overhangs, which 1 m cubes do not show):

* **Ground**: `dem` TIN vertices near the box → `scipy` `LinearNDInterpolator` at cell centres, filled solid below; the box minimum gives `groundZ` (Tokyo Peil metres; 13 m in Yakkozaka, 2 m in Shimbashi).
* **Roads**: polygons rasterised at cell centres (`shapely.contains_xy`) and written into the top ground voxel. A road's own LOD1 polygon is used only when it has no LOD2/3 `TrafficArea` children. `1000/1020` carriageway → road, `2000` sidewalk → sidewalk, auxiliary `3000` island → sidewalk, `5000-5020` planting → vegetation. LOD3 surfaces that float more than 2.5 m above the DEM would become class 10 decks (none in the boxes).
* **Buildings**: up-facing polygons of the highest LOD present (LOD1 solid top, LOD2/3 roof surfaces; plane fitted per polygon) → per-column z-buffer → column filled from the local terrain up to the roof, so buildings sit on the slope; the top voxel is class 5.
* **Poles / furniture / fences / bridges / trees**: polygon soup → earcut triangles → surface samples every 0.3 to 0.6 m → voxels. Lamps (`4200`), pole families (`4800-4840`), signals (`4900`), info boards and masts → class 7; fences (`2000`) → 12; signs, vending machines, mirrors, bus stops... → 11; trees and bridges are filled per column between their lowest and highest surface point.

### Results

| id | dims | cubes by class | time |
|---|---|---|---|
| `plateau-yakkozaka` | 160 x 100 x 160 | ground 265,671 (solid, includes slope), road 3,183, wall 98,895, roof 11,473; sidewalk, vegetation, pole, furniture, fence all **0** | 2.8 s (8.6 s first run incl. 6 s to parse the 484 MB DEM) |
| `plateau-shimbashi-lod3` | 160 x 100 x 160 | ground 4,200, road 7,344, sidewalk 4,251, wall 346,653, roof 8,943, vegetation 4,824, pole 856, furniture 220, fence 577 | 8.3 s (16 s with downloads) |

What it looks like in the lab viewer:

* **Yakkozaka** (`plateau-yakkozaka-iso.webp`, `-scale3.webp`, `-vs-pointcloud-vs-arnis.webp`): the street pattern, the building blocks and the 15 m slope are right; a top-down comparison with the OSM baseline shows the same streets and footprints cell for cell, with PLATEAU missing a couple of dead-end lanes and OSM missing a few buildings. Buildings are bare flat boxes with true heights (more trustworthy than the OSM guessed ones). There are no trees, no poles and one flat road colour, so it reads as "a model of a city district" rather than a lived-in street. At `?scale=3` (54 x 54 cubes) the main roads and block structure survive, narrow lanes break up.
* **Shimbashi LOD3** (`plateau-shimbashi-lod3-iso.webp`, `-cap18.webp`, `-cap18-scale3.webp`): streets, sidewalk bands, tree rows (stipple), 10 m solid-black poles and signals, fences and buildings with real roof steps are all distinguishable at 1 m. At `?scale=3` poles pool into 3 x 3 black slabs and the sidewalks thin out, but road, sidewalk, tree row and building still tell apart. This is the ceiling of what PLATEAU gives, and it is exactly what the Yakkozaka box lacks.

### Pitfalls

* **CRS and axis order**: CityGML is EPSG:6697 (JGD2011 geographic 3D) and `posList` is **lat lon height**; project with `Transformer.from_crs(6697, 6677, always_xy=True)` fed `(lon, lat)`. EPSG:6677 keeps GIS order (x = easting); the Japanese survey convention (x = north) is the other way round. Heights are orthometric (Tokyo Peil), identical across bldg, tran, dem and frn, so no geoid fix is needed.
* **2D roads vs 3D buildings**: LOD1 tran polygons and the LOD2 `TrafficArea` polygons all have z = 0 (plateau2minecraft warns the same); only LOD3 road surfaces carry heights. Always drape on the DEM.
* **Road-level LOD2/3 geometry is just xlink references** to the child `TrafficArea` polygons, so a naive reader sees empty geometry (cost me a debugging round); read the children instead.
* **Building bottoms**: LOD1 bottoms are not floating here: bottom minus DEM has median -0.34 m (p10 -1.85, p90 -0.12) in Yakkozaka and -0.13 m in Shimbashi, i.e. buildings are slightly sunk on slopes. Filling each column from the DEM to the roof removes any gap or float either way.
* **LOD mixing**: a mesh mixes LOD1, LOD2 and LOD3 buildings (331 of 5,211 buildings in the two Yakkozaka meshes are LOD2); pick the highest LOD per feature and do not use the data sheet's "LOD" list as coverage.
* **Files are big and mesh-sized**: 1 km buildings are up to 214 MB (Shimbashi), DEM 484 MB per 2nd mesh; always stream with `lxml.iterparse` and cache the DEM triangles (done). The codelists in the zip are not needed (nusamai only warns without them).
* Zip members are fetched by name through `remotezip`; the zip URL belongs to the CMS asset (`assets.cms.plateau.reearth.io/assets/ea/d75459-...`) and may change with a new dataset edition, look it up in the catalog.

### Licence and attribution

PLATEAU Site Policy, art. 3: content is usable under the **Public Data License v1.0 (PDL1.0)**, which MLIT states is **compatible with CC BY 4.0** (commercial use allowed, copyright held by the local government that built the data, here Tokyo Metropolitan Government / Minato-ku). Required: a source line, and a note when the data is edited/processed, and it must not look like an official MLIT product; some data derives from public surveys (測量法 restrictions, see the handbooks). Used string (also in each json):

> 出典：国土交通省 3D都市モデル（Project PLATEAU）東京都港区（令和7年度）(https://www.geospatial.jp/ckan/dataset/plateau-13103-minato-ku-2025) を加工して作成

### Effort and recommendation

* To reproduce for another box in Minato-ku: add a `Box(...)` line and run `plateau_voxelize.py <name>`; minutes, 5 to 50 MB of downloads. Writing it from scratch took me about 3 hours, of which most was finding out what exists where (the catalog and the zip listing made that cheap). Python deps: `numpy lxml pyproj shapely scipy mapbox-earcut remotezip` (no GDAL, no Rust). Other municipalities use the same file layout, but frn/veg/LOD3 exist only in selected areas, so check with the zip listing first.
* **Minimal-work recommendation**: use PLATEAU as the *backbone* (buildings with real heights, roads, true terrain) because it is free, tidy and a few seconds of Python away; it does not contain sidewalks, lamp posts or trees in a normal residential area such as Yakkozaka (it only does in LOD3 pockets such as Shimbashi), so those details must come from a second source (point cloud classification, OSM nodes, or hand placement) or be left out. If the user wants a showcase of "what the cubes can express" with streets, lamps, trees and buildings *from one open source*, `plateau-shimbashi-lod3-cap18` is the proof, but it is a business district, not a quiet slope.


<!-- owner: PointCloudVoxels -->
## Point clouds (Tokyo digital twin, Mapillary, OSM poles)

Outputs: `pointcloud-yakkozaka` (the test box, Tokyo aerial LiDAR + OSM), `pointcloud-shimbashi` (same recipe on PlateauVoxels' LOD3 best-case box, so the two can be compared side by side: `/lab.html?v=pointcloud-shimbashi,plateau-shimbashi-lod3`) and `pointcloud-numazu` (Shizuoka MMS street, **rotated corridor** 191 x 40 x 35, the only real poles). Scripts: `pipeline/cubeworld/pointcloud_tokyo.py [yakkozaka|shimbashi]`, `pointcloud_mms.py`, `pointcloud_streetlevel.py` (OSM counts, Mapillary), `pointcloud_preview.py` (matplotlib top/side check), shared `pointcloud_common.py`. Downloads land in `pipeline/cache/cubeworld/{tokyo,shizuoka}` (gitignored; zips + thinned crops 1.4 GB, the scripts re-extract the LAS on demand). Screenshots: `research/img/pointcloud-*.webp`. Every run takes about 2 s on the cached crop.

### Which open point clouds exist, and do they cover the box?

| dataset | what it is | covers Yakkozaka? | density | licence | format / classes | tile scheme and how to fetch |
|---|---|---|---|---|---|---|
| **Tokyo digital twin, 23-ku point cloud** ([catalog](https://catalog.data.metro.tokyo.lg.jp/dataset/t000029d0000000024), [G-Spatial mirror](https://www.geospatial.jp/ckan/dataset/tokyopc-23ku-2024)) | **aerial** LiDAR flown Mar-Apr 2023, released Oct 2024 | **yes**: mesh `09LD2796` holds the whole box | 16 pts/m² spec, **48 pts/m²** measured in the box (1.22 M points / 160 x 160 m, multi-strip) | CC BY 4.0, Tokyo Metropolitan Government | LAS 1.2, point format 3 (RGB, return numbers, intensity), EPSG:6677 (JGD2011 plane IX), classes **1 other, 2 ground, 3 other only**: no building, vegetation or pole classes | 1/2500-style meshes of about 400 x 300 m, one 100-400 MB zip per mesh (`09LD2796` = 113 MB, 208 MB LAS). The index is a public vector tile pyramid, `https://gic-tokyo.s3.ap-northeast-1.amazonaws.com/2024/dig/Vectortile/23ku/lp/{z}/{x}/{y}.pbf`; each feature has `MESH_NO` and a direct `URL` (`.../2024/dig/lp/<mesh>.zip`). No login, no key, `pointcloud_tokyo.meshes_for_box()` does the lookup. |
| Tokyo digital twin, 多摩 / 島しょ point cloud | same programme, other areas | no | similar | CC BY 4.0 | LAS | same scheme under other prefixes |
| **Tokyo, NTT East MMS** (data cooperation project, [page](https://info.tokyo-digitaltwin.metro.tokyo.lg.jp/kensyou_data_2024/)) | **mobile mapping** of roads for pole/cable maintenance | not downloadable | n/a | none | shown only in the Tokyo 3D viewer as a trial; the report itself lists occlusion by guardrails and street trees as a limit | nothing to download |
| Aero Asahi MMS (G-Spatial `mms`) | MMS, 900 pts/m², Olympic venues + Shuto expressway corridors | not on the slope | 900 pts/m² | **paid, 1,100 yen per 60 x 80 m, not open**, redistribution only as screen captures | LAS | purchase flow |
| MLIT xROAD / DRM association MMS | national road MMS | n/a | n/a | needs a signed licence with the DRM association | | not open |
| **VIRTUAL SHIZUOKA** ([Shizuoka Point Cloud DB](https://pointcloud.pref.shizuoka.jp/), [2019 Fuji SE / east Izu](https://www.geospatial.jp/ckan/dataset/shizuoka-2019-pointcloud), 2020 west Izu, 2021 Fuji + east, 2022 mid/west) | **aerial LiDAR + ALB + MMS + backpack + UAV**, whole prefecture | no (Shizuoka) | MMS **about 7,000 pts/m²** on the road (42.6 M points in 5,500 m² for one mesh) | CC BY 4.0 / ODbL dual licence | LAS 1.2 format 3 with RGB + intensity, EPSG:6676 (plane VIII). **MMS "Ground" meshes carry only height bins** (2 ground, 3, 4, 5 = low / mid / high above ground), no semantics | per-mesh zips of 3 MB to 3.6 GB. Index tiles, e.g. `https://gic-shizuoka.s3.ap-northeast-1.amazonaws.com/2020/Vectortile2025/MMS00/{z}/{x}/{y}.pbf`, each feature carries `URL` like `https://virtual-shizuoka.s3.ap-northeast-1.amazonaws.com/2019/MMS/Ground/08/NE/38/08NE3830.zip`. Travel tracks (`Traveltrack_R1.zip`, shapefile) show where the van drove. |
| Kanagawa 2019-2024, Hamamatsu | aerial (Kanagawa), MMS strips on trunk roads (Hamamatsu, [CC BY 2.1 JP](https://www.city.hamamatsu.shizuoka.jp/koho2/opendata/tengun.html)) | no | n/a | CC BY | LAS | not tried |

Net: **in Tokyo the only open cloud is aerial**, so there is no open MMS to turn into cubes at Yakkozaka. Open street-level LiDAR with real poles exists in Shizuoka (and some Hamamatsu roads), not in the user's reference area.

### Pipeline A: Tokyo aerial LiDAR + OSM (`pointcloud-yakkozaka`, `pointcloud-shimbashi`)

1. **Ground**: median of LAS class 2 per 1 m cell, holes (under buildings, pond) filled by linear then nearest interpolation, 3 x 3 median. Terrain 13 to 28 m high in the box, solid below the surface so the viewer shows a landscape, `groundZ` = 13.
2. **Buildings**: the cloud has no building class, so footprints come from OSM (142 in the box, aligned well enough). Each footprint cell is filled up to the 80th percentile height of the non-green points inside it (roofs measured, so pitched roofs and stairwell boxes stay), top layer = roof. Cells touching a footprint with tall points are snapped in (eaves, lean-tos).
3. **Vegetation**: per column, either green RGB, or 20+ points over 2+ height layers with 40 % non-last returns, 2 m away from walls. Wires (thin, 1 layer) are excluded this way; my first rule turned every overhead wire above a lane into a hedge. Canopy is filled down to 45 % of its height, one trunk column under each canopy maximum. The orthophoto colour is too flat for reliable green (5.6 % of points pass), so this is the weak part.
4. **Roads / sidewalks**: not from the cloud (aerial LiDAR sees asphalt and a garden path the same) but from OSM highway lines buffered by type (residential 5 m, alley 3.5 m, ...). Yakkozaka has no sidewalks anyway (`sidewalk=no` on every street that carries the tag).
5. **Poles: none emitted.** I tried a column isolation detector at 1 m and a 0.25 m / 0.5 m one. At 48 pts/m² a 0.3 m pole gives a handful of top hits; candidates were scattered over roofs and wires and could not be validated. Overhead wires do show as clean horizontal lines at 6 to 12 m in a vertical slice, so the information that poles exist is in there, but not the poles. Cars appear (parking lots, 907 furniture cells) and low walls/fences (3,327 wall cells).

Class counts: yakkozaka building 109,434, roof 14,091, vegetation 19,902, road 3,193, sidewalk 116, water 95 (pond), furniture 907, wall 3,327, **pole 0**. Shimbashi: building 370,157 (towers clipped at the 100 m box), vegetation 15,892, road 8,416, sidewalk 1,412, **pole 0**.

### Pipeline B: Shizuoka MMS street (`pointcloud-numazu`)

Mesh `08NE3830` (Numazu, about 35.0968 N 138.8517 E; I picked it because the zip is 610 MB, most meshes are 1.5 to 3.6 GB) holds one diagonal street with shopfronts, overhead wires, a crossing. 42.6 M points, thinned to every third. The corridor is 30 to 40 m wide and runs 190 m, so the voxel box is **rotated to the street** (`origin.rotationDeg` = -39.08, x along the street, z to its right) instead of padding a 160 m square with air.

1. DEM from class 2 (median per cell), terrain only within 4 m of seen ground.
2. **Poles** (the point of this source): 0.25 m x 0.5 m grid of non-ground points, a cell counts as pole-like when at most 9 of the 81 cells in a +-1 m window are occupied, a column needs 7 such layers between 1.5 and 8 m and a footprint of at most 40 cells (10 m²) and a top at 4 m or more. Result: **31 columns, 5 to 13.5 m** (235 pole cells). Overlaid on the raw cloud (`pipeline/cache/cubeworld/shizuoka/poles_check.png`) about two thirds sit on a visible pole (my count by eye, not against a surveyed list); the rest are facade corners and sign posts. Crossarms and wires near the top are not kept: a pole is a plain column to its measured top. Wires are dropped on purpose (1 cube thick lines are noise at this scale).
3. **Scatter index** (lambda_min / trace of the point covariance per 1 m voxel, about 0 for planes, 0.1 to 0.33 for foliage) finds trees because the MMS colours of street trees are grey and the green test finds almost none. 987 vegetation cells, mostly small street trees along the frontage.
4. **Buildings**: 3-D connected components of dense voxels (n >= 40 points) at least 4 m tall = facades, extruded to the OSM footprints they touch (the van sees only the street side and the lower storeys, so roofs and depth are inferred), topped with roof. Low components on the road/pavement = vehicles and signs (`furniture`, 75), elsewhere fences (`wall`, 384).
5. Roads and the 16 footways come from OSM again (no semantics in the LAS). Class counts: building 8,049, roof 718, road 1,817, sidewalk 443, vegetation 987, pole 235.

### Street-level detections as a pole layer

* **OSM** (counted with the OSM API `map` call, which works from here; Overpass answered 504 about half of the time):

  | box | `highway=street_lamp` | `power=pole` | `man_made=utility_pole` | `natural=tree` | `traffic_signals` | `crossing` | buildings |
  |---|---|---|---|---|---|---|---|
  | Yakkozaka 160 m | **0** | **0** | **0** | **0** | 2 | 4 | 142 |
  | Numazu corridor | 0 | 0 | 0 | 1 | 14 | 3 | 146 |

  A 1 km box around Yakkozaka also has 0 `power=pole` and 0 `utility_pole` (Overpass), and the whole of Minato-ku (Overpass area query) has 138 street lamps and 933 mapped trees. In Japan OSM street furniture is not mapped; only the traffic signals at junctions are. Not a pole source.
* **Mapillary** (CC BY-SA 4.0): the API is the right shape (`GET https://graph.mapillary.com/map_features?access_token=$TOKEN&fields=id,object_value,geometry,first_seen_at,last_seen_at&bbox=W,S,E,N&object_values=object--support--utility-pole,object--street-light`, bbox smaller than 0.01 deg², or the `mly_map_feature_point` vector tiles) but every request needs a token. I tested it without one: `{"error":{"message":"Invalid OAuth 2.0 Access Token","code":190}}`, and no token exists in this environment, so **no Mapillary numbers are reported and no data was faked**. To get a token: https://www.mapillary.com/dashboard/developers, register an application (free), copy the client token (`MLY|<id>|<hash>`), `export MAPILLARY_TOKEN=...`, `python pipeline/cubeworld/pointcloud_streetlevel.py mapillary` (default box = `area.json`). Its poles are positions only (no height, one point per pole), derived from images by a detector; detections are sparse where the Mapillary coverage is thin, so I expect a position layer to be the right size for one pole voxel column each but have not measured coverage.
* **Google Street View / Photorealistic 3D Tiles**: excluded by the Map Tiles policy (no extraction), see the summary.

### How things come out at 1 m and at the 50 x 50 budget

* **Streets**: 5 m lanes are 5 cubes at 1 m, about 1.5 at the 50 x 50 budget (`?scale=3`). They survive as a dark stripe because roads are painted on the ground cell, not extruded.
* **Buildings**: roofs and eaves are right at 1 m (aerial) or facades (MMS); at /3 they become blocky boxes but remain buildings. Facade detail (windows, shopfronts) is gone in both.
* **Poles**: a 0.3 m pole must become a **1 m column** to exist at all, and priority pooling then keeps it (`pointcloud-numazu` at /3 still shows black columns, now 3 cubes wide, with `scale3` screenshot). At 50 x 50 (`/3.2` for 160 m) a pole is a 3 to 4 m wide pillar, so a pole line reads as a fence of pillars: use it as a symbol, not as a measurement.
* **Trees**: aerial canopies read as stippled blobs at 1 m and as small lumps at /3; MMS trees are thin and half-synthesised.
* **Curbs**: a 15 cm curb is below one cube; kerbs are lost, the sidewalk/road split must come from a map layer (OSM or PLATEAU LOD3).

### Effort, tools, recommendation

* Tools: `laspy`, `lazrs` (installed but not needed: these LAS files are uncompressed), `numpy`, `scipy`, `shapely`, `pyproj`, `mapbox-vector-tile`, `mercantile`; no PDAL, CSF or open3d was needed (all a 2 s numpy job on the crop). Everything lives in a venv at `pipeline/cache/cubeworld/venv`.
* Tokyo aerial: one 113 MB zip per 400 x 300 m mesh (Shimbashi needed two), about 50 minutes of rule tuning once the data was in. Shizuoka MMS: 610 MB to 3.6 GB per mesh; about 2 h including the pole detector. Both are one-off scripts; not a service.
* **Recommendation**: do **not** build the pipeline on point clouds for the Yakkozaka area. Open Tokyo cloud is aerial, adds only measured roof heights, tree canopies and parked cars on top of what PLATEAU already provides, and its two best features (poles, curbs) are not in it. If real **lamp posts and poles** must be real, the only open path found is a **MMS street corridor from Shizuoka (or Hamamatsu)**, and that means choosing a Shizuoka street instead of 奴坂. If the user insists on Yakkozaka, use PLATEAU (or OSM) for the backbone, and place poles by hand from the street-level photos the user already has, or from a Mapillary token (a few hours) rather than derive them from LiDAR.


<!-- owner: CubeWorld -->
## Composite: best layer of each source (`merged-yakkozaka`)

`pipeline/cubeworld/merge_layers.py` (about 80 lines, numpy only) builds `merged-yakkozaka` from the other files, because they share one 160 m grid: **ground and buildings from PLATEAU** (measured LOD1 heights on the PLATEAU DEM), **road / sidewalk / pond painted from OSM** where PLATEAU has no building (OSM has the lanes PLATEAU's LOD1 roads lack), **trees and lamp posts from Arnis**, shifted in height to sit on the PLATEAU ground (1,712 vegetation and 11 pole cells). It runs in under a second and proves the pieces are interchangeable. What it cannot do: make the trees and lamps real (Arnis infers them from a canopy-height model and `lit=yes`), or add the sidewalk/carriageway split PLATEAU only has in LOD3 pockets. Open: `/lab.html?v=merged-yakkozaka&zoom=2`.

<!-- owner: CubeWorld -->
## Libraries and existing projects

Surveyed with the GitHub API on 2026-10-02 (stars, licence, last push are from there). "Tried" means I ran it for this investigation.

### Voxelizing meshes (when a source is a 3D model)

| Library | What it is | Verdict for us |
| --- | --- | --- |
| [trimesh](https://github.com/mikedh/trimesh) (MIT, 3.7k stars, active) | Python mesh library; `mesh.voxelized(pitch)` gives a surface occupancy grid, `.fill()` solidifies | Easiest Python route from OBJ/glTF/CityGML-derived meshes to a dense grid. Not needed so far: both PLATEAU and the point-cloud prototypes rasterise columns directly (a city is a height field, see below) |
| [Open3D](https://github.com/isl-org/Open3D) (14k stars, active, big dependency) | `VoxelGrid.create_from_triangle_mesh` and from point clouds | Heavier than trimesh; useful only for raw LiDAR clouds (it voxelizes point clouds directly) |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) (MIT, 3.5k stars, active) | The [`voxelize` example](https://github.com/gkjohnson/three-mesh-bvh/blob/master/example/voxelize.js) tests every cell with `bvh.intersectsBox` and a ray parity check for the inside | The way to voxelize **in the browser** from a glTF/3D Tiles mesh (needs a worker for 160^3 cells = 4M box tests); no pipeline step required if we pre-bake |
| [nusamai](https://github.com/MIERUNE/nusamai) (MIT, 103 stars, Rust, active) / [plateau-gis-converter](https://github.com/Project-PLATEAU/plateau-gis-converter) (GUI) | PLATEAU CityGML to 3D Tiles 1.1, MVT, GeoPackage, glTF | A converter, not a voxelizer, but it turns CityGML into glTF/3D Tiles that the above can ingest. Not needed when the CityGML is parsed directly (PlateauVoxels used lxml) |
| [plateau2minecraft](https://github.com/Project-PLATEAU/plateau2minecraft) (MIT, 85 stars, Python; forks exist) | MLIT's own CityGML to Minecraft converter: 1 m blocks, EPSG:3857, hollow buildings, everything is stone, LOD2 else LOD1, can add `tran`, `brid`, `frn`, `veg` | The reference for "PLATEAU as cubes". Single-material output means it can't tell roads from walls; its `anvil` + `voxelizer.py` are readable if we ever need a mesh voxelizer |
| [Arnis](https://github.com/louis-e/arnis) (Apache-2.0, 18k stars, Rust, very active) | OSM + elevation + Overture to a Minecraft world; CLI with `--bbox` | **Tried**, see the Arnis section: the least-effort OSM route, with real material semantics |
| [OSM2World](https://github.com/tordanik/OSM2World) (MIT, 784 stars, Java) | OSM to 3D models (OBJ/glTF) with detailed roofs, street lamps, trees | **Not tried** (needs a Java toolchain). Output is a mesh, so it would go through trimesh/three-mesh-bvh; worth a look if OSM remains the source and we want better roofs and furniture than Arnis |

### Reading 3D Tiles

| Library | What it is | Verdict for us |
| --- | --- | --- |
| [3d-tiles-renderer](https://github.com/NASA-AMMOS/3DTilesRendererJS) (NASA-AMMOS, Apache-2.0, 2.5k stars, active) | three.js renderer and loader for 3D Tiles (and the same family of plugins for Cesium ion, Google tiles) | The right client library if cubeworld ever streams PLATEAU tiles live. It is three.js-native like our app. (Its Google photorealistic plugin is off limits for us, see the policy note in the task) |
| [loaders.gl](https://github.com/visgl/loaders.gl) (visgl, 855 stars, licence field is mixed) | `Tiles3DLoader`, `MVTLoader`, LAS/PLY/glTF loaders | Handy for reading MVT and point clouds in JS; heavier than needed |
| [py3dtiles](https://github.com/VCityTeam/py3dtiles) (10 stars, licence not detected, last push 2025-07) | Python 3D Tiles reader/writer | Low activity; not recommended |

### What the survey says

* A Japanese street is a **height field with classified surfaces** (ground, road, sidewalk, buildings, trees), so column rasterisation (what all four prototypes do) beats general mesh voxelization: no inside/outside tests, no watertight meshes needed.
* No library solves "poles and trees at 1 m" by itself; that comes from the data (PLATEAU LOD3 `frn`/`veg`, Arnis' inference, or Mapillary/OSM points).
* Existing Minecraft-style tools (Arnis, plateau2minecraft) already encode the same idea we want, so the cheapest comparison is to read their output (anvil `.mca` regions, one block name per cell) and map names to our classes, which is what `arnis_voxelize.py` does.

<!-- owner: CubeWorld -->
## Limits and next steps

* **Everything shares one grid and one class table**, so layers can be mixed per cell (`merge_layers.py` does it in 80 lines). The remaining work for a real feature is choosing the streets, not inventing a format.
* **Not solved:** window-level detail, facades (aerial data sees none; PLATEAU LOD3 has them but we throw them away at 1 m), roofs other than flat boxes at LOD1, cars and people, and anything under tree canopy.
* **To verify before committing to a street:** that the chosen block really has the layers we need (PLATEAU: check the CityGML mesh codes for `frn`/`veg` and LOD2/3 buildings before downloading; point cloud: check the mesh exists), and attribution wording per source (each voxel json carries it; the app has no text, so the credit needs a home in the `?` dialog).
* **Suggested next step if you pick the Shimbashi route:** voxelize an actual 2-3 street corridor (not a 160 m square) from `plateau_voxelize.py`, pool it to the 50 x 50 x 100 world (about 3 m per cube, `?scale=3` is the preview) or keep 1 m cubes and stream 50 x 50 chunks (see `research/cubeworld.md` for the chunk plan).
* **Known weak spots of the lab itself:** the viewer is orthographic and iso only (no street-level camera). Pooling keeps thin classes alive (pole, furniture, fence, vegetation and sidewalk outrank road and ground), but a 1 m pole becomes a 3 m wide column at `?scale=3`, so pooled previews show where things are, not how thin they are.

<!-- owner: Palettes -->
## Visual styles

The dithered 1-bit look was busy (everywhere stipple, harsh black roads). Colour is now a **palette** (`src/cubeworld/palettes.ts`): per-class colours, per-face light, outline mode, sky, fog and a few extras. A palette never changes which cubes or quads exist: the mesh builder emits the same geometry for all five (Shimbashi: **183,500 cubes, 79,753 quads** in every style; `merged-yakkozaka`: 380,945 cubes, 82,870 quads). Everything stays in one merged geometry, vertex attributes and one shader:

* **Corner AO** from neighbour occupancy, computed in the mesh builder (`aAo`, quad split along the darker diagonal so no seams). Strength and tint are per palette.
* **Outlines in the fragment shader** (no line geometry): per palette none / every cube / only silhouettes and creases, with width, opacity and a tint mode. Roads never get lines, so a street stays one ribbon.
* **Extras by uniform:** depth fade to a haze colour, screen-space paper grain, a wall gradient towards the ground, wavy water bands, lit-window speckle hashed per cube, lamp tips with an additive halo and a pool of light baked per vertex, a 4-colour quantiser with 2 px pixel snapping.
* **Cost** (median of 5, 160 x 100 x 160 grids, desktop Chrome): mesh build 49-67 ms, night 95-99 ms (lamp-pool lighting); the world is **1 draw call**, plus 1 for the full-screen sky and, in the night style only, 1 for the halo sprites. About 160k triangles.

Open the lab with `?style=1..5` (id also works: `mono`, `gameboy`, `washi`, `night`, `foam`); keys **1-5** switch live, `?style=1,2` puts styles side by side, `?grid=1` shows all five in a 3+2 grid with synced cameras and a summary cell (keys 1-5 solo a style, 0 or G back to the grid). `?ui=0` hides the labels for screenshots, `?scale=3` previews the 50 x 50 budget. The main app's prototype world uses `PALETTE_ID` in `src/cubeworld/index.ts` (now `'foam'`: the heightfield reads as a white card model on the white-ish page, and its white sky blends into the iris transition).

| # | Style | Idea | Lab URL (Shimbashi, 1 m) | Images |
|---|-------|------|--------------------------|--------|
| 1 | **Refined mono** | The brand black and white, calmed: white sky, soft greys, strong AO, grey hairlines on silhouettes and creases only, mid-grey roads, near-black poles. | `/lab.html?v=plateau-shimbashi-lod3-cap18&zoom=2&style=1` | `research/img/palette-1-*.webp` |
| 2 | **Game Boy DMG** | Four olive greens (`#0f380f #306230 #8bac0f #cadc9f`), 2 px pixel snapping, 1 px hard outlines, no antialiasing. Classes pick a ramp step, walls step down with the light, AO only as a faint contact shadow. | `...&style=2` | `palette-2-*.webp` |
| 3 | **Washi & sumi** | Warm paper with grain and vignette, sumi-ink outlines and trees, indigo (藍) water and roofs, vermilion (朱) lamp tips as the one accent, wash gradient on the walls. | `...&style=3` | `palette-3-*.webp` |
| 4 | **Tokyo night** | Blue-black sky with stars and haze, dark towers with hash-lit windows, sodium-tinted roads, glowing lamp tips with halo and a light pool on the street, cool rim lines. | `...&style=4` | `palette-4-*.webp` |
| 5 | **Foam-core model** | White card blocks on a pale warm board, sage trees, light warm grey roads, soft AO, pencil edges (tinted lines), coral lamp pins as the one accent. | `...&style=5` | `palette-5-*.webp` |

For each style: `palette-<n>-shimbashi.webp` (1 m), `palette-<n>-shimbashi-scale3.webp` (`&scale=3`) and `palette-<n>-yakkozaka.webp` (`merged-yakkozaka`), all at the same camera (`zoom=2`, default heading). Contact sheet: `research/img/palettes-sheet.webp`. Grid: `/lab.html?v=plateau-shimbashi-lod3-cap18&zoom=2&grid=1`.

Notes: lamp halos and pools are authored in metres and shrink in cubes with `?scale=k` (`forCubeSize`), so the night style stays readable pooled. Poles are single-cube accents at 3 m cubes, so the accent colour shows on every pole there.
