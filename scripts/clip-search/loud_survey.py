"""Loudness survey of the candidate clips of the 43 non-report voices (CPU only, plays nothing).
Writes E:/CyberpunkConvai-offload/work/clip-search/loudness/<voice>.json and prints the spread."""
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
import loudband  # noqa: E402


def voices43():
    shown = set(json.loads((common.ROOT / "scripts/reference-picker/shown-voices.json").read_text(encoding="utf-8")))
    done = sorted(p.name for p in (common.WORK / "runs3/omni16").iterdir() if (p / "result.json").is_file())
    return [v for v in done if v not in shown]


if __name__ == "__main__":
    index = common.load_index()
    names = sys.argv[1:] or voices43()
    t0 = time.time()
    tot = 0
    for v in names:
        pool = common.VoicePool(index, v)
        cands = [c for c in pool.clips if common.usable(c)]
        rows = loudband.clip_measures(cands, common.WORK / "loudness" / f"{v}.json")
        lufs = np.array([rows[c.id]["lufs"] for c in cands])
        rej = sum(1 for c in cands if loudband.reject_clip(rows[c.id]))
        inband = int(((lufs >= -22) & (lufs <= -16)).sum())
        tot += len(cands)
        print(f"{v:20s} n={len(cands):4d} lufs p10/50/90 {np.percentile(lufs, 10):6.1f} {np.percentile(lufs, 50):6.1f} {np.percentile(lufs, 90):6.1f} "
              f"inband(-22..-16) {inband:4d} reject {rej} med_lv {pool.loud_median}", flush=True)
    print(f"{tot} clips in {time.time() - t0:.0f}s")
