"""OSM 2.5D baseline: OSM XML + GSI DEM -> 1 m voxel grids of the lab area.

Usage (from project root)::

    python3 pipeline/cubeworld/osm_voxelize.py

Reads pipeline/cache/lab/osm.xml (fetched with osm_fetch.py if missing) and the GSI dem5a
tiles (fetched/cached by labcommon) and writes

    public/lab/voxels/osm-yakkozaka.{json,bin}        real OSM data only
    public/lab/voxels/osm-yakkozaka-synth.{json,bin}  + SYNTHETIC street lamps / trees (not real)

Method: terrain columns from the DEM (class 1, top cell takes the surface class), surface
classes painted with priority vegetation < water < sidewalk < rail < road < bridge, buildings
extruded (height tag, else building:levels*3, else default levels) from the terrain up to a flat
roof at round(min footprint ground - groundZ) + height. Classes: see labcommon.CLASS_NAMES.
"""
from __future__ import annotations

import math
import sys
import time
import zlib
from pathlib import Path

import numpy as np
import shapely
from lxml import etree
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import polygonize, unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
import labcommon as lc  # noqa: E402
from labcommon import (AIR, BRIDGE, GROUND, POLE, RAIL, ROAD, ROOF, SIDEWALK,  # noqa: E402
                       VEGETATION, WALL, WATER)
from osm_fetch import fetch_osm  # noqa: E402

SRC_ID = "osm-yakkozaka"
SYNTH_ID = "osm-yakkozaka-synth"

HIGHWAY_WIDTH = {
    "motorway": 12, "trunk": 10, "primary": 9, "secondary": 7, "tertiary": 7,
    "residential": 5.5, "unclassified": 5, "living_street": 4, "service": 3.2, "track": 3,
    "pedestrian": 3, "footway": 1.5, "path": 1.5, "steps": 1.5, "cycleway": 2, "bridleway": 1.5,
}
FOOT_CLASSES = {"footway", "path", "steps", "pedestrian", "cycleway", "bridleway"}
HIGHWAY_SKIP = {"proposed", "construction", "platform", "bus_stop", "street_lamp", "crossing",
                "traffic_signals", "stop", "give_way", "elevator", "corridor"}
VEG_LANDUSE = {"grass", "forest", "meadow", "village_green", "recreation_ground", "orchard"}
SPARSE_LANDUSE = {"cemetery", "religious"}  # class 6 on every 2nd cell (hashed)
VEG_NATURAL = {"wood", "scrub", "grassland", "heath"}
VEG_LEISURE = {"park", "garden"}
RAIL_TYPES = {"rail", "subway", "light_rail", "tram"}
POLE_TAGS = (("highway", "street_lamp"), ("power", "pole"), ("man_made", "utility_pole"))
POLE_HEIGHT = 6
SIDEWALK_W = 1.5


# ---------------------------------------------------------------- helpers

def num(s):
    """Parse '12', '12.5 m', '5,5' -> float, else None."""
    if s is None:
        return None
    import re
    m = re.match(r"\s*([0-9]+(?:[.,][0-9]+)?)", s)
    return float(m.group(1).replace(",", ".")) if m else None


def hash_uint(ix, iz, seed=0):
    """Deterministic 32-bit hash of integer cell coordinates (numpy, vectorised)."""
    h = (np.asarray(ix, np.uint64) * np.uint64(73856093)) ^ (np.asarray(iz, np.uint64) * np.uint64(19349663)) \
        ^ np.uint64((seed * 83492791) & 0xFFFFFFFF)
    m = np.uint64(0xFFFFFFFF)
    h &= m
    h ^= h >> np.uint64(13)
    h = (h * np.uint64(0x5BD1E995)) & m
    h ^= h >> np.uint64(15)
    return h


def fix(g):
    if g is None or g.is_empty:
        return None
    if not g.is_valid:
        g = shapely.make_valid(g)
    return None if g.is_empty else g


def polys_only(g):
    """Keep polygonal parts of any geometry (make_valid may return collections)."""
    if g is None:
        return None
    if g.geom_type in ("Polygon", "MultiPolygon"):
        return g
    parts = [p for p in getattr(g, "geoms", []) if p.geom_type in ("Polygon", "MultiPolygon")]
    return unary_union(parts) if parts else None


