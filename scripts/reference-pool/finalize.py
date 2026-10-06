"""Step 4: apply the post-decode filters and write each voice's manifest (and its before/after numbers).

    python scripts/reference-pool/finalize.py [--voices a,b | --priority] [--keep-rejected]

Per voice, from WORK/<voice>/clips.jsonl (extract.py) this
  * drops lines outside 1.5-15 s, lines the pool already has (same source .wem as a training clip), repeats of the
    same recording (same .wem bytes under another variant name; the plain "vo" female variant wins),
    and shouts (speech level more than SHOUT_DB above the voice's median);
  * flags holocall files as "phone" (analysis only, nothing is filtered on it; band limits and other effects come from the
    effect-exclusion list the picker index joins);
  * deletes the rejected WAV files (WORK keeps only what the picker can show) and writes WORK/<voice>/manifest.json:
    {"voice", "clips": [{id, sid, d, lv, t, path, phone, phoneWhy, ...}], "rejected": {reason: count}}.
Held-out evaluation lines and dev/test lines never got this far (extract.py pre-filter).
"""
from __future__ import annotations

import argparse
import collections
import json
import statistics
import sys

import numpy as np
import soundfile as sf

from common import *  # noqa

PRIORITY = read_json(ROOT / "scripts/reference-picker/shown-voices.json")
MIN_S, MAX_S, SHOUT_DB = 1.5, 15.0, 7.0
MIN_ACTIVE, MAX_EDGE_SILENCE = 0.30, 3.0     # share of 50 ms frames within 30 dB of the loudest; silence before/after the speech (s)


def activity(path):
    """(share of speech frames, leading + trailing silence in s) of a clip; frames are 50 ms, speech = within 30 dB of the peak frame."""
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    frame = int(rate * 0.05)
    count = len(mono) // frame
    if count < 2:
        return 0.0, 0.0
    energy = (mono[: count * frame].reshape(count, frame) ** 2).mean(axis=1)
    if energy.max() <= 0:
        return 0.0, 0.0
    active = energy >= energy.max() * 1e-3
    where = np.flatnonzero(active)
    return float(active.mean()), float((where[0] + (count - 1 - where[-1])) * 0.05)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--voices")
    parser.add_argument("--priority", action="store_true")
    parser.add_argument("--keep-rejected", action="store_true", help="do not delete the WAV files of rejected clips")
    args = parser.parse_args()
    catalog = read_json(SRC / "catalog.json")
    index = read_json(POOL_INDEX)
    voices = args.voices.split(",") if args.voices else [v for v in PRIORITY if v in catalog] if args.priority else [v for v in catalog if (WORK / v / "clips.jsonl").exists()]
    summary = read_json(WORK / "summary.json") if (WORK / "summary.json").exists() else {}
    for voice in voices:
        path = WORK / voice / "clips.jsonl"
        if not path.exists():
            continue
        rows, failed = [], collections.Counter()
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("failed"):
                failed[row["failed"]] += 1
            else:
                rows.append(row)
        train_sha = set(catalog[voice]["trainWemSha"])
        old = index["voices"][voice]["clips"]
        old_levels = [c["lv"] for c in old if c["lv"] is not None]
        rejected = collections.Counter(failed)
        keep, drop = [], []
        for row in rows:
            reason = None
            if not MIN_S <= row["d"] <= MAX_S:
                reason = "duration"
            elif row["wemSha"] in train_sha:
                reason = "already-in-pool"
            if reason:
                drop.append((row, reason))
            else:
                keep.append(row)
        # The same recording under several names: keep one (plain vo, female variant first).
        order = lambda r: (r["vo"] != "vo", r["fm"] != "f", r["id"])
        seen, unique = set(), []
        for row in sorted(keep, key=order):
            if row["wemSha"] in seen:
                drop.append((row, "repeat"))
            else:
                seen.add(row["wemSha"])
                unique.append(row)
        # Shouts: speech level far above what the voice usually sounds like.
        levels = old_levels + [r["lv"] for r in unique if r["lv"] is not None]
        median = statistics.median(levels) if levels else None
        kept = []
        for row in unique:
            if median is not None and row["lv"] is not None and row["lv"] - median > SHOUT_DB:
                drop.append((row, "shout"))
            else:
                kept.append(row)
        # Mostly silence (long padding around a few words) makes a poor reference.
        speechy = []
        for row in kept:
            ratio, edge = activity(WORK / voice / f"{row['id']}.wav")
            row["active"], row["edge"] = round(ratio, 3), round(edge, 2)
            if ratio < MIN_ACTIVE or edge > MAX_EDGE_SILENCE:
                drop.append((row, "silence"))
            else:
                speechy.append(row)
        kept = speechy
        clips = []
        for row in sorted(kept, key=lambda r: r["id"]):
            # Phone flag (analysis only): the game's own holocall file.  Band limits and other effects are not judged here: the
            # picker index joins the 48 kHz-validated effect exclusions (scripts/phone_detect/effect-exclusions.json).
            why = ["holocall-file"] if row["vo"] == "vo_holocall" else []
            clips.append({"id": f"{voice}/{row['id']}", "sid": row["sid"], "d": row["d"], "lv": row["lv"], "t": row["text"], "path": str(WORK / voice / f"{row['id']}.wav"),
                          "phone": bool(why), "phoneWhy": why, "vo": row["vo"], "fm": row["fm"], "stem": row["stem"], "archive": row["archive"], "wem": row["wem"],
                          "wemSha": row["wemSha"], "inDataset": row["inDataset"], "active": row["active"], "edge": row["edge"]})
        for row, reason in drop:
            rejected[reason] += 1
            if not args.keep_rejected:
                (WORK / voice / f"{row['id']}.wav").unlink(missing_ok=True)
        write_json(WORK / voice / "manifest.json", {"voice": voice, "clips": clips, "rejected": dict(rejected), "loudMedian": median, "tags": catalog[voice]["tags"]})
        before = {"n": len(old), "s": round(sum(c["d"] for c in old), 1)}
        after = {"n": len(old) + len(clips), "s": round(before["s"] + sum(c["d"] for c in clips), 1)}
        summary[voice] = {"before": before, "after": after, "new": len(clips), "phone": sum(c["phone"] for c in clips), "rejected": dict(rejected)}
        print(f"{voice:20} {before['n']:5} -> {after['n']:5} clips  {before['s']:8.1f} -> {after['s']:8.1f} s   phone {summary[voice]['phone']:4}  rejected {dict(rejected)}", flush=True)
    write_json(WORK / "summary.json", summary, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
