"""Build reference WAVs the shipped way from decoded game clips (CPU).

  from build_refs import build, clean_text
  build(["<decoded wav>", ...], out_wav)  -> {"seconds", "lufs", "tp", "gain_db", ...}

Whole clips in the given order, 0.4 s of silence between them, mono 24 kHz, 16-bit (scripts/clip-search/common.py build_reference), then the
-20 LUFS gain match the shipped sets got (loud43/apply_loud43.py gain_match: one linear gain towards -20 LUFS, true peak kept at or below -1 dBTP,
never quieter, no limiter).  Needs CLIP_SEARCH_ROOT (the main checkout) like the other clip-search scripts.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0]))
sys.path.insert(0, str(HERE.parents[0] / "loud43"))
import common  # noqa: E402
import loudband  # noqa: E402
from apply_loud43 import gain_match  # noqa: E402


def clean_text(text: str) -> str:
    """Subtitle text as the words said: ellipsis character to three dots, stray replacement characters dropped."""
    return " ".join(text.replace("…", "...").replace("�", "").split())


def build(paths: list[str], out: Path, gain: bool = True) -> dict:
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    raw = out.with_name(out.stem + ".raw.tmp.wav")
    seconds = common.build_reference(list(paths), raw)
    data, rate = sf.read(str(raw), dtype="float64")
    raw.unlink()
    if gain:
        data, info = gain_match(data)
    else:
        info = {"gain_db": 0.0, **loudband.measure_signal(data)}
    sf.write(str(out), data.astype(np.float32), rate, format="WAV", subtype="PCM_16")
    info["seconds"] = round(seconds, 2)
    return info
