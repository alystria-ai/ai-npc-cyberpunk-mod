"""Pocket v2 data: latent cache, runtime-style cross-utterance references and the deterministic sampler.

Policy pocket_crossref_teacher_v1 / pocket_voice_guided_distill_v1 (docs/POCKET_NEXT_RUN_PLAN.md section 3).

* Every clip is encoded once by the frozen Mimi encoder (whole clip from its start, so a slice is the exact encoding).
* Reference sets are joined exactly like runtime (whole clips, 0.4 s of digital silence, 24 kHz) and encoded as one
  waveform, never by concatenating per-clip latents.
* sample(g) depends only on (seed, g): resume is exact and both ranks draw disjoint global indices.
  - 85%: 1/2/3 other clips of the same voice (probabilities 0.3/0.3/0.4) from the precomputed bank, never containing
    the target, avoiding the target's scene when the voice has other sets; target = the whole clip.
  - 15% (rows with word timings only): the official same-utterance prefix cut (<= 5 s, word boundary, >= 1 s each
    side); the overlapping full-utterance fallback of the old corpus is never used.
"""
from __future__ import annotations

import bisect
import hashlib
import json
import math
import random
import re
from pathlib import Path
from typing import Any

SAMPLE_RATE = 24000
FRAME_RATE = 12.5
FRAME = int(SAMPLE_RATE / FRAME_RATE)  # 1920 samples
GAP_SECONDS = 0.4
PREFIX_PROBABILITY = 0.15
K_PROBABILITIES = ((1, 0.3), (2, 0.3), (3, 0.4))
PREFIX_WINDOW = 5.0
MIN_CUT = 1.0
TRAIL = 0.2
FINAL_PUNCT_DROPOUT = 0.3


def frames_for(samples: int) -> int:
    return max(1, samples // FRAME)


def load_wave(path: str, torch: Any) -> Any:
    """Mono float32 tensor at 24 kHz."""
    import soundfile as sf
    import torchaudio.functional as AF
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.mean(1).copy())
    if rate != SAMPLE_RATE:
        wav = AF.resample(wav, rate, SAMPLE_RATE)
    return wav


def speech_end_seconds(wav: Any) -> float:
    """End of the last frame within 40 dB of the loudest 10 ms frame (trailing-silence trim)."""
    hop = 240
    n = len(wav) // hop
    if n < 2:
        return len(wav) / SAMPLE_RATE
    rms = wav[: n * hop].reshape(n, hop).pow(2).mean(1).add(1e-10).log10().mul(10)
    active = (rms > rms.max() - 40).nonzero().flatten()
    return (int(active[-1]) + 1) * hop / SAMPLE_RATE


def join(waves: list[Any], torch: Any) -> Any:
    gap = torch.zeros(round(GAP_SECONDS * SAMPLE_RATE))
    parts = []
    for i, w in enumerate(waves):
        parts.append(w)
        if i < len(waves) - 1:
            parts.append(gap)
    return torch.cat(parts).clamp(-1, 1)


def set_key(group: str, voice: str, k: str, index: int) -> str:
    return f"{group}|{voice}|{k}|{index}"


def reference_jobs(corpus: dict) -> list[tuple[str, list[str]]]:
    """Every joined reference to encode: the training bank plus the D/Z panel references."""
    jobs = []
    for voice, sets in corpus["bank"].items():
        for k, items in sets.items():
            for i, ids in enumerate(items):
                jobs.append((set_key("bank", voice, k, i), ids))
    for name in ("D", "Z"):
        for voice, entry in corpus["panels"][name].items():
            for k, ids in entry["refs"].items():
                jobs.append((set_key(name, voice, k, 0), ids))
    return jobs


def valid_cuts(words: list[dict] | None, duration: float) -> list[tuple[float, int]]:
    if not words:
        return []
    cuts = []
    for i in range(1, len(words)):
        a, b = words[i - 1], words[i]
        if a.get("end") is None or b.get("start") is None:
            continue
        cut = 0.5 * (a["end"] + b["start"])
        if cut >= MIN_CUT and duration - cut >= MIN_CUT and a["end"] < PREFIX_WINDOW:
            cuts.append((cut, i))
    return cuts


