"""Shared helpers for the CubeWorld lab voxel pipelines (no OSM code here).

Import from sibling scripts (run from the project root, they add this dir to sys.path)::

    import labcommon as lc
    area = lc.load_area()                      # public/lab/area.json
    E, N = lc.cell_centres(area)               # (nz, nx) plane coords of cell centres
    elev = lc.sample_dem(area)                 # (nz, nx) metres, GSI dem5a, lightly smoothed
    grid = np.zeros((ny, nz, nx), np.uint8)    # index [y, z, x]  == flat x + nx*(z + nz*y)
    lc.write_voxels("my-id", grid, meta)       # -> public/lab/voxels/my-id.{json,bin}

Conventions (see area.json): CRS EPSG:6677 with x=easting, y=northing;
voxel x = easting - sw.x (east), voxel z = (sw.y + sizeM) - northing (+z south),
voxel y = up = elevation - groundZ.

DEM: 国土地理院タイル dem5a_png (z15), cached in pipeline/cache/lab/gsi/.
"""
from __future__ import annotations

import json
import math
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import requests
from PIL import Image
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
LAB_PUBLIC = ROOT / "public" / "lab"
VOXEL_DIR = LAB_PUBLIC / "voxels"
CACHE_DIR = ROOT / "pipeline" / "cache" / "lab"
GSI_CACHE = CACHE_DIR / "gsi"
USER_AGENT = "river-globe-lab/0.1 (research prototype)"
GSI_URL = "https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png"
DEM_ZOOM = 15

# Voxel classes
AIR, GROUND, ROAD, SIDEWALK, WALL, ROOF, VEGETATION, POLE, WATER, RAIL, BRIDGE, FURNITURE, FENCE = range(13)
CLASS_NAMES = [
    "air", "ground", "road", "sidewalk", "wall", "roof", "vegetation",
    "pole", "water", "rail", "bridge", "furniture", "fence",
]

_to_plane = None
_to_wgs = None


@dataclass(frozen=True)
class Area:
    id: str
    name: str
    lat: float
    lon: float
    epsg: int
    sw_x: float
    sw_y: float
    size_m: int
    mpc: float
    dims: tuple  # (nx, ny, nz)
    bbox: dict  # west/south/east/north in WGS84
    raw: dict

    @property
    def nx(self): return self.dims[0]
    @property
    def ny(self): return self.dims[1]
    @property
    def nz(self): return self.dims[2]


def load_area(path: Path | None = None) -> Area:
    a = json.loads((path or LAB_PUBLIC / "area.json").read_text())
    return Area(
        id=a["id"], name=a["name"], lat=a["center"]["lat"], lon=a["center"]["lon"],
        epsg=a["epsg"], sw_x=a["sw"]["x"], sw_y=a["sw"]["y"], size_m=a["sizeM"],
        mpc=a["metersPerCube"], dims=tuple(a["dims"]), bbox=a["bboxWGS84"], raw=a,
    )


def _transformers(epsg: int = 6677):
    global _to_plane, _to_wgs
    if _to_plane is None:
        _to_plane = Transformer.from_crs(4326, epsg, always_xy=True)
        _to_wgs = Transformer.from_crs(epsg, 4326, always_xy=True)
    return _to_plane, _to_wgs


def lonlat_to_plane(lon, lat, epsg: int = 6677):
    """WGS84 lon/lat (scalars or arrays) -> plane (easting, northing)."""
    return _transformers(epsg)[0].transform(lon, lat)


def plane_to_lonlat(x, y, epsg: int = 6677):
    """Plane (easting, northing) -> WGS84 (lon, lat)."""
    return _transformers(epsg)[1].transform(x, y)


def plane_to_cell(area: Area, easting, northing):
    """Plane coords -> float voxel (x, z) coordinates (cell i spans [i, i+1))."""
    return (np.asarray(easting) - area.sw_x) / area.mpc, (area.sw_y + area.size_m - np.asarray(northing)) / area.mpc


def cell_centres(area: Area):
    """Plane coords of every cell centre: (E, N), each shape (nz, nx)."""
    ix = np.arange(area.nx) + 0.5
    iz = np.arange(area.nz) + 0.5
    E = area.sw_x + ix * area.mpc
    N = area.sw_y + area.size_m - iz * area.mpc
    return np.broadcast_to(E[None, :], (area.nz, area.nx)).copy(), np.broadcast_to(N[:, None], (area.nz, area.nx)).copy()


# ---------------------------------------------------------------- GSI DEM

def _lonlat_to_pixel(lon, lat, z: int):
    n = 256 * 2 ** z
    lon = np.asarray(lon, dtype=float)
    lat = np.radians(np.asarray(lat, dtype=float))
    px = (lon + 180.0) / 360.0 * n
    py = (1.0 - np.log(np.tan(lat) + 1.0 / np.cos(lat)) / math.pi) / 2.0 * n
    return px, py


def decode_dem_png(path_or_img) -> np.ndarray:
    """GSI dem png -> float32 metres (256x256), nodata = NaN."""
    img = Image.open(path_or_img).convert("RGB")
    a = np.asarray(img).astype(np.int64)
    v = 65536 * a[..., 0] + 256 * a[..., 1] + a[..., 2]
    h = np.where(v < 8388608, v * 0.01, (v - 16777216) * 0.01)
    h[v == 8388608] = np.nan
    return h.astype(np.float32)


