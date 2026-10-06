"""Fine-tune only the Pocket Mimi decoder on game dialogue (policy ``mimi_decoder_gan_v1``).

Why: a Mimi round trip of real game lines already loses most of the >8 kHz
spectrum and much of the timbre that the user hears (Phase 1: high-band error
7.1 dB vs 3.4 dB between real clips; ECAPA 0.53 vs 0.70). The flow LM cannot
recover what the decoder drops. The encoder, the latent space and every
FlowLM weight stay frozen, so the teacher/student models, their exports and
the runtime cost are unchanged: only ``mimi.quantizer``, ``mimi.upsample``,
``mimi.decoder_transformer`` and ``mimi.decoder`` tensors are replaced.

Recipe: frozen-encoder latents of random 1.92 s crops, decoded by the
trainable decoder; multi-scale log-mel L1 (to 12 kHz) + multi-scale STFT
discriminator (hinge) + feature matching, EMA of the generator for export.
Held-out lines (``--holdout-ids``) are never trained on and are scored every
``--eval-every`` steps (log-mel L1 and >8 kHz spectrum error vs the original).
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import random
import sys
import time
from pathlib import Path

POLICY = "mimi_decoder_gan_v1"
DECODER_PREFIXES = ("quantizer.", "upsample.", "decoder_transformer.", "decoder.")
SEGMENT_FRAMES = 24  # 1.92 s at 12.5 Hz


def decoder_keys(state: dict) -> list[str]:
    return [k for k in state if k.startswith(DECODER_PREFIXES)]


def load_exclusions(path: Path | None) -> set[str]:
    """Clip ids to leave out of training (effect-heavy clips; scripts/phone_detect/effect-exclusions.json)."""
    if path is None:
        return set()
    data = json.loads(path.read_text(encoding="utf-8"))
    return set(data["clips"] if isinstance(data, dict) else data)


def read_rows(manifest: Path, holdout: set[str], audio_root: Path, exclude: set[str] = frozenset()) -> list[dict]:
    rows = []
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r["id"] in holdout or r["id"] in exclude or float(r["duration"]) < 1.0:
            continue
        rows.append({"id": r["id"], "path": str(audio_root / r["path"]), "start": float(r.get("start", 0)),
                     "duration": float(r["duration"])})
    if not rows:
        raise ValueError("No training rows remain after the held-out exclusion")
    return rows


def load_window(path: str, start: float, duration: float, sr: int = 24000):
    import soundfile as sf
    import torch
    import torchaudio.functional as AF

    info = sf.info(path)
    data, rate = sf.read(path, start=int(start * info.samplerate), frames=int(duration * info.samplerate),
                         dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.mean(axis=1))
    return AF.resample(wav, rate, sr) if rate != sr else wav


class Crops:
    """Random fixed-length crops, sampled in proportion to clip duration."""

    def __init__(self, rows: list[dict], seconds: float, seed: int):
        import torch
        self.rows, self.seconds = rows, seconds
        self.samples = int(round(seconds * 24000))
        self.weights = torch.tensor([r["duration"] for r in rows], dtype=torch.float64)
        self.rng = random.Random(seed)

    def batch(self, size: int):
        import torch
        out = []
        idx = torch.multinomial(self.weights, size, replacement=True,
                                generator=torch.Generator().manual_seed(self.rng.randrange(1 << 30))).tolist()
        for i in idx:
            r = self.rows[i]
            span = max(0.0, r["duration"] - self.seconds)
            w = load_window(r["path"], r["start"] + self.rng.uniform(0, span), min(self.seconds, r["duration"]))
            if len(w) < self.samples:
                w = torch.nn.functional.pad(w, (0, self.samples - len(w)))
            out.append(w[: self.samples])
        return torch.stack(out)[:, None]


def build_discriminator():
    import torch
    from torch import nn
    from torch.nn.utils.parametrizations import weight_norm

    class STFTDisc(nn.Module):
        def __init__(self, n_fft: int, ch: int = 32):
            super().__init__()
            self.n_fft, self.hop = n_fft, n_fft // 4
            self.register_buffer("window", torch.hann_window(n_fft), persistent=False)
            self.convs = nn.ModuleList([
                weight_norm(nn.Conv2d(2, ch, (3, 9), padding=(1, 4))),
                weight_norm(nn.Conv2d(ch, ch, (3, 9), stride=(1, 2), dilation=(1, 1), padding=(1, 4))),
                weight_norm(nn.Conv2d(ch, ch, (3, 9), stride=(1, 2), dilation=(2, 1), padding=(2, 4))),
                weight_norm(nn.Conv2d(ch, ch, (3, 9), stride=(1, 2), dilation=(4, 1), padding=(4, 4))),
                weight_norm(nn.Conv2d(ch, ch, (3, 3), padding=(1, 1))),
            ])
            self.out = weight_norm(nn.Conv2d(ch, 1, (3, 3), padding=(1, 1)))

        def forward(self, x):
            spec = torch.stft(x.squeeze(1), self.n_fft, self.hop, window=self.window, return_complex=True)
            h = torch.stack([spec.real, spec.imag], 1).transpose(2, 3)  # [B, 2, T, F]
            feats = []
            for conv in self.convs:
                h = torch.nn.functional.leaky_relu(conv(h), 0.2)
                feats.append(h)
            return self.out(h), feats

    class MultiSTFT(nn.Module):
        def __init__(self):
            super().__init__()
            self.discs = nn.ModuleList([STFTDisc(n) for n in (2048, 1024, 512, 256, 128)])

        def forward(self, x):
            return [d(x) for d in self.discs]

    return MultiSTFT()


class MelLoss:
    def __init__(self, device):
        import torchaudio
        self.mels = [torchaudio.transforms.MelSpectrogram(24000, n_fft=n, hop_length=n // 4, n_mels=m, f_max=12000,
                                                          power=1.0).to(device)
                     for n, m in ((512, 64), (1024, 80), (2048, 128))]

    def __call__(self, y, x):
        import torch
        loss = 0.0
        for mel in self.mels:
            a, b = mel(y.squeeze(1)), mel(x.squeeze(1))
            loss = loss + (torch.log(a.clamp_min(1e-5)) - torch.log(b.clamp_min(1e-5))).abs().mean()
        return loss / len(self.mels)


def high_band_db(y, x, device):
    """Mean |dB| difference of the long-term spectrum above 8 kHz."""
    import torch
    win = torch.hann_window(1024, device=device)
    def ltas(w):
        s = torch.stft(w, 1024, 256, window=win, return_complex=True).abs().pow(2).mean(-1)
        return 10 * torch.log10(s.clamp_min(1e-10))
    a, b = ltas(y), ltas(x)
    lo = int(8000 / 12000 * 512)
    return float((a[lo:] - b[lo:]).abs().mean())


LTAS_FFT = 4096                  # 5.86 Hz bins at 24 kHz
GRID_HZ = 200.0                  # the decoder's own frame grid: 24 kHz / (4 * 5 * 6); lines appear at multiples of it


def ltas_db(w, device):
    """Long-term spectrum (dB per bin) of [B, T] audio: power averaged over time."""
    import torch
    win = torch.hann_window(LTAS_FFT, device=device)
    spec = torch.stft(w, LTAS_FFT, LTAS_FFT // 4, window=win, return_complex=True).abs().pow(2).mean(-1)
    return 10 * torch.log10(spec.clamp_min(1e-10))


def grid_contrast(ltas, spacing: float = GRID_HZ, lo: float = 3000.0, hi: float = 11000.0):
    """Mean dB of the long-term spectrum on the lines k*spacing minus halfway between them, [B]. A comb of
    persistent tones (the 'holographic' buzz of the first fine-tuned decoder) makes this positive."""
    import math
    import torch
    bin_hz = 24000 / LTAS_FFT
    k = torch.arange(math.ceil(lo / spacing), math.floor(hi / spacing), device=ltas.device, dtype=torch.float32)

    def at(freq):
        pos = freq / bin_hz
        i0 = pos.floor().long().clamp(0, ltas.shape[-1] - 2)
        frac = (pos - i0.float()).clamp(0, 1)
        return ltas[:, i0] * (1 - frac) + ltas[:, i0 + 1] * frac
    return at(k * spacing).mean(-1) - 0.5 * (at((k - 0.5) * spacing) + at((k + 0.5) * spacing)).mean(-1)


def ltas_losses(y, x, device):
    """(fine long-term spectrum L1 in units of 10 dB over 1.5-11.5 kHz, hinge on excess 200 Hz line contrast in dB)."""
    import torch
    fake, real = ltas_db(y.squeeze(1), device), ltas_db(x.squeeze(1), device)
    lo, hi = int(1500 / (24000 / LTAS_FFT)), int(11500 / (24000 / LTAS_FFT))
    l1 = (fake[:, lo:hi] - real[:, lo:hi]).abs().mean() / 10
    excess = torch.relu(grid_contrast(fake) - grid_contrast(real) - 0.5).mean()
    return l1, excess


MID_LO, MID_HI = 500.0, 4000.0        # the band whose phase made decoder A sound "holographic" (1.5-4 kHz mostly, 0.5-1.5 kHz too)


def _band_bins(n_fft: int, lo: float, hi: float):
    return int(lo / (24000 / n_fft)), int(hi / (24000 / n_fft))


def anchor_loss(y, ref, lo: float = MID_LO, hi: float = MID_HI):
    """Complex-STFT L1 between the decoder output and the frozen pretrained decoder's output for the same latents,
    in [lo, hi) Hz (default 0.5-4 kHz) only, normalised by the reference magnitude (about 1.4 for unrelated phase, 0 when identical).
    Anchors the mid-band PHASE to the pretrained decoder, which the mel loss cannot constrain, and leaves magnitude
    and everything outside the band to the mel loss and the GAN."""
    import torch
    total = 0.0
    for n_fft in (512, 1024, 2048):
        win = torch.hann_window(n_fft, device=y.device)
        a = torch.stft(y.squeeze(1), n_fft, n_fft // 4, window=win, return_complex=True)
        b = torch.stft(ref.squeeze(1), n_fft, n_fft // 4, window=win, return_complex=True)
        k0, k1 = _band_bins(n_fft, lo, hi)
        a, b = a[:, k0:k1], b[:, k0:k1]
        total = total + (a - b).abs().mean() / (b.abs().mean() + 1e-6)
    return total / 3


def band_coherence(y, ref, lo: float, hi: float):
    """Paired phase agreement in [lo, hi) Hz (1 = same phase), magnitude weighted on speech frames."""
    import torch
    n_fft = 1024
    win = torch.hann_window(n_fft, device=y.device)
    a = torch.stft(y.reshape(-1), n_fft, n_fft // 4, window=win, return_complex=True)
    b = torch.stft(ref.reshape(-1), n_fft, n_fft // 4, window=win, return_complex=True)
    level = 10 * torch.log10(b.abs().pow(2).sum(0) + 1e-12)
    keep = level > level.max() - 30
    k0, k1 = _band_bins(n_fft, lo, hi)
    a, b = a[k0:k1][:, keep], b[k0:k1][:, keep]
    return float((a * b.conj()).sum().abs() / torch.sqrt(a.abs().pow(2).sum() * b.abs().pow(2).sum() + 1e-12))


def mid_coherence(y, ref, lo: float = MID_LO, hi: float = MID_HI):
    """The artifact gate: the WORST of the 0.5-1.5 kHz and 1.5-4 kHz phase agreements with the pretrained decoder on the
    same latents (a single 0.5-4 kHz figure is dominated by the loud low band and hides the mid band). Decoder A scored
    0.61-0.77 in 1.5-4 kHz (holographic); controls that sounded normal scored >= 0.94 there."""
    edges = [lo] + [e for e in (1500.0,) if lo < e < hi] + [hi]
    return min(band_coherence(y, ref, a, b) for a, b in zip(edges[:-1], edges[1:]))


def resources(device) -> dict:
    """Host RSS, free disk and GPU memory, logged with training progress (a crash leaves a trail)."""
    import shutil
    import torch
    out = {"gpu_alloc_gib": round(torch.cuda.memory_allocated(device) / 2**30, 2) if torch.cuda.is_available() else 0}
    if torch.cuda.is_available():
        free, total = torch.cuda.mem_get_info(device)
        out["gpu_used_gib"] = round((total - free) / 2**30, 2)          # whole card, all processes
    try:
        import psutil
        out["rss_gib"] = round(psutil.Process().memory_info().rss / 2**30, 2)
        out["host_free_gib"] = round(psutil.virtual_memory().available / 2**30, 2)
    except ImportError:
        pass
    out["disk_free_gib"] = round(shutil.disk_usage(".").free / 2**30, 1)
    return out


def decode(mimi, latents):
    from pocket_tts.modules.stateful_module import init_states
    state = init_states(mimi, latents.shape[0], (latents.shape[1] + 8) * 16)
    return mimi.decode_from_latent(latents, state)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", type=Path, required=True)
    p.add_argument("--weights", type=Path, required=True, help="Any Pocket bundle with mimi.* tensors")
    p.add_argument("--manifest", type=Path, required=True, action="append")
    p.add_argument("--audio-root", type=Path, required=True)
    p.add_argument("--holdout-ids", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--variant", default="A")
    p.add_argument("--steps", type=int, default=200000)
    p.add_argument("--time-budget-seconds", type=float, default=5 * 3600)
    p.add_argument("--batch", type=int, default=12)
    p.add_argument("--seconds", type=float, default=SEGMENT_FRAMES / 12.5)
    p.add_argument("--lr-g", type=float, default=2e-5)
    p.add_argument("--lr-d", type=float, default=1e-4)
    p.add_argument("--lambda-mel", type=float, default=15.0)
    p.add_argument("--lambda-adv", type=float, default=1.0)
    p.add_argument("--lambda-fm", type=float, default=2.0)
    p.add_argument("--lambda-ltas", type=float, default=0.0, help="Fine long-term-spectrum L1 (kills persistent lines)")
    p.add_argument("--lambda-grid", type=float, default=0.0, help="Hinge on excess 200 Hz line-comb contrast (dB)")
    p.add_argument("--lambda-anchor", type=float, default=0.0,
                   help="Complex-STFT L1 to the frozen pretrained decoder in 0.5-4 kHz (anchors the mid-band phase)")
    p.add_argument("--watch-voice", default="carol-emeka",
                   help="Voice whose held-out lines are evaluated first and gated separately (the most sensitive voice)")
    p.add_argument("--coherence-floor", type=float, default=0.92,
                   help="Held-out mid-band phase coherence with the pretrained decoder below which a checkpoint is penalised")
    p.add_argument("--exclude-ids", type=Path, default=None, help="JSON of clip ids (or {'clips': {...}}) to leave out")
    p.add_argument("--disc-warmup", type=int, default=500)
    p.add_argument("--ema", type=float, default=0.999)
    p.add_argument("--eval-every", type=int, default=1000)
    p.add_argument("--eval-limit", type=int, default=80)
    p.add_argument("--seed", type=int, default=1234)
    p.add_argument("--device", default="cuda")
    p.add_argument("--loader-threads", type=int, default=2)
    p.add_argument("--snapshot-every", type=int, default=10000)
    args = p.parse_args(argv)

    sys.path.insert(0, str(args.source))
    import safetensors.torch
    import torch
    import yaml
    from pocket_tts.models.mimi import build_mimi
    from pocket_tts.utils.config import Config

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    device = torch.device(args.device)
    args.out.mkdir(parents=True, exist_ok=True)
    cfg = yaml.safe_load((args.source / "pocket_tts/config/english_2026-09.yaml").read_text())
    config = Config(**{**cfg, "weights_path": None, "weights_path_without_voice_cloning": None})
    mimi = build_mimi(config.mimi)
    bundle = safetensors.torch.load_file(str(args.weights))
    mimi_state = {k.removeprefix("mimi."): v for k, v in bundle.items() if k.startswith("mimi.")}
    mimi.load_state_dict(mimi_state, strict=True)
    from training.modules.utils import stamp_state_names
    stamp_state_names(mimi)
    mimi.to(device).train()
    for name, param in mimi.named_parameters():
        param.requires_grad_(name.startswith(DECODER_PREFIXES))
    trainable = [p_ for n, p_ in mimi.named_parameters() if p_.requires_grad]
    frozen_before = {k: v.clone() for k, v in mimi.state_dict().items() if not k.startswith(DECODER_PREFIXES)}
    ema = {n: p_.detach().clone() for n, p_ in mimi.named_parameters() if p_.requires_grad}
    disc = build_discriminator().to(device).train()
    opt_g = torch.optim.AdamW(trainable, lr=args.lr_g, betas=(0.8, 0.99), weight_decay=0.0)
    opt_d = torch.optim.AdamW(disc.parameters(), lr=args.lr_d, betas=(0.8, 0.99), weight_decay=0.0)
    mel_loss = MelLoss(device)
    ref_mimi = copy.deepcopy(mimi).eval()                           # pretrained decoder, frozen: phase reference + gate
    for q in ref_mimi.parameters():
        q.requires_grad_(False)

    holdout = set(json.loads(args.holdout_ids.read_text()))
    excluded = load_exclusions(args.exclude_ids)
    rows = [r for m in args.manifest for r in read_rows(m, holdout, args.audio_root, excluded)]
    seen, unique = set(), []
    for r in rows:
        if (r["path"], r["start"]) not in seen:
            seen.add((r["path"], r["start"])); unique.append(r)
    rows = unique
    eval_rows = []
    for m in args.manifest:
        for line in m.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                if r["id"] in holdout and (r["id"], ) not in {(e["id"],) for e in eval_rows}:
                    eval_rows.append({"id": r["id"], "path": str(args.audio_root / r["path"]),
                                      "start": float(r.get("start", 0)), "duration": float(r["duration"])})
    eval_rows.sort(key=lambda r: not r["id"].startswith(args.watch_voice + "/"))      # the watched voice first
    eval_rows = eval_rows[: args.eval_limit]
    crops = Crops(rows, args.seconds, args.seed)
    import queue
    import threading
    ready: "queue.Queue" = queue.Queue(maxsize=4)

    def producer(worker: int):
        local = Crops(rows, args.seconds, args.seed + 7919 * (worker + 1))
        while True:
            ready.put(local.batch(args.batch))

    for worker in range(args.loader_threads):
        threading.Thread(target=producer, args=(worker,), daemon=True).start()
    log_path = args.out / "log.jsonl"

    def log(record):
        record = {"utc": time.time(), "variant": args.variant, **record}
        print(json.dumps(record), flush=True)
        with log_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")

    def swap_in_ema():
        backup = {}
        with torch.no_grad():
            for n, p_ in mimi.named_parameters():
                if n in ema:
                    backup[n] = p_.detach().clone(); p_.copy_(ema[n])
        return backup

    def restore(backup):
        with torch.no_grad():
            for n, p_ in mimi.named_parameters():
                if n in backup:
                    p_.copy_(backup[n])

    def evaluate(step: int, use_ema: bool) -> dict:
        backup = swap_in_ema() if use_ema else None
        mimi.eval()
        mels, highs, grids, cohs, watched = [], [], [], [], []
        try:
            with torch.no_grad():
                for r in eval_rows:
                    x = load_window(r["path"], r["start"], r["duration"]).to(device)
                    x = x[: len(x) - len(x) % 1920][None, None]
                    y = decode(mimi, mimi.encode_to_latent(x))[..., : x.shape[-1]]
                    mels.append(float(mel_loss(y, x)))
                    highs.append(high_band_db(y[0, 0], x[0, 0], device))
                    both = grid_contrast(ltas_db(torch.cat([y[:, 0], x[:, 0]]), device))
                    grids.append(float(both[0] - both[1]))
                    cohs.append(mid_coherence(y[0, 0], decode(ref_mimi, ref_mimi.encode_to_latent(x))[0, 0, : x.shape[-1]]))
                    if r["id"].startswith(args.watch_voice + "/"):
                        watched.append(cohs[-1])
        finally:
            mimi.train()
            if backup is not None:
                restore(backup)
        mel, grid, coh = sum(mels) / len(mels), sum(grids) / len(grids), sum(cohs) / len(cohs)
        watch = sum(watched) / len(watched) if watched else coh
        return {"step": step, "weights": "ema" if use_ema else "raw", "heldout_mel_l1": mel,
                "heldout_high_band_db": sum(highs) / len(highs), "heldout_grid200_excess_db": grid,
                "heldout_mid_coherence": coh, "heldout_watch_coherence": watch, "watch_lines": len(watched),
                "score": mel + 0.02 * max(0.0, grid) + 2.0 * max(0.0, args.coherence_floor - min(coh, watch)), "heldout_lines": len(mels)}

    def export(tag: str, use_ema: bool, metrics: dict):
        backup = swap_in_ema() if use_ema else None
        try:
            state = {"mimi." + k: v.detach().cpu().contiguous() for k, v in mimi.state_dict().items()
                     if k.startswith(DECODER_PREFIXES)}
        finally:
            if backup is not None:
                restore(backup)
        path = args.out / f"decoder-{tag}.safetensors"
        safetensors.torch.save_file(state, str(path), metadata={"policy": POLICY, "variant": args.variant,
                                                                "metrics": json.dumps(metrics)})
        return path

    baseline = evaluate(0, use_ema=False)
    log({"event": "baseline", **baseline, "train_rows": len(rows), "excluded_ids": len(excluded), "trainable_params": sum(p_.numel() for p_ in trainable)})
    best = {"score": baseline["score"], "step": 0}
    started = time.monotonic()
    step = 0
    while step < args.steps and time.monotonic() - started < args.time_budget_seconds:
        x = ready.get().to(device)
        with torch.no_grad():
            lat = mimi.encode_to_latent(x)
        y = decode(mimi, lat)[..., : x.shape[-1]]
        # Discriminator.
        d_real = disc(x)
        d_fake = disc(y.detach())
        loss_d = sum(torch.relu(1 - r[0]).mean() + torch.relu(1 + f[0]).mean() for r, f in zip(d_real, d_fake)) / len(d_real)
        opt_d.zero_grad(set_to_none=True)
        loss_d.backward()
        opt_d.step()
        record = {"loss_d": float(loss_d.detach())}
        if step >= args.disc_warmup or args.disc_warmup == 0:
            loss_mel = mel_loss(y, x)
            d_fake = disc(y)
            d_real = [(r[0].detach(), [f.detach() for f in r[1]]) for r in disc(x)]
            loss_adv = sum(torch.relu(1 - f[0]).mean() for f in d_fake) / len(d_fake)
            loss_fm = 0.0
            count = 0
            for (_, fr), (_, ff) in zip(d_real, d_fake):
                for a, b in zip(fr, ff):
                    loss_fm = loss_fm + (a - b).abs().mean() / (a.abs().mean() + 1e-5)
                    count += 1
            loss_fm = loss_fm / count
            loss_g = args.lambda_mel * loss_mel + args.lambda_adv * loss_adv + args.lambda_fm * loss_fm
            if args.lambda_anchor > 0:
                with torch.no_grad():
                    y_ref = decode(ref_mimi, lat)[..., : x.shape[-1]]
                loss_anchor = anchor_loss(y, y_ref)
                loss_g = loss_g + args.lambda_anchor * loss_anchor
                record.update(loss_anchor=float(loss_anchor))
            if args.lambda_ltas or args.lambda_grid:
                loss_ltas, loss_grid = ltas_losses(y, x, device)
                loss_g = loss_g + args.lambda_ltas * loss_ltas + args.lambda_grid * loss_grid
                record.update(loss_ltas=float(loss_ltas), loss_grid=float(loss_grid))
            opt_g.zero_grad(set_to_none=True)
            loss_g.backward()
            torch.nn.utils.clip_grad_norm_(trainable, 1.0)
            opt_g.step()
            with torch.no_grad():
                for n, p_ in mimi.named_parameters():
                    if n in ema:
                        ema[n].mul_(args.ema).add_(p_.detach(), alpha=1 - args.ema)
            record.update(loss_mel=float(loss_mel), loss_adv=float(loss_adv), loss_fm=float(loss_fm))
        step += 1
        if step % 50 == 0:
            log({"event": "train", "step": step, **record, "elapsed": round(time.monotonic() - started, 1),
                 **resources(device)})
        if step % args.eval_every == 0:
            for use_ema in (True, False):
                metrics = evaluate(step, use_ema)
                log({"event": "eval", **metrics})
                if metrics["score"] < best["score"]:
                    best = {"score": metrics["score"], "step": step, "weights": metrics["weights"]}
                    export("best", use_ema, metrics)
            export("last", True, {"step": step})
            if step % args.snapshot_every == 0:
                export(f"step{step:06d}-ema", True, {"step": step})
            for k, v in mimi.state_dict().items():
                if k in frozen_before and not torch.equal(v, frozen_before[k]):
                    raise RuntimeError("A frozen encoder/latent tensor changed: " + k)
    final = evaluate(step, True)
    export("last", True, final)
    log({"event": "done", **final, "best": best, "baseline": baseline})
    (args.out / "summary.json").write_text(json.dumps({"policy": POLICY, "variant": args.variant, "args": {
        k: str(v) for k, v in vars(args).items()}, "baseline": baseline, "final": final, "best": best}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
