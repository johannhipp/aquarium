"""PLATEAU Minato-ku FY2025 -> streamable chunk archive for src/cubeworld/stream (see research/cubeworld-streaming.md).

    V=pipeline/cache/cubeworld/venv/bin/python
    $V pipeline/cubeworld/stream_build.py fetch      # range-request every needed CityGML member (~380 MB zipped, 4.2 GB unzipped)
    $V pipeline/cubeworld/stream_build.py prep       # DEM triangle caches (parses the 480 MB TIN files) + water triangles
    $V pipeline/cubeworld/stream_build.py raster     # per 3rd-mesh tile (10 processes, ~40 s): DEM, roads, water, buildings, objects
    $V pipeline/cubeworld/stream_build.py merge      # paste the tiles into 8192 x 7680 global layers (+ `preview` writes a PNG of them)
    $V pipeline/cubeworld/stream_build.py pack       # 240 supertiles -> 7-level pyramid -> public/stream/ (~15 s, 20 MB)

Output: manifest.json, dir.<hash>.bin (deflate-raw chunk directory), chunks.<hash>.bin (every chunk its own deflate-raw
blob, read with HTTP range requests). Wire format: src/cubeworld/stream/format.ts.

The whole ward is rasterised once into 2.5D layers at 1 m (DEM height, surface class, building roof height, water)
plus sparse voxels for thin things (trees, poles, bridge decks). Chunks are cut from those layers; coarser LODs are
priority-pooled from the finer one. The parsing and rasterising helpers are imported from plateau_voxelize.py and
plateau_citygml.py, not copied.
"""
from __future__ import annotations

import functools
import hashlib
import json
import math
import struct
import sys
import threading
import time
import zlib
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

ROOT = HERE.parents[1]
CACHE = ROOT / "pipeline" / "cache" / "cubeworld"
DATA = CACHE / "minato2025"
STREAM_CACHE = CACHE / "stream"
OUT = ROOT / "public" / "stream"
LISTING = CACHE / "minato2025_listing.txt"
ZIP_URL = ("https://assets.cms.plateau.reearth.io/assets/ea/d75459-6d62-4a1f-8081-317603bd5f8d/"
           "13103_minato-ku_pref_2025_citygml_1_op.zip")

# CityGML members that feed the build. luse (1.5 GB) and fld/htd/urf are skipped on purpose.
KINDS = ("bldg", "tran", "frn", "veg", "brid", "wtr", "dem")


def listing_members() -> list[tuple[str, int]]:
    """(member, uncompressed size) for every top-level udx/<kind>/<id>_<kind>_6697_op.gml in the zip listing."""
    out = []
    for line in LISTING.read_text().splitlines():
        parts = line.split(" ", 2)
        if len(parts) != 3:
            continue
        size, _, name = parts
        p = name.split("/")
        if len(p) == 3 and p[0] == "udx" and p[1] in KINDS and p[2].endswith("_6697_op.gml"):
            out.append((name, int(size)))
    return sorted(out)


def mesh3_codes() -> list[str]:
    """3rd-mesh codes that carry buildings or roads: the area the archive covers."""
    return sorted({Path(m).name.split("_")[0] for m, _ in listing_members()
                   if m.split("/")[1] in ("bldg", "tran") and len(Path(m).name.split("_")[0]) == 8})


def cmd_fetch(workers: int = 6) -> None:
    from remotezip import RemoteZip
    todo = [m for m, _ in listing_members() if not (DATA / m).exists()]
    print(f"{len(todo)} of {len(listing_members())} members missing")
    local = threading.local()

    def get(member: str) -> str:
        if not hasattr(local, "zip"):
            local.zip = RemoteZip(ZIP_URL)
        local.zip.extract(member, DATA)
        return member

    with ThreadPoolExecutor(workers) as ex:
        for i, m in enumerate(ex.map(get, todo), 1):
            print(f"  [{i}/{len(todo)}] {m}", flush=True)


# ----------------------------------------------------------------------------- frame

CHUNK = 32            # cells per chunk side, at every LOD
PAD = 1              # ring of neighbour cells stored with each chunk so it meshes alone
SPAN = CHUNK + 2 * PAD
SUPER = 512           # metres per supertile = one chunk at the coarsest LOD (16 m cells)
LEVELS = 7            # cell size 1, 2, 4, 8, 16, 32, 64 m
FINE_LEVELS = 5       # levels 0-4 are cut per supertile; 5-6 are pooled from the whole ward's 16 m grid
GZ = -12              # voxel y = floor(height above Tokyo Peil - GZ); the lowest DEM point is about -10 m
NY_MAX = 512
TILES = STREAM_CACHE / "tiles"


def mesh_bounds(code: str) -> tuple[float, float, float, float]:
    """JIS X 0410 3rd mesh code -> (lat0, lat1, lon0, lon1); a cell is 30 arc-seconds by 45."""
    p, u, q, v, s, w = int(code[0:2]), int(code[2:4]), int(code[4]), int(code[5]), int(code[6]), int(code[7])
    lat0 = (p * 40 + q * 5 + s * 0.5) / 60
    lon0 = 100 + u + (v * 7.5 + w * 0.75) / 60
    return lat0, lat0 + 0.5 / 60, lon0, lon0 + 0.75 / 60


