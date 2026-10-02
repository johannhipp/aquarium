"""Street-level pole / lamp / tree layer: OSM counts + Mapillary map features.

usage:
  python pointcloud_streetlevel.py osm     [W S E N]     # OSM tag counts in a bbox (OSM API map call)
  python pointcloud_streetlevel.py mapillary [W S E N]   # needs MAPILLARY_TOKEN (free client token, see below)

Default bbox = public/lab/area.json (Yakkozaka).

Mapillary (CC BY-SA 4.0 data):
  1. https://www.mapillary.com/dashboard/developers -> "Register application" (free, a Mapillary/Facebook login)
  2. copy the *client token* (MLY|<app id>|<hash>)
  3. export MAPILLARY_TOKEN='MLY|...'
  GET https://graph.mapillary.com/map_features?access_token=$TOKEN
      &fields=id,object_value,geometry,first_seen_at,last_seen_at
      &bbox=W,S,E,N                       (bbox must be < 0.01 deg^2)
      &object_values=object--support--utility-pole,object--street-light
  Every request without a token returns {"error":{"code":190,"message":"Invalid OAuth 2.0 Access Token"}}
  (verified from this machine; no token is available here, so no Mapillary numbers are reported).
"""

import json
import os
import sys
import urllib.parse
import urllib.request

from pointcloud_common import UA, load_area

OSM_KEYS = [
    ("highway", "street_lamp"), ("power", "pole"), ("man_made", "utility_pole"), ("natural", "tree"),
    ("natural", "tree_row"), ("highway", "traffic_signals"), ("highway", "crossing"), ("barrier", "fence"),
    ("barrier", "wall"), ("amenity", "vending_machine"), ("highway", "bus_stop"),
]
MAPILLARY_VALUES = ["object--support--utility-pole", "object--street-light", "object--support--pole",
                    "object--traffic-light--general-upright-front", "nature--vegetation"]


def bbox_from_args(args):
    if len(args) == 4:
        return tuple(float(a) for a in args)
    b = load_area()["bboxWGS84"]
    return b["west"], b["south"], b["east"], b["north"]


def osm_counts(w, s, e, n):
    """Count tags with the OSM API `map` call (reliable for boxes of a few hundred metres; Overpass 504s from here)."""
    import xml.etree.ElementTree as ET

    url = f"https://api.openstreetmap.org/api/0.6/map?bbox={w},{s},{e},{n}"
    root = ET.fromstring(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read())
    out = {f"{k}={v}": 0 for k, v in OSM_KEYS}
    for el in root:
        if el.tag in ("node", "way"):
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            for k, v in OSM_KEYS:
                if tags.get(k) == v:
                    out[f"{k}={v}"] += 1
    out["building=*"] = sum(1 for w_ in root.findall("way") if any(t.get("k") == "building" for t in w_.findall("tag")))
    return out


def mapillary(w, s, e, n):
    token = os.environ.get("MAPILLARY_TOKEN")
    if not token:
        sys.exit("MAPILLARY_TOKEN not set - see the module docstring for how to get a free client token")
    q = urllib.parse.urlencode({
        "access_token": token, "fields": "id,object_value,geometry,first_seen_at,last_seen_at",
        "bbox": f"{w},{s},{e},{n}", "object_values": ",".join(MAPILLARY_VALUES), "limit": 2000,
    })
    d = json.load(urllib.request.urlopen(f"https://graph.mapillary.com/map_features?{q}", timeout=60))
    counts = {}
    for f in d.get("data", []):
        counts[f["object_value"]] = counts.get(f["object_value"], 0) + 1
    return counts, d.get("data", [])


if __name__ == "__main__":
    mode = sys.argv[1]
    box = bbox_from_args(sys.argv[2:6])
    if mode == "osm":
        print(json.dumps(osm_counts(*box), indent=1))
    elif mode == "mapillary":
        counts, feats = mapillary(*box)
        print(json.dumps(counts, indent=1))
    else:
        sys.exit(__doc__)
