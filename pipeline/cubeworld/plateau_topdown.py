"""Debug: top-down PNG of a lab voxel file (highest non-air class per column). usage: plateau_topdown.py <id> [scale]"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parent))
import labcommon as lc
meta, g = lc.read_voxels(sys.argv[1])
s = int(sys.argv[2]) if len(sys.argv) > 2 else 4
ny, nz, nx = g.shape
kk = np.arange(ny)[:, None, None]
top = np.where(g > 0, kk, -1).max(0)
cls = np.take_along_axis(g, np.clip(top, 0, None)[None], 0)[0]
pal = np.array([[255,255,255],[200,190,160],[60,60,60],[240,200,120],[220,120,120],[170,60,60],[40,160,60],[0,0,0],[60,120,255],[120,60,160],[255,140,0],[200,0,200],[120,80,40]], np.uint8)
img = pal[cls].astype(float)
shade = (0.55 + 0.45 * np.clip(top / max(1, top.max()), 0, 1))[..., None]
Image.fromarray((img * shade).astype(np.uint8)).resize((nx * s, nz * s), Image.NEAREST).save(f"/tmp/{sys.argv[1]}-top.png")
print(f"/tmp/{sys.argv[1]}-top.png", {lc.CLASS_NAMES[i]: int((cls == i).sum()) for i in range(13) if (cls == i).any()})