@dataclass(frozen=True)
class Frame:
    gx0: float   # EPSG:6677 easting of cell x=0
    gtop: float  # EPSG:6677 northing of the top edge (cell z=0)
    nx: int
    nz: int


def mesh_rect(code: str) -> tuple[float, float, float, float]:
    """(minE, maxE, minN, maxN) of a mesh in EPSG:6677."""
    from pyproj import Transformer
    la0, la1, lo0, lo1 = mesh_bounds(code)
    x, y = Transformer.from_crs(4326, 6677, always_xy=True).transform([lo0, lo1, lo0, lo1], [la0, la0, la1, la1])
    return min(x), max(x), min(y), max(y)


@functools.cache
def frame() -> Frame:
    rects = [mesh_rect(c) for c in mesh3_codes()]
    gx0 = math.floor(min(r[0] for r in rects)) - 8
    gtop = math.ceil(max(r[3] for r in rects)) + 8
    nx = math.ceil((max(r[1] for r in rects) + 8 - gx0) / SUPER) * SUPER
    nz = math.ceil((gtop - (min(r[2] for r in rects) - 8)) / SUPER) * SUPER
    return Frame(gx0, gtop, nx, nz)


# ----------------------------------------------------------------------------- rasterising

def raster_tris(tri: np.ndarray, n: int, small: int = 10) -> np.ndarray:
    """(m,3,3) triangles in cell space (x east, z south, h) -> (n,n) float32 heights at cell centres, NaN where uncovered."""
    out = np.full((n, n), np.nan, np.float32)
    if len(tri) == 0:
        return out
    x0, x1, x2 = tri[:, 0, 0], tri[:, 1, 0], tri[:, 2, 0]
    z0, z1, z2 = tri[:, 0, 1], tri[:, 1, 1], tri[:, 2, 1]
    h0, h1, h2 = tri[:, 0, 2], tri[:, 1, 2], tri[:, 2, 2]
    det = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2)
    i_lo = np.ceil(np.minimum(np.minimum(x0, x1), x2) - 0.5).astype(np.int64)
    i_hi = np.floor(np.maximum(np.maximum(x0, x1), x2) - 0.5).astype(np.int64)
    j_lo = np.ceil(np.minimum(np.minimum(z0, z1), z2) - 0.5).astype(np.int64)
    j_hi = np.floor(np.maximum(np.maximum(z0, z1), z2) - 0.5).astype(np.int64)
    ok = (np.abs(det) > 1e-9) & (i_hi >= i_lo) & (j_hi >= j_lo) & (i_hi >= 0) & (j_hi >= 0) & (i_lo < n) & (j_lo < n)
    span_i = i_hi - i_lo + 1
    span_j = j_hi - j_lo + 1

    def paint(idx: np.ndarray, i: np.ndarray, j: np.ndarray) -> None:
        px, pz = i + 0.5, j + 0.5
        d = det[idx]
        l0 = ((z1[idx] - z2[idx]) * (px - x2[idx]) + (x2[idx] - x1[idx]) * (pz - z2[idx])) / d
        l1 = ((z2[idx] - z0[idx]) * (px - x2[idx]) + (x0[idx] - x2[idx]) * (pz - z2[idx])) / d
        l2 = 1.0 - l0 - l1
        inside = (l0 >= -1e-9) & (l1 >= -1e-9) & (l2 >= -1e-9) & (i >= 0) & (i < n) & (j >= 0) & (j < n)
        out[j[inside], i[inside]] = (l0 * h0[idx] + l1 * h1[idx] + l2 * h2[idx])[inside]

    idx = np.nonzero(ok & (span_i <= small) & (span_j <= small))[0]
    for di in range(small):
        sub = idx[span_i[idx] > di]
        for dj in range(small):
            sub2 = sub[span_j[sub] > dj]
            if len(sub2):
                paint(sub2, i_lo[sub2] + di, j_lo[sub2] + dj)
    for t in np.nonzero(ok & ((span_i > small) | (span_j > small)))[0]:
        a, c = max(i_lo[t], 0), min(i_hi[t], n - 1)
        b, d = max(j_lo[t], 0), min(j_hi[t], n - 1)
        if c < a or d < b:
            continue
        jj, ii = np.meshgrid(np.arange(b, d + 1), np.arange(a, c + 1), indexing="ij")
        paint(np.full(ii.size, t), ii.ravel(), jj.ravel())
    return out


