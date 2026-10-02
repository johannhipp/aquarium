"""Tokyo 23-ku aerial LiDAR (CC BY 4.0) -> 1 m cubeworld voxels for the Yakkozaka test box.

Source : 東京都デジタルツイン実現プロジェクト 区部点群データ, mesh 09LD2796 (LAS 1.2, fmt 3, EPSG:6677, RGB,
         ~48 pts/m^2, classes 1 other / 2 ground / 3 other, return numbers).  Flown Mar-Apr 2023.
Fuse   : OSM (building footprints, highway lines, parking, pond) via the OSM API `map` call.
Method : see classify() below.  Heuristics only; there is no building/vegetation class in the LAS.

usage: python pointcloud_tokyo.py [yakkozaka|shimbashi] [--debug]
"""

import sys
import urllib.request
import zipfile

import numpy as np
import scipy.ndimage as ndi
import scipy.interpolate as si
from pyproj import Transformer
from shapely import contains_xy
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

from pointcloud_common import *  # noqa: F401,F403

INDEX = "https://gic-tokyo.s3.ap-northeast-1.amazonaws.com/2024/dig/Vectortile/23ku/lp/{z}/{x}/{y}.pbf"
TOKYO = CACHE / "tokyo"
NY = 100

ROAD_WIDTH = {"primary": 12, "secondary": 10, "tertiary": 8, "unclassified": 5, "residential": 5,
              "service": 3.5, "living_street": 4, "footway": 1.6, "path": 1.6, "pedestrian": 4, "steps": 1.6}


def meshes_for_box(area):
    """Mesh ids whose 1/2500-ish sheets intersect the box (public vector-tile index: no login, no API key)."""
    import gzip

    import mapbox_vector_tile as mvt
    import mercantile
    from shapely.geometry import box as sbox
    from shapely.geometry import shape

    b = area["bboxWGS84"]
    found = {}
    for t in mercantile.tiles(b["west"], b["south"], b["east"], b["north"], 16):
        raw = urllib.request.urlopen(INDEX.format(z=t.z, x=t.x, y=t.y)).read()
        try:
            raw = gzip.decompress(raw)
        except OSError:
            pass
        bb = mercantile.bounds(t)
        qb = sbox((b["west"] - bb.west) / (bb.east - bb.west) * 4096, (b["south"] - bb.south) / (bb.north - bb.south) * 4096,
                  (b["east"] - bb.west) / (bb.east - bb.west) * 4096, (b["north"] - bb.south) / (bb.north - bb.south) * 4096)
        for f in mvt.decode(raw)["lp2"]["features"]:
            if shape(f["geometry"]).intersects(qb):
                found[f["properties"]["MESH_NO"]] = f["properties"]["URL"]
    return found


def fetch_las(mesh, url):
    las = TOKYO / f"{mesh}.las"
    if las.exists():
        return las
    TOKYO.mkdir(parents=True, exist_ok=True)
    zp = TOKYO / f"{mesh}.zip"
    if not zp.exists():
        print("downloading", url)
        urllib.request.urlretrieve(url, zp)
    with zipfile.ZipFile(zp) as z:
        z.extract(f"{mesh}.las", TOKYO)
    return las


def load_points(area):
    import laspy

    swx, swy, n = area["sw"]["x"], area["sw"]["y"], area["sizeM"]
    cache = TOKYO / area["cache"]
    if not cache.exists():
        parts = []
        for mesh, url in meshes_for_box(area).items():
            las = laspy.read(fetch_las(mesh, url))
            A = np.array
            x, y, z = A(las.x), A(las.y), A(las.z)
            m = (x >= swx - 4) & (x < swx + n + 4) & (y >= swy - 4) & (y < swy + n + 4)
            print(mesh, int(m.sum()), "points in box")
            parts.append({"x": x[m], "y": y[m], "z": z[m], "c": A(las.classification)[m], "rn": A(las.return_number)[m],
                          "nr": A(las.number_of_returns)[m], "r": (A(las.red)[m] >> 8).astype(np.uint8),
                          "g": (A(las.green)[m] >> 8).astype(np.uint8), "b": (A(las.blue)[m] >> 8).astype(np.uint8),
                          "i": A(las.intensity)[m]})
        np.savez(cache, **{k: np.concatenate([p[k] for p in parts]) for k in parts[0]})
    d = np.load(cache)
    ix = np.floor(d["x"] - swx).astype(int)
    iz = np.floor(swy + n - d["y"]).astype(int)
    m = (ix >= 0) & (ix < n) & (iz >= 0) & (iz < n)
    P = {k: d[k][m] for k in ("x", "y", "z", "c", "rn", "nr", "r", "g", "b", "i")}
    P["ix"], P["iz"] = ix[m], iz[m]
    return P


