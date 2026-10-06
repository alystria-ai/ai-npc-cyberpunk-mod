"""Pocket v2 teacher / student training on Kaggle 2x T4 (torchrun), crash-tolerant.

Policies: pocket_crossref_teacher_v1 (role teacher), pocket_voice_guided_distill_v1 (role student).
Plan: docs/POCKET_NEXT_RUN_PLAN.md. The official, digest-pinned training modules are imported unmodified.

    torchrun --nproc_per_node 2 -m pocket_training.v2_train --config /kaggle/working/v2/config.json

Phases: prepare (latent cache, transcript QC, joined references, centroids; cached in the bucket for reuse) ->
step-0 evaluation -> training with ECAPA evaluation every `eval_every` updates -> early stop -> guidance sweep
(teacher) -> selected weights in the bucket. Every evaluation publishes a resumable checkpoint to the next of three
slots under runs/<run_id>/; logs go to runs/<run_id>/logs/ (the notebook watchdog also uploads them every 10 min).
"""
from __future__ import annotations

import argparse
import copy
from contextlib import contextmanager, nullcontext
from datetime import timedelta
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import sys
import threading
import time
import traceback
from typing import Any

from . import v2_data
from .v2_eval import PanelEvaluator, paired

BUCKET = "akshitireddy/cyberpunk-pocket-rolling-checkpoints"
POLICIES = {"teacher": "pocket_crossref_teacher_v1", "student": "pocket_voice_guided_distill_v1"}
SPOT_VOICES = ("johnny-silverhand", "judy-alvarez", "panam-palmer", "takemura")


# ----------------------------------------------------------------------------- small utilities
def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, indent=1, default=float), encoding="utf-8")
    os.replace(tmp, path)


class Log:
    def __init__(self, path: Path, rank: int):
        self.path, self.rank = path, rank

    def __call__(self, event: str, **fields: Any) -> None:
        if self.rank != 0:
            return
        line = json.dumps({"at": now(), "event": event, **fields}, default=float)
        print("V2 " + line[:1500], flush=True)
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(line + "\n")


# ----------------------------------------------------------------------------- bucket I/O (private HF bucket)
class Bucket:
    def __init__(self, run_id: str, enabled: bool = True):
        self.run_id, self.enabled = run_id, enabled and bool(os.environ.get("HF_TOKEN"))
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None

    def api(self):
        from huggingface_hub import HfApi
        return HfApi()

    def put(self, files: list[tuple[str, str]], delete: list[str] | None = None) -> None:
        if not self.enabled:
            return
        with self.lock:
            kwargs = {"add": [(src, f"runs/{self.run_id}/{dst}") for src, dst in files]}
            if delete:
                kwargs["delete"] = [f"runs/{self.run_id}/{d}" for d in delete]
            self.api().batch_bucket_files(BUCKET, token=os.environ["HF_TOKEN"], **kwargs)

    def delete(self, paths: list[str]) -> None:
        if not self.enabled or not paths:
            return
        with self.lock:
            self.api().batch_bucket_files(BUCKET, delete=[f"runs/{self.run_id}/{p}" for p in paths],
                                          token=os.environ["HF_TOKEN"])

    def listing(self, prefix: str = "") -> list[str]:
        if not self.enabled:
            return []
        base = f"runs/{self.run_id}/{prefix}"
        out = []
        try:
            for entry in self.api().list_bucket_tree(BUCKET, prefix=base, recursive=True, token=os.environ["HF_TOKEN"]):
                if getattr(entry, "type", None) == "file":
                    out.append(entry.path[len(f"runs/{self.run_id}/"):])
        except Exception:
            return []
        return out

    def get(self, remote: str, local: Path, run_id: str | None = None) -> bool:
        if not self.enabled:
            return False
        local.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.api().download_bucket_files(BUCKET, files=[(f"runs/{run_id or self.run_id}/{remote}", str(local))],
                                             raise_on_missing_files=True, token=os.environ["HF_TOKEN"])
            return local.is_file()
        except Exception:
            return False

    def background(self, fn, *args) -> None:
        """Run one upload at a time in the background; a new call waits for the previous one."""
        if self.thread is not None:
            self.thread.join()

        def body():
            try:
                fn(*args)
            except Exception as error:  # never kill training for an upload
                print("V2 upload_failed " + type(error).__name__ + " " + str(error)[:200], flush=True)
        self.thread = threading.Thread(target=body, daemon=True)
        self.thread.start()

    def wait(self) -> None:
        if self.thread is not None:
            self.thread.join()
            self.thread = None


# ----------------------------------------------------------------------------- environment and models
def install_source(source: Path) -> None:
    try:  # speechbrain still calls torchaudio.list_audio_backends, removed in newer torchaudio
        import torchaudio
        if not hasattr(torchaudio, "list_audio_backends"):
            torchaudio.list_audio_backends = lambda: ["soundfile"]
    except Exception:
        pass
    sys.path.insert(0, str(source))
    os.environ["HF_HUB_OFFLINE"] = "0"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")


