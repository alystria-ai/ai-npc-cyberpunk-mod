"""Bounded execution around the pinned official Pocket TTS training modules.

JSON specification paths are relative to the specification's directory. The
original manifests must contain relocatable audio paths relative to that same
directory. Only local model assets are accepted. Preparation writes relocated
copies under output_dir; input source/configuration/audio files are never edited.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import signal
import socket
import subprocess
import sys
import time
from typing import Any, Iterator
import uuid

PINNED_REVISION = "41cbc84af539ea78a804ffca5f9c6edc1a22ce44"
SCHEMA = 1
SESSION_LIMIT = 11 * 3600
QUOTA_LIMIT = 30 * 3600
SOURCE_IGNORES = {".git", "__pycache__", ".pytest_cache", ".ruff_cache"}
EXIT_PAUSED = 10
EXIT_PRECISION = 75
CALIBRATION_POLICY = {
    "stats_ema_steps": 0,
    "policy": "preserve_pretrained_latent_mean_and_std",
    "official_teacher_stats_ema_steps": 1000,
    "official_distill_stats_ema_steps": 0,
    "teacher_recipe_deviation": "finetune.yaml stats_ema_steps 1000 is overridden to 0",
    "rationale": "Upstream calibration updates run per forward. Micro batch 1 with accumulation 32 would apply gamma^32 per optimizer step and use rank-local means; freeze calibration to preserve released geometry and teacher-to-student transfer.",
}
OBJECTIVE_POLICY = {
    "policy": "official_pooled_frame_denominators",
    "teacher_flow": "global_valid_frames",
    "teacher_eos_and_student_regression": "global_shifted_mask_positions",
    "ddp_scale": "world_size_times_local_fraction",
    "extra_accumulation_divisor": False,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_digest(source: Path) -> str:
    """Content digest of a ZIP checkout; deliberately never calls Git."""
    digest = hashlib.sha256()
    paths = sorted(
        (p for p in source.rglob("*") if p.is_file() and not set(p.relative_to(source).parts) & SOURCE_IGNORES),
        key=lambda p: p.relative_to(source).as_posix(),
    )
    for path in paths:
        digest.update(path.relative_to(source).as_posix().encode("utf-8") + b"\0")
        digest.update(bytes.fromhex(sha256_file(path)) + b"\n")
    return digest.hexdigest()


def atomic_text(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temp.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(contents)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def atomic_json(path: Path, value: Any) -> None:
    atomic_text(path, json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8-sig"))


def rows_at(path: Path) -> list[dict[str, Any]]:
    rows = []
    with path.open(encoding="utf-8-sig") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                raise ValueError(f"Blank manifest row: {path.name}:{line_number}")
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid manifest JSON: {path.name}:{line_number}") from exc
            if not isinstance(value, dict):
                raise ValueError(f"Manifest row must be an object: {path.name}:{line_number}")
            rows.append(value)
    if not rows:
        raise ValueError(f"Empty manifest: {path}")
    return rows


def atomic_rows(path: Path, rows: list[dict[str, Any]]) -> None:
    atomic_text(path, "".join(json.dumps(r, ensure_ascii=False, allow_nan=False) + "\n" for r in rows))


def local_path(base: Path, value: str | Path, *, exists: bool = True) -> Path:
    text = str(value)
    if "://" in text or text.startswith("hf:"):
        raise ValueError("Every model/audio asset must be staged as a local file")
    path = Path(text).expanduser()
    path = (base / path).resolve() if not path.is_absolute() else path.resolve()
    if exists and not path.exists():
        raise FileNotFoundError(f"Required local asset is missing: {path}")
    return path


def stable_row_id(row: dict[str, Any]) -> str:
    return str(row.get("id", row.get("line_id", row.get("uid", f"{row['path']}@{float(row.get('start', 0))}"))))


def speaker_key(row: dict[str, Any]) -> str:
    for field in ("character", "speaker", "speaker_id", "character_id"):
        if row.get(field) is not None:
            return str(row[field])
    return "unknown"


def cast_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    result: dict[str, int] = {}
    for row in rows:
        key = speaker_key(row)
        result[key] = result.get(key, 0) + 1
    return dict(sorted(result.items()))


def valid_words(row: dict[str, Any], *, require_cut: bool = True) -> bool:
    words = row.get("words")
    if not isinstance(words, list) or len(words) < 2:
        return False
    previous = -1.0
    cuts = 0
    for i, word in enumerate(words):
        if not isinstance(word, dict) or not isinstance(word.get("word"), str):
            return False
        start, end = word.get("start"), word.get("end")
        if start is None or end is None:
            continue
        if not math.isfinite(float(start)) or not math.isfinite(float(end)):
            return False
        if float(start) < 0 or float(end) < float(start) or float(end) > float(row["duration"]) + 0.05:
            return False
        if float(start) + 0.02 < previous:
            return False
        previous = float(end)
        if i > 0 and words[i - 1].get("end") is not None:
            cut = (float(words[i - 1]["end"]) + float(start)) / 2
            if cut >= 1.0 and float(row["duration"]) - cut >= 1.0:
                cuts += 1
    return cuts > 0 if require_cut else previous >= 0


@dataclass
class Spec:
    path: Path
    raw: dict[str, Any]
    base: Path
    source: Path
    output: Path
    identity: str
    manifests: dict[str, Path]

    def asset(self, key: str) -> Path:
        return local_path(self.base, self.raw[key])

    def option(self, key: str, default: Any) -> Any:
        return self.raw.get(key, default)


def load_spec(path: Path, *, verify: bool = True, require_manifests: bool = True) -> Spec:
    path = path.resolve()
    raw = read_json(path)
    if not isinstance(raw, dict):
        raise ValueError("The runner specification must be a JSON object")
    if raw.get("source_revision") != PINNED_REVISION:
        raise ValueError(f"This runner supports only source revision {PINNED_REVISION}")
    base = path.parent
    source = local_path(base, raw["source_dir"])
    if not (source / "training/configs/finetune.yaml").is_file():
        raise ValueError("source_dir is not the official training ZIP root")
    recorded_digest = raw.get("source_digest")
    if not isinstance(recorded_digest, str) or len(recorded_digest) != 64:
        raise ValueError("The owner must provide the pinned ZIP's source_digest")
    if verify and source_digest(source) != recorded_digest:
        raise ValueError("Official source content digest does not match the owner's staged receipt")
    session = float(raw.get("session_budget_seconds", 39000))
    quota = float(raw.get("gpu_budget_seconds", QUOTA_LIMIT))
    if not 60 <= session <= SESSION_LIMIT or not 60 <= quota <= QUOTA_LIMIT:
        raise ValueError("session_budget_seconds must be <= 39600 and gpu_budget_seconds <= 108000")
    output = local_path(base, raw["output_dir"], exists=False)
    if output == base or source == output or output in source.parents or source in output.parents:
        raise ValueError("output_dir must be a separate runner-owned directory")
    manifest_keys = {"train": "train_manifest", "dev": "valid_manifest", "test": "test_manifest"}
    supplied = [key for key in manifest_keys.values() if raw.get(key)]
    if (require_manifests or supplied) and len(supplied) != 3:
        raise ValueError("Training/evaluation requires all three train, valid, and test manifest paths")
    manifests = {split: local_path(base, raw[key]) for split, key in manifest_keys.items() if raw.get(key)}
    identities: dict[str, Any] = {"source_revision": PINNED_REVISION, "source_digest": recorded_digest}
    for key in ("teacher_config", "student_config", "tokenizer", "reference_manifest"):
        asset = local_path(base, raw[key])
        identities[key] = sha256_file(asset)
    import yaml

    for key in ("teacher", "student"):
        config = yaml.safe_load(local_path(base, raw[f"{key}_config"]).read_text(encoding="utf-8-sig"))
        identities[f"{key}_weight_sha256"] = sha256_file(local_path(base, config["weights_path"]))
    identities.update({split: sha256_file(manifest) for split, manifest in manifests.items()})
    for key in ("teacher_max_epochs", "distill_max_epochs", "effective_batch_size", "seed", "student_init_from", "speaker_balanced_sampling",
                "teacher_max_steps", "distill_max_steps", "teacher_schedule_steps", "distill_schedule_steps",
                "teacher_ema_decay", "distill_ema_decay", "teacher_learning_rate", "distill_learning_rate",
                "teacher_warmup_steps", "distill_warmup_steps", "rollout_steps", "rollout_max_wer",
                "rollout_stop_after_step", "rollout_export_snapshots"):
        identities[key] = raw.get(key)
    for key in ("student_init_from", "import_teacher_checkpoint", "import_teacher_weights", "import_teacher_receipt"):
        if raw.get(key):
            identities[f"{key}_sha256"] = sha256_file(local_path(base, raw[key]))
    reference_data = read_json(local_path(base, raw["reference_manifest"]))
    reference_items = reference_data if isinstance(reference_data, list) else reference_data.get("references", reference_data.get("voices", []))
    if isinstance(reference_items, dict):
        reference_items = list(reference_items.values())
    identities["reference_audio"] = [sha256_file(local_path(base, r.get("path", r.get("reference", "")))) for r in reference_items]
    identity = hashlib.sha256(json.dumps(identities, sort_keys=True).encode()).hexdigest()
    return Spec(path, raw, base, source, output, identity, manifests)


def install_source(spec: Spec) -> None:
    # Do this before importing any upstream modules, including the public API.
    sys.path.insert(0, str(spec.source))
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")


def references(spec: Spec) -> list[dict[str, Any]]:
    raw = read_json(spec.asset("reference_manifest"))
    items = raw if isinstance(raw, list) else raw.get("references", raw.get("voices", []))
    if isinstance(items, dict):
        items = [{"id": key, **value} for key, value in items.items()]
    if not isinstance(items, list) or not items:
        raise ValueError("reference_manifest must contain a nonempty references list")
    result = []
    for index, item in enumerate(items):
        value = dict(item)
        value["id"] = str(value.get("id", value.get("character", f"reference-{index}")))
        if not all(c.isalnum() or c in "-_" for c in value["id"]):
            raise ValueError("Reference IDs may contain only letters, digits, hyphens, and underscores")
        value["path"] = str(local_path(spec.base, value.get("path", value.get("reference", ""))))
        texts = value.get("texts", [value.get("text", "My man, Dex DeShawn. How's that quiet life workin' out for you now, choom?")])
        if isinstance(texts, str):
            texts = [texts]
        if not texts or any(not isinstance(text, str) or not text.strip() for text in texts):
            raise ValueError("Every reference needs nonempty text(s)")
        value["texts"] = texts
        value["sha256"] = sha256_file(Path(value["path"]))
        result.append(value)
    if len({r["id"] for r in result}) != len(result):
        raise ValueError("Reference IDs must be unique")
    return result


def relocate_manifest(spec: Spec, split: str) -> list[dict[str, Any]]:
    rows = rows_at(spec.manifests[split])
    seen = set()
    for row in rows:
        duration = float(row["duration"])
        start = float(row.get("start", 0))
        if not math.isfinite(duration) or duration <= 0 or not math.isfinite(start) or start < 0:
            raise ValueError(f"Invalid duration/start in {split}")
        if not isinstance(row.get("transcript"), str) or not row["transcript"].strip():
            raise ValueError(f"Empty transcript in {split}")
        if duration > float(spec.option("max_utterance_seconds", 30)):
            raise ValueError(f"Utterance in {split} exceeds the bounded preparation/training window; split and align it before staging")
        path = local_path(spec.base, row["path"])
        key = (str(path), start)
        if key in seen:
            raise ValueError(f"Duplicate utterance in {split}")
        seen.add(key)
        row["path"] = str(path)
        # Never trust precomputed files supplied without this runner's codec/data receipt.
        row.pop("latents_file", None)
    return rows


def fence_splits(spec: Spec, rows: dict[str, list[dict[str, Any]]]) -> None:
    seen: dict[tuple[str, float], str] = {}
    files: dict[str, str] = {}
    identifiers: dict[str, str] = {}
    scenes: dict[str, str] = {}
    for split, entries in rows.items():
        for row in entries:
            key = (row["path"], float(row.get("start", 0)))
            if key in seen and seen[key] != split:
                raise ValueError(f"Audio leakage between {seen[key]} and {split}")
            seen[key] = split
            if row["path"] in files and files[row["path"]] != split:
                raise ValueError(f"Recording leakage between {files[row['path']]} and {split}")
            files[row["path"]] = split
            for field in ("id", "line_id", "uid"):
                if row.get(field) is not None:
                    identifier = f"{field}:{row[field]}"
                    if identifier in identifiers and identifiers[identifier] != split:
                        raise ValueError(f"Utterance ID leakage between {identifiers[identifier]} and {split}")
                    identifiers[identifier] = split
            scene = row.get("scene_id", row.get("scene"))
            if scene:
                scene = str(scene)
                if scene in scenes and scenes[scene] != split:
                    raise ValueError(f"Scene leakage between {scenes[scene]} and {split}")
                scenes[scene] = split
    for reference in references(spec):
        if any(path == reference["path"] for path, _ in seen):
            raise ValueError("A fenced conditioning reference appears in a training/evaluation manifest")


def resolve_inference_config(spec: Spec, kind: str, destination: Path) -> dict[str, Any]:
    import yaml

    raw = yaml.safe_load(spec.asset(f"{kind}_config").read_text(encoding="utf-8-sig"))
    expected_layers = 24 if kind == "teacher" else 6
    if raw["flow_lm"]["transformer"]["num_layers"] != expected_layers:
        raise ValueError(f"{kind} must use the official {expected_layers}-layer architecture")
    tokenizer = spec.asset("tokenizer")
    raw["flow_lm"]["lookup_table"]["tokenizer_path"] = str(tokenizer)
    raw["flow_lm"]["dtype"] = "float32"
    raw["mimi"]["dtype"] = "float32"
    # Root stages inference configurations with local weights. A path in a YAML
    # is interpreted relative to the bundle root, not to the YAML directory.
    for node in (raw, raw["flow_lm"], raw["mimi"]):
        for key in ("weights_path", "weights_path_without_voice_cloning"):
            if node.get(key):
                if key == "weights_path_without_voice_cloning":
                    node[key] = None
                else:
                    node[key] = str(local_path(spec.base, node[key]))
    if not raw.get("weights_path"):
        raise ValueError("Inference configs must name a local combined Pocket safetensors bundle")
    atomic_text(destination, yaml.safe_dump(raw, sort_keys=False))
    return raw


class Stop:
    def __init__(self, spec: Spec, deadline: float):
        self.spec, self.deadline = spec, deadline
        self.monotonic_deadline = time.monotonic() + max(0.0, deadline - time.time())
        self.signalled = False
        self.reason = ""
        for name in ("SIGTERM", "SIGINT", "SIGUSR1"):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), self._signal)

    def _signal(self, signum: int, frame: Any) -> None:
        self.signalled = True
        self.reason = "owner_signal"

    def requested(self) -> bool:
        if (self.spec.output / "CANCEL").exists():
            self.reason = "owner_cancel_file"
            return True
        if time.monotonic() >= self.monotonic_deadline:
            self.reason = "session_or_quota_bound"
            return True
        return self.signalled


def stage_state(spec: Spec, stage: str, **fields: Any) -> None:
    path = spec.output / stage / "state.json"
    previous = read_json(path, {})
    if stage in ("teacher", "distill"):
        fields["latent_calibration"] = CALIBRATION_POLICY
        fields["objective_weighting"] = OBJECTIVE_POLICY
    atomic_json(path, {**previous, "schema": SCHEMA, "input_identity": spec.identity,
                       "stage": stage, "updated_at": now_iso(), **fields})


def import_teacher(spec: Spec) -> None:
    """Verify and import a selected teacher, retaining its original provenance."""
    if not spec.raw.get("import_teacher_checkpoint"):
        return
    import torch
    import safetensors.torch
    import yaml

    checkpoint = spec.asset("import_teacher_checkpoint")
    weights = spec.asset("import_teacher_weights")
    receipt = read_json(spec.asset("import_teacher_receipt"))
    weight_hash = sha256_file(weights)
    if (receipt.get("source_revision") != PINNED_REVISION or receipt.get("weights") != "ema"
            or receipt.get("sample_cfg") != 2.0 or receipt.get("model_sha256") != weight_hash
            or type(receipt.get("selected_step")) is not int or receipt["selected_step"] < 1):
        raise ValueError("Imported teacher must be an intact selected EMA CFG2 export")
    config = yaml.safe_load((spec.output / "configs/teacher-inference.yaml").read_text())
    if sha256_file(Path(config["weights_path"])) != weight_hash:
        raise ValueError("Imported teacher differs from the staged teacher configuration")
    destination = spec.output / "teacher/best.pt"
    existing = read_json(destination.parent / "state.json", {})
    if existing.get("status") == "imported" and existing.get("input_identity") == spec.identity:
        origin = existing.get("origin", {})
        if (origin.get("source_weights_sha256") != weight_hash or not destination.is_file()
                or origin.get("imported_checkpoint_sha256") != sha256_file(destination)):
            raise ValueError("Previously imported teacher changed on resume")
        return
    payload = torch.load(checkpoint, map_location="cpu", weights_only=True)
    parent_identity = receipt.get("input_identity")
    if (payload.get("step") != receipt["selected_step"] or not parent_identity
            or payload.get("runner", {}).get("input_identity") != parent_identity
            or not payload.get("ema")):
        raise ValueError("Imported teacher checkpoint does not match its selected export")
    combined = {**payload["model"], **payload["ema"]}
    exported = safetensors.torch.load_file(str(weights))
    keys = [key for key in exported if key.startswith("flow_lm.")]
    if not keys or any(key not in combined or not torch.equal(combined[key].float(), exported[key].float()) for key in keys):
        raise ValueError("Imported teacher checkpoint tensors differ from the accepted export")
    origin = {"source_input_identity": parent_identity, "source_weights_sha256": weight_hash,
              "source_checkpoint_sha256": sha256_file(checkpoint), "selected_step": receipt["selected_step"]}
    payload["runner"] = {**payload["runner"], "input_identity": spec.identity, "imported_teacher": origin}
    destination.parent.mkdir(parents=True, exist_ok=True)
    atomic_torch_save(destination, payload, spec)
    origin["imported_checkpoint_sha256"] = sha256_file(destination)
    atomic_json(destination.parent / "best.json", {"step": payload["step"], "input_identity": spec.identity,
                "weights": "ema", "origin": origin, "metrics": payload["runner"].get("selection_metrics", {})})
    stage_state(spec, "teacher", status="imported", step=payload["step"], origin=origin)


def require_gpu() -> Any:
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("The actual runtime has no CUDA device; training is not authorized to run on CPU")
    torch.set_num_threads(2)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cuda.enable_cudnn_sdp(False)
    return torch


def hardware_receipt(torch: Any) -> dict[str, Any]:
    devices = []
    for i in range(torch.cuda.device_count()):
        prop = torch.cuda.get_device_properties(i)
        devices.append({"index": i, "name": prop.name, "total_memory_bytes": prop.total_memory,
                        "capability": [prop.major, prop.minor],
                        "native_bf16": prop.major >= 8})
    return {"torch": str(torch.__version__), "cuda_build": torch.version.cuda, "devices": devices,
            "device_count": len(devices), "source_revision": PINNED_REVISION}


def prepare(spec: Spec, stop: Stop) -> int:
    import yaml

    install_source(spec)
    torch = require_gpu()
    device = torch.device("cuda", 0)
    receipt = hardware_receipt(torch)
    atomic_json(spec.output / "hardware.json", receipt)
    data_dir = spec.output / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    config_dir = spec.output / "configs"
    config_dir.mkdir(parents=True, exist_ok=True)
    stage_state(spec, "prepare", status="running", pid=os.getpid())
    relocated = {split: relocate_manifest(spec, split) for split in spec.manifests}
    fence_splits(spec, relocated)
    teacher_config = resolve_inference_config(spec, "teacher", config_dir / "teacher-inference.yaml")
    student_config = resolve_inference_config(spec, "student", config_dir / "student-inference.yaml")
    teacher_arch = dict(teacher_config["flow_lm"]["transformer"])
    student_arch = dict(student_config["flow_lm"]["transformer"])
    teacher_arch.pop("num_layers")
    student_arch.pop("num_layers")
    teacher_flow = {k: v for k, v in teacher_config["flow_lm"].items() if k not in ("transformer", "weights_path")}
    student_flow = {k: v for k, v in student_config["flow_lm"].items() if k not in ("transformer", "weights_path")}
    teacher_codec = {k: v for k, v in teacher_config["mimi"].items() if k != "weights_path"}
    student_codec = {k: v for k, v in student_config["mimi"].items() if k != "weights_path"}
    if teacher_arch != student_arch or teacher_flow != student_flow or teacher_codec != student_codec:
        # weights_path fields inside Mimi may differ while the codec architecture
        # does not; official combined bundles do not set these separate paths.
        raise ValueError("Depth distillation requires identical teacher/student width and codec architecture")
    config_receipt = {"teacher_weight_sha256": sha256_file(Path(teacher_config["weights_path"])),
                      "student_weight_sha256": sha256_file(Path(student_config["weights_path"])),
                      "tokenizer_sha256": sha256_file(spec.asset("tokenizer"))}
    atomic_json(spec.output / "assets.json", config_receipt)
    import_teacher(spec)
    rejected = {}
    for split, entries in relocated.items():
        aligned, rejected[split] = align_entries(spec, split, entries, device, stop)
        if stop.requested():
            stage_state(spec, "prepare", status="paused", reason=stop.reason)
            return EXIT_PAUSED
        if not aligned:
            raise ValueError(f"No eligible aligned utterances remain in {split}")
        atomic_rows(data_dir / f"{split}.jsonl", aligned)
        if len(rejected[split]) / len(entries) > float(spec.option("max_alignment_reject_fraction", 0.25)):
            raise ValueError(f"Alignment rejected too much of {split}; inspect prepare/rejected.json before training")
    atomic_json(spec.output / "prepare" / "rejected.json", rejected)
    from training.modules.builders import load_model_config
    from training.scripts.precompute_latents import build_mimi
    import safetensors.torch

    config = load_model_config(str(config_dir / "teacher-inference.yaml"), {})
    mimi = build_mimi(config.mimi)
    # Deliberately do not use upstream load_frozen_mimi: it calls .compile().
    with safetensors.safe_open(str(config.weights_path), framework="pt", device="cpu") as bundle:
        codec = {k.removeprefix("mimi."): bundle.get_tensor(k) for k in bundle.keys() if k.startswith("mimi.")}
    mimi.load_state_dict(codec, strict=True)
    del codec
    mimi.eval().requires_grad_(False).to(device)
    if not any(p.detach().abs().max().item() > 0 for p in mimi.encoder.parameters()):
        raise ValueError("The staged teacher bundle has no voice-cloning encoder")
    if not precompute(spec, mimi, device, stop):
        stage_state(spec, "prepare", status="paused", reason=stop.reason)
        return EXIT_PAUSED
    counts = {split: len(rows_at(data_dir / f"{split}.jsonl")) for split in relocated}
    atomic_json(spec.output / "prepared.json", {"schema": SCHEMA, "input_identity": spec.identity,
                "counts": counts, "cast_counts": {split: cast_counts(rows_at(data_dir / f"{split}.jsonl")) for split in relocated},
                "assets": config_receipt, "source_digest": spec.raw["source_digest"],
                "completed_at": now_iso(), "alignment_dtype": "float32", "mimi_dtype": "float32",
                "compiled": False})
    stage_state(spec, "prepare", status="completed", counts=counts)
    return 0


def align_entries(spec: Spec, split: str, entries: list[dict[str, Any]], device: Any,
                  stop: Stop) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Official CTC trellis with local FP32 inference and atomic row cache."""
    import torch
    from training.scripts.align_data import batched_word_spans, case_fold_for, _tokens_for
    from training.dataloader.audio import _load_window
    import re

    cache = spec.output / "prepare" / f"{split}-alignments.json"
    saved = read_json(cache, {"input_identity": spec.identity, "rows": {}, "rejected": {}})
    if saved.get("input_identity") != spec.identity:
        raise ValueError("Alignment cache belongs to different inputs")
    known, bad = saved["rows"], saved["rejected"]
    for row in entries:
        key = stable_row_id(row)
        if valid_words(row):
            known[key] = row["words"]
    pending = [r for r in entries if stable_row_id(r) not in known and stable_row_id(r) not in bad]
    if pending:
        if not spec.raw.get("align_model_dir"):
            raise ValueError("Unaligned input rows require a staged local align_model_dir; no model will be downloaded")
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

        asset = spec.asset("align_model_dir")
        processor = Wav2Vec2Processor.from_pretrained(str(asset), local_files_only=True)
        ctc = Wav2Vec2ForCTC.from_pretrained(str(asset), local_files_only=True).float().to(device).eval()
        vocab = processor.tokenizer.get_vocab()
        blank = processor.tokenizer.pad_token_id
        delim = vocab[processor.tokenizer.word_delimiter_token]
        fold = case_fold_for(vocab)
        sample_rate = processor.feature_extractor.sampling_rate
        batch_size = max(1, min(4, int(spec.option("align_batch_size", 2))))
        order = sorted(pending, key=lambda row: float(row["duration"]))
        for offset in range(0, len(order), batch_size):
            if stop.requested():
                break
            chunk = order[offset:offset + batch_size]
            loaded = []
            for row in chunk:
                key = stable_row_id(row)
                words = row["transcript"].split()
                normalized = ["".join(c for c in fold(re.sub(r"[^\w']", "", w)) if c in vocab) for w in words]
                if not any(normalized):
                    bad[key] = "no_ctc_vocabulary_characters"
                    continue
                tokens, word_of = _tokens_for([w for w in normalized if w], vocab, delim)
                try:
                    wav = _load_window(row["path"], float(row.get("start", 0)), float(row["duration"]), sample_rate)
                except Exception:
                    bad[key] = "audio_decode_failed"
                    continue
                if not len(wav) or not torch.isfinite(torch.from_numpy(wav)).all():
                    bad[key] = "invalid_audio"
                    continue
                loaded.append((row, words, normalized, tokens, word_of, wav))
            if loaded:
                lens = [len(item[-1]) for item in loaded]
                audio = torch.zeros(len(loaded), max(lens), dtype=torch.float32)
                for i, item in enumerate(loaded):
                    audio[i, :lens[i]] = torch.from_numpy(item[-1])
                attention = (torch.arange(max(lens))[None] < torch.tensor(lens)[:, None]).long()
                with torch.no_grad(), torch.autocast(device_type=device.type, enabled=False):
                    logits = ctc(audio.to(device), attention_mask=attention.to(device)).logits.float()
                    if not torch.isfinite(logits).all():
                        raise RuntimeError("CTC model produced non-finite FP32 logits")
                    lengths = torch.tensor([int(ctc._get_feat_extract_output_lengths(n)) for n in lens], device=device)
                    spans = batched_word_spans(logits.log_softmax(-1), lengths,
                            [item[3] for item in loaded], [item[4] for item in loaded], blank)
                for item, item_spans, frame_count in zip(loaded, spans, lengths.tolist(), strict=True):
                    row, words, normalized, _, _, wav = item
                    key = stable_row_id(row)
                    if item_spans is None:
                        bad[key] = "ctc_alignment_failed"
                        continue
                    seconds = len(wav) / sample_rate / frame_count
                    timed, j = [], 0
                    for word, norm in zip(words, normalized, strict=True):
                        span = item_spans[j] if norm else None
                        if norm:
                            j += 1
                        timed.append({"word": word, "start": None if span is None else round(span[0] * seconds, 3),
                                      "end": None if span is None else round((span[1] + 1) * seconds, 3)})
                    if valid_words({**row, "words": timed}):
                        known[key] = timed
                    else:
                        bad[key] = "no_safe_disjoint_prompt_target_cut"
            atomic_json(cache, saved)
            stage_state(spec, "prepare", status="running", split=split,
                        aligned=len(known), rejected=len(bad), pending=len(pending) - offset - len(chunk))
        del ctc, processor
        gc.collect()
        torch.cuda.empty_cache()
    atomic_json(cache, saved)
    accepted = [{**row, "words": known[stable_row_id(row)]} for row in entries if stable_row_id(row) in known]
    rejected = [{"id": stable_row_id(row), "reason": bad[stable_row_id(row)]} for row in entries if stable_row_id(row) in bad]
    return accepted, rejected


