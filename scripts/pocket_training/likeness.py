"""Perceptual likeness score (PLS) for voice candidates, plus an ECAPA speaker guard.

Validated on 67 game voices against the user's ears (OmniVoice ~90 > fine-tuned
Pocket ~70 > stock Pocket ~60): with only the stock-Pocket and OmniVoice-32 anchors
it places the fine-tuned Pocket students at 69-70. WavLM-SV against one reference,
UTMOS and DNSMOS failed that check (WavLM saturates; the MOS predictors rate real
game lines lowest), so they are not used.

PLS averages three components, each mapped linearly so the low anchor = 60 and
the high anchor = 90:
  * fd_mfcc   - Frechet distance between the generated frames' MFCC (1-20, 24 kHz,
                to 12 kHz) and the voice's own real clips (timbre + recording character)
  * mcd       - DTW mel-cepstral distance to the original recording of the same line
                (delivery + articulation + timbre)
  * ltas_hi   - mean |dB| error of the long-term spectrum above 8 kHz vs the voice's
                real clips ("air", which 16 kHz SV models never see)
The guard is ECAPA (VoxCeleb) cosine to the centroid of the voice's real clips.
"""
from __future__ import annotations

import math
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

SR = 24000
HOP = 240


def load_audio(path: str | Path, sr: int = SR, start: float = 0.0, duration: float | None = None):
    import soundfile as sf
    import torch
    import torchaudio.functional as AF

    info = sf.info(str(path))
    frames = -1 if duration is None else int(duration * info.samplerate)
    data, rate = sf.read(str(path), start=int(start * info.samplerate), frames=frames, dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.mean(axis=1))
    return AF.resample(wav, rate, sr) if rate != sr else wav


def mel_bin_at(hz: float, n_mels: int = 80, f_max: float = 12000) -> int:
    mel = lambda f: 2595 * math.log10(1 + f / 700)
    inv = lambda m: 700 * (10 ** (m / 2595) - 1)
    return next(i for i in range(n_mels) if inv(mel(f_max) * (i + 1) / (n_mels + 1)) >= hz)


HIGH_BIN = mel_bin_at(8000)


class Analyzer:
    """Frame features on one device; ECAPA is optional (guard only)."""

    def __init__(self, device: str = "cpu", ecapa_dir: str | Path | None = None, savedir: str | Path | None = None):
        import torchaudio
        self.device = device
        self.mel = torchaudio.transforms.MelSpectrogram(SR, n_fft=1024, hop_length=HOP, n_mels=80, f_max=12000).to(device)
        self.mfcc = torchaudio.transforms.MFCC(SR, n_mfcc=21, melkwargs=dict(n_fft=1024, hop_length=HOP, n_mels=80,
                                                                          f_max=12000)).to(device)
        self.ecapa = None
        if ecapa_dir:
            from speechbrain.inference.speaker import EncoderClassifier
            from speechbrain.utils.fetching import LocalStrategy
            self.ecapa = EncoderClassifier.from_hparams(source=str(ecapa_dir), savedir=str(savedir or ecapa_dir),
                                                        overrides={"pretrained_path": str(ecapa_dir)},
                                                        local_strategy=LocalStrategy.COPY, run_opts={"device": device})

    def features(self, wav24) -> dict[str, Any]:
        import torch
        import torchaudio.functional as AF
        n = len(wav24) // HOP
        if n < 5:
            wav24 = torch.nn.functional.pad(wav24, (0, 5 * HOP)); n = len(wav24) // HOP
        rms = wav24[: n * HOP].reshape(n, HOP).pow(2).mean(1).add(1e-10).log10().mul(10)
        active = (rms > rms.max() - 40).nonzero().flatten()
        a0, a1 = int(active[0]), int(active[-1]) + 1
        span = wav24[a0 * HOP: a1 * HOP]
        pause = float((rms[a0:a1] < rms.max() - 35).float().mean())
        with torch.no_grad():
            mel = (self.mel(span.to(self.device)) + 1e-6).log10().mul(10).T.cpu()
            mfcc = self.mfcc(span.to(self.device)).T.cpu()
        act = mel.max(1).values > mel.max() - 40
        out = {"dur": len(span) / SR, "pause": pause, "mel_act": mel[act].half(), "mfcc": mfcc.half()}
        if self.ecapa is not None:
            w16 = AF.resample(span, SR, 16000)
            with torch.inference_mode():
                e = self.ecapa.encode_batch(w16[None].to(self.device)).reshape(-1)
            out["ecapa"] = torch.nn.functional.normalize(e, dim=0).cpu()
        return out


