"""PLATEAU FY2025 Tokyo wards -> streamable chunk archive for src/cubeworld/stream (see research/cubeworld-streaming.md).

The area (EPSG:6677 frame and the wards that fill it) is pipeline/cubeworld/stream_area.json.

    V=pipeline/cache/cubeworld/venv/bin/python
    $V pipeline/cubeworld/stream_build.py fetch      # list each ward zip, then range-request every 3rd-mesh CityGML member inside the frame
    $V pipeline/cubeworld/stream_build.py prep       # DEM triangle caches (parses the 0.2-1 GB TIN files) + water triangles
    $V pipeline/cubeworld/stream_build.py raster     # per 3rd-mesh tile (10 processes): DEM, roads, water, buildings, objects
    $V pipeline/cubeworld/stream_build.py merge      # paste the tiles into frame-sized global layers (+ `preview` writes a PNG of them)
    $V pipeline/cubeworld/stream_build.py pack [--out DIR]   # train the codec, supertiles -> 7-level pyramid -> public/stream-next/

Output: manifest.json, dir.<hash>.bin (deflate-raw: the chunk codec's frequency tables, then each chunk's length and
height), chunks.<hash>-<n>.bin (16 MiB shards; every chunk one blob, read with HTTP range requests). The chunk codec is
stream_codec.py; the wire format is documented in src/cubeworld/stream/format.ts. `pack` takes about 7 minutes (the
entropy coder is plain Python on 10 cores) and writes to public/stream-next/, so a running dev page keeps working; the
dev server reloads on any write below public/, so build with `--out pipeline/cache/cubeworld/out-next` and swap with
`mv public/stream public/stream-old && cp -R pipeline/cache/cubeworld/out-next public/stream`.

The whole area is rasterised once into 2.5D layers at 1 m (DEM height, surface class, building roof height, water)
plus sparse voxels for thin things (trees, poles, bridge decks). Chunks are cut from those layers; coarser LODs are
priority-pooled from the finer one. The parsing and rasterising helpers are imported from plateau_voxelize.py and
plateau_citygml.py, not copied.

A 3rd mesh on a ward boundary is in both wards' zips, each file holding that ward's part. The tile reads every ward's
file for its mesh and keeps one copy of each gml:id.
"""
from __future__ import annotations

import functools
import hashlib
import json
import math
import sys
import threading
import time
import zlib
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Iterator

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import stream_codec as sc  # noqa: E402

ROOT = HERE.parents[1]
CACHE = ROOT / "pipeline" / "cache" / "cubeworld"
PLATEAU = CACHE / "plateau2025"
LISTINGS = CACHE / "listings"
STREAM_CACHE = CACHE / "stream"
OUT = ROOT / "public" / "stream-next"
AREA = json.loads((HERE / "stream_area.json").read_text())
WARDS: list[dict] = AREA["wards"]

# CityGML members that feed the build. luse (1.5 GB) and fld/htd/urf are skipped on purpose.
KINDS = ("bldg", "tran", "frn", "veg", "brid", "wtr", "dem")


def ward_dir(w: dict) -> Path:
    """Where a ward's extracted udx/ lives (Minato's was fetched before the multi-ward build and keeps its old dir)."""
    return CACHE / w["dir"] if "dir" in w else PLATEAU / w["code"]


@functools.cache
def _plan() -> dict[str, list[tuple[str, int, int]]]:
    """ward code -> (member, uncompressed size, compressed size) of every top-level udx/<kind>/<mesh>_<kind>_6697[_xx]_op.gml
    whose mesh (3rd, or 2nd for wtr and dem) touches the frame. Boundary meshes are in several ward zips, mostly as the same
    file: a member with the same name, size and CRC as one of an earlier ward is left to that ward (never fetched twice)."""
    seen: set[tuple[str, int, str]] = set()
    out: dict[str, list[tuple[str, int, int]]] = {}
    for w in WARDS:
        mine = []
        for line in (LISTINGS / f"{w['code']}.txt").read_text().splitlines():
            parts = line.split(" ", 3)
            if len(parts) != 4:
                continue
            size, comp, crc, name = parts
            p = name.split("/")
            if len(p) == 3 and p[0] == "udx" and p[1] in KINDS and p[2].endswith("_op.gml") and mesh_in_frame(p[2].split("_")[0]):
                if (name, int(size), crc) not in seen:
                    seen.add((name, int(size), crc))
                    mine.append((name, int(size), int(comp)))
        out[w["code"]] = sorted(mine)
    return out