def fill_nan(a, valid):
    """Fill invalid cells of a 2-D array by linear interpolation, nearest outside the hull."""
    yy, xx = np.nonzero(valid)
    lin = si.LinearNDInterpolator(np.c_[yy, xx], a[valid])
    gy, gx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
    out = lin(gy, gx)
    bad = np.isnan(out)
    if bad.any():
        nn = si.NearestNDInterpolator(np.c_[yy, xx], a[valid])
        out[bad] = nn(gy[bad], gx[bad])
    return out


def osm_layers(area, tr):
    """Rasterise OSM buildings / roads / sidewalks / water / parking at cell centres. Returns bool masks (n,n)."""
    osm = CACHE / "osm" / area["osm"]
    if not osm.exists():
        osm.parent.mkdir(parents=True, exist_ok=True)
        b = area["bboxWGS84"]
        url = f"https://api.openstreetmap.org/api/0.6/map?bbox={b['west']},{b['south']},{b['east']},{b['north']}"
        urllib.request.urlretrieve(url, osm)
    data = parse_osm(osm, tr)
    swx, swy, n = area["sw"]["x"], area["sw"]["y"], area["sizeM"]
    cx = swx + np.arange(n) + 0.5
    cy = swy + n - (np.arange(n) + 0.5)  # row index = voxel z (south)
    X, Y = np.meshgrid(cx, cy)

    def raster(geoms):
        if not geoms:
            return np.zeros((n, n), bool)
        return contains_xy(unary_union(geoms), X, Y)

    bld, road, side, water, park = [], [], [], [], []
    for tags, pts in data["ways"]:
        closed = len(pts) > 3 and pts[0] == pts[-1]
        hw = tags.get("highway")
        if "building" in tags and closed:
            bld.append(Polygon(pts).buffer(0.0))
        elif hw in ROAD_WIDTH and len(pts) > 1:
            w = ROAD_WIDTH[hw]
            line = LineString(pts)
            if hw in ("footway", "path", "steps", "pedestrian") and tags.get("footway") != "crossing":
                side.append(line.buffer(w / 2, cap_style="flat"))
            else:
                road.append(line.buffer(w / 2, cap_style="flat"))
        elif tags.get("amenity") == "parking" and closed:
            park.append(Polygon(pts).buffer(0.0))
        elif tags.get("natural") == "water" and closed:
            water.append(Polygon(pts).buffer(0.0))
    bmask = raster([g.buffer(0.5) for g in bld])
    return {
        "building": bmask,
        "building_raw": raster(bld),
        "road": raster(road) | raster(park),
        "sidewalk": raster(side),
        "water": raster(water),
        "n_buildings": len(bld),
    }


