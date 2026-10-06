"""Validation sample for the phone detector: 20 flagged and 20 unflagged clips with scores, and spectrum sheets.

    python scripts/phone_detect/validate.py [--seed 7] [--out E:/CyberpunkConvai-offload/work/phone-detect/validation]

Spectra (long-term, dB re the telephone band) are the listen-proxy: a phone/holocall filter shows as a shelf or cliff
near 3.4-4 kHz, a missing bass end, or a hard noise-floor above the telephone band.  Needs matplotlib.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from spectral import ltas  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--work", type=Path, default=Path("E:/CyberpunkConvai-offload/work/phone-detect"))
    parser.add_argument("--flags", type=Path, default=ROOT / "runtime/voice-data-phone-flags.json")
    parser.add_argument("--out", type=Path, default=Path("E:/CyberpunkConvai-offload/work/phone-detect/validation"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    flags = json.loads(args.flags.read_text(encoding="utf-8"))["clips"]
    meta = json.loads((args.work / "meta.json").read_text(encoding="utf-8"))
    rng = random.Random(args.seed)
    train = [i for i in flags if meta[i]["split"] == "train"]
    spectral = [i for i in train if flags[i]["spectral"]]
    metadata_only = [i for i in train if flags[i]["metadata"] and not flags[i]["spectral"]]
    clean = [i for i in train if not flags[i]["phone"]]
    print("reason counts:", Counter(r for i in train for r in flags[i]["reasons"]))
    spectral_pick = sorted(spectral, key=lambda i: -flags[i]["spec_score"])[:5] + rng.sample(spectral, 5)
    flagged = list(dict.fromkeys(spectral_pick)) + rng.sample(metadata_only, 20 - len(set(spectral_pick)))
    unflagged = rng.sample(clean, 20)
    rows = []
    for label, ids in (("flagged", flagged), ("unflagged", unflagged)):
        for i in ids:
            c, m = flags[i], meta[i]
            rows.append({"set": label, "id": i, "voice": m["speaker"], "score": c["score"], "spectral": c["spectral"], "metadata": c["metadata"],
                         "scene": c["scene"], "reasons": c["reasons"], "hi_db": c["hi_db"], "lo_db": c["lo_db"], "floor_hz": c["bw_hz"],
                         "kind": m["kind"], "scene_file": (m["scenes"][0].replace("\\", "/").split("/")[-1] if m["scenes"] else "")})
    (args.out / "sample.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    for label, ids in (("flagged", flagged), ("unflagged", unflagged)):
        fig, axes = plt.subplots(4, 5, figsize=(20, 12))
        for ax, i in zip(axes.flat, ids):
            m = meta[i]
            data, rate = sf.read(m["path"], start=int(m["start"] * 48000), frames=int(min(m["duration"], 12) * 48000), dtype="float32", always_2d=True)
            freqs, db, _ = ltas(data.mean(axis=1), rate)
            band = (freqs > 300) & (freqs < 3400)
            ax.plot(freqs / 1000, db - db[band].mean(), lw=0.7)
            ax.axvspan(0.3, 3.4, color="orange", alpha=0.12)
            ax.set_xlim(0, 24); ax.set_ylim(-90, 20); ax.grid(alpha=0.3)
            c = flags[i]
            ax.set_title(f"{i[:30]}\nscore {c['score']:.2f} {'SPEC ' if c['spectral'] else ''}{'META' if c['metadata'] else ''}", fontsize=8)
        plt.tight_layout()
        plt.savefig(args.out / f"{label}.png", dpi=60)
        plt.close(fig)
    for r in rows:
        print(f"{r['set'][:3]} {r['id'][:42]:42s} score {r['score']:.2f} spec={int(r['spectral'])} meta={int(r['metadata'])} scene={int(r['scene'])} "
              f"hi {r['hi_db']:6.1f} lo {r['lo_db']:6.1f} floor {r['floor_hz']:6.0f} | {','.join(r['reasons'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
