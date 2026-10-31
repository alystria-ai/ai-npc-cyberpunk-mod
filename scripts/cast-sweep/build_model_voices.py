"""Build archetype style references for the generic voice models that side characters are proven to use (docs/CAST_SWEEP.md, "Voice models").

    python scripts/cast-sweep/build_model_voices.py --models civ_high_m_07_enus_40,gang_kml_m_02_enus_40 [--plan-only]

A generic voice model (civilians, gangs, police, security, mercs: `civ_high_m_07_enus_40`) is one voice actor.  Many archetype voices of characters/archetypes.json already are one
such model each (characters/archetype-voices.json `voiceset`).  For a model that has none, this makes one with the SAME recipe and the SAME code as
scripts/archetype-voices/build_archetype_voices.py (calm conversational lines of the actor, 1.5 to 9 s, 4 to 28 words, no clipping, no phone band, loudness within the actor's window,
whole clips joined with 0.4 s of silence, omni-short <= 10 s, omni-long <= 18 s, pocket <= 20 s, no EQ, denoise, gain or trim), but for exactly the model asked for, never another.

The key is `model-<model with dashes>` (e.g. `model-civ-high-m-07-enus-40`).  Outputs, as the archetype builder writes them:
  runtime/voice-references/archetypes/<engine>/<key>.wav and the manifest beside them (git-ignored, holds game dialogue)
  characters/archetype-voices.json   the tracked receipt (no dialogue text), `modelVoice: true` on these entries
  characters/model-voices.json       {key: {voiceset, gender}} so register_archetype_voices.mjs registers them in the live configs
A model whose actor has no usable set of clips is listed as `unprepared` in the report and gets no key.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
spec = importlib.util.spec_from_file_location("archetype_builder", REPO / "scripts/archetype-voices/build_archetype_voices.py")
B = importlib.util.module_from_spec(spec)
sys.modules["archetype_builder"] = B
spec.loader.exec_module(B)

CATALOGUE = REPO / "characters/model-voices.json"


def model_key(model: str) -> str:
    return "model-" + model.replace("_", "-")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models", required=True, help="comma separated voice models, or @file with a JSON list")
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument("--report", help="write the result per model here")
    args = parser.parse_args()
    models = json.loads(Path(args.models[1:]).read_text(encoding="utf-8")) if args.models.startswith("@") else [m for m in args.models.split(",") if m]
    B.pool_extract.set_low_priority()
    subtitles = B.read_json(B.SRC / "subtitles.json")
    flagged = B.known_flagged_sids()
    lines = B.load_lines()
    manifest = B.read_json(B.MANIFEST) if B.MANIFEST.exists() else {"version": 1, "builtAt": None, "note": "contains game dialogue; git-ignored", "voices": {}}
    receipt = B.read_json(B.RECEIPT)
    catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8")) if CATALOGUE.exists() else {"version": 1, "voices": {}}
    used = {entry.get("voiceset"): key for key, entry in receipt["voices"].items() if entry.get("status") == "ready"}
    cache_path = B.AWORK / "decode-cache.json"
    cache = B.read_json(cache_path) if cache_path.exists() else {}
    report, built = {}, datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest["updatedAt"] = built
    for model in models:
        key = model_key(model)
        if model in used:
            report[model] = {"status": "exists", "key": used[model]}
            continue
        good = {model: [l for l in lines.get(model, []) if B.text_reason(l, subtitles, flagged) is None]}
        if not good[model]:
            report[model] = {"status": "unprepared", "reason": "no clean conversational line"}
            continue
        if args.plan_only:
            report[model] = {"status": "plan", "key": key, "lines": len(good[model])}
            continue
        refs, drops, why = B.try_voiceset(model, key, good, cache)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache), encoding="utf-8")
        if refs is None:
            report[model] = {"status": "unprepared", "reason": why, "drops": drops}
            B.log(f"{key}: unprepared ({why})")
            continue
        used_clips = {}
        for engine, clips in refs.items():
            for clip in clips:
                used_clips.setdefault(clip["sid"], clip)
        result = {"status": "ready", "voiceset": model, "drops": drops, "tried": [],
                  "clips": [{"sid": c["sid"], "wem": c["wem"], "archive": c["archive"], "seconds": c["d"], "gatedDb": c["lv"], "text": c["text"]} for c in used_clips.values()],
                  "references": {}}
        for engine, clips in refs.items():
            path = B.OUT_DIR / engine / f"{key}.wav"
            info = B.write_reference(clips, path)
            result["references"][engine] = {"path": path.relative_to(B.ROOT).as_posix(), **info, "clips": [c["sid"] for c in clips], "transcript": " ".join(c["text"] for c in clips)}
        manifest["voices"][key] = result
        B.atomic_json(B.MANIFEST, manifest)
        receipt["voices"][key] = {**B.receipt_entry(result), "modelVoice": True}
        gender = "FEMALE" if "_f_" in model else "MALE"
        catalogue["voices"][key] = {"voiceset": model, "gender": gender}
        report[model] = {"status": "ready", "key": key, "seconds": {e: result["references"][e]["seconds"] for e in B.CAPS}, "clips": {e: len(result["references"][e]["clips"]) for e in B.CAPS}}
        B.log(f"{key}: {report[model]}")
    if not args.plan_only:
        receipt["updatedAt"] = built
        B.atomic_json(B.RECEIPT, receipt)
        CATALOGUE.write_text(json.dumps(catalogue, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=1), encoding="utf-8")
    counts = {}
    for item in report.values():
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    print(counts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
