"""Launch full-A student distillation from a teacher candidate in the private bucket.

prepare builds one private notebook (frozen full-A payload, student recipe,
reviewed source overlays, observable logging, three rolling bucket slots);
submit Saves it exactly once; status/stream read it back. Nothing here
replaces the accepted runtime student.
"""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LAUNCH = ROOT / "runtime/voice-data-expansion-20261004/a-continuation-launch-v1"
FROZEN = ROOT / "runtime/voice-data-expansion-20261004/a-continuation-candidate-v5-runner-entry-fix"
DEST = ROOT / "runtime/voice-data-expansion-20261005/full-a-student"
PURPOSE = "full_a_student_observable"
PREFIX = "cp2077-full-a-student-"
BUCKET = "alystria-ai/cyberpunk-pocket-rolling-checkpoints"
CORE_PATH = ROOT / "scripts/Pocket-ObservableKaggle.py"
EXPORT_HELPER = ROOT / "scripts/pocket_training/selected_teacher_export.py"
module = importlib.util.spec_from_file_location("observable_job_io", CORE_PATH)
io = importlib.util.module_from_spec(module)
sys.modules[module.name] = io
module.loader.exec_module(io)

# The full-A teacher run full-a-20261005-c5e2605b overfit after update 1000;
# the user selected update 1000 raw (held-out macro dev 0.3305, the best of
# every evaluation). The run was cancelled without saved Kaggle output, so
# this compact candidate exists only in the rolling bucket.
TEACHER = {
    "run_id": "full-a-20261005-c5e2605b",
    "path_in_bucket": "runs/full-a-20261005-c5e2605b/slot-2/teacher/candidates/step000001000-raw.pt",
    "bytes": 1264167441, "step": 1000, "weights": "raw",
    "input_identity": "03e89124733a88ac5d869f0df5c79f0d2d60cc88a77a67bbc32d444a59ffc22c",
    "architecture_config": "configs/a-teacher.yaml",
    "selection_basis": "user-selected full-A teacher update 1000 raw: lowest held-out macro dev score "
                       "(0.3305) before the run overfit",
}
MAX_STEPS = 12000


def stopping_recipe(student_spec):
    """Stop on held-out evidence instead of fixed exposure gates.

    The frozen recipe could not stop before 50 corpus passes (~6,400 updates)
    and only counted an evaluation as progress when no per-character gate
    fired; on the teacher every evaluation tripped at least one, so it would
    have trained to its exposure floor regardless. Here an evaluation counts
    when the better of its EMA/raw macro dev scores beats the best so far
    (step-zero student included) by 0.2%; two evaluations without that stop
    the run. The first stop is possible at update 2000.
    """
    policy = dict(student_spec["student_continuation"])
    policy.update(minimum_corpus_passes=1, minimum_speech_evaluations=2, plateau_patience=2)
    return {"student_continuation": policy, "distill_min_steps": 2000, "validation_patience": 2,
            "distill_plateau_rule": "macro_dev_best_of_ema_raw_v1", "log_freq": 10}


