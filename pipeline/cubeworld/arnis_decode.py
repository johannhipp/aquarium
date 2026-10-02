#!/usr/bin/env python3
"""Decode an Arnis-generated Java world (one region file) into a dense numpy block-id volume.

    uv run --with anvil-parser2 --with numpy python pipeline/cubeworld/arnis_decode.py WORLD_DIR OUT.npz

`WORLD_DIR` holds `region/r.0.0.mca`. The result has `ids[y, z, x]` (uint16 index into `names`)
cropped to the first 160 x 160 columns and the y range that contains blocks. Minecraft x is east
and z is south, the same axes as the lab voxel grid. Uses numpy per chunk section: the 160 x 160 x
~100 area decodes in about a second (anvil's per-block `get_block` takes minutes).
"""
from __future__ import annotations

import sys
from pathlib import Path

import anvil
import numpy as np

SIZE = 160
Y_MIN = -64  # Java 1.18+ world floor


def decode_section(section) -> tuple[list[str], np.ndarray]:
    states = section["block_states"]
    palette = [str(p["Name"]).removeprefix("minecraft:") for p in states["palette"]]
    if "data" not in states or len(palette) == 1:
        return palette, np.zeros((16, 16, 16), np.uint16)
    bits = max(4, (len(palette) - 1).bit_length())
    per_long = 64 // bits
    longs = np.array([int(v) & 0xFFFFFFFFFFFFFFFF for v in states["data"].value], dtype=np.uint64)
    shifts = (np.arange(per_long, dtype=np.uint64) * np.uint64(bits))[None, :]
    mask = np.uint64((1 << bits) - 1)
    idx = ((longs[:, None] >> shifts) & mask).reshape(-1)[:4096]
    return palette, idx.astype(np.uint16).reshape(16, 16, 16)  # y, z, x


def decode_world(world: Path) -> tuple[np.ndarray, list[str]]:
    region = anvil.Region.from_file(str(next((world / "region").glob("r.0.0.mca"))))
    names: dict[str, int] = {"air": 0}
    top = 0
    columns: dict[tuple[int, int, int], np.ndarray] = {}
    for cz in range(SIZE // 16 + 1):
        for cx in range(SIZE // 16):
            try:
                chunk = anvil.Chunk.from_region(region, cx, cz)
            except Exception:
                continue
            for section in chunk.data["sections"]:
                palette, local = decode_section(section)
                remap = np.array([names.setdefault(n, len(names)) for n in palette], np.uint16)
                block = remap[local]
                if not block.any():
                    continue
                sy = int(section["Y"].value)
                columns[(cx, cz, sy)] = block
                top = max(top, sy)
    height = (top + 1) * 16 - Y_MIN
    ids = np.zeros((height, (SIZE // 16 + 1) * 16, SIZE), np.uint16)
    for (cx, cz, sy), block in columns.items():
        y0 = sy * 16 - Y_MIN
        ids[y0 : y0 + 16, cz * 16 : cz * 16 + 16, cx * 16 : cx * 16 + 16] = block
    ids = ids[:, :SIZE, :]
    return ids, sorted(names, key=names.get)


if __name__ == "__main__":
    ids, names = decode_world(Path(sys.argv[1]))
    np.savez_compressed(sys.argv[2], ids=ids, names=np.array(names))
    print(f"ids {ids.shape} (y from {Y_MIN}), {len(names)} block names")