def precompute(spec: Spec, mimi: Any, device: Any, stop: Stop) -> bool:
    import torch
    import safetensors.torch
    from training.scripts.precompute_latents import mimi_encode_hash, measure_stitch_frames, _decode_chunk, _entry_frames

    manifest = spec.output / "data/train.jsonl"
    rows = rows_at(manifest)
    codec_hash = mimi_encode_hash(mimi)
    # Also key by corpus contents: the official codec-only + row-index layout
    # would silently reuse another utterance's latents after a manifest reorder.
    data_hash = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
    tag = f"{codec_hash[:12]}-{data_hash[:12]}"
    folder = manifest.parent / "latents" / tag
    folder.mkdir(parents=True, exist_ok=True)
    metadata = read_json(folder / "calibration.json")
    if metadata is None:
        longest = max(rows, key=lambda row: float(row["duration"]))
        arr, _ = _decode_chunk([(longest["path"], float(longest.get("start", 0)), float(longest["duration"]), mimi.sample_rate)])
        length = arr.shape[-1] - arr.shape[-1] % mimi.frame_size
        if length < mimi.frame_size * 8:
            raise ValueError("Corpus has no utterance long enough for official stitch calibration")
        with torch.no_grad(), torch.autocast(device_type=device.type, enabled=False):
            stitch, floor = measure_stitch_frames(mimi, torch.from_numpy(arr[..., :length]).to(device))
        if not math.isfinite(floor) or stitch < 1:
            raise RuntimeError("Invalid codec stitch calibration")
        metadata = {"stitch_frames": stitch, "noise_floor": floor}
        atomic_json(folder / "calibration.json", metadata)
    batch_size = max(1, min(4, int(spec.option("precompute_batch_size", 2))))
    order = sorted(range(len(rows)), key=lambda i: float(rows[i]["duration"]))
    for offset in range(0, len(order), batch_size):
        if stop.requested():
            return False
        indices = [i for i in order[offset:offset + batch_size] if not (folder / f"train_{i:08d}.safetensors").is_file()]
        if not indices:
            continue
        jobs = [(rows[i]["path"], float(rows[i].get("start", 0)), float(rows[i]["duration"]), mimi.sample_rate) for i in indices]
        arr, lengths = _decode_chunk(jobs)
        with torch.no_grad(), torch.autocast(device_type=device.type, enabled=False):
            latents = mimi.encode_to_latent(torch.from_numpy(arr).to(device)).float().cpu()
        if not torch.isfinite(latents).all():
            raise RuntimeError("Non-finite precomputed codec latents")
        for index, latent, length in zip(indices, latents, lengths, strict=True):
            frames = min(_entry_frames(length, mimi.sample_rate, mimi.frame_rate), latent.shape[0])
            destination = folder / f"train_{index:08d}.safetensors"
            temp = destination.with_suffix(f".tmp.{os.getpid()}")
            safetensors.torch.save_file({"latents": latent[:frames].contiguous()}, str(temp))
            os.replace(temp, destination)
        stage_state(spec, "prepare", status="running", phase="precompute", encoded=offset + len(indices), total=len(rows))
    annotated = [{**row, "latents_file": f"latents/{tag}/train_{i:08d}.safetensors"} for i, row in enumerate(rows)]
    atomic_rows(manifest.with_name("train_latents.jsonl"), annotated)
    atomic_json(manifest.with_name("train_latents.meta.json"), {**metadata, "mimi_hash": codec_hash,
                "manifest_hash": data_hash, "frame_rate": mimi.frame_rate,
                "weights_path": str(spec.output / "configs/teacher-inference.yaml")})
    return True


