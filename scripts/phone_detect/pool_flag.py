"""Effect exclusions for the expanded reference pool (24 kHz mono clips), merged into effect-exclusions.json.

    python scripts/phone_detect/pool_flag.py [--pool E:/CyberpunkConvai-offload/work/phone-detect-pool]
        [--train-work E:/CyberpunkConvai-offload/work/phone-detect] [--train-manifest-out pool-train.jsonl]

Needs, per work folder: meta.json, effects.json (effects_extract.py) and spec24.json (spectral24.py).
The 48 kHz phone detector cannot run on 24 kHz audio (its noise-floor and 8-16 kHz tests need the 24 kHz top octave), so
band limits use a 24 kHz rule checked against the 48 kHz flags on the training clips (recall 0.88, precision 0.83):
  high band missing  4-8 kHz >= 12 dB under the voice's median and under -28 dB re the phone band, or 8-12 kHz >= 12 dB
                     under and under -40 dB; or
  band-pass shape    bass >= 15 dB under the voice's median and under -15 dB, together with 4-8 kHz >= 6 dB under.
Comb, tone and reverb rules are the same as effects_flag.py.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import effects_flag as ef  # noqa: E402

KEYS = ("hi_rel", "vhi_rel", "lo_rel")


def band_limited(f: dict, m: dict) -> bool:
    d = lambda k: f[k] - m[k]
    high = (d("hi_rel") <= -12 and f["hi_rel"] <= -28) or (d("vhi_rel") <= -12 and f["vhi_rel"] <= -40)
    return bool(high or (d("lo_rel") <= -15 and f["lo_rel"] <= -15 and d("hi_rel") <= -6))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--pool", type=Path, default=Path("E:/CyberpunkConvai-offload/work/phone-detect-pool"))
    p.add_argument("--train-work", type=Path, default=Path("E:/CyberpunkConvai-offload/work/phone-detect"))
    p.add_argument("--out", type=Path, default=HERE / "effect-exclusions.json")
    p.add_argument("--train-manifest-out", type=Path, default=None)
    a = p.parse_args()
    load = lambda path: json.loads(path.read_text(encoding="utf-8"))
    pm, ps, pe = load(a.pool / "meta.json"), load(a.pool / "spec24.json"), load(a.pool / "effects.json")
    tm, ts = load(a.train_work / "meta.json"), load(a.train_work / "spec24.json")
    allm, alls = {**tm, **pm}, {**ts, **ps}
    by = defaultdict(list)
    for clip_id, m in allm.items():
        by[m["speaker"]].append(clip_id)
    overall = {k: float(np.median([alls[i][k] for i in allm])) for k in KEYS}
    medians = {v: ({k: float(np.median([alls[i][k] for i in ids])) for k in KEYS} if len(ids) >= 8 else overall) for v, ids in by.items()}
    old = load(a.out)
    base = {k: v for k, v in old["clips"].items() if v.get("split") != "pool"}      # the training-set part stays
    excluded = {}
    for clip_id, m in pm.items():
        e, reasons = pe[clip_id], []
        if band_limited(ps[clip_id], medians[m["speaker"]]):
            reasons.append("band-limited")
        if "error" not in e:
            reasons += [name for name, rule in ef.RULES.items() if rule(e, m)]
        if reasons:
            excluded[clip_id] = {"reasons": reasons, "speaker": m["speaker"], "split": "pool"}
    counts = Counter(r for v in excluded.values() for r in v["reasons"])
    summary = dict(old["summary"])
    summary["expanded_pool"] = {"clips": len(pm), "excluded": len(excluded), "by_reason": dict(counts),
                                "top_speakers": Counter(v["speaker"] for v in excluded.values()).most_common(10)}
    a.out.write_text(json.dumps({**old, "summary": summary, "clips": {**base, **excluded}}, ensure_ascii=False), encoding="utf-8")
    if a.train_manifest_out:
        with a.train_manifest_out.open("w", encoding="utf-8") as stream:
            kept = 0
            for clip_id, m in pm.items():
                if clip_id not in excluded and m["duration"] >= 1.0:
                    stream.write(json.dumps({"id": clip_id, "path": m["path"], "start": 0.0, "duration": m["duration"]}) + "\n")
                    kept += 1
        summary["expanded_pool"]["training_rows"] = kept
    print(json.dumps(summary["expanded_pool"], indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
