"""Step 5a of the cast sweep: a short plain-text extract of each person's Cyberpunk Wiki page, read through the MediaWiki API.

    python scripts/cast-sweep/wiki.py [--people staging/cast-sweep/final-people.json] [--out staging/cast-sweep/wiki.json]

The wiki answers a direct page fetch with HTTP 402; the API works.  Titles are looked up 40 at a time (redirects followed); a
person with no exact page gets one search, and the top hit is taken only when its title contains the person's family name or
whole name.  One request every 2 seconds, resumable (existing entries are kept).  Each extract is the infobox facts that matter
(affiliation, occupation, status, gender, voice actor is dropped) plus the plain text of the page's first ~2000 characters.
Text is used as reading material for original wording; nothing is copied into a profile.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://cyberpunk.fandom.com/api.php"
UA = "Mozilla/5.0 (research for a Cyberpunk 2077 fan mod; polite, 1 request per 2 s)"


def get(params: dict) -> dict:
    url = API + "?" + urllib.parse.urlencode({**params, "format": "json", "formatversion": "2"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=40) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            time.sleep(2)
            return data
        except Exception as exc:  # noqa: BLE001
            print("retry", attempt, exc, file=sys.stderr)
            time.sleep(8 * (attempt + 1))
    return {}


def strip_templates(text: str) -> str:
    out, depth, i = [], 0, 0
    while i < len(text):
        if text.startswith("{{", i):
            depth += 1
            i += 2
        elif text.startswith("}}", i) and depth:
            depth -= 1
            i += 2
        else:
            if not depth:
                out.append(text[i])
            i += 1
    return "".join(out)


def infobox(text: str) -> dict:
    m = re.search(r"\{\{\s*(?:Infobox[^|\n]*|Character[^|\n]*)\n?(.*?)\n\}\}", text, re.S | re.I)
    facts = {}
    if m:
        for line in m.group(1).splitlines():
            kv = re.match(r"\s*\|\s*([a-zA-Z_ ]+?)\s*=\s*(.*)", line)
            if kv and kv.group(1).lower() in {"affiliation", "occupation", "status", "gender", "residence", "location", "alias", "aliases", "born", "species", "title", "known as", "appearances", "quests"}:
                value = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", kv.group(2))
                value = re.sub(r"<[^>]+>|\{\{[^}]*\}\}", "", value).strip()
                if value:
                    facts[kv.group(1).lower()] = value[:160]
    return facts


def clean(text: str, limit: int = 2000) -> str:
    text = re.sub(r"<ref[^>]*?/>|<ref[^>]*>.*?</ref>", "", text, flags=re.S)
    text = re.sub(r"<!--.*?-->|<gallery.*?</gallery>|<[^>]+>", "", text, flags=re.S)
    text = strip_templates(text)
    text = re.sub(r"\[\[(?:File|Image|Category)[^\]]*\]\]", "", text)
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"'{2,}", "", text)
    text = re.sub(r"^=+\s*(.*?)\s*=+\s*$", r"\n## \1", text, flags=re.M)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:limit]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--people", default="staging/cast-sweep/final-people.json")
    ap.add_argument("--out", default="staging/cast-sweep/wiki.json")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    people = json.loads(Path(args.people).read_text(encoding="utf-8"))
    out_path = Path(args.out)
    done = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
    todo = [p for p in people if p["key"] not in done]
    if args.limit:
        todo = todo[:args.limit]

    def save():
        out_path.write_text(json.dumps(done, ensure_ascii=False, indent=0), encoding="utf-8")

    def title_of(p):
        name = re.sub(r'^(?:Dr\.|Lt\.|Cpl\.|Det\.|Officer|Captain|Mayor|Deputy Mayor|Prof\.|Reverend)\s+', "", p["name"]).strip()
        return name.replace('"', "'")

    batch = []
    titles = {}
    for p in todo:
        t = title_of(p).replace(" ", "_")
        titles[p["key"]] = t
    keys = list(titles)
    for i in range(0, len(keys), 40):
        chunk = keys[i:i + 40]
        data = get({"action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main", "redirects": "1",
                    "titles": "|".join(titles[k] for k in chunk)})
        pages = {}
        for page in data.get("query", {}).get("pages", []):
            if "missing" not in page and page.get("revisions"):
                pages[page["title"].lower().replace(" ", "_")] = page
        norm = {}
        for n in data.get("query", {}).get("normalized", []) + data.get("query", {}).get("redirects", []):
            norm[n["from"].lower().replace(" ", "_")] = n["to"].lower().replace(" ", "_")
        for k in chunk:
            t = titles[k].lower()
            seen = 0
            while t in norm and seen < 3:
                t, seen = norm[t], seen + 1
            page = pages.get(t)
            if page:
                text = page["revisions"][0]["slots"]["main"]["content"]
                if text.lstrip().lower().startswith("#redirect"):
                    page = None
            if page:
                done[k] = {"title": page["title"], "infobox": infobox(text), "text": clean(text), "how": "title"}
        save()
        print(f"titles {i + len(chunk)}/{len(keys)} found so far {sum(1 for k in keys if k in done)}", flush=True)
    # one search for the rest: a page whose title holds the whole name, else the top pages that mention the person (snippets only)
    for p in todo:
        if p["key"] in done:
            continue
        name = title_of(p)
        words = re.sub(r"[^A-Za-z ]+", " ", name).split()
        data = get({"action": "query", "list": "search", "srsearch": '"' + name + '"', "srlimit": "4", "srnamespace": "0", "srprop": "snippet"})
        hits = [h for h in data.get("query", {}).get("search", []) if ":" not in h["title"]]
        own = next((h for h in hits if words and all(w.lower() in h["title"].lower() for w in words) and len(words) >= 2), None)
        if own:
            page = get({"action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main", "redirects": "1", "titles": own["title"]})
            pgs = page.get("query", {}).get("pages", [])
            if pgs and pgs[0].get("revisions"):
                text = pgs[0]["revisions"][0]["slots"]["main"]["content"]
                done[p["key"]] = {"title": pgs[0]["title"], "infobox": infobox(text), "text": clean(text), "how": "search"}
                save()
                continue
        mentions = [{"page": h["title"], "snippet": re.sub(r"<[^>]+>|&quot;|&#039;", "", h.get("snippet", "")).strip()[:220]} for h in hits[:3]]
        done[p["key"]] = {"title": None, "infobox": {}, "text": "", "how": "mentions" if mentions else "none", "mentions": mentions}
        save()
    print("with a page:", sum(1 for v in done.values() if v["title"]), "of", len(done))
    return 0


if __name__ == "__main__":
    sys.exit(main())
