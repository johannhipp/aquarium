"""VIRTUAL SHIZUOKA mobile-mapping (MMS) point cloud -> 1 m cubeworld voxels (Numazu street corridor).

Source : Shizuoka Prefecture VIRTUAL SHIZUOKA, 富士山南東部・伊豆東部 2019 MMS "Ground" meshes (LAS 1.2, fmt 3, EPSG:6676,
         RGB + intensity, ~7000 pts/m^2 on the road, classes are only height-above-ground bins 2/3/4/5, no semantics).
         CC BY 4.0 / ODbL dual licence.  Mesh 08NE3830 (Numazu, ~35.0968N 138.8517E), 42.6 M points, one diagonal street.
Fuse   : OSM (building footprints, footways, highways) from the OSM API `map` call.
Frame  : MMS gives a street corridor, so the voxel box is rotated to run along the street (x = along the street,
         z = to the right of the direction of travel = roughly south).  The rotation is stored in the json
         (origin.rotationDeg, origin.x/y = projected position of voxel (0,0) corner).

usage: python pointcloud_mms.py
"""

import json
import sys
import urllib.request
import zipfile

import laspy
import numpy as np
import scipy.ndimage as ndi
from pyproj import Transformer
from shapely import contains_xy
from shapely.affinity import affine_transform
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

from pointcloud_common import *  # noqa: F401,F403

MESH = "08NE3830"
URL = "https://virtual-shizuoka.s3.ap-northeast-1.amazonaws.com/2019/MMS/Ground/08/NE/38/{}.zip"
DIR = CACHE / "shizuoka"
EPSG = 6676
THIN = 3  # keep every 3rd point (7000 pts/m^2 is far more than a 1 m cube needs)
NY = 40
ROAD_WIDTH = {"primary": 12, "secondary": 10, "tertiary": 8, "unclassified": 6, "residential": 5, "service": 3.5,
              "footway": 1.6, "path": 1.6}


def fetch():
    las = DIR / f"{MESH}.las"
    if las.exists():
        return las
    DIR.mkdir(parents=True, exist_ok=True)
    zp = DIR / f"{MESH}_ground.zip"
    if not zp.exists():
        urllib.request.urlretrieve(URL.format(MESH), zp)
    with zipfile.ZipFile(zp) as z:
        z.extract(f"{MESH}.las", DIR)
    return las


def load_thinned():
    cache = DIR / f"{MESH}_thin{THIN}.npz"
    if not cache.exists():
        parts = []
        with laspy.open(fetch()) as f:
            for ch in f.chunk_iterator(4_000_000):
                A = np.array
                sl = slice(0, None, THIN)
                parts.append((A(ch.x)[sl], A(ch.y)[sl], A(ch.z)[sl], A(ch.classification)[sl],
                              (A(ch.red)[sl] >> 8).astype(np.uint8), (A(ch.green)[sl] >> 8).astype(np.uint8),
                              (A(ch.blue)[sl] >> 8).astype(np.uint8), A(ch.intensity)[sl]))
        names = ("x", "y", "z", "c", "r", "g", "b", "i")
        np.savez(cache, **{n: np.concatenate([p[k] for p in parts]) for k, n in enumerate(names)})
    return dict(np.load(cache))


def frame_from_points(x, y):
    """PCA street axis; returns (O, theta) with voxel u along +d, v south-positive, origin at the data minimum corner."""
    xy = np.c_[x[::50], y[::50]]
    c = xy.mean(0)
    w, v = np.linalg.eigh(np.cov((xy - c).T))
    d = v[:, 1]
    if d[0] < 0:
        d = -d
    theta = float(np.arctan2(d[1], d[0]))
    return d, theta


def to_frame(x, y, O, theta):
    d = np.array([np.cos(theta), np.sin(theta)])
    nrm = np.array([-np.sin(theta), np.cos(theta)])
    dx, dy = x - O[0], y - O[1]
    return dx * d[0] + dy * d[1], -(dx * nrm[0] + dy * nrm[1])


