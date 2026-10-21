"""A small listening sheet for a built pack: the English reference next to the new one, with both transcripts.

    python -I scripts/voice-packs/listening_sheet.py --lang zh-cn [--voices panam-palmer,...]

Writes <project>/deliverables/voice-packs/<lang>/ (git-ignored): the WAVs and an index.html with one row per voice.
Panam, Judy, Johnny, Jackie, River and two pedestrian archetypes by default.
"""
from __future__ import annotations

import argparse
import html
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vp_common as vp  # noqa: E402

DEFAULT = ["panam-palmer", "judy-alvarez", "johnny-silverhand", "jackie-welles", "river-ward", "resident-male", "resident-female"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lang", required=True)
    ap.add_argument("--voices", default=",".join(DEFAULT))
    args = ap.parse_args()
    lang = args.lang
    pack = vp.OUT / lang / "stage" / "red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual" / lang
    manifest = vp.read_json(pack / "manifest.json")
    english = vp.read_json(vp.RUNTIME / "app/defaults/local-voices.autobest-long.json")["voices"]
    out = vp.MAIN / "deliverables/voice-packs" / lang
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for key in filter(None, args.voices.split(",")):
        entry = manifest["voices"].get(key)
        en = english.get(key)
        if not entry or not en:
            rows.append(f"<tr><td>{html.escape(key)}</td><td colspan=2>not in the pack (keeps its English reference)</td></tr>")
            continue
        en_src = vp.RUNTIME / "voices" / ("archetypes/omni-long" if "/archetypes/" in en["reference"] else "picked/autobest/omni-long") / Path(en["reference"]).name
        shutil.copyfile(en_src, out / f"{key}.en.wav")
        shutil.copyfile(pack / entry["file"], out / f"{key}.{lang}.wav")
        rows.append(
            f"<tr><td><b>{html.escape(key)}</b><br>{entry['seconds']} s, {len(entry['lines'])} lines</td>"
            f"<td><audio controls preload='none' src='{key}.en.wav'></audio><p>{html.escape(en['transcript'])}</p></td>"
            f"<td><audio controls preload='none' src='{key}.{lang}.wav'></audio><p>{html.escape(entry['text'])}</p></td></tr>")
    page = ("<!doctype html><meta charset='utf-8'><title>Voice pack " + lang + "</title>"
            "<style>body{font:15px system-ui;margin:24px}td{vertical-align:top;padding:8px 12px;border-bottom:1px solid #ccc}p{max-width:46ch}</style>"
            f"<h1>Voice language pack {html.escape(lang)}: English reference vs the dub</h1>"
            "<table><tr><th>Voice</th><th>English reference</th><th>New (" + html.escape(lang) + ")</th></tr>" + "".join(rows) + "</table>")
    (out / "index.html").write_text(page, encoding="utf-8")
    print(f"listening sheet: {out / 'index.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
