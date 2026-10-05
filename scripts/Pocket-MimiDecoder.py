"""Prepare / submit / watch / download the Pocket Mimi-decoder fine-tune (policy mimi_decoder_gan_v1).

Runs scripts/pocket_training/mimi_decoder.py on Kaggle 2x T4: variant A on GPU 0
and variant B on GPU 1, each with its own time budget. Inputs are the existing
private datasets (pocket source, a Pocket bundle for the Mimi weights, the
full-A corpus audio); no new upload. Outputs stay in the kernel's /kaggle/working
(decoder-only safetensors, logs, summaries). Nothing touches the checkpoint
bucket, the runtime, or the FlowLM weights.

  prepare  --holdout E:/.../holdout-ids.json [--hours 6]
  submit | status | stream  --folder <prepared folder>
  download --folder <prepared folder>
"""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "runtime/voice-data-expansion-20261005/mimi-decoder"
PURPOSE = "pocket_mimi_decoder_gan_v1"
PREFIX = "cp2077-mimi-decoder-"
CORE_PATH = ROOT / "scripts/Pocket-ObservableKaggle.py"
TRAINER = ROOT / "scripts/pocket_training/mimi_decoder.py"
DATASETS = [
    {"role": "common", "slug": "akshit40392/cp2077-pocket-common-5d580bb5-f7d5fe66", "dataset_id": 12346972, "version": 1},
    {"role": "student-init", "slug": "akshit40392/cp2077-pocket-student-init-dda504b2-e5c58cdc", "dataset_id": 12348421, "version": 1},
    {"role": "full-a-input", "slug": "akshit40392/cp2077-pocket-full-a-input-a9b7a3a4-623fb987", "dataset_id": 12357047, "version": 1},
]
VARIANTS = {"A": ["--lambda-mel", "15", "--lambda-fm", "2"], "B": ["--lambda-mel", "45", "--lambda-fm", "2"]}

spec = importlib.util.spec_from_file_location("observable_job_io", CORE_PATH)
core = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = core
spec.loader.exec_module(core)

NOTEBOOK = r'''
import json, os, subprocess, sys, time, threading
from pathlib import Path
print("POCKET_NOTEBOOK_STARTED mimi-decoder __NONCE__", flush=True)
TRAINER_SOURCE = __TRAINER__
HOLDOUT = __HOLDOUT__
VARIANTS = __VARIANTS__
HOURS = __HOURS__
inp = Path("/kaggle/input")
def find(rel):
    hits = [p for p in inp.rglob(rel.split("/")[-1]) if p.as_posix().endswith(rel)]
    if len(hits) != 1:
        raise SystemExit(f"input {rel}: {len(hits)} matches")
    return hits[0]
source = find("pocket-source/pocket_tts/__init__.py").parents[1]
weights = find("accepted-student/model.safetensors")
train = find("data/train.jsonl"); data_root = train.parents[1]
manifests = [train] + [data_root / "data" / n for n in ("dev.jsonl", "test.jsonl") if (data_root / "data" / n).is_file()]
work = Path("/kaggle/working"); code = work / "code/pocket_training"; code.mkdir(parents=True, exist_ok=True)
(code.parent / "pocket_training/__init__.py").write_text("")
(code / "mimi_decoder.py").write_text(TRAINER_SOURCE)
(work / "holdout-ids.json").write_text(json.dumps(HOLDOUT))
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "einops", "sentencepiece", "tokenizers", "typer"], check=False)
procs = []
for gpu, (name, extra) in enumerate(sorted(VARIANTS.items())):
    out = work / f"mimi-dec-{name}"
    cmd = [sys.executable, "-u", "-m", "pocket_training.mimi_decoder", "--source", str(source), "--weights", str(weights),
           "--audio-root", str(data_root), "--holdout-ids", str(work / "holdout-ids.json"), "--out", str(out),
           "--variant", name, "--time-budget-seconds", str(HOURS * 3600), "--device", "cuda:0", *extra]
    for m in manifests:
        cmd += ["--manifest", str(m)]
    env = {**os.environ, "PYTHONPATH": str(code.parent), "CUDA_VISIBLE_DEVICES": str(gpu)}
    log = open(work / f"mimi-dec-{name}.log", "w")
    procs.append((name, subprocess.Popen(cmd, env=env, stdout=log, stderr=subprocess.STDOUT), work / f"mimi-dec-{name}.log"))
seen = {}
while any(p.poll() is None for _, p, _ in procs):
    time.sleep(60)
    for name, p, path in procs:
        lines = path.read_text(errors="replace").splitlines()
        for line in lines[seen.get(name, 0):]:
            if '"event": "eval"' in line or '"event": "baseline"' in line or "Error" in line or "Traceback" in line \
                    or ('"event": "train"' in line and '"step": ' in line and line.split('"step": ')[1].split(",")[0].endswith("000")):
                print(name, line[:400], flush=True)
        seen[name] = len(lines)
for name, p, path in procs:
    print("EXIT", name, p.returncode, path.read_text(errors="replace")[-2000:], flush=True)
'''


