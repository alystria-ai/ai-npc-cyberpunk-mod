"""Artifact gate for a fine-tuned Mimi decoder: does it add the "holographic" signature?

    python scripts/pocket_training/decoder_artifact_check.py --gen <out/gen> --new <cond-or-roundtrip> [--out report.json]

Compares, on the held-out lines and for the SAME latents, the pretrained decoder, decoder A (the holographic one) and the new
decoder:
  phase agreement with the pretrained decoder in 0.5-1.5 kHz and 1.5-4 kHz (decoder A: 0.6-0.8 in 1.5-4 kHz, holographic;
  anything that sounded normal: >= 0.94); the gate is the worse band, per line, with the mean, the minimum and the watched voice;
  persistent-line contrast on the 200 Hz grid and the strongest persistent tone (effects.py), relative to the pretrained decoder.
`--pairs` lists name pairs "label=pretrained_folder,decA_folder,new_folder" (folders under --gen holding <voice>__<line>.wav).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/phone_detect"))
import decoder_controls as dc  # noqa: E402
import effects  # noqa: E402

GATE = 0.92


def load(path):
    w, sr = sf.read(path, dtype="float32")
    return w if w.ndim == 1 else w.mean(1)


def check(gen: Path, label: str, pre: str, dec_a: str, new: str, watch: str = "carol-emeka", real: str | None = None) -> dict:
    files = sorted((gen / new).glob("*__*.wav"))
    rows = []
    for path in files:
        name = path.name
        if not (gen / pre / name).exists():
            continue
        p, a, n = load(gen / pre / name), load(gen / dec_a / name), load(path)
        row = {"file": name, "voice": name.split("__")[0]}
        for key, x in (("A", a), ("new", n)):
            row[f"{key}_lo"] = dc.phase_coherence(x, p, 500, 1500)
            row[f"{key}_mid"] = dc.phase_coherence(x, p, 1500, 4000)
        for key, x in (("pre", p), ("A", a), ("new", n)):
            f = effects.features(x, 24000)
            row[f"{key}_grid200"], row[f"{key}_tone"] = (f["grid200"], f["tone_db"]) if f else (np.nan, np.nan)
        rows.append(row)
    worse = lambda key: np.array([min(r[f"{key}_lo"], r[f"{key}_mid"]) for r in rows])
    out = {"label": label, "lines": len(rows)}
    for key in ("A", "new"):
        w = worse(key)
        watched = [min(r[f"{key}_lo"], r[f"{key}_mid"]) for r in rows if r["voice"] == watch]
        out[key] = {"coherence_worst_band_mean": round(float(w.mean()), 3), "min": round(float(w.min()), 3),
                    "p10": round(float(np.percentile(w, 10)), 3), "share_below_gate": round(float((w < GATE).mean()), 3),
                    "watched_voice_mean": round(float(np.mean(watched)), 3) if watched else None,
                    "mid_1.5-4k_mean": round(float(np.mean([r[f"{key}_mid"] for r in rows])), 3),
                    "low_0.5-1.5k_mean": round(float(np.mean([r[f"{key}_lo"] for r in rows])), 3)}
    for key in ("pre", "A", "new"):
        out[f"{key}_grid200_mean"] = round(float(np.nanmean([r[f"{key}_grid200"] for r in rows])), 2)
        out[f"{key}_tone_db_mean"] = round(float(np.nanmean([r[f"{key}_tone"] for r in rows])), 2)
    out["pass"] = bool(out["new"]["coherence_worst_band_mean"] >= GATE and (out["new"]["watched_voice_mean"] or 1) >= GATE
                       and out["new_grid200_mean"] <= out["pre_grid200_mean"] + 0.7)
    out["worst_lines"] = [(r["file"], round(min(r["new_lo"], r["new_mid"]), 3)) for r in sorted(rows, key=lambda r: min(r["new_lo"], r["new_mid"]))[:5]]
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--gen", type=Path, default=Path("E:/CyberpunkConvai-offload/work/likeness-phase1/out/gen"))
    p.add_argument("--pairs", nargs="+", required=True, help="label=pre,decA,new")
    p.add_argument("--out", type=Path)
    p.add_argument("--watch", default="carol-emeka")
    a = p.parse_args()
    report = []
    for item in a.pairs:
        label, folders = item.split("=")
        pre, dec_a, new = folders.split(",")
        report.append(check(a.gen, label, pre, dec_a, new, a.watch))
        print(json.dumps(report[-1]), flush=True)
    if a.out:
        a.out.write_text(json.dumps(report, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