def ward_members(w: dict) -> list[tuple[str, int, int]]:
    return _plan()[w["code"]]


def mesh3_codes() -> list[str]:
    """3rd-mesh codes that carry buildings or roads in some ward and touch the frame: the area the archive covers."""
    return sorted({Path(m).name.split("_")[0] for w in WARDS for m, _, _ in ward_members(w)
                   if m.split("/")[1] in ("bldg", "tran")})


@functools.cache
def _tile_index() -> dict[tuple[str, str], list[Path]]:
    idx: dict[tuple[str, str], list[Path]] = {}
    for w in WARDS:
        for m, _, _ in ward_members(w):
            idx.setdefault((m.split("/")[1], Path(m).name.split("_")[0]), []).append(ward_dir(w) / m)
    return idx


def tile_paths(kind: str, code: str) -> list[Path]:
    """The files of one 3rd mesh and kind: one per distinct version among the wards that carry it."""
    return [p for p in _tile_index().get((kind, code), []) if p.exists()]


def cmd_listing() -> None:
    """Central directories of the ward zips (one small range request each), cached as `size compressed crc name` lines."""
    from remotezip import RemoteZip
    LISTINGS.mkdir(parents=True, exist_ok=True)
    for w in WARDS:
        out = LISTINGS / f"{w['code']}.txt"
        if out.exists():
            continue
        with RemoteZip(w["url"]) as z:
            out.write_text("\n".join(f"{i.file_size} {i.compress_size} {i.CRC:08x} {i.filename}" for i in z.infolist()))
        print("listed", w["code"], w["name"], flush=True)


def cmd_fetch(workers: int = 6) -> None:
    import os
    from remotezip import RemoteZip
    cmd_listing()
    todo = [(w, m, comp) for w in WARDS for m, _, comp in ward_members(w) if not (ward_dir(w) / m).exists()]
    print(f"{len(todo)} members to fetch, {sum(t[2] for t in todo) / 1e6:.0f} MB zipped", flush=True)
    local = threading.local()

    def get(job: tuple[dict, str, int]) -> int:
        w, member, comp = job
        zips = local.__dict__.setdefault("zips", {})
        for attempt in range(4):
            try:
                if w["code"] not in zips:
                    zips[w["code"]] = RemoteZip(w["url"])
                part = ward_dir(w) / ".part" / str(threading.get_ident())
                zips[w["code"]].extract(member, part)      # never leave a truncated file at the final path
                dest = ward_dir(w) / member
                dest.parent.mkdir(parents=True, exist_ok=True)
                os.replace(part / member, dest)
                return comp
            except Exception as e:                           # noqa: BLE001 network hiccup: new connection, retry
                zips.pop(w["code"], None)
                if attempt == 3:
                    raise
                print("  retry", member, type(e).__name__, e, flush=True)
                time.sleep(2 + 3 * attempt)
        return 0

    done = 0
    with ThreadPoolExecutor(workers) as ex:
        for i, n in enumerate(ex.map(get, todo), 1):
            done += n
            if i % 20 == 0 or i == len(todo):
                print(f"  [{i}/{len(todo)}] {done / 1e6:.0f} MB zipped fetched", flush=True)


# ----------------------------------------------------------------------------- frame

CHUNK = 32            # cells per chunk side, at every LOD
PAD = 1              # ring of neighbour cells stored with each chunk so it meshes alone
SPAN = CHUNK + 2 * PAD
SUPER = 512           # metres per supertile = one chunk at the coarsest LOD (16 m cells)
LEVELS = 7            # cell size 1, 2, 4, 8, 16, 32, 64 m
FINE_LEVELS = 5       # levels 0-4 are cut per supertile; 5-6 are pooled from the whole area's 16 m grid
GZ = -12              # voxel y = floor(height above Tokyo Peil - GZ); the lowest DEM point is about -10 m
NY_MAX = 512
TILES = STREAM_CACHE / "tiles"