def cmd_prep() -> None:
    """Triangle caches: DEM per 2nd mesh (the 480 MB TIN files) and every WaterBody triangle."""
    import plateau_citygml as pc
    STREAM_CACHE.mkdir(parents=True, exist_ok=True)
    for sec in sorted({c[:6] for c in mesh3_codes()}):
        npz = CACHE / f"dem_tris_{sec}.npz"
        if not npz.exists():
            print("dem", sec, flush=True)
            pc.load_dem_triangles(str(DATA / f"udx/dem/{sec}_dem_6697_op.gml"),
                                  {f"{sec}{i}{j}" for i in range(10) for j in range(10)}, str(npz))
    out = STREAM_CACHE / "water_tris.npz"
    if out.exists():
        return
    pc.Q["wtr"] = "{http://www.opengis.net/citygml/waterbody/2.0}"
    tris, cls = [], []
    for p in sorted((DATA / "udx/wtr").glob("*_wtr_6697_op.gml")):
        for f in pc.iter_deep(str(p), pc.Q["wtr"] + "WaterBody"):
            for shell, _ in f.lods[max(f.lods)]:
                v = shell[:-1]
                for k in range(1, len(v) - 1):    # fan; PLATEAU water surfaces are already triangles
                    tris.append(np.array([v[0], v[k], v[k + 1]]))
                    cls.append(int(f.function or 0))
        print("water", p.name, len(tris), flush=True)
    np.savez_compressed(out, tris=np.array(tris, np.float64), cls=np.array(cls, np.int32))


@dataclass
class Window:
    code: str
    ox: int      # global cell of the window's x=0
    oz: int
    size: int
    rect: tuple[float, float, float, float]


def window_of(code: str, margin: float = 400.0) -> Window:
    f = frame()
    r = mesh_rect(code)
    ox = int(math.floor(r[0] - f.gx0 - margin))
    oz = int(math.floor(f.gtop - r[3] - margin))
    size = int(math.ceil(max(r[1] - r[0], r[3] - r[2]) + 2 * margin))
    return Window(code, ox, oz, size, r)


_npz_handles: dict[str, "np.lib.npyio.NpzFile"] = {}


def _dem_tris(mesh: str) -> np.ndarray | None:
    path = CACHE / f"dem_tris_{mesh[:6]}.npz"
    if not path.exists():
        return None
    z = _npz_handles.setdefault(str(path), np.load(path))
    return z[mesh] if mesh in z.files else None


