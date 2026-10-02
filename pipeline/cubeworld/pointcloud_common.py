"""Shared helpers for the point-cloud -> cube pipelines (cubeworld lab).

Voxel file contract (public/lab/voxels/<id>.{json,bin}):
  bin  = raw uint8, length nx*ny*nz, index  x + nx*(z + nz*y)
         x = east, z = south (z grows southward, as in three.js), y = up
  class ids: 0 air, 1 ground, 2 road, 3 sidewalk, 4 building, 5 roof, 6 vegetation,
             7 pole/street light, 8 water, 9 rail, 10 bridge, 11 other furniture, 12 wall/fence
"""

import json
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "pipeline" / "cache" / "cubeworld"
LAB = ROOT / "public" / "lab"
UA = {"User-Agent": "river-globe/0.1 (local experiment)"}

AIR, GROUND, ROAD, SIDEWALK, BUILDING, ROOF, VEG, POLE, WATER, RAIL, BRIDGE, FURNITURE, WALL = range(13)
CLASS_NAMES = [
    "air", "ground", "road", "sidewalk", "building", "roof", "vegetation",
    "pole", "water", "rail", "bridge", "furniture", "wall",
]


def load_area(path: Path = LAB / "area.json") -> dict:
    return json.loads(path.read_text())


def write_voxels(vid: str, grid: np.ndarray, meta: dict) -> None:
    """grid is indexed [y, z, x] (up, south, east) uint8 -> bin x + nx*(z + nz*y)."""
    ny, nz, nx = grid.shape
    out = LAB / "voxels"
    out.mkdir(parents=True, exist_ok=True)
    counts = {CLASS_NAMES[i]: int(n) for i, n in enumerate(np.bincount(grid.ravel(), minlength=13))}
    meta = {**meta, "id": vid, "dims": [nx, ny, nz], "classCounts": counts}
    (out / f"{vid}.bin").write_bytes(np.ascontiguousarray(grid, dtype=np.uint8).tobytes())
    (out / f"{vid}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    print(f"wrote {out / vid}.bin  dims={[nx, ny, nz]}  classes={ {k: v for k, v in counts.items() if v} }")


def parse_osm(path: Path, transformer) -> dict:
    """Parse an OSM XML `map` call. Returns {'nodes': {id:(x,y,tags)}, 'ways': [(tags,[(x,y)...])]} in projected metres."""
    root = ET.parse(path).getroot()
    nodes = {}
    for n in root.findall("node"):
        tags = {t.get("k"): t.get("v") for t in n.findall("tag")}
        x, y = transformer.transform(float(n.get("lon")), float(n.get("lat")))
        nodes[n.get("id")] = (x, y, tags)
    ways = []
    for w in root.findall("way"):
        tags = {t.get("k"): t.get("v") for t in w.findall("tag")}
        pts = [(nodes[r.get("ref")][0], nodes[r.get("ref")][1]) for r in w.findall("nd") if r.get("ref") in nodes]
        ways.append((tags, pts))
    return {"nodes": nodes, "ways": ways}
