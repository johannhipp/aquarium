"""PLATEAU (Minato-ku 2025, CityGML v5) -> cubeworld lab voxels.

    pipeline/cache/cubeworld/venv/bin/python pipeline/cubeworld/plateau_voxelize.py yakkozaka
    pipeline/cache/cubeworld/venv/bin/python pipeline/cubeworld/plateau_voxelize.py shimbashi-lod3

Downloads only the 3rd-mesh files covering the box (HTTP range requests into the 5 GB dataset zip).

Method (no mesh voxelizer needed; everything is 2.5D except small objects):
  * ground   : PLATEAU dem TIN -> scipy LinearNDInterpolator at cell centres, filled solid below.
  * roads    : tran polygons rasterised at cell centres. LOD3/LOD2 TrafficArea (carriageway 1000/1020,
               sidewalk 2000, island 3000) replace the Road's LOD1 polygon. Roads drape onto the DEM
               unless an LOD3 surface floats > 2.5 m above it (then class 10 bridge deck).
  * buildings: up-facing polygons of the highest LOD present (LOD1 solid top / LOD2-3 roof) -> per-column
               roof height (z-buffer max) -> column filled from the terrain up to the roof.
  * furniture/poles/trees/bridges: polygon soup sampled to points -> voxels (trees/bridges: filled per column).
"""
from __future__ import annotations

import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import mapbox_earcut
import numpy as np
import shapely
from pyproj import Transformer
from scipy.interpolate import LinearNDInterpolator, NearestNDInterpolator

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import labcommon as lc  # noqa: E402
import plateau_citygml as pc  # noqa: E402

ROOT = HERE.parents[1]
CACHE = ROOT / "pipeline" / "cache" / "cubeworld"
DATA = CACHE / "minato2025"
ZIP_URL = ("https://assets.cms.plateau.reearth.io/assets/ea/d75459-6d62-4a1f-8081-317603bd5f8d/"
           "13103_minato-ku_pref_2025_citygml_1_op.zip")

AIR, GROUND, ROAD, SIDEWALK, BUILDING, ROOF, VEG, POLE, WATER, RAIL, BRIDGE, FURN, FENCE = range(13)


@dataclass
class Box:
    vid: str
    sw_x: float
    sw_y: float
    size: int = 160
    ny: int = 100

    @property
    def nx(self): return self.size

    @property
    def nz(self): return self.size


def boxes() -> dict[str, Box]:
    a = lc.load_area()
    return {
        "yakkozaka": Box("plateau-yakkozaka", a.sw_x, a.sw_y, a.size_m),
        "shimbashi-lod3": Box("plateau-shimbashi-lod3", -7200.0, -37280.0),
    }


# ----------------------------------------------------------------------------- data access

