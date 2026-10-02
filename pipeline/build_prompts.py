"""Fill the prompt template and publish the slim creature index.

Source of truth: art/creatures/creatures.full.json and art/places/places.full.json (same template) (every field, including prompt, notes, art paths) and
art/creatures/extras/*.json. This script
  1. renders art/creatures/style.json + each entry's subject/motion into its `prompt`
  2. writes the slim public/creatures/creatures.json the app fetches: only the fields it reads
     (id, common, riverId, focus, soundKnown, sprite)

Usage: python pipeline/build_prompts.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "art" / "creatures"
PUBLIC = ROOT / "public" / "creatures"
SLIM_FIELDS = ("id", "common", "riverId", "focus", "soundKnown", "sprite")


def main() -> None:
    style = json.loads((ART / "style.json").read_text())
    fields = {k: v for k, v in style.items() if isinstance(v, str)}

    def prompt(entry: dict) -> str:
        return style["template"].format(**{**fields, "subject": entry["subject"], "motion": entry["motion"]})

    creatures = json.loads((ART / "creatures.full.json").read_text())
    for c in creatures:
        c["prompt"] = prompt(c)
        print(f"--- {c['id']}\n{c['prompt']}\n")
    (ART / "creatures.full.json").write_text(json.dumps(creatures, indent=2, ensure_ascii=False) + "\n")
    slim = [{k: c[k] for k in SLIM_FIELDS} for c in creatures]
    (PUBLIC / "creatures.json").write_text(json.dumps(slim, ensure_ascii=False, separators=(",", ":")) + "\n")  # compact: fetched on every load

    places_path = ROOT / "art" / "places" / "places.full.json"  # places: objects, not creatures; same template
    if places_path.exists():
        places = json.loads(places_path.read_text())
        for pl in places:
            pl["prompt"] = prompt(pl)
            print(f"--- places/{pl['id']}\n{pl['prompt']}\n")
        places_path.write_text(json.dumps(places, indent=2, ensure_ascii=False) + "\n")

    for path in sorted((ART / "extras").glob("*.json")):  # extra images: not creature entries, same template
        extra = json.loads(path.read_text())
        extra["prompt"] = prompt(extra)
        path.write_text(json.dumps(extra, indent=2, ensure_ascii=False) + "\n")
        print(f"--- extras/{extra['id']}\n{extra['prompt']}\n")


if __name__ == "__main__":
    main()
