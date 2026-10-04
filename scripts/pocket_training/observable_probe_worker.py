"""Observable, isolated 100-update Pocket teacher diagnostic on authentic audio.

This is a diagnostic of Kaggle execution and checkpoint publication, not a
replacement quality recipe. It uses one CUDA device, effective batch two, the
official raw-audio encoder and teacher objective, and the selected A initializer.
Only a separate, explicitly qualified full run may be promoted for the mod.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import signal
import subprocess
import sys
import time
import traceback
from typing import Any


ANCHOR_SHA256 = "ce80dd672670de6b0b2aa658023db7699b1782ecff8d8a66cf1f1ec15c803fbc"
MAX_OUTPUT_BYTES = 18_000_000_000
STOP_REQUESTED = False


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temp.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(payload, stream, indent=2, ensure_ascii=False, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


class Events:
    def __init__(self, output: Path, total_steps: int):
        self.output = output
        self.path = output / "events.jsonl"
        self.total_steps = total_steps
        self.started = time.monotonic()
        self.latest_step = 0

    def emit(self, phase: str, **data: Any) -> None:
        record = {"time_utc": utc_now(), "elapsed_seconds": round(time.monotonic() - self.started, 3),
                  "phase": phase, "step": self.latest_step, "total_steps": self.total_steps, **data}
        line = json.dumps(record, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        with self.path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(line + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        print(line, flush=True)
        atomic_json(self.output / "status.json", record)


def on_stop(_signum: int, _frame: Any) -> None:
    global STOP_REQUESTED
    STOP_REQUESTED = True


def selected_rows(root: Path, output: Path, events: Events) -> tuple[Path, str]:
    selection = json.loads((root / "probe-selection.json").read_text(encoding="utf-8-sig"))
    rows = selection.get("rows")
    if not isinstance(rows, list) or len(rows) < 2 or len(rows) > 64:
        raise ValueError("probe-selection.json must contain 2–64 full original train rows")
    manifest = root / "data/train.jsonl"
    manifest_hash = sha256_file(manifest)
    if selection.get("source_manifest_sha256") != manifest_hash:
        raise ValueError("Probe rows do not bind to the staged frozen train manifest")
    if selection.get("anchor_sha256") != ANCHOR_SHA256:
        raise ValueError("Probe selection does not declare the exact A initializer")
    originals: dict[str, dict[str, Any]] = {}
    with manifest.open("r", encoding="utf-8-sig") as stream:
        for line in stream:
            row = json.loads(line)
            key = str(row.get("id", row.get("line_id", "")))
            if key:
                if key in originals:
                    raise ValueError(f"Duplicate train row ID: {key}")
                originals[key] = row
    selected = []
    ids = set()
    for row in rows:
        key = str(row.get("id", row.get("line_id", "")))
        if not key or key in ids or originals.get(key) != row:
            raise ValueError(f"Selected row missing, changed, or repeated in original manifest: {key}")
        ids.add(key)
        if not 2.5 <= float(row["duration"]) <= 5.0 or len(row.get("words", [])) < 3:
            raise ValueError(f"Selected row is outside the declared short aligned audio gate: {key}")
        path = (root / str(row["path"])).resolve()
        if not path.is_relative_to(root) or not path.is_file() or path.suffix.lower() != ".wav":
            raise ValueError(f"Selected native WAV is missing or outside the staged input: {key}")
        expected_audio_hash = row.get("audio_sha256", row.get("sha256"))
        if not isinstance(expected_audio_hash, str) or sha256_file(path) != expected_audio_hash:
            raise ValueError(f"Selected native WAV differs from its admitted source hash: {key}")
        selected.append({**row, "path": str(path)})
    selected_path = output / "probe-selected.jsonl"
    with selected_path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in selected:
            stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    events.emit("selection_verified", selected_rows=len(selected), source_manifest_sha256=manifest_hash,
                selected_manifest_sha256=sha256_file(selected_path), speaker_count=len({
                    str(row.get("character") or row.get("speaker_id") or row.get("speaker", "unknown")) for row in selected}))
    return selected_path, manifest_hash


def make_config(root: Path, output: Path) -> Path:
    import yaml

    source = root / "configs/a-teacher.yaml"
    config = yaml.safe_load(source.read_text(encoding="utf-8-sig"))
    if config["flow_lm"]["transformer"]["num_layers"] != 24:
        raise ValueError("Probe requires the official 24-layer teacher")
    config["weights_path"] = str((root / "a-ema500/model.safetensors").resolve())
    config["flow_lm"]["lookup_table"]["tokenizer_path"] = str((root / "models/tokenizer.json").resolve())
    config["flow_lm"]["dtype"] = "float32"
    config["mimi"]["dtype"] = "float32"
    config["flow_lm"]["weights_path"] = None
    config["mimi"]["weights_path"] = None
    config["weights_path_without_voice_cloning"] = None
    destination = output / "teacher-inference.yaml"
    destination.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    return destination


def export_raw(root: Path, output: Path, step: int, model: Any, mimi: Any, events: Events) -> None:
    import yaml
    from training.checkpointing import export_pocket_safetensors

    destination = output / f"export-step{step:06d}"
    destination.mkdir(exist_ok=True)
    events.emit("export_begin", export_step=step)
    weights = destination / "model.safetensors"
    export_pocket_safetensors(weights, model.flow_lm, mimi, None)
    shutil.copyfile(root / "models/tokenizer.json", destination / "tokenizer.json")
    config = yaml.safe_load((output / "teacher-inference.yaml").read_text(encoding="utf-8"))
    config["weights_path"] = "model.safetensors"
    config["flow_lm"]["lookup_table"]["tokenizer_path"] = "tokenizer.json"
    (destination / "inference.yaml").write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    (destination / "README.txt").write_text(
        "Diagnostic raw teacher export; never automatically promoted. Paths in inference.yaml "
        "are relative to this folder. Run a loader with this folder as its working directory "
        "or rewrite those two paths to absolute local paths before loading.\n", encoding="utf-8")
    events.emit("export_complete", export_step=step, export_bytes=weights.stat().st_size,
                export_sha256=sha256_file(weights))


def run(root: Path, output: Path, steps: int, events: Events) -> int:
    if steps != 100:
        raise ValueError("This isolated probe is fixed at exactly 100 optimizer updates")
    root, output = root.resolve(), output.resolve()
    if not (root / "pocket-source/training/configs/finetune.yaml").is_file():
        raise ValueError("The staged official Pocket training source is missing")
    if not (root / "candidate/scripts/pocket_training/runner.py").is_file():
        raise ValueError("The frozen continuation runner is missing")
    events.emit("startup", root=str(root), output=str(output), diagnostic_effective_batch=2,
                optimizer_updates=steps, quality_replacement=False)
    selected, source_manifest_hash = selected_rows(root, output, events)
    initializer = root / "a-ema500/model.safetensors"
    anchor_hash = sha256_file(initializer)
    if anchor_hash != ANCHOR_SHA256:
        raise ValueError("Staged A EMA500 model differs from the qualified initializer")
    events.emit("anchor_verified", anchor_sha256=anchor_hash, anchor_bytes=initializer.stat().st_size)
    sys.path.insert(0, str(root / "candidate/scripts"))
    sys.path.insert(0, str(root / "pocket-source"))
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    events.emit("imports_begin")
    import torch
    from pocket_training import runner
    from training.args import load_args
    from training.checkpointing import EMA
    from training.dataloader import encode_batch
    from training.modules.builders import build_models
    from training.train_utils import build_optimizer, lr_at

    if not torch.cuda.is_available():
        raise RuntimeError("No CUDA GPU; this probe cannot silently train on CPU")
    torch.set_num_threads(2)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cuda.enable_cudnn_sdp(False)
    device = torch.device("cuda:0")
    torch.cuda.set_device(device)
    events.emit("gpu_ready", gpu=torch.cuda.get_device_name(device), gpu_memory_bytes=torch.cuda.get_device_properties(device).total_memory,
                torch_version=torch.__version__)

    config_path = make_config(root, output)
    args = load_args(root / "pocket-source/training/configs/finetune.yaml")
    args.model_config = str(config_path)
    args.model_overrides = {}
    args.run_dir = output / "teacher"
    args.run_dir.mkdir(exist_ok=True)
    args.data.train_jsonl = str(selected)
    args.data.valid_jsonl = str(selected)
    args.data.precompute = False
    args.data.loader_procs = 1
    args.data.num_bucket_batches = 1
    args.compile = False
    args.stats_ema_steps = 0
    args.seed = 42
    args.batch_size = 1
    args.grad_accum_steps = 2
    args.optim.lr = 1e-5
    args.optim.schedule = "constant"
    args.optim.warmup_steps = 10
    args.max_steps = steps
    args.ema_decay = 0.999
    args.log_freq = 1
    args.sample_sentences = []
    args.sample_freq = 0
    events.emit("model_load_begin", layers=24, precision="fp16", calibration="frozen",
                learning_rate=args.optim.lr, warmup_steps=args.optim.warmup_steps)
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    model, mimi, _ = build_models(args)
    runner.install_fp32_reductions(model)
    model.to(device).train()
    mimi.to(device).eval()
    if model.distill_teacher is not None or any(p.dtype != torch.float32 for p in model.parameters()):
        raise RuntimeError("Expected a FP32-master teacher, not a student/distillation graph")
    optimizer = build_optimizer(model, args, device, rank=0)
    ema = EMA(model, args.ema_decay)
    scaler = torch.amp.GradScaler("cuda", enabled=True, init_scale=128)
    loader = runner.IndexedBatches(args, model, mimi, balanced=False)
    if loader.size != len(json.loads((root / "probe-selection.json").read_text())["rows"]):
        raise RuntimeError("Official loader did not index exactly the selected native rows")
    events.emit("model_ready", trainable_parameters=sum(p.numel() for p in model.parameters() if p.requires_grad),
                selected_rows=loader.size, peak_gpu_allocated_bytes=torch.cuda.max_memory_allocated(device))

    identity = hashlib.sha256(json.dumps({"source_manifest_sha256": source_manifest_hash,
        "selected_manifest_sha256": sha256_file(selected), "anchor_sha256": anchor_hash,
        "steps": steps, "effective_batch": 2, "lr": args.optim.lr, "warmup": args.optim.warmup_steps},
        sort_keys=True).encode()).hexdigest()
    spec = runner.Spec(output / "probe-spec.json", {"max_output_gib": 18}, root,
                       root / "pocket-source", output, identity, {"train": selected})
    runner.atomic_json(spec.path, {"schema": "isolated_observable_teacher_probe_v1", "input_identity": identity,
        "diagnostic_only": True, "selected_manifest_sha256": sha256_file(selected),
        "full_train_manifest_sha256": source_manifest_hash, "anchor_sha256": anchor_hash,
        "effective_batch": 2, "optimizer_updates": steps, "lr": args.optim.lr,
        "warmup_steps": args.optim.warmup_steps, "ema_decay": args.ema_decay})
    state = {"status": "running", "scope": "observable_diagnostic_not_quality_replacement",
             "precision": "fp16", "effective_batch_size": 2, "planned_max_steps": steps,
             "learning_schedule_steps": steps, "ema_decay": args.ema_decay,
             "selected_manifest_sha256": sha256_file(selected)}
    remote_config_path = root / "remote-checkpoint-config.json"
    remote_config = json.loads(remote_config_path.read_text(encoding="utf-8")) if remote_config_path.is_file() else None
    # A remote diagnostic needs the first saved model available during later
    # updates, plus the final model. Avoid uploading ten redundant 5 GB states.
    checkpoint_interval = steps if remote_config is not None else 10
    events.emit("checkpoint_schedule", first_step=1, interval=checkpoint_interval,
                remote_uploads_enabled=remote_config is not None)
    checkpoint = args.run_dir / "last.pt"
    step = 0
    persisted_step = 0
    if checkpoint.exists():
        payload = torch.load(checkpoint, map_location="cpu", weights_only=True)
        if payload.get("runner", {}).get("input_identity") != identity or payload["runner"].get("world_size") != 1:
            raise ValueError("Existing checkpoint belongs to different probe inputs")
        model.load_state_dict(payload["model"], strict=True)
        optimizer.load_state_dict(payload["optimizer"])
        ema.load_state_dict(payload["ema"])
        scaler.load_state_dict(payload["scaler"])
        runner.restore_rng(torch, model, payload["rng_by_rank"][0])
        step = int(payload["step"])
        if step < 1 or step > steps:
            raise ValueError("Existing checkpoint step is outside probe bounds")
        events.latest_step = step
        persisted_step = step
        events.emit("checkpoint_resumed", checkpoint_step=step, checkpoint_bytes=checkpoint.stat().st_size)
        del payload
    trainable = [p for p in model.parameters() if p.requires_grad]
    if not trainable:
        raise RuntimeError("No teacher parameters are trainable")
    tracked = [(name, p) for name, p in model.named_parameters() if p.requires_grad and p.numel() <= 10000]
    if not tracked:
        raise RuntimeError("Could not select compact parameters for update verification")
    consecutive_overflow = 0
    while step < steps:
        if STOP_REQUESTED or (output / "CANCEL").exists():
            events.emit("paused", reason="owner_signal_or_cancel_file", last_checkpoint_step=persisted_step,
                        completed_updates_since_checkpoint=step - persisted_step)
            return 10
        started = time.monotonic()
        optimizer.zero_grad(set_to_none=True)
        lr = lr_at(step, args)
        for group in optimizer.param_groups:
            group["lr"] = lr * group.get("lr_scale", 1)
        prepared = []
        frames_total = shifted_total = 0
        for micro in range(2):
            if STOP_REQUESTED or (output / "CANCEL").exists():
                events.emit("paused", reason="owner_signal_between_microbatches", last_checkpoint_step=persisted_step,
                            completed_updates_since_checkpoint=step - persisted_step)
                return 10
            batch = loader.batch(step * 2 + micro)
            with torch.no_grad(), torch.autocast(device_type="cuda", enabled=False):
                latents, mask, voice, prompt_frames = runner.with_terminal_slot(encode_batch(mimi, batch, device))
            frames = int(mask.sum().item())
            shifted = int(torch.cat([mask[:, :1], mask[:, :-1]], dim=1).sum().item())
            prepared.append((batch, latents, mask, voice, prompt_frames, frames, shifted))
            frames_total += frames
            shifted_total += shifted
            events.emit("micro_encoded", optimizer_step=step + 1, micro=micro + 1, valid_frames=frames,
                        shifted_positions=shifted)
        if min(frames_total, shifted_total) < 1:
            raise RuntimeError("Actual audio produced an empty training target")
        metric_sums: dict[str, float] = {}
        pooled_weighted_loss = 0.0
        for micro, (batch, latents, mask, voice, prompt_frames, frames, shifted) in enumerate(prepared, 1):
            flow_weight, eos_weight = runner.pooled_objective_weights(
                frames, shifted, frames_total, shifted_total, 1, args.eos_loss_weight, distill=False)
            with runner.temporary_eos_weight(args, eos_weight), torch.autocast("cuda", dtype=torch.float16):
                loss, metrics = model(latents, mask, batch.text_tokens, voice,
                                      update_stats=False, num_voice_prompt_frames=prompt_frames)
            weighted_loss = loss * flow_weight
            if not bool(torch.isfinite(weighted_loss)):
                raise RuntimeError(f"Non-finite teacher loss at optimizer step {step + 1}, micro {micro}")
            pooled_weighted_loss += float(weighted_loss.detach().item())
            scaler.scale(weighted_loss).backward()
            for name, value in metrics.items():
                if value.numel() == 1 and bool(torch.isfinite(value)):
                    fraction = shifted / shifted_total if name in ("eos_loss", "distill_mse") else frames / frames_total
                    contribution = float(value.item()) * (flow_weight if name == "loss" else fraction)
                    metric_sums[name] = metric_sums.get(name, 0.0) + contribution
            events.emit("micro_backward", optimizer_step=step + 1, micro=micro,
                        weighted_loss=float(weighted_loss.detach().item()))
        scaler.unscale_(optimizer)
        norm = torch.nn.utils.clip_grad_norm_(trainable, args.optim.max_norm)
        if not bool(torch.isfinite(norm)):
            raise RuntimeError(f"Non-finite teacher gradient norm at step {step + 1}")
        if float(norm.item()) <= 0:
            raise RuntimeError(f"Zero teacher gradient norm at step {step + 1}")
        before = {name: p.detach().clone() for name, p in tracked} if step in (0, steps - 1) else None
        old_scale = scaler.get_scale()
        scaler.step(optimizer)
        scaler.update()
        if scaler.get_scale() < old_scale:
            consecutive_overflow += 1
            events.emit("optimizer_overflow", attempted_step=step + 1, loss_scale_before=old_scale,
                        loss_scale_after=scaler.get_scale(), consecutive_overflows=consecutive_overflow)
            if consecutive_overflow > 3:
                raise RuntimeError("Repeated FP16 overflow prevented a verified optimizer update")
            continue
        consecutive_overflow = 0
        if before is not None:
            max_delta = max(float((p.detach() - before[name]).abs().max().item()) for name, p in tracked)
            if not math.isfinite(max_delta) or max_delta <= 0:
                raise RuntimeError(f"Step {step + 1} had no detectable parameter update")
        else:
            max_delta = None
        ema.update(model)
        step += 1
        events.latest_step = step
        events.emit("optimizer_update", loss=pooled_weighted_loss,
                    diagnostic_subset_passes=step * 2 / loader.size,
                    epoch_number=(step * 2 - 1) // loader.size + 1,
                    metrics=metric_sums, gradient_norm_unscaled=float(norm.item()),
                    learning_rate=lr, loss_scale=scaler.get_scale(),
                    parameter_delta_max=max_delta, valid_frames=frames_total,
                    seconds_per_update=round(time.monotonic() - started, 3))
        if step == 1 or step % checkpoint_interval == 0 or step == steps:
            events.emit("checkpoint_begin", checkpoint_step=step)
            state["step"] = step
            runner.save_training(spec, "teacher", step, model, optimizer, ema, scaler,
                                 state, device, world=1, rank=0)
            persisted_step = step
            if step == 1 and remote_config is None:
                first = args.run_dir / "step000001.pt"
                if not first.exists():
                    with checkpoint.open("rb") as source, first.open("xb") as destination:
                        shutil.copyfileobj(source, destination, 4 * 1024 * 1024)
                        destination.flush()
                        os.fsync(destination.fileno())
            events.emit("checkpoint_complete", checkpoint_step=step,
                        checkpoint_bytes=checkpoint.stat().st_size,
                        checkpoint_sha256=sha256_file(checkpoint))
            if step in (1, steps):
                export_raw(root, output, step, model, mimi, events)
            if remote_config is not None:
                events.emit("remote_checkpoint_upload_begin", checkpoint_step=step)
                exports = {}
                export_dir = output / f"export-step{step:06d}"
                if export_dir.is_dir():
                    exports = {"export/" + p.name: str(p) for p in export_dir.iterdir() if p.is_file()}
                extra_path = output / "remote-exports.json"
                atomic_json(extra_path, exports)
                child_env = {**os.environ, "HF_HUB_OFFLINE": "0", "TRANSFORMERS_OFFLINE": "0",
                             "HF_HUB_DISABLE_PROGRESS_BARS": "1", "HF_HUB_DISABLE_TELEMETRY": "1"}
                # A separate exec process keeps the model loader offline and
                # prevents importing its CUDA context into the uploader.
                command = [sys.executable, "-u", str(root / "remote_checkpoints.py"),
                           "--checkpoint", str(checkpoint), "--step", str(step),
                           "--input-identity", identity, "--run-id", remote_config["run_id"],
                           "--state-dir", str(output / "remote-checkpoints"),
                           "--exports-json", str(extra_path)]
                child = subprocess.run(command, env=child_env, check=False)
                if child.returncode:
                    raise RuntimeError("Remote checkpoint is not verified; preserve the local saved model")
                events.emit("remote_checkpoint_verified", checkpoint_step=step)
            used = sum(p.stat().st_size for p in output.rglob("*") if p.is_file())
            if used >= MAX_OUTPUT_BYTES:
                raise RuntimeError("Probe artifacts exceeded the 18 GB publication budget")
    events.emit("completed", completed_updates=step, final_checkpoint_sha256=sha256_file(checkpoint),
                final_export_sha256=sha256_file(output / f"export-step{steps:06d}/model.safetensors"))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--steps", type=int, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    events = Events(args.output, args.steps)
    signal.signal(signal.SIGTERM, on_stop)
    signal.signal(signal.SIGINT, on_stop)
    events.emit("process_started", pid=os.getpid(), python=sys.version.split()[0])
    try:
        return run(args.root, args.output, args.steps, events)
    except Exception as exc:
        events.emit("failed", error_type=type(exc).__name__, message=str(exc),
                    traceback=traceback.format_exc(limit=8))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