def install_fp32_reductions(model: Any) -> None:
    """Keep official forward/loss semantics while promoting sensitive reductions.

    The official generic FP32 island casts inputs and disables autocast, but
    stock LSD does not enable it (only Drifting does). Enable it for LSD.
    out_norm
    hooks promote the teacher/student activations before CFG subtraction and
    squared regression; EOS hooks promote logits before softplus/sum. Casting
    preserves autograd and does not change any parameter or state_dict key.
    """
    def promote(module: Any, inputs: Any, output: Any) -> Any:
        return output.float()

    if model.args.flow.type != "lsd":
        raise ValueError("This runner requires the official LSD objective")
    model.flow.fp32_loss = True
    for flow_lm in (model.flow_lm, model.distill_teacher):
        if flow_lm is not None:
            flow_lm.out_norm.register_forward_hook(promote)
            flow_lm.out_eos.register_forward_hook(promote)


def with_terminal_slot(encoded: tuple[Any, Any, Any, Any]) -> tuple[Any, Any, Any, Any]:
    """Ensure the official shifted mask includes one EOS target on every row.

    Precomputed batches with one row otherwise often have T == target frames.
    The official EOS objective marks the first invalid position; without a
    terminal slot these batches contain no positive EOS label. A zero, masked
    target slot adds that state while leaving all flow targets untouched. The
    teacher-forced backbone input at it is the last real latent, not this zero.
    """
    import torch

    latents, mask, voice, frames = encoded
    if mask.shape[1] == 0 or not bool(mask.any(dim=1).all()):
        raise ValueError("Every target row must contain at least one valid audio frame")
    if bool(mask[:, -1].any()):
        latents = torch.cat([latents, latents.new_zeros(latents.shape[0], 1, latents.shape[2])], dim=1)
        mask = torch.cat([mask, mask.new_zeros(mask.shape[0], 1)], dim=1)
    return latents, mask, voice, frames


class IndexedBatches:
    """Official sample/collate with deterministic coverage and exact step resume.

    A global sample index identifies both the epoch permutation and prompt-cut
    RNG. Unlike upstream's asynchronous infinite iterator, no loader cursor is
    lost on preemption and no heldout loop repeats an incomplete last batch.
    """
    def __init__(self, args: Any, model: Any, mimi: Any, *, balanced: bool = False):
        from training.dataloader import DataLoader

        self.args = args
        self.loader = DataLoader(args.data.train_jsonl, model.flow_lm.conditioner.tokenizer.encode,
            args.batch_size, mimi.sample_rate, mimi.frame_rate, args.data.max_duration_sec,
            args.data.max_voice_prompt_sec, 0, 1, seed=args.seed, shuffle=False,
            io_workers=1, num_bucket_batches=1, prompt_trim_max_sec=args.data.prompt_trim_max_sec,
            final_punct_dropout=args.data.final_punct_dropout)
        self.size = len(self.loader.entries)
        self.epoch, self.order = -1, []
        self.balanced = balanced
        self.speakers: dict[str, list[int]] = {}
        self.speaker_orders: dict[str, tuple[int, list[int]]] = {}
        self.speaker_round = -1
        self.speaker_round_order: list[str] = []
        if balanced:
            for i, row in enumerate(rows_at(Path(args.data.train_jsonl))):
                speaker = speaker_key(row)
                self.speakers.setdefault(speaker, []).append(i)
            if "unknown" in self.speakers and len(self.speakers) > 1:
                raise ValueError("Balanced sampling requires speaker metadata on every training row")
            self.speaker_names = sorted(self.speakers)

    def batch(self, global_start: int) -> Any:
        samples = []
        for global_index in range(global_start, global_start + self.args.batch_size):
            if self.balanced:
                draw, speaker_index = divmod(global_index, len(self.speaker_names))
                if draw != self.speaker_round:
                    self.speaker_round_order = list(self.speaker_names)
                    random.Random(self.args.seed + 104729 * draw).shuffle(self.speaker_round_order)
                    self.speaker_round = draw
                # Shuffling each cast round avoids permanently assigning the
                # same speakers to one rank when cast count divides world size.
                speaker = self.speaker_round_order[speaker_index]
                epoch, within = divmod(draw, len(self.speakers[speaker]))
                if speaker not in self.speaker_orders or self.speaker_orders[speaker][0] != epoch:
                    order = list(self.speakers[speaker])
                    speaker_seed = int(hashlib.sha256(speaker.encode()).hexdigest()[:8], 16)
                    random.Random(self.args.seed + speaker_seed + epoch).shuffle(order)
                    self.speaker_orders[speaker] = (epoch, order)
                index = self.speaker_orders[speaker][1][within]
            else:
                epoch, within = divmod(global_index, self.size)
                if epoch != self.epoch:
                    self.order = list(range(self.size))
                    random.Random(self.args.seed + epoch).shuffle(self.order)
                    self.epoch = epoch
                index = self.order[within]
            self.loader.rng.seed(self.args.seed + 104729 * global_index)
            entry = self.loader.get_entry(index)
            # Fail an unreadable entry; silently skipping changes coverage/resume.
            samples.append(self.loader._sample(entry))
        return self.loader._collate(samples)


def capture_rng(torch: Any, model: Any) -> dict[str, Any]:
    result = {"cpu": torch.get_rng_state(), "cuda": torch.cuda.get_rng_state() if torch.cuda.is_available() else None,
              "python": random.getstate()}
    if hasattr(model.flow, "_skip_rng"):
        result["lsd_skip"] = model.flow._skip_rng.get_state()
    return result


def restore_rng(torch: Any, model: Any, state: dict[str, Any]) -> None:
    torch.set_rng_state(state["cpu"])
    if state.get("cuda") is not None:
        torch.cuda.set_rng_state(state["cuda"])
    random.setstate(state["python"])
    if "lsd_skip" in state:
        model.flow._skip_rng.set_state(state["lsd_skip"])


@contextmanager
def ema_weights(model: Any, ema: Any) -> Iterator[None]:
    import torch

    named = dict(model.named_parameters())
    original = {}
    if ema is not None:
        with torch.no_grad():
            for name, shadow in ema.shadow.items():
                if name in named:
                    # Host copies avoid a second full teacher on a 15 GiB T4.
                    original[name] = named[name].detach().cpu().clone()
                    named[name].copy_(shadow)
    try:
        yield
    finally:
        if original:
            with torch.no_grad():
                for name, parameter in original.items():
                    named[name].copy_(parameter.to(named[name].device))


