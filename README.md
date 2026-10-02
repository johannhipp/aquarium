# Aquarium

The 233 longest river systems (233 = Fibonacci number closest to 200), pulled from
OpenStreetMap, rasterized to 1-bit bitmaps (black = river, white = everything else),
and wrapped onto a 3D globe that shows nothing but the rivers. On top sits a small
creature layer: twenty fish and aquatic animals, each tied to one of the rivers, shown as a
Game Boy–style index. Clicking one plays that river's soundscape and flies the globe there.
A wallet in the corner (unlocked by looking at five creatures) opens *cubeworld*: a voxel map of
Tokyo with five bookmarked places, which works the same way (see *Places on the Tokyo map*).

## Run

```sh
npm install
npm run dev          # drag to rotate, scroll/pinch to zoom
npm run build        # type-check + production build into dist/
```

If the browser would block audio, a pixel speaker with a sad face asks for one click first (see *Sound gate*); the `?` in the corner opens a picture of a fish bopping to music.
Then click a sprite at the bottom to hear its river and fly to it; click it again (or press
Esc) to stop. Dragging or zooming interrupts a flight.

## Rebuild the data

```sh
python3 pipeline/build_list.py 233   # ranking -> pipeline/rivers.json
python3 pipeline/fetch.py 233        # OSM centerlines -> pipeline/cache/geom/*.json (cached)
python3 pipeline/rasterize.py 233    # -> art/bitmaps/*.png (reference), public/atlas/*.png, public/rivers.json
```

Requires Python 3 with `requests`, `beautifulsoup4`, `lxml`, `Pillow`.

The creature assets have their own scripts (see *Creature layer* below):
`pipeline/build_prompts.py`, `creature_images.py`, `sprites.py` and `audio.py` (the last needs
`numpy`, `requests` and `ffmpeg`; downloads are cached in `pipeline/cache/audio`).

`pipeline/cache/` (~300 MB of downloaded OSM geometry, source recordings and raw image renders)
is not committed; the scripts above recreate it. Everything the app serves is committed under
`public/`, and the source art under `art/`.

## Choices

**Ranking.** Wikipedia's *List of river systems by length* (first length figure per row,
227 rivers >= 1000 km), topped up with the next-longest rivers from Wikidata (P2043).
Every linked segment of a system (e.g. Nile – White Nile – Kagera – Nyabarongo) is kept,
so the full flow path is mapped, not just the named main stem.

**OSM access: plain `requests` against the OSM API (+ Nominatim) and Pillow.** Each
segment's Wikidata item names its OSM relation (P402); `relation/<id>/full.json` from the
OSM API returns it with all member ways and nodes. Relations are walked to their way
members, skipping `tributary`/`spring`/`mouth` roles and keeping only centerline
`waterway=*` ways (no riverbank areas). Rivers without a P402 link are searched by name in
Nominatim (every Wikipedia title of the system, bounded to its Wikidata coordinate),
preferring a relation over loose ways. A short `EXTRA` table in `fetch.py` adds a few
hand-picked OSM ids where Wikidata only links the lower stem of a listed system (e.g. the
Caniapiscau for the Koksoak, the Alabama and Tombigbee for the Mobile, the Georgina for
Warburton Creek). Overpass was tried first and dropped: its tag lookups are global scans
that took minutes per river under load.
Alternatives considered:

- `osmnx` — wraps Overpass, but pulls in geopandas/GDAL and is graph/street oriented.
- `overpy` — thin Overpass client that materializes every node as a Python object; slow
  for relations like the Amazon with tens of thousands of nodes.
- `pyosmium` / `pyrosm` — PBF readers; would need the ~80 GB planet file for global rivers.

Raw JSON is the leanest path, and Pillow's 1-bit mode (`"1"`) writes true bitmaps.

**Bitmaps.** Local plate carrée per river, 0.0125° of latitude per pixel (~1.4 km),
x scaled by cos(mid-latitude) so pixels are near-square on the ground, 1 px stroke.
Gaps in the OSM line (ways usually stop at lakes and reservoirs) are bridged with
straight segments up to 1.5°, closest pieces first, so each river reads as one line.
The only encoded information is the flow line.