def osm_layers(O, theta, nx, nz, tr_to_proj, bbox):
    osm = CACHE / "osm" / "numazu.osm"
    if not osm.exists():
        w, s, e, n = bbox
        urllib.request.urlretrieve(f"https://api.openstreetmap.org/api/0.6/map?bbox={w},{s},{e},{n}", osm)
    data = parse_osm(osm, tr_to_proj)
    cos, sin = np.cos(theta), np.sin(theta)
    # shapely affine: x' = u = (x-Ox)*cos + (y-Oy)*sin ; y' = vs = (x-Ox)*sin - (y-Oy)*cos
    mat = [cos, sin, sin, -cos, -(O[0] * cos + O[1] * sin), -(O[0] * sin - O[1] * cos)]
    X, Y = np.meshgrid(np.arange(nx) + 0.5, np.arange(nz) + 0.5)

    def raster(geoms):
        return contains_xy(unary_union(geoms), X, Y) if geoms else np.zeros((nz, nx), bool)

    def tf(g):
        return affine_transform(g, mat)

    bld, road, side = [], [], []
    for tags, pts in data["ways"]:
        closed = len(pts) > 3 and pts[0] == pts[-1]
        hw = tags.get("highway")
        if "building" in tags and closed:
            bld.append(tf(Polygon(pts).buffer(0)))
        elif hw in ROAD_WIDTH and len(pts) > 1:
            g = tf(LineString(pts).buffer(ROAD_WIDTH[hw] / 2, cap_style="flat"))
            (side if hw in ("footway", "path") else road).append(g)
    return {"building": raster(bld), "road": raster(road), "sidewalk": raster(side), "n_buildings": len(bld)}


def scatter_index(u, v, h, vi, shp):
    """Per-voxel lambda_min / trace of the point covariance: ~0 for planes (road, facade, roof), 0.1-0.33 for foliage."""
    size = int(np.prod(shp))
    n = np.bincount(vi, minlength=size).astype(np.float64)
    nzv = n >= 10
    lu, lv, lh = u - np.floor(u), v - np.floor(v), h - np.floor(h)  # coordinates inside the 1 m cell
    cols = (lu, lv, lh)
    mean = [np.bincount(vi, weights=c, minlength=size)[nzv] / n[nzv] for c in cols]
    cov = np.zeros((nzv.sum(), 3, 3))
    for i in range(3):
        for j in range(i, 3):
            sij = np.bincount(vi, weights=cols[i] * cols[j], minlength=size)[nzv] / n[nzv] - mean[i] * mean[j]
            cov[:, i, j] = cov[:, j, i] = sij
    ev = np.linalg.eigvalsh(cov)
    out = np.zeros(size, np.float32)
    out[nzv] = ev[:, 0] / np.maximum(ev.sum(1), 1e-9)
    return out.reshape(shp)


def detect_poles(P, dem, nx, nz):
    """Thin, tall, isolated vertical structures on a 0.25 m grid. Returns [(u, v, top_height_m)] in voxel-frame metres."""
    res = 0.25
    u, v, z = P["u"], P["v"], P["z"]
    iz = np.clip(np.floor(v).astype(int), 0, nz - 1)
    ix = np.clip(np.floor(u).astype(int), 0, nx - 1)
    h = z - dem[iz, ix]
    m = (h > 0.4) & (h < 14)
    fu = np.floor(u[m] / res).astype(int)
    fv = np.floor(v[m] / res).astype(int)
    fh = np.floor(h[m] / 0.5).astype(int)
    L, W, H = 28, int(nx / res) + 1, int(nz / res) + 1
    ok = (fu >= 0) & (fu < W) & (fv >= 0) & (fv < H) & (fh < L)
    cnt = np.zeros((L, H, W), np.uint16)
    np.add.at(cnt, (fh[ok], fv[ok], fu[ok]), 1)
    occ = cnt >= 3
    # horizontal isolation: in a 9x9 window (+-1.0 m) only the pole's own few cells are occupied (a facade, hedge or car fills many)
    win = ndi.uniform_filter(occ.astype(np.float32), size=(1, 9, 9), mode="constant") * 81
    thin = occ & (win <= 9)
    layers = thin[3:16].sum(0)  # 1.5 m .. 8 m
    cand = layers >= 7
    lab, n = ndi.label(cand, structure=np.ones((3, 3)))
    poles = []
    for i in range(1, n + 1):
        ys, xs = np.nonzero(lab == i)
        if len(ys) > 40:  # a wide blob is not a pole
            continue
        cu, cv = (xs.mean() + 0.5) * res, (ys.mean() + 0.5) * res
        zz = np.nonzero(thin[:, ys, xs].any(1))[0]
        top = (zz.max() + 1) * 0.5
        if top >= 4.0:
            poles.append((float(cu), float(cv), float(top)))
    return poles


