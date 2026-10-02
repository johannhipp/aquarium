#!/usr/bin/env python3
"""Compose the best layer of each source into one lab voxel file: `merged-yakkozaka`.

    python pipeline/cubeworld/merge_layers.py

All lab files share one 160 x 160 m grid, so merging is a per-cell choice:

    ground, buildings   plateau-yakkozaka   measured heights (LOD1 boxes) on the PLATEAU DEM
    road / sidewalk /   osm-yakkozaka       painted on the top ground cell of every column PLATEAU does not build on
    water / ground cover                    (OSM has the narrow lanes PLATEAU's LOD1 roads lack)
    trees, lamp posts   arnis-yakkozaka     canopy-height trees and inferred lamps, shifted in height to sit on the
                                            PLATEAU ground (Arnis scales relief differently); skipped under buildings

Run `osm_voxelize.py`, `arnis_voxelize.py` and the PLATEAU converter first. The result is only as real as its
layers: roof heights are measured, trees and lamps are inferred, see the json notes.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from labcommon import load_area, read_voxels, write_voxels  # noqa: E402

GROUND, ROAD, SIDEWALK, BUILDING, ROOF, VEG, POLE, WATER = 1, 2, 3, 4, 5, 6, 7, 8


def ground_top(grid: np.ndarray) -> np.ndarray:
    """Per (z, x): index of the highest cell of ground, road, sidewalk or water."""
    ys = np.arange(grid.shape[0])[:, None, None]
    return np.where(np.isin(grid, [GROUND, ROAD, SIDEWALK, WATER]), ys, -1).max(axis=0)


def main() -> None:
    base_meta, base = read_voxels("plateau-yakkozaka")
    _, osm = read_voxels("osm-yakkozaka")
    _, arnis = read_voxels("arnis-yakkozaka")
    ny, nz, nx = base.shape
    zz, xx = np.meshgrid(np.arange(nz), np.arange(nx), indexing="ij")

    out = base.copy()
    built = np.isin(base, [BUILDING, ROOF]).any(axis=0)  # columns PLATEAU builds on
    gt = ground_top(base)

    # 1. surfaces from OSM, only where PLATEAU has no building and OSM has none either.
    osm_top = ground_top(osm)
    osm_surface = osm[osm_top.clip(0), zz, xx]
    osm_built = np.isin(osm, [BUILDING, ROOF]).any(axis=0)
    paint = ~built & ~osm_built & np.isin(osm_surface, [ROAD, SIDEWALK, WATER])
    out[gt[paint], zz[paint], xx[paint]] = osm_surface[paint]
    # OSM buildings PLATEAU lacks are left out on purpose: PLATEAU is the measured source.

    # 2. Arnis trees and lamp posts, dropped onto the PLATEAU ground.
    a_gt = ground_top(arnis)
    offset = gt - a_gt  # (z, x): shift in cells
    placed = {"vegetation": 0, "pole": 0}
    for cls, name in ((VEG, "vegetation"), (POLE, "pole")):
        ys, zs, xs = np.nonzero(arnis == cls)
        ny_ = ys + offset[zs, xs]
        ok = (ny_ >= 0) & (ny_ < ny) & ~built[zs, xs] & (out[ny_.clip(0, ny - 1), zs, xs] == 0)
        out[ny_[ok], zs[ok], xs[ok]] = cls
        placed[name] = int(ok.sum())

    meta = {
        "source": "COMPOSITE: PLATEAU Minato-ku FY2025 (ground, measured building heights) + OpenStreetMap (road, sidewalk, water) + Arnis v3.2.0 (trees from canopy-height map, inferred lamps)",
        "license": "PDL1.0 / CC BY 4.0-compatible (PLATEAU) + ODbL 1.0 (OpenStreetMap) + Arnis inputs (Overture, Mapterhorn, Meta canopy height) terms",
        "attribution": base_meta["attribution"] + " ; © OpenStreetMap contributors; Arnis by louis-e",
        "method": "pipeline/cubeworld/merge_layers.py: per-cell layer choice on the shared 160 m grid; Arnis objects shifted in height to the PLATEAU ground",
        "origin": base_meta["origin"],
        "notes": [
            "Measured: terrain and building heights (PLATEAU LOD1 boxes, flat roofs).",
            "OSM: roads, alleys, footways, pond, painted onto the PLATEAU ground wherever no building stands.",
            f"Inferred, not observed: {placed['vegetation']} vegetation cells and {placed['pole']} pole cells come from Arnis (canopy-height model, lamps every 25 m along lit=yes ways).",
            "Layers come from different DEMs (GSI dem5a vs PLATEAU TIN); heights agree to about a metre, so painted surfaces may sit a cube off on steep bits.",
        ],
    }
    write_voxels("merged-yakkozaka", out, meta)
    counts = np.bincount(out.ravel(), minlength=13)
    print("placed", placed, "classCounts", counts.tolist())


if __name__ == "__main__":
    main()
