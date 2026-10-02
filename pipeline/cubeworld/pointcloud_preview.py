"""Quick matplotlib previews of a voxel file: top-down class map + one oblique height slice.

usage: python pointcloud_preview.py <id> [out.png]
"""

import json
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import ListedColormap

from pointcloud_common import CACHE, LAB

COLORS = ["#ffffff", "#c8b89a", "#444444", "#e8e0d0", "#d9534f", "#a03030", "#2e8b3a", "#000000",
          "#3070ff", "#888888", "#ffa500", "#ff00ff", "#00aaaa"]

vid = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else str(CACHE / f"preview-{vid}.png")
meta = json.loads((LAB / "voxels" / f"{vid}.json").read_text())
nx, ny, nz = meta["dims"]
g = np.fromfile(LAB / "voxels" / f"{vid}.bin", np.uint8).reshape(ny, nz, nx)
cm = ListedColormap(COLORS)
# top-down: highest non-air voxel per column
nonair = g > 0
top = ny - 1 - np.argmax(nonair[::-1], axis=0)
topc = np.take_along_axis(g, top[None], 0)[0]
fig, ax = plt.subplots(1, 3, figsize=(24, 9) if nx == nz else (24, 8))
ax[0].imshow(topc, cmap=cm, vmin=0, vmax=12, interpolation="nearest")
ax[0].set_title(f"{vid} top class (z grows south)")
im = ax[1].imshow(top, cmap="terrain", interpolation="nearest")
plt.colorbar(im, ax=ax[1])
poles = np.argwhere(g == 7)
ax[0].scatter(poles[:, 2], poles[:, 1], s=6, c="yellow", marker="x", linewidths=0.6)
# side view (looking along +z): nearest non-air voxel along z, per (y, x)
nz_hit = np.argmax(g > 0, axis=1)
side = np.take_along_axis(g, nz_hit[:, None, :], 1)[:, 0, :]
ax[2].imshow(side, cmap=cm, vmin=0, vmax=12, interpolation="nearest", origin="lower")
ax[2].set_title("side view from north (y up)")
plt.tight_layout()
plt.savefig(out, dpi=70)
print(out)