class Osm:
    def __init__(self, path):
        root = etree.parse(str(path)).getroot()
        ids, lons, lats = [], [], []
        for n in root.iterfind("node"):
            ids.append(int(n.get("id")))
            lons.append(float(n.get("lon")))
            lats.append(float(n.get("lat")))
        x, y = lc.lonlat_to_plane(np.array(lons), np.array(lats))
        self.nodes = {i: (float(a), float(b)) for i, a, b in zip(ids, x, y)}
        self.node_tags = {}
        for n in root.iterfind("node"):
            t = {k.get("k"): k.get("v") for k in n.iterfind("tag")}
            if t:
                self.node_tags[int(n.get("id"))] = t
        self.ways = {}
        for w in root.iterfind("way"):
            self.ways[int(w.get("id"))] = (
                [int(r.get("ref")) for r in w.iterfind("nd")],
                {k.get("k"): k.get("v") for k in w.iterfind("tag")},
            )
        self.rels = {}
        for r in root.iterfind("relation"):
            self.rels[int(r.get("id"))] = (
                [(m.get("type"), int(m.get("ref")), m.get("role")) for m in r.iterfind("member")],
                {k.get("k"): k.get("v") for k in r.iterfind("tag")},
            )

    def coords(self, wid):
        refs = self.ways[wid][0]
        return [self.nodes[r] for r in refs if r in self.nodes]

    def way_line(self, wid):
        c = self.coords(wid)
        return LineString(c) if len(c) >= 2 else None

    def way_polygon(self, wid):
        refs = self.ways[wid][0]
        c = self.coords(wid)
        if len(refs) < 4 or refs[0] != refs[-1] or len(c) < 4:
            return None
        return polys_only(fix(Polygon(c)))

    def multipolygon(self, rid):
        members, _ = self.rels[rid]

        def rings(role):
            lines = [self.way_line(ref) for t, ref, r in members
                     if t == "way" and r == role and ref in self.ways]
            lines = [l for l in lines if l is not None]
            if not lines:
                return None
            merged = shapely.line_merge(unary_union(lines))
            return unary_union(list(polygonize(list(getattr(merged, "geoms", [merged])))))

        outer = rings("outer")
        if outer is None or outer.is_empty:
            return None
        inner = rings("inner")
        g = outer.difference(inner) if inner is not None and not inner.is_empty else outer
        return polys_only(fix(g))


# ---------------------------------------------------------------- rasteriser

class Raster:
    def __init__(self, area):
        self.area = area
        self.E, self.N = lc.cell_centres(area)

    def window(self, geom):
        """Return (slice_z, slice_x, mask) for cell centres covered by geom (bbox-limited)."""
        a = self.area
        minx, miny, maxx, maxy = geom.bounds
        x0 = max(0, int(math.floor(minx - a.sw_x)) - 1)
        x1 = min(a.nx, int(math.ceil(maxx - a.sw_x)) + 1)
        z0 = max(0, int(math.floor(a.sw_y + a.size_m - maxy)) - 1)
        z1 = min(a.nz, int(math.ceil(a.sw_y + a.size_m - miny)) + 1)
        if x1 <= x0 or z1 <= z0:
            return None
        sz, sx = slice(z0, z1), slice(x0, x1)
        return sz, sx, self.E[sz, sx], self.N[sz, sx]

    def cover(self, geom, centre_inside=False):
        w = self.window(geom)
        if w is None:
            return None
        sz, sx, E, N = w
        m = shapely.contains_xy(geom, E, N) if centre_inside else shapely.intersects_xy(geom, E, N)
        return sz, sx, m


# ---------------------------------------------------------------- main build