def distributed_any(torch: Any, value: bool, device: Any, world: int) -> bool:
    flag = torch.tensor(int(value), device=device)
    if world > 1:
        torch.distributed.all_reduce(flag, op=torch.distributed.ReduceOp.MAX)
    return bool(flag.item())


def cpu_tree(value: Any, torch: Any) -> Any:
    if torch.is_tensor(value):
        return value.detach().cpu()
    if isinstance(value, dict):
        return {k: cpu_tree(v, torch) for k, v in value.items()}
    if isinstance(value, list):
        return [cpu_tree(v, torch) for v in value]
    if isinstance(value, tuple):
        return tuple(cpu_tree(v, torch) for v in value)
    return value


def tensor_bytes(value: Any, torch: Any) -> int:
    if torch.is_tensor(value):
        return value.numel() * value.element_size()
    if isinstance(value, dict):
        return sum(tensor_bytes(v, torch) for v in value.values())
    if isinstance(value, (list, tuple)):
        return sum(tensor_bytes(v, torch) for v in value)
    return 0


def atomic_torch_save(path: Path, payload: dict[str, Any], spec: Spec) -> None:
    import torch

    size = tensor_bytes(payload, torch)
    limit = float(spec.option("max_output_gib", 18)) * 1024 ** 3
    if not 8 <= limit / 1024 ** 3 <= 20:
        raise ValueError("max_output_gib must be between 8 and 20")
    used = sum(p.stat().st_size for p in spec.output.rglob("*") if p.is_file())
    if used + size * 1.05 > limit:
        raise RuntimeError("Checkpoint would exceed the output disk bound; retain results and increase space before resuming")
    if shutil.disk_usage(path.parent).free < size * 1.1 + 256 * 1024 ** 2:
        raise RuntimeError("Insufficient free space for an atomic checkpoint")
    for name, tensor in payload.get("model", {}).items():
        if tensor.is_floating_point() and not torch.isfinite(tensor).all():
            raise RuntimeError(f"Refusing to checkpoint a non-finite model tensor: {name}")
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temp.open("wb") as stream:
            torch.save(payload, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def save_training(spec: Spec, stage: str, step: int, model: Any, optimizer: Any, ema: Any,
                  scaler: Any, runner: dict[str, Any], device: Any, world: int, rank: int) -> None:
    import torch

    rng = capture_rng(torch, model)
    all_rng = [None] * world
    if world > 1:
        torch.distributed.all_gather_object(all_rng, rng)
    else:
        all_rng[0] = rng
    if rank == 0:
        path = spec.output / stage / "last.pt"
        payload = {"step": step, "model": cpu_tree(model.state_dict(), torch),
                   "ema": cpu_tree(ema.state_dict(), torch) if ema else None,
                   "optimizer": cpu_tree(optimizer.state_dict(), torch),
                   "scaler": scaler.state_dict(), "rng_by_rank": all_rng,
                   "runner": {**runner, "schema": SCHEMA, "input_identity": spec.identity,
                              "world_size": world}}
        atomic_torch_save(path, payload, spec)
        stage_state(spec, stage, checkpoint="last.pt", checkpoint_step=step,
                    checkpoint_bytes=path.stat().st_size, **runner)
        del payload
    if world > 1:
        torch.distributed.barrier()


def save_best(spec: Spec, stage: str, step: int, model: Any, ema: Any, metrics: dict[str, Any]) -> None:
    import torch

    payload = {"step": step, "model": cpu_tree(model.state_dict(), torch),
               "ema": cpu_tree(ema.state_dict(), torch) if ema else None,
               "runner": {"schema": SCHEMA, "input_identity": spec.identity,
                          "selection_metrics": metrics, "selection_weights": "ema"}}
    atomic_torch_save(spec.output / stage / "best.pt", payload, spec)
    atomic_json(spec.output / stage / "best.json", {"step": step, "metrics": metrics,
                "input_identity": spec.identity, "weights": "ema", "selected_at": now_iso()})


def run_rollout_checks(spec: Spec, model: Any, mimi: Any, ema: Any, device: Any,
                       step: int, stop: Stop, rank: int, world: int) -> dict[str, Any] | None:
    """Check free generation at declared steps; MSE alone cannot qualify speech."""
    if step not in spec.option("rollout_steps", []):
        return None
    import torch
    from pocket_training.rollout import evaluate_rollout
    from training.checkpointing import export_pocket_safetensors

    summary = None
    failed = False
    if rank == 0:
        try:
            summary = {"step": step, "candidates": [], "input_identity": spec.identity}
            previous_kind = spec.raw.get("rollout_weight_kind")
            try:
                for kind in (["ema"] if step == 0 else ["ema", "raw"]):
                    spec.raw["rollout_weight_kind"] = kind
                    with (ema_weights(model, ema) if kind == "ema" else nullcontext()):
                        result = evaluate_rollout(spec, model, mimi, device, step, stop)
                        aggregate = result["aggregate"]
                        summary["candidates"].append({"weights": kind, "score": result["score"],
                            "diagnostic_failure": result["diagnostic_failure"], "aggregate": aggregate})
                        if stop.requested():
                            break
                        eligible = (step > 0 and result["status"] == "completed" and not result["diagnostic_failure"]
                                    and aggregate["natural_eos_samples"] >= 2 and result["score"] is not None
                                    and result["score"] <= float(spec.option("rollout_max_wer", 0.5)))
                        if not eligible:
                            continue
                        selected = speech_selection(spec)
                        # ASR is noisy. Equivalent completeness prefers the
                        # later adapted EMA; keep every snapshot for listening.
                        old_score = selected.get("score", float("inf"))
                        better = result["score"] < old_score - 0.025
                        tied = abs(result["score"] - old_score) <= 0.025
                        prefer = tied and (kind == "ema" and (step >= selected.get("step", 0)))
                        if bool(spec.option("rollout_export_snapshots", False)):
                            export = spec.output / f"comparisons/rollout-step{step:06d}-{kind}/model.safetensors"
                            export_pocket_safetensors(export, model.flow_lm, mimi)
                        if not selected or better or prefer:
                            checkpoint = spec.output / "distill/speech-best.pt"
                            checkpoint.parent.mkdir(parents=True, exist_ok=True)
                            payload = {"step": step, "model": cpu_tree(model.state_dict(), torch), "ema": None,
                                "runner": {"schema": SCHEMA, "input_identity": spec.identity,
                                    "selection_weights": kind, "selection_metrics": result,
                                    "validated_probe_count": aggregate["natural_eos_samples"]}}
                            atomic_torch_save(checkpoint, payload, spec)
                            atomic_json(checkpoint.with_suffix(".json"), {"step": step, "weights": kind,
                                "score": result["score"], "input_identity": spec.identity,
                                "checkpoint_sha256": sha256_file(checkpoint), "asr_tentative": True,
                                "listening_qualified": False})
            finally:
                if previous_kind is None:
                    spec.raw.pop("rollout_weight_kind", None)
                else:
                    spec.raw["rollout_weight_kind"] = previous_kind
            best = speech_selection(spec)
            summary["has_speech_candidate"] = bool(best)
            summary["best"] = best
            atomic_json(spec.output / "distill/rollout-state.json", summary)
        except Exception as exc:
            failed = True
            atomic_json(spec.output / "distill/rollout-error.json", {"step": step, "type": type(exc).__name__, "message": str(exc)[:1000]})
    if distributed_any(torch, failed, device, world):
        raise RuntimeError("Generated speech check failed; inspect distill/rollout-error.json")
    if world > 1:
        values = [summary]
        torch.distributed.broadcast_object_list(values, src=0)
        summary = values[0]
    return summary


def speech_selection(spec: Spec) -> dict[str, Any]:
    checkpoint = spec.output / "distill/speech-best.pt"
    receipt = read_json(checkpoint.with_suffix(".json"), {})
    if not receipt and not checkpoint.exists():
        return {}
    if (not receipt or receipt.get("input_identity") != spec.identity or not checkpoint.is_file()
            or receipt.get("checkpoint_sha256") != sha256_file(checkpoint)):
        raise ValueError("Generated speech checkpoint differs from its exact run/selection receipt")
    return receipt


def selected_checkpoint(spec: Spec, stage: str) -> Path:
    speech = spec.output / stage / "speech-best.pt"
    if stage == "distill" and speech.is_file():
        speech_selection(spec)
    # With generation checks enabled, rejected speech must never fall back to
    # the teacher-forced checkpoint that happened to minimize latent MSE.
    return speech if stage == "distill" and (speech.is_file() or spec.option("rollout_steps", [])) else spec.output / stage / "best.pt"


def fixed_validation_indices(rows: list[dict[str, Any]], maximum: int, seed: int) -> list[int]:
    # Deterministic round-robin coverage across cast, then hash order within cast.
    groups: dict[str, list[int]] = {}
    for i, row in enumerate(rows):
        group = speaker_key(row)
        groups.setdefault(group, []).append(i)
    for indices in groups.values():
        indices.sort(key=lambda i: hashlib.sha256(f"{seed}:{stable_row_id(rows[i])}".encode()).hexdigest())
    ordered = []
    for offset in range(max(map(len, groups.values()))):
        ordered.extend(indices[offset] for _, indices in sorted(groups.items()) if offset < len(indices))
    if maximum > 0:
        maximum = max(maximum, len(groups))
        ordered = ordered[:maximum]
    return sorted(ordered)


def validate(spec: Spec, model: Any, mimi: Any, args: Any, device: Any, rank: int, world: int,
             stop: Stop, *, split: str = "dev") -> dict[str, Any] | None:
    import torch
    from training.dataloader import DataLoader, encode_batch

    rows = rows_at(spec.output / f"data/{split}.jsonl")
    limit = int(spec.option("max_valid_samples", 128)) if split == "dev" else 0
    indices = fixed_validation_indices(rows, limit, args.seed)
    loader = DataLoader(str(spec.output / f"data/{split}.jsonl"), model.flow_lm.conditioner.tokenizer.encode,
             1, mimi.sample_rate, mimi.frame_rate, args.data.max_duration_sec,
             args.data.max_voice_prompt_sec, 0, 1, seed=args.seed, shuffle=False, io_workers=1,
             prompt_trim_max_sec=0, final_punct_dropout=0)
    saved_rng = capture_rng(torch, model)
    was_training = model.training
    model.eval()
    totals: dict[str, float] = {}
    count = 0
    failed = False
    try:
        # Every rank executes the same number of stop collectives; an uneven
        # heldout shard cannot leave a rank waiting in an allreduce.
        for offset in range(0, len(indices), world):
            if distributed_any(torch, stop.requested(), device, world):
                failed = True
                break
            location = offset + rank
            if location >= len(indices):
                continue
            index = indices[location]
            loader.rng.seed(args.seed + 1009 * index)
            torch.manual_seed(args.seed + 8191 * index)
            batch = loader._collate([loader._sample(loader.get_entry(index))])
            with torch.no_grad(), torch.autocast(device_type=device.type, enabled=False):
                latents, mask, voice, frames = with_terminal_slot(encode_batch(mimi, batch, device))
                loss, metrics = model(latents, mask, batch.text_tokens, voice,
                                      num_voice_prompt_frames=frames)
            if not bool(torch.isfinite(loss)):
                raise RuntimeError("Non-finite fixed heldout loss")
            for name, value in metrics.items():
                if torch.is_tensor(value) and value.numel() == 1:
                    scalar = float(value.item())
                    if not math.isfinite(scalar):
                        raise RuntimeError("Non-finite heldout metric")
                    totals[name] = totals.get(name, 0) + scalar
            count += 1
    finally:
        restore_rng(torch, model, saved_rng)
        model.train(was_training)
    if failed:
        return None
    names = ["loss", "distill_mse"] if model.distill_teacher is not None else ["loss", "flow_loss", "flow_diag", "flow_distill", "eos_loss"]
    values = torch.tensor([count] + [totals.get(n, 0) for n in names], dtype=torch.float64, device=device)
    if world > 1:
        torch.distributed.all_reduce(values)
    actual = int(values[0].item())
    if actual != len(indices):
        raise RuntimeError("Fixed heldout enumeration lost or repeated samples")
    averaged = {name: float(values[i + 1].item() / actual) for i, name in enumerate(names)}
    if model.distill_teacher is not None:
        score = averaged["distill_mse"]
        selection = "ema_fixed_dev_cfg2_backbone_mse"
    else:
        # The learned log-variance weighting can improve loss by itself. Select
        # teachers on unweighted diagnostics with exactly repeatable noises.
        score = (model.flow.p_equal * averaged["flow_diag"] + (1 - model.flow.p_equal) * averaged["flow_distill"]) / model.ldim + args.eos_loss_weight * averaged["eos_loss"]
        selection = "ema_fixed_dev_unweighted_lsd_plus_eos"
    return {**averaged, "score": score, "samples": actual, "eligible_samples": len(rows),
            "sample_ids_sha256": hashlib.sha256(json.dumps([stable_row_id(rows[i]) for i in indices]).encode()).hexdigest(),
            "selection": selection, "split": split, "precision": "float32", "prompt_augmentation": False}


def choose_precision(torch: Any, requested: str, device: Any) -> str:
    capability = torch.cuda.get_device_capability(device)
    if requested == "auto":
        return "bf16" if capability[0] >= 8 else "fp16"
    if requested == "bf16" and capability[0] < 8:
        raise ValueError("Actual hardware lacks native BF16; select auto, fp16, or fp32")
    return requested


def autocast_for(torch: Any, mode: str, device: Any) -> Any:
    return torch.autocast(device_type=device.type,
            dtype=torch.bfloat16 if mode == "bf16" else torch.float16,
            enabled=mode != "fp32")


@contextmanager
def force_complete_lsd_probe(model: Any) -> Iterator[bool]:
    """Exercise both diagonal and JVP terms, independent of the skip RNG."""
    required = model.distill_teacher is None
    original = model.flow.distill_prob
    try:
        if required:
            model.flow.distill_prob = 1.0
        yield required
    finally:
        model.flow.distill_prob = original


def pooled_objective_weights(local_frames: int, local_shifted: int, global_frames: int,
                             global_shifted: int, world: int, eos_weight: float,
                             *, distill: bool) -> tuple[float, float]:
    """Scale local means so DDP averaging gives the original pooled objective."""
    if min(local_frames, local_shifted, global_frames, global_shifted, world) < 1:
        raise ValueError("Pooled objective denominators must all be positive")
    if distill:
        return world * local_shifted / global_shifted, eos_weight
    flow_fraction = local_frames / global_frames
    eos_fraction = local_shifted / global_shifted
    return world * flow_fraction, eos_weight * eos_fraction / flow_fraction


@contextmanager
def temporary_eos_weight(args: Any, weight: float) -> Iterator[None]:
    original = args.eos_loss_weight
    try:
        args.eos_loss_weight = weight
        yield
    finally:
        args.eos_loss_weight = original


def precision_probe(spec: Spec, model: Any, mimi: Any, optimizer: Any, batch: Any,
                    mode: str, device: Any) -> dict[str, Any]:
    import torch
    from training.dataloader import encode_batch

    rng = capture_rng(torch, model)
    saved = {k: v.clone() for k, v in model.named_buffers()}
    record: dict[str, Any] = {"requested_precision": mode, "source": "actual_model_forward_backward",
                              "master_dtype": "float32", "loss_reductions": "float32",
                              "forced_lsd_jvp": model.distill_teacher is None,
                              "original_lsd_distill_probability": model.flow.distill_prob,
                              "jvp_metrics_verified_by_precision": {}}
    results = []
    modes = ["fp32"] if mode == "fp32" else ["fp32", mode]
    try:
        with torch.no_grad(), torch.autocast(device_type=device.type, enabled=False):
            encoded = with_terminal_slot(encode_batch(mimi, batch, device))
        latents, mask, voice, frames = encoded
        with force_complete_lsd_probe(model) as jvp_required:
            for precision in modes:
                restore_rng(torch, model, rng)
                optimizer.zero_grad(set_to_none=True)
                scaler = torch.amp.GradScaler("cuda", enabled=precision == "fp16", init_scale=128)
                with autocast_for(torch, precision, device):
                    loss, metrics = model(latents, mask, batch.text_tokens, voice, update_stats=False,
                                          num_voice_prompt_frames=frames)
                if jvp_required:
                    for metric in ("flow_diag", "flow_distill"):
                        if metric not in metrics or not bool(torch.isfinite(metrics[metric]).all()):
                            raise RuntimeError("Teacher precision probe did not execute finite diagonal and JVP terms")
                    record["jvp_metrics_verified_by_precision"][precision] = True
                if loss.dtype != torch.float32 or not bool(torch.isfinite(loss)):
                    raise RuntimeError("Probe loss is not finite FP32")
                scaler.scale(loss).backward()
                scaler.unscale_(optimizer)
                norm = torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], float("inf"))
                if not bool(torch.isfinite(norm)):
                    raise RuntimeError("Probe gradients are non-finite")
                samples = {}
                for name, param in model.named_parameters():
                    if param.requires_grad and param.grad is not None:
                        grad = param.grad.detach().float().flatten()
                        stride = max(1, grad.numel() // 256)
                        samples[name] = grad[::stride][:256].cpu().clone()
                if not samples:
                    raise RuntimeError("Probe produced no trainable gradients")
                results.append((float(loss.item()), float(norm.item()), samples))
                if precision == "fp32":
                    record.update(fp32_reference_safe=True, fp32_loss=float(loss.item()),
                                  fp32_grad_norm=float(norm.item()))
        record["fp32_loss"], record["fp32_grad_norm"], _ = results[0]
        if len(results) > 1:
            loss_a, norm_a, grads_a = results[0]
            loss_b, norm_b, grads_b = results[1]
            a = torch.cat([grads_a[k] for k in sorted(grads_a)])
            b = torch.cat([grads_b[k] for k in sorted(grads_a)])
            cosine = float(torch.nn.functional.cosine_similarity(a[None], b[None]).item())
            loss_relative = abs(loss_a - loss_b) / max(abs(loss_a), 1e-5)
            norm_relative = abs(norm_a - norm_b) / max(norm_a, 1e-5)
            record.update(mixed_loss=loss_b, mixed_grad_norm=norm_b, grad_sample_cosine=cosine,
                          relative_loss_error=loss_relative, relative_grad_norm_error=norm_relative)
            if cosine < 0.97 or loss_relative > 0.05 or norm_relative > 0.2:
                record.update(safe=False, selected_precision="fp32", reason="mixed_precision_differs_from_fp32")
                return record
        record.update(safe=True, selected_precision=mode)
        return record
    except (RuntimeError, NotImplementedError) as exc:
        if not results:
            raise RuntimeError("Actual-model FP32 reference probe failed; reduce the stage micro batch before training") from exc
        record.update(safe=False, selected_precision="fp32", reason=type(exc).__name__)
        if mode == "fp32":
            raise
        return record
    finally:
        optimizer.zero_grad(set_to_none=True)
        with torch.no_grad():
            for name, value in model.named_buffers():
                value.copy_(saved[name])
        restore_rng(torch, model, rng)
        gc.collect()
        torch.cuda.empty_cache()


def make_training_args(spec: Spec, stage: str, world: int) -> Any:
    from training.args import load_args, dump_args

    data = read_json(spec.output / "prepared.json")
    if not data or data.get("input_identity") != spec.identity:
        raise ValueError("Preparation must complete for these exact inputs before training")
    args = load_args(spec.source / f"training/configs/{'finetune' if stage == 'teacher' else 'depth_distill'}.yaml")
    args.model_config = str(spec.output / f"configs/{'teacher' if stage == 'teacher' else 'student'}-inference.yaml")
    args.model_overrides = {}
    args.run_dir = spec.output / stage
    args.run_dir.mkdir(parents=True, exist_ok=True)
    args.data.train_jsonl = str(spec.output / "data/train_latents.jsonl")
    args.data.valid_jsonl = str(spec.output / "data/dev.jsonl")
    args.data.precompute = False
    args.data.loader_procs = 1
    args.data.num_bucket_batches = 1
    args.compile = False
    # Preserve the released calibration. Upstream updates this once per
    # forward, which is incompatible with small accumulated DDP batches.
    args.stats_ema_steps = 0
    args.seed = int(spec.option("seed", 42))
    args.batch_size = int(spec.option(f"{stage}_micro_batch_size", 1))
    effective = int(spec.option("effective_batch_size", 64))
    if effective != 64 or args.batch_size < 1 or effective % (world * args.batch_size):
        raise ValueError("batch_size * grad_accum_steps * actual_world_size must equal the official effective batch 64")
    args.grad_accum_steps = effective // (world * args.batch_size)
    args.sample_sentences, args.sample_freq = [], 0
    args.log_freq = max(1, int(spec.option("log_freq", 10)))
    args.valid_freq = max(1, int(spec.option("valid_freq", 100)))
    args.ckpt_freq = max(1, int(spec.option("ckpt_freq", 100)))
    args.num_ckpt_keep = 1
    epochs = float(spec.option(f"{stage}_max_epochs", 80 if stage == "teacher" else 200))
    if not 1 <= epochs <= 2000:
        raise ValueError("Stage exposure bound must be between 1 and 2000 corpus passes")
    official_ceiling = args.max_steps
    execution_steps = min(official_ceiling, max(1, math.ceil(data["counts"]["train"] * epochs / effective)))
    if spec.raw.get(f"{stage}_max_steps") is not None:
        bound = spec.raw[f"{stage}_max_steps"]
        if type(bound) is not int or not 1 <= bound <= official_ceiling:
            raise ValueError("Execution step bound must be a positive integer within the official ceiling")
        execution_steps = min(execution_steps, bound)
    schedule_steps = spec.option(f"{stage}_schedule_steps", execution_steps)
    if type(schedule_steps) is not int or not execution_steps <= schedule_steps <= official_ceiling:
        raise ValueError("Learning schedule horizon must cover execution and stay within the official ceiling")
    args.max_steps = schedule_steps
    args._execution_max_steps = execution_steps
    for option in ("ema_decay", "learning_rate", "warmup_steps"):
        value = spec.raw.get(f"{stage}_{option}")
        if value is None:
            continue
        if option == "ema_decay":
            if not isinstance(value, (int, float)) or not 0 <= value < 1:
                raise ValueError("EMA decay must be in [0, 1)")
            args.ema_decay = float(value)
        elif option == "learning_rate":
            if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= 0.01:
                raise ValueError("Learning rate must be finite, positive and <= 0.01")
            args.optim.lr = float(value)
        else:
            if type(value) is not int or not 1 <= value <= schedule_steps:
                raise ValueError("Warm-up steps must be a positive integer within the schedule")
            args.optim.warmup_steps = value
    if stage == "distill":
        teacher_state = read_json(spec.output / "teacher/state.json", {})
        if teacher_state.get("status") not in ("completed", "imported") or not (spec.output / "teacher/best.pt").is_file():
            raise ValueError("Distillation requires a completed teacher stage and its selected best heldout checkpoint")
        args.distill_teacher_config = str(spec.output / "configs/teacher-inference.yaml")
        args.distill_teacher_overrides = {}
        args.distill_teacher_weights = str(spec.output / "teacher/best.pt")
        args.distill_teacher_use_ema = True
        if spec.raw.get("student_init_from"):
            args.student_init_from = str(spec.asset("student_init_from"))
    args_path = args.run_dir / "args.yaml"
    new_text = dump_args(args)
    if args_path.exists() and args_path.read_text(encoding="utf-8") != new_text and (args.run_dir / "last.pt").exists():
        raise ValueError("Resolved training configuration changed on resume; preserve the original optimization schedule")
    # Rank zero writes below after actual distributed initialization.
    return args, new_text, official_ceiling


def train(spec: Spec, stage: str, requested_precision: str, stop: Stop) -> int:
    install_source(spec)
    torch = require_gpu()
    from torch.nn.parallel import DistributedDataParallel as DDP
    from training.modules.builders import build_models
    from training.checkpointing import EMA
    from training.dataloader import encode_batch
    from training.train_utils import build_optimizer, lr_at

    rank, world = int(os.environ.get("RANK", 0)), int(os.environ.get("WORLD_SIZE", 1))
    local_rank = int(os.environ.get("LOCAL_RANK", 0))
    torch.cuda.set_device(local_rank)
    device = torch.device("cuda", local_rank)
    if world > 1:
        torch.distributed.init_process_group("nccl", timeout=timedelta(minutes=25))
    args, args_text, official_ceiling = make_training_args(spec, stage, world)
    execution_steps = args._execution_max_steps
    if rank == 0:
        atomic_text(args.run_dir / "args.yaml", args_text)
    torch.manual_seed(args.seed + rank)
    random.seed(args.seed + rank)
    model, mimi, _ = build_models(args)
    install_fp32_reductions(model)
    model.to(device).train()
    mimi.to(device).eval()
    from training.scripts.precompute_latents import mimi_encode_hash

    latent_meta = read_json(spec.output / "data/train_latents.meta.json")
    if not latent_meta or latent_meta.get("mimi_hash") != mimi_encode_hash(mimi):
        raise ValueError("Training codec differs from the exact Mimi encoder that precomputed the corpus")
    if model.distill_teacher is not None:
        model.distill_teacher.to(device).eval()
        if any(p.requires_grad for p in model.distill_teacher.parameters()):
            raise ValueError("Distillation teacher must be frozen")
        if any(p.requires_grad for module in (model.flow_lm.flow_net, model.flow_lm.out_eos, model.flow) for p in module.parameters()):
            raise ValueError("Official depth distillation must freeze flow and EOS heads")
        for name in ("emb_mean", "emb_std"):
            if not torch.equal(getattr(model.flow_lm, name), getattr(model.distill_teacher, name)):
                raise ValueError("Mature student initialization changed the teacher's frozen latent calibration")
    if any(p.dtype != torch.float32 for p in model.parameters()):
        raise ValueError("All trainable master weights must remain FP32")
    optimizer = build_optimizer(model, args, device, rank)
    ema = EMA(model, args.ema_decay)
    mode = choose_precision(torch, requested_precision, device)
    scaler = torch.amp.GradScaler("cuda", enabled=mode == "fp16", init_scale=128)
    start_step = 0
    state = {"status": "running", "precision": mode, "best_score": None, "best_step": 0,
             "bad_validations": 0, "attempts": 0, "nonfinite_gradient_attempts": 0,
             "effective_batch_size": 64, "planned_max_steps": execution_steps,
             "learning_schedule_steps": args.max_steps, "ema_decay": args.ema_decay,
             "official_max_steps": official_ceiling, "stop_reason": "",
             "latent_calibration": CALIBRATION_POLICY, "objective_weighting": OBJECTIVE_POLICY}
    checkpoint = args.run_dir / "last.pt"
    if checkpoint.exists():
        payload = torch.load(checkpoint, map_location="cpu", weights_only=True)
        stored = payload["runner"]
        if stored.get("input_identity") != spec.identity or stored.get("world_size") != world:
            raise ValueError("Resume checkpoint input identity or DDP world size differs")
        model.load_state_dict(payload["model"], strict=True)
        optimizer.load_state_dict(payload["optimizer"])
        ema.load_state_dict(payload["ema"])
        start_step = int(payload["step"])
        state.update({k: v for k, v in stored.items() if k in state})
        if requested_precision == "auto":
            mode = stored["precision"]
        else:
            mode = choose_precision(torch, requested_precision, device)
        scaler = torch.amp.GradScaler("cuda", enabled=mode == "fp16", init_scale=128)
        if mode == stored["precision"]:
            scaler.load_state_dict(payload["scaler"])
        restore_rng(torch, model, payload["rng_by_rank"][rank])
        del payload
    selected = read_json(args.run_dir / "best.json", {})
    if selected and (state["best_score"] is None or selected["metrics"]["score"] < state["best_score"]):
        state.update(best_score=selected["metrics"]["score"], best_step=int(selected["step"]))
    loader = IndexedBatches(args, model, mimi, balanced=bool(spec.option("speaker_balanced_sampling", False)))
    probe_batch = loader.batch(start_step * 64 + rank * args.batch_size)
    probe = precision_probe(spec, model, mimi, optimizer, probe_batch, mode, device)
    fallback = distributed_any(torch, not probe["safe"], device, world)
    if fallback:
        if not bool(spec.option("allow_fp32_fallback", True)):
            if rank == 0:
                atomic_json(args.run_dir / "precision.json", probe)
            raise RuntimeError("Mixed precision failed actual-model validation and FP32 fallback is disabled")
        mode = "fp32"
        scaler = torch.amp.GradScaler("cuda", enabled=False)
    state["precision"] = mode
    state["speaker_balanced_sampling"] = loader.balanced
    state["status"] = "running"
    if rank == 0:
        atomic_json(args.run_dir / "precision.json", {**probe, "selected_precision": mode,
                    "all_ranks_safe": not fallback, "hardware": hardware_receipt(torch)})
    # CFG dropout can remove an entire text/voice prefix in a micro batch of
    # one. Those conditioning parameters are unused on that forward.
    wrapped = DDP(model, device_ids=[local_rank], find_unused_parameters=stage == "teacher") if world > 1 else model
    if stage == "distill":
        run_rollout_checks(spec, model, mimi, ema, device, start_step, stop, rank, world)
    if start_step == 0 and not (args.run_dir / "best.pt").exists():
        with ema_weights(model, ema):
            baseline = validate(spec, model, mimi, args, device, rank, world, stop)
        if baseline is None:
            state.update(status="paused", stop_reason=stop.reason)
            save_training(spec, stage, 0, model, optimizer, ema, scaler, state, device, world, rank)
            return EXIT_PAUSED
        state.update(best_score=baseline["score"], best_step=0)
        if rank == 0:
            save_best(spec, stage, 0, model, ema, baseline)
            atomic_json(args.run_dir / "metrics.json", {"step": 0, "heldout": baseline, "input_identity": spec.identity})
    step = start_step
    checkpoint_time = time.monotonic()
    bad_gradients = 0
    exit_code = 0
    last_metrics: dict[str, Any] = {}
    trainable = [p for p in model.parameters() if p.requires_grad]
    try:
        while step < execution_steps:
            if distributed_any(torch, stop.requested(), device, world):
                state.update(status="paused", stop_reason=stop.reason or "other_rank_stop")
                exit_code = EXIT_PAUSED
                break
            iteration_start = time.monotonic()
            optimizer.zero_grad(set_to_none=True)
            state["attempts"] += 1
            saved_buffers = {name: value.clone() for name, value in model.named_buffers()}
            step_rng = capture_rng(torch, model)
            sums: dict[str, float] = {}
            invalid_loss = False
            interrupted_micro = False
            lr = lr_at(step, args)
            for group in optimizer.param_groups:
                group["lr"] = lr * group.get("lr_scale", 1)
            prepared_batches = []
            local_frame_total = 0
            local_shifted_total = 0
            # Codec outputs are small (32 latent channels) and have no graph.
            # Preloading establishes exact denominators for the whole batch 64
            # before any differentiable forward, including uneven rank lengths.
            for micro in range(args.grad_accum_steps):
                if distributed_any(torch, stop.requested(), device, world):
                    interrupted_micro = True
                    break
                global_start = step * 64 + micro * world * args.batch_size + rank * args.batch_size
                batch = loader.batch(global_start)
                with torch.no_grad(), torch.autocast(device_type=device.type, enabled=False):
                    encoded = with_terminal_slot(encode_batch(mimi, batch, device))
                mask = encoded[1]
                valid_count = int(mask.sum().item())
                shifted_count = int(torch.cat([mask[:, :1], mask[:, :-1]], dim=1).sum().item())
                local_frame_total += valid_count
                local_shifted_total += shifted_count
                prepared_batches.append((batch, encoded, valid_count, shifted_count))
            if not interrupted_micro:
                totals = torch.tensor([local_frame_total, local_shifted_total], device=device, dtype=torch.int64)
                if world > 1:
                    torch.distributed.all_reduce(totals)
                global_frames, global_shifted = (int(v) for v in totals.tolist())
            original_eos_weight = args.eos_loss_weight
            for micro, (batch, encoded, valid_count, shifted_count) in enumerate(prepared_batches):
                if interrupted_micro or distributed_any(torch, stop.requested(), device, world):
                    interrupted_micro = True
                    break
                latents, mask, voice, frames = encoded
                loss_scale, local_eos_weight = pooled_objective_weights(valid_count, shifted_count,
                    global_frames, global_shifted, world, original_eos_weight,
                    distill=model.distill_teacher is not None)
                sync = wrapped.no_sync() if world > 1 and micro < args.grad_accum_steps - 1 else nullcontext()
                # DDP requires both the forward and backward inside no_sync().
                with sync:
                    with temporary_eos_weight(args, local_eos_weight), autocast_for(torch, mode, device):
                        loss, metrics = wrapped(latents, mask, batch.text_tokens, voice,
                            update_stats=False, num_voice_prompt_frames=frames)
                    weighted_loss = loss * loss_scale
                    invalid_loss = distributed_any(torch, not bool(torch.isfinite(weighted_loss)), device, world)
                    # Complete DDP's backward even on bad loss; the optimizer
                    # never sees these gradients and all ranks follow one path.
                    # Backward is outside autocast, including LSD's nested VJP.
                    scaler.scale(weighted_loss).backward()
                for name, metric in metrics.items():
                    if metric.numel() == 1 and bool(torch.isfinite(metric)):
                        fraction = shifted_count / global_shifted if name in ("eos_loss", "distill_mse") else valid_count / global_frames
                        contribution = metric.item() * (loss_scale / world if name == "loss" else fraction)
                        sums[name] = sums.get(name, 0) + contribution
                if invalid_loss:
                    break
            if interrupted_micro:
                optimizer.zero_grad(set_to_none=True)
                with torch.no_grad():
                    for name, value in model.named_buffers():
                        value.copy_(saved_buffers[name])
                restore_rng(torch, model, step_rng)
                state.update(status="paused", stop_reason=stop.reason or "other_rank_stop")
                exit_code = EXIT_PAUSED
                break
            if invalid_loss:
                optimizer.zero_grad(set_to_none=True)
                with torch.no_grad():
                    for name, value in model.named_buffers():
                        value.copy_(saved_buffers[name])
                restore_rng(torch, model, step_rng)
                state.update(status="requires_fp32" if mode != "fp32" else "failed",
                             stop_reason="nonfinite_loss")
                exit_code = EXIT_PRECISION if mode != "fp32" else 1
                break
            # Clip *unscaled* gradients. Scaling otherwise changes the effective
            # max_norm and can silently shrink updates by orders of magnitude.
            scaler.unscale_(optimizer)
            grad_norm = torch.nn.utils.clip_grad_norm_(trainable, args.optim.max_norm)
            invalid_gradient = distributed_any(torch, not bool(torch.isfinite(grad_norm)), device, world)
            if invalid_gradient:
                optimizer.zero_grad(set_to_none=True)
                with torch.no_grad():
                    for name, value in model.named_buffers():
                        value.copy_(saved_buffers[name])
                restore_rng(torch, model, step_rng)
                state["nonfinite_gradient_attempts"] += 1
                bad_gradients += 1
                if mode == "fp16" and bad_gradients <= 3:
                    scaler.update(new_scale=max(1.0, scaler.get_scale() / 2))
                    continue
                state.update(status="requires_fp32" if mode != "fp32" else "failed",
                             stop_reason="nonfinite_gradient")
                exit_code = EXIT_PRECISION if mode != "fp32" else 1
                break
            scaler.step(optimizer)
            scaler.update()
            ema.update(model)
            step += 1
            bad_gradients = 0
            metric_names = ["loss", "distill_mse"] if model.distill_teacher is not None else ["loss", "flow_loss", "flow_diag", "flow_distill", "eos_loss"]
            metric_totals = torch.tensor([sums.get(name, 0) for name in metric_names], device=device, dtype=torch.float64)
            if world > 1:
                torch.distributed.all_reduce(metric_totals)
            sums = {name: float(value) for name, value in zip(metric_names, metric_totals.tolist(), strict=True)}
            last_metrics = {"train": sums, "lr": lr, "gradient_norm_unscaled": float(grad_norm.item()),
                    "loss_scale": scaler.get_scale(), "seconds_per_step": time.monotonic() - iteration_start,
                    "corpus_passes": step * 64 / loader.size, "precision": mode,
                    "global_valid_frames": global_frames, "global_shifted_positions": global_shifted}
            if rank == 0 and (step <= 3 or step % args.log_freq == 0):
                atomic_json(args.run_dir / "metrics.json", {"input_identity": spec.identity, "step": step,
                            **last_metrics, "best_score": state["best_score"], "best_step": state["best_step"]})
                stage_state(spec, stage, **state, step=step, corpus_passes=last_metrics["corpus_passes"])
                print(json.dumps({"stage": stage, "step": step, **last_metrics}, allow_nan=False), flush=True)
            validation_due = step % args.valid_freq == 0 or step == execution_steps
            if stage == "distill":
                speech = run_rollout_checks(spec, model, mimi, ema, device, step, stop, rank, world)
                if (speech is not None and step >= int(spec.option("rollout_stop_after_step", 2000))
                        and not speech["has_speech_candidate"]):
                    state.update(status="rejected", stop_reason="generated_speech_failed")
                    break
            if validation_due:
                with ema_weights(model, ema):
                    heldout = validate(spec, model, mimi, args, device, rank, world, stop)
                if heldout is None:
                    state.update(status="paused", stop_reason=stop.reason or "other_rank_stop")
                    exit_code = EXIT_PAUSED
                    break
                minimum_delta = float(spec.option("minimum_relative_improvement", 0.002))
                improved = state["best_score"] is None or heldout["score"] < state["best_score"] - max(abs(state["best_score"]) * minimum_delta, 1e-8)
                if improved:
                    state.update(best_score=heldout["score"], best_step=step, bad_validations=0)
                    if rank == 0:
                        save_best(spec, stage, step, model, ema, heldout)
                else:
                    state["bad_validations"] += 1
                if rank == 0:
                    atomic_json(args.run_dir / "heldout.json", {"step": step, "input_identity": spec.identity,
                                "metrics": heldout, "best_score": state["best_score"], "best_step": state["best_step"]})
                if world > 1:
                    torch.distributed.barrier()
                minimum_steps = max(1, int(spec.option(f"{stage}_min_steps", min(args.optim.warmup_steps, args.max_steps))))
                patience = max(1, int(spec.option("validation_patience", 8)))
                if step >= minimum_steps and state["bad_validations"] >= patience:
                    state.update(status="completed", stop_reason="heldout_plateau")
                    break
            timed_checkpoint = time.monotonic() - checkpoint_time >= float(spec.option("checkpoint_seconds", 600))
            checkpoint_due = distributed_any(torch, step % args.ckpt_freq == 0 or timed_checkpoint or validation_due, device, world)
            if checkpoint_due:
                save_training(spec, stage, step, model, optimizer, ema, scaler, state, device, world, rank)
                checkpoint_time = time.monotonic()
        if step >= execution_steps and state.get("status") != "rejected":
            state.update(status="completed", stop_reason="exposure_or_official_step_bound")
        save_training(spec, stage, step, model, optimizer, ema, scaler, state, device, world, rank)
        if rank == 0:
            stage_state(spec, stage, **state, step=step, corpus_passes=step * 64 / loader.size,
                        peak_allocated_bytes=torch.cuda.max_memory_allocated(device),
                        peak_reserved_bytes=torch.cuda.max_memory_reserved(device))
    finally:
        if torch.distributed.is_initialized():
            torch.distributed.destroy_process_group()
    return exit_code


def generate_samples(spec: Spec, model: Any, mimi: Any, device: Any, label: str, cfg: float,
                     stop: Stop, *, selection_identity: str, limit_references: int = 0) -> bool:
    import torch
    import soundfile as sf
    from training.dataloader.audio import _load_window
    from pocket_tts.modules.stateful_module import init_states

    folder = spec.output / "comparisons" / label
    folder.mkdir(parents=True, exist_ok=True)
    records = read_json(folder / "samples.json", [])
    if any(r.get("selection_identity") != selection_identity for r in records):
        records = []
    done = {(r["reference_id"], r["text_index"]) for r in records if (folder / r["audio"]).exists()}
    model.eval()
    for reference in references(spec)[:limit_references or None]:
        for text_index, text in enumerate(reference["texts"]):
            if stop.requested():
                return False
            if (reference["id"], text_index) in done:
                continue
            started = time.monotonic()
            import sphn

            pcm, input_sr = sphn.read(reference["path"])
            duration = pcm.shape[-1] / input_sr
            wav = _load_window(reference["path"], 0, duration, mimi.sample_rate)
            seed = int(spec.option("sample_seed", 1337)) + text_index
            torch.manual_seed(seed)
            max_frames = int(float(spec.option("sample_max_seconds", 30)) * mimi.frame_rate)
            with torch.no_grad(), torch.autocast(device_type=device.type, enabled=False):
                voice = mimi.encode_to_latent(torch.from_numpy(wav)[None, None].to(device))[0]
                tokens = torch.tensor(model.flow_lm.conditioner.tokenizer.encode(text), dtype=torch.long)
                latent = model.generate([tokens], [voice], max_frames=max_frames, temp=float(spec.option("sample_temperature", 0.3)),
                           n_steps=1, cfg_coef=cfg, eos_threshold=-1.0, eos_countdown=1)[0]
                if latent.shape[0] < 8 or not torch.isfinite(latent).all():
                    raise RuntimeError("Official generation produced empty or non-finite latents")
                ratio = round(mimi.encoder_frame_rate / mimi.frame_rate)
                decoder_state = init_states(mimi, 1, (latent.shape[0] + 8) * ratio)
                audio = mimi.decode_from_latent(latent[None], decoder_state)[0, 0].float().cpu()
            if not torch.isfinite(audio).all():
                raise RuntimeError("Official generation produced non-finite PCM")
            name = f"{reference['id']}-{text_index:02d}.wav"
            temp = folder / f".{name}.{os.getpid()}.tmp"
            sf.write(temp, audio.numpy(), mimi.sample_rate, format="WAV", subtype="FLOAT")
            os.replace(temp, folder / name)
            records.append({"selection_identity": selection_identity,
                "reference_id": reference["id"], "reference_sha256": reference["sha256"],
                "reference_duration_seconds": duration, "text_index": text_index, "text": text,
                "seed": seed, "cfg": cfg, "decode_steps": 1, "temperature": float(spec.option("sample_temperature", 0.3)),
                "sampler": "official_training_TrainableTTS.generate", "audio": name,
                "audio_sha256": sha256_file(folder / name), "audio_duration_seconds": audio.numel() / mimi.sample_rate,
                "generation_seconds": time.monotonic() - started, "sample_rate": mimi.sample_rate,
                "hit_frame_cap": latent.shape[0] >= max_frames, "rms": float(audio.square().mean().sqrt().item()),
                "peak": float(audio.abs().max().item()), "wave_subtype": "FLOAT",
                "postprocessing": "none", "listening_qualified": False})
            atomic_json(folder / "samples.json", records)
    return True


def evaluation_identity(spec: Spec, *, baseline_only: bool = False) -> str:
    selections = {"input_identity": spec.identity, "baseline_only": baseline_only}
    if not baseline_only:
        for stage in ("teacher", "distill"):
            path = selected_checkpoint(spec, stage)
            if path.is_file():
                selections[stage] = sha256_file(path)
    return hashlib.sha256(json.dumps(selections, sort_keys=True).encode()).hexdigest()


def evaluate(spec: Spec, stop: Stop, *, baseline_only: bool = False) -> int:
    install_source(spec)
    torch = require_gpu()
    from training.args import TrainArgs
    from training.modules.builders import build_models
    from training.checkpointing import export_pocket_safetensors

    device = torch.device("cuda", 0)
    stage_name = "baseline" if baseline_only else "evaluate"
    identity = evaluation_identity(spec, baseline_only=baseline_only)
    stage_state(spec, stage_name, status="running", pid=os.getpid(), evaluation_identity=identity)
    if baseline_only:
        config_dir = spec.output / "configs"
        config_dir.mkdir(parents=True, exist_ok=True)
        configs = {}
        for kind in ("teacher", "student"):
            configs[kind] = resolve_inference_config(spec, kind, config_dir / f"{kind}-inference.yaml")
        atomic_json(spec.output / "assets.json", {
            "teacher_weight_sha256": sha256_file(Path(configs["teacher"]["weights_path"])),
            "student_weight_sha256": sha256_file(Path(configs["student"]["weights_path"])),
            "tokenizer_sha256": sha256_file(spec.asset("tokenizer"))})
        atomic_json(spec.output / "hardware.json", hardware_receipt(torch))
    labels = [("baseline-teacher-cfg2", "teacher", None, 2.0),
              ("baseline-september-student-cfg1", "student", None, 1.0)]
    for stage, cfg in (() if baseline_only else (("teacher", 2.0), ("distill", 1.0))):
        checkpoint = selected_checkpoint(spec, stage)
        if checkpoint.is_file():
            labels.append((f"adapted-{stage}-cfg{int(cfg)}", "teacher" if stage == "teacher" else "student", checkpoint, cfg))
    for label, config_kind, checkpoint, cfg in labels:
        if stop.requested():
            stage_state(spec, stage_name, status="paused", reason=stop.reason)
            return EXIT_PAUSED
        args = TrainArgs(model_config=str(spec.output / f"configs/{config_kind}-inference.yaml"), compile=False,
                         start_from_pretrained=checkpoint is None, text_dropout=0, voice_dropout=0)
        model, mimi, _ = build_models(args)
        install_fp32_reductions(model)
        if checkpoint is not None:
            payload = torch.load(checkpoint, map_location="cpu", weights_only=True)
            if payload["runner"].get("input_identity") != spec.identity:
                raise ValueError("Selected checkpoint does not belong to these inputs")
            state = dict(payload["model"])
            if payload.get("ema"):
                state.update(payload["ema"])
            model.load_state_dict(state, strict=True)
            selection_step = int(payload["step"])
            selection_weights = payload.get("runner", {}).get("selection_weights", "ema")
            validated_probes = payload.get("runner", {}).get("validated_probe_count", 0)
            del payload, state
        else:
            selection_step = 0
        model.to(device).eval()
        mimi.to(device).eval()
        selection = sha256_file(checkpoint) if checkpoint else read_json(spec.output / "assets.json")[f"{config_kind}_weight_sha256"]
        if not generate_samples(spec, model, mimi, device, label, cfg, stop,
                                selection_identity=f"{spec.identity}:{label}:{selection}"):
            stage_state(spec, stage_name, status="paused", reason=stop.reason)
            return EXIT_PAUSED
        if checkpoint is not None:
            export_dir = spec.output / checkpoint.parent.name / "export"
            export_dir.mkdir(exist_ok=True)
            # Only export selected EMA weights; latest raw training state can be
            # worse on heldout data. model now contains the complete EMA overlay.
            export_pocket_safetensors(export_dir / "model.safetensors", model.flow_lm, mimi)
            import yaml

            config = yaml.safe_load((spec.output / f"configs/{config_kind}-inference.yaml").read_text())
            config["weights_path"] = "model.safetensors"
            config["flow_lm"]["lookup_table"]["tokenizer_path"] = "tokenizer.json"
            shutil.copyfile(spec.asset("tokenizer"), export_dir / "tokenizer.json")
            atomic_text(export_dir / "inference.yaml", yaml.safe_dump(config, sort_keys=False))
            atomic_json(export_dir / "receipt.json", {"selected_step": selection_step, "checkpoint_step": selection_step,
                "weights": selection_weights, "source_checkpoint_sha256": sha256_file(checkpoint),
                "validated_probe_count": validated_probes,
                "model_sha256": sha256_file(export_dir / "model.safetensors"), "input_identity": spec.identity,
                "source_revision": PINNED_REVISION, "sample_cfg": cfg, "quality_parity_qualified": False,
                "latent_calibration": CALIBRATION_POLICY, "objective_weighting": OBJECTIVE_POLICY})
        del model, mimi
        gc.collect()
        torch.cuda.empty_cache()
    if baseline_only:
        stage_state(spec, stage_name, status="completed", labels=[label for label, _, _, _ in labels],
                    evaluation_identity=identity, listening_qualified=False,
                    wer_measured=False, speaker_similarity_measured=False)
        return 0
    # Test is never used for selecting a checkpoint or stopping optimization.
    # These diagnostics use an identically initialized LSD weight net for all
    # bundles; its loss is descriptive, not a WER/voice-identity judgment.
    test_results = {}
    for label, config_kind, checkpoint, _cfg in labels:
        if stop.requested():
            stage_state(spec, "evaluate", status="paused", reason=stop.reason)
            return EXIT_PAUSED
        torch.manual_seed(int(spec.option("seed", 42)))
        args = TrainArgs(model_config=str(spec.output / f"configs/{config_kind}-inference.yaml"), compile=False,
                         start_from_pretrained=True, text_dropout=0, voice_dropout=0)
        model, mimi, _ = build_models(args)
        install_fp32_reductions(model)
        if checkpoint is not None:
            payload = torch.load(checkpoint, map_location="cpu", weights_only=True)
            combined = {**payload["model"], **(payload.get("ema") or {})}
            model.flow_lm.load_state_dict({k.removeprefix("flow_lm."): v for k, v in combined.items() if k.startswith("flow_lm.")}, strict=True)
            del payload, combined
        model.to(device).eval()
        mimi.to(device).eval()
        result = validate(spec, model, mimi, args, device, 0, 1, stop, split="test")
        if result is None:
            stage_state(spec, "evaluate", status="paused", reason=stop.reason)
            return EXIT_PAUSED
        test_results[label] = result
        atomic_json(spec.output / "evaluate/test-metrics.json", test_results)
        del model, mimi
        gc.collect()
        torch.cuda.empty_cache()
    stage_state(spec, "evaluate", status="completed", test_labels=list(test_results),
                evaluation_identity=identity,
                listening_qualified=False, wer_measured=False, speaker_similarity_measured=False)
    return 0


def restore_results(spec: Spec) -> None:
    value = spec.raw.get("resume_dir")
    if not value:
        return
    source = local_path(spec.base, value)
    if source == spec.output:
        return
    identity = read_json(source / "prepared.json", {}).get("input_identity")
    if identity != spec.identity:
        raise ValueError("resume_dir was trained on different inputs")
    if (spec.output / "prepared.json").exists():
        return
    if source in spec.output.parents or spec.output in source.parents:
        raise ValueError("resume_dir and output_dir may not contain one another")
    # The owner explicitly supplies this runner-owned result directory. No
    # other workspace/history/credential paths are discovered or copied.
    shutil.copytree(source, spec.output, dirs_exist_ok=True, ignore=shutil.ignore_patterns("CANCEL", "*.tmp", "*.tmp.*", ".runner-lock"))


def supervise(spec: Spec, modes: list[str]) -> int:
    restore_results(spec)
    spec.output.mkdir(parents=True, exist_ok=True)
    lock = spec.output / ".runner-lock"
    if lock.exists():
        old_owner = read_json(spec.output / "owner.json", {})
        live = True
        if old_owner.get("host") and old_owner["host"] != socket.gethostname():
            live = False
        elif old_owner.get("pid"):
            try:
                os.kill(int(old_owner["pid"]), 0)
            except (ProcessLookupError, OSError):
                live = False
        if not live:
            lock.unlink()
    try:
        lock_fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    except FileExistsError as exc:
        raise RuntimeError("Another runner owns output_dir, or an interrupted session left .runner-lock; inspect owner.json before removing it") from exc
    os.write(lock_fd, str(os.getpid()).encode())
    os.close(lock_fd)
    state_path = spec.output / "state.json"
    state = read_json(state_path, {"schema": SCHEMA, "input_identity": spec.identity, "sessions": [],
                                 "used_gpu_wall_seconds": 0.0})
    if state.get("input_identity") != spec.identity:
        lock.unlink()
        raise ValueError("output_dir belongs to different inputs")
    old_used = float(state.get("used_gpu_wall_seconds", 0))
    remaining = float(spec.option("gpu_budget_seconds", QUOTA_LIMIT)) - old_used
    session_budget = min(float(spec.option("session_budget_seconds", 39000)), remaining)
    if session_budget < 60:
        lock.unlink()
        raise RuntimeError("The owner's aggregate GPU wall-time allocation is exhausted")
    reserve = min(float(spec.option("checkpoint_reserve_seconds", 300)), session_budget / 4)
    if reserve < 10:
        lock.unlink()
        raise ValueError("checkpoint_reserve_seconds must allow at least 10 seconds before the session bound")
    started = time.time()
    started_monotonic = time.monotonic()
    session_id = str(uuid.uuid4())
    stop = Stop(spec, started + session_budget - reserve)
    session = {"id": session_id, "started_at": now_iso(), "budget_seconds": session_budget,
               "wall_seconds": 0.0, "status": "running"}
    state["sessions"].append(session)
    install_source(spec)
    try:
        torch = require_gpu()
    except Exception:
        lock.unlink(missing_ok=True)
        state.update(status="failed", reason="cuda_runtime_unavailable")
        atomic_json(state_path, state)
        raise
    actual_devices = torch.cuda.device_count()
    world = min(actual_devices, int(spec.option("nproc_per_node", 2)))
    if world < 1 or 64 % world:
        lock.unlink()
        raise ValueError("Actual GPU count cannot form the official effective batch 64")
    atomic_json(spec.output / "owner.json", {"pid": os.getpid(), "session_id": session_id,
                "host": socket.gethostname(),
                "started_at": now_iso(), "hardware": hardware_receipt(torch),
                "cancel_file": "CANCEL", "checkpoint_reserve_seconds": reserve})
    entry = Path(__file__).resolve().parents[1] / "Pocket-KaggleTrain.py"
    child = None
    status = EXIT_PAUSED
    try:
        for mode in modes:
            if stop.requested():
                break
            stage = {"teacher": "teacher", "distill": "distill", "prepare": "prepare", "evaluate": "evaluate", "baseline": "baseline"}[mode]
            prior_stage = read_json(spec.output / stage / "state.json", {})
            completed = prior_stage.get("status") == "completed"
            if completed and stage in ("baseline", "evaluate"):
                completed = prior_stage.get("evaluation_identity") == evaluation_identity(spec, baseline_only=stage == "baseline")
            if completed:
                continue
            precision = str(spec.option("precision", "auto"))
            while True:
                if mode in ("teacher", "distill"):
                    command = [sys.executable, "-m", "torch.distributed.run", "--standalone", "--nnodes=1",
                               f"--nproc-per-node={world}", str(entry), "--mode", "worker", "--stage", stage]
                else:
                    command = [sys.executable, str(entry), "--mode", "worker", "--stage", stage]
                command += ["--spec", str(spec.path), "--precision", precision, "--deadline", str(stop.deadline)]
                log_dir = spec.output / "logs"
                log_dir.mkdir(exist_ok=True)
                stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
                log_path = log_dir / f"{stage}-{stamp}.log"
                kwargs = {"start_new_session": True} if os.name != "nt" else {"creationflags": subprocess.CREATE_NO_WINDOW}
                with log_path.open("w", encoding="utf-8") as log:
                    child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, **kwargs)
                    state.update(status="running", stage=stage, last_log=log_path.relative_to(spec.output).as_posix())
                    signalled_at = None
                    while child.poll() is None:
                        elapsed = time.monotonic() - started_monotonic
                        session["wall_seconds"] = elapsed
                        state["used_gpu_wall_seconds"] = old_used + elapsed
                        state["updated_at"] = now_iso()
                        atomic_json(state_path, state)
                        if stop.requested() and signalled_at is None:
                            signalled_at = time.monotonic()
                            if os.name != "nt":
                                os.killpg(child.pid, signal.SIGTERM)
                            else:
                                child.send_signal(signal.SIGTERM)
                        if signalled_at is not None and (time.monotonic() - signalled_at >= reserve or elapsed >= session_budget):
                            if os.name != "nt":
                                os.killpg(child.pid, signal.SIGKILL)
                            else:
                                child.kill()
                            break
                        time.sleep(2)
                    code = child.wait()
                    child = None
                numerical_fallback = read_json(spec.output / stage / "state.json", {}).get("status") == "requires_fp32"
                # torchrun reports ChildFailedError as exit 1 even when a rank
                # exits 75, so the atomically saved worker state is authoritative.
                if (code == EXIT_PRECISION or numerical_fallback) and precision != "fp32" and bool(spec.option("allow_fp32_fallback", True)) and not stop.requested():
                    precision = "fp32"
                    continue
                if code:
                    status = EXIT_PAUSED if code == EXIT_PAUSED or stop.requested() else code
                    state.update(status="paused" if status == EXIT_PAUSED else "failed", stage=stage)
                    return status
                break
        all_done = all(read_json(spec.output / stage / "state.json", {}).get("status") == "completed" for stage in modes)
        status = 0 if all_done else EXIT_PAUSED
        state.update(status="completed" if all_done else "paused", reason=stop.reason)
        return status
    finally:
        if child is not None and child.poll() is None:
            if os.name != "nt":
                os.killpg(child.pid, signal.SIGTERM)
            else:
                child.terminate()
            try:
                child.wait(timeout=reserve)
            except subprocess.TimeoutExpired:
                child.kill()
        elapsed = time.monotonic() - started_monotonic
        session.update(wall_seconds=elapsed, status=state.get("status", "failed"), ended_at=now_iso(),
                       actual_device_seconds=elapsed * actual_devices)
        state["used_gpu_wall_seconds"] = old_used + elapsed
        atomic_json(state_path, state)
        atomic_json(spec.output / "owner.json", {"pid": os.getpid(), "session_id": session_id,
                    "host": socket.gethostname(),
                    "status": state.get("status", "failed"), "ended_at": now_iso()})
        lock.unlink(missing_ok=True)


