"""Stage 4: effect-heavy clip flags for the decoder training set.

    python scripts/phone_detect/effects_flag.py [--work E:/CyberpunkConvai-offload/work/phone-detect]
        [--out scripts/phone_detect/effect-exclusions.json]

A clip is excluded from decoder training when any of these fires (reasons are recorded per clip):
  band-limited  the phone detector's `spectral` flag (runtime/voice-data-phone-flags.json): phone, holocall, answering machine
  comb          fixed-spacing line comb in the 3-11 kHz long-term spectrum, contrast >= 5 dB (clips >= 2 s): flanger/comb
                filter or a fixed room reflection (the Phantom Liberty Johnny clips share one at 561 Hz spacing)
  tone          persistent narrow tone >= 15 dB above its spectral neighbourhood (clips >= 2 s)
  reverb        no 20 dB fall within 590 ms after speech peaks (clips >= 2.5 s): heavy reverb / long tails
`robotic` (flat pitch) is reported but not excluded: its few hits look like ordinary speech.
Metadata-only phone/holocall clips are NOT excluded (the user checked: they sound normal).
Thresholds come from the distribution over the 8,472 clips (about the 97th-99.9th percentile) and a spectrogram check.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RULES = {
    "comb": lambda e, m: m["duration"] >= 2.0 and e["comb_best"] >= 5.0,
    "tone": lambda e, m: m["duration"] >= 2.0 and e["tone_db"] >= 15.0,
    "reverb": lambda e, m: m["duration"] >= 2.5 and e["tail_ms"] == e["tail_ms"] and e["tail_ms"] >= 590.0,
}
REPORT_ONLY = {
    "robotic": lambda e, m: m["duration"] >= 2.5 and e["f0_std_st"] == e["f0_std_st"] and e["f0_std_st"] < 0.9 and e["voiced_frac"] > 0.4,
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, default=Path("E:/CyberpunkConvai-offload/work/phone-detect"))
    parser.add_argument("--flags", type=Path, default=ROOT / "runtime/voice-data-phone-flags.json")
    parser.add_argument("--out", type=Path, default=ROOT / "scripts/phone_detect/effect-exclusions.json")
    args = parser.parse_args()
    effects = json.loads((args.work / "effects.json").read_text(encoding="utf-8"))
    meta = json.loads((args.work / "meta.json").read_text(encoding="utf-8"))
    phone = json.loads(args.flags.read_text(encoding="utf-8"))["clips"]
    excluded, reported = {}, {}
    for clip_id, m in meta.items():
        e = effects[clip_id]
        reasons = []
        if phone.get(clip_id, {}).get("spectral"):
            reasons.append("band-limited")
        if "error" not in e:
            reasons += [name for name, rule in RULES.items() if rule(e, m)]
            hits = [name for name, rule in REPORT_ONLY.items() if rule(e, m)]
            if hits:
                reported[clip_id] = hits
        if reasons:
            excluded[clip_id] = {"reasons": reasons, "speaker": m["speaker"], "split": m["split"]}
    counts = Counter(r for v in excluded.values() for r in v["reasons"])
    summary = {"clips_total": len(meta), "excluded": len(excluded), "by_reason": dict(counts),
               "by_split": dict(Counter(v["split"] for v in excluded.values())),
               "top_speakers": Counter(v["speaker"] for v in excluded.values()).most_common(12),
               "report_only": dict(Counter(r for v in reported.values() for r in v))}
    args.out.write_text(json.dumps({"schema": "voice-data-effect-exclusions/v1", "rules": {
        "band-limited": "phone detector spectral flag", "comb": "comb_best >= 5.0, >= 2 s", "tone": "tone_db >= 15, >= 2 s",
        "reverb": "tail_ms >= 590, >= 2.5 s", "kept": "metadata-only phone/holocall clips"}, "summary": summary, "clips": excluded},
        indent=0, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