def classify(area, P, osm, debug=False):
    n = area["sizeM"]
    ix, iz, z, c = P["ix"], P["iz"], P["z"], P["c"]
    cell = iz * n + ix

    # --- ground: per-cell median of LAS class 2, holes (under buildings, water) interpolated
    g = c == 2
    order = np.argsort(cell[g], kind="stable")
    cg, zg = cell[g][order], z[g][order]
    u, st = np.unique(cg, return_index=True)
    en = np.r_[st[1:], len(cg)]
    dem = np.full(n * n, np.nan)
    dem[u] = [np.median(zg[s:e]) for s, e in zip(st, en)]
    dem = dem.reshape(n, n)
    valid = ~np.isnan(dem)
    dem = fill_nan(dem, valid)
    dem = ndi.median_filter(dem, size=3, mode="nearest")
    ground_z = float(np.floor(dem.min()))
    surf = np.floor(dem - ground_z).astype(int)  # index of top ground voxel in each column

    h = z - dem[iz, ix]  # height above ground
    nonground = (c != 2) & (h > 0.35)
    vy = np.floor(z - ground_z).astype(int)

    # --- voxel-level evidence (points >= 0.7 m above ground)
    nyv = NY
    nonground = (c != 2) & (h > 0.7)
    vy = np.floor(z - ground_z).astype(int)
    ok = nonground & (vy >= 0) & (vy < nyv)
    vi = (vy * n + iz) * n + ix
    tot = np.bincount(vi[ok], minlength=nyv * n * n).astype(np.float32)
    nonlast = np.bincount(vi[ok & (P["rn"] < P["nr"])], minlength=nyv * n * n).astype(np.float32)
    rgbf = np.stack([P["r"], P["g"], P["b"]], 1).astype(np.float32)
    green = (rgbf[:, 1] > rgbf[:, 0] * 1.04) & (rgbf[:, 1] > rgbf[:, 2] * 1.04)
    gcount = np.bincount(vi[ok & green], minlength=nyv * n * n).astype(np.float32)
    shape3 = (nyv, n, n)
    tot, nonlast, gcount = (a.reshape(shape3) for a in (tot, nonlast, gcount))
    occ = tot > 0
    # vegetation is decided per column: green RGB, or many non-last returns away from building walls
    ct, cn, cg = tot.sum(0), nonlast.sum(0), gcount.sum(0)
    dist = ndi.distance_transform_edt(~osm["building_raw"])
    nlay = occ.sum(0)  # occupied 1 m layers: wires / eaves are 1 layer thick, canopies are several
    colveg = (((ct >= 3) & ((cg / np.maximum(ct, 1)) >= 0.25))
              | ((dist >= 2.0) & (ct >= 20) & (nlay >= 2) & ((cn / np.maximum(ct, 1)) >= 0.40)))
    veg_v = occ & colveg[None]
    # OSM footprints are a little smaller than eaves / lean-tos: snap tall non-vegetation cells that touch a footprint
    hmax = np.zeros(n * n)
    np.maximum.at(hmax, cell[ok], h[ok])
    hmax = hmax.reshape(n, n)
    osm["building"] = osm["building"] | ((dist <= 1.1) & (hmax >= 3.0) & ~colveg & ~osm["road"] & ~osm["sidewalk"])

    grid = np.zeros(shape3, np.uint8)
    yv = np.arange(nyv)[:, None, None]

    # --- terrain (solid below the surface), plus water
    ground_mask = yv <= surf[None]
    grid[ground_mask] = GROUND
    top = surf
    zz, xx = np.indices((n, n))
    # roads / sidewalks painted onto the top ground voxel (not under buildings)
    free = ~osm["building"]
    water = osm["water"]
    road = osm["road"] & free & ~water
    side = osm["sidewalk"] & free & ~road & ~water
    grid[top[side], zz[side], xx[side]] = SIDEWALK
    grid[top[road], zz[road], xx[road]] = ROAD
    grid[top[water], zz[water], xx[water]] = WATER

    # --- buildings: footprint cells are filled up to the roof height measured from the cloud
    bmask = osm["building"]
    in_b = bmask[iz, ix] & (c != 2) & (h > 1.0)
    # roof height per cell: 80th percentile of non-green points; cells with no points are interpolated
    bc = cell[in_b & ~green]
    bh = h[in_b & ~green]
    order = np.argsort(bc, kind="stable")
    bc, bh = bc[order], bh[order]
    u, st = np.unique(bc, return_index=True)
    en = np.r_[st[1:], len(bc)]
    roof = np.full(n * n, np.nan)
    roof[u] = [np.percentile(bh[s:e], 80) if e - s >= 2 else np.nan for s, e in zip(st, en)]
    roof = roof.reshape(n, n)
    roof[~bmask] = np.nan
    rvalid = ~np.isnan(roof)
    roof_f = fill_nan(roof, rvalid) if rvalid.any() else roof
    roof_f = ndi.median_filter(roof_f, size=3, mode="nearest")
    bcells = bmask & (roof_f > 1.5) & ~water
    rh = np.where(bcells, np.round(roof_f).astype(int), 0)
    for yv_ in range(1, nyv):  # fill column from surf+1 .. surf+rh
        sel = bcells & (rh >= yv_)
        yi = top[sel] + yv_
        okk = yi < nyv
        grid[yi[okk], zz[sel][okk], xx[sel][okk]] = BUILDING
    yi = top[bcells] + rh[bcells]
    okk = yi < nyv
    grid[yi[okk], zz[bcells][okk], xx[bcells][okk]] = ROOF
    bfoot = bmask

    # --- everything above ground that is not inside a building footprint
    ext = occ & ~bfoot[None] & (yv > top[None])
    veg = ext & veg_v
    rest = ext & ~veg_v

    # tree canopy: occupied vegetation voxels, filled down to ~45% of the local canopy top (trunk = 1 column)
    vegtop = np.where(veg.any(0), nyv - 1 - np.argmax(veg[::-1], axis=0), -1)
    canopy = np.zeros(shape3, bool)
    for zi, xi in zip(*np.nonzero(vegtop >= 0)):
        T = vegtop[zi, xi] - top[zi, xi]
        if T < 1:
            continue
        lo = top[zi, xi] + 1 if T <= 3 else top[zi, xi] + int(0.45 * T)
        canopy[lo:vegtop[zi, xi] + 1, zi, xi] = True
    canopy |= veg
    canopy &= ~bfoot[None]
    lm = ndi.maximum_filter(vegtop, size=5) == vegtop  # trunk = one column under each canopy local maximum
    for zi, xi in zip(*np.nonzero((vegtop >= 0) & lm)):
        T = vegtop[zi, xi] - top[zi, xi]
        if T > 3:
            canopy[top[zi, xi] + 1:top[zi, xi] + int(0.45 * T) + 1, zi, xi] = True
    grid[canopy & (grid == 0)] = VEG

    # --- remaining low structures: vehicles on the road, walls / fences / misc furniture elsewhere
    leftover = rest & ~(grid > 0) & (yv <= top[None] + 3)
    on_road = (road | side)[None] & leftover
    grid[on_road] = FURNITURE
    other = leftover & ~(road | side)[None]
    grid[other] = WALL

    stats = {"groundZ": ground_z, "dem_min": float(dem.min()), "dem_max": float(dem.max()),
             "n_buildings_osm": osm["n_buildings"],
             "n_points_box": int(len(z)), "building_cells": int(bcells.sum())}
    if debug:
        np.savez(TOKYO / "debug.npz", dem=dem, top=top, tot=tot, veg=veg, rest=rest, roof=roof_f)
    return grid, stats


