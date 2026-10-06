"""Pocket v2 panel evaluation: ECAPA-first, runtime-style references, pretrained Mimi decoder.

The D panel (two held-out lines per voice, 1-clip and 3-clip references) and the Z panel (whole held-out voices) are
generated with separate text/voice guidance

    z = z_null + w_t * (z_text - z_null) + w_v * (z_full - z_text)

(w_t = w_v = 1 is the runtime student: one branch). Metrics per voice, macro over voices:
  ecapa  cosine of the generated line to the voice's held-out centroid (SpeechBrain VoxCeleb ECAPA), PRIMARY
  mcd    DTW mel-cepstral distance to the original line (delivery), fd_mfcc / ltas_hi (timbre, air): PLS-D components
  dur    generated / original duration; eos_fail = lines that hit the frame cap
Work is split across ranks by line and gathered, so both GPUs generate.
"""
from __future__ import annotations

from functools import partial
import math
from pathlib import Path
from typing import Any

import numpy as np


def tokens_for(model: Any, text: str, torch: Any) -> Any:
    return torch.tensor(model.flow_lm.conditioner.tokenizer.encode(text), dtype=torch.long)


def generate(model: Any, rows: list[tuple[Any, Any]], torch: Any, *, w_text: float = 1.0, w_voice: float = 1.0,
             temp: float = 0.3, n_steps: int = 1, max_frames: int = 250, eos_threshold: float = -1.0,
             seed: int = 0) -> tuple[list[Any], list[bool]]:
    """rows: (tokens, voice latents [Tv, C]). Returns (raw latents per row, hit-the-cap flags)."""
    import torch.nn.functional as F
    from pocket_tts.modules.stateful_module import init_states, increment_steps
    from training.modules.utils import set_state_padding

    fl = model.flow_lm
    device = fl.bos_emb.device
    B = len(rows)

    def prefix(use_voice: bool, use_text: bool):
        out = []
        for tokens, voice in rows:
            parts = [fl.bos_before_voice[0]]
            if use_voice and voice is not None:
                parts.append(F.linear(voice[None].to(device, fl.speaker_proj_weight.dtype), fl.speaker_proj_weight)[0])
            if use_text:
                parts.append(fl.conditioner(tokens[None].to(device))[0])
            out.append(torch.cat(parts, 0))
        width = max(r.shape[0] for r in out)
        cond = torch.zeros(B, width, out[0].shape[-1], device=device, dtype=out[0].dtype)
        for b, r in enumerate(out):
            cond[b, width - r.shape[0]:] = r
        return cond, torch.tensor([width - r.shape[0] for r in out], device=device, dtype=torch.long)

    branches = {"full": prefix(True, True)}
    need_text_only = abs(w_text - w_voice) > 1e-9
    need_null = not (abs(w_text - 1) < 1e-9 and abs(w_voice - 1) < 1e-9)
    if need_text_only:
        branches["text"] = prefix(False, True)
    if need_null:
        branches["null"] = prefix(False, False)
    states = {}
    for k, (p, pd) in branches.items():
        st = init_states(fl, B, p.shape[1] + max_frames + 2)
        set_state_padding(st, pd)
        states[k] = st
    first = [True]

    def run(x_lat):
        zs = {}
        for k, (p, _) in branches.items():
            inp = fl.input_linear(x_lat)
            if first[0]:
                inp = torch.cat([p, inp], dim=1)
            out = fl.out_norm(fl.transformer(inp, states[k]))
            increment_steps(fl, states[k], increment=inp.shape[1])
            zs[k] = out[:, -1].float()
        first[0] = False
        zf = zs["full"]
        if not need_null:
            return zf
        zn = zs["null"]
        if not need_text_only:
            return zn + w_text * (zf - zn)
        return zn + w_text * (zs["text"] - zn) + w_voice * (zf - zs["text"])

    g = torch.Generator(device=device).manual_seed(seed)
    x_lat = fl.bos_emb.view(1, 1, -1).expand(B, 1, -1)
    frames = []
    ends = torch.full((B,), max_frames, device=device, dtype=torch.long)
    done = torch.zeros(B, dtype=torch.bool, device=device)
    for t in range(max_frames):
        z = run(x_lat)
        noise = temp ** 0.5 * torch.randn(B, model.ldim, device=device, dtype=z.dtype, generator=g)
        latent = model.flow.decode(partial(fl.flow_net, z), noise, n_steps)
        logits = fl.out_eos(z).squeeze(-1)
        fired = (logits > eos_threshold) & ~done & (t >= 6)
        ends = torch.where(fired, torch.full_like(ends, t), ends)
        done = done | fired
        if bool(done.all()):
            break
        frames.append(latent)
        x_lat = latent[:, None, :].to(fl.bos_emb.dtype)
    if not frames:
        frames.append(torch.zeros(B, model.ldim, device=device))
    stacked = torch.stack(frames, dim=1)
    hit_cap = [not bool(d) for d in done.tolist()]
    return [stacked[b, : max(1, int(ends[b]))] * fl.emb_std + fl.emb_mean for b in range(B)], hit_cap


