"""Shared pieces of the per-character reference clip search (research only; nothing live is touched).

Paths, the picker's pool index, the held-out split of a voice's real clips, and the reference builder (whole clips,
mono 24 kHz via torchaudio's default resampler, 0.4 s of silence between clips, 16-bit PCM, no processing - the same
recipe as scripts/reference-picker/audio.mjs, which Apply-ReferencePicks.mjs and the picker use).
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
WORK = Path(r"E:\CyberpunkConvai-offload\work\clip-search")
POOL_INDEX = Path(r"E:\CyberpunkConvai-offload\work\reference-picker\pool-index.json")
LIKENESS = Path(r"E:\CyberpunkConvai-offload\work\likeness-phase1")
REFERENCE_RATE = 24000
GAP_SECONDS = 0.4
OLD_POCKET_EXPORT = ROOT / "runtime/pocket-student-full-a-s5000-raw"

# Reference budgets are TOTAL SECONDS (clips plus the 0.4 s gaps); there is no clip count.  OmniVoice: short <= 10 s, long <= 18 s
# (the bridge's own Omni limit is 20 s, scripts/reference-picker/validate-config.py); Pocket: the bridge refuses references over 30 s
# (bridge/pocket_voice_runtime.py) and its student was trained on references up to 18 s.  A single clip is at most 9 s.
MAX_CLIP_SECONDS = 9.0
OMNI_SHORT_SECONDS, OMNI_LONG_SECONDS, OMNI_LIMIT_SECONDS = 10.0, 18.0, 20.0
POCKET_LIMIT_SECONDS = 30.0


def joined_seconds(durations) -> float:
    durations = list(durations)
    return sum(durations) + max(0, len(durations) - 1) * GAP_SECONDS


def stable(text: str, salt: str = "") -> str:
    return hashlib.sha256(f"{salt}|{text}".encode("utf-8")).hexdigest()


def words(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9']+", text or ""))


class Clip(dict):
    """A pool clip: id, d (s), t (transcript), path (absolute), k (delivery kind), lv (loudness dB), ty."""
    @property
    def id(self): return self["id"]
    @property
    def d(self): return self["d"]


class VoicePool:
    def __init__(self, index: dict, key: str):
        self.key = key
        voice = index["voices"][key]
        root = Path(index["dataRoot"])
        self.live = voice.get("live", {})
        self.proposed = voice.get("proposed", {})
        self.loud_median = voice.get("loudMedian")
        self.clips: list[Clip] = []
        seen = set()
        for clip in voice["clips"]:
            if clip["id"] in seen:                 # the index can list one id twice (e.g. a training and an expanded copy)
                continue
            seen.add(clip["id"])
            self.clips.append(Clip({**clip, "path": str(root / clip["p"])}))
        self.by_id = {clip.id: clip for clip in self.clips}

    def clip(self, clip_id: str) -> Clip:
        return self.by_id[clip_id]


def load_index(path: Path = POOL_INDEX) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_audio_mono(path, rate: int = REFERENCE_RATE):
    import soundfile as sf
    import torch
    import torchaudio.functional as AF
    data, source_rate = sf.read(str(path), dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.mean(axis=1))
    return AF.resample(wav, source_rate, rate) if source_rate != rate else wav


def build_reference(paths: list[str], out: Path) -> float:
    """Whole clips in the given order, 0.4 s gaps, 24 kHz mono 16-bit. Returns the length in seconds."""
    import numpy as np
    import soundfile as sf
    gap = np.zeros(round(GAP_SECONDS * REFERENCE_RATE), dtype=np.float32)
    parts = []
    for at, path in enumerate(paths):
        parts.append(load_audio_mono(path).numpy())
        if at < len(paths) - 1:
            parts.append(gap)
    samples = np.clip(np.concatenate(parts), -1, 1)
    out.parent.mkdir(parents=True, exist_ok=True)
    temporary = out.with_name(out.name + ".part")
    sf.write(str(temporary), samples, REFERENCE_RATE, format="WAV", subtype="PCM_16")
    temporary.replace(out)
    return len(samples) / REFERENCE_RATE


# ---- the held-out split ---------------------------------------------------------------------------------------------

LINE_MIN_SECONDS, LINE_MAX_SECONDS, LINE_MIN_WORDS = 2.5, 6.5, 5


def usable(clip: Clip) -> bool:
    """A reference candidate: 1.5-9 s, at least three words, not media-processed, not effect-flagged (fx: band-limited,
    comb, tone or reverb, from scripts/phone_detect/effect-exclusions.json). Phone/holocall clips are allowed."""
    return 1.5 <= clip.d <= MAX_CLIP_SECONDS and words(clip["t"]) >= 3 and clip.get("k") != "media" and not clip.get("fx")


def split_voice(pool: VoicePool, salt: str = "clip-search-v1", n_dev: int = 2, n_final: int = 4) -> dict:
    """Reserve real clips of the voice for scoring only; they are never reference candidates.

    holdout H: every held-out clip; the ECAPA target for a generated line is the centroid of H minus that line's own
               clip (leave-one-out), so no reference clip is ever part of its own target and the target does not
               depend on which candidate set is being scored.
    dev:       lines the search renders and scores (a fixed pair, shared by every candidate: common random numbers).
    final:     fresh lines kept for the last comparison, never used to choose or prune anything before it.
    The research agent's two evaluation lines are not in the pool (the index builder removed them) and are not used here.
    Clips that are today's reference or part of the research proposals stay out of H, so those baselines are clean.
    """
    live_shas = {entry.get("sha256") for entry in pool.live.values() if entry}
    proposed = {c for entry in pool.proposed.values() for c in entry.get("clips", [])}
    valid = [clip for clip in pool.clips if usable(clip) or (clip.get("k") != "media" and not clip.get("fx") and clip.d >= 1.0 and words(clip["t"]) >= 2)]
    eligible = [clip for clip in valid if Path(clip["path"]).stem not in live_shas and clip.id not in proposed]
    eligible.sort(key=lambda clip: stable(clip.id, salt))
    n_valid = len(valid)

    def line_ok(clip: Clip, strict: bool = True) -> bool:
        if strict:
            return LINE_MIN_SECONDS <= clip.d <= LINE_MAX_SECONDS and words(clip["t"]) >= LINE_MIN_WORDS
        return 2.0 <= clip.d <= 8.0 and words(clip["t"]) >= 4

    lines = [clip for clip in eligible if line_ok(clip)]
    if len(lines) < n_dev + n_final:
        lines = [clip for clip in eligible if line_ok(clip, False)]
    wanted_lines = min(n_dev + n_final, len(lines))
    n_h = min(14, max(5, round(0.18 * n_valid)), max(0, n_valid - 3))
    n_h = max(n_h, min(wanted_lines + 2, len(eligible)))
    chosen_lines = lines[:wanted_lines]
    if len(chosen_lines) < n_dev + 2:                    # nothing sensible to hold out
        return {"ok": False, "reason": f"only {len(chosen_lines)} line-sized clips outside the baselines", "n_valid": n_valid}
    n_dev_used = min(n_dev, len(chosen_lines) // 2)
    dev, final = chosen_lines[:n_dev_used], chosen_lines[n_dev_used:]
    rest = [clip for clip in eligible if clip not in chosen_lines][: max(0, n_h - len(chosen_lines))]
    holdout = chosen_lines + rest
    held = {clip.id for clip in holdout}
    candidates = [clip for clip in pool.clips if usable(clip) and clip.id not in held]
    return {"ok": True, "holdout": [c.id for c in holdout], "dev": [c.id for c in dev], "final": [c.id for c in final],
            "candidates": [c.id for c in candidates], "n_valid": n_valid}
