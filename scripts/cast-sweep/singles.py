"""Review helper: single-word names and the people/roster entries that share a word with them."""
import json, re, sys, unicodedata
sys.stdout.reconfigure(encoding="utf-8")
base = "staging/cast-sweep/"
people = json.load(open(base + "people.json", encoding="utf8"))
roster = json.load(open("characters/roster.json", encoding="utf8"))


def norm(t):
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]+", " ", t).split()


pool = [(r["name"], "ROSTER", r["key"], r.get("records", [])) for r in roster] + [(p["name"], "new", p["key"], p["records"]) for p in people]
for p in people:
    toks = norm(p["name"])
    if len(toks) != 1:
        continue
    hits = [f"{n} ({src}) {recs[:2]}" for n, src, k, recs in pool if k != p["key"] and toks[0] in norm(n)]
    print(f"{p['name']} {p['records'][:3]} aff={p['affiliations']} -> " + (" | ".join(hits[:4]) if hits else "-"))
