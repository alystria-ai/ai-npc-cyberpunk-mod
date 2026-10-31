"""Choose the dub lines of the side characters' language clips with the multilingual pack builder's rules and write the specs add_language_voice.py builds from.

    <vendor python> -I scripts/voice-extract/side_language_voices.py --dub-lines <side-voices-dub-lines.json> --out <folder> [--langs de,fr] [--keys a,b] [--only own,models,missing]
            [--no-speaker]

Three groups of voices, each for the ten dubbed languages (docs/VOICE_LANGUAGE_PACKS.md, "Clips on demand"):

  own      the side characters that have a clip of their own (characters/cast-sweep-voices.json `clip`).  The English clip is one game line, so the language clip is the same
           line of the dub (scripts/cast-sweep/dub_lines.py already applied the builder's per-clip checks and its fallback to the next ranked line, the data file is its output).
           Kind `picked`, one line, no gain.
  models   the `model-<model>` archetype voices (characters/model-voices.json).  The builder's own build_voice is run on the English long reference's lines: whole dub lines in
           order, a line the dub lacks or that fails a check replaced by the next line the English scoring ranked (the archetype manifest's order), the set cut to 19.9 s by
           dropping whole last lines, topped up when it is under 8 s, the ECAPA speaker check when the weights are installed.  Kind `archetypes`, no gain.
  missing  the archetype voices that exist in English but were left out of the packs (npc-joytoy-female, npc-joytoy-male, npc-maxtac-male, npc-maxtac-male-v2, npc-nusa-male-v2),
           built the same way from scripts/voice-packs/line-lists.json.
  extra    six more of the same kind (EXTRA_MISSING), only when asked for with --only extra.

Output: <out>/specs.json (the specs for add_language_voice.py), <out>/ref/<lang>/<kind>/<key>.wav (the builder's own audio, to compare the recipe's rebuild with) and
<out>/report.json (what was replaced, dropped or left out, per voice and language).  Archives are only read, work files go to the side-voice work folder on E:.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / "scripts/voice-packs"))
import vp_common as vp  # noqa: E402

vp.WORK = Path("E:/CyberpunkConvai-offload/work/side-voice-models/dub")          # the folder dub_lines.py filled: extracted wem, decoded wav, archive listings
import build_pack as bp  # noqa: E402
import vp_text  # noqa: E402

LANGS = ["de", "es-es", "fr", "it", "ja", "ko", "pl", "pt-br", "ru", "zh-cn"]
MISSING = ["npc-joytoy-female", "npc-joytoy-male", "npc-maxtac-male", "npc-maxtac-male-v2", "npc-nusa-male-v2"]
# Six more archetype voices that exist in English and were also left out of the packs (found when checking which archetype keys a side character's voice can resolve to: the voice
# service picks a variant of the alias, so the -v2 voices and the female and male siblings are spoken too).
EXTRA_MISSING = ["npc-joytoy-female-v2", "npc-joytoy-male-v2", "npc-maxtac-female", "npc-nusa-female", "npc-nusa-female-v2", "npc-nusa-male",
                 "npc-militech-female"]            # the last one is in the German, Spanish, Italian, Japanese, Korean and Portuguese packs and was left out of the French, Polish and Russian ones


def english_lines(spec_lines: list) -> list[dict]:
    out = []
    for line in spec_lines:
        match = vp.WEM_RE.match(line["path"])
        out.append({"hex": match["hex"], "fm": match["fm"], "vo": match["vo"], "stem": match["stem"], "rest": match["rest"],
                    "archive": "ep1" if match["top"].lower() == "ep1" else "content"})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dub-lines", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--langs", default="")
    ap.add_argument("--keys", default="")
    ap.add_argument("--only", default="")
    ap.add_argument("--no-speaker", action="store_true")
    ap.add_argument("--drop", default="", help="lang:key:line id[,...]: a line of the English set that the dub gave to another actor, left out of the build (the speaker check named it)")
    args = ap.parse_args()
    drops = [tuple(item.split(":")) for item in args.drop.split(",") if item]
    out = Path(args.out)
    langs = args.langs.split(",") if args.langs else LANGS
    only_keys = set(filter(None, args.keys.split(",")))
    groups = set(filter(None, args.only.split(","))) or {"own", "models", "missing"}      # `extra` only when asked for
    data = json.loads(Path(args.dub_lines).read_text(encoding="utf-8"))
    manifest = json.loads((REPO / "characters/voice-clips-manifest.json").read_text(encoding="utf-8"))["voices"]
    model_voices = json.loads((REPO / "characters/model-voices.json").read_text(encoding="utf-8"))["voices"]
    roster = {row["key"]: row for row in json.loads((REPO / "characters/roster.json").read_text(encoding="utf-8"))}
    line_lists = json.loads((REPO / "scripts/voice-packs/line-lists.json").read_text(encoding="utf-8"))["voices"]

    speaker, threshold = None, 0.10
    if not args.no_speaker:
        import vp_speaker
        if vp_speaker.available():
            speaker = vp_speaker.Speaker(threads=2)
            vp.log("speaker check on (bar 0.10, the builder's floor: the lines of one voice model are one speaker)")
        else:
            vp.log("ECAPA weights not found: speaker check skipped (the lines of one voice model are one speaker)")

    wanted: dict[str, dict] = {}
    if "own" in groups:
        for key, per_lang in data["own"].items():
            if only_keys and key not in only_keys:
                continue
            gender = (roster.get(key) or {}).get("gender") or ""
            wanted[key] = {"kind": "picked", "gender": gender.lower() or None, "own": per_lang}
    if "models" in groups:
        for key, row in model_voices.items():
            if only_keys and key not in only_keys:
                continue
            spec = manifest[key]["omni-long"]
            wanted[key] = {"kind": "archetypes", "gender": row["gender"].lower(), "row": {"kind": "archetypes", "lines": english_lines(spec["lines"]), "gainStage": False}}
    if "missing" in groups or "extra" in groups:
        for key in (MISSING if "missing" in groups else []) + (EXTRA_MISSING if "extra" in groups else []):
            if only_keys and key not in only_keys:
                continue
            row = line_lists[key]
            wanted[key] = {"kind": "archetypes", "gender": "female" if key.endswith("female") else "male", "row": {"kind": "archetypes", "lines": row["lines"], "gainStage": bool(row.get("gainStage"))}}

    english = bp.English()
    specs = {key: {"key": key, "kind": item["kind"], **({"gender": item["gender"]} if item["gender"] else {}), "voices": {}} for key, item in wanted.items()}
    report: dict = {}
    for lang in langs:
        dub = bp.Dub(lang)
        subs = vp_text.Subtitles(lang)
        vp.log(f"{lang}: {len(dub.index)} voice files in the dub")
        for key, item in wanted.items():
            rep = report.setdefault(key, {}).setdefault(lang, {})
            if "own" in item:
                line = item["own"][lang]
                if "id" not in line:
                    rep["left out"] = line.get("missing", "no line")
                    continue
                specs[key]["voices"][lang] = {"lines": [{"id": line["id"], "path": line["path"], "stash": line["stash"]}], "text": line["text"]}
                rep.update(lines=1, seconds=line["seconds"], sameLine=line["sameLine"])
                continue
            row = item["row"]
            gone = {hex_id for (d_lang, d_key, hex_id) in drops if d_lang == lang and d_key == key}
            if gone:
                row = {**row, "lines": [line for line in row["lines"] if line["hex"] not in gone]}
                rep["dropped before the build"] = sorted(gone)
            result = bp.build_voice(key, row, dub, subs, english, speaker, threshold, None)
            rep.update({k: v for k, v in result["report"].items() if k in ("replaced", "missing", "dropped", "notes", "speakerMinCosine", "borderlineSpeaker") and v})
            if not result["ok"]:
                rep["left out"] = result["report"]["notes"][-1] if result["report"]["notes"] else "unusable"
                vp.log(f"  {key}: LEFT OUT ({rep['left out']})")
                continue
            clips = result["clips"]
            specs[key]["voices"][lang] = {"lines": [{"id": c.line["hex"], "path": dub.index[c.key], "stash": c.key[0]} for c in clips], "text": " ".join(c.text for c in clips)}
            rep.update(lines=len(clips), seconds=result["seconds"])
            vp.write_pcm16(out / "ref" / lang / item["kind"] / f"{key}.wav", result["audio"])
        done = sum(1 for key in wanted if lang in specs[key]["voices"])
        vp.log(f"{lang}: {done} of {len(wanted)} voices have a dub clip")
        out.mkdir(parents=True, exist_ok=True)
        (out / "specs.json").write_text(json.dumps({"voices": list(specs.values())}, ensure_ascii=False, indent=1), encoding="utf-8")
        (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