def mesh_bounds(code: str) -> tuple[float, float, float, float]:
    """JIS X 0410 mesh code -> (lat0, lat1, lon0, lon1). 3rd mesh (8 digits): 30 arc-seconds by 45; 2nd mesh (6): 5' by 7.5'."""
    p, u, q, v = int(code[0:2]), int(code[2:4]), int(code[4]), int(code[5])
    lat0 = (p * 40 + q * 5) / 60
    lon0 = 100 + u + v * 7.5 / 60
    if len(code) == 6:
        return lat0, lat0 + 5 / 60, lon0, lon0 + 7.5 / 60
    s, w = int(code[6]), int(code[7])
    lat0 += s * 0.5 / 60
    lon0 += w * 0.75 / 60
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
    f = AREA["frame"]
    assert f["nx"] % SUPER == 0 and f["nz"] % SUPER == 0, "frame must be whole supertiles"
    return Frame(f["gx0"], f["gtop"], f["nx"], f["nz"])


@functools.cache
def mesh_in_frame(code: str) -> bool:
    f = frame()
    e0, e1, n0, n1 = mesh_rect(code)
    return e1 > f.gx0 and e0 < f.gx0 + f.nx and n1 > f.gtop - f.nz and n0 < f.gtop

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


def _prep_dem(job: tuple[str, str]) -> str:
    import plateau_citygml as pc
    ward, member = job
    w = next(w for w in WARDS if w["code"] == ward)
    stem = Path(member).name.removesuffix("_op.gml")                       # 533935_dem_6697 or 533935_dem_6697_50
    npz = STREAM_CACHE / "dem" / f"{ward}_{stem}.npz"
    if npz.exists():
        return stem
    sec = stem[:6]
    names = {f"{sec}{i}{j}" for i in range(10) for j in range(10)}
    t0 = time.time()
    tmp = npz.with_name(npz.stem + ".tmp.npz")
    kept = pc.load_dem_triangles(str(ward_dir(w) / member), {c for c in names if mesh_in_frame(c)}, str(tmp))
    tmp.rename(npz)
    print(f"dem {ward} {stem}: {len(kept)} meshes, {sum(len(v) for v in kept.values()) / 1e6:.2f} M triangles, {time.time() - t0:.0f}s", flush=True)
    return stem


def cmd_prep() -> None:
    """Triangle caches: DEM per ward and 2nd-mesh file (the 0.2-1 GB TIN files, parsed in parallel; only the 3rd meshes
    that touch the frame are kept) and every WaterBody triangle near the frame, one copy per gml:id."""
    import plateau_citygml as pc
    (STREAM_CACHE / "dem").mkdir(parents=True, exist_ok=True)
    jobs = [(w["code"], m) for w in WARDS for m, _, _ in ward_members(w) if m.split("/")[1] == "dem"]
    jobs.sort(key=lambda j: -(ward_dir(next(w for w in WARDS if w["code"] == j[0])) / j[1]).stat().st_size)
    with ProcessPoolExecutor(6) as ex:
        list(ex.map(_prep_dem, jobs))
    out = STREAM_CACHE / "water_tris.npz"
    if out.exists():
        return
    pc.Q["wtr"] = "{http://www.opengis.net/citygml/waterbody/2.0}"
    f = frame()
    tris: list[np.ndarray] = []
    seen: set[str] = set()
    dropped = 0
    for w in WARDS:
        for m, _, _ in ward_members(w):
            if m.split("/")[1] != "wtr":
                continue
            for ft in pc.iter_deep(str(ward_dir(w) / m), pc.Q["wtr"] + "WaterBody"):
                if ft.gid in seen:
                    dropped += 1
                    continue
                seen.add(ft.gid)
                for shell, _ in ft.lods[max(ft.lods)]:
                    v = shell[:-1]
                    if len(v) >= 3:                                      # fan; PLATEAU water surfaces are already triangles
                        tris.append(np.stack([np.repeat(v[:1], len(v) - 2, 0), v[1:-1], v[2:]], axis=1))
            print("water", w["code"], Path(m).name, sum(len(t) for t in tris), f"({dropped} duplicate bodies dropped)", flush=True)
    t = np.concatenate(tris)
    near = ((t[:, :, 0].max(1) > f.gx0 - 500) & (t[:, :, 0].min(1) < f.gx0 + f.nx + 500)
            & (t[:, :, 1].max(1) > f.gtop - f.nz - 500) & (t[:, :, 1].min(1) < f.gtop + 500))
    np.savez_compressed(out, tris=t[near])
    print(f"water: {near.sum()} of {len(t)} triangles near the frame")