def raster_tile(code: str) -> str:
    """One 3rd mesh -> its window of 2.5D layers (+ sparse voxels), written to cache/stream/tiles/<code>.npz."""
    import plateau_voxelize as pv
    pc = pv.pc
    out = TILES / f"{code}.npz"
    if out.exists():
        return code
    t0 = time.time()
    f = frame()
    w = window_of(code)
    S = w.size
    b = pv.Box(code, f.gx0 + w.ox, f.gtop - w.oz - S, S, 1)
    g = pv.Grid(b)
    meshes = pv.covering_meshes(b, margin=0)

    def to_cells(tris: np.ndarray) -> np.ndarray:
        c = g.to_cell(tris.reshape(-1, 3)).reshape(-1, 3, 3)
        keep = (c[:, :, 0].max(1) >= 0) & (c[:, :, 0].min(1) <= S) & (c[:, :, 1].max(1) >= 0) & (c[:, :, 1].min(1) <= S)
        return c[keep]

    # ---- ground and water surfaces (TIN triangles, rasterised exactly)
    dem = [t for t in (_dem_tris(m) for m in meshes) if t is not None]
    H = raster_tris(to_cells(np.concatenate(dem)), S) if dem else np.full((S, S), np.nan, np.float32)
    wt = np.load(STREAM_CACHE / "water_tris.npz")["tris"]
    W = raster_tris(to_cells(wt), S)

    # ---- roads: LOD1 Road polygons, replaced by LOD2/3 traffic areas where the mesh has them
    RC = np.zeros((S, S), np.uint8)
    RC_lod = np.zeros((S, S), np.uint8)
    deck = np.full((S, S), np.nan, np.float32)
    n_road = {"road_lod1": 0, "area_lod2": 0, "area_lod3": 0}
    p = DATA / f"udx/tran/{code}_tran_6697_op.gml"
    feats = list(pc.iter_tran(str(p))) if p.exists() else []
    for pass_lods in ((1,), (2, 3)):
        for ft in feats:
            lk = pv.best_lod(ft.lods)
            lod = int(lk[3])
            if lod not in pass_lods:
                continue
            if ft.kind == "Road":
                cls = pv.ROAD
            elif ft.kind == "TrafficArea":
                cls = pv.SIDEWALK if ft.function in pv.SIDEWALK_FN else pv.ROAD
            else:
                cls = pv.SIDEWALK if ft.function in pv.AUX_SIDEWALK else pv.VEG if ft.function in pv.AUX_PLANT else pv.ROAD
            hit = False
            for shell, holes in ft.lods[lk]:
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
                n_road["road_lod1" if ft.kind == "Road" else f"area_lod{lod}"] += 1

    # ---- buildings: up-facing polygons of the best LOD -> roof z-buffer
    BH = np.full((S, S), -np.inf, np.float32)
    n_b = {"lod1": 0, "lod2": 0, "lod3": 0}
    p = DATA / f"udx/bldg/{code}_bldg_6697_op.gml"
    if p.exists():
        for ft in pc.iter_bldg(str(p)):
            by_lod: dict[int, list] = {}
            for k, v in ft.lods.items():
                if v:
                    by_lod.setdefault(int(k[3]), []).extend(v)
            if not by_lod:
                continue
            lod = max(by_lod)
            polys = by_lod[lod]
            if not g.overlaps(np.vstack([q[0] for q in polys])):
                continue
            n_b[f"lod{lod}"] += 1
            for shell, holes in polys:
                if pv.up_normal(shell) < 0.3:
                    continue
                r = g.poly_cells(shell, holes)
                if r is None:
                    continue
                zi, xi, h = r
                BH[zi, xi] = np.maximum(BH[zi, xi], h)
    BH[~np.isfinite(BH)] = np.nan

    # ---- thin things: bridges, trees, poles, furniture -> (x, z, y0, y1, class) column spans
    spans: list[np.ndarray] = []
    n_f = {"bridge": 0, "tree": 0, "plantcover": 0, "pole": 0, "furniture": 0, "fence": 0, "skipped_flat": 0}

    def add_points(pts: np.ndarray, cls: int, fill_cols: bool) -> None:
        c = g.to_cell(pts)
        i, j = np.floor(c[:, 0]).astype(np.int64), np.floor(c[:, 1]).astype(np.int64)
        k = np.floor(c[:, 2] - GZ).astype(np.int64)
        ok = (i >= 0) & (i < S) & (j >= 0) & (j < S) & (k >= 0) & (k < NY_MAX)
        i, j, k = i[ok], j[ok], k[ok]
        if len(i) == 0:
            return
        col = j * S + i
        order = np.lexsort((k, col))
        col, k = col[order], k[order]
        starts = np.r_[0, np.nonzero(np.diff(col))[0] + 1]
        k0 = np.minimum.reduceat(k, starts)
        k1 = np.maximum.reduceat(k, starts) if fill_cols else k0
        cc = col[starts]
        rows = np.column_stack([cc % S + w.ox, cc // S + w.oz, k0, k1, np.full(len(cc), cls)])
        if not fill_cols:   # single voxels: every sample is its own span
            rows = np.unique(np.column_stack([i + w.ox, j + w.oz, k, k, np.full(len(k), cls)]), axis=0)
        spans.append(rows.astype(np.int32))

    p = DATA / f"udx/brid/{code}_brid_6697_op.gml"
    if p.exists():
        for ft in pc.iter_deep(str(p), pc.Q["brid"] + "Bridge"):
            polys = ft.lods[pv.best_lod(ft.lods)]
            if g.overlaps(np.vstack([q[0] for q in polys])):
                add_points(pv.sample_surface(polys, 0.6), pv.BRIDGE, True)
                n_f["bridge"] += 1
    p = DATA / f"udx/veg/{code}_veg_6697_op.gml"
    if p.exists():
        for tag, key in (("SolitaryVegetationObject", "tree"), ("PlantCover", "plantcover")):
            for ft in pc.iter_deep(str(p), pc.Q["veg"] + tag):
                lk = pv.best_lod(ft.lods)
                polys = ft.lods[lk]
                if not g.overlaps(np.vstack([q[0] for q in polys])):
                    continue
                n_f[key] += 1
                if lk == "lod1" and key == "plantcover":
                    for shell, holes in polys:
                        r = g.poly_cells(shell, holes)
                        if r is not None:
                            zi, xi, _ = r
                            weak = RC[zi, xi] == 0
                            RC[zi[weak], xi[weak]] = pv.VEG   # RC_lod stays 0: any road or sidewalk from another tile wins
                else:
                    add_points(pv.sample_surface(polys, 0.5), pv.VEG, True)
    p = DATA / f"udx/frn/{code}_frn_6697_op.gml"
    if p.exists():
        for ft in pc.iter_deep(str(p), pc.Q["frn"] + "CityFurniture"):
            polys = ft.lods[pv.best_lod(ft.lods)]
            if not g.overlaps(np.vstack([q[0] for q in polys])):
                continue
            if ft.function in pv.FURN_SKIP:
                n_f["skipped_flat"] += 1
                continue
            if ft.function in pv.FURN_POLE:
                cls, key = pv.POLE, "pole"
            elif ft.function == "2000":
                cls, key = pv.FENCE, "fence"
            else:
                cls, key = pv.FURN, "furniture"
            add_points(pv.sample_surface(polys, 0.3), cls, False)
            n_f[key] += 1
    sp = np.concatenate(spans) if spans else np.zeros((0, 5), np.int32)

    TILES.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp.npz")
    np.savez_compressed(tmp, win=np.array([w.ox, w.oz, S]), H=H, W=W, RC=RC, RC_lod=RC_lod, BH=BH.astype(np.float32),
                        deck=deck, spans=sp, rect=np.array(w.rect))
    tmp.rename(out)
    print(f"{code}: {time.time() - t0:5.1f}s road {n_road} bldg {n_b} objs {n_f} spans {len(sp)}", flush=True)
    return code


def cmd_raster(only: list[str]) -> None:
    codes = only or mesh3_codes()
    size = {c: sum((DATA / f"udx/{k}/{c}_{k}_6697_op.gml").stat().st_size
                   for k in ("bldg", "tran", "frn", "veg", "brid") if (DATA / f"udx/{k}/{c}_{k}_6697_op.gml").exists())
            for c in codes}
    codes.sort(key=lambda c: -size[c])
    if len(codes) == 1:
        raster_tile(codes[0])
        return
    with ProcessPoolExecutor(min(10, len(codes))) as ex:
        list(ex.map(raster_tile, codes))


# ----------------------------------------------------------------------------- merge

GLOBAL = STREAM_CACHE / "global"
LAYERS = {"H": np.float32, "W": np.float32, "RC": np.uint8, "RC_lod": np.uint8, "BH": np.float32, "deck": np.float32,
          "cover": np.uint8}


def open_global(mode: str = "r") -> dict[str, np.ndarray]:
    f = frame()
    if mode == "w+":
        return {k: np.lib.format.open_memmap(GLOBAL / f"{k}.npy", mode=mode, dtype=t, shape=(f.nz, f.nx))
                for k, t in LAYERS.items()}
    return {k: np.load(GLOBAL / f"{k}.npy", mmap_mode=mode) for k in LAYERS}


def cmd_merge() -> None:
    """Paste every tile window into global 8192 x 7680 layers (memmapped .npy) and the span list."""
    f = frame()
    GLOBAL.mkdir(parents=True, exist_ok=True)
    G = open_global("w+")
    G["H"][:] = np.nan
    G["W"][:] = np.nan
    G["BH"][:] = np.nan
    G["deck"][:] = np.nan
    spans = []
    for code in mesh3_codes():
        z = np.load(TILES / f"{code}.npz")
        ox, oz, S = (int(v) for v in z["win"])
        gx0, gz0, gx1, gz1 = max(ox, 0), max(oz, 0), min(ox + S, f.nx), min(oz + S, f.nz)
        wx0, wz0 = gx0 - ox, gz0 - oz
        sx, sz = slice(gx0, gx1), slice(gz0, gz1)
        wsx, wsz = slice(wx0, wx0 + gx1 - gx0), slice(wz0, wz0 + gz1 - gz0)
        for k in ("H", "W"):
            cur, new = np.array(G[k][sz, sx]), z[k][wsz, wsx]
            take = np.isnan(cur) & ~np.isnan(new)
            cur[take] = new[take]
            G[k][sz, sx] = cur
        for k in ("BH", "deck"):
            G[k][sz, sx] = np.fmax(G[k][sz, sx], z[k][wsz, wsx])
        rc, rl = np.array(G["RC"][sz, sx]), np.array(G["RC_lod"][sz, sx])
        nrc, nrl = z["RC"][wsz, wsx], z["RC_lod"][wsz, wsx]
        take = (nrc > 0) & ((nrl > rl) | (rc == 0) | (nrl == rl))
        rc[take] = nrc[take]
        rl[take] = nrl[take]
        G["RC"][sz, sx], G["RC_lod"][sz, sx] = rc, rl
        e0, e1, n0, n1 = z["rect"]       # the mesh's own area, grown 3 m so skewed neighbours leave no seam
        cx0, cx1 = int(e0 - f.gx0) - 3, int(math.ceil(e1 - f.gx0)) + 3
        cz0, cz1 = int(f.gtop - n1) - 3, int(math.ceil(f.gtop - n0)) + 3
        G["cover"][max(cz0, 0):max(cz1, 0), max(cx0, 0):max(cx1, 0)] = 1
        spans.append(z["spans"])
    sp = np.unique(np.concatenate(spans), axis=0)
    np.save(GLOBAL / "spans.npy", sp)
    for a in G.values():
        a.flush()
    cover = G["cover"]
    print(f"merged: covered {int(cover.sum()) / 1e6:.1f} M cells ({cover.sum() / cover.size:.0%} of the box), {len(sp)} spans")


def cmd_preview() -> None:
    """Quick look at the merged layers (height, water, roads, buildings), 1 px per 4 m."""
    from PIL import Image
    G = open_global()
    sub = (slice(None, None, 4), slice(None, None, 4))
    H, W, BH, RC, cover = (np.asarray(G[k][sub]) for k in ("H", "W", "BH", "RC", "cover"))
    img = np.full(H.shape + (3,), 255, np.uint8)
    land = ~np.isnan(H)
    img[land] = np.clip(60 + 6 * H[land], 0, 255).astype(np.uint8)[:, None]
    img[np.isnan(H) & (cover > 0)] = (200, 120, 120)
    img[~np.isnan(W)] = (60, 90, 200)
    img[RC > 0] = (90, 90, 90)
    img[~np.isnan(BH)] = (230, 190, 90)
    STREAM_CACHE.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img).save(STREAM_CACHE / "preview.png")
    print("wrote", STREAM_CACHE / "preview.png", img.shape)


# ----------------------------------------------------------------------------- pack

AIR, GROUND, ROAD, SIDEWALK, BUILDING, ROOF, VEG, POLE, WATER, RAIL, BRIDGE, FURN, FENCE = range(13)
BORDER = 16   # cells of L0 context around a supertile, so that a 16 m cell still has one neighbour ring
REGION = SUPER + 2 * BORDER

# Pooling: when a 2x2x2 block holds several classes, the thin things win first (see src/lab/pool.ts, same order).
_ORDER = [POLE, FURN, FENCE, VEG, ROOF, BUILDING, BRIDGE, RAIL, WATER, SIDEWALK, ROAD, GROUND]
RANK = np.full(256, 255, np.uint8)
CLS_OF = np.zeros(256, np.uint8)
for _i, _c in enumerate(_ORDER):
    RANK[_c] = _i
    CLS_OF[_i] = _c
THIN_RANK = 2     # pole, furniture, fence
VEG_RANK = 3


def pool2(c: np.ndarray, level: int) -> np.ndarray:
    """(ny, nz, nx) -> half size per axis. A block is solid when at least half of its 8 cells are; poles, furniture and
    fences survive only to 2 m cells (they would become giant black cubes), foliage when a quarter is filled."""
    ny, nz, nx = c.shape
    if level >= 2:
        c = np.where(RANK[c] <= THIN_RANK, 0, c).astype(np.uint8)
    shape = (ny // 2, 2, nz // 2, 2, nx // 2, 2)
    best = RANK[c].reshape(shape).min(axis=(1, 3, 5))
    cnt = (c != 0).reshape(shape).sum(axis=(1, 3, 5), dtype=np.uint8)
    solid = (cnt >= 4) | ((best <= THIN_RANK) & (level == 1)) | ((best == VEG_RANK) & (cnt >= 2))
    return np.where(solid, CLS_OF[best], 0).astype(np.uint8)


_G: dict[str, np.ndarray] = {}
_SPANS: list[np.ndarray] = []


def compose_region(sx: int, sz: int) -> np.ndarray | None:
    """The L0 voxels of supertile (sx, sz) plus BORDER cells around it: (ny, REGION, REGION) uint8, or None if empty."""
    from scipy.ndimage import distance_transform_edt
    f = frame()
    if not _G:
        _G.update(open_global("r"))
        _SPANS.append(np.load(GLOBAL / "spans.npy"))
    x0, z0 = sx * SUPER - BORDER, sz * SUPER - BORDER
    gx0, gx1, gz0, gz1 = max(x0, 0), min(x0 + REGION, f.nx), max(z0, 0), min(z0 + REGION, f.nz)

    def grab(name: str, fill: float) -> np.ndarray:
        a = np.full((REGION, REGION), fill, _G[name].dtype)
        a[gz0 - z0:gz1 - z0, gx0 - x0:gx1 - x0] = _G[name][gz0:gz1, gx0:gx1]
        return a

    cover = grab("cover", 0) > 0
    if not cover.any():
        return None
    H, W, BH, deck = grab("H", np.nan), grab("W", np.nan), grab("BH", np.nan), grab("deck", np.nan)
    RC = grab("RC", 0)

    nanH = np.isnan(H)
    if nanH.all():
        Hf = np.zeros_like(H)
    elif nanH.any():
        idx = distance_transform_edt(nanH, return_distances=False, return_indices=True)
        Hf = H[idx[0], idx[1]]
    else:
        Hf = H
    water = cover & ~np.isnan(W) & (nanH | (H <= W + 0.5))
    k_of = lambda h: np.ceil(np.nan_to_num(h) - GZ).astype(np.int32) - 1   # noqa: E731  voxel holding a surface at height h
    surf = np.clip(np.where(water, k_of(W), k_of(Hf)), 1, NY_MAX - 8)
    surf_cls = np.where(RC > 0, RC, np.where(water, WATER, GROUND)).astype(np.uint8)
    bm = cover & ~np.isnan(BH)
    top = np.clip(np.where(bm, np.maximum(k_of(BH), surf), surf), 1, NY_MAX - 8)
    dm = cover & ~np.isnan(deck)
    dk = np.clip(k_of(deck), 0, NY_MAX - 8)

    sp = _SPANS[0]
    sel = sp[(sp[:, 0] >= x0) & (sp[:, 0] < x0 + REGION) & (sp[:, 1] >= z0) & (sp[:, 1] < z0 + REGION)]
    top_k = max(int(top[cover].max()), int(dk[dm].max()) if dm.any() else 0, int(sel[:, 3].max()) if len(sel) else 0)
    ny = max(16, -(-(top_k + 2) // 16) * 16)

    grid = np.zeros((ny, REGION, REGION), np.uint8)
    kk = np.arange(ny, dtype=np.int32)[:, None, None]
    grid[(kk < surf[None]) & cover[None]] = GROUND
    zi, xi = np.nonzero(cover)
    grid[surf[zi, xi], zi, xi] = surf_cls[zi, xi]
    fill = bm[None] & (kk >= surf[None]) & (kk <= top[None])
    grid[fill] = BUILDING
    zb, xb = np.nonzero(bm)
    grid[top[zb, xb], zb, xb] = ROOF
    zd, xd = np.nonzero(dm)
    grid[dk[zd, xd], zd, xd] = BRIDGE
    if len(sel):
        n = sel[:, 3] - sel[:, 2] + 1
        rep = np.repeat(np.arange(len(sel)), n)
        y = sel[rep, 2] + np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)
        grid[y, sel[rep, 1] - z0, sel[rep, 0] - x0] = sel[rep, 4].astype(np.uint8)
    return grid


def encode_chunk(win: np.ndarray) -> tuple[bytes, int] | None:
    """(ny, SPAN, SPAN) cells -> (deflate-raw blob, height in cells); None when the 32 x 32 interior is all air.
    Blob layout is documented in src/cubeworld/stream/format.ts decodeChunk."""
    ny = win.shape[0]
    if not win[:, 1:CHUNK + 1, 1:CHUNK + 1].any():
        return None
    top = int(np.nonzero(win.reshape(ny, -1).any(axis=1))[0].max()) + 1
    cols = np.ascontiguousarray(win[:top].reshape(top, -1).T)          # (SPAN*SPAN, top): one row per column
    nonair = cols != 0
    last = top - np.argmax(nonair[:, ::-1], axis=1)                     # one past the highest solid cell
    last[~nonair.any(axis=1)] = 0
    start = np.empty(cols.shape, bool)
    start[:, 0] = True
    start[:, 1:] = cols[:, 1:] != cols[:, :-1]
    start &= np.arange(top)[None, :] < last[:, None]
    counts = start.sum(axis=1)
    assert counts.max() < 256
    pos = np.nonzero(start.ravel())[0]
    col, y = pos // top, pos % top
    cls = cols.ravel()[pos]
    same = np.r_[col[1:] == col[:-1], False]
    length = np.where(same, np.r_[y[1:], 0], last[col]) - y
    wide = int(length.max()) > 255 if len(length) else False
    head = struct.pack("<BBHI", 1, 1 if wide else 0, top, len(pos))
    raw = head + counts.astype(np.uint8).tobytes() + cls.astype(np.uint8).tobytes() + length.astype("<u2" if wide else np.uint8).tobytes()
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    return co.compress(raw) + co.flush(), top


def pack_supertile(job: tuple[int, int]) -> tuple[list[tuple[int, int, int, int, bytes]], np.ndarray | None]:
    """All chunks of one supertile for the fine LODs: (level, cx, cz, height, blob) with cx/cz global at that level,
    plus the supertile's 16 m voxels (32 x 32 columns), from which the coarse LODs are pooled."""
    sx, sz = job
    grid = compose_region(sx, sz)
    out: list[tuple[int, int, int, int, bytes]] = []
    if grid is None:
        return out, None
    core = None
    for level in range(FINE_LEVELS):
        if level:
            grid = pool2(grid, level)
        off = BORDER >> level
        per = (SUPER // CHUNK) >> level          # chunks per supertile side at this level
        for lz in range(per):
            for lx in range(per):
                x0, z0 = off + lx * CHUNK - PAD, off + lz * CHUNK - PAD
                enc = encode_chunk(grid[:, z0:z0 + SPAN, x0:x0 + SPAN])
                if enc is not None:
                    out.append((level, sx * per + lx, sz * per + lz, enc[1], enc[0]))
        if level == FINE_LEVELS - 1:
            core = grid[:, off:off + CHUNK, off:off + CHUNK].copy()
    return out, core


def coarse_levels(core4: dict[tuple[int, int], np.ndarray], f: Frame) -> list[tuple[int, int, int, int, bytes]]:
    """Levels 5 and 6 (32 m and 64 m cubes): the whole ward's 16 m voxels are only 512 x 480 x 32 bytes, so the top
    of the pyramid is pooled from one global array instead of per supertile. These are the first chunks a client needs."""
    ny4 = max((c.shape[0] for c in core4.values()), default=1)
    ny4 = -(-ny4 // 4) * 4
    w = np.zeros((ny4, f.nz // 16, f.nx // 16), np.uint8)
    for (sx, sz), c in core4.items():
        w[:c.shape[0], sz * CHUNK:(sz + 1) * CHUNK, sx * CHUNK:(sx + 1) * CHUNK] = c
    out: list[tuple[int, int, int, int, bytes]] = []
    for level in range(FINE_LEVELS, LEVELS):
        w = pool2(w, level)
        if w.shape[1] % 2 or w.shape[2] % 2 or w.shape[0] % 2:
            w = np.pad(w, ((0, w.shape[0] % 2), (0, w.shape[1] % 2), (0, w.shape[2] % 2)))
        padded = np.pad(w, ((0, 0), (PAD, CHUNK), (PAD, CHUNK)))
        for cz in range(-(-w.shape[1] // CHUNK)):
            for cx in range(-(-w.shape[2] // CHUNK)):
                enc = encode_chunk(padded[:, cz * CHUNK:cz * CHUNK + SPAN, cx * CHUNK:cx * CHUNK + SPAN])
                if enc is not None:
                    out.append((level, cx, cz, enc[1], enc[0]))
    return out


def morton(x: int, z: int) -> int:
    m = 0
    for b in range(14):
        m |= ((x >> b) & 1) << (2 * b) | ((z >> b) & 1) << (2 * b + 1)
    return m


THEMES = [
    # id, icon, label, EPSG:6677 (e, n) or (lat, lon), zoom
    ("shimbashi", "pole", "Shimbashi LOD3 avenue, poles and trees", ("xy", -7120.0, -37200.0), 1.3),
    ("tower", "tower", "Tokyo Tower, Shiba Park", ("ll", 35.65861, 139.74544), 0.5),
    ("yakkozaka", "house", "Yakkozaka (奴坂), a slope in Minami-Azabu", ("xy", -9282.0, -38811.0), 1.2),
    ("hills", "hill", "Roppongi Hills and Mori Tower", ("ll", 35.66045, 139.72936), 0.7),
    ("waterfront", "water", "Rainbow Bridge and the Odaiba waterfront", ("ll", 35.63640, 139.76330), 0.3),
]


def theme_defs() -> list[dict]:
    from pyproj import Transformer
    f = frame()
    to = Transformer.from_crs(4326, 6677, always_xy=True)
    out = []
    for tid, icon, name, pos, zoom in THEMES:
        e, n = (pos[1], pos[2]) if pos[0] == "xy" else to.transform(pos[2], pos[1])
        out.append({"id": tid, "icon": icon, "name": name, "x": round(e - f.gx0, 1), "z": round(f.gtop - n, 1), "zoom": zoom})
    return out


def cmd_pack(only: list[str]) -> None:
    f = frame()
    jobs = [(sx, sz) for sz in range(f.nz // SUPER) for sx in range(f.nx // SUPER)]
    if only:
        jobs = [(int(a), int(b)) for a, b in (s.split(",") for s in only)]
    t0 = time.time()
    per_super: dict[tuple[int, int], list] = {}
    core4: dict[tuple[int, int], np.ndarray] = {}
    with ProcessPoolExecutor(10) as ex:
        for n, (job, res) in enumerate(zip(jobs, ex.map(pack_supertile, jobs, chunksize=1)), 1):
            per_super[job], core = res
            if core is not None:
                core4[job] = core
            if n % 20 == 0 or n == len(jobs):
                print(f"  {n}/{len(jobs)} supertiles, {time.time() - t0:.0f}s", flush=True)

    top_chunks = coarse_levels(core4, f)
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*"):
        old.unlink()
    levels = [{"level": lv, "cell": 1 << lv, "ncx": -(-f.nx // (CHUNK << lv)), "ncz": -(-f.nz // (CHUNK << lv))} for lv in range(LEVELS)]
    offsets = [np.zeros(lv["ncx"] * lv["ncz"], np.uint32) for lv in levels]
    lengths = [np.zeros(lv["ncx"] * lv["ncz"], np.uint32) for lv in levels]
    heights = [np.zeros(lv["ncx"] * lv["ncz"], np.uint16) for lv in levels]
    seen: dict[bytes, tuple[int, int]] = {}
    total = unique = 0
    by_level = [0] * LEVELS
    cursor = 0
    chunks_tmp = OUT / "chunks.tmp"
    with open(chunks_tmp, "wb") as fh:
        ordered = sorted(top_chunks, key=lambda r: (-r[0], morton(r[1], r[2])))
        for job in sorted(per_super, key=lambda j: morton(*j)):
            # coarse first inside a supertile, so the first bytes of a region are the cheap overview
            ordered += sorted(per_super[job], key=lambda r: (-r[0], morton(r[1], r[2])))
        for level, cx, cz, h, blob in ordered:
            if blob not in seen:
                seen[blob] = (cursor, len(blob))
                fh.write(blob)
                cursor += len(blob)
                unique += 1
            o, n = seen[blob]
            i = cz * levels[level]["ncx"] + cx
            offsets[level][i], lengths[level][i], heights[level][i] = o, n, h
            total += 1
            by_level[level] += 1
    dir_raw = bytearray()
    for lv in range(LEVELS):
        for arr in (offsets[lv], lengths[lv], heights[lv]):
            dir_raw += arr.astype("<u4" if arr.dtype == np.uint32 else "<u2").tobytes()
            dir_raw += b"\0" * (-len(dir_raw) % 4)
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    dir_blob = co.compress(bytes(dir_raw)) + co.flush()
    h = hashlib.sha1(dir_blob)
    with open(chunks_tmp, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    digest = h.hexdigest()[:10]
    chunks_tmp.rename(OUT / f"chunks.{digest}.bin")
    (OUT / f"dir.{digest}.bin").write_bytes(dir_blob)
    manifest = {
        "format": 1, "hash": digest,
        "source": "PLATEAU 3D city model Minato-ku FY2025 (CityGML 2.0, spec v5): bldg LOD1-3, tran LOD1-3, frn/veg/brid, wtr, dem",
        "attribution": "出典：国土交通省 3D都市モデル（Project PLATEAU）東京都港区（令和7年度）を加工して作成 / "
                       "Source: MLIT Project PLATEAU, Minato-ku FY2025 3D city model, processed into voxels (PDL 1.0 / CC BY 4.0)",
        "frame": {"epsg": 6677, "gx0": f.gx0, "gtop": f.gtop, "nx": f.nx, "nz": f.nz, "gz": GZ},
        "chunk": CHUNK, "levels": levels,
        "files": {"dir": f"dir.{digest}.bin", "chunks": f"chunks.{digest}.bin"},
        "bytes": {"dir": len(dir_blob), "chunks": cursor},
        "counts": {"chunks": total, "uniqueChunks": unique, "byLevel": by_level},
        "themes": theme_defs(),
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"packed {total} chunks ({unique} unique) {by_level}: chunks {cursor / 1e6:.1f} MB, dir {len(dir_blob) / 1e3:.0f} KB, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "fetch":
        cmd_fetch()
    elif cmd == "prep":
        cmd_prep()
    elif cmd == "raster":
        cmd_raster(sys.argv[2:])
    elif cmd == "merge":
        cmd_merge()
    elif cmd == "preview":
        cmd_preview()
    elif cmd == "pack":
        cmd_pack(sys.argv[2:])
    else:
        print(__doc__)