def model_yaml(cfg: dict, name: str, weights: str, layers: int, out: Path) -> Path:
    import yaml
    base = "english_2026-04_24l.yaml" if layers == 24 else "english_2026-09.yaml"
    layers = int(cfg.get("layers_override", {}).get(name, layers))  # local smoke tests only
    raw = yaml.safe_load((Path(cfg["source_dir"]) / "pocket_tts/config" / base).read_text())
    raw["weights_path"] = weights
    raw["weights_path_without_voice_cloning"] = None
    raw["flow_lm"]["transformer"]["num_layers"] = layers
    raw["flow_lm"]["lookup_table"]["tokenizer_path"] = cfg["tokenizer"]
    raw["flow_lm"]["dtype"] = "float32"
    raw["mimi"]["dtype"] = "float32"
    raw.pop("default_temperature", None)
    path = out / f"{name}.yaml"
    path.write_text(yaml.safe_dump(raw, sort_keys=False))
    return path


def install_fp32_reductions(model: Any) -> None:
    """As runner.install_fp32_reductions: FP32 LSD loss and FP32 head outputs under FP16 autocast."""
    def promote(module, inputs, output):
        return output.float()
    model.flow.fp32_loss = True
    for flow_lm in (model.flow_lm, model.distill_teacher):
        if flow_lm is not None:
            flow_lm.out_norm.register_forward_hook(promote)
            flow_lm.out_eos.register_forward_hook(promote)


def build_inference_model(cfg: dict, weights: str, layers: int, work: Path, torch: Any):
    """Plain (TrainableTTS, mimi) for anchors / evaluation of a released or exported model."""
    from training.args import TrainArgs
    from training.modules.builders import build_models
    path = model_yaml(cfg, f"infer-{layers}-{hashlib.sha1(weights.encode()).hexdigest()[:8]}", weights, layers, work)
    args = TrainArgs(model_config=str(path), compile=False, start_from_pretrained=True, text_dropout=0, voice_dropout=0)
    model, mimi, _ = build_models(args)
    return model, mimi


# ----------------------------------------------------------------------------- EMA with warm-up
class WarmEMA:
    """Shadow of the trainable parameters; decay = min(target, (1 + t) / (10 + t))."""

    def __init__(self, model: Any, decay: float):
        self.decay = decay
        self.shadow = {k: p.detach().clone().float() for k, p in model.named_parameters() if p.requires_grad}
        self.updates = 0

    def update(self, model: Any, torch: Any) -> None:
        self.updates += 1
        d = min(self.decay, (1 + self.updates) / (10 + self.updates))
        named = dict(model.named_parameters())
        with torch.no_grad():
            shadows = [self.shadow[k] for k in self.shadow]
            params = [named[k].detach().float() for k in self.shadow]
            torch._foreach_mul_(shadows, d)
            torch._foreach_add_(shadows, params, alpha=1 - d)

    def state_dict(self) -> dict:
        return {"decay": self.decay, "updates": self.updates, "shadow": self.shadow}

    def load_state_dict(self, state: dict, device: Any) -> None:
        self.decay, self.updates = state["decay"], state["updates"]
        for k, v in state["shadow"].items():
            self.shadow[k].copy_(v.to(device))


@contextmanager
def ema_weights(model: Any, ema: WarmEMA, torch: Any):
    named = dict(model.named_parameters())
    saved = {k: named[k].detach().clone() for k in ema.shadow}
    with torch.no_grad():
        for k, v in ema.shadow.items():
            named[k].copy_(v.to(named[k].dtype))
    try:
        yield
    finally:
        with torch.no_grad():
            for k, v in saved.items():
                named[k].copy_(v)


# ----------------------------------------------------------------------------- guided distillation forward
def guided_distill_forward(model: Any, w_text: float, w_voice: float):
    """Replace TrainableTTS.forward for the student: the backbone regresses onto
    z_null + w_t (z_text - z_null) + w_v (z_full - z_text) of the frozen teacher (masked latent MSE)."""
    import torch
    from training.modules.conditioner import build_sequences_with_conditions

    text_only_args = copy.copy(model.args)
    text_only_args.voice_dropout, text_only_args.text_dropout = 1.0, 0.0

    def forward(latents, mask, text_tokens, voice_latents, update_stats=False, num_voice_prompt_frames=None):
        fl = model.flow_lm
        T = latents.shape[1]
        normalized = (latents - fl.emb_mean) / fl.emb_std

        def backbone(module, args, cfg_dropout, force_null=False):
            x, prefix = build_sequences_with_conditions(args, normalized, text_tokens, voice_latents,
                                                        cfg_dropout=cfg_dropout, fl=module,
                                                        num_voice_prompt_frames=num_voice_prompt_frames,
                                                        force_null=force_null)
            out = module.out_norm(module.transformer(x, model_state=None))
            idx = prefix[:, None] + torch.arange(T, device=out.device)[None, :]
            return out.gather(1, idx[:, :, None].expand(-1, -1, out.shape[-1]))

        z = backbone(fl, model.args, cfg_dropout=False)
        teacher = model.distill_teacher.to(latents.device)
        with torch.no_grad():
            z_full = backbone(teacher, model.args, cfg_dropout=False)
            z_null = backbone(teacher, model.args, cfg_dropout=False, force_null=True)
            if abs(w_text - w_voice) < 1e-9:
                z_t = z_null + w_text * (z_full - z_null)
            else:
                z_text = backbone(teacher, text_only_args, cfg_dropout=True)
                z_t = z_null + w_text * (z_text - z_null) + w_voice * (z_full - z_text)
        shifted = torch.cat([mask[:, :1], mask[:, :-1]], dim=1)
        loss = ((z.float() - z_t.float()).square().mean(dim=-1) * shifted).sum() / shifted.sum().clamp(min=1)
        return loss, {"distill_mse": loss.detach(), "loss": loss.detach()}

    return forward


