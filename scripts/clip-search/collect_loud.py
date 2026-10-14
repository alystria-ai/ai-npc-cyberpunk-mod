"""Gather the loudness-aware runs of the 43 non-report voices into a prepared (NOT applied) reference-set proposal and the report numbers.

  python scripts/clip-search/collect_loud.py [--omni omni16-loud] [--pocket pocket-student-v2-s2000-ema-decv2-loud] [--build]

Reads   runs3/<tag>/<voice>/result.json of the loud runs (the earlier likeness-only picks are re-scored inside the same final under
        picks/compare, so old and new are compared on identical lines and seeds).
Writes  E:/.../clip-search/loud43/omni-loud-sets.json          the Omni picks of the loud run, clip ids only (the applied sets file is made by loud43/apply_loud43.py)
        E:/.../clip-search/loud43/report.json                  every number the report needs
        E:/.../clip-search/loud43/refs/<omni-short|omni-long|pocket>/<voice>.wav   the references built the clip-search way (--build)
Never touches runtime/ or the live configs; the 29 report voices and the hand-extracted sets are not read.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
import loudband  # noqa: E402
from loud_survey import voices43  # noqa: E402

OUT = common.WORK / "loud43"
FOLDERS = {"omni-short": ("omni", "short"), "omni-long": ("omni", "long"), "pocket": ("pocket", "best")}


def load(runs: Path, tag: str, voice: str):
    f = runs / tag / voice / "result.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.is_file() else None


def gain_to(lufs: float, tp: float, target: float = -20.0, ceiling: float = loudband.PEAK_CEILING) -> dict:
    want = target - lufs
    room = ceiling - tp
    return {"gain_db": round(min(want, room), 2), "wanted_db": round(want, 2), "peak_limited": bool(room < want)}


def old_row_in_new(new: dict, name: str):
    return (new.get("compare") or {}).get(f"overnight-{name}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=Path, default=common.WORK / "runs3")
    parser.add_argument("--omni", default="omni16-loud")
    parser.add_argument("--pocket", default="pocket-student-v2-s2000-ema-decv2-loud")
    parser.add_argument("--omni-old", default="omni16")
    parser.add_argument("--pocket-old", default="pocket-student-v2-s2000-ema-decv2")
    parser.add_argument("--build", action="store_true", help="build the reference WAVs (clip-search recipe) into the work folder")
    args = parser.parse_args(argv)
    index = common.load_index()
    voices = voices43()
    report = {"voices": {}, "band": {"low": loudband.BAND_LOW, "high": loudband.BAND_HIGH, "hot_above": loudband.HOT_ABOVE, "peak_ceiling": loudband.PEAK_CEILING,
                                     "bonus": loudband.BONUS, "quiet_slope": loudband.QUIET_SLOPE, "hot_slope": loudband.HOT_SLOPE}}
    sets = {"version": 2, "generated": None, "note": "loudness-aware clip search, 43 non-report voices; PREPARED, not applied", "engines": {"omni": {"tag": args.omni}, "pocket": {"tag": args.pocket}}, "voices": {}}
    skipped = {}
    for voice in voices:
        row_report, row_sets = {}, {}
        for folder, (engine, name) in FOLDERS.items():
            tag, old_tag = (args.omni, args.omni_old) if engine == "omni" else (args.pocket, args.pocket_old)
            new = load(args.runs, tag, voice)
            old = load(args.runs, old_tag, voice)
            if new is None:
                skipped.setdefault(voice, f"no loud result for {engine}")
                continue
            if "skipped" in new:
                skipped[voice] = new["skipped"]
                continue
            pick = (new.get("picks") or {}).get(name)
            if not pick:
                continue
            old_in_new = old_row_in_new(new, name)
            old_orig = ((old or {}).get("picks") or {}).get(name)
            loud = pick.get("loud") or {}
            entry = {"ids": pick["ids"], "seconds": pick["seconds"], "ecapa": pick["ecapa"], "ecapa_se": pick.get("ecapa_se"), "pls": pick.get("pls"),
                     "lufs": loud.get("lufs"), "tp": loud.get("tp"), "plr": loud.get("plr"), "floor": loud.get("floor"), "bonus": loud.get("bonus"),
                     "gain_to_-20": gain_to(loud["lufs"], loud["tp"]) if loud else None, "latency_ms": pick.get("latency_ms")}
            old_entry = None
            if old_in_new:
                ol = old_in_new.get("loud") or {}
                old_entry = {"ids": old_in_new["ids"], "seconds": old_in_new["seconds"], "ecapa": old_in_new["ecapa"], "ecapa_se": old_in_new.get("ecapa_se"),
                             "lufs": ol.get("lufs"), "tp": ol.get("tp"), "plr": ol.get("plr"), "bonus": ol.get("bonus"),
                             "ecapa_original_run": old_orig["ecapa"] if old_orig else None}
            entry["old"] = old_entry
            entry["changed"] = bool(old_entry and sorted(old_entry["ids"]) != sorted(entry["ids"]))
            entry["order_only"] = bool(old_entry and old_entry["ids"] != entry["ids"] and not entry["changed"])
            row_report[folder] = entry
            row_sets.setdefault(engine, {})[name] = {k: pick[k] for k in ("ids", "seconds", "ecapa", "ecapa_se", "ecapa_tgt", "pls", "latency_ms") if k in pick}
            if engine == "omni" and name == "short":
                pass
            if engine == "omni" and name == "long":
                best = (new["picks"].get("best") or {})
                if best:
                    row_sets["omni"]["best"] = {k: best[k] for k in ("ids", "seconds", "ecapa", "ecapa_se", "ecapa_tgt", "pls", "latency_ms") if k in best}
        if row_report:
            report["voices"][voice] = row_report
            sets["voices"][voice] = row_sets
    import datetime
    sets["generated"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    report["skipped"] = skipped
    OUT.mkdir(parents=True, exist_ok=True)
    dest = OUT / "omni-loud-sets.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(sets, indent=1), encoding="utf-8")
    if args.build:
        hashes = {}
        for voice, row in report["voices"].items():
            pool = common.VoicePool(index, voice)
            for folder, entry in row.items():
                paths = [pool.clip(i)["path"] for i in entry["ids"]]
                out = OUT / "refs" / folder / f"{voice}.wav"
                seconds = common.build_reference(paths, out)
                hashes[f"{folder}/{voice}"] = {"sha256": hashlib.sha256(out.read_bytes()).hexdigest(), "seconds": round(seconds, 3)}
        (OUT / "refs" / "hashes.json").write_text(json.dumps(hashes, indent=1), encoding="utf-8")
        print(f"built {len(hashes)} references under {OUT / 'refs'}")
    (OUT / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    changed = sum(1 for r in report["voices"].values() for e in r.values() if e["changed"])
    total = sum(len(r) for r in report["voices"].values())
    print(f"{len(report['voices'])} voices, {total} sets, {changed} changed vs the likeness-only pick; skipped: {skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
