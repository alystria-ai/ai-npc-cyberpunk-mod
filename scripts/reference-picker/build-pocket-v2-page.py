"""Build the Pocket v2 listening page (standard format: labelled, every column speaks the original line's text).

    python scripts/reference-picker/build-pocket-v2-page.py [--out E:/CyberpunkConvai-offload/work/pocket-v2/page]

Columns (user spec, 2026-10-06): Original | Pocket base (stock) | new Pocket student + decoder v2 | OmniVoice 16 |
OmniVoice 32, each model with 1 clip / 2 clips (10 s) / 3 clips (18 s), for the 29 shown characters, both held-out
lines. Header scores: ECAPA first (cosine to the voice's held-out real-clip centroid, macro over the shown voices),
PLS second (calibrated on the same voices: stock Pocket 1 clip = 60, OmniVoice 32 1 clip = 90). Inputs are read only:
renders in likeness-phase1/out/gen/<condition>/, out/panel.json, out/np_scores_v2.json and a per-line ECAPA cache.
Served read-only at http://127.0.0.1:8765/pocket-v2/ (scripts/reference-picker/pocket-v2-page.mjs).
"""
from __future__ import annotations

import argparse
import html
import json
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path("E:/CyberpunkConvai-offload/work/likeness-phase1/out")
SHOWN = json.loads((ROOT / "scripts/reference-picker/shown-voices.json").read_text(encoding="utf-8"))
VARIANTS = ["1 clip", "2 clips (10 s)", "3 clips (18 s)"]
MODELS = [
    ("Pocket base (stock, no fine-tuning)", ["base6-2609__cfg1", "base6-2609__multiC", "base6-2609__multiB"]),
    ("New Pocket student + decoder v2", ["ft6-v2__decv2", "ft6-v2__decv2_multiC", "ft6-v2__decv2_multiB"]),
    ("OmniVoice 16 steps", ["omni__s16_g2", "omni__s16_g2_multiC", "omni__s16_g2_multiB"]),
    ("OmniVoice 32 steps", ["omni__s32_g2", "omni__s32_g2_multiC", "omni__s32_g2_multiB"]),
]
ORIGINAL = "REAL-target-copy"