def prepare(candidate):
    candidate = candidate.resolve()
    original_manifest = io.read(FROZEN / "frozen-source-manifest.json")["files"]
    sources = {
        "candidate/scripts/pocket_training/runner.py":
            (candidate / "candidate/scripts/pocket_training/runner.py",
             original_manifest["scripts/pocket_training/runner.py"]["sha256"]),
        "candidate/scripts/pocket_training/student_transfer.py":
            (candidate / "candidate/scripts/pocket_training/student_transfer.py",
             original_manifest["scripts/pocket_training/student_transfer.py"]["sha256"]),
        "candidate/scripts/pocket_training/remote_checkpoints.py":
            (candidate / "candidate/scripts/pocket_training/remote_checkpoints.py", None),
        "candidate/scripts/pocket_training/selected_teacher_export.py": (EXPORT_HELPER, None),
    }
    if any(not path.is_file() for path, _ in sources.values()):
        raise ValueError("Reviewed student candidate is incomplete")
    old = LAUNCH / "full-job-teacher-278f55dd0e944d57"
    original = io.read(old / "root-approval.json")
    binding = io.read(old / "launch-bindings.json")
    archive = LAUNCH / "final-payload-v2" / binding["payload"]["archive_name"]
    with zipfile.ZipFile(archive) as bundle:
        student_spec = json.loads(bundle.read("student-spec.json"))
    if student_spec["distill_max_steps"] != MAX_STEPS or student_spec.get("import_teacher_checkpoint") is not None:
        raise ValueError("Frozen student recipe differs from the reviewed one")
    quota_module = importlib.util.spec_from_file_location("full_quota_read", LAUNCH / "read_progress.py")
    quota_io = importlib.util.module_from_spec(quota_module)
    quota_module.loader.exec_module(quota_io)
    quota = quota_io.snapshot()
    if quota["reserved_seconds"] != 0:
        raise ValueError("Another reserved job must finish before launch")
    allowance = min(43200, math.floor(quota["available_seconds"]))
    if allowance < 6 * 3600:
        raise ValueError("Less than six hours of GPU quota remain for the student")
    nonce = uuid.uuid4().hex[:16]
    name = PREFIX + nonce
    folder = DEST / name
    folder.mkdir(parents=True, exist_ok=False)
    overlays = []
    for member, (path, previous) in sources.items():
        source = path.read_text(encoding="utf-8")
        compile(source, member, "exec")
        overlays.append({"path": member, "before_sha256": previous,
                         "sha256": hashlib.sha256(source.encode()).hexdigest(), "source": source})
    experiment = "full-a-student-20261005-" + nonce[:8]
    binding.update(role="student", experiment_id=experiment, segment_id="student-" + nonce,
                   available_execution_seconds=allowance, student_quota_reserve_seconds=0,
                   source_overlays=overlays, spec_overrides={}, selected_teacher=None, resume=None,
                   bucket_teacher=TEACHER, recipe_overrides=stopping_recipe(student_spec),
                   remote_checkpoint_run_id=experiment, remote_checkpoint_max_keep=3,
                   checkpoint_bucket=BUCKET)
    original_source = (LAUNCH / "kernel-template.py").read_text(encoding="utf-8")
    original_source = original_source.split('\nif __name__ == "__main__":', 1)[0]
    original_source = original_source.replace("def main():", "def full_original_main():", 1)
    original_source = original_source.replace('"__FULL_A_BINDINGS_JSON__"', repr(json.dumps(binding)), 1)
    token = (ROOT / "runtime/huggingface-alystria-token.txt").read_text().strip()
    if not token.startswith("hf_"):
        raise ValueError("Private checkpoint credential missing")
    adapter = (ROOT / "scripts/pocket_training/full_a_live_bootstrap.py").read_text(encoding="utf-8")
    source = ('print("FULL_A_PYTHON_ENTRY ' + nonce + '", flush=True)\n' + original_source
              + '\nos.environ["HF_TOKEN"] = ' + repr(token) + '\n' + adapter)
    compile(source, "full-a-student-notebook.py", "exec")
    cell = lambda text: {"id": uuid.uuid4().hex[:12], "cell_type": "code", "execution_count": None,
                         "metadata": {}, "outputs": [], "source": text.splitlines(True)}
    notebook = {"nbformat": 4, "nbformat_minor": 5,
        "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}},
        "cells": [cell('import datetime\nprint("POCKET_NOTEBOOK_STARTED full-a-student ' + nonce + '", datetime.datetime.now(datetime.timezone.utc).isoformat(), flush=True)\n'), cell(source)]}
    io.atomic(folder / "kernel.ipynb", notebook)
    meta = {"id": "akshit40392/" + name, "title": name.replace("-", " "),
        "code_file": "kernel.ipynb", "language": "python", "kernel_type": "notebook", "is_private": True,
        "dataset_sources": [item["slug"] for item in original["datasets"]], "kernel_sources": []}
    io.atomic(folder / "kernel-metadata.json", meta)
    safe_binding = {**binding, "source_overlays": [{key: value for key, value in item.items() if key != "source"}
                                                   for item in overlays]}
    io.atomic(folder / "launch-bindings.json", safe_binding)
    io.atomic(folder / "approval.json", {"slug": meta["id"], "nonce": nonce, "purpose": PURPOSE,
        "source_sha256": io.sha(folder / "kernel.ipynb"), "datasets": original["datasets"],
        "timeout_seconds": allowance, "quota_reserve_seconds": 0, "execution_type": "SAVE_AND_RUN_ALL",
        "contains_private_checkpoint_credential": True, "automatic_model_promotion": False,
        "authorized_save_calls": 1, "launcher_sha256": io.sha(CORE_PATH),
        "full_launcher_sha256": io.sha(__file__), "max_steps": MAX_STEPS,
        "train_rows": 8140, "voices": 79, "effective_batch_size": 64, "nproc_per_node": 2,
        "diagnostic_subset": False, "selected_ids": [], "source_overlays": safe_binding["source_overlays"],
        "teacher": TEACHER, "recipe_overrides": binding["recipe_overrides"],
        "checkpoint_storage": {"kind": "private_bucket", "max_snapshots": 3, "bucket_id": BUCKET},
        "payload_anchor_sha256": binding["payload"]["anchor_sha256"],
        "scope": "Full-A student distillation from the selected bucket teacher; held-out stopping; "
                 "first-update and evaluation cloud checkpoints"})
    io.atomic(folder / "quota-at-preparation.json", quota)
    return {"prepared": str(folder), "source_sha256": io.sha(folder / "kernel.ipynb"),
            "session_allowance_seconds": allowance, "experiment_id": experiment}


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
            result = io.connected(args.folder, args.action, allowed_root=DEST,
                                  required_purpose=PURPOSE, name_prefix=PREFIX)
        print(json.dumps(result, indent=2))
    except Exception as error:
        print(json.dumps({"failed": type(error).__name__, "automatic_retry": False}))
        raise SystemExit(1) from None
