"""Pick screening candidates from analyze_viktor.py's measurements, build their references and write the render jobs (CPU).

  python prepare_screen.py <analysis.json> <work dir> [--shorts N] [--mids N]

A clip passes when it is mono, not clipped, not effect- or combat-flagged, peak at or below -3 dBFS, noise floor under -48 dBFS, 99 percent of the
energy under at least 6.5 kHz, speech ratio 0.70 or more and 19 to 27 LU under full scale (-27 to -19 LUFS).  Among those the calm ones rank
first: moderate pitch spread (about 5.5 semitones), even levels, full bandwidth, a high peak-to-loudness ratio, few hesitations, laughs or shouts.
Writes <work>/screen/ref/<sid>.wav (single-clip references), <work>/screen/jobs.json (OmniVoice, 16 steps), <work>/screen/real.json and samples.json
(for score_samples.py).  Same key text for every job so the scores compare.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_refs import build, clean_text  # noqa: E402

TEST_TEXT = ("Hey, V. Good to see you in one piece. Sit down, and let me take a look at that arm. "
             "I have seen a lot of things in this city, but nothing quite like you.")


def passes(r: dict) -> bool:
    return not (r["fx"] or r["cbflag"] or r["clipped"] or r["ch"] != 1 or r["peak_db"] > -3 or r["m_floor"] > -48 or r["f99_hz"] < 6500
                or r["speech_ratio"] < 0.70 or not -27 <= r["m_lufs"] <= -19)


def calm_score(r: dict) -> float:
    s = -abs(r.get("f0_range_st", 8) - 5.5) * 0.5 - max(0, r["level_sd_db"] - 4.0) + min(r["f99_hz"], 9000) / 3000
    s -= 3 * (r.get("cb") or 0)
    s += (r["m_plr"] - 12) * 0.1 if r["m_plr"] else 0
    s += r["speech_ratio"] * 3
    t = r["text"]
    s -= 1.5 * len(re.findall(r"\.\.\.|…|�|--|—", t))
    s -= 2 * len(re.findall(r"\b(heh|heheh|ha|hah|hhh|ugh|tsk|wooo|mh|hm|uh|er)\b", t, re.I))
    s -= 2 * t.count("!")
    return s


def main() -> int:
    analysis, work = Path(sys.argv[1]), Path(sys.argv[2])
    arg = lambda name, default: int(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default
    n_short, n_mid = arg("--shorts", 30), arg("--mids", 10)
    data = json.loads(analysis.read_text(encoding="utf-8"))
    good = [r for r in data["clips"] if passes(r)]
    picked, seen_text = [], set()
    for lo, hi, count in ((5.0, 9.0, n_short), (9.0, 12.5, n_mid)):
        for r in sorted((r for r in good if lo <= r["seconds"] < hi), key=lambda r: -calm_score(r)):
            key = clean_text(r["text"]).lower()
            if key in seen_text or len([p for p in picked if lo <= p["seconds"] < hi]) >= count:
                continue
            seen_text.add(key)
            picked.append(r)
    screen = work / "screen"
    jobs, real, samples = [], [], []
    for r in picked:
        ref = screen / "ref" / f"{r['sid']}.wav"
        info = build([r["path"]], ref)
        jobs.append({"name": r["sid"], "ref": str(ref), "transcript": clean_text(r["text"]), "text": TEST_TEXT, "seed": 1042, "steps": 16,
                     "out": str(screen / "out" / f"{r['sid']}.wav")})
        samples.append({"name": r["sid"], "wav": str(screen / "out" / f"{r['sid']}.wav"), "text": TEST_TEXT, "exclude": [r["sid"]]})
        print(r["sid"], r["stem"], f"{r['seconds']:.1f}s", "gain", info["gain_db"], "lufs", info["lufs"], clean_text(r["text"])[:70])
    real = [{"sid": r["sid"], "path": r["path"]} for r in data["clips"] if passes(r) or not (r["fx"] or r["cbflag"] or r["ch"] != 1 or r["clipped"])]
    (screen / "jobs.json").write_text(json.dumps(jobs, indent=1), encoding="utf-8")
    (screen / "real.json").write_text(json.dumps(real, indent=1), encoding="utf-8")
    (screen / "samples.json").write_text(json.dumps(samples, indent=1), encoding="utf-8")
    print(len(jobs), "jobs,", len(real), "real clips for the similarity target")
    return 0


if __name__ == "__main__":
    sys.exit(main())