def classify(P, osm, nx, nz):
    """P: dict with u, v (voxel-frame metres), z (metres), c, rgb."""
    u, v, z = P["u"], P["v"], P["z"]
    ix = np.floor(u).astype(int)
    iz = np.floor(v).astype(int)
    cell = iz * nx + ix
    # --- DEM from LAS class 2 (median per 1 m cell), nearest fill, light smoothing
    g = P["c"] == 2
    order = np.argsort(cell[g], kind="stable")
    cg, zg = cell[g][order], z[g][order]
    uq, st = np.unique(cg, return_index=True)
    en = np.r_[st[1:], len(cg)]
    dem = np.full(nx * nz, np.nan)
    dem[uq] = [np.median(zg[s:e]) for s, e in zip(st, en)]
    dem = dem.reshape(nz, nx)
    valid = ~np.isnan(dem)
    idx = ndi.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    dem = dem[idx[0], idx[1]]
    dem = ndi.uniform_filter(dem, 3, mode="nearest")
    ground_z = float(np.floor(dem.min()))
    surf = np.floor(dem - ground_z).astype(int)
    near = ndi.distance_transform_edt(~valid) <= 4.0  # terrain only where the scanner saw ground nearby

    # --- 1 m voxel evidence above the ground
    h = z - dem[iz, ix]
    ok = (h > 0.35) & (h < NY - 6)
    vy = surf[iz, ix] + np.floor(h).astype(int) + 1
    ok &= vy < NY
    vi = (vy * nz + iz) * nx + ix
    shp = (NY, nz, nx)
    n_all = np.bincount(vi[ok], minlength=NY * nz * nx).reshape(shp).astype(np.float32)
    rgb = P["rgb"].astype(np.float32)
    greenpt = (rgb[:, 1] > rgb[:, 0] * 1.06) & (rgb[:, 1] > rgb[:, 2] * 1.10) & (rgb[:, 1] > 40)
    n_green = np.bincount(vi[ok & greenpt], minlength=NY * nz * nx).reshape(shp).astype(np.float32)
    yv = np.arange(NY)[:, None, None]
    scat = scatter_index(u[ok], v[ok], h[ok], vi[ok], shp)

    grid = np.zeros(shp, np.uint8)
    zz, xx = np.indices((nz, nx))
    grid[(yv <= surf[None]) & near[None]] = GROUND
    road = osm["road"] & near & ~osm["building"]
    side = osm["sidewalk"] & near & ~road & ~osm["building"]
    grid[surf[side], zz[side], xx[side]] = SIDEWALK
    grid[surf[road], zz[road], xx[road]] = ROAD

    # --- poles (fine 0.25 m search), painted as one column; their points are removed from the other evidence
    poles = detect_poles(P, dem, nx, nz)
    pole_mask = np.zeros(shp, bool)
    for pu, pv, top in poles:
        cx, cz = int(pu), int(pv)
        if 0 <= cx < nx and 0 <= cz < nz:
            y0 = surf[cz, cx] + 1
            pole_mask[y0:min(NY, y0 + int(round(top))), cz, cx] = True
    # clear a 1-cell halo of evidence around pole columns so crossarms/signs do not become building blobs
    halo = ndi.binary_dilation(pole_mask.any(0), iterations=1)
    n_all[:, halo] = 0
    n_green[:, halo] = 0

    # --- vegetation voxels: dense enough and green
    far_from_wall = ndi.distance_transform_edt(~osm["building"]) >= 2.0
    veg = (((n_all >= 6) & (n_green / np.maximum(n_all, 1) >= 0.35))
           | ((n_all >= 25) & (scat >= 0.075) & (yv - surf[None] >= 2) & far_from_wall[None]))
    solid = (n_all >= 40) & ~veg
    lab, nl = ndi.label(solid, structure=np.ones((3, 3, 3)))
    sizes = ndi.sum(solid, lab, index=np.arange(1, nl + 1))
    ext_y = np.zeros(nl + 1)
    ys_any = ndi.maximum(np.broadcast_to(yv, shp), lab, index=np.arange(1, nl + 1))
    ys_min = ndi.minimum(np.broadcast_to(yv, shp), lab, index=np.arange(1, nl + 1))
    height = ys_any - ys_min + 1
    is_bld = np.zeros(nl + 1, bool)
    is_bld[1:] = (sizes >= 60) & (height >= 4)
    bld_v = is_bld[lab] & solid
    low_v = solid & ~bld_v

    # --- buildings: OSM footprints that the scanner actually hit, extruded to the measured facade/roof height
    bmask = osm["building"]
    btop = np.where(bld_v.any(0), NY - 1 - np.argmax(bld_v[::-1], axis=0), -1)
    foot = ndi.label(bmask)[0]  # touching footprints merge; fine at 1 m
    for k in range(1, foot.max() + 1):
        cells = foot == k
        hit = cells & (btop >= 0)
        if hit.sum() < 3:
            continue
        top_h = int(np.percentile(btop[hit] - surf[hit], 85))
        top_h = max(top_h, 3)
        for cz, cx in zip(*np.nonzero(cells & near)):
            y_roof = min(NY - 1, surf[cz, cx] + top_h)
            col = grid[surf[cz, cx] + 1:y_roof + 1, cz, cx]
            col[:] = BUILDING
            if y_roof < NY:
                grid[y_roof, cz, cx] = ROOF
    grid[bld_v & (grid == 0)] = BUILDING

    # --- trees: vegetation voxels, filled down toward a trunk (trunk column under each canopy top)
    vtop = np.where(veg.any(0), NY - 1 - np.argmax(veg[::-1], axis=0), -1)
    can = veg.copy()
    for cz, cx in zip(*np.nonzero(vtop >= 0)):
        T = vtop[cz, cx] - surf[cz, cx]
        if T >= 3:
            lo = surf[cz, cx] + int(0.45 * T)
            can[lo:vtop[cz, cx] + 1, cz, cx] = True
    lm = ndi.maximum_filter(vtop, size=5) == vtop
    for cz, cx in zip(*np.nonzero((vtop >= 0) & lm)):
        T = vtop[cz, cx] - surf[cz, cx]
        if T >= 4:
            can[surf[cz, cx] + 1:surf[cz, cx] + int(0.45 * T) + 1, cz, cx] = True
    grid[can & (grid <= GROUND)] = VEG

    # --- low structures: vehicles/furniture on road & pavement, fences/walls elsewhere
    on_street = (road | side)[None]
    grid[low_v & on_street & (grid == 0)] = FURNITURE
    grid[low_v & ~on_street & (grid == 0)] = WALL
    # poles last (solid black must win)
    grid[pole_mask & ((grid == 0) | (grid == VEG) | (grid == WALL) | (grid == FURNITURE))] = POLE
    stats = {"poles": len(poles), "pole_tops_m": sorted(round(t, 1) for _, _, t in poles), "bld_components": int(is_bld.sum()),
             "footprints": osm["n_buildings"], "dem_min": float(dem.min()), "dem_max": float(dem.max())}
    stats["groundZ"] = ground_z
    return grid, stats, dem