**Globe: three.js.** Thin WebGL layer, tree-shakeable, first-class in Vite, full control
over shaders. Babylon.js is a heavier game engine; CesiumJS/globe.gl/MapLibre bring an
Earth surface, imagery and tiling machinery that would only be switched off again.

Rendering: the bitmaps are shelf-packed into 4096² atlas pages uploaded as single-channel
`R8` textures. Each river is a lon/lat grid patch on the unit sphere textured with its
bitmap; patches on the same page are merged into one geometry, so the whole globe is a
handful of draw calls. White texels are discarded; black ones are drawn black. When
zoomed out, coverage is scaled by texels-per-pixel so mipmapped rivers stay ~1 px black;
when zoomed in, the bitmap is thresholded with screen-space AA. A depth-only sphere
(`colorWrite: false`) hides rivers on the far side without drawing any surface.

## Creature layer

Twenty fish and aquatic animals, each tied to one river. What the app reads lives under
`public/` and is validated on load (`src/data.ts`); everything that is only source material lives
under `art/` and never ships.

| file | content |
| --- | --- |
| `public/creatures/creatures.json` | per creature: `id`, `common`, `riverId`, `focus` `[lon, lat]` on that river, `soundKnown`, `sprite` |
| `public/creatures/<id>-gb.png` | 80x80 1-bit pixel sprite, derived from the photograph by `pipeline/sprites.py` |
| `public/creatures/river-names.json` | `riverId` → up to 3 `{lang, name}` in the local languages and native scripts (identical names after NFC + trim are shown once) |
| `public/creatures/extras/headphones-fish-gb.png` | the sprite in the `?` card |
| `public/audio/audio.json`, `audio/<id>.mp3` | one short seamless loop per creature (river sound, plus the animal's own sound where one is known), with per-layer credits |
| `art/creatures/<id>.png`, `creatures.full.json`, `style.json` | full-size photographs, the full records (scientific names, why, prompts) and the single prompt template all images share |
| `art/bitmaps/<id>.png` | the 233 per-river bitmaps from `rasterize.py` (reference output; the app loads the packed atlas instead) |

**The only text in the UI is the river names.** The index is a Game Boy-style select grid of the
twenty sprites (10 tiles a row on desktop, 6 on a phone, scrolling if it ever exceeds 40% of the
screen), pixelated and black and white (`image-rendering: pixelated`, 40 CSS px = one device pixel per
sprite pixel on a 2x screen). Creature names exist only as `aria-label`s. The selected tile is
pressed in and inverted, its sprite bobs in two steps and a Game Boy-style cursor blinks above it.
The grid is a compact overlay: the globe stays centred in the full window and the river a
flight ends on is centred on screen; the note sits above the index in z-order. After the flight the
note names the river in each local language beside a dot on the river; it follows the globe while
you drag or zoom and fades out when the river turns to the far side. The type follows
madebygray.co (Inter, `#0B0B0B`, muted greys), self-hosted through `@fontsource/inter` (weight 400
only, ~24 KB for Latin; other scripts are fetched only when a note needs them); scripts Inter lacks
(Devanagari, Bengali, Arabic, ...) fall back to the system font for the line's `lang`.

**Motion.** Tiles stagger in (28 ms apart, rise + sharpen); pressing a tile sinks it into its
shadow; names slip out of the dot one after another (origin-aware, 90 ms stagger) and leave
faster than they came (200 ms); the globe turn is an eased great-circle slerp of 2.4-3.3 s
that backs the camera off a little on long hops and settles at distance 1.8. With
`prefers-reduced-motion` the camera jumps, movement and blur go away, and only fades remain.

**Sound gate.** Browsers have no audio permission prompt; the gate is the autoplay policy. On
load `navigator.getAutoplayPolicy('mediaelement')` is read where it exists; elsewhere an unmuted
silent clip is played and a `NotAllowedError` means blocked. If audio is already allowed (a
permissive policy, or Chrome's media engagement score for the origin), no click is needed: a
pixel speaker with waves and a smile shows at once, holds about 2 s and fades. If it is
blocked, a modal (native `<dialog>`, inert page, focus trap, Esc does not dismiss it; globe
drag and wheel are switched off) shows a muted speaker and a sad face, as one big button. Its
click plays a silent clip and resumes a shared `AudioContext`, which records the user activation;
the icons crossfade to the speaker and smile, hold 2 s and fade, and the index appears. The icons are
hand-drawn pixel grids rendered as crisp SVG rects (`src/pixel.ts`), not glyphs; there is no text.

**Sound turned off later.** The same sad gate comes back, blocking the page until the click, and the
current track then fades back in where it stopped. Everything a page can observe counts: the
`AudioContext` leaving `running` (Safari reports `interrupted`) or refusing to resume; the Media
Session `pause`/`stop` actions (media keys, Control Center, lock screen; the session title is the
river's first native name and is only shown by the OS); a pause or mute of the silent, looping keep-alive
`<audio>` element that makes those controls route to this page; and re-probing autoplay when the tab
becomes visible again. Our own crossfades, deselecting, Esc and background-tab throttling do not count.
**Limits:** OS-level mute, hardware volume and the browser's tab-mute are not observable by a page, so
they cannot bring the gate back. Automated runs that mute elements themselves can add `?test` to the
URL to have muting ignored.

**The `?`.** A 7x8 pixel question mark in the top-right corner opens a card with
`creatures/extras/headphones-fish-gb.png`: a catfish with headphones bobbing at 110 BPM,
only up and down, snapped to whole sprite pixels in uneven steps that read as ease-in-out, with three
pixel music notes (hand-drawn grids at the sprite's pixel size) rising from its head and flickering
out, each starting on its own beat. A clipped inner frame keeps the fish and notes inside the card's
border at every frame. Reduced motion: the fish is still and the notes hang beside it. Clicking
outside the card (or Esc) closes it; there is no button and no text.

**Audio.** Web Audio, one `AudioContext`. A creature's track is fetched and decoded only when its
tile is hovered, focused or clicked (at most four decoded buffers are kept; nothing but `audio.json`
loads up front) and looped by an `AudioBufferSourceNode`, with crossfades as gain ramps (0.9 s in,
0.6 s out). The tracks carry a gapless MP3 header and no baked fades; `<audio loop>` was measured
leaving a ~20 ms hole at each wrap, the buffer loop shows none.

**Performance.** The render loop draws only when the camera moved (a drag, damping, a
flight) or the window resized; the page geometry is built once, and a click only moves the
camera and a DOM node. First load (production build, cold cache, Chrome): see *Payload* below.

### Payload

First load of `vite build` served by `vite preview`, transferred bytes, no cache: HTML, CSS and JS
~143 KB (three.js dominates; only `OrbitControls` is imported from addons), the five 4096² atlas pages
~335 KB (1-bit PNG), `rivers.json` 15 KB, `creatures.json` 3.5 KB, `river-names.json`, `audio.json`,
twenty 340-byte sprites. No audio, no full-size image and none of the 233 per-river bitmaps is fetched.

### Credits

Images were generated with an image model from the shared prompt in
`art/creatures/style.json` (look: flash-lit, cold-graded analog scan after the Essential
Textures photographs of madebygray.co; no text in the images), finished by
`pipeline/creature_images.py` and reduced to sprites by `pipeline/sprites.py`; both scripts
are deterministic.

Sounds are mixed by `pipeline/audio.py` from the recordings below (full per-layer notes in
`art/audio/credits.json`; the served `public/audio/audio.json` holds only file, duration and loop).
Creature layers exist only where the animal is known to make a sound; where no open recording of the species
exists, a close relative stands in and the note in `credits.json` says so. Attribution is required for the
CC BY (4.0 and 3.0) recordings. **The Irrawaddy dolphin bed is CC BY-NC-SA 3.0: that track is non-commercial
and share-alike, so the site cannot be used commercially with it unless that file is replaced.**

| creature | river layers | creature layer |
| --- | --- | --- |
| Dourada (goliath catfish) | [night_on_the_river.WAV](https://freesound.org/people/WilliamDauricio/sounds/658081/) by WilliamDauricio (CC BY 4.0); [Amazon River Cargo Boat- Water against Hull](https://freesound.org/people/edfrederick/sounds/871472/) by edfrederick (CC0 1.0) | none |
| Ganges river dolphin (susu) | [BR_049_India_GangesRiver.mp3](https://freesound.org/people/kevp888/sounds/578754/) by kevp888 (Kevin Luce) (CC BY 4.0); [BR_041_India_GangesRiver.mp3](https://freesound.org/people/kevp888/sounds/578753/) by kevp888 (Kevin Luce) (CC BY 4.0) | [Amazonian Dolphins](https://freesound.org/people/felix.blume/sounds/408555/) by Felix Blume (CC0 1.0) |
| Chinook salmon (king salmon) | [Yukon River by KDCC - with drumming](https://freesound.org/people/SoundsLikeYukon/sounds/865260/) by SoundsLikeYukon (CC0 1.0); [Raven pair on Yukon River bank](https://freesound.org/people/SoundsLikeYukon/sounds/824995/) by SoundsLikeYukon (CC0 1.0); [Alder Flycatchers Yukon River](https://commons.wikimedia.org/wiki/File:Alder_Flycatchers_Yukon_River.ogg) by National Park Service (Public domain (US National Park Service)) | none |
| Beluga sturgeon | [Volga River](https://freesound.org/people/Agnivolok/sounds/840824/) by Agnivolok (CC0 1.0) | none |
| Bull shark (Zambezi shark) | [Vic Falls.mp3](https://freesound.org/people/toadie/sounds/194869/) by toadie (CC0 1.0); [hippos.mp3](https://freesound.org/people/toadie/sounds/194870/) by toadie (CC0 1.0); [hippos 2.mp3](https://freesound.org/people/toadie/sounds/194871/) by toadie (CC0 1.0) | none |
| Yangtze finless porpoise | [Yangtze river.wav](https://freesound.org/people/gamma1/sounds/328088/) by gamma1 (CC0 1.0) | [Atlantic Spotted Dolphins off the coast of La Gomera, Canary Islands](https://freesound.org/people/geraldfiebig/sounds/385796/) by geraldfiebig (CC0 1.0) |
| American paddlefish | [RiverWavesLappingBargeJune22012.wav](https://freesound.org/people/kvgarlic/sounds/157370/) by kvgarlic (CC0 1.0); [River flow bubbling with a bird singing behind](https://freesound.org/people/felix.blume/sounds/655508/) by Felix Blume (CC0 1.0) | none |
| Mekong giant catfish | [Mekong River, Vientiane, Laos - Mekong River, early morning 1](https://archive.org/details/aporee_39453_45100) by lastpedestrian (radio aporee) (CC BY 3.0); [20140212 - Chiang Rai mountains and river at night 01.wav](https://freesound.org/people/LG/sounds/345144/) by LG (CC BY 4.0); [DonDetLaosjungleambience](https://freesound.org/people/hopflog/sounds/752783/) by hopflog (CC0 1.0) | none |
| Irrawaddy dolphin | [Region de Magway, Myanmar - BINAURAL cruise on Irrawaddy river](https://archive.org/details/aporee_23701_27551) by Espaces Sonores // Stephane MARIN (radio aporee) (CC BY-NC-SA 3.0 (non-commercial, share-alike)) | [Dolphin screaming underwater in Caribbean Sea (Mexico)](https://freesound.org/people/felix.blume/sounds/161691/) by Felix Blume (CC0 1.0) |
| Amazon river dolphin (boto) | [water_running_under_the_bridge.WAV](https://freesound.org/people/WilliamDauricio/sounds/658073/) by WilliamDauricio (CC BY 4.0); [Olho d'agua em igarape, grilos e cigarras](https://freesound.org/people/jose.viana/sounds/667363/) by Jose Viana (Banco Sonoro Amazonico) (CC BY 4.0) | [Amazonian Dolphins](https://freesound.org/people/felix.blume/sounds/408555/) by Felix Blume (CC0 1.0) |
| Amazonian manatee | [Dawn in a small village, in the Amazonian Rainforest](https://freesound.org/people/felix.blume/sounds/510179/) by Felix Blume (CC0 1.0); [Olho d'agua em igarape, grilos e cigarras](https://freesound.org/people/jose.viana/sounds/667363/) by Jose Viana (Banco Sonoro Amazonico) (CC BY 4.0) | none |
| Arapaima (pirarucu) | [frogs_insects_night.WAV](https://freesound.org/people/WilliamDauricio/sounds/659690/) by WilliamDauricio (CC BY 4.0); [Olho d'agua em igarape, grilos e cigarras](https://freesound.org/people/jose.viana/sounds/667363/) by Jose Viana (Banco Sonoro Amazonico) (CC BY 4.0) | none |
| European eel | [River Elbe near Hamburg](https://freesound.org/people/inchadney/sounds/75977/) by inchadney (CC BY 4.0); [Elbe near Ovelgoenne](https://freesound.org/people/inchadney/sounds/75962/) by inchadney (CC BY 4.0) | none |
| Atlantic salmon | [37000 Tours, France - Loire river](https://archive.org/details/aporee_37640_43094) by Vincent Duseigne (radio aporee) (CC BY 3.0); [River Loire.wav](https://freesound.org/people/L.Finck/sounds/653535/) by L.Finck (CC0 1.0) | none |
| Pacific lamprey | [WavesOnTheShore.wav](https://freesound.org/people/richardemoore/sounds/260263/) by richardemoore (CC0 1.0); [river and travel sounds.wav](https://freesound.org/people/aaronhahnmedia/sounds/178652/) by aaronhahnmedia (CC0 1.0) | none |
| Murray cod | [Flowing River Cathedral Ranges](https://freesound.org/people/Sassaby/sounds/427878/) by Sassaby (CC0 1.0); [Jacinta Cain Atmos](https://freesound.org/people/kangaroovindaloo/sounds/193483/) by kangaroovindaloo (CC BY 4.0) | none |
| Goliath tigerfish | [Descente de l'eau au pont tshopo](https://commons.wikimedia.org/wiki/File:Descente_de_l%27eau_au_pont_tshopo.webm) by Yannick Ikombe (CC0 1.0); [Pont de la snel tshopo](https://commons.wikimedia.org/wiki/File:Pont_de_la_snel_tshopo.webm) by Yannick Ikombe (CC0 1.0); [Pont tshopo kisangani](https://commons.wikimedia.org/wiki/File:Pont_tshopo_kisangani.webm) by Yannick Ikombe (CC0 1.0) | none |
| Golden dorado (river tiger) | [20160308_14.iguazu.waterfall.flac](https://freesound.org/people/dobroide/sounds/339795/) by dobroide (CC BY 4.0) | none |
| Gharial | [River side ambience in India, water flowing, birds, breeze](https://freesound.org/people/seventhsamurai/sounds/332419/) by seventhsamurai (CC0 1.0) | [Alligator (Everglades NP)](https://www.nps.gov/subjects/sound/sounds-alligator.htm) by National Park Service (Public domain (US National Park Service work)); [Female alligator bellow and juveniles answer, SMNWR](https://freesound.org/people/KevinSonger/sounds/689966/) by Kevin Songer (CC BY 4.0) |
| Nile crocodile | [SFX_Ext_Water_Irrigation System_Nile River_Aswan_Egypt](https://freesound.org/people/SolySombraRecordings/sounds/736706/) by SolySombraRecordings (CC BY 4.0); [elephantine_island_frogs.wav](https://freesound.org/people/wjoojoo/sounds/472818/) by wjoojoo (CC BY 4.0) | [Supplementary Audio 1: juvenile Nile crocodile calls](https://www.nature.com/articles/srep15547) by Chabert, Mathevon et al. (Scientific Reports 5:15547, 2015) (CC BY 4.0) |

River names are native-language names of the rivers as used along them (e.g. Amazon:
Portuguese, Spanish, Quechua; Ganges: Hindi, Bengali, Urdu).

## Places on the Tokyo map

*Cubeworld* (the cube in the wallet) is a streamed voxel map of Tokyo drawn in the `foam` palette
(`src/cubeworld/palettes.ts`). It has its own index of five places the author bookmarked, in the same
look and with the same behaviour as the creature index: click a sprite and its recording crossfades in
(same player, same sound gate and sound-loss rules) while the camera hops there (zoom out, glide, zoom
in, with the destination's chunks fetched along the path); when it lands, the place's Japanese name
appears in the same note component beside a dot on the spot. Click it again, or press Esc, to stop.
No other text is drawn. The fish-to-cube iris transition and the `?` are unchanged; the map and its
data are only fetched when the cube is entered (`import('./cubeworld')`, then the module worker and
range requests into `public/stream/`).

| id | place | where |
| --- | --- | --- |
| `imakatsu-roppongi` | Imakatsu Roppongi, tonkatsu | Roppongi |
| `teamlab-borderless` | teamLab Borderless, digital art museum | Azabudai Hills |
| `perfect-beer-kitchen` | Perfect Beer Kitchen, craft beer bar | Shimbashi |
| `aoyama-tunnel` | Aoyama Tunnel, bar | Aoyama (Shibuya 4-chome) |
| `sushidokoro-unitora` | Sushidokoro Unitora, sushi | Tsukiji |

Tsukiji is Chuo-ku, but the PLATEAU Minato-ku data reaches across the ward line and renders
buildings and streets there, so it needed no fallback (`jinza-udon-shimbashi`, Shiodome, was prepared
as one and is not shown). Aoyama Tunnel sits about 1 km inside the western edge of the data.

| file | content |
| --- | --- |
| `public/places/places.json` | per place: `id`, `name`, `kind`, `address`, `lat`, `lon`, `epsg6677` `[E, N]` (the map's native plane coordinates), `sprite`; the last entry carries the unused `fallback` |
| `public/places/<id>-gb.png` | 80x80 1-bit sprite, same style template and `pipeline/sprites.py` as the creatures |
| `public/places/place-names.json` | `id` → `{lang, name}`: the name as on the shop's signage / Tabelog (second entry only when the brand is written in Latin) |
| `public/audio/places/<id>.mp3`, `audio.json` key `place:<id>` | one 18 s seamless loop per place, the same encoding as the creatures |
| `art/places/` | full-size images and `places.full.json` (not served) |
| `public/stream/` | the map: `manifest.json`, `dir.<hash>.bin`, `chunks.<hash>.bin` |

**The map data.** PLATEAU 3D city model, FY2025, 16 central wards from Setagaya (Shimokitazawa) to Koto
and Sumida (Morishita, Kinshicho, Tatekawa), a 16.4 x 11.3 km frame (CityGML 2.0): buildings LOD1-3 (LOD2/3 in the centre, LOD1 in the
west), roads LOD1-3 (carriageway, sidewalk, island), city furniture and vegetation (poles and trees where
the wards publish them, Shimbashi/Toranomon), bridges, water, and the DEM TIN. The 104 MB `chunks.<hash>.bin`
is not in git: rebuild it with `pipeline/cubeworld/stream_build.py` (`research/cubeworld-streaming.md`, section 9;
the area is `pipeline/cubeworld/stream_area.json`). The script fetches
only the needed CityGML members by HTTP range request, rasterises 1 m layers, and packs a 7-level
pyramid (1, 2, 4, 8, 16, 32, 64 m cubes) of 32x32-column chunks, run-length encoded and `deflate-raw`
compressed, into one range-readable `chunks.<hash>.bin` plus a directory. The viewer (`src/cubeworld/stream/`)
picks levels by on-screen cube size, draws a coarser stand-in until all children of a chunk are ready,
prefetches along the flight path, caches chunks in Cache Storage (and warms the five destinations at
idle), and keeps GPU memory under a budget. Rebuild and measurements: `pipeline/cubeworld/stream_build.py`
(docstring) and `research/cubeworld-streaming.md`. The dev-only page `stream.html` (`STREAM=1 vite build`
bundles it) shows the same map with theme buttons and the flight metrics.

**Integration.** `src/guide.ts` is the one place where an index, the player, a camera and the note meet; the
globe's creatures (`src/main.ts`) and the map's places (`src/cubeworld/mount.ts`) are each a guide with
their own stage (`globe.flyTo/project`, `cubeworld.flyTo/project`). Entering the other world puts a guide to
sleep (silence, note hidden, selection kept) and wakes the other, so returning resumes where you left.

### Place credits

Map: 出典：国土交通省 3D都市モデル（Project PLATEAU）東京都（千代田区・中央区・港区・新宿区・文京区・台東区・墨田区・江東区・品川区・目黒区・大田区・世田谷区・渋谷区・中野区・杉並区・江戸川区、令和7年度）を加工して作成 / Source: MLIT Project
PLATEAU, FY2025 3D city models of 16 Tokyo wards, processed into voxels (Public Data License v1.0, CC BY 4.0
compatible). The app draws no text but the place names, so this notice lives here and bottom-right on `stream.html`.
Place sprites were generated like the creatures' (see *Credits* above).

Place sounds are 18 s loops cut by `pipeline/audio.py` from YouTube recordings (downloaded with yt-dlp; per-layer
URLs, channels, licences and time ranges in `art/audio/credits.json`). **Only the teamLab loop is
Creative Commons (CC BY). The other four are under YouTube's standard licence: private prototype only, not
cleared for public release; replace them (or get permission) before the site goes public.**

| place | recording | licence |
| --- | --- | --- |
| teamLab Borderless | [Teamlab Borderless Tokyo Japan 2024 walkthrough](https://www.youtube.com/watch?v=_ExKTkNFepE) by Traveling with Sochi, inside the museum (waterfall room) | CC BY 3.0 (YouTube Creative Commons Attribution) |
| Perfect Beer Kitchen | room tone from two bar-hopping vlogs filmed in the shop: [なおたか酒場](https://www.youtube.com/watch?v=n3WFAKnQPsc), [PERFECT BEER](https://www.youtube.com/watch?v=pBzMJAJzEHc) | YouTube standard licence |
| Imakatsu Roppongi | dining room of the honten: [一口だけ東京](https://www.youtube.com/watch?v=xGjUPqv1VMc), [백백백 backback100](https://www.youtube.com/watch?v=WhHnreFxLEY) | YouTube standard licence |
| Sushidokoro Unitora | counter of the shop (then Tsukiji Itadori Bekkan): [MySX30](https://www.youtube.com/watch?v=JoORdqFUz7M) | YouTube standard licence |
| Aoyama Tunnel | **street fallback**, no usable interior recording exists: dusk traffic on Aoyama-dori near Miyamasuzaka, [akkz01](https://www.youtube.com/watch?v=1Wxz7KvrHrw) | YouTube standard licence |

Approximations are noted per place in `credits.json` (Imakatsu has no isolated fryer sizzle; the unused Jinza
Udon fallback loop comes from the shop's earlier location).

### Rebuilding the map data

```sh
V=pipeline/cache/cubeworld/venv/bin/python
$V pipeline/cubeworld/stream_build.py fetch     # PLATEAU CityGML members by HTTP range request
$V pipeline/cubeworld/stream_build.py prep      # DEM triangle caches + water triangles
$V pipeline/cubeworld/stream_build.py raster    # per-3rd-mesh tile layers
$V pipeline/cubeworld/stream_build.py merge     # global layers
$V pipeline/cubeworld/stream_build.py pack      # -> public/stream/
```
See the docstring of `stream_build.py` (it also covers the wider multi-ward frame) and
`research/cubeworld-streaming.md`. If `public/stream/chunks.*.bin` is not committed (it is large), `pack`
recreates it from the cached layers.