@dataclass
class Window:
    """A tile's raster window in absolute EPSG:6677 integers, so cached tiles do not depend on the frame."""
    code: str
    e0: int      # easting of the window's cell x=0
    ntop: int    # northing of its top edge (cell z=0)
    size: int
    rect: tuple[float, float, float, float]


def window_of(code: str, margin: float = 400.0) -> Window:
    r = mesh_rect(code)
    size = int(math.ceil(max(r[1] - r[0], r[3] - r[2]) + 2 * margin))
    return Window(code, int(math.floor(r[0] - margin)), int(math.ceil(r[3] + margin)), size, r)


_npz_handles: dict[str, "np.lib.npyio.NpzFile"] = {}


@functools.cache
def _dem_index() -> dict[str, list[Path]]:
    idx: dict[str, list[Path]] = {}
    for w in WARDS:
        for m, _, _ in ward_members(w):
            if m.split("/")[1] == "dem":
                p = STREAM_CACHE / "dem" / f"{w['code']}_{Path(m).name.removesuffix('_op.gml')}.npz"
                with np.load(p) as z:
                    for k in z.files:
                        idx.setdefault(k, []).append(p)
    return idx


def _dem_tris(mesh: str) -> np.ndarray | None:
    """Relief triangles of one 3rd mesh; a boundary mesh has a part in each ward's DEM file."""
    parts = [_npz_handles.setdefault(str(p), np.load(p))[mesh] for p in _dem_index().get(mesh, [])]
    return np.concatenate(parts) if parts else None


def iter_unique(paths: Iterable[Path], read: Callable[[str], Iterator]) -> Iterator:
    """Features of the same mesh from every ward's file, one copy per gml:id."""
    seen: set[str] = set()
    for p in paths:
        for ft in read(str(p)):
            if ft.gid is not None:
                if ft.gid in seen:
                    continue
                seen.add(ft.gid)
            yield ft