def build_features(osm):
    """Classify OSM objects into layers. Returns dict of lists."""
    F = {k: [] for k in ("building", "veg", "sparse", "water", "road", "foot", "rail", "bridge",
                         "sidewalk_side", "noTree", "lit", "trees", "treerows")}
    stats = {"buildings": 0, "explicit": 0, "underground": 0, "bld_height": 0, "bld_levels": 0}

    def handle(oid, kind, tags, poly, line):
        b = tags.get("building")
        if (b and b != "no") or tags.get("building:part"):
            if tags.get("location") == "underground" or tags.get("layer", "0").startswith("-"):
                stats["underground"] += 1
            elif poly is not None:
                F["building"].append((oid, tags, poly))
        lu, nat, lei = tags.get("landuse"), tags.get("natural"), tags.get("leisure")
        if poly is not None:
            if lu in SPARSE_LANDUSE:
                F["sparse"].append(poly)
            elif lu in VEG_LANDUSE or nat in VEG_NATURAL or lei in VEG_LEISURE:
                F["veg"].append(poly)
            if nat == "water" or tags.get("waterway") == "riverbank":
                F["water"].append(poly)
            if tags.get("amenity") == "parking" or lei in ("playground", "pitch"):
                F["noTree"].append(poly)
        hw = tags.get("highway")
        if hw and hw not in HIGHWAY_SKIP and tags.get("tunnel") not in ("yes", "building_passage", "culvert"):
            if line is not None:
                w = num(tags.get("width")) or HIGHWAY_WIDTH.get(hw, 3.0)
                if hw == "service" and tags.get("service") == "driveway" and not num(tags.get("width")):
                    w = 2.5
                tgt = "foot" if (hw in FOOT_CLASSES or tags.get("footway") == "sidewalk") else "road"
                F[tgt].append((line, w))
                if tags.get("bridge") not in (None, "no"):
                    F["bridge"].append((line, w))
                if tags.get("lit") == "yes":
                    F["lit"].append((line, w))
                if tgt == "road":
                    sw = tags.get("sidewalk")
                    for side in {"left": [1], "right": [-1], "both": [1, -1]}.get(sw, []):
                        F["sidewalk_side"].append((line, w, side))
            elif poly is not None and tags.get("area") == "yes":
                F["foot" if hw in FOOT_CLASSES else "road"].append((poly, 0))
        ww = tags.get("waterway")
        if ww and line is not None and ww != "riverbank" and tags.get("tunnel") not in ("yes", "culvert"):
            F["water"].append(line.buffer((num(tags.get("width")) or 2.0) / 2.0, cap_style="flat"))
        rw = tags.get("railway")
        if rw in RAIL_TYPES and line is not None and tags.get("tunnel") not in ("yes",):
            F["rail"].append(line.buffer(1.5, cap_style="flat"))
            if tags.get("bridge") not in (None, "no"):
                F["bridge"].append((line, 3.0))
        if nat == "tree_row" and line is not None:
            F["treerows"].append(line)

    for wid, (refs, tags) in osm.ways.items():
        if not tags:
            continue
        closed = len(refs) >= 4 and refs[0] == refs[-1]
        # closed ways are areas only for area-ish tags; keep line for linear features
        line = osm.way_line(wid)
        poly = osm.way_polygon(wid) if closed else None
        if closed and (tags.get("highway") or tags.get("railway") or tags.get("waterway")) \
                and tags.get("area") != "yes":
            poly = None
        handle(("way", wid), "way", tags, poly, line)
    for rid, (members, tags) in osm.rels.items():
        if tags.get("type") == "multipolygon":
            poly = osm.multipolygon(rid)
            if poly is not None:
                handle(("relation", rid), "relation", tags, poly, None)
    for nid, tags in osm.node_tags.items():
        x, y = osm.nodes[nid]
        if tags.get("natural") == "tree":
            F["trees"].append((x, y))
        for k, v in POLE_TAGS:
            if tags.get(k) == v:
                F.setdefault("poles", []).append((x, y))
    F.setdefault("poles", [])
    return F, stats


def building_height_m(oid, tags):
    """Return (height_m, explicit?)."""
    h = num(tags.get("height"))
    if h:
        return h, True
    lv = num(tags.get("building:levels"))
    if lv:
        return lv * 3.0, True
    b = tags.get("building")
    if b == "apartments":
        return 5 * 3.0, False
    if b == "school":
        return 3 * 3.0, False
    levels = 2 + (zlib.crc32(f"{oid[0]}{oid[1]}".encode()) % 2)
    return levels * 3.0, False


def put_tree(grid, ix, iz, base):
    """3-cube trunk + radius-2 canopy (class 6), only into air cells."""
    ny, nz, nx = grid.shape
    for dy in range(3):
        y = base + dy
        if y < ny and grid[y, iz, ix] == AIR:
            grid[y, iz, ix] = VEGETATION
    cy = base + 3
    for dy in range(-2, 3):
        y = cy + dy
        if not 0 <= y < ny:
            continue
        for dz in range(-2, 3):
            for dx in range(-2, 3):
                if dx * dx + dy * dy + dz * dz <= 5:
                    x, z = ix + dx, iz + dz
                    if 0 <= x < nx and 0 <= z < nz and grid[y, z, x] == AIR:
                        grid[y, z, x] = VEGETATION


