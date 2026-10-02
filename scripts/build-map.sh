#!/usr/bin/env bash
# Build the streamed Tokyo map (public/stream/) from PLATEAU open data. It is generated, not committed.
#
#   npm run map            # or: scripts/build-map.sh
#
# WHAT THIS COSTS (measured on a 10-core Apple-silicon laptop, 18 wards, 16.4 x 12.8 km frame):
#   disk      about 47 GB under pipeline/cache/cubeworld/ (gitignored), of which
#               plateau2025/   40.8 GB  the CityGML members fetched from the PLATEAU ward zips (the bulk is DEM and buildings)
#               stream/         5.4 GB  intermediates: global/ 3.8 (1 m layers of the whole frame), tiles/ 1.3, dem/ 0.3
#               venv/           0.4 GB  Python environment
#             The map it produces is small: public/stream/ is about 22 MB. Once it is built you can delete
#             plateau2025/ (41 GB); a later rebuild downloads the 2.3 GB again and parses it again.
#   download  about 2.3 GB (HTTP range requests into the ward zips listed in pipeline/cubeworld/stream_area.json;
#             only the members inside the frame are fetched, never whole zips)
#   time      about 30-40 minutes: fetch 13 min (bandwidth bound), prep 3.5, raster 5, merge < 1, pack 3-5
#   RAM       up to about 4 GB for the biggest process (pack), about 1 GB for the heaviest raster tile; 10 workers in parallel
# Every step is resumable: re-running skips what is already in the cache. Needs Python 3.12 (uv is used if present).
# The script refuses to start without enough free disk (MAP_SKIP_DISK_CHECK=1 to override).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CACHE="pipeline/cache/cubeworld"
VENV="$CACHE/venv"
PY="$VENV/bin/python"
STAGE="$CACHE/out-next"

# Free-disk guard: a from-scratch build needs about 47 GB (+ margin); once the raw CityGML is cached only the
# intermediates and the output remain (about 8 GB).
need_gb=50
if [ -d "$CACHE/plateau2025" ]; then need_gb=8; fi
avail_gb=$(( $(df -k . | awk 'NR==2 {print $4}') / 1048576 ))
if [ "${MAP_SKIP_DISK_CHECK:-0}" != "1" ] && [ "$avail_gb" -lt "$need_gb" ]; then
  echo "not enough free disk: building the map needs about ${need_gb} GB free, this volume has ${avail_gb} GB." >&2
  echo "(the raw CityGML cache is 41 GB; see the header of scripts/build-map.sh. MAP_SKIP_DISK_CHECK=1 overrides.)" >&2
  exit 1
fi

if [ ! -x "$PY" ]; then
  echo "creating $VENV"
  mkdir -p "$CACHE"
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.12 "$VENV"
    uv pip install --python "$PY" -r pipeline/cubeworld/requirements.txt
  else
    python3.12 -m venv "$VENV"
    "$PY" -m pip install -r pipeline/cubeworld/requirements.txt
  fi
fi

for step in fetch prep raster merge; do
  echo "== $step"
  "$PY" pipeline/cubeworld/stream_build.py "$step"
done
echo "== pack"
rm -rf "$STAGE"
"$PY" pipeline/cubeworld/stream_build.py pack --out "$STAGE"

# Swap in one move, so a running dev server never sees a half-written archive.
rm -rf public/stream-old
if [ -d public/stream ]; then mv public/stream public/stream-old; fi
mv "$STAGE" public/stream
rm -rf public/stream-old
echo "map ready: public/stream/ ($(du -sh public/stream | cut -f1))"
echo "the raw CityGML cache ($(du -sh "$CACHE/plateau2025" 2>/dev/null | cut -f1)) is only needed to rebuild; rm -rf $CACHE/plateau2025 frees it"