def sha_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def prepare(holdout: Path, hours: float):
    nonce = uuid.uuid4().hex[:12]
    name = PREFIX + nonce
    folder = DEST / name
    folder.mkdir(parents=True, exist_ok=False)
    ids = json.loads(holdout.read_text())
    if not isinstance(ids, list) or len(ids) < 50:
        raise ValueError("Held-out evaluation IDs are required")
    trainer = TRAINER.read_text(encoding="utf-8")
    compile(trainer, "mimi_decoder.py", "exec")
    source = (NOTEBOOK.replace("__NONCE__", nonce).replace("__TRAINER__", repr(trainer))
              .replace("__HOLDOUT__", repr(ids)).replace("__VARIANTS__", repr(VARIANTS)).replace("__HOURS__", repr(hours)))
    compile(source, "mimi-decoder-notebook.py", "exec")
    cell = lambda text: {"id": uuid.uuid4().hex[:12], "cell_type": "code", "execution_count": None,
                         "metadata": {}, "outputs": [], "source": text.splitlines(True)}
    notebook = {"nbformat": 4, "nbformat_minor": 5, "metadata": {"kernelspec": {
        "display_name": "Python 3", "language": "python", "name": "python3"}}, "cells": [cell(source)]}
    core.atomic(folder / "kernel.ipynb", notebook)
    meta = {"id": "akshit40392/" + name, "title": name.replace("-", " "), "code_file": "kernel.ipynb",
            "language": "python", "kernel_type": "notebook", "is_private": True,
            "dataset_sources": [d["slug"] for d in DATASETS], "kernel_sources": []}
    core.atomic(folder / "kernel-metadata.json", meta)
    timeout = int(hours * 3600 + 3600)
    core.atomic(folder / "approval.json", {
        "slug": meta["id"], "nonce": nonce, "purpose": PURPOSE, "policy": "mimi_decoder_gan_v1",
        "source_sha256": core.sha(folder / "kernel.ipynb"), "datasets": DATASETS, "timeout_seconds": timeout,
        "quota_reserve_seconds": 0, "execution_type": "SAVE_AND_RUN_ALL", "contains_private_checkpoint_credential": False,
        "automatic_model_promotion": False, "authorized_save_calls": 1, "launcher_sha256": core.sha(CORE_PATH),
        "mimi_launcher_sha256": core.sha(Path(__file__)), "trainer_sha256": sha_text(trainer), "selected_ids": [],
        "variants": VARIANTS, "hours_per_variant": hours, "heldout_ids": len(ids),
        "scope": "Mimi decoder-only fine-tune; encoder, latents and FlowLM frozen; outputs stay in kernel output"})
    return {"prepared": str(folder), "slug": meta["id"], "timeout_seconds": timeout}


def download(folder: Path):
    folder = folder.resolve()
    approval = core.read(folder / "approval.json")
    auth_spec = importlib.util.spec_from_file_location("mimi_auth", core.AUTH)
    auth = importlib.util.module_from_spec(auth_spec)
    auth_spec.loader.exec_module(auth)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        api, _ = auth.authenticate()
    import requests
    from kagglesdk.kernels.types.kernels_api_service import ApiListKernelSessionOutputRequest
    out = Path(r"E:\CyberpunkConvai-offload\work\mimi-dec") / folder.name
    out.mkdir(parents=True, exist_ok=True)
    got = []
    with api.build_kaggle_client() as client:
        token = None
        while True:
            request = ApiListKernelSessionOutputRequest()
            request.user_name, request.kernel_slug = approval["slug"].split("/", 1)
            request.page_size = 200
            if token:
                request.page_token = token
            response = client.kernels.kernels_api_client.list_kernel_session_output(request)
            for item in response.files or []:
                if not item.file_name.startswith("mimi-dec"):
                    continue
                destination = (out / item.file_name).resolve()
                if not destination.is_relative_to(out.resolve()):
                    raise ValueError("Output path escapes the download folder")
                destination.parent.mkdir(parents=True, exist_ok=True)
                with requests.get(item.url, stream=True, timeout=120) as r:
                    r.raise_for_status()
                    with destination.open("wb") as stream:
                        for block in r.iter_content(1 << 20):
                            stream.write(block)
                got.append(item.file_name)
            token = response.next_page_token
            if not token:
                break
    return {"downloaded": got, "folder": str(out)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "submit", "status", "stream", "download"))
    parser.add_argument("--folder", type=Path)
    parser.add_argument("--holdout", type=Path)
    parser.add_argument("--hours", type=float, default=6.0)
    args = parser.parse_args()
    try:
        if args.action == "prepare":
            result = prepare(args.holdout, args.hours)
        elif args.action == "download":
            result = download(args.folder)
        else:
            result = core.connected(args.folder, args.action, allowed_root=DEST, required_purpose=PURPOSE, name_prefix=PREFIX)
        print(json.dumps(result, indent=2))
    except Exception as error:
        import re
        message = re.sub(r"https?://\S+|hf_\w+|KGAT_\w+", "[redacted]", str(error))[:300]
        print(json.dumps({"failed": type(error).__name__, "message": message, "automatic_retry": False}))
        raise SystemExit(1) from None
