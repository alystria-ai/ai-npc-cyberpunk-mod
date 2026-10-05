"""OmniVoice LoRA fine-tune on game dialogue, on Kaggle 2x T4 (policy omnivoice_lora_game_v1).

  dataset  --tokens E:/.../omni-ft/data/tokens       build + upload a NEW private input dataset
  prepare  --dataset <owner/slug> [--steps 3000]     write the notebook folder (one Save allowed)
  submit | status | stream  --folder <prepared folder>
  download --folder <prepared folder>               fetch adapter checkpoints to E:

Training data: Higgs-tokenized game clips with the evaluation panel's target lines and
reference pool removed (built by the likeness experiments). The base model is the pinned
public k2-fsa/OmniVoice revision the runtime uses. Only LoRA adapters (+ audio
embeddings/heads, as the upstream recipe trains them) are saved; the runtime is untouched.
"""
import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "runtime/voice-data-expansion-20261005/omni-lora"
PURPOSE = "omnivoice_lora_game_v1"
PREFIX = "cp2077-omni-lora-"
CORE_PATH = ROOT / "scripts/Pocket-ObservableKaggle.py"
OMNI_SRC = ROOT / "vendor/reference-omnivoice-training/omnivoice"
REVISION = "c5fdb5ccb189668d56333f77ba2629f4cd7535f4"
WORK = Path(r"E:\CyberpunkConvai-offload\work\omni-ft")

spec = importlib.util.spec_from_file_location("observable_job_io", CORE_PATH)
core = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = core
spec.loader.exec_module(core)

NOTEBOOK = r'''
import json, os, subprocess, sys, tarfile, time
from pathlib import Path
print("POCKET_NOTEBOOK_STARTED omni-lora __NONCE__", flush=True)
STEPS = __STEPS__
CONFIG = __CONFIG__
inp = Path("/kaggle/input"); work = Path("/kaggle/working"); tmp = Path("/tmp/omni"); tmp.mkdir(parents=True, exist_ok=True)
src = [p for p in inp.rglob("omnivoice-src.bin")]
assert len(src) == 1, src
data_dir = src[0].parent
with tarfile.open(src[0]) as t:
    t.extractall(tmp / "src")
for split in ("train", "dev"):
    lines = []
    for line in (data_dir / f"{split}-data.lst").read_text().splitlines():
        tar_name, jsonl_name, n, d = line.split()
        lines.append(f"file:{data_dir / tar_name} {data_dir / jsonl_name} {n} {d}")
    (tmp / f"{split}.lst").write_text("\n".join(lines) + "\n")
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "transformers>=5.3.0,<6", "accelerate>=1.10", "peft>=0.20.0",
                "webdataset", "pydub", "tensorboardX"], check=True)
# peft imports torchao when present; the image's 0.10 is rejected (needs >0.16) and it is unused here.
subprocess.run([sys.executable, "-m", "pip", "uninstall", "-y", "-q", "torchao"], check=False)
from huggingface_hub import snapshot_download
model_dir = snapshot_download("k2-fsa/OmniVoice", revision="__REVISION__", local_dir=str(tmp / "OmniVoice"),
                              allow_patterns=["*.json", "*.safetensors", "*.jinja", "*.txt", "*.model"], ignore_patterns=["audio_tokenizer/*"])
CONFIG.update(init_from_checkpoint=model_dir, llm_name_or_path=model_dir, steps=STEPS)
(tmp / "train_config.json").write_text(json.dumps(CONFIG, indent=1))
# No dev loader: one dev shard cannot feed 2 ranks x 2 workers, and selection happens offline
# on the held-out panel through the runtime backend anyway.
(tmp / "data_config.json").write_text(json.dumps({"train": [{"manifest_path": [str(tmp / "train.lst")]}]}))
(tmp / "run_train.py").write_text("""
import sys, accelerate
accelerate.Accelerator.save_state = lambda self, *a, **k: None  # adapters only: full states would fill the disk
from omnivoice.cli.train import main
sys.exit(main())
""")
env = {**os.environ, "PYTHONPATH": str(tmp / "src"), "PYTHONUNBUFFERED": "1",
       "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}
cmd = ["accelerate", "launch", "--num_processes", "2", "--mixed_precision", "fp16", str(tmp / "run_train.py"),
       "--train_config", str(tmp / "train_config.json"), "--data_config", str(tmp / "data_config.json"),
       "--output_dir", str(work / "omni-lora")]
log = open(work / "omni-lora-train.log", "w")
proc = subprocess.Popen(cmd, env=env, stdout=log, stderr=subprocess.STDOUT)
seen = 0
while proc.poll() is None:
    time.sleep(60)
    lines = (work / "omni-lora-train.log").read_text(errors="replace").replace("\r", "\n").splitlines()
    for line in lines[seen:]:
        if line.startswith("Step ") or "Eval" in line or "eval" in line[:40] or "Error" in line or "Traceback" in line:
            print(line[:300], flush=True)
    seen = len(lines)
print("EXIT", proc.returncode, (work / "omni-lora-train.log").read_text(errors="replace")[-3000:], flush=True)
'''


