"""Pick and build one character's omni-short, omni-long and Pocket references from analyze.py's checks, the same way as the
existing cast (whole clips, 0.4 s gaps, mono 24 kHz, 16-bit PCM; no EQ, denoise or gain: scripts/clip-search/common.py).

Selection (objective, every number in analysis.json):
  pool     1.5-9 s, >= 3 words, no clipped samples, peak <= -3 dBFS (relaxed to -1.5 only if the pool would hold under 12 s),
           gated loudness within 2 dB of the set median (shouted and whispered lines out), Whisper similarity >= 0.85 (clean
           speech whose transcript is right), WavLM typicality >= median - 0.03 (no effects or other voice), silence <= 0.45.
  score    typicality + 0.05 * Whisper similarity + 0.004 * seconds (the length bonus of the 2026-10-13 recipe).
  short    best-scoring clips while the joined length stays <= 10 s (>= 7 s required).
  long     the short clips, then the next best while <= 18 s (>= 12 s preferred; at least the short set).  Pocket = long.
Spec overrides: "exclude" (ids never used) and "prefer" (ids tried first, e.g. calm conversational lines).

Writes runtime/voice-references/picked/autobest/<omni-short|omni-long|pocket>/<key>.wav (refuses to replace an existing file
unless --replace) and staging/cast/<key>/voice-rows.json: the three config entries.  scripts/clip-search/cast-expansion/
merge_rows.py puts the rows into the live configs (one writer, with backups).

Usage: python build.py --key bryce-mosley [--dry-run] [--replace]
"""
from __future__ import annotations

import argparse
import hashlib
import statistics
import sys
from datetime import datetime, timezone

from cx_common import PICKED, REPO, STAGING, load_spec, read_json, work_dir, write_json

sys.path.insert(0, str(REPO / "scripts/clip-search"))
from common import build_reference, joined_seconds, words  # noqa: E402

KINDS = ("omni-short", "omni-long", "pocket")


def pick(clips, spec):
    excluded = set(spec.get("exclude", []))
    prefer = spec.get("prefer", [])
    med_loud = statistics.median(c["gatedRmsDb"] for c in clips)
    med_typ = statistics.median(c["typicality"] for c in clips)

    def pool(peak_limit):
        return [c for c in clips if c["id"] not in excluded and 1.5 <= c["seconds"] <= 9.0 and words(c["text"]) >= 3
                and c["clipped"] == 0 and c["peakDbfs"] <= peak_limit and abs(c["gatedRmsDb"] - med_loud) <= 2.0
                and c.get("asrSimilarity", 1.0) >= 0.85 and c["typicality"] >= med_typ - 0.03 and c["silenceRatio"] <= 0.45]

    candidates, peak_rule = pool(-3.0), -3.0
    # "relaxPeak": true (with "relaxPeakNote") is the override for a loudly mastered voice whose -3 dBFS pool is barely 12 s of
    # ~3 s clips (Patricia): the same -1.5 dBFS rule as below, still no clipped samples.
    if spec.get("relaxPeak") or sum(c["seconds"] for c in candidates) < 12:
        candidates, peak_rule = pool(-1.5), -1.5
    score = {c["id"]: c["typicality"] + 0.05 * c.get("asrSimilarity", 1.0) + 0.004 * c["seconds"] for c in candidates}
    ordered = sorted(candidates, key=lambda c: (c["id"] not in prefer, prefer.index(c["id"]) if c["id"] in prefer else 0, -score[c["id"]]))

    def fill(start, limit):
        chosen = list(start)
        for c in ordered:
            if c in chosen:
                continue
            if joined_seconds([x["seconds"] for x in chosen + [c]]) <= limit:
                chosen.append(c)
        return chosen

    short = fill([], 10.0)
    long_ = fill(short, 18.0)
    rules = {"medianGatedDb": round(med_loud, 2), "medianTypicality": round(med_typ, 3), "peakRule": peak_rule,
             "pool": len(candidates), "poolSeconds": round(sum(c["seconds"] for c in candidates), 1)}
    return short, long_, rules


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()
    spec = load_spec(args.key)
    analysis = read_json(work_dir(args.key) / "analysis.json")
    clips = analysis["clips"]
    short, long_, rules = pick(clips, spec)
    sets = {"omni-short": short, "omni-long": long_, "pocket": long_}
    print("rules", rules)
    for kind, chosen in sets.items():
        print(kind, round(joined_seconds([c["seconds"] for c in chosen]), 2), "s", [c["id"][-6:] for c in chosen])
        for c in chosen:
            print("    ", c["seconds"], c["typicality"], c.get("asrSimilarity"), "|", c["text"])
    short_s = joined_seconds([c["seconds"] for c in short])
    long_s = joined_seconds([c["seconds"] for c in long_])
    if short_s < 7.0:
        raise SystemExit(f"short set only {short_s:.2f} s (< 7 s): not enough clean speech; report the character as voice-thin")
    if long_s < 12.0:
        print(f"note: long set {long_s:.2f} s (< 12 s preferred)")
    if args.dry_run:
        return
    rows = {}
    for kind, chosen in sets.items():
        chosen = sorted(chosen, key=lambda c: int(c["id"]))      # string ids roughly follow scene order
        wav = PICKED / kind / f"{args.key}.wav"
        if wav.exists() and not args.replace:
            raise SystemExit(f"{wav} exists; pass --replace only when this key's reference is meant to change")
        seconds = build_reference([c["wavPath"] for c in chosen], wav)
        transcript = " ".join(c["text"].strip() for c in chosen)
        rows[kind] = {"reference": f"runtime/voice-references/picked/autobest/{kind}/{args.key}.wav",
                      "sha256": hashlib.sha256(wav.read_bytes()).hexdigest(), "transcript": transcript,
                      "transcriptSha256": hashlib.sha256(transcript.encode("utf-8")).hexdigest(), "status": "ready",
                      "pick": {"clips": [f"{args.key}/{c['id']}" for c in chosen], "seconds": round(seconds, 2),
                               "keptAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                               "note": f"cast-expansion recipe (docs/CAST_EXPANSION_RECIPE.md): scene-attributed lines, "
                                       f"{round(seconds, 2)} s, WavLM typicality median {rules['medianTypicality']}, "
                                       f"Whisper >= 0.85; no EQ, denoise or gain"}}
        print("built", kind, round(seconds, 2), "s", wav)
    write_json(STAGING / args.key / "voice-rows.json", {"key": args.key, "rules": rules, "rows": rows})
    print("wrote", STAGING / args.key / "voice-rows.json")


if __name__ == "__main__":
    main()