def get_area(which):
    """yakkozaka = CubeWorld's public/lab/area.json; shimbashi = PlateauVoxels' LOD3 best-case box (same 160 m convention)."""
    if which == "yakkozaka":
        return {**load_area(), "id": "pointcloud-yakkozaka", "cache": "box_crop.npz", "osm": "box.osm"}
    if which == "shimbashi":
        epsg, swx, swy, n = 6677, -7200, -37280, 160
        t = Transformer.from_crs(epsg, 4326, always_xy=True)
        w, s_ = t.transform(swx, swy)
        e, nn = t.transform(swx + n, swy + n)
        return {"id": "pointcloud-shimbashi", "name": "Shimbashi / Toranomon (PLATEAU LOD3 best-case box)", "epsg": epsg,
                "sw": {"x": swx, "y": swy}, "sizeM": n, "metersPerCube": 1, "center": {"lat": (s_ + nn) / 2, "lon": (w + e) / 2},
                "bboxWGS84": {"west": w, "south": s_, "east": e, "north": nn}, "cache": "box_crop_shimbashi.npz",
                "osm": "shimbashi.osm"}
    raise SystemExit("area must be yakkozaka or shimbashi")


def main():
    debug = "--debug" in sys.argv
    which = next((a for a in sys.argv[1:] if not a.startswith("--")), "yakkozaka")
    area = get_area(which)
    tr = Transformer.from_crs(4326, area["epsg"], always_xy=True)
    P = load_points(area)
    osm = osm_layers(area, tr)
    grid, stats = classify(area, P, osm, debug)
    print(stats)
    meta = {
        "source": "Tokyo Metropolitan Government Digital Twin aerial LiDAR point cloud, 23-ku (2023) + OpenStreetMap",
        "license": "CC BY 4.0 (point cloud, Tokyo Metropolitan Government) + ODbL (OpenStreetMap footprints/roads)",
        "attribution": "東京都デジタルツイン実現プロジェクト 区部点群データ (Tokyo Metropolitan Government, CC BY 4.0); © OpenStreetMap contributors (ODbL)",
        "method": "aerial LiDAR ~48 pts/m2 binned at 1 m; ground = LAS class 2 median DEM; buildings = OSM footprints filled to cloud roof height; "
                  "vegetation = non-last returns / green RGB; no poles (not resolvable in aerial LiDAR); roads/sidewalks from OSM highway buffers",
        "metersPerCube": area["metersPerCube"],
        "origin": {"lat": area["center"]["lat"], "lon": area["center"]["lon"], "epsg": area["epsg"],
                   "x": area["sw"]["x"], "y": area["sw"]["y"], "groundZ": stats["groundZ"]},
        "notes": "Terrain is solid below the surface (class 1). Aerial LiDAR cannot resolve poles (only wires show as horizontal lines) and cannot see "
                 "walls or tree trunks; trunks are synthesised below canopies. Anything above the 100 m box is clipped. voxel z grows southward.",
    }
    write_voxels(area["id"], grid, meta)


if __name__ == "__main__":
    main()