def kaggle_cli(*args):
    env = {**os.environ, "KAGGLE_API_TOKEN": (ROOT / "runtime/kaggle-access-token.txt").read_text().strip(),
           "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    exe = ROOT / "vendor/kaggle-env/Scripts/kaggle.exe"
    result = subprocess.run([str(exe), *args], env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    clean = lambda s: re.sub(r"https?://\S+|KGAT_\w+|hf_\w+", "[redacted]", s or "")
    return result.returncode, clean(result.stdout)[-2000:], clean(result.stderr)[-2000:]


def build_dataset(tokens: Path):
    nonce = uuid.uuid4().hex[:8]
    slug = f"akshit40392/cp2077-omni-lora-input-{nonce}"
    folder = WORK / f"kaggle-dataset-{nonce}"
    folder.mkdir(parents=True)
    for split in ("train", "dev"):
        out_lines = []
        for line in (tokens / split / "data.lst").read_text().splitlines():
            tar_url, jsonl, n, d = line.split()
            tar_path = Path(tar_url.removeprefix("file:"))
            tar_name = f"{split}-{tar_path.stem}.shard"  # not .tar: the provider must not unpack shards
            jsonl_name = f"{split}-{Path(jsonl).name}"
            shutil.copyfile(tar_path, folder / tar_name)
            shutil.copyfile(jsonl, folder / jsonl_name)
            out_lines.append(f"{tar_name} {jsonl_name} {n} {d}")
        (folder / f"{split}-data.lst").write_text("\n".join(out_lines) + "\n")
    with tarfile.open(folder / "omnivoice-src.bin", "w") as t:
        t.add(OMNI_SRC, arcname="omnivoice", filter=lambda m: None if "__pycache__" in m.name else m)
    (folder / "dataset-metadata.json").write_text(json.dumps({"title": f"cp2077 omni lora input {nonce}", "id": slug,
                                                              "licenses": [{"name": "other"}]}))
    code, out, err = kaggle_cli("datasets", "create", "-p", str(folder))
    return {"slug": slug, "folder": str(folder), "returncode": code, "stdout": out, "stderr": err}


def prepare(dataset: str, steps: int):
    nonce = uuid.uuid4().hex[:12]
    name = PREFIX + nonce
    folder = DEST / name
    folder.mkdir(parents=True, exist_ok=False)
    config = json.loads((ROOT / "vendor/reference-omnivoice-training/examples/config/train_config_finetune_lora.json").read_text())
    config.update(lora_r=32, lora_alpha=64, batch_tokens=2048, gradient_accumulation_steps=2, num_workers=2,
                  mixed_precision="fp16", attn_implementation="sdpa", save_steps=500, eval_steps=500, logging_steps=25,
                  keep_last_n_checkpoints=-1)
    source = (NOTEBOOK.replace("__NONCE__", nonce).replace("__STEPS__", str(steps)).replace("__CONFIG__", repr(config))
              .replace("__REVISION__", REVISION))
    compile(source, "omni-lora-notebook.py", "exec")
    cell = lambda text: {"id": uuid.uuid4().hex[:12], "cell_type": "code", "execution_count": None,
                         "metadata": {}, "outputs": [], "source": text.splitlines(True)}
    notebook = {"nbformat": 4, "nbformat_minor": 5, "metadata": {"kernelspec": {
        "display_name": "Python 3", "language": "python", "name": "python3"}}, "cells": [cell(source)]}
    core.atomic(folder / "kernel.ipynb", notebook)
    meta = {"id": "akshit40392/" + name, "title": name.replace("-", " "), "code_file": "kernel.ipynb",
            "language": "python", "kernel_type": "notebook", "is_private": True, "dataset_sources": [dataset],
            "kernel_sources": []}
    core.atomic(folder / "kernel-metadata.json", meta)
    core.atomic(folder / "approval.json", {
        "slug": meta["id"], "nonce": nonce, "purpose": PURPOSE, "policy": PURPOSE,
        "source_sha256": core.sha(folder / "kernel.ipynb"), "datasets": [], "timeout_seconds": 6 * 3600,
        "quota_reserve_seconds": 0, "execution_type": "SAVE_AND_RUN_ALL", "contains_private_checkpoint_credential": False,
        "automatic_model_promotion": False, "authorized_save_calls": 1, "launcher_sha256": core.sha(CORE_PATH),
        "selected_ids": [], "steps": steps, "base_model": "k2-fsa/OmniVoice@" + REVISION, "input_dataset": dataset,
        "scope": "OmniVoice LoRA on held-out-fenced game clips; adapters saved to kernel output only"})
    return {"prepared": str(folder), "slug": meta["id"]}


def download(folder: Path):
    approval = core.read(folder.resolve() / "approval.json")
    auth_spec = importlib.util.spec_from_file_location("omni_auth", core.AUTH)
    auth = importlib.util.module_from_spec(auth_spec)
    auth_spec.loader.exec_module(auth)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        api, _ = auth.authenticate()
    import requests
    from kagglesdk.kernels.types.kernels_api_service import ApiListKernelSessionOutputRequest
    out = WORK / "downloads" / folder.name
    got, token = [], None
    with api.build_kaggle_client() as client:
        while True:
            request = ApiListKernelSessionOutputRequest()
            request.user_name, request.kernel_slug = approval["slug"].split("/", 1)
            request.page_size = 200
            if token:
                request.page_token = token
            response = client.kernels.kernels_api_client.list_kernel_session_output(request)
            for item in response.files or []:
                if not item.file_name.startswith("omni-lora"):
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
    return {"downloaded": len(got), "folder": str(out)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("dataset", "prepare", "submit", "status", "stream", "download"))
    parser.add_argument("--folder", type=Path)
    parser.add_argument("--tokens", type=Path)
    parser.add_argument("--dataset")
    parser.add_argument("--steps", type=int, default=3000)
    args = parser.parse_args()
    try:
        if args.action == "dataset":
            result = build_dataset(args.tokens)
        elif args.action == "prepare":
            result = prepare(args.dataset, args.steps)
        elif args.action == "download":
            result = download(args.folder)
        else:
            result = core.connected(args.folder, args.action, allowed_root=DEST, required_purpose=PURPOSE, name_prefix=PREFIX)
        print(json.dumps(result, indent=2))
    except Exception as error:
        message = re.sub(r"https?://\S+|hf_\w+|KGAT_\w+", "[redacted]", str(error))[:300]
        print(json.dumps({"failed": type(error).__name__, "message": message, "automatic_retry": False}))
        raise SystemExit(1) from None