def fetch_dem_tile(x: int, y: int, z: int = DEM_ZOOM, refresh: bool = False):
    """Return cached/downloaded tile elevation (256x256 float32, NaN nodata); all-NaN on 404."""
    GSI_CACHE.mkdir(parents=True, exist_ok=True)
    p = GSI_CACHE / f"dem5a_{z}_{x}_{y}.png"
    if refresh or not p.exists():
        r = requests.get(GSI_URL.format(z=z, x=x, y=y), headers={"User-Agent": USER_AGENT}, timeout=30)
        if r.status_code == 404:
            print(f"[labcommon] GSI tile {z}/{x}/{y} missing (404): nodata", file=sys.stderr)
            return np.full((256, 256), np.nan, np.float32)
        r.raise_for_status()
        p.write_bytes(r.content)
    return decode_dem_png(p)


def _fill_nan(a: np.ndarray) -> np.ndarray:
    """Fill NaN by repeatedly averaging valid 8-neighbours (nearest-valid propagation)."""
    a = a.copy()
    if np.isnan(a).all():
        raise RuntimeError("DEM has no valid cells in the area")
    while np.isnan(a).any():
        m = np.isnan(a)
        p = np.pad(a, 1, constant_values=np.nan)
        stack = np.stack([p[i:i + a.shape[0], j:j + a.shape[1]] for i in range(3) for j in range(3)])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            mean = np.nanmean(stack, axis=0)
        a[m] = mean[m]
    return a


def sample_dem(area: Area, smooth: bool = True, refresh: bool = False) -> np.ndarray:
    """Elevation (m) at every cell centre, shape (nz, nx).

    Fetches/caches all GSI dem5a z15 tiles covering the area, fills nodata from the nearest
    valid neighbours, bilinearly samples at cell centres (via lon/lat -> Web Mercator pixels)
    and, if `smooth`, applies a 3x3 box filter at 1 m resolution (edge-replicated).
    """
    E, N = cell_centres(area)
    lon, lat = plane_to_lonlat(E, N, area.epsg)
    px, py = _lonlat_to_pixel(lon, lat, DEM_ZOOM)
    px -= 0.5  # pixel centres sit at integer + 0.5
    py -= 0.5
    x0, x1 = int(math.floor(px.min())), int(math.floor(px.max())) + 1
    y0, y1 = int(math.floor(py.min())), int(math.floor(py.max())) + 1
    tx0, tx1 = x0 // 256, x1 // 256
    ty0, ty1 = y0 // 256, y1 // 256
    mosaic = np.full(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.nan, np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = \
                fetch_dem_tile(tx, ty, DEM_ZOOM, refresh)
    nodata_frac = float(np.isnan(mosaic).mean())
    mosaic = _fill_nan(mosaic)
    u = px - tx0 * 256
    v = py - ty0 * 256
    iu = np.floor(u).astype(int)
    iv = np.floor(v).astype(int)
    fu, fv = u - iu, v - iv
    h = (mosaic[iv, iu] * (1 - fu) * (1 - fv) + mosaic[iv, iu + 1] * fu * (1 - fv)
         + mosaic[iv + 1, iu] * (1 - fu) * fv + mosaic[iv + 1, iu + 1] * fu * fv)
    if smooth:
        p = np.pad(h, 1, mode="edge")
        h = sum(p[i:i + h.shape[0], j:j + h.shape[1]] for i in range(3) for j in range(3)) / 9.0
    h = h.astype(np.float64)
    sample_dem.last_nodata_fraction = nodata_frac
    return h


sample_dem.last_nodata_fraction = 0.0


# ---------------------------------------------------------------- voxel IO

def write_voxels(vid: str, grid: np.ndarray, meta: dict, out_dir: Path | None = None) -> dict:
    """Write `<vid>.bin` (uint8, index x + nx*(z + nz*y)) and `<vid>.json`.

    `grid` has shape (ny, nz, nx). `meta` supplies source/license/attribution/method/origin/notes;
    dims, metersPerCube (if missing) and classCounts are filled in here.
    """
    out_dir = out_dir or VOXEL_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    grid = np.ascontiguousarray(grid, dtype=np.uint8)
    ny, nz, nx = grid.shape
    counts = np.bincount(grid.ravel(), minlength=len(CLASS_NAMES))
    head = {"id": vid}
    head.update(meta)
    head["dims"] = [nx, ny, nz]
    head.setdefault("metersPerCube", 1)
    head["classCounts"] = {n: int(counts[i]) for i, n in enumerate(CLASS_NAMES)}
    ordered = {k: head[k] for k in ("id", "source", "license", "attribution", "method", "metersPerCube",
                                    "dims", "origin", "classCounts", "notes") if k in head}
    ordered.update({k: v for k, v in head.items() if k not in ordered})
    (out_dir / f"{vid}.bin").write_bytes(grid.tobytes())
    (out_dir / f"{vid}.json").write_text(json.dumps(ordered, ensure_ascii=False, indent=2) + "\n")
    return ordered


def read_voxels(vid: str, in_dir: Path | None = None):
    """Return (meta dict, grid (ny, nz, nx) uint8)."""
    in_dir = in_dir or VOXEL_DIR
    meta = json.loads((in_dir / f"{vid}.json").read_text())
    nx, ny, nz = meta["dims"]
    grid = np.frombuffer((in_dir / f"{vid}.bin").read_bytes(), np.uint8).reshape(ny, nz, nx)
    return meta, grid