def plan(spec: Spec) -> dict[str, Any]:
    import yaml

    counts = {split: len(rows_at(path)) for split, path in spec.manifests.items()}
    relocated = {split: relocate_manifest(spec, split) for split in spec.manifests}
    fence_splits(spec, relocated)
    missing = {split: sum(not valid_words(row) for row in rows) for split, rows in relocated.items()}
    if any(missing.values()) and not spec.raw.get("align_model_dir"):
        raise ValueError("Unaligned data requires a staged local align_model_dir")
    if spec.raw.get("align_model_dir"):
        spec.asset("align_model_dir")
    result = {"schema": SCHEMA, "input_identity": spec.identity, "source_revision": PINNED_REVISION,
              "source_digest": spec.raw["source_digest"], "counts": counts, "needs_alignment": missing,
              "session_budget_seconds": spec.option("session_budget_seconds", 39000),
              "gpu_budget_seconds": spec.option("gpu_budget_seconds", QUOTA_LIMIT),
              "effective_batch_size": 64, "compile": False, "precision": spec.option("precision", "auto"),
              "local_assets_only": True, "selection_split": "dev", "final_only_split": "test"}
    result["baseline_only"] = not spec.manifests
    result["cast_counts"] = {split: cast_counts(rows) for split, rows in relocated.items()}
    result["latent_calibration"] = CALIBRATION_POLICY
    result["objective_weighting"] = OBJECTIVE_POLICY
    for kind in ("teacher", "student"):
        config = yaml.safe_load(spec.asset(f"{kind}_config").read_text())
        local_path(spec.base, config["weights_path"])
        result[f"{kind}_layers"] = config["flow_lm"]["transformer"]["num_layers"]
    return result


