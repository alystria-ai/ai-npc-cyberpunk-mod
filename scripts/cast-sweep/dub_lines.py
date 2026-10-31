"""The dubbed voice lines of the side characters that have a clip of their own, per language (docs/CAST_SWEEP.md, "Voice models").

    <vendor python> -I scripts/cast-sweep/dub_lines.py --out staging/side-voices-dub-lines.json [--langs de,fr,...] [--keys a,b]

For every side character with a `clip` in characters/cast-sweep-voices.json and every dubbed language of the game (de, es-es, fr, it, ja, ko, pl, pt-br, ru, zh-cn) this finds
the dub line with the builder's rules (scripts/voice-packs, docs/VOICE_PACK_BUILDER.md): the same string id and file stem under the language's locale folder of
E:/SteamLibrary/AiNpc-vo-stash/<lang>/{content,ep1} (else the same string id), decoded with vgmstream, and the builder's per-clip checks (1 to 12 s, not clipped, gated level -36 to -10 dBFS)
plus a non-empty subtitle of that language (`lang_<xx>_text.archive`, female variant for an `_f_` file, markup resolved).  When the line is missing or fails, the builder's
fallback rule applies: the next line of the same voice tag in the order the English choice ranked them (closest to 14 words), up to 6 tries.
Result: {"version": 1, "own": {key: {lang: {"id", "path", "stash", "seconds", "gatedDb", "text", "sameLine": bool, "tries": n} or {"missing": reason}}},
"modelMapped": {key: {"archetype": archetype voice key, "model": voice model, "packLanguages": [languages whose multilingual pack has that archetype voice]}},
"modelVoices": {"model-<model>": {lang: {"lines": [{"id", "path", "stash", "seconds", "text"} ...], "missing": [ids the dub lacks or fails]}}} (the new archetype voices built for models no archetype covered, with
every line of the three English references).  It is a data file for the on-demand language clips,
not part of the repository (it holds dub dialogue).  Archives are only read.  Work files go to E:/CyberpunkConvai-offload/work/side-voice-models/dub.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / "scripts/voice-packs"))
sys.path.insert(0, str(REPO / "scripts/clip-search/cast-expansion"))
import vp_common as vp  # noqa: E402

vp.WORK = Path("E:/CyberpunkConvai-offload/work/side-voice-models/dub")
import build_pack as bp  # noqa: E402
import vp_text  # noqa: E402
from cx_common import Subtitles, parse_wem, wem_lists, words  # noqa: E402

LANGS = ["de", "es-es", "fr", "it", "ja", "ko", "pl", "pt-br", "ru", "zh-cn"]


def english_candidates(stem_names: list[str], first_id: str) -> list[dict]:
    """The chosen line first, then the other lines of the same voice tag closest to 14 words (the voices.py order), as the builder's English line dicts."""
    subs = Subtitles()
    found = {}
    for label, lines in wem_lists().items():
        for path in lines:
            parsed = parse_wem(path)
            if not parsed or parsed[0] != "vo" or parsed[1].lower() not in stem_names:
                continue
            match = vp.WEM_RE.match(path)
            if not match:
                continue
            row = found.setdefault(parsed[3], {})
            row[parsed[2]] = {"hex": match["hex"], "fm": match["fm"], "vo": match["vo"], "stem": match["stem"], "rest": match["rest"], "archive": "ep1" if match["top"].lower() == "ep1" else "content", "sid": parsed[3]}
    ranked = []
    for sid, variants in found.items():
        variant = "f" if "f" in variants else "m"
        n = words(subs.text(sid, variant))
        if n >= 6:
            ranked.append((sid != first_id, abs(n - 14), sid, variants[variant]))
    ranked.sort(key=lambda r: r[:3])
    return [r[3] for r in ranked[:7]]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True)
    parser.add_argument("--langs")
    parser.add_argument("--keys")
    parser.add_argument("--models", action="store_true", help="also check every line of the new model-<model> archetype voices")
    args = parser.parse_args()
    sweep = json.loads((REPO / "characters/cast-sweep-voices.json").read_text(encoding="utf-8"))["characters"]
    keys = [k for k, row in sweep.items() if row.get("clip") and (not args.keys or k in args.keys.split(","))]
    langs = args.langs.split(",") if args.langs else LANGS
    plan = {}
    for key in keys:
        clip = sweep[key]["clip"]
        link = sweep[key].get("link") or {}
        stems = {clip["stem"]}
        if link.get("tag"):
            stems |= {s for _l, lines in wem_lists().items() for s in {(parse_wem(p) or ("", "",))[1].lower() for p in lines} if s == link["tag"] or s.startswith(link["tag"] + "_")}
        plan[key] = english_candidates(stems, str(clip["id"]))
    path = Path(args.out)
    full = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    if "own" not in full:
        full = {"version": 1, "own": full, "modelMapped": {}}
    out = full["own"]
    for lang in langs:
        dub = bp.Dub(lang)
        subs = vp_text.Subtitles(lang)
        for key in keys:
            result = {"missing": "no candidate line"}
            for tries, line in enumerate(plan[key], 1):
                found, note = dub.find(line)
                if found is None:
                    result = {"missing": note}
                    continue
                dub.prepare([found])
                audio = bp.load_audio(dub, found, "picked")
                if audio is None:
                    result = {"missing": "the dub file could not be decoded"}
                    continue
                problem = bp.check_clip(audio)
                if problem:
                    result = {"missing": problem}
                    continue
                text, why = subs.text(line["sid"], line["fm"])
                if not text:
                    result = {"missing": why}
                    continue
                measure = vp.measure(audio)
                result = {"id": line["hex"], "path": dub.index[found], "stash": found[0], "seconds": round(len(audio) / vp.RATE, 2), "gatedDb": measure["gatedRmsDb"], "text": text,
                          "sameLine": tries == 1 and not note, "tries": tries, **({"note": note} if note else {})}
                break
            out.setdefault(key, {})[lang] = result
        print(lang, sum(1 for k in keys if "id" in out[k][lang]), "of", len(keys), flush=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(full, ensure_ascii=False, indent=1), encoding="utf-8")
    if args.models:
        manifest = json.loads((REPO / "characters/voice-clips-manifest.json").read_text(encoding="utf-8"))["voices"]
        wanted = {}
        for key, kinds in manifest.items():
            if key.startswith("model-"):
                seen = {}
                for spec in kinds.values():
                    for line in spec.get("lines", []):
                        match = vp.WEM_RE.match(line["path"])
                        seen[match["hex"]] = {"hex": match["hex"], "fm": match["fm"], "vo": match["vo"], "stem": match["stem"], "rest": match["rest"], "archive": "ep1" if match["top"].lower() == "ep1" else "content"}
                wanted[key] = list(seen.values())
        full.setdefault("modelVoices", {})
        for lang in langs:
            dub = bp.Dub(lang)
            subs = vp_text.Subtitles(lang)
            located = {}
            for key, lines in wanted.items():
                for line in lines:
                    found, _note = dub.find(line)
                    if found is not None:
                        located[(key, line["hex"])] = found
            dub.prepare(sorted(set(located.values())))          # one extraction and decode for all the files of the language
            for key, lines in wanted.items():
                row = {"lines": [], "missing": []}
                for line in lines:
                    found = located.get((key, line["hex"]))
                    problem = "the line is not in the dub archive" if found is None else None
                    if found is not None:
                        audio = bp.load_audio(dub, found, "picked")
                        problem = "the dub file could not be decoded" if audio is None else bp.check_clip(audio)
                    text = ""
                    if not problem:
                        text, problem = subs.text(str(int(line["hex"], 16)), line["fm"])
                    if problem:
                        row["missing"].append(line["hex"])
                    else:
                        row["lines"].append({"id": line["hex"], "path": dub.index[found], "stash": found[0], "seconds": round(len(audio) / vp.RATE, 2), "text": text})
                full["modelVoices"].setdefault(key, {})[lang] = row
            print(lang, "model voices", sum(1 for k in wanted if full["modelVoices"][k][lang]["lines"]), "of", len(wanted), "have dub lines;", sum(len(full["modelVoices"][k][lang]["missing"]) for k in wanted), "lines missing", flush=True)
            path.write_text(json.dumps(full, ensure_ascii=False, indent=1), encoding="utf-8")
    # side characters mapped to a generic voice model: only the archetype key (the languages' archetype voices are the model's own dub)
    packs = {}
    pack_root = vp.RUNTIME / "voices/multilingual"
    for lang in LANGS:
        manifest = pack_root / lang / "manifest.json"
        packs[lang] = set(json.loads(manifest.read_text(encoding="utf-8-sig"))["voices"]) if manifest.is_file() else set()
    for key, row in sweep.items():
        if row.get("voiceModel") and not row.get("clip"):
            full["modelMapped"][key] = {"archetype": row["fallback"], "model": row["voiceModel"]["model"], "packLanguages": [lang for lang in LANGS if row["fallback"] in packs[lang]]}
    path.write_text(json.dumps(full, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
