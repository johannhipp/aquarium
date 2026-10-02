#!/usr/bin/env bash
# Build the streamed Tokyo map (public/stream/) from PLATEAU open data. It is generated, not committed.
#
#   npm run map            # or: scripts/build-map.sh
#
# Needs: Python 3.12 (uv is used if present), ~50 GB free disk for the cache, network.
# Downloads ~2.3 GB of CityGML (HTTP range requests into the ward zips listed in
# pipeline/cubeworld/stream_area.json); about 30-40 minutes on a 10-core laptop. Every step is
# resumable: re-running skips what is already in pipeline/cache/cubeworld/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CACHE="pipeline/cache/cubeworld"
VENV="$CACHE/venv"
PY="$VENV/bin/python"
STAGE="$CACHE/out-next"

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