def main():
    P = load_thinned()
    d, theta = frame_from_points(P["x"], P["y"])
    dvec = np.array([np.cos(theta), np.sin(theta)])
    nvec = np.array([-np.sin(theta), np.cos(theta)])
    tmp_u, tmp_v = to_frame(P["x"], P["y"], (0.0, 0.0), theta)
    u0, v0 = float(tmp_u.min()) - 2, float(tmp_v.min()) - 2
    O = u0 * dvec - v0 * nvec  # projected position of voxel-frame origin
    P["u"], P["v"] = to_frame(P["x"], P["y"], O, theta)
    nx, nz = int(np.ceil(P["u"].max())) + 2, int(np.ceil(P["v"].max())) + 2
    P["rgb"] = np.stack([P["r"], P["g"], P["b"]], 1)
    print("frame theta(deg)", np.degrees(theta), "O", O, "box", nx, nz)
    t = Transformer.from_crs(EPSG, 4326, always_xy=True)
    to_proj = Transformer.from_crs(4326, EPSG, always_xy=True)
    corners = [t.transform(*(O + a * dvec - b * nvec)) for a in (0, nx) for b in (0, nz)]
    bbox = (min(c[0] for c in corners) - 0.0003, min(c[1] for c in corners) - 0.0003,
            max(c[0] for c in corners) + 0.0003, max(c[1] for c in corners) + 0.0003)
    osm = osm_layers(O, theta, nx, nz, to_proj, bbox)
    grid, stats, dem = classify(P, osm, nx, nz)
    ground_z = stats["groundZ"]
    print(stats)
    lon, lat = t.transform(*O)
    meta = {
        "source": "VIRTUAL SHIZUOKA 2019 MMS point cloud (Shizuoka Prefecture), mesh 08NE3830, Numazu + OpenStreetMap",
        "license": "CC BY 4.0 / ODbL dual licence (Shizuoka Prefecture) + ODbL (OpenStreetMap footprints/roads)",
        "attribution": "静岡県 VIRTUAL SHIZUOKA 点群データ (Shizuoka Prefecture, CC BY 4.0 / ODbL); © OpenStreetMap contributors (ODbL)",
        "method": "MMS ~7000 pts/m2 thinned 1/3; LAS classes are height bins only; ground = class 2 median DEM; poles = 0.25 m grid "
                  "isolated vertical columns >=4 m; trees = green RGB voxels with synthesised trunk; buildings = 3-D connected facade "
                  "components >=4 m tall, extruded to OSM footprints; roads/sidewalks from OSM",
        "metersPerCube": 1,
        "origin": {"lat": lat, "lon": lon, "epsg": EPSG, "x": float(O[0]), "y": float(O[1]), "groundZ": ground_z,
                   "rotationDeg": float(np.degrees(theta)),
                   "rotationNote": "voxel x runs along the street direction (angle rotationDeg CCW from east); voxel z = right-hand side; "
                                   "(x,y) = projected position of voxel (0,0) corner; EPSG:6676 JGD2011 / Japan Plane Rectangular CS VIII"},
        "notes": "Corridor-shaped: MMS only covers the street and its frontage (~30 m wide). Terrain is solid and only present near scanned ground.",
    }
    write_voxels("pointcloud-numazu", grid, meta)
    np.save(DIR / "dem.npy", dem)


if __name__ == "__main__":
    main()
