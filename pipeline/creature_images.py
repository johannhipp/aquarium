"""Finishing pass for the generated creature photographs (one consistent look).

Reads the raw image-model output from pipeline/cache/creature-raw/<id>.png and writes
art/creatures/<id>.png (full-size, not shipped with the site):
  1. white point: near-white (>= 249) becomes exactly #FFFFFF, so the surround is pure white
  2. framing: crop to the subject, scale to a shared bounding box, centre on a square canvas
  3. grade: pull saturation down to a shared level and cool the shadows (white stays white)
  4. grain: seeded monochrome film grain, only where the subject is

Deterministic (fixed seed per creature). Usage: python pipeline/creature_images.py
"""
import json
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "pipeline" / "cache" / "creature-raw"
OUT = ROOT / "art" / "creatures"   # also holds creatures.full.json and extras/*.json

WHITE_POINT = 249.0       # input value that maps to 255
SUBJECT_THRESHOLD = 235   # min-channel below this counts as subject when measuring the bbox
FIT_W, FIT_H = 0.86, 0.70  # subject bbox as a fraction of the canvas
SATURATION = 0.45
GRAIN_SIGMA = 9.0


def finish(src: Path, dst: Path, seed: int) -> None:
    rgb = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32)
    rgb = np.clip(rgb * (255.0 / WHITE_POINT), 0, 255)
    img = Image.fromarray(rgb.round().astype(np.uint8))

    h, w = rgb.shape[:2]
    ys, xs = np.where(rgb.min(axis=2) < SUBJECT_THRESHOLD)
    box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    crop = img.crop(box)
    scale = min(FIT_W * w / crop.width, FIT_H * h / crop.height)
    crop = crop.resize((round(crop.width * scale), round(crop.height * scale)), Image.LANCZOS)
    canvas = Image.new("RGB", (w, h), (255, 255, 255))
    canvas.paste(crop, ((w - crop.width) // 2, (h - crop.height) // 2))

    a = np.asarray(canvas, dtype=np.float32)
    lum = (a @ np.array([0.299, 0.587, 0.114], dtype=np.float32))[..., None]
    a = lum + SATURATION * (a - lum)
    cool = 1.0 - lum / 255.0                         # 0 on white, 1 on black
    a = a * np.array([1 - 0.07 * cool[..., 0], 1 - 0.02 * cool[..., 0], np.ones_like(cool[..., 0])]).transpose(1, 2, 0)

    subject = np.clip((255.0 - a.min(axis=2, keepdims=True)) / 40.0, 0, 1)  # soft mask, 0 on pure white
    noise = np.random.default_rng(seed).normal(0.0, GRAIN_SIGMA, size=(h, w, 1)).astype(np.float32)
    a = np.clip(a + noise * subject, 0, 255)
    Image.fromarray(a.round().astype(np.uint8)).save(dst, optimize=True)


def main() -> None:
    for c in json.loads((OUT / "creatures.full.json").read_text()):
        finish(RAW / f"{c['id']}.png", OUT / f"{c['id']}.png", zlib.crc32(c["id"].encode()))
        print("wrote", OUT / f"{c['id']}.png")
    for path in sorted((OUT / "extras").glob("*.json")):  # extras: art/creatures/extras/
        extra_id = json.loads(path.read_text())["id"]
        finish(RAW / f"{extra_id}.png", OUT / "extras" / f"{extra_id}.png", zlib.crc32(extra_id.encode()))
        print("wrote", OUT / "extras" / f"{extra_id}.png")


if __name__ == "__main__":
    main()