def raster_tile(code: str) -> str:
    """One 3rd mesh -> its window of 2.5D layers (+ sparse voxels), written to cache/stream/tiles/<code>.npz."""
    import plateau_voxelize as pv
    pc = pv.pc
    out = TILES / f"{code}.npz"
    if out.exists():
        return code
    t0 = time.time()
    w = window_of(code)
    S = w.size
    b = pv.Box(code, w.e0, w.ntop - S, S, 1)
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
    feats = list(iter_unique(tile_paths("tran", code), pc.iter_tran))
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
    for ft in iter_unique(tile_paths("bldg", code), pc.iter_bldg):
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
        rows = np.column_stack([cc % S, cc // S, k0, k1, np.full(len(cc), cls)])      # window-local x, z
        if not fill_cols:   # single voxels: every sample is its own span
            rows = np.unique(np.column_stack([i, j, k, k, np.full(len(k), cls)]), axis=0)
        spans.append(rows.astype(np.int32))

    def deep(kind: str, ns: str, tag: str) -> Iterator:
        return iter_unique(tile_paths(kind, code), lambda p: pc.iter_deep(p, pc.Q[ns] + tag))

    for ft in deep("brid", "brid", "Bridge"):
        polys = ft.lods[pv.best_lod(ft.lods)]
        if g.overlaps(np.vstack([q[0] for q in polys])):
            add_points(pv.sample_surface(polys, 0.6), pv.BRIDGE, True)
            n_f["bridge"] += 1
    for tag, key in (("SolitaryVegetationObject", "tree"), ("PlantCover", "plantcover")):
        for ft in deep("veg", "veg", tag):
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
    for ft in deep("frn", "frn", "CityFurniture"):
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
    np.savez_compressed(tmp, win=np.array([w.e0, w.ntop, S]), H=H, W=W, RC=RC, RC_lod=RC_lod, BH=BH.astype(np.float32),
                        deck=deck, spans=sp, rect=np.array(w.rect))
    tmp.rename(out)
    print(f"{code}: {time.time() - t0:5.1f}s road {n_road} bldg {n_b} objs {n_f} spans {len(sp)}", flush=True)
    return code


def cmd_raster(only: list[str]) -> None:
    codes = only or mesh3_codes()
    size = {c: sum(p.stat().st_size for k in ("bldg", "tran", "frn", "veg", "brid") for p in tile_paths(k, c)) for c in codes}
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
    """Paste every tile window into frame-sized global layers (memmapped .npy) and the span list."""
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
        e0, ntop, S = (int(v) for v in z["win"])
        ox, oz = e0 - int(f.gx0), int(f.gtop) - ntop          # window origin in frame cells
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
        s = z["spans"].copy()
        s[:, 0] += ox
        s[:, 1] += oz
        spans.append(s[(s[:, 0] >= 0) & (s[:, 0] < f.nx) & (s[:, 1] >= 0) & (s[:, 1] < f.nz)])
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


_MODEL: sc.Model | None = None       # set in every worker by _set_model
_TRAIN: sc.Counts | None = None      # when set, encode_chunk only counts symbols (the training pass)


def _set_model(model_bytes: bytes) -> None:
    global _MODEL
    _MODEL = sc.Model.from_bytes(model_bytes)


def encode_chunk(win: np.ndarray, level: int) -> tuple[bytes, int] | None:
    """(ny, SPAN, SPAN) cells -> (blob, height in cells); None when the 32 x 32 interior is all air.
    Blob layout and model: stream_codec.py; decoder: src/cubeworld/stream/format.ts decodeChunk."""
    if not win[:, PAD:CHUNK + PAD, PAD:CHUNK + PAD].any():
        return None
    if _TRAIN is not None:
        _TRAIN.add(level, sc.symbolize(win)[1])
        return None
    assert _MODEL is not None
    return sc.encode_blob(win, _MODEL, level)


def train_supertile(job: tuple[int, int]) -> sc.Counts:
    global _TRAIN
    _TRAIN = sc.Counts()
    try:
        pack_supertile(job)
        return _TRAIN
    finally:
        _TRAIN = None


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
                enc = encode_chunk(grid[:, z0:z0 + SPAN, x0:x0 + SPAN], level)
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
                enc = encode_chunk(padded[:, cz * CHUNK:cz * CHUNK + SPAN, cx * CHUNK:cx * CHUNK + SPAN], level)
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
    ("shimokitazawa", "house", "Shimokitazawa station, the dense low-rise grid (世田谷区)", ("ll", 35.66128, 139.66813), 1.0),
    ("morishita", "pole", "Morishita station, Koto-ku (east end of the map)", ("ll", 35.68800, 139.79750), 1.0),
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


SHARD_BITS = 24       # 16 MiB shard files: under every static host's per-file limit (Cloudflare Pages 25 MiB)


def slot_order(levels: list[dict]) -> list[tuple[int, int, int]]:
    """Every chunk slot (level, cx, cz) in file order; src/cubeworld/stream/format.ts parseDirectory walks the same order."""
    out: list[tuple[int, int, int]] = []
    for level in range(LEVELS - 1, FINE_LEVELS - 1, -1):
        lv = levels[level]
        out += [(level, cx, cz) for _, cx, cz in sorted((morton(cx, cz), cx, cz) for cz in range(lv["ncz"]) for cx in range(lv["ncx"]))]
    nsx, nsz = levels[0]["ncx"] // (SUPER // CHUNK), levels[0]["ncz"] // (SUPER // CHUNK)
    for _, sx, sz in sorted((morton(sx, sz), sx, sz) for sz in range(nsz) for sx in range(nsx)):
        for level in range(FINE_LEVELS - 1, -1, -1):
            per = (SUPER // CHUNK) >> level
            out += [(level, sx * per + lx, sz * per + lz) for _, lx, lz in sorted((morton(lx, lz), lx, lz) for lz in range(per) for lx in range(per))]
    return out


def cmd_pack(args: list[str]) -> None:
    global OUT
    if "--out" in args:
        i = args.index("--out")
        OUT = Path(args[i + 1]).resolve()
        args = args[:i] + args[i + 2:]
    only = args
    f = frame()
    jobs = [(sx, sz) for sz in range(f.nz // SUPER) for sx in range(f.nx // SUPER)]
    if only:
        jobs = [(int(a), int(b)) for a, b in (s.split(",") for s in only)]
    t0 = time.time()

    # pass 1: the codec's frequency tables, trained on every fourth supertile (they are static, shipped in dir.bin)
    counts = sc.Counts()
    with ProcessPoolExecutor(10) as ex:
        for c in ex.map(train_supertile, jobs[::4], chunksize=1):
            counts.merge(c)
    model_bytes = counts.model().to_bytes()
    _set_model(model_bytes)
    print(f"  trained codec tables on {len(jobs[::4])} supertiles, {time.time() - t0:.0f}s", flush=True)

    # pass 2: every chunk
    chunks: dict[tuple[int, int, int], tuple[int, bytes]] = {}
    core4: dict[tuple[int, int], np.ndarray] = {}
    with ProcessPoolExecutor(10, initializer=_set_model, initargs=(model_bytes,)) as ex:
        for n, (job, res) in enumerate(zip(jobs, ex.map(pack_supertile, jobs, chunksize=1)), 1):
            for level, cx, cz, h, blob in res[0]:
                chunks[(level, cx, cz)] = (h, blob)
            if res[1] is not None:
                core4[job] = res[1]
            if n % 100 == 0 or n == len(jobs):
                print(f"  {n}/{len(jobs)} supertiles, {time.time() - t0:.0f}s", flush=True)
    for level, cx, cz, h, blob in coarse_levels(core4, f):
        chunks[(level, cx, cz)] = (h, blob)

    levels = [{"level": lv, "cell": 1 << lv, "ncx": -(-f.nx // (CHUNK << lv)), "ncz": -(-f.nz // (CHUNK << lv))} for lv in range(LEVELS)]
    order = slot_order(levels)
    assert set(chunks) <= set(order), "a chunk outside the slot grid"
    shard = 1 << SHARD_BITS
    shards = [bytearray()]
    lengths = np.zeros(len(order), np.uint16)
    heights = np.zeros(len(order), np.uint16)
    by_level = [0] * LEVELS
    for k, key in enumerate(order):
        item = chunks.get(key)
        if item is None:
            continue
        h, blob = item
        assert len(blob) < 65536 and h < 65536
        if len(shards[-1]) + len(blob) > shard:
            shards.append(bytearray())
        shards[-1] += blob
        lengths[k], heights[k] = len(blob), h
        by_level[key[0]] += 1
    planes = b"".join(a.astype(t).tobytes() for a, t in ((lengths & 255, np.uint8), (lengths >> 8, np.uint8), (heights & 255, np.uint8), (heights >> 8, np.uint8)))
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    dir_blob = co.compress(model_bytes + planes) + co.flush()
    h = hashlib.sha1(dir_blob)
    for sh in shards:
        h.update(sh)
    digest = h.hexdigest()[:10]
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*"):
        old.unlink()
    for n, sh in enumerate(shards):
        (OUT / f"chunks.{digest}-{n}.bin").write_bytes(sh)
    (OUT / f"dir.{digest}.bin").write_bytes(dir_blob)
    total = sum(by_level)
    manifest = {
        "format": 2, "hash": digest,
        "source": f"PLATEAU 3D city model FY2025 (CityGML 2.0, spec v5), {len(WARDS)} Tokyo wards ("
                  + ", ".join(w["name"].removesuffix("-ku") for w in WARDS) + "): bldg LOD1-3, tran LOD1-3, frn/veg/brid, wtr, dem",
        "attribution": "出典：国土交通省 3D都市モデル（Project PLATEAU）東京都" + "・".join(w["ja"] for w in WARDS) + "（令和7年度）を加工して作成 / "
                       "Source: MLIT Project PLATEAU, FY2025 3D city models of " + ", ".join(w["name"].removesuffix("-ku").capitalize() for w in WARDS)
                       + " wards, processed into voxels (PDL 1.0 / CC BY 4.0)",
        "frame": {"epsg": 6677, "gx0": f.gx0, "gtop": f.gtop, "nx": f.nx, "nz": f.nz, "gz": GZ},
        "chunk": CHUNK, "levels": levels,
        "files": {"dir": f"dir.{digest}.bin", "chunks": [f"chunks.{digest}-{n}.bin" for n in range(len(shards))]},
        "shardBits": SHARD_BITS,
        "bytes": {"dir": len(dir_blob), "chunks": sum(len(sh) for sh in shards)},
        "counts": {"chunks": total, "byLevel": by_level},
        "themes": theme_defs(),
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    per_level = [sum(len(chunks[k][1]) for k in chunks if k[0] == lv) for lv in range(LEVELS)]
    print(f"packed {total} chunks {by_level}: chunks {manifest['bytes']['chunks'] / 1e6:.1f} MB in {len(shards)} shards (per level MB "
          f"{[round(x / 1e6, 1) for x in per_level]}), dir {len(dir_blob) / 1e3:.0f} KB (model {len(model_bytes) / 1e3:.0f} KB raw), {time.time() - t0:.0f}s")


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
