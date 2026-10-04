"""Launch the frozen full-A recipe with observable private checkpoint recovery."""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
LAUNCH = ROOT / "runtime/voice-data-expansion-20261004/a-continuation-launch-v1"
DEST = ROOT / "runtime/voice-data-expansion-20261005/full-a-live"
PURPOSE = "full_a_teacher_observable"
CORE_PATH = ROOT / "scripts/Pocket-ObservableKaggle.py"
module = importlib.util.spec_from_file_location("observable_job_io", CORE_PATH)
io = importlib.util.module_from_spec(module)
sys.modules[module.name] = io
module.loader.exec_module(io)


def prepare(candidate):
    candidate = candidate.resolve()
    frozen = ROOT / "runtime/voice-data-expansion-20261004/a-continuation-candidate-v5-runner-entry-fix"
    original_manifest = io.read(frozen / "frozen-source-manifest.json")
    runner = candidate / "candidate/scripts/pocket_training/runner.py"
    uploader = candidate / "candidate/scripts/pocket_training/remote_checkpoints.py"
    if not runner.is_file() or not uploader.is_file():
        raise ValueError("Reviewed full teacher candidate is incomplete")
    old = LAUNCH / "full-job-teacher-278f55dd0e944d57"
    original = io.read(old / "root-approval.json")
    binding = io.read(old / "launch-bindings.json")
    quota_module = importlib.util.spec_from_file_location("full_quota_read", LAUNCH / "read_progress.py")
    quota_io = importlib.util.module_from_spec(quota_module)
    quota_module.loader.exec_module(quota_io)
    quota = quota_io.snapshot()
    if quota["reserved_seconds"] != 0:
        raise ValueError("Another reserved job must finish before launch")
    teacher_allowance = math.floor(quota["available_seconds"]) - 25200
    if teacher_allowance < 3600:
        raise ValueError("Insufficient actual teacher allowance after student reserve")
    nonce = uuid.uuid4().hex[:16]
    name = "cp2077-full-a-live-" + nonce
    folder = DEST / name
    folder.mkdir(parents=True, exist_ok=False)
    overlays = []
    for path, member, previous in (
        (runner, "candidate/scripts/pocket_training/runner.py", original_manifest["files"]["scripts/pocket_training/runner.py"]["sha256"]),
        (uploader, "candidate/scripts/pocket_training/remote_checkpoints.py", None)):
        source = path.read_text(encoding="utf-8")
        compile(source, member, "exec")
        overlays.append({"path": member, "before_sha256": previous,
                         "sha256": hashlib.sha256(source.encode()).hexdigest(), "source": source})
    binding.update(experiment_id="full-a-20261005-" + nonce[:8], segment_id="teacher-" + nonce,
                   available_execution_seconds=teacher_allowance,
                   teacher_lifetime_budget_seconds=teacher_allowance, source_overlays=overlays,
                   remote_checkpoint_run_id="full-a-20261005-" + nonce[:8],
                   remote_checkpoint_max_keep=3,
                   checkpoint_bucket="akshitireddy/cyberpunk-pocket-rolling-checkpoints")
    original_source = (LAUNCH / "kernel-template.py").read_text(encoding="utf-8")
    original_source = original_source.split('\nif __name__ == "__main__":', 1)[0]
    original_source = original_source.replace("def main():", "def full_original_main():", 1)
    original_source = original_source.replace('"__FULL_A_BINDINGS_JSON__"', repr(json.dumps(binding)), 1)
    token = (ROOT / "runtime/huggingface-checkpoint-token.txt").read_text().strip()
    if not token.startswith("hf_"):
        raise ValueError("Private checkpoint credential missing")
    adapter = (ROOT / "scripts/pocket_training/full_a_live_bootstrap.py").read_text(encoding="utf-8")
    source = ('print("FULL_A_PYTHON_ENTRY ' + nonce + '", flush=True)\n' + original_source
              + '\nos.environ["HF_TOKEN"] = ' + repr(token) + '\n' + adapter)
    compile(source, "full-a-notebook.py", "exec")
    cell = lambda text: {"id": uuid.uuid4().hex[:12], "cell_type": "code", "execution_count": None,
                         "metadata": {}, "outputs": [], "source": text.splitlines(True)}
    notebook = {"nbformat": 4, "nbformat_minor": 5,
        "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}},
        "cells": [cell('import datetime\nprint("POCKET_NOTEBOOK_STARTED full-a ' + nonce + '", datetime.datetime.now(datetime.timezone.utc).isoformat(), flush=True)\n'), cell(source)]}
    io.atomic(folder / "kernel.ipynb", notebook)
    meta = {"id": "akshit40392/" + name, "title": name.replace("-", " "),
        "code_file": "kernel.ipynb", "language": "python", "kernel_type": "notebook", "is_private": True,
        "dataset_sources": [item["slug"] for item in original["datasets"]], "kernel_sources": []}
    io.atomic(folder / "kernel-metadata.json", meta)
    safe_binding = {**binding, "source_overlays": [{key:value for key,value in item.items() if key != "source"} for item in overlays]}
    io.atomic(folder / "launch-bindings.json", safe_binding)
    io.atomic(folder / "approval.json", {"slug": meta["id"], "nonce": nonce, "purpose": PURPOSE,
        "source_sha256": io.sha(folder / "kernel.ipynb"), "datasets": original["datasets"],
        "timeout_seconds": min(43200, teacher_allowance), "execution_type": "SAVE_AND_RUN_ALL",
        "contains_private_checkpoint_credential": True, "automatic_model_promotion": False,
        "authorized_save_calls": 1, "launcher_sha256": io.sha(CORE_PATH),
        "full_launcher_sha256": io.sha(__file__), "teacher_lifetime_budget_seconds": teacher_allowance,
        "student_quota_reserve_seconds": 25200, "max_steps": 20000,
        "train_rows": 8140, "voices": 79, "effective_batch_size": 64, "nproc_per_node": 2,
        "diagnostic_subset": False, "selected_ids": [], "source_overlays": safe_binding["source_overlays"],
        "checkpoint_storage": {"kind": "private_bucket", "max_snapshots": 3,
                               "bucket_id": binding["checkpoint_bucket"]},
        "payload_anchor_sha256": binding["payload"]["anchor_sha256"],
        "scope": "Frozen A teacher recipe, full corpus; first-update and evaluation cloud checkpoints"})
    io.atomic(folder / "quota-at-preparation.json", quota)
    return {"prepared": str(folder), "source_sha256": io.sha(folder / "kernel.ipynb"),
            "train_rows": 8140, "teacher_allowance_seconds": teacher_allowance}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "submit", "status", "stream"))
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--folder", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "prepare":
            if args.candidate is None:
                parser.error("--candidate required")
            result = prepare(args.candidate)
        else:
            if args.folder is None:
                parser.error("--folder required")
            result = io.connected(args.folder, args.action, allowed_root=DEST, required_purpose=PURPOSE)
        print(json.dumps(result, indent=2))
    except Exception as error:
        print(json.dumps({"failed": type(error).__name__, "automatic_retry": False}))
        raise SystemExit(1) from None
