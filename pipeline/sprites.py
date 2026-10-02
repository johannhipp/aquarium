"""Derive early-Game-Boy style 1-bit sprites from the finished creature images.

Reads art/creatures/<id>.png (full-size images, kept out of the shipped site), writes
public/creatures/<id>-gb.png (extras: art/creatures/extras -> public/creatures/extras):
  crop to the creature -> area-downscale to SPRITE_PX on the long side -> normalise tone inside the
  creature -> 1px black inner contour -> 4x4 Bayer ordered dither to pure black/white -> centre on a
  square SPRITE_CANVAS grid (white) -> saved as a native 80x80 1-bit PNG. The page upscales it with
  CSS `image-rendering: pixelated`, so the file stays a few hundred bytes.

Deterministic, no randomness. Usage: python pipeline/sprites.py
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "art" / "creatures"
OUT = ROOT / "public" / "creatures"

SPRITE_PX = 72        # creature size on its long side, in sprite pixels
SPRITE_CANVAS = 80    # square grid, in sprite pixels
BACKGROUND = 232      # gray values at or above this are background (white)
BAYER4 = (np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], dtype=np.float32) + 0.5) / 16.0


def erode(m: np.ndarray) -> np.ndarray:
    p = np.pad(m, 1, constant_values=False)
    return m & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]


def sprite(src: Path, dst: Path) -> None:
    gray = Image.open(src).convert("L").filter(ImageFilter.GaussianBlur(1.2))  # suppress film grain
    g = np.asarray(gray)
    ys, xs = np.where(g < BACKGROUND)
    pad = 6
    box = (max(xs.min() - pad, 0), max(ys.min() - pad, 0), min(xs.max() + pad + 1, g.shape[1]), min(ys.max() + pad + 1, g.shape[0]))
    crop = gray.crop(box)
    k = SPRITE_PX / max(crop.size)
    small = crop.resize((max(1, round(crop.width * k)), max(1, round(crop.height * k))), Image.BOX)
    s = np.asarray(small, dtype=np.float32)

    mask = s < BACKGROUND
    lo, hi = np.percentile(s[mask], [2, 98])
    t = np.clip((s - lo) / max(hi - lo, 1.0), 0, 1) ** 0.65  # normalise tone inside the creature
    blur = np.asarray(Image.fromarray((t * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.0)), dtype=np.float32) / 255
    t = np.clip(t + 1.2 * (t - blur), 0, 1)                  # local contrast keeps eyes, gills, fins

    h, w = t.shape
    reps = (h // 4 + 1, w // 4 + 1)
    out = (t > np.tile(BAYER4, reps)[:h, :w])
    out[~mask] = True                                        # background stays white
    out[mask & ~erode(mask)] = False                         # 1px black contour so pale bellies read against white

    canvas = np.ones((SPRITE_CANVAS, SPRITE_CANVAS), dtype=bool)
    y0, x0 = (SPRITE_CANVAS - h) // 2, (SPRITE_CANVAS - w) // 2
    canvas[y0:y0 + h, x0:x0 + w] = out
    Image.fromarray(canvas).save(dst, optimize=True)  # bool array -> mode "1"


def main() -> None:
    for c in json.loads((ART / "creatures.full.json").read_text()):
        sprite(ART / f"{c['id']}.png", OUT / f"{c['id']}-gb.png")
        print("wrote", OUT / f"{c['id']}-gb.png")
    for path in sorted((ART / "extras").glob("*.json")):  # extras: art/creatures/extras/<id>.png -> public/creatures/extras/<id>-gb.png
        extra_id = json.loads(path.read_text())["id"]
        sprite(ART / "extras" / f"{extra_id}.png", OUT / "extras" / f"{extra_id}-gb.png")
        print("wrote", OUT / "extras" / f"{extra_id}-gb.png")
    places_art = ROOT / "art" / "places"  # places: art/places/<id>.png -> public/places/<id>-gb.png
    places_out = ROOT / "public" / "places"
    for pl in json.loads((places_art / "places.full.json").read_text()):
        sprite(places_art / f"{pl['id']}.png", places_out / f"{pl['id']}-gb.png")
        print("wrote", places_out / f"{pl['id']}-gb.png")


if __name__ == "__main__":
    main()