# ----------------------------------------------------------------------------- prepare: latents, QC, references, real stats
def prepare(cfg: dict, corpus: dict, rank: int, world: int, device: Any, torch: Any, log: Log, bucket: Bucket) -> dict:
    cache = Path(cfg["cache_dir"])
    cache.mkdir(parents=True, exist_ok=True)
    done = cache / "complete.json"
    if not done.is_file() and rank == 0 and cfg.get("cache_run_id"):
        # Reuse a cache published by an earlier session (the teacher's, for the student).
        names = ["complete.json", "latents.pt", "real.pt", "qc.json"]
        ok = all(bucket.get(f"cache/{n}", cache / n, run_id=cfg["cache_run_id"]) for n in names)
        log("cache_download", ok=ok, source=cfg["cache_run_id"])
        if ok and cfg["cache_run_id"] != cfg["run_id"]:  # keep a copy under this run for later sessions
            bucket.background(bucket.put, [(str(cache / n), f"cache/{n}") for n in names])
        if not ok:
            for n in names:
                (cache / n).unlink(missing_ok=True)
    if world > 1:
        torch.distributed.barrier()
    if done.is_file():
        return load_cache(cache, torch)
    rows = {r["id"]: r for r in corpus["rows"]}

    def path_of(row):
        return str(Path(cfg["pool_root"] if row["src"] == "pool" else cfg["fa_root"]) / row["path"])

    from training.modules.builders import load_model_config
    from pocket_tts.models.mimi import build_mimi
    import safetensors
    config = load_model_config(str(model_yaml(cfg, "mimi", cfg["models"]["base6"], 6, Path(cfg["work_dir"]))), {})
    mimi = build_mimi(config.mimi)
    with safetensors.safe_open(cfg["models"]["base6"], framework="pt", device="cpu") as bundle:
        mimi.load_state_dict({k.removeprefix("mimi."): bundle.get_tensor(k) for k in bundle.keys() if k.startswith("mimi.")}, strict=True)
    mimi.eval().requires_grad_(False).to(device)
    # Transcript QC model (wav2vec2 CTC greedy decode) for pool rows.
    from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
    processor = Wav2Vec2Processor.from_pretrained(cfg["alignment_dir"], local_files_only=True)
    ctc = Wav2Vec2ForCTC.from_pretrained(cfg["alignment_dir"], local_files_only=True).float().to(device).eval()
    import torchaudio.functional as AF

    def letters(text):
        return "".join(c for c in text.upper() if c.isalpha() or c == "'")

    def cer(ref, hyp):
        ref, hyp = letters(ref), letters(hyp)
        if not ref:
            return 1.0
        prev = list(range(len(hyp) + 1))
        for i, a in enumerate(ref, 1):
            cur = [i] + [0] * len(hyp)
            for j, b in enumerate(hyp, 1):
                cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a != b))
            prev = cur
        return prev[-1] / len(ref)

    ids = sorted(rows)
    mine = ids[rank::world]
    latents, qc, t0, unreadable = {}, {}, time.time(), {}
    order = sorted(mine, key=lambda i: rows[i]["dur"])
    for s in range(0, len(order), 8):
        chunk, waves = [], []
        for i in order[s:s + 8]:
            try:  # a missing or unreadable file is skipped and logged, never fatal
                w = v2_data.load_wave(path_of(rows[i]), torch)
                if len(w) < v2_data.FRAME or not bool(torch.isfinite(w).all()):
                    raise ValueError("empty or non-finite audio")
                chunk.append(i); waves.append(w)
            except Exception as error:
                unreadable[i] = type(error).__name__
        if not chunk:
            continue
        lens = [len(w) for w in waves]
        batch = torch.zeros(len(waves), 1, max(lens))
        for b, w in enumerate(waves):
            batch[b, 0, : lens[b]] = w
        with torch.no_grad():
            enc = mimi.encode_to_latent(batch.to(device)).float().cpu()
        for b, i in enumerate(chunk):
            latents[i] = enc[b, : v2_data.frames_for(lens[b])].clone()
            rows[i]["speech_end"] = v2_data.speech_end_seconds(waves[b])
        pool = [b for b, i in enumerate(chunk) if rows[i]["src"] == "pool"]
        if pool:
            audio16 = [AF.resample(waves[b], 24000, 16000) for b in pool]
            n16 = [len(a) for a in audio16]
            x = torch.zeros(len(audio16), max(n16))
            for j, a in enumerate(audio16):
                x[j, : n16[j]] = (a - a.mean()) / (a.std() + 1e-7)
            attention = (torch.arange(max(n16))[None] < torch.tensor(n16)[:, None]).long()
            with torch.no_grad():
                logits = ctc(x.to(device), attention_mask=attention.to(device)).logits
            hyps = processor.batch_decode(logits.argmax(-1).cpu())
            for j, b in enumerate(pool):
                i = chunk[b]
                qc[i] = round(cer(rows[i]["text"], hyps[j]), 3)
        if rank == 0 and s % 800 == 0:
            log("prepare_progress", encoded=s, of=len(order), seconds=round(time.time() - t0))
    ends = {i: rows[i]["speech_end"] for i in mine if i in latents}
    if unreadable:
        print("V2 unreadable_clips " + json.dumps({"rank": rank, "count": len(unreadable), "examples": dict(list(unreadable.items())[:10])}), flush=True)
    torch.save({"latents": latents, "qc": qc, "ends": ends, "unreadable": unreadable}, cache / f"clips_rank{rank}.pt")
    del ctc
    if world > 1:
        torch.distributed.barrier()
    # Joined references (bank + panels): each rank encodes its share.
    jobs = v2_data.reference_jobs(corpus)
    refs = {}
    for n, (key, clip_ids) in enumerate(jobs):
        if n % world != rank:
            continue
        try:
            wav = v2_data.join([v2_data.load_wave(path_of(rows[c]), torch) for c in clip_ids], torch)
        except Exception as error:
            print(f"V2 reference_skipped {key} {type(error).__name__}", flush=True)
            continue
        with torch.no_grad():
            refs[key] = mimi.encode_to_latent(wav[None, None].to(device)).float().cpu()[0, : v2_data.frames_for(len(wav))].clone()
    torch.save(refs, cache / f"refs_rank{rank}.pt")
    if world > 1:
        torch.distributed.barrier()
    # Real-clip statistics: centroids, per-voice timbre stats, original-line features (split by voice, gathered).
    import numpy as np
    from . import likeness
    analyzer = likeness.Analyzer(device=str(device), ecapa_dir=cfg["ecapa_dir"], savedir=str(Path(cfg["work_dir"]) / f"ecapa{rank}"))
    voices = sorted(set(corpus["panels"]["D"]) | set(corpus["panels"]["Z"]))
    real = {"centroid": {}, "stats": {}, "orig": {}}
    for n, voice in enumerate(voices):
        if n % world != rank:
            continue
        entry = corpus["panels"]["D"].get(voice) or corpus["panels"]["Z"][voice]
        feats = []
        for cid in entry["centroid"][:40]:
            try:
                feats.append(analyzer.features(v2_data.load_wave(path_of(rows[cid]), torch)))
            except Exception:
                continue
        if len(feats) >= 2:
            stats = likeness.voice_reference_stats(feats)
            mf = stats["mfcc"]
            if len(mf) > 6000:
                mf = mf[np.random.default_rng(0).choice(len(mf), 6000, replace=False)]
            real["stats"][voice] = {"ltas": stats["ltas"], "mfcc": mf}
            real["centroid"][voice] = stats["ecapa"]
        for lid in entry["lines"]:
            try:
                f = analyzer.features(v2_data.load_wave(path_of(rows[lid]), torch))
            except Exception as error:
                print(f"V2 panel_line_unreadable {lid} {type(error).__name__}", flush=True)
                continue
            real["orig"][lid] = {"dur": f["dur"], "mfcc": f["mfcc"]}
    torch.save(real, cache / f"real_rank{rank}.pt")
    if world > 1:
        torch.distributed.barrier()
    if rank == 0:
        merged = {"clips": {}, "refs": {}, "qc": {}, "ends": {}}
        real_all = {"centroid": {}, "stats": {}, "orig": {}}
        for r in range(world):
            part = torch.load(cache / f"clips_rank{r}.pt", weights_only=False)
            merged["clips"].update(part["latents"]); merged["qc"].update(part["qc"]); merged["ends"].update(part["ends"])
            merged.setdefault("unreadable", {}).update(part.get("unreadable", {}))
            merged["refs"].update(torch.load(cache / f"refs_rank{r}.pt", weights_only=False))
            rp = torch.load(cache / f"real_rank{r}.pt", weights_only=False)
            for k in real_all:
                real_all[k].update(rp[k])
        torch.save({"clips": merged["clips"], "refs": merged["refs"], "ends": merged["ends"]}, cache / "latents.pt")
        torch.save(real_all, cache / "real.pt")
        atomic_json(cache / "qc.json", merged["qc"])
        atomic_json(done, {"at": now(), "clips": len(merged["clips"]), "refs": len(merged["refs"]),
                           "qc_rows": len(merged["qc"]), "centroids": len(real_all["centroid"]),
                           "unreadable": len(merged.get("unreadable", {}))})
        for r in range(world):
            for n in ("clips", "refs", "real"):
                (cache / f"{n}_rank{r}.pt").unlink(missing_ok=True)
        files = [(str(cache / n), f"cache/{n}") for n in ("latents.pt", "real.pt", "qc.json", "complete.json")]
        bucket.background(bucket.put, files)
        log("prepare_complete", **json.loads(done.read_text()))
    if world > 1:
        torch.distributed.barrier()
    del mimi
    torch.cuda.empty_cache()
    return load_cache(cache, torch)


