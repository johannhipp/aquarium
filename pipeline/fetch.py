"""Fetch river centerlines from OpenStreetMap.

For each river (all segments of the system), the segment's Wikidata item names its
OSM relation (property P402). Rivers with no P402 link are found by name through
Nominatim, bounded to the river's Wikidata coordinate (P625). Relations are downloaded
from the OSM API (`relation/<id>/full`) and walked down to their way members, skipping
tributary/spring/mouth roles and keeping only centerline waterway ways.
Output per river: cache/geom/<id>.json = list of [[lon, lat], ...] polylines.

usage: python3 fetch.py N   # fetch the first N rivers of rivers.json
"""

import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

ROOT = Path(__file__).parent
GEOM = ROOT / "cache" / "geom"
GEOM.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": "river-globe/0.1 (local experiment)"}
OSM_API = "https://api.openstreetmap.org/api/0.6"
CENTERLINE = {"river", "stream", "canal", "tidal_channel", "rapids", "waterfall", "drain", "ditch", "brook"}
SKIP_ROLES = {"tributary", "spring", "mouth", "source", "branch", "inflow", "outflow", "label"}
NOMINATIM_LOCK = threading.Lock()  # Nominatim policy: at most 1 request per second
# Hand-picked OSM ids added on top of the Wikidata/Nominatim result. Wikipedia lists these
# rivers as systems, but Wikidata's relation covers only the lower stem (or none at all), so
# the named upstream rivers are added to make the line read as a river and not a stub.
EXTRA = {
    "118-warburton": {"relations": [10813722]},         # Georgina River
    "131-hai": {"relations": [8599180]},                # Yongding River
    "140-ruki": {"relations": [13962439, 385008]},      # Busira, Tshuapa
    "161-fimi-lukenie": {"ways": [81119425, 975062545]},  # Lukenie
    "162-mobile": {"relations": [2182432, 2183787]},    # Alabama, Tombigbee
    "163-lukuga": {"relations": [1213393]},
    "226-koksoak": {"relations": [14082110]},           # Caniapiscau River
}


def osm_full(kind, osm_id):
    """Element + members with geometry from the OSM API; waits out bandwidth throttling (509/429)."""
    for _ in range(20):
        try:
            r = requests.get(f"{OSM_API}/{kind}/{osm_id}/full.json", headers=UA, timeout=(15, 300))
        except requests.RequestException:
            time.sleep(10)
            continue
        if r.status_code in (404, 410):
            return []
        if r.status_code == 200:
            break
        time.sleep(30)
    else:
        raise RuntimeError(f"OSM API {kind} {osm_id}: HTTP {r.status_code}")
    els = r.json()["elements"]
    nodes = {e["id"]: (e["lon"], e["lat"]) for e in els if e["type"] == "node"}
    for e in els:
        if e["type"] == "way":
            e["geometry"] = [nodes[n] for n in e["nodes"] if n in nodes]
    return [e for e in els if e["type"] != "relation" or e["id"] == int(osm_id)]


def centerline(way):
    return way.get("tags", {}).get("waterway") in CENTERLINE


def osm_relations(rel_ids):
    """Centerline way members + non-tributary subrelation ids of a batch of relations."""
    out, subs = {}, []
    for rel_id in rel_ids:
        els = osm_full("relation", rel_id)
        ways = {e["id"]: e for e in els if e["type"] == "way"}
        for rel in (e for e in els if e["type"] == "relation"):
            for m in rel.get("members", []):
                if m.get("role", "") in SKIP_ROLES:
                    continue
                if m["type"] == "way" and m["ref"] in ways and centerline(ways[m["ref"]]):
                    out[m["ref"]] = ways[m["ref"]]["geometry"]
                elif m["type"] == "relation":
                    subs.append(m["ref"])
    return out, subs