class CrossRefSampler:
    def __init__(self, corpus: dict, latents: dict[str, Any], seed: int, *, rejected: set[str] | None = None):
        rejected = rejected or set()
        roles = corpus["roles"]
        self.rows = {r["id"]: r for r in corpus["rows"]}
        self.latents = latents
        self.seed = seed
        by_voice: dict[str, list[str]] = {}
        for r in corpus["rows"]:
            if r["id"] in roles or r["id"] in rejected or r["id"] not in latents:
                continue
            by_voice.setdefault(r["voice"], []).append(r["id"])
        self.bank: dict[str, dict[int, list[tuple[str, list[str], set[str]]]]] = {}
        for voice, sets in corpus["bank"].items():
            entry = {}
            for k, items in sets.items():
                entry[int(k)] = [(set_key("bank", voice, k, i), ids, {self.rows[c]["scene"] for c in ids})
                                 for i, ids in enumerate(items) if set_key("bank", voice, k, i) in latents]
            self.bank[voice] = entry
        self.voices = sorted(v for v in by_voice if v in self.bank and any(self.bank[v].values()))
        self.clips = {v: sorted(by_voice[v]) for v in self.voices}
        weights = [min(len(self.clips[v]), int(corpus["weights"].get(v, 0)) or len(self.clips[v])) for v in self.voices]
        self.cumulative, total = [], 0.0
        for w in weights:
            total += w
            self.cumulative.append(total)
        self.total = total

    def _rng(self, g: int) -> random.Random:
        digest = hashlib.sha256(f"{self.seed}:{g}".encode()).digest()
        return random.Random(int.from_bytes(digest[:8], "little"))

    def _target_frames(self, row: dict, stored: int) -> int:
        end = row.get("speech_end") or row["dur"]
        words = row.get("words") or []
        ends = [w["end"] for w in words if w.get("end") is not None]
        if ends:
            end = min(row["dur"], max(ends) + TRAIL)
        else:
            end = min(row["dur"], end + TRAIL)
        return max(1, min(stored, int(end * FRAME_RATE)))

    def sample(self, g: int) -> tuple[Any, str, Any, str]:
        """(target latents [T, C], text, prompt latents [Tv, C], mode) for global sample index g."""
        rng = self._rng(g)
        for _ in range(16):
            voice = self.voices[bisect.bisect_right(self.cumulative, rng.random() * self.total)
                                if self.total else 0]
            row = self.rows[rng.choice(self.clips[voice])]
            lat = self.latents[row["id"]]
            text = row["text"]
            cuts = valid_cuts(row.get("words"), row["dur"])
            if cuts and rng.random() < PREFIX_PROBABILITY:
                cut, i = rng.choice(cuts)
                cut_frames = min(max(round(cut * FRAME_RATE), 1), lat.shape[0] - 1)
                prompt = lat[: min(cut_frames, int(PREFIX_WINDOW * FRAME_RATE))]
                end = self._target_frames(row, lat.shape[0])
                if end - cut_frames < 4:
                    continue
                target = lat[cut_frames:end]
                text = " ".join(w["word"] for w in row["words"][i:])
                mode = "prefix"
            else:
                draw, acc = rng.random(), 0.0
                order = []
                for k, p in K_PROBABILITIES:
                    acc += p
                    order.append(k)
                    if draw < acc:
                        break
                ks = [order[-1]] + [k for k, _ in K_PROBABILITIES if k != order[-1]]
                chosen = None
                for k in ks:
                    candidates = [s for s in self.bank[voice].get(k, []) if row["id"] not in s[1]]
                    other_scene = [s for s in candidates if row["scene"] not in s[2]]
                    pool = other_scene or candidates
                    if pool:
                        chosen = rng.choice(pool)
                        break
                if chosen is None:
                    continue
                prompt = self.latents[chosen[0]]
                target = lat[: self._target_frames(row, lat.shape[0])]
                mode = f"cross{len(chosen[1])}"
            if rng.random() < FINAL_PUNCT_DROPOUT:
                text = re.sub(r"\.\s*$", "", text) or text
            return target, text, prompt, mode
        raise RuntimeError(f"No usable sample for index {g}")


def collate(samples: list[tuple[Any, str, Any, str]], tokenize: Any, torch: Any) -> tuple:
    """Padded raw latents, mask (with one terminal EOS slot), tokens, voice latents, voice frame counts."""
    B = len(samples)
    C = samples[0][0].shape[-1]
    T = max(s[0].shape[0] for s in samples) + 1  # terminal slot: the first invalid position is the EOS target
    Tv = max(s[2].shape[0] for s in samples)
    latents = torch.zeros(B, T, C)
    mask = torch.zeros(B, T, dtype=torch.bool)
    voice = torch.zeros(B, Tv, C)
    frames = torch.zeros(B, dtype=torch.long)
    tokens = []
    for b, (target, text, prompt, _) in enumerate(samples):
        latents[b, : target.shape[0]] = target.float()
        mask[b, : target.shape[0]] = True
        voice[b, : prompt.shape[0]] = prompt.float()
        frames[b] = max(1, prompt.shape[0])
        tokens.append(torch.tensor(tokenize(text), dtype=torch.long))
    return latents, mask, tokens, voice, frames
