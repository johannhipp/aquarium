#!/usr/bin/env python3
"""Run Arnis (OSM -> Minecraft generator) on the lab box and convert its world to a lab voxel file.

    uv run --with anvil-parser2 --with numpy python pipeline/cubeworld/arnis_voxelize.py \
        --arnis /path/to/arnis-mac-universal [--work /tmp/arnis]

Arnis (https://github.com/louis-e/arnis, Apache-2.0, v3.2.0 release binary) takes a lat/lon bbox
and writes a Java-edition world: OSM buildings, roads, trees (Meta canopy height map), elevation
(Mapterhorn), plus Overture buildings missing in OSM. This script runs it twice, once normally and
once with `--mode terrain-only`, because the terrain-only world gives the bare ground height of
every column (the object world hides it under buildings), then classifies every block by name:

    ground surface   grass/dirt/podzol, stone-brick paving   -> 1 ground
    asphalt mix      gray_concrete_powder, cyan_terracotta   -> 2 road        (Arnis' default road mix)
    footway/alley    gray_concrete, smooth_stone             -> 3 sidewalk
    lamp stack       smooth_stone + wall + redstone lamp     -> 7 pole
    logs, leaves                                              -> 6 vegetation
    iron bars, walls, fences                                  -> 12 fence
    anything else above ground                                -> 4 building (top cell of a column -> 5 roof)

Ground plants (grass tufts, flowers) are dropped. The voxel x/z axes are Minecraft's: x east, z
south, 1 block = 1 m, so they match the lab grid up to the sub-metre difference between the WGS84
bbox Arnis uses and the plane-rectangular box of area.json.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from arnis_decode import Y_MIN, decode_world  # noqa: E402
from labcommon import load_area, write_voxels  # noqa: E402

ROAD = {"gray_concrete_powder", "cyan_terracotta", "black_concrete"}
FOOTWAY = {"gray_concrete", "smooth_stone", "dirt_path"}
PLANTS = {"short_grass", "tall_grass", "fern", "dandelion", "poppy", "blue_orchid", "azure_bluet", "allium",
          "oxeye_daisy", "cornflower", "lily_of_the_valley", "dead_bush", "flower_pot", "sweet_berry_bush"}
LAMP_PARTS = {"smooth_stone", "stone_brick_wall", "redstone_lamp", "iron_trapdoor"}
FENCE_HINTS = ("fence", "_wall", "iron_bars")


def run_arnis(arnis: Path, bbox: str, out: Path, extra: list[str]) -> Path:
    if out.exists():
        subprocess.run(["rm", "-rf", str(out)], check=True)
    cmd = [str(arnis), "--bbox", bbox, "--output-dir", str(out), "--no-3d", "--map-item", "false",
           "--signage", "none", *extra]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    return next(d for d in out.iterdir() if (d / "region").is_dir())  # "Arnis World 1"


def is_log_or_leaf(name: str) -> bool:
    return name.endswith("_log") or name.endswith("_leaves") or name in {"vine", "moss_block", "mangrove_roots"}


def classify(objects: np.ndarray, o_names: list[str], terrain: np.ndarray, t_names: list[str]):
    ny, nz, nx = objects.shape
    air_o = o_names.index("air")
    air_t = t_names.index("air")

    # Ground height per column: the highest terrain-only block that is not a tree or a plant.
    t_kind = np.array([0 if n == "air" else (2 if (is_log_or_leaf(n) or n in PLANTS) else 1) for n in t_names])
    is_ground_t = t_kind[terrain] == 1
    ys = np.arange(terrain.shape[0])[:, None, None]
    ground = np.where(is_ground_t, ys, -1).max(axis=0)  # (z, x) index into the y axis
    zz, xx = np.meshgrid(np.arange(nz), np.arange(nx), indexing="ij")

    name_of = np.array(o_names)
    kind = np.zeros(len(o_names), np.uint8)  # 0 air/plant, 1 solid structure, 2 veg, 3 fence-ish, 4 lamp part
    for i, n in enumerate(o_names):
        if n == "air" or n in PLANTS:
            kind[i] = 0
        elif is_log_or_leaf(n):
            kind[i] = 2
        elif any(h in n for h in FENCE_HINTS) and n != "stone_brick_wall":
            kind[i] = 3
        elif n in LAMP_PARTS:
            kind[i] = 4
        else:
            kind[i] = 1
    k = kind[objects]
    yy = np.arange(ny)[:, None, None]
    above = (yy > ground[None]) & (k > 0)

    # Thin lamp stacks: lamp parts with no structure in the 8 horizontal neighbours at that height.
    struct = above & (k != 0)
    pad = np.pad(struct, ((0, 0), (1, 1), (1, 1)))
    neighbours = np.zeros_like(struct, dtype=np.uint8)
    for dz in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dz or dx:
                neighbours += pad[:, 1 + dz : 1 + dz + nz, 1 + dx : 1 + dx + nx]
    lamp = above & (k == 4) & (neighbours == 0)

    # Output y: 0 at one cube below the lowest ground top, so every ground column has >= 1 cube.
    y0 = int(ground.min()) - 1
    out_ny = min(100, int(max(ground.max(), np.where(above, yy, -1).max())) - y0 + 2)
    out = np.zeros((out_ny, nz, nx), np.uint8)

    # ground stack (everything at or below the terrain top is ground), then the surface class.
    for y in range(out_ny):
        src = y + y0
        out[y] = np.where(src <= ground, 1, 0)
    surf_name = name_of[objects[ground, zz, xx]]
    surf = np.ones((nz, nx), np.uint8)
    surf[np.isin(surf_name, list(ROAD))] = 2
    surf[np.isin(surf_name, list(FOOTWAY))] = 3
    out[ground - y0, zz, xx] = surf

    # objects
    for y in range(out_ny):
        src = y + y0
        if src >= ny:
            break
        layer = out[y]
        a = above[src]
        kl = k[src]
        layer[a & (kl == 1)] = 4
        layer[a & (kl == 2)] = 6
        layer[a & (kl == 3)] = 12
        layer[a & (kl == 4)] = 12
        layer[lamp[src]] = 7
    # roof: the highest class-4 cell of every column that has a building
    is_wall = out == 4
    top = np.where(is_wall, np.arange(out_ny)[:, None, None], -1).max(axis=0)
    has = top >= 0
    out[top[has], zz[has], xx[has]] = 5
    return out, int(ground.min()), int(ground.max()), y0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arnis", required=True, type=Path)
    ap.add_argument("--work", type=Path, default=Path("/tmp/arnis"))
    args = ap.parse_args()
    area = load_area()
    bb = area.bbox
    bbox = f"{bb['south']},{bb['west']},{bb['north']},{bb['east']}"
    args.work.mkdir(parents=True, exist_ok=True)
    objects_dir = run_arnis(args.arnis, bbox, args.work / "world", [])
    terrain_dir = run_arnis(args.arnis, bbox, args.work / "world-terrain", ["--mode", "terrain-only"])
    objects, o_names = decode_world(objects_dir)
    terrain, t_names = decode_world(terrain_dir)
    grid, gmin, gmax, y0 = classify(objects, o_names, terrain, t_names)
    meta = {
        "source": "Arnis v3.2.0 (OSM + Overture buildings + Mapterhorn elevation + Meta canopy height), Minecraft world converted by block name",
        "license": "ODbL 1.0 (OpenStreetMap), Overture Maps (per-source), Mapterhorn / canopy data terms; Arnis itself Apache-2.0",
        "attribution": "© OpenStreetMap contributors; Overture Maps Foundation; Arnis by louis-e",
        "method": "arnis --bbox <WGS84 bbox of area.json> --no-3d (objects) and --mode terrain-only (bare ground heights); blocks mapped to lab classes by name, see pipeline/cubeworld/arnis_voxelize.py",
        "origin": {"lat": area.lat, "lon": area.lon, "epsg": area.epsg, "x": area.sw_x, "y": area.sw_y, "groundZ": None},
        "notes": [
            f"Minecraft ground tops span y={gmin + Y_MIN}..{gmax + Y_MIN} (Arnis scales relief to its own range; absolute elevation is not preserved, groundZ is null).",
            "Roads are recognised by Arnis' asphalt block mix; alleys and footways share one block (class 3).",
            "Street lamps are inferred by Arnis along lit=yes ways every 25 m (not mapped objects).",
            "Trees come from the Meta/WRI canopy height map, not from OSM nodes.",
            "Ground plants are dropped; building interiors are empty shells in Arnis and are not distinguished here.",
        ],
    }
    write_voxels("arnis-yakkozaka", grid, meta)
    counts = np.bincount(grid.ravel(), minlength=13)
    print("dims", grid.shape[::-1], "classCounts", counts.tolist(), "ground", gmin, gmax)


if __name__ == "__main__":
    main()