CSS = """
body{font:14px/1.4 system-ui,Segoe UI,sans-serif;margin:16px;background:#111;color:#ddd}
h1{font-size:20px} .note{max-width:1100px;color:#aaa} table{border-collapse:collapse;margin:8px 0 24px}
th,td{border:1px solid #333;padding:4px 6px;vertical-align:top;text-align:center} th{background:#1d1d1d}
td.text{text-align:left;max-width:260px;color:#eee} audio{width:150px;height:30px} .s{font-size:11px;color:#9ab}
.fam{background:#222} h2{font-size:16px;margin:20px 0 4px}
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("E:/CyberpunkConvai-offload/work/pocket-v2/page"))
    parser.add_argument("--line-ecapa", type=Path, default=Path(os.environ.get("TEMP", ".")) / "t_score_cache.json")
    parser.add_argument("--override", type=Path, action="append", default=[],
                        help="JSON {voice: {note, conditions: {condition: {files: [wav per line], ecapa: [per line], text}}}}: "
                             "renders that replace one voice's audio in the given columns (e.g. a user-chosen clip pool)")
    args = parser.parse_args()
    panel = json.loads((OUT / "panel.json").read_text(encoding="utf-8"))
    scores = json.loads((OUT / "np_scores_v2.json").read_text(encoding="utf-8"))["shown_all_lines"]
    line_ecapa = json.loads(args.line_ecapa.read_text()) if args.line_ecapa.is_file() else {}
    conds = [ORIGINAL] + [c for _, cs in MODELS for c in cs]
    missing = [c for c in conds if not (OUT / "gen" / c / "records.json").is_file()]
    if missing:
        raise SystemExit(f"renders missing: {missing}")
    audio = args.out / "audio"
    files = {}
    for c in conds:
        recs = json.loads((OUT / "gen" / c / "records.json").read_text())["records"]
        for r in recs:
            if r["speaker"] not in SHOWN:
                continue
            dest = audio / c / r["file"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            src = OUT / "gen" / c / r["file"]
            if not dest.is_file() or dest.stat().st_size != src.stat().st_size:
                shutil.copy2(src, dest)
            files[(c, r["speaker"], r["line"])] = f"audio/{c}/{r['file']}"

    overrides: dict = {}
    for path in args.override:
        for voice, item in json.loads(path.read_text(encoding="utf-8")).items():
            overrides.setdefault(voice, {"note": "", "conditions": {}})
            overrides[voice]["note"] = item.get("note", overrides[voice]["note"])
            overrides[voice]["conditions"].update(item.get("conditions", {}))
    override_ecapa = {}
    for voice, item in overrides.items():
        for c, entry in item["conditions"].items():
            for line, src in enumerate(entry["files"]):
                dest = audio / c / f"{voice}__{line}.set.wav"
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
                files[(c, voice, line)] = f"audio/{c}/{dest.name}"
                if entry.get("ecapa"):
                    override_ecapa[(c, voice, line)] = entry["ecapa"][line]

    def head_scores(c):
        s = scores.get(c, {})
        e, p = s.get("ecapa"), s.get("PLS")
        return f"ECAPA {e:.3f}" + (f" · PLS {p:.1f}" if p is not None else "") if e is not None else ""

    out = [f"<!doctype html><html><head><meta charset='utf-8'><title>Pocket v2 listening</title><style>{CSS}</style></head><body>",
           "<h1>Pocket v2 listening page</h1>",
           "<p class='note'>Every column speaks the original game line's text. These lines were never in the new student's "
           "training (held out), nor in any OmniVoice or stock-Pocket training. "
           "<b>Pocket base</b> is the stock 6-layer model with the pretrained decoder. "
           "<b>New Pocket student</b> is the 6-layer student distilled from the released 24-layer model with runtime-style "
           "1–3 clip references, the expanded clean data and voice-weighted guidance baked in, played through decoder v2. "
           "OmniVoice uses guidance 2.0. References: 1 clip = today's single reference; 2 clips = the 10 s set; "
           "3 clips = the 18 s set (whole clips, 0.4 s gaps). Scores under each header: ECAPA (speaker identity: cosine to the "
           "voice's held-out real clips, higher is better) first, then PLS (perceptual likeness, stock Pocket 1 clip = 60, "
           "OmniVoice 32 1 clip = 90), both averaged over these 29 characters. The small number under each player is that "
           "line's ECAPA.</p>"]
    header1 = "<tr><th rowspan=2>Line (original text)</th><th rowspan=2>Original</th>" + "".join(
        f"<th class='fam' colspan=3>{html.escape(name)}</th>" for name, _ in MODELS) + "</tr>"
    header2 = "<tr>" + "".join(f"<th>{v}<br><span class='s'>{head_scores(c)}</span></th>"
                               for _, cs in MODELS for v, c in zip(VARIANTS, cs)) + "</tr>"
    for voice in SHOWN:
        if voice not in panel:
            continue
        out.append(f"<h2>{html.escape(voice.replace('-', ' ').title())}</h2><table>{header1}{header2}")
        for line, target in enumerate(panel[voice]["targets"]):
            cells = [f"<td class='text'>{html.escape(target['transcript'])}</td>"]
            for c in conds:
                src = files.get((c, voice, line))
                if src is None:
                    cells.append("<td>—</td>")
                    continue
                e = line_ecapa.get(f"{c}/{voice}__{line}.wav")
                if (c, voice, line) in override_ecapa:
                    e = override_ecapa[(c, voice, line)]
                sub = f"<br><span class='s'>{e:.2f}</span>" if isinstance(e, (int, float)) and c != ORIGINAL else ""
                cells.append(f"<td><audio controls preload='none' src='{src}'></audio>{sub}</td>")
            out.append("<tr>" + "".join(cells) + "</tr>")
        out.append("</table>")
        if voice in overrides and overrides[voice]["note"]:
            out.append(f"<p class='note'>{overrides[voice]['note']}</p>")
    out.append("</body></html>")
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "index.html").write_text("\n".join(out), encoding="utf-8")
    print(json.dumps({"page": str(args.out / "index.html"), "voices": len([v for v in SHOWN if v in panel]), "audio": len(files)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
