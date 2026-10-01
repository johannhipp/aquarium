"""Build rivers.json: the longest river systems, ranked by length.

Source: Wikipedia "List of river systems by length" (first length figure per row),
topped up from Wikidata (P2043 length) when the list is shorter than TARGET.
Each river keeps every linked segment (e.g. Nile – White Nile – Kagera) so the
whole flow path can be fetched from OpenStreetMap via the segments' Wikidata IDs.
"""

import json
import re
import sys
from pathlib import Path

import bs4
import requests

ROOT = Path(__file__).parent
CACHE = ROOT / "cache"
UA = {"User-Agent": "river-globe/0.1 (local experiment)"}
TARGET = int(sys.argv[1]) if len(sys.argv) > 1 else 233


def wiki_rows():
    path = CACHE / "wiki_list.json"
    if not path.exists():
        r = requests.get(
            "https://en.wikipedia.org/w/api.php",
            params={"action": "parse", "page": "List_of_river_systems_by_length",
                    "prop": "text", "format": "json", "formatversion": 2},
            headers=UA, timeout=60)
        r.raise_for_status()
        path.write_text(r.text)
    html = json.loads(path.read_text())["parse"]["text"]
    table = bs4.BeautifulSoup(html, "lxml").select("table.wikitable")[1]
    for row in table.select("tr")[1:]:
        cells = row.select("th,td")
        name = re.sub(r"\s*\[.*?\]", "", cells[1].get_text(" ", strip=True)).strip()
        length = int(re.match(r"[\d,]+", cells[2].get_text(" ", strip=True)).group().replace(",", ""))
        titles = []
        for a in cells[1].select("a[href^='/wiki/']"):
            t = a["href"].removeprefix("/wiki/").split("#")[0]
            if ":" not in t and t not in titles:
                titles.append(t)
        yield {"name": name, "length_km": length, "titles": titles or [name.replace(" ", "_")]}


def wikidata_ids(titles):
    out = {}
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        r = requests.get(
            "https://en.wikipedia.org/w/api.php",
            params={"action": "query", "prop": "pageprops", "ppprop": "wikibase_item",
                    "redirects": 1, "titles": "|".join(requests.utils.unquote(t) for t in chunk),
                    "format": "json", "formatversion": 2},
            headers=UA, timeout=60)
        r.raise_for_status()
        q = r.json()["query"]
        alias = {}
        for n in q.get("normalized", []):
            alias[n["from"]] = n["to"]
        for n in q.get("redirects", []):
            alias[n["from"]] = n["to"]
        by_title = {p["title"]: p.get("pageprops", {}).get("wikibase_item") for p in q["pages"]}
        for t in chunk:
            name = requests.utils.unquote(t)
            while name in alias:
                name = alias[name]
            out[t] = by_title.get(name)
    return out


def wikidata_topup(exclude_qids, need):
    """Next-longest rivers under 1000 km from Wikidata (instance of river, length P2043 in km)."""
    query = """
    SELECT ?river ?riverLabel ?len WHERE {
      ?river wdt:P31 wd:Q4022; p:P2043/psv:P2043 ?v .
      ?v wikibase:quantityAmount ?len; wikibase:quantityUnit wd:Q828224 .
      FILTER(?len < 1000 && ?len >= 900)
      ?article schema:about ?river; schema:isPartOf <https://en.wikipedia.org/> .
      ?river rdfs:label ?riverLabel . FILTER(LANG(?riverLabel) = "en")
    } ORDER BY DESC(?len) LIMIT 200"""
    r = requests.get("https://query.wikidata.org/sparql",
                     params={"query": query, "format": "json"}, headers=UA, timeout=120)
    r.raise_for_status()
    rows, seen = [], set(exclude_qids)
    for b in r.json()["results"]["bindings"]:
        qid = b["river"]["value"].rsplit("/", 1)[1]
        if qid in seen:
            continue
        seen.add(qid)
        rows.append({"name": b["riverLabel"]["value"], "length_km": round(float(b["len"]["value"])),
                     "titles": [], "qids": [qid]})
        if len(rows) == need:
            break
    return rows


def main():
    rivers = list(wiki_rows())
    ids = wikidata_ids(sorted({t for r in rivers for t in r["titles"]}))
    for r in rivers:
        r["qids"] = [ids[t] for t in r["titles"] if ids.get(t)]
    if len(rivers) < TARGET:
        rivers += wikidata_topup({q for r in rivers for q in r["qids"]}, TARGET - len(rivers))
    rivers.sort(key=lambda r: -r["length_km"])
    rivers = rivers[:TARGET]
    for i, r in enumerate(rivers, 1):
        r["rank"] = i
        r["id"] = f"{i:03d}-" + re.sub(r"[^a-z0-9]+", "-", r["name"].split("–")[0].lower()).strip("-")
    (ROOT / "rivers.json").write_text(json.dumps(rivers, indent=1, ensure_ascii=False))
    missing = [r["name"] for r in rivers if not r["qids"]]
    print(f"{len(rivers)} rivers, {len(missing)} without wikidata: {missing}")


if __name__ == "__main__":
    main()