def dtw_path(a, b) -> list[tuple[int, int]]:
    import torch
    a = torch.nn.functional.normalize(a.float(), dim=1)
    b = torch.nn.functional.normalize(b.float(), dim=1)
    cost = (1 - a @ b.T).numpy()
    n, m = cost.shape
    D = np.full((n + 1, m + 1), np.inf)
    D[0, 0] = 0
    for i in range(1, n + 1):
        ci, Di, Dp = cost[i - 1], D[i], D[i - 1]
        for j in range(1, m + 1):
            Di[j] = ci[j - 1] + min(Dp[j], Di[j - 1], Dp[j - 1])
    i, j, path = n, m, []
    while i > 0 and j > 0:
        path.append((i - 1, j - 1))
        k = int(np.argmin([D[i - 1, j - 1], D[i - 1, j], D[i, j - 1]]))
        i, j = (i - 1, j - 1) if k == 0 else ((i - 1, j) if k == 1 else (i, j - 1))
    return path[::-1]


def mcd_dtw(gen: dict, orig: dict) -> float:
    import torch
    a, b = gen["mfcc"][:, 1:].float(), orig["mfcc"][:, 1:].float()
    path = dtw_path(a[::2], b[::2])
    ia = torch.tensor([p[0] * 2 for p in path]); ib = torch.tensor([p[1] * 2 for p in path])
    diff = a[ia] - b[ib]
    return float((10 / math.log(10)) * math.sqrt(2) * diff.pow(2).sum(1).sqrt().mean())


def frechet(x: np.ndarray, y: np.ndarray) -> float:
    from scipy import linalg
    mx, my = x.mean(0), y.mean(0)
    cx, cy = np.cov(x, rowvar=False), np.cov(y, rowvar=False)
    covmean = linalg.sqrtm(cx @ cy)
    if np.iscomplexobj(covmean):
        covmean = covmean.real
    return float(((mx - my) ** 2).sum() + np.trace(cx + cy - 2 * covmean))


def voice_reference_stats(clip_features: list[dict]) -> dict:
    import torch
    mel = torch.cat([f["mel_act"].float() for f in clip_features]).numpy()
    stats = {"ltas": mel.mean(0), "mfcc": torch.cat([f["mfcc"][:, 1:].float() for f in clip_features]).numpy()}
    if all("ecapa" in f for f in clip_features):
        centroid = torch.stack([f["ecapa"] for f in clip_features]).mean(0)
        stats["ecapa"] = torch.nn.functional.normalize(centroid, dim=0)
    return stats


def condition_metrics(lines: list[tuple[str, dict, dict]], voices: dict[str, dict]) -> dict[str, Any]:
    """lines: (voice, generated features, original-line features). Macro over voices."""
    per = defaultdict(list)
    frames = defaultdict(list)
    for voice, gen, orig in lines:
        m = {"mcd": mcd_dtw(gen, orig), "dur_err": abs(math.log(gen["dur"] / orig["dur"]))}
        stats = voices.get(voice)
        if stats is not None:
            err = np.abs(gen["mel_act"].float().numpy().mean(0) - stats["ltas"])
            m["ltas_hi"] = float(err[HIGH_BIN:].mean())
            frames[voice].append(gen["mfcc"][:, 1:].float().numpy())
            if "ecapa" in stats and "ecapa" in gen:
                m["guard_ecapa"] = float(stats["ecapa"] @ gen["ecapa"])
        per[voice].append(m)
    out: dict[str, Any] = {}
    keys = sorted(set().union(*[set(m) for ms in per.values() for m in ms]))
    for k in keys:
        vals = [np.mean([m[k] for m in ms if k in m]) for ms in per.values() if any(k in m for m in ms)]
        out[k] = float(np.mean(vals))
    fds = [frechet(np.concatenate(f), voices[v]["mfcc"]) for v, f in frames.items()]
    out["fd_mfcc"] = float(np.median(fds)) if fds else None
    out["voices"] = len(per)
    return out


def pls(metrics: dict[str, dict], low: str, high: str, low_score: float = 60, high_score: float = 90) -> dict[str, float]:
    """Map each component linearly so `low` -> 60 and `high` -> 90; return the mean per condition."""
    lo, hi = metrics[low], metrics[high]
    result = {}
    for name, m in metrics.items():
        parts = [low_score + (high_score - low_score) * (lo[k] - m[k]) / (lo[k] - hi[k])
                 for k in ("fd_mfcc", "mcd", "ltas_hi") if m.get(k) is not None and lo[k] != hi[k]]
        result[name] = float(np.mean(parts)) if parts else float("nan")
    return result