def put_pole(grid, ix, iz, base, height=POLE_HEIGHT):
    ny = grid.shape[0]
    for y in range(base, min(ny, base + height)):
        if grid[y, iz, ix] == AIR:
            grid[y, iz, ix] = POLE


def cell_of(area, x, y):
    ix = int(math.floor(x - area.sw_x))
    iz = int(math.floor(area.sw_y + area.size_m - y))
    return ix, iz


def main():
    t0 = time.time()
    area = lc.load_area()
    nx, ny, nz = area.dims
    osm = Osm(fetch_osm())
    t_parse = time.time()

    elev = lc.sample_dem(area)
    ground_z = int(math.floor(elev.min())) - 1
    h_col = np.clip(np.rint(elev - ground_z).astype(int), 1, ny)
    t_dem = time.time()

    F, st = build_features(osm)
    R = Raster(area)
    surf = np.zeros((nz, nx), np.uint8)

    def paint(geom, cls, mask_filter=None):
        if geom is None or geom.is_empty:
            return None
        r = R.cover(geom)
        if r is None:
            return None
        sz, sx, m = r
        if mask_filter is not None:
            m = m & mask_filter(sz, sx)
        surf[sz, sx][m] = cls
        return sz, sx, m

    # --- surface classes, low -> high priority
    veg_region = np.zeros((nz, nx), bool)
    for g in F["veg"] + F["sparse"]:
        r = R.cover(g)
        if r is not None:
            veg_region[r[0], r[1]] |= r[2]
    iz_g, ix_g = np.mgrid[0:nz, 0:nx]
    sparse_ok = (hash_uint(ix_g, iz_g, 1) % np.uint64(2)) == 0
    for g in F["veg"]:
        paint(g, VEGETATION)
    for g in F["sparse"]:
        paint(g, VEGETATION, lambda sz, sx: sparse_ok[sz, sx])
    for g in F["water"]:
        paint(g, WATER)
    for line, w in F["foot"]:
        paint(line.buffer(w / 2.0, cap_style="flat") if w else line, SIDEWALK)
    for line, w, side in F["sidewalk_side"]:
        off = line.offset_curve(side * (w / 2.0 + SIDEWALK_W / 2.0))
        if not off.is_empty:
            paint(off.buffer(SIDEWALK_W / 2.0, cap_style="flat"), SIDEWALK)
    for g in F["rail"]:
        paint(g, RAIL)
    for line, w in F["road"]:
        paint(line.buffer(w / 2.0, cap_style="flat") if w else line, ROAD)
    for line, w in F["bridge"]:
        paint(line.buffer(w / 2.0, cap_style="flat"), BRIDGE)
    t_surf = time.time()

    # --- buildings: per-column roof level (max over overlapping buildings)
    roof_top = np.zeros((nz, nx), int)
    n_b = n_explicit = n_hgt = n_lv = 0
    for oid, tags, poly in F["building"]:
        n_b += 1
        hm, explicit = building_height_m(oid, tags)
        n_explicit += explicit
        n_hgt += bool(num(tags.get("height")))
        n_lv += bool(num(tags.get("building:levels"))) and not num(tags.get("height"))
        hc = max(2, int(round(hm)))
        r = R.cover(poly, centre_inside=True)
        if r is None:
            continue
        sz, sx, m = r
        if not m.any():  # tiny footprint: take the cell holding a representative point
            p = poly.representative_point()
            ix, iz = cell_of(area, p.x, p.y)
            if not (0 <= ix < nx and 0 <= iz < nz):
                continue
            m = np.zeros((nz, nx), bool)
            m[iz, ix] = True
            sz, sx = slice(0, nz), slice(0, nx)
        roof = int(round(elev[sz, sx][m].min() - ground_z)) + hc
        cur = roof_top[sz, sx]
        cur[m] = np.maximum(cur[m], roof)
    bmask = roof_top > 0
    roof_top = np.where(bmask, np.minimum(np.maximum(roof_top, h_col + 1), ny), 0)
    t_bld = time.time()

    # --- assemble grid (ny, nz, nx)
    y = np.arange(ny)[:, None, None]
    grid = np.where(y < h_col[None], GROUND, AIR).astype(np.uint8)
    top = (~bmask) & (surf > 0)
    zz, xx = np.nonzero(top)
    grid[h_col[zz, xx] - 1, zz, xx] = surf[zz, xx]
    rt = roof_top[None]
    grid[(y >= h_col[None]) & (y < rt)] = WALL
    grid[(y == rt - 1) & bmask[None]] = ROOF

    # --- real furniture (support only; none in this OSM extract)
    n_real = {"trees": 0, "poles": 0}
    for x, yy in F["trees"]:
        ix, iz = cell_of(area, x, yy)
        if 0 <= ix < nx and 0 <= iz < nz and not bmask[iz, ix]:
            put_tree(grid, ix, iz, h_col[iz, ix]); n_real["trees"] += 1
    for line in F["treerows"]:
        for s in np.arange(0, line.length, 6.0):
            p = line.interpolate(s)
            ix, iz = cell_of(area, p.x, p.y)
            if 0 <= ix < nx and 0 <= iz < nz and not bmask[iz, ix]:
                put_tree(grid, ix, iz, h_col[iz, ix]); n_real["trees"] += 1
    for x, yy in F["poles"]:
        ix, iz = cell_of(area, x, yy)
        if 0 <= ix < nx and 0 <= iz < nz and not bmask[iz, ix]:
            put_pole(grid, ix, iz, h_col[iz, ix]); n_real["poles"] += 1

    # --- common metadata
    pct = 100.0 * n_explicit / max(1, n_b)
    elev_min, elev_max = float(elev.min()), float(elev.max())
    base_notes = [
        f"{n_b} buildings extruded; only {n_explicit} ({pct:.1f}%) carry height info "
        f"({n_hgt} height, {n_lv} building:levels); the rest use default heights "
        f"(apartments 15 m, school 9 m, others 6 or 9 m by id hash) so roof heights are largely guesses.",
        f"No natural=tree, highway=street_lamp, power=pole or man_made=utility_pole objects exist in this OSM extract "
        f"(real trees: {n_real['trees']}, real poles: {n_real['poles']}): the main output contains no trees or poles.",
        "Vegetation ground cover comes only from landuse cemetery/religious (painted on a hashed 50% of cells), "
        "grass/forest/etc. and park/garden polygons; most gardens and trees are not mapped in OSM.",
        f"Terrain: GSI dem5a at z15 (~3.9 m/px at this latitude, ~5 m source mesh) bilinearly sampled at 1 m cell centres, "
        f"nodata filled from neighbours ({100 * lc.sample_dem.last_nodata_fraction:.2f}% of mosaic), 3x3 box smoothed; "
        f"elevation {elev_min:.1f}..{elev_max:.1f} m, so 1 m terraces are DEM artefacts, not real steps.",
        "Buildings are flat-roofed prisms (2.5D): no roof shapes, overhangs, bridges lifted off the ground or underpasses; "
        "walls reach down to the terrain on slopes. Bridge=yes only repaints the surface as class 10.",
        "Classes 11 (other furniture) and 12 (wall/fence) are unused: barrier ways are not voxelised in this baseline. "
        "Roads are fixed-width buffers (tag width or class default), not true carriageway geometry; "
        "tunnels and building:location=underground are skipped.",
    ]
    method = (
        "2.5D extrusion: OSM ways/relations -> shapely polygons in EPSG:6677, rasterised by cell-centre tests per bbox window. "
        "Terrain columns from GSI dem5a (class 1, top cell = surface class, priority vegetation < water < sidewalk < rail < road < bridge). "
        "Roads = centrelines buffered by width/2 (flat caps); buildings extruded from terrain to a flat roof at "
        "round(min footprint ground - groundZ) + max(2, round(height_m)) with top cell = roof; "
        "height_m = height tag, else building:levels*3, else default levels (apartments 5, school 3, otherwise 2 or 3 by crc32 of the way id) * 3 m."
    )
    origin = {"lat": area.lat, "lon": area.lon, "epsg": area.epsg, "x": area.sw_x, "y": area.sw_y, "groundZ": ground_z}
    common = {
        "license": "ODbL 1.0 (OpenStreetMap) + 国土地理院 tile terms (DEM)",
        "attribution": "© OpenStreetMap contributors; 国土地理院タイル (dem5a)",
        "metersPerCube": area.mpc,
        "origin": origin,
    }
    meta_main = dict(common, source="OpenStreetMap (api.openstreetmap.org map call) + GSI dem5a", method=method,
                     notes=base_notes)
    out_main = lc.write_voxels(SRC_ID, grid, meta_main)

    # --- synthetic furniture variant
    sg = grid.copy()
    lamps = trees_veg = trees_gap = 0
    for line, w in F["lit"]:
        L = line.length
        for k, s in enumerate(np.arange(12.5, L, 25.0)):
            p0, p1 = line.interpolate(max(0, s - 0.5)), line.interpolate(min(L, s + 0.5))
            tx, ty = p1.x - p0.x, p1.y - p0.y
            n = math.hypot(tx, ty) or 1.0
            side = 1 if k % 2 == 0 else -1
            p = line.interpolate(s)
            lx = p.x + side * (-ty / n) * (w / 2.0 + 0.5)
            ly = p.y + side * (tx / n) * (w / 2.0 + 0.5)
            ix, iz = cell_of(area, lx, ly)
            if 0 <= ix < nx and 0 <= iz < nz and not bmask[iz, ix] and surf[iz, ix] != WATER:
                put_pole(sg, ix, iz, h_col[iz, ix]); lamps += 1
    no_tree = np.zeros((nz, nx), bool)
    for g in F["noTree"]:
        r = R.cover(g)
        if r is not None:
            no_tree[r[0], r[1]] |= r[2]
    near_b = bmask.copy()
    for _ in range(2):
        p = np.pad(near_b, 1)
        near_b = near_b | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    hv = hash_uint(ix_g, iz_g, 7) % np.uint64(40)
    hg = hash_uint(ix_g, iz_g, 11) % np.uint64(150)
    veg_c = veg_region & ((surf == 0) | (surf == VEGETATION)) & ~bmask & (hv == 0)
    gap_c = ~veg_region & (surf == 0) & ~near_b & ~no_tree & (hg == 0)
    for zz, xx in zip(*np.nonzero(veg_c)):
        put_tree(sg, xx, zz, h_col[zz, xx]); trees_veg += 1
    for zz, xx in zip(*np.nonzero(gap_c)):
        put_tree(sg, xx, zz, h_col[zz, xx]); trees_gap += 1
    meta_synth = dict(
        common,
        source="OSM + SYNTHETIC street furniture (not real data)",
        method=method + " Plus synthetic items: 6 m class-7 street lamps every 25 m (alternating sides, just outside the "
                        "carriageway) along highways tagged lit=yes, and class-6 trees (3 m trunk + radius-2 canopy) on a hashed "
                        "~1/40 of cemetery/religious/vegetation cells and ~1/150 of building-free open ground cells.",
        notes=["WARNING: the street lamps and trees in this variant are fabricated for visual testing of how poles and trees "
               f"read in the viewer; they are not OpenStreetMap data ({lamps} lamps, {trees_veg} trees on vegetation cells, "
               f"{trees_gap} trees on open-ground cells)."] + base_notes,
    )
    out_synth = lc.write_voxels(SYNTH_ID, sg, meta_synth)
    t1 = time.time()

    print(f"groundZ={ground_z}  terrain elevation {elev_min:.2f}..{elev_max:.2f} m  max voxel y={int(np.nonzero((grid > 0).any(axis=(1, 2)))[0].max()) + 1}/{ny}")
    print(f"buildings={n_b} explicit={n_explicit} ({pct:.1f}%) height={n_hgt} levels={n_lv}; "
          f"real trees={n_real['trees']} real poles={n_real['poles']}; synth lamps={lamps} trees={trees_veg}+{trees_gap}")
    for name, o in ((SRC_ID, out_main), (SYNTH_ID, out_synth)):
        print(name, o["classCounts"], f"bin={(lc.VOXEL_DIR / (name + '.bin')).stat().st_size} bytes")
    print(f"timing: parse {t_parse - t0:.2f}s dem {t_dem - t_parse:.2f}s surface {t_surf - t_dem:.2f}s "
          f"buildings {t_bld - t_surf:.2f}s total {t1 - t0:.2f}s")


if __name__ == "__main__":
    main()