def mesh3(lat: float, lon: float) -> str:
    """JIS X 0410 3rd-mesh code (8 digits)."""
    m = lat * 60
    p = int(m // 40)
    r = m - p * 40
    q = int(r // 5)
    s = int((r - q * 5) // 0.5)
    f = (lon - 100 - int(lon - 100)) * 60
    u = int(lon - 100)
    v = int(f // 7.5)
    w = int((f - v * 7.5) // 0.75)
    return f"{p}{u}{q}{v}{s}{w}"


def covering_meshes(b: Box, margin: float = 30.0) -> list[str]:
    to_ll = Transformer.from_crs(6677, 4326, always_xy=True)
    xs = np.arange(b.sw_x - margin, b.sw_x + b.size + margin + 1, 20.0)
    ys = np.arange(b.sw_y - margin, b.sw_y + b.size + margin + 1, 20.0)
    X, Y = np.meshgrid(xs, ys)
    lon, lat = to_ll.transform(X.ravel(), Y.ravel())
    return sorted({mesh3(la, lo) for la, lo in zip(lat, lon)})


_zip = None


def fetch(member: str) -> Path | None:
    """Extract one member of the remote dataset zip into the cache (None if the zip has no such member)."""
    global _zip
    out = DATA / member
    if out.exists():
        return out
    if _zip is None:
        from remotezip import RemoteZip
        _zip = RemoteZip(ZIP_URL)
    if member not in _zip.namelist():
        return None
    print(f"  fetching {member} ({_zip.getinfo(member).file_size / 1e6:.1f} MB, {_zip.getinfo(member).compress_size / 1e6:.1f} MB zipped)")
    _zip.extract(member, DATA)
    return out


# ----------------------------------------------------------------------------- raster helpers

class Grid:
    def __init__(self, b: Box):
        self.b = b
        self.nx, self.nz = b.nx, b.nz

    def to_cell(self, pts: np.ndarray) -> np.ndarray:
        """(n,3) E,N,h -> cell-space x (east), z (south), h."""
        return np.column_stack([pts[:, 0] - self.b.sw_x, self.b.sw_y + self.b.size - pts[:, 1], pts[:, 2]])

    def overlaps(self, pts: np.ndarray, pad: float = 0.0) -> bool:
        c = self.to_cell(pts)
        return not (c[:, 0].max() < -pad or c[:, 0].min() > self.nx + pad or c[:, 1].max() < -pad or c[:, 1].min() > self.nz + pad)

    def poly_cells(self, shell: np.ndarray, holes: list[np.ndarray]):
        """Cells whose centre lies in the polygon -> (zi, xi, plane height at centre) or None."""
        c = self.to_cell(shell)
        poly = shapely.Polygon(c[:, :2], [self.to_cell(h)[:, :2] for h in holes])
        if not poly.is_valid:
            poly = shapely.make_valid(poly)
        minx, minz, maxx, maxz = poly.bounds
        i0, i1 = max(0, math.floor(minx - 0.5)), min(self.nx - 1, math.ceil(maxx))
        j0, j1 = max(0, math.floor(minz - 0.5)), min(self.nz - 1, math.ceil(maxz))
        if i1 < i0 or j1 < j0:
            return None
        X, Z = np.meshgrid(np.arange(i0, i1 + 1) + 0.5, np.arange(j0, j1 + 1) + 0.5)
        m = shapely.contains_xy(poly, X, Z)
        if not m.any():
            return None
        # least-squares plane through the ring -> height at the cell centres
        A = np.column_stack([c[:-1, 0], c[:-1, 1], np.ones(len(c) - 1)])
        coef, *_ = np.linalg.lstsq(A, c[:-1, 2], rcond=None)
        zi, xi = np.nonzero(m)
        xc, zc = X[zi, xi], Z[zi, xi]
        h = coef[0] * xc + coef[1] * zc + coef[2]
        return zi + j0, xi + i0, h


def up_normal(ring: np.ndarray) -> float:
    """Newell normal z component divided by |n| (1 = facing straight up)."""
    p, q = ring[:-1], np.roll(ring[:-1], -1, axis=0)
    n = np.array([np.sum((p[:, 1] - q[:, 1]) * (p[:, 2] + q[:, 2])),
                  np.sum((p[:, 2] - q[:, 2]) * (p[:, 0] + q[:, 0])),
                  np.sum((p[:, 0] - q[:, 0]) * (p[:, 1] + q[:, 1]))])
    l = np.linalg.norm(n)
    return 0.0 if l == 0 else float(n[2] / l)


def sample_surface(polys, step: float = 0.4) -> np.ndarray:
    """Points (n,3) covering the polygons' surfaces, spacing <= step (earcut triangulation of shells)."""
    out = []
    for shell, _ in polys:
        v = shell[:-1]
        if len(v) < 3:
            continue
        if len(v) == 3:
            tris = np.array([[0, 1, 2]])
        else:
            ctr = v.mean(0)
            d = v - ctr
            _, _, vt = np.linalg.svd(d, full_matrices=False)
            uv = d @ vt[:2].T
            idx = mapbox_earcut.triangulate_float64(uv, np.array([len(uv)], dtype=np.uint32))
            tris = idx.reshape(-1, 3)
        for t in tris:
            a, b_, c = v[t[0]], v[t[1]], v[t[2]]
            n = max(1, int(math.ceil(max(np.linalg.norm(b_ - a), np.linalg.norm(c - a), np.linalg.norm(c - b_)) / step)))
            ii, jj = np.meshgrid(np.arange(n + 1), np.arange(n + 1))
            m = ii + jj <= n
            u, w = ii[m] / n, jj[m] / n
            out.append(a + np.outer(u, b_ - a) + np.outer(w, c - a))
    return np.vstack(out) if out else np.zeros((0, 3))


# ----------------------------------------------------------------------------- the pipeline

def terrain(g: Grid, meshes: list[str]) -> np.ndarray:
    b = g.b
    sec = sorted({m[:6] for m in meshes})
    tris = []
    for s in sec:
        gml = fetch(f"udx/dem/{s}_dem_6697_op.gml")
        assert gml is not None, f"no dem for {s}"
        got = pc.load_dem_triangles(str(gml), {f"{s}{i}{j}" for i in range(10) for j in range(10)},
                                    str(CACHE / f"dem_tris_{s}.npz"))
        tris += [v for v in got.values()]
    pts = np.vstack([t.reshape(-1, 3) for t in tris])
    c = g.to_cell(pts)
    keep = (c[:, 0] > -60) & (c[:, 0] < b.nx + 60) & (c[:, 1] > -60) & (c[:, 1] < b.nz + 60)
    c = c[keep]
    c = np.unique(np.round(c, 3), axis=0)
    xs = np.arange(b.nx) + 0.5
    zs = np.arange(b.nz) + 0.5
    X, Z = np.meshgrid(xs, zs)
    h = LinearNDInterpolator(c[:, :2], c[:, 2])(X, Z)
    nan = np.isnan(h)
    if nan.any():
        h[nan] = NearestNDInterpolator(c[:, :2], c[:, 2])(X[nan], Z[nan])
    print(f"  DEM: {len(c)} TIN vertices near the box, h {h.min():.2f}..{h.max():.2f} m")
    return h


ROAD_FN = {"1000", "1010", "1020", "1030", "1040", "1050", "1070", "1130", "6000", "7000"}
SIDEWALK_FN = {"2000", "2010", "2020", "2030"}
AUX_ROAD = {"1000", "1060", "1080", "1090", "1100", "1110", "1120", "4000", "6000", "7000"}
AUX_SIDEWALK = {"3000", "3010", "3020"}   # traffic island / separator
AUX_PLANT = {"5000", "5010", "5020"}      # planting strip / tree pit

FURN_POLE = {"4200", "4800", "4810", "4820", "4830", "4840", "4900", "4600", "4300", "4235", "4236"}
FURN_SKIP = {"1000", "1010", "1020", "1030", "1040", "1100", "1110", "1120", "1200", "5000", "5010", "5020", "5030",
             "5100", "5200", "5300", "5400", "5500", "5600", "5610", "5620", "5630", "7000", "7100", "7200", "7300",
             "7400", "7500", "8070", "8150", "6000", "6010", "6020"}


def best_lod(lods: dict[str, list], prefix: str = "lod") -> str:
    return max(lods, key=lambda k: (int(k[3]), k))


def build(b: Box, cap: int | None = None) -> tuple[np.ndarray, dict]:
    t0 = time.time()
    stats: dict = {"timings_s": {}, "pitfalls": {}}
    g = Grid(b)
    meshes = covering_meshes(b)
    print(f"{b.vid}: SW=({b.sw_x},{b.sw_y}) 3rd meshes {meshes}")

    # ---------------- ground
    t = time.time()
    H = terrain(g, meshes)
    gz = math.floor(H.min())
    tk = np.clip(np.ceil(H - gz).astype(int) - 1, 0, b.ny - 1)  # index of the top ground voxel per column
    stats["timings_s"]["terrain"] = round(time.time() - t, 1)

    def k_of(h):  # voxel index whose cell contains the height h from above (top surface at h)
        return np.ceil(np.asarray(h) - gz).astype(int) - 1

    # ---------------- roads
    t = time.time()
    RC = np.zeros((b.nz, b.nx), np.uint8)       # painted surface class per column
    RC_lod = np.zeros((b.nz, b.nx), np.uint8)   # which LOD painted it (lowest wins nothing: higher overwrites)
    deck = np.full((b.nz, b.nx), np.nan)        # elevated LOD3 road deck height
    n_road = {"road_lod1": 0, "area_lod2": 0, "area_lod3": 0}
    road_files = [fetch(f"udx/tran/{m}_tran_6697_op.gml") for m in meshes]
    feats = [f for p in road_files if p for f in pc.iter_tran(str(p))]
    for pass_lods in ((1,), (2, 3)):
        for f in feats:
            lk = best_lod(f.lods)
            lod = int(lk[3])
            if lod not in pass_lods:
                continue
            if f.kind == "Road":
                cls = ROAD
            elif f.kind == "TrafficArea":
                cls = SIDEWALK if f.function in SIDEWALK_FN else ROAD
            else:
                cls = SIDEWALK if f.function in AUX_SIDEWALK else VEG if f.function in AUX_PLANT else ROAD
            hit = False
            for shell, holes in f.lods[lk]:
                if not g.overlaps(shell):
                    continue
                r = g.poly_cells(shell, holes)
                if r is None:
                    continue
                zi, xi, h = r
                hit = True
                if lod == 3:
                    el = h > H[zi, xi] + 2.5
                    if el.any():
                        deck[zi[el], xi[el]] = h[el]
                        zi, xi = zi[~el], xi[~el]
                RC[zi, xi] = cls
                RC_lod[zi, xi] = lod
            if hit:
                n_road[f"road_lod1" if f.kind == "Road" else f"area_lod{lod}"] += 1
    stats["road_features_in_box"] = n_road
    stats["timings_s"]["roads"] = round(time.time() - t, 1)

    # ---------------- buildings
    t = time.time()
    BH = np.full((b.nz, b.nx), -np.inf)
    n_b = {"lod1": 0, "lod2": 0, "lod3": 0}
    floating = []
    for m in meshes:
        p = fetch(f"udx/bldg/{m}_bldg_6697_op.gml")
        if p is None:
            continue
        for f in pc.iter_bldg(str(p)):
            by_lod: dict[int, list] = {}
            for k, v in f.lods.items():
                if v:
                    by_lod.setdefault(int(k[3]), []).extend(v)
            if not by_lod:
                continue
            lod = max(by_lod)
            polys = by_lod[lod]
            allv = np.vstack([q[0] for q in polys])
            if not g.overlaps(allv):
                continue
            n_b[f"lod{lod}"] += 1
            got = False
            for shell, holes in polys:
                if up_normal(shell) < 0.3:
                    continue
                r = g.poly_cells(shell, holes)
                if r is None:
                    continue
                zi, xi, h = r
                got = True
                BH[zi, xi] = np.maximum(BH[zi, xi], h)
            if got:
                c = g.to_cell(allv)
                ci, cj = int(np.clip(c[:, 0].mean(), 0, b.nx - 1)), int(np.clip(c[:, 1].mean(), 0, b.nz - 1))
                floating.append(c[:, 2].min() - H[cj, ci])
    stats["buildings_in_box"] = n_b
    if floating:
        fl = np.array(floating)
        stats["pitfalls"]["building_bottom_minus_dem_m"] = {
            "median": round(float(np.median(fl)), 2), "p10": round(float(np.percentile(fl, 10)), 2),
            "p90": round(float(np.percentile(fl, 90)), 2)}
    stats["timings_s"]["buildings"] = round(time.time() - t, 1)

    # ---------------- compose terrain, roads, buildings
    ny = b.ny
    grid = np.zeros((ny, b.nz, b.nx), np.uint8)
    kk = np.arange(ny)[:, None, None]
    grid[kk <= tk[None]] = GROUND
    zz, xx = np.indices((b.nz, b.nx))
    painted = RC > 0
    grid[tk[painted], zz[painted], xx[painted]] = RC[painted]

    bm = np.isfinite(BH)
    top = np.clip(k_of(np.where(bm, BH, 0)), 0, ny - 1)
    if cap is not None:
        top = np.minimum(top, cap)   # preview only: lop towers off so the streets stay visible
    top = np.maximum(top, tk)
    over = int((bm & (k_of(np.where(bm, BH, 0)) > ny - 1)).sum())
    fill = bm[None] & (kk >= tk[None]) & (kk <= top[None])
    grid[fill] = BUILDING
    grid[top[bm], zz[bm], xx[bm]] = ROOF
    stats["building_columns_clipped_to_ny"] = over

    # elevated LOD3 road decks
    dm = np.isfinite(deck)
    if dm.any():
        dk = np.clip(k_of(np.where(dm, deck, 0)), 0, ny - 1)
        grid[dk[dm], zz[dm], xx[dm]] = BRIDGE

    # ---------------- bridges, vegetation, furniture
    def put_points(pts: np.ndarray, cls: int, fill_cols: bool, only_air_or_ground: bool = False):
        c = g.to_cell(pts)
        i, j = np.floor(c[:, 0]).astype(int), np.floor(c[:, 1]).astype(int)
        k = np.floor(c[:, 2] - gz).astype(int)
        ok = (i >= 0) & (i < b.nx) & (j >= 0) & (j < b.nz) & (k >= 0) & (k < ny)
        i, j, k = i[ok], j[ok], k[ok]
        if fill_cols:
            col = j * b.nx + i
            order = np.lexsort((k, col))
            col, i, j, k = col[order], i[order], j[order], k[order]
            starts = np.r_[0, np.nonzero(np.diff(col))[0] + 1]
            ends = np.r_[starts[1:], len(col)]
            for s, e in zip(starts, ends):
                grid[k[s]:k[e - 1] + 1, j[s], i[s]] = cls
        else:
            grid[k, j, i] = cls

    t = time.time()
    n_f = {"bridge": 0, "tree": 0, "plantcover": 0, "pole": 0, "furniture": 0, "fence": 0, "skipped_flat": 0}
    func_hist: dict[str, int] = {}
    for m in meshes:
        p = fetch(f"udx/brid/{m}_brid_6697_op.gml")
        if p is not None:
            for f in pc.iter_deep(str(p), pc.Q["brid"] + "Bridge"):
                polys = f.lods[best_lod(f.lods)]
                if g.overlaps(np.vstack([q[0] for q in polys])):
                    put_points(sample_surface(polys, 0.6), BRIDGE, True)
                    n_f["bridge"] += 1
    for m in meshes:
        p = fetch(f"udx/veg/{m}_veg_6697_op.gml")
        if p is None:
            continue
        for tag, key in (("SolitaryVegetationObject", "tree"), ("PlantCover", "plantcover")):
            for f in pc.iter_deep(str(p), pc.Q["veg"] + tag):
                lk = best_lod(f.lods)
                polys = f.lods[lk]
                if not g.overlaps(np.vstack([q[0] for q in polys])):
                    continue
                n_f[key] += 1
                if lk == "lod1" and key == "plantcover":
                    for shell, holes in polys:
                        r = g.poly_cells(shell, holes)
                        if r is not None:
                            zi, xi, _ = r
                            grid[tk[zi, xi], zi, xi] = np.where(grid[tk[zi, xi], zi, xi] == GROUND, VEG, grid[tk[zi, xi], zi, xi])
                else:
                    put_points(sample_surface(polys, 0.5), VEG, True)
    for m in meshes:
        p = fetch(f"udx/frn/{m}_frn_6697_op.gml")
        if p is None:
            continue
        for f in pc.iter_deep(str(p), pc.Q["frn"] + "CityFurniture"):
            polys = f.lods[best_lod(f.lods)]
            if not g.overlaps(np.vstack([q[0] for q in polys])):
                continue
            func_hist[f.function or "?"] = func_hist.get(f.function or "?", 0) + 1
            if f.function in FURN_SKIP:
                n_f["skipped_flat"] += 1
                continue
            if f.function in FURN_POLE:
                cls, key = POLE, "pole"
            elif f.function == "2000":
                cls, key = FENCE, "fence"
            else:
                cls, key = FURN, "furniture"
            put_points(sample_surface(polys, 0.3), cls, False)
            n_f[key] += 1
    stats["objects_in_box"] = n_f
    stats["frn_function_histogram_in_box"] = dict(sorted(func_hist.items(), key=lambda kv: -kv[1]))
    stats["timings_s"]["objects"] = round(time.time() - t, 1)

    stats["groundZ"] = gz
    stats["terrain_relief_m"] = round(float(H.max() - H.min()), 1)
    stats["timings_s"]["total"] = round(time.time() - t0, 1)
    return grid, stats


def main():
    name = sys.argv[1]
    b = boxes()[name]
    cap = int(sys.argv[sys.argv.index("--cap") + 1]) if "--cap" in sys.argv else None
    if cap is not None:
        b.vid += f"-cap{cap}"
    grid, stats = build(b, cap)
    to_ll = Transformer.from_crs(6677, 4326, always_xy=True)
    cx, cy = b.sw_x + b.size / 2, b.sw_y + b.size / 2
    lon, lat = to_ll.transform(cx, cy)
    meta = {
        "source": "PLATEAU 3D city model Minato-ku FY2025 (spec v5, CityGML 2.0, built by Tokyo Metropolitan Government): bldg + tran + dem, plus frn/veg/brid where the mesh has them",
        "license": "PLATEAU Site Policy art. 3 = Public Data License v1.0 (PDL1.0), CC BY 4.0 compatible; free incl. commercial use, attribution + 'modified' notice required; copyright held by the local government (Tokyo / Minato-ku)",
        "attribution": "出典：国土交通省 3D都市モデル（Project PLATEAU）東京都港区（令和7年度） "
                       "(https://www.geospatial.jp/ckan/dataset/plateau-13103-minato-ku-2025) を加工して作成 / "
                       "Source: MLIT Project PLATEAU, Minato-ku FY2025 3D city model, processed into voxels",
        "method": "pipeline/cubeworld/plateau_voxelize.py: lxml CityGML parse -> EPSG:6677; DEM TIN interpolation; "
                  "tran polygons rasterised at cell centres; building roof z-buffer filled to terrain; "
                  "frn/veg/brid surface-sampled to voxels",
        "metersPerCube": 1,
        "origin": {"lat": round(lat, 6), "lon": round(lon, 6), "epsg": 6677, "x": b.sw_x, "y": b.sw_y,
                   "groundZ": stats["groundZ"], "centre": True, "note": "lat/lon is the box centre; x/y the projected SW corner"},
        "notes": {**stats, **({"cap": f"buildings cut at voxel y={cap} (preview of the street level)"} if cap else {})},
    }
    out = lc.write_voxels(b.vid, grid, meta)
    print(json.dumps({k: out[k] for k in ("dims", "classCounts")}, ensure_ascii=False))
    print(json.dumps(stats, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