def wikidata_claims(qids):
    """{qid: {"p402": [relation ids], "coord": (lon, lat) | None}}, cached."""
    path = ROOT / "cache" / "wikidata.json"
    known = json.loads(path.read_text()) if path.exists() else {}
    todo = sorted(set(qids) - known.keys())
    for i in range(0, len(todo), 50):
        r = requests.get("https://www.wikidata.org/w/api.php",
                         params={"action": "wbgetentities", "ids": "|".join(todo[i:i + 50]),
                                 "props": "claims", "format": "json"}, headers=UA, timeout=60)
        r.raise_for_status()
        for q, e in r.json()["entities"].items():
            claims = e.get("claims", {})
            values = lambda p: [c["mainsnak"]["datavalue"]["value"] for c in claims.get(p, [])
                                if "datavalue" in c["mainsnak"]]
            coords = values("P625")
            known[q] = {"p402": values("P402"),
                        "coord": [coords[0]["longitude"], coords[0]["latitude"]] if coords else None}
    path.write_text(json.dumps(known))
    return known


def nominatim_lookup(river, claims):
    """OSM waterway relations / ways named like each title of the river, near its Wikidata coordinate.

    Every title is searched (a system such as Fimi-Lukenie has several); a title that has a
    relation contributes that relation, otherwise its named ways.
    """
    ways, rels = {}, []
    for i, raw in enumerate(river["titles"] or [river["name"]]):
        title = requests.utils.unquote(raw).replace("_", " ")
        params = {"q": re.sub(r"\s*\(.*?\)", "", title), "format": "jsonv2", "limit": 20}
        qid = river["qids"][i] if i < len(river["qids"]) else None
        coord = claims.get(qid, {}).get("coord")
        if coord:
            lon, lat = coord
            params.update(viewbox=f"{lon - 4},{lat + 4},{lon + 4},{lat - 4}", bounded=1)
        with NOMINATIM_LOCK:
            r = requests.get("https://nominatim.openstreetmap.org/search", params=params, headers=UA, timeout=60)
            time.sleep(1.1)
        r.raise_for_status()
        hits = [h for h in r.json() if h["category"] == "waterway"]
        found = [h["osm_id"] for h in hits if h["osm_type"] == "relation"][:1]
        if found:
            rels += found
            continue
        for h in hits:
            if h["osm_type"] == "way":
                ways.update({e["id"]: e["geometry"] for e in osm_full("way", h["osm_id"])
                             if e["type"] == "way" and centerline(e)})
    return ways, rels


def fetch_river(river, claims):
    out = GEOM / f"{river['id']}.json"
    if out.exists():
        return river["id"], "cached"
    ways, rels = {}, [int(x) for q in river["qids"] for x in claims.get(q, {}).get("p402", [])]
    if not rels:  # headwater segments without P402 are skipped; the main stem carries the line
        ways, rels = nominatim_lookup(river, claims)
    extra = EXTRA.get(river["id"], {})
    rels += extra.get("relations", [])
    for way_id in extra.get("ways", []):
        ways.update({e["id"]: e["geometry"] for e in osm_full("way", way_id)
                     if e["type"] == "way" and centerline(e)})
    seen = set()
    for _ in range(3):
        rels = [r for r in dict.fromkeys(rels) if r not in seen]
        if not rels:
            break
        seen.update(rels)
        found, rels = osm_relations(rels)
        ways.update(found)

    lines = [[[round(x, 5), round(y, 5)] for x, y in g] for g in ways.values()]
    lines = [l for l in lines if len(l) >= 2]
    if not lines:
        raise RuntimeError("no centerline geometry found")
    out.write_text(json.dumps(lines, separators=(",", ":")))
    return river["id"], f"{len(lines)} ways"


def main():
    n = int(sys.argv[1])
    rivers = json.loads((ROOT / "rivers.json").read_text())[:n]
    claims = wikidata_claims([q for r in rivers for q in r["qids"]])
    with ThreadPoolExecutor(2) as pool:
        futures = {pool.submit(fetch_river, r, claims): r["id"] for r in rivers}
        for f in as_completed(futures):
            try:
                rid, status = f.result()
            except Exception as e:  # keep going; a rerun retries only the missing ones
                rid, status = futures[f], f"FAILED {e}"
            print(rid, status, flush=True)


if __name__ == "__main__":
    main()