def load_cache(cache: Path, torch: Any) -> dict:
    data = torch.load(cache / "latents.pt", weights_only=False)
    return {"clips": data["clips"], "refs": data["refs"], "ends": data["ends"],
            "real": torch.load(cache / "real.pt", weights_only=False),
            "qc": json.loads((cache / "qc.json").read_text())}


# ----------------------------------------------------------------------------- main
def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    cfg = json.loads(parser.parse_args().config.read_text())
    role = cfg["role"]
    install_source(Path(cfg["source_dir"]))
    import torch
    from torch.nn.parallel import DistributedDataParallel as DDP

    rank, world = int(os.environ.get("RANK", 0)), int(os.environ.get("WORLD_SIZE", 1))
    local = int(os.environ.get("LOCAL_RANK", 0))
    cuda = torch.cuda.is_available() and not cfg.get("force_cpu")
    device = torch.device("cuda", local) if cuda else torch.device("cpu")
    if cuda:
        torch.cuda.set_device(local)
    if world > 1:
        torch.distributed.init_process_group("nccl" if cuda else "gloo", timeout=timedelta(minutes=90))
    work = Path(cfg["work_dir"]) / role
    work.mkdir(parents=True, exist_ok=True)
    log = Log(work / "events.jsonl", rank)
    bucket = Bucket(cfg["run_id"], enabled=cfg.get("bucket", True))
    started = time.time()
    log("start", role=role, policy=POLICIES[role], run_id=cfg["run_id"], world=world,
        gpu=torch.cuda.get_device_name(local) if cuda else "cpu")
    corpus = json.loads(Path(cfg["corpus"]).read_text(encoding="utf-8"))
    data = prepare(cfg, corpus, rank, world, device, torch, log, bucket)
    for row in corpus["rows"]:
        if row["id"] in data["ends"]:
            row["speech_end"] = data["ends"][row["id"]]
    rejected = {i for i, c in data["qc"].items() if c > cfg.get("qc_max_cer", 0.6)}
    sampler = v2_data.CrossRefSampler(corpus, {**data["clips"], **data["refs"]}, cfg["seed"], rejected=rejected)
    train_counts = {v: len(c) for v, c in sampler.clips.items()}
    log("data", train_clips=sum(train_counts.values()), voices=len(sampler.voices), qc_rejected=len(rejected),
        qc_checked=len(data["qc"]), refs=len(data["refs"]))

    from training.args import load_args
    from training.modules.builders import build_models
    from training.train_utils import build_optimizer, lr_at

    source = Path(cfg["source_dir"])
    if role == "teacher":
        args = load_args(source / "training/configs/finetune.yaml")
        args.model_config = str(model_yaml(cfg, "teacher", cfg["models"]["base24"], 24, work))
        args.start_from_pretrained = True
    else:
        args = load_args(source / "training/configs/depth_distill.yaml")
        args.model_config = str(model_yaml(cfg, "student", cfg["models"]["base6"], 6, work))
        args.start_from_pretrained = False
        args.distill_teacher_config = str(model_yaml(cfg, "teacher", cfg["models"]["base24"], 24, work))
        args.distill_teacher_overrides = {}
        args.distill_teacher_weights = cfg["teacher_weights"]
        args.distill_teacher_use_ema = False
        args.student_init_from = cfg["models"]["base6"]
        args.distill_cfg_coef = 2.0  # attaches the frozen teacher; the target itself is the guided forward below
    args.model_overrides = {}
    args.compile = False
    args.stats_ema_steps = 0
    args.seed = cfg["seed"]
    args.optim.lr = cfg["lr"]
    args.optim.warmup_steps = cfg["warmup"]
    args.optim.schedule = "cosine"
    args.optim.lr_min_ratio = cfg.get("lr_min_ratio", 0.1)
    args.max_steps = cfg["horizon"]
    torch.manual_seed(cfg["seed"] + rank)
    random.seed(cfg["seed"] + rank)
    model, mimi, _ = build_models(args)
    install_fp32_reductions(model)
    model.to(device).train()
    mimi.to(device).eval()
    if model.distill_teacher is not None:
        model.distill_teacher.to(device).eval()
        model.forward = guided_distill_forward(model, *cfg["guidance"])
    optimizer = build_optimizer(model, args, device, rank)
    ema = WarmEMA(model, cfg["ema_decay"])
    scaler = torch.amp.GradScaler("cuda", enabled=cuda and cfg.get("precision", "fp16") == "fp16", init_scale=128)
    analyzer = None
    from . import likeness
    analyzer = likeness.Analyzer(device=str(device), ecapa_dir=cfg["ecapa_dir"], savedir=str(Path(cfg["work_dir"]) / f"ecapa-eval{rank}"))
    evaluator = PanelEvaluator(corpus, data["refs"], data["real"], analyzer, train_counts)
    state = {"step": 0, "best": None, "best_step": None, "bad_evals": 0, "z_best": None, "history": [],
             "anchors": {}, "slot": 0, "policy": POLICIES[role], "run_id": cfg["run_id"], "status": "running"}

    # ---------------- resume from the newest complete bucket slot
    ckpt_dir = Path(cfg.get("ckpt_dir", "/tmp/v2ckpt"))
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    if cfg.get("resume"):
        best_slot = None
        if rank == 0:
            manifests = [p for p in bucket.listing() if p.endswith("/manifest.json") and p.startswith("slot-")]
            found = []
            for m in manifests:
                local_m = ckpt_dir / m.replace("/", "_")
                if bucket.get(m, local_m):
                    found.append((json.loads(local_m.read_text())["step"], m.split("/")[0]))
            if found:
                best_slot = max(found)[1]
                ok = bucket.get(f"{best_slot}/last.pt", ckpt_dir / "resume.pt")
                best_slot = best_slot if ok else None
            log("resume_lookup", slots=found, chosen=best_slot)
        holder = [best_slot]
        if world > 1:
            torch.distributed.broadcast_object_list(holder, 0)
        if holder[0] is not None:
            if world > 1:
                torch.distributed.barrier()
            payload = torch.load(ckpt_dir / "resume.pt", map_location="cpu", weights_only=False)
            model.load_state_dict(payload["model"], strict=True)
            optimizer.load_state_dict(payload["optimizer"])
            ema.load_state_dict(payload["ema"], device)
            scaler.load_state_dict(payload["scaler"])
            state.update(payload["state"])
            state["status"] = "running"
            log("resumed", step=state["step"], best=state["best"], best_step=state["best_step"])
            del payload

    wrapped = DDP(model, device_ids=[local] if cuda else None, find_unused_parameters=True) if world > 1 else model
    trainable = [p for p in model.parameters() if p.requires_grad]
    micro = cfg["micro_batch"]
    accum = 64 // (world * micro)
    if accum * world * micro != 64:
        raise ValueError("effective batch must be 64")
    tokenize = model.flow_lm.conditioner.tokenizer.encode
    eval_cfg = {"w_text": cfg["eval_guidance"][0], "w_voice": cfg["eval_guidance"][1],
                "n_steps": cfg.get("eval_steps", 1), "temp": 0.3}

    def evaluate(tag: str, use_ema: bool, *, guidance=None, ks=("3", "1"), include_z=True, spot=True) -> dict:
        g = guidance or (eval_cfg["w_text"], eval_cfg["w_voice"])
        t0 = time.time()
        ctx = ema_weights(model, ema, torch) if use_ema else nullcontext()
        with ctx:
            result = evaluator.run(model, mimi, torch, rank=rank, world=world, w_text=g[0], w_voice=g[1],
                                   n_steps=eval_cfg["n_steps"], temp=0.3, ks=ks, include_z=include_z,
                                   spot_dir=(work / "spot" / tag) if spot and rank == 0 else None, spot_voices=SPOT_VOICES)
        result["seconds"] = round(time.time() - t0, 1)
        result["guidance"] = list(g)
        if rank == 0:
            atomic_json(work / "evals" / f"{tag}.json", result)
        return result

    def brief(result: dict) -> dict:
        return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in result.items()
                if not k.endswith("per_voice") and k != "records"}

    def anchor(name: str, weights: str, layers: int, guidance) -> None:
        if name in state["anchors"]:
            return
        m, mm = build_inference_model(cfg, weights, layers, work, torch)
        m.to(device).eval(); mm.to(device).eval()
        t0 = time.time()
        result = evaluator.run(m, mm, torch, rank=rank, world=world, w_text=guidance[0], w_voice=guidance[1],
                               n_steps=1, temp=0.3, spot_dir=(work / "spot" / name) if rank == 0 else None,
                               spot_voices=SPOT_VOICES)
        result["seconds"] = round(time.time() - t0, 1)
        result["guidance"] = list(guidance)
        state["anchors"][name] = {k: v for k, v in result.items() if k != "records"}
        if rank == 0:
            atomic_json(work / "evals" / f"anchor-{name}.json", result)
        log("anchor", name=name, **brief(result))
        del m, mm
        torch.cuda.empty_cache()

    def publish(step: int, best_changed: bool) -> None:
        """Rank 0: write last.pt and upload it to the next slot (manifest last); selected weights when best."""
        if rank != 0:
            return
        bucket.wait()
        slot = f"slot-{state['slot'] % 3}"
        state["slot"] += 1
        path = ckpt_dir / "last.pt"
        torch.save({"model": model.state_dict(), "optimizer": optimizer.state_dict(), "ema": ema.state_dict(),
                    "scaler": scaler.state_dict(), "state": state, "config": cfg}, path)
        manifest = ckpt_dir / "manifest.json"
        atomic_json(manifest, {"step": step, "at": now(), "policy": POLICIES[role], "best": state["best"],
                               "best_step": state["best_step"], "bytes": path.stat().st_size})
        uploads = []
        if best_changed:
            sel = ckpt_dir / "selected.safetensors"
            import safetensors.torch
            with ema_weights(model, ema, torch):
                tensors = {k: v.detach().float().cpu().contiguous() for k, v in model.state_dict().items() if k.startswith("flow_lm.")}
            safetensors.torch.save_file(tensors, str(sel))
            atomic_json(ckpt_dir / "selected.json", {"step": step, "weights": "ema", "policy": POLICIES[role],
                                                       "best": state["best"], "metric": "D3_ecapa"})
            uploads = [(str(sel), f"selected/{role}-ema.safetensors"), (str(ckpt_dir / "selected.json"), f"selected/{role}.json")]

        def body():
            bucket.delete([f"{slot}/manifest.json"])
            bucket.put([(str(path), f"{slot}/last.pt")])
            bucket.put([(str(manifest), f"{slot}/manifest.json")])
            if uploads:
                bucket.put(uploads)
            files = [(str(p), f"logs/{role}/{p.relative_to(work).as_posix()}") for p in work.rglob("*")
                     if p.is_file() and p.suffix in (".json", ".jsonl", ".wav") and p.stat().st_size < 50_000_000]
            if files:
                bucket.put(files)
            print(f"V2 published {slot} step {step} best_changed={best_changed}", flush=True)
        bucket.background(body)

    # ---------------- step-0 anchors and baseline
    if state["step"] == 0 and not state["history"]:
        if role == "student":
            anchor("student5000", cfg["models"]["student5000"], 6, (1.0, 1.0))
            anchor("base6", cfg["models"]["base6"], 6, (1.0, 1.0))
        result = evaluate("step000000", use_ema=False)
        state["history"].append({"step": 0, **brief(result)})
        state["best"], state["best_step"] = result.get("D3_ecapa"), 0
        state["z_best"] = result.get("Z3_ecapa")
        log("eval", step=0, **brief(result))
        if role == "student":
            for name in state["anchors"]:
                cmp = paired(state["anchors"][name].get("D3_ecapa_per_voice", {}), result.get("D3_ecapa_per_voice", {}))
                log("vs_anchor", step=0, anchor=name, **cmp)

    # ---------------- training loop
    max_steps, budget = cfg["max_steps"], cfg["time_budget_seconds"]
    step = state["step"]
    step_times = []
    stop_reason = ""
    while step < max_steps:
        t_step = time.time()
        lr = lr_at(step, args)
        for group in optimizer.param_groups:
            group["lr"] = lr * group.get("lr_scale", 1)
        optimizer.zero_grad(set_to_none=True)
        sums = {}
        modes = {}
        for m in range(accum):
            base = step * 64 + m * world * micro + rank * micro
            samples = [sampler.sample(base + i) for i in range(micro)]
            for s in samples:
                modes[s[3]] = modes.get(s[3], 0) + 1
            latents, mask, tokens, voice, frames = v2_data.collate(samples, tokenize, torch)
            latents, mask, voice = latents.to(device), mask.to(device), voice.to(device)
            sync = wrapped.no_sync() if world > 1 and m < accum - 1 else nullcontext()
            with sync:
                with torch.autocast(device_type="cuda", dtype=torch.float16, enabled=scaler.is_enabled()):
                    loss, metrics = wrapped(latents, mask, tokens, voice, num_voice_prompt_frames=frames)
                scaler.scale(loss / accum).backward()
            for k, v in metrics.items():
                if torch.is_tensor(v) and v.numel() == 1:
                    sums[k] = sums.get(k, 0.0) + float(v) / accum
        scaler.unscale_(optimizer)
        grad_norm = torch.nn.utils.clip_grad_norm_(trainable, args.optim.max_norm)
        scaler.step(optimizer)
        scaler.update()
        ema.update(model, torch)
        step += 1
        state["step"] = step
        step_times.append(time.time() - t_step)
        if step <= 3 or step % 10 == 0:
            totals = torch.tensor([sums.get("loss", 0.0), sums.get("flow_loss", sums.get("distill_mse", 0.0)),
                                   sums.get("eos_loss", 0.0)], device=device)
            if world > 1:
                torch.distributed.all_reduce(totals)
                totals /= world
            log("train", step=step, lr=lr, loss=float(totals[0]), main=float(totals[1]), eos=float(totals[2]),
                grad_norm=float(grad_norm), scale=scaler.get_scale(), s_per_step=round(sum(step_times[-10:]) / len(step_times[-10:]), 3),
                modes=modes, mem_gb=round(torch.cuda.max_memory_allocated() / 2**30, 2) if cuda else 0)
        elapsed = time.time() - started
        avg = sum(step_times[-50:]) / len(step_times[-50:])
        flag_t = torch.tensor([1.0 if elapsed + avg * 20 + cfg.get("eval_reserve_seconds", 900) > budget else 0.0], device=device)
        if world > 1:
            torch.distributed.broadcast(flag_t, 0)  # every rank must take the same evaluation decision
        out_of_time = bool(flag_t.item() > 0)
        if step % cfg["eval_every"] == 0 or step == max_steps or out_of_time:
            result = evaluate(f"step{step:06d}", use_ema=True)
            score, z = result.get("D3_ecapa"), result.get("Z3_ecapa")
            improved = score is not None and (state["best"] is None or score > state["best"] + cfg["min_delta"])
            best_changed = score is not None and (state["best"] is None or score > state["best"])
            if best_changed:
                state["best"], state["best_step"] = score, step
            state["bad_evals"] = 0 if improved else state["bad_evals"] + 1
            if z is not None and (state["z_best"] is None or z > state["z_best"]):
                state["z_best"] = z
            state["history"].append({"step": step, **brief(result)})
            log("eval", step=step, best=state["best"], best_step=state["best_step"], bad_evals=state["bad_evals"], **brief(result))
            publish(step, best_changed)
            if step >= cfg["min_steps"] and state["bad_evals"] >= cfg["patience"]:
                stop_reason = "ecapa_plateau"
            if (step >= cfg["min_steps"] and z is not None and state["z_best"] is not None
                    and z < state["z_best"] - cfg.get("z_drop", 0.02)):
                stop_reason = "zero_shot_drop"
            if out_of_time:
                stop_reason = stop_reason or "time_budget"
            flag = [stop_reason]
            if world > 1:
                torch.distributed.broadcast_object_list(flag, 0)
            stop_reason = flag[0]
            if stop_reason:
                break
    state["status"] = "stopped"
    state["stop_reason"] = stop_reason or "max_steps"
    log("stopped", step=step, reason=state["stop_reason"], best=state["best"], best_step=state["best_step"])

    # ---------------- teacher: guidance sweep on the selected weights
    if role == "teacher" and cfg.get("sweep") and state["best_step"]:
        if rank == 0:
            bucket.wait()
        sel = ckpt_dir / "selected.safetensors"  # same machine: rank 0 wrote it, every rank reads it
        if world > 1:
            torch.distributed.barrier()
        import safetensors.torch
        model.load_state_dict({**model.state_dict(), **safetensors.torch.load_file(str(sel))}, strict=True)
        sweep = {}
        for g in cfg["sweep"]:
            r = evaluate(f"sweep-wt{g[0]}-wv{g[1]}", use_ema=False, guidance=tuple(g), include_z=False, spot=True)
            sweep[f"{g[0]},{g[1]}"] = brief(r)
            log("sweep", sweep_guidance=g, **brief(r))
        state["sweep"] = sweep
        joint = sweep.get("2.0,2.0") or sweep.get("2,2")
        best_g, best_v = None, -1.0
        for key, r in sweep.items():
            if r.get("D3_ecapa") is None:
                continue
            if joint and joint.get("D3_mcd") and r.get("D3_mcd") and r["D3_mcd"] > joint["D3_mcd"] * 1.03:
                continue
            if joint and joint.get("D3_fd_mfcc") and r.get("D3_fd_mfcc") and r["D3_fd_mfcc"] > joint["D3_fd_mfcc"] * 1.10:
                continue
            if joint and abs(r.get("D3_dur_ratio_median", 1) / max(joint.get("D3_dur_ratio_median", 1), 1e-3) - 1) > 0.10:
                continue
            if r["D3_ecapa"] > best_v:
                best_g, best_v = key, r["D3_ecapa"]
        state["selected_guidance"] = [float(x) for x in best_g.split(",")] if best_g else [2.0, 2.0]
        log("sweep_selected", guidance=state["selected_guidance"], ecapa=best_v)
    if rank == 0:
        atomic_json(work / "final-state.json", state)
        bucket.wait()
        files = [(str(p), f"logs/{role}/{p.relative_to(work).as_posix()}") for p in work.rglob("*")
                 if p.is_file() and p.suffix in (".json", ".jsonl", ".wav") and p.stat().st_size < 50_000_000]
        try:
            bucket.put(files)
        except Exception as error:
            print("V2 final_upload_failed", type(error).__name__, flush=True)
    if world > 1:
        torch.distributed.barrier()
        torch.distributed.destroy_process_group()
    log("done", seconds=round(time.time() - started))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc()
        sys.stdout.flush()
        raise
