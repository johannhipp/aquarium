"""Download (and cache) the OSM XML for the lab area.

Usage (from project root)::

    python pipeline/cubeworld/osm_fetch.py            # download only if cache missing
    python pipeline/cubeworld/osm_fetch.py --refresh  # force re-download

Writes pipeline/cache/lab/osm.xml via the plain OSM API 0.6 /map call for the
bboxWGS84 in public/lab/area.json. Data (c) OpenStreetMap contributors, ODbL 1.0.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import labcommon as lc  # noqa: E402

OSM_CACHE = lc.CACHE_DIR / "osm.xml"
API = "https://api.openstreetmap.org/api/0.6/map"


def fetch_osm(refresh: bool = False) -> Path:
    """Return the cached OSM XML path, downloading it if missing (or `refresh`)."""
    if OSM_CACHE.exists() and not refresh:
        return OSM_CACHE
    b = lc.load_area().bbox
    bbox = f"{b['west']:.6f},{b['south']:.6f},{b['east']:.6f},{b['north']:.6f}"
    r = requests.get(API, params={"bbox": bbox}, headers={"User-Agent": lc.USER_AGENT}, timeout=120)
    r.raise_for_status()
    OSM_CACHE.parent.mkdir(parents=True, exist_ok=True)
    OSM_CACHE.write_bytes(r.content)
    print(f"downloaded {len(r.content)} bytes (bbox={bbox}) -> {OSM_CACHE}")
    return OSM_CACHE


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--refresh", action="store_true", help="re-download even if cached")
    args = ap.parse_args()
    p = fetch_osm(args.refresh)
    print(f"{p} ({p.stat().st_size} bytes)")
