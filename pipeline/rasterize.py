"""Rasterize fetched river centerlines into 1-bit bitmaps and pack them for the globe.

Each river becomes art/bitmaps/<id>.png (reference output; the app only loads the atlas): 1-bit, black = river, white = everything
else, in a local plate carree (lon/lat linear; x scaled by cos(mid-latitude) so pixels
are roughly square on the ground). The same bitmaps are shelf-packed into
public/atlas/page-<k>.png and described by public/rivers.json for the globe.

usage: python3 rasterize.py N   # first N rivers of rivers.json
"""

import json
import math
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).parent
PUBLIC = ROOT.parent / "public"
BITMAPS = ROOT.parent / "art" / "bitmaps"  # kept out of public/ so it never ships
GEOM = ROOT / "cache" / "geom"

RES = 0.0125      # degrees of latitude per pixel (~1.4 km)
LINE = 1          # stroke width in pixels
MARGIN = 2        # empty pixels around each river
PAGE = 4096       # atlas page size (WebGL-safe)
PAD = 32          # gap between packed bitmaps; keeps mipmaps from bleeding
MAX_GAP = 1.5     # degrees; longest straight bridge drawn across a gap in the OSM line


def unwrap(lines):
    """Shift western longitudes east when a river straddles the antimeridian."""
    lons = [p[0] for l in lines for p in l]
    if max(lons) - min(lons) <= 180:
        return lines
    return [[[x + 360 if x < 0 else x, y] for x, y in l] for l in lines]


def bridge_gaps(lines):
    """Join disconnected pieces (river ways often stop at lakes/reservoirs) with straight
    segments: Kruskal over endpoint pairs of different pieces, closest first, up to MAX_GAP."""
    parent = list(range(len(lines)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    by_point = {}
    for i, l in enumerate(lines):
        for p in (tuple(l[0]), tuple(l[-1])):
            j = by_point.setdefault(p, i)
            parent[find(i)] = find(j)
    ends = np.array([p for l in lines for p in (l[0], l[-1])], dtype=float)
    owner = np.repeat(np.arange(len(lines)), 2)
    d = np.hypot(ends[:, None, 0] - ends[None, :, 0], ends[:, None, 1] - ends[None, :, 1])
    a, b = np.nonzero(np.triu(d < MAX_GAP, 1))
    bridges = []
    for k in np.argsort(d[a, b], kind="stable"):
        i, j = find(owner[a[k]]), find(owner[b[k]])
        if i != j:
            parent[i] = j
            bridges.append([ends[a[k]].tolist(), ends[b[k]].tolist()])
    return lines + bridges


def rasterize(river):
    lines = bridge_gaps(unwrap(json.loads((GEOM / f"{river['id']}.json").read_text())))
    lons = [p[0] for l in lines for p in l]
    lats = [p[1] for l in lines for p in l]
    lon0, lon1, lat0, lat1 = min(lons), max(lons), min(lats), max(lats)
    dy = RES
    dx = RES / max(math.cos(math.radians((lat0 + lat1) / 2)), 0.25)
    limit = PAGE - 2 * PAD - 2 * MARGIN - 2
    scale = max(1.0, (lon1 - lon0) / dx / limit, (lat1 - lat0) / dy / limit)
    dx, dy = dx * scale, dy * scale
    w = math.ceil((lon1 - lon0) / dx) + 1 + 2 * MARGIN
    h = math.ceil((lat1 - lat0) / dy) + 1 + 2 * MARGIN
    west, north = lon0 - MARGIN * dx, lat1 + MARGIN * dy

    img = Image.new("1", (w, h), 1)
    draw = ImageDraw.Draw(img)
    for l in lines:
        pts = [((x - west) / dx, (north - y) / dy) for x, y in l]
        draw.line(pts, fill=0, width=LINE)
    img.save(BITMAPS / f"{river['id']}.png", optimize=True)
    return img, [west, north - h * dy, west + w * dx, north]


def pack(sizes):
    """Shelf packing, tallest first. Returns (page, x, y) per input index."""
    order = sorted(range(len(sizes)), key=lambda i: -sizes[i][1])
    pages, place = [], {}
    for i in order:
        w, h = sizes[i]
        for p, page in enumerate(pages):
            shelf = page["shelves"][-1]
            if shelf["x"] + w + PAD <= PAGE:
                break
            if page["y"] + h + PAD <= PAGE:
                page["shelves"].append({"y": page["y"], "x": PAD})
                page["y"] += h + PAD
                break
        else:
            pages.append({"y": PAD + h + PAD, "shelves": [{"y": PAD, "x": PAD}]})
            p = len(pages) - 1
        shelf = pages[p]["shelves"][-1]
        place[i] = (p, shelf["x"], shelf["y"])
        shelf["x"] += w + PAD
    return [place[i] for i in range(len(sizes))], len(pages)


def main():
    n = int(sys.argv[1])
    rivers = json.loads((ROOT / "rivers.json").read_text())[:n]
    rivers = [r for r in rivers if (GEOM / f"{r['id']}.json").exists()]
    for d in (BITMAPS, PUBLIC / "atlas"):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)

    images, bboxes = zip(*(rasterize(r) for r in rivers))
    places, npages = pack([im.size for im in images])
    pages = [Image.new("1", (PAGE, PAGE), 1) for _ in range(npages)]
    manifest = []
    for r, im, bbox, (p, x, y) in zip(rivers, images, bboxes, places):
        pages[p].paste(im, (x, y))
        w, h = im.size
        manifest.append({
            "id": r["id"], "rank": r["rank"], "name": r["name"], "length_km": r["length_km"],
            "bbox": [round(v, 6) for v in bbox],  # west, south, east, north
            "page": p,
            # texture coords with v=0 at the top row (flipY disabled on the client)
            "uv": [x / PAGE, y / PAGE, (x + w) / PAGE, (y + h) / PAGE],
        })
    for p, page in enumerate(pages):
        page.save(PUBLIC / "atlas" / f"page-{p}.png", optimize=True)
    (PUBLIC / "rivers.json").write_text(json.dumps({"pageSize": PAGE, "pages": npages, "rivers": manifest}))
    px = sum(w * h for w, h in (im.size for im in images))
    print(f"{len(rivers)} rivers -> {npages} atlas page(s), {px / 1e6:.1f} Mpx of bitmaps")


if __name__ == "__main__":
    main()
