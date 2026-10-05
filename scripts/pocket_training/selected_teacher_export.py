"""Fetch a selected full-A teacher candidate and export it for distillation.

The student notebook runs this before the runner. A teacher run that is
stopped early never reaches its own export stage, so this does that stage for
one compact candidate: build the A teacher, load the candidate strictly,
export_pocket_safetensors (the runner's teacher export), then write the
receipt fields that the runner's teacher import checks. CPU only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

PINNED_REVISION = "41cbc84af539ea78a804ffca5f9c6edc1a22ce44"
BUCKET_ID = "akshitireddy/cyberpunk-pocket-rolling-checkpoints"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(remote: str, destination: Path, expected_bytes: int) -> None:
    """Read one file from the private checkpoint bucket (HF_TOKEN)."""
    os.environ.update(HF_HUB_OFFLINE="0", HF_HUB_DISABLE_PROGRESS_BARS="1",
                      HF_HUB_DISABLE_TELEMETRY="1")
    from huggingface_hub import HfApi

    token = os.environ["HF_TOKEN"]
    api = HfApi(token=token)
    folder = remote.rsplit("/", 1)[0]
    listed = [entry for entry in api.list_bucket_tree(BUCKET_ID, prefix=folder, recursive=True, token=token)
              if getattr(entry, "path", None) == remote]
    if len(listed) != 1 or getattr(listed[0], "size", None) != expected_bytes:
        raise RuntimeError("Selected teacher candidate is missing from the bucket or has a different size")
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".partial")
    partial.unlink(missing_ok=True)
    api.download_bucket_files(BUCKET_ID, files=[(remote, partial)], raise_on_missing_files=True, token=token)
    if partial.stat().st_size != expected_bytes:
        raise RuntimeError("Downloaded teacher candidate size differs")
    partial.replace(destination)


def resolved_config(config: Path, assets_root: Path, tokenizer: Path, destination: Path) -> dict:
    """Same resolution as runner.resolve_inference_config for the teacher."""
    import yaml

    raw = yaml.safe_load(config.read_text(encoding="utf-8-sig"))
    if raw["flow_lm"]["transformer"]["num_layers"] != 24:
        raise ValueError("The teacher must use the official 24-layer architecture")
    raw["flow_lm"]["lookup_table"]["tokenizer_path"] = str(tokenizer)
    raw["flow_lm"]["dtype"] = "float32"
    raw["mimi"]["dtype"] = "float32"
    for node in (raw, raw["flow_lm"], raw["mimi"]):
        if node.get("weights_path_without_voice_cloning"):
            node["weights_path_without_voice_cloning"] = None
        if node.get("weights_path"):
            node["weights_path"] = str((assets_root / node["weights_path"]).resolve(strict=True))
    if not raw.get("weights_path"):
        raise ValueError("The teacher config must name the combined bundle that supplies Mimi")
    destination.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    return raw


def export(args: argparse.Namespace) -> dict:
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    sys.path.insert(0, str(args.source.resolve()))
    import torch
    import safetensors.torch
    import yaml

    payload = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    meta = payload.get("runner", {})
    if (payload.get("step") != args.expected_step or meta.get("selection_weights") != args.expected_weights
            or (args.expected_weights == "raw" and payload.get("ema") is not None)
            or meta.get("input_identity") != args.expected_input_identity):
        raise ValueError("Checkpoint is not the selected teacher step, weight kind or run")
    args.export_dir.mkdir(parents=True, exist_ok=True)
    build_config = args.export_dir.parent / "teacher-export-build.yaml"
    config = resolved_config(args.config, args.assets_root, args.tokenizer, build_config)

    from training.args import TrainArgs
    from training.modules.builders import build_models
    from training.checkpointing import export_pocket_safetensors

    model_args = TrainArgs(model_config=str(build_config), compile=False, start_from_pretrained=False,
                           text_dropout=0, voice_dropout=0)
    model, mimi, _ = build_models(model_args)
    model.load_state_dict(payload["model"], strict=True)
    model.eval()
    weights = args.export_dir / "model.safetensors"
    export_pocket_safetensors(weights, model.flow_lm, mimi)
    del model

    # The runner's import repeats this comparison; failing here is cheaper.
    exported = safetensors.torch.load_file(str(weights))
    source = {key: value for key, value in payload["model"].items() if key.startswith("flow_lm.")}
    if {key for key in exported if key.startswith("flow_lm.")} != set(source) or any(
            exported[key].dtype != value.dtype or not torch.equal(exported[key], value) for key, value in source.items()):
        raise ValueError("Exported teacher FlowLM differs from the selected checkpoint")
    bundle = safetensors.torch.load_file(config["weights_path"])
    codec = {key: value for key, value in bundle.items() if key.startswith("mimi.")}
    if {key for key in exported if key.startswith("mimi.")} != set(codec) or any(
            not torch.equal(exported[key], value) for key, value in codec.items()):
        raise ValueError("Exported teacher codec differs from the A teacher bundle")
    del exported, bundle, codec, source

    inference = yaml.safe_load(build_config.read_text(encoding="utf-8"))
    inference["weights_path"] = "model.safetensors"
    inference["flow_lm"]["lookup_table"]["tokenizer_path"] = "tokenizer.json"
    shutil.copyfile(args.tokenizer, args.export_dir / "tokenizer.json")
    (args.export_dir / "inference.yaml").write_text(yaml.safe_dump(inference, sort_keys=False), encoding="utf-8")
    checkpoint_sha = sha256_file(args.checkpoint)
    model_sha = sha256_file(weights)
    receipt = {"selected_step": payload["step"], "checkpoint_step": payload["step"],
               "weights": args.expected_weights, "source_checkpoint_sha256": checkpoint_sha,
               "validated_probe_count": meta.get("validated_probe_count", 0), "model_sha256": model_sha,
               "input_identity": meta["input_identity"], "source_revision": PINNED_REVISION,
               "sample_cfg": 2.0, "quality_parity_qualified": False, "listening_qualified": False,
               "automatic_promotion": False,
               "selection": {"bucket_id": BUCKET_ID, "path_in_bucket": args.bucket_path,
                             "basis": args.selection_basis}}
    (args.export_dir / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return {"event": "selected_teacher_exported", "step": payload["step"], "weights": args.expected_weights,
            "input_identity": meta["input_identity"], "checkpoint_sha256": checkpoint_sha,
            "model_sha256": model_sha, "model_bytes": weights.stat().st_size}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Pinned Pocket source checkout")
    parser.add_argument("--config", type=Path, required=True, help="A teacher architecture YAML")
    parser.add_argument("--assets-root", type=Path, required=True, help="Root for the YAML's relative weights_path")
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--export-dir", type=Path, required=True)
    parser.add_argument("--expected-step", type=int, required=True)
    parser.add_argument("--expected-weights", choices=("ema", "raw"), required=True)
    parser.add_argument("--expected-input-identity", required=True)
    parser.add_argument("--bucket-path", required=True)
    parser.add_argument("--expected-bytes", type=int)
    parser.add_argument("--download", action="store_true", help="Fetch the checkpoint from the bucket first")
    parser.add_argument("--selection-basis", default="")
    parser.add_argument("--result", type=Path)
    args = parser.parse_args(argv)
    if args.download:
        if args.expected_bytes is None:
            parser.error("--download needs --expected-bytes")
        # Only a finished download is renamed into place, so a file of the
        # expected size is a complete earlier attempt (the caller may retry).
        if args.checkpoint.is_file() and args.checkpoint.stat().st_size == args.expected_bytes:
            print(json.dumps({"event": "selected_teacher_download_reused", "bytes": args.expected_bytes}), flush=True)
        else:
            print(json.dumps({"event": "selected_teacher_download_start", "bytes": args.expected_bytes}), flush=True)
            download(args.bucket_path, args.checkpoint, args.expected_bytes)
    elif args.expected_bytes is not None and args.checkpoint.stat().st_size != args.expected_bytes:
        raise ValueError("Local teacher candidate size differs")
    result = export(args)
    if args.result is not None:
        args.result.parent.mkdir(parents=True, exist_ok=True)
        args.result.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