def decode(mimi: Any, latent: Any, torch: Any) -> Any:
    from pocket_tts.modules.stateful_module import init_states
    ratio = round(mimi.encoder_frame_rate / mimi.frame_rate)
    with torch.no_grad():
        state = init_states(mimi, 1, (latent.shape[0] + 8) * ratio)
        return mimi.decode_from_latent(latent[None].float(), state)[0, 0].float().cpu()


class PanelEvaluator:
    """Holds the panel text, reference latents, centroids and real-clip statistics; evaluates one model."""

    def __init__(self, corpus: dict, ref_latents: dict[str, Any], real: dict, analyzer: Any, train_counts: dict[str, int]):
        self.rows = {r["id"]: r for r in corpus["rows"]}
        self.panels = corpus["panels"]
        self.refs = ref_latents
        self.real = real                    # {"centroid": {voice: tensor}, "stats": {voice: {...}}, "orig": {id: features}}
        self.analyzer = analyzer
        self.counts = train_counts

    def jobs(self, ks: tuple[str, ...] = ("3", "1"), include_z: bool = True) -> list[tuple[str, str, str, str]]:
        """(panel, voice, line id, k) for every generation."""
        out = []
        for voice, entry in sorted(self.panels["D"].items()):
            for k in ks:
                if k in entry["refs"]:
                    out += [("D", voice, lid, k) for lid in entry["lines"]]
        if include_z:
            for voice, entry in sorted(self.panels["Z"].items()):
                out += [("Z", voice, lid, "3") for lid in entry["lines"]]
        # Skip anything whose audio could not be read during preparation.
        return [j for j in out if j[2] in self.real["orig"] and f"{j[0]}|{j[1]}|{j[3]}|0" in self.refs]

    def run(self, model: Any, mimi: Any, torch: Any, *, rank: int, world: int, w_text: float, w_voice: float,
            n_steps: int = 1, temp: float = 0.3, batch: int = 16, seed: int = 1337, ks=("3", "1"),
            include_z: bool = True, spot_dir: Path | None = None, spot_voices=()) -> dict:
        from . import likeness
        jobs = self.jobs(ks, include_z)
        mine = [j for i, j in enumerate(jobs) if i % world == rank]
        # Batch similar lengths together so the frame cap stays tight.
        mine.sort(key=lambda j: self.rows[j[2]]["dur"])
        records = []
        was_training = model.training
        model.eval()
        with torch.no_grad():
            for s in range(0, len(mine), batch):
                chunk = mine[s:s + batch]
                rows = [(tokens_for(model, self.rows[j[2]]["text"], torch), self.refs[f"{j[0]}|{j[1]}|{j[3]}|0"].to(model.flow_lm.bos_emb.device))
                        for j in chunk]
                cap = int(12 + 2.0 * max(self.rows[j[2]]["dur"] for j in chunk) * 12.5)
                lats, capped = generate(model, rows, torch, w_text=w_text, w_voice=w_voice, temp=temp, n_steps=n_steps,
                                        max_frames=min(cap, 300), seed=seed + 7919 * s + rank)
                for j, lat, hit in zip(chunk, lats, capped):
                    audio = decode(mimi, lat, torch)
                    feats = self.analyzer.features(audio)
                    orig = self.real["orig"][j[2]]
                    stats = self.real["stats"].get(j[1])
                    centroid = self.real["centroid"].get(j[1])
                    rec = {"panel": j[0], "voice": j[1], "line": j[2], "k": j[3], "hit_cap": bool(hit),
                           "dur": float(feats["dur"]), "dur_ratio": float(feats["dur"] / max(orig["dur"], 1e-3)),
                           "mcd": likeness.mcd_dtw(feats, orig)}
                    if centroid is not None:
                        rec["ecapa"] = float(centroid @ feats["ecapa"])
                    if stats is not None:
                        err = np.abs(feats["mel_act"].float().numpy().mean(0) - stats["ltas"])
                        rec["ltas_hi"] = float(err[likeness.HIGH_BIN:].mean())
                        rec["_mfcc"] = feats["mfcc"][:, 1:].float().numpy()
                    if spot_dir is not None and j[1] in spot_voices and j[3] == "3":
                        import soundfile as sf
                        spot_dir.mkdir(parents=True, exist_ok=True)
                        sf.write(str(spot_dir / f"{j[1]}__{j[2].split('/')[1]}.wav"), audio.numpy(), 24000, subtype="PCM_16")
                    records.append(rec)
        model.train(was_training)
        if world > 1:
            gathered = [None] * world
            torch.distributed.all_gather_object(gathered, records)
            records = [r for part in gathered for r in part]
        return self.summarize(records)

    def summarize(self, records: list[dict]) -> dict:
        from . import likeness
        out: dict[str, Any] = {}

        def macro(sel, key):
            per = {}
            for r in sel:
                if key in r and r[key] == r[key]:
                    per.setdefault(r["voice"], []).append(r[key])
            vals = {v: float(np.mean(x)) for v, x in per.items()}
            return (float(np.mean(list(vals.values()))) if vals else None), vals

        for panel, k in (("D", "3"), ("D", "1"), ("Z", "3")):
            sel = [r for r in records if r["panel"] == panel and r["k"] == k]
            if not sel:
                continue
            name = f"{panel}{k}"
            out[f"{name}_ecapa"], per_voice = macro(sel, "ecapa")
            out[f"{name}_ecapa_per_voice"] = per_voice
            if panel == "D":
                common = {v: x for v, x in per_voice.items() if self.counts.get(v, 0) >= 150}
                rare = {v: x for v, x in per_voice.items() if self.counts.get(v, 0) < 150}
                out[f"{name}_ecapa_common"] = float(np.mean(list(common.values()))) if common else None
                out[f"{name}_ecapa_rare"] = float(np.mean(list(rare.values()))) if rare else None
            out[f"{name}_mcd"], _ = macro(sel, "mcd")
            out[f"{name}_ltas_hi"], _ = macro(sel, "ltas_hi")
            out[f"{name}_dur_ratio_median"] = float(np.median([r["dur_ratio"] for r in sel]))
            out[f"{name}_hit_cap"] = int(sum(r["hit_cap"] for r in sel))
            frames: dict[str, list] = {}
            for r in sel:
                if "_mfcc" in r:
                    frames.setdefault(r["voice"], []).append(r["_mfcc"])
            fds = [likeness.frechet(np.concatenate(f), self.real["stats"][v]["mfcc"]) for v, f in frames.items()
                   if v in self.real["stats"]]
            out[f"{name}_fd_mfcc"] = float(np.median(fds)) if fds else None
            out[f"{name}_lines"] = len(sel)
        out["records"] = [{k: v for k, v in r.items() if not k.startswith("_")} for r in records]
        return out


def paired(a: dict[str, float], b: dict[str, float], draws: int = 2000, seed: int = 0) -> dict:
    """Mean per-voice difference b - a with a bootstrap 95% interval over voices."""
    import random
    keys = [k for k in a if k in b]
    if len(keys) < 3:
        return {"n": len(keys)}
    diff = [b[k] - a[k] for k in keys]
    rng = random.Random(seed)
    boots = sorted(float(np.mean([diff[rng.randrange(len(diff))] for _ in diff])) for _ in range(draws))
    return {"n": len(keys), "diff": float(np.mean(diff)), "lo": boots[int(0.025 * draws)], "hi": boots[int(0.975 * draws) - 1]}