def relocate_export(directory: Path) -> dict[str, Any]:
    """Resolve a downloaded export's local paths without loading its model.

    The public upstream loader interprets paths relative to the process CWD,
    rather than to the YAML file. Explicitly rebase after moving an export so
    TTSModel.load_model(config=<absolute inference.yaml>) works from any CWD.
    """
    import yaml

    directory = directory.resolve()
    config_path = directory / "inference.yaml"
    model = local_path(directory, "model.safetensors")
    tokenizer = local_path(directory, "tokenizer.json")
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8-sig"))
    raw["weights_path"] = str(model)
    raw["weights_path_without_voice_cloning"] = None
    raw["flow_lm"]["weights_path"] = None
    raw["mimi"]["weights_path"] = None
    raw["flow_lm"]["lookup_table"]["tokenizer_path"] = str(tokenizer)
    raw["flow_lm"]["dtype"] = "float32"
    raw["mimi"]["dtype"] = "float32"
    receipt = read_json(directory / "receipt.json", {})
    if receipt:
        if receipt.get("model_sha256") and receipt["model_sha256"] != sha256_file(model):
            raise ValueError("Downloaded export weights differ from their selected-checkpoint receipt")
    atomic_text(config_path, yaml.safe_dump(raw, sort_keys=False))
    if receipt:
        atomic_json(directory / "receipt.json", {**receipt, "relocated_at": now_iso()})
    return {"config": str(config_path), "weights": str(model), "tokenizer": str(tokenizer),
            "model_execution": False, "source_files_changed": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--spec", type=Path, help="Owner-staged local JSON specification")
    parser.add_argument("--mode", choices=("plan", "baseline", "prepare", "teacher", "distill", "evaluate", "student", "all", "worker"), default="plan")
    parser.add_argument("--stage", choices=("baseline", "prepare", "teacher", "distill", "evaluate"))
    parser.add_argument("--plan-only", action="store_true", help="Validate local inputs and print a CPU-only plan without starting a worker")
    parser.add_argument("--precision", choices=("auto", "bf16", "fp16", "fp32"))
    parser.add_argument("--deadline", type=float, help=argparse.SUPPRESS)
    parser.add_argument("--digest-source", type=Path, help="Print the content digest of the pinned source ZIP checkout")
    parser.add_argument("--relocate-export", type=Path, help="Rebase a downloaded export's YAML to its local assets; no model is loaded")
    parser.add_argument("--self-test", type=Path, metavar="SOURCE_DIR", help="Run offline CPU numerical/state checks against the official source")
    arguments = parser.parse_args()
    if arguments.digest_source:
        print(source_digest(arguments.digest_source.resolve()))
        return 0
    if arguments.relocate_export:
        print(json.dumps(relocate_export(arguments.relocate_export), indent=2))
        return 0
    if arguments.self_test:
        from pocket_training.selftest import run_tests

        return run_tests(arguments.self_test.resolve())
    if arguments.spec is None:
        parser.error("--spec is required for a runner mode")
    baseline_mode = arguments.mode in ("plan", "baseline") or (arguments.mode == "worker" and arguments.stage == "baseline")
    spec = load_spec(arguments.spec, require_manifests=not baseline_mode)
    requested_precision = arguments.precision or str(spec.option("precision", "auto"))
    if requested_precision not in ("auto", "bf16", "fp16", "fp32"):
        raise ValueError("precision must be auto, bf16, fp16, or fp32")
    spec.raw["precision"] = requested_precision
    if arguments.mode == "plan" or arguments.plan_only:
        print(json.dumps(plan(spec), indent=2, allow_nan=False))
        return 0
    if arguments.mode == "worker":
        if not arguments.stage or not arguments.deadline:
            parser.error("worker is owned by the supervisor and requires --stage and --deadline")
        stop = Stop(spec, arguments.deadline)
        if arguments.stage == "prepare":
            return prepare(spec, stop)
        if arguments.stage == "evaluate":
            return evaluate(spec, stop)
        if arguments.stage == "baseline":
            return evaluate(spec, stop, baseline_only=True)
        return train(spec, arguments.stage, requested_precision, stop)
    if arguments.mode == "student":
        if not spec.raw.get("import_teacher_checkpoint"):
            raise ValueError("Student-only adaptation requires a provenanced imported teacher")
        modes = ["prepare", "distill", "evaluate"]
    else:
        modes = ["prepare", "teacher", "distill", "evaluate"] if arguments.mode == "all" else [arguments.mode]
    return supervise(spec, modes)
