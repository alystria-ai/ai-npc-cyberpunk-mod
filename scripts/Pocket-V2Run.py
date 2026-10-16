"""Pocket v2 teacher / student runs on Kaggle 2x T4 (docs/POCKET_NEXT_RUN_PLAN.md).

  upload-data                       stage and create the private v2 data dataset once (pool audio, corpus, models)
  prepare --role teacher|student    write a private notebook folder under runtime/pocket-v2/ (gitignored: it embeds
            [--run-id ID]           the bucket token; never stage it). --run-id resumes that run from its newest
            [--teacher-run ID]      bucket slot; the student needs the teacher run (selected weights + cache)
            [--smoke] [--hours H]
  submit | status | stream --folder F   via scripts/Pocket-ObservableKaggle.py (one Save, no resubmit)
  logs --run-id ID                  download runs/<ID>/logs/ from the bucket to runtime/pocket-v2/logs/<ID>/

Inputs on Kaggle: the existing private common dataset (pocket source, tokenizer, alignment model), the full-A input
dataset (48 kHz corpus audio) and the new v2 data dataset. Checkpoints, logs and the latent cache go to the private
bucket alystria-ai/cyberpunk-pocket-rolling-checkpoints under runs/<run id>/ (three rotating slots).
"""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "runtime/pocket-v2"
PURPOSE = "pocket_v2_run"
PREFIX = "cp2077-pocket-v2-"
CORE_PATH = ROOT / "scripts/Pocket-ObservableKaggle.py"
CODE = ["__init__.py", "likeness.py", "v2_data.py", "v2_eval.py", "v2_train.py"]
PAYLOAD = Path("E:/CyberpunkConvai-offload/work/pocket-v2/payload")
STAGE = Path("E:/CyberpunkConvai-offload/work/pocket-v2/dataset")
OWNER = "akshit40392"
DATA_PREFIX = "data/pocket-v2-e416611a"  # bucket copy of the v2 payload (same files as the dataset staging folder)
FIXED = [
    {"role": "common", "slug": "akshit40392/cp2077-pocket-common-5d580bb5-f7d5fe66", "dataset_id": 12346972, "version": 1},
    {"role": "full-a-input", "slug": "akshit40392/cp2077-pocket-full-a-input-a9b7a3a4-623fb987", "dataset_id": 12357047, "version": 1},
]
MODELS = {
    "base24.safetensors": ROOT / "vendor/pocket-tts-training/models/english_2026-04_24l.safetensors",
    "base6.safetensors": ROOT / "vendor/pocket-tts-training/models/english_2026-09.safetensors",
    "student5000.safetensors": Path(r"E:\CyberpunkConvai-offload\work\student-ranking\exports\s5000-raw\model.safetensors"),
}
ECAPA = Path(r"E:\CyberpunkConvai-offload\work\likeness-phase1\ecapa-src")

spec = importlib.util.spec_from_file_location("observable_job_io", CORE_PATH)
core = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = core
spec.loader.exec_module(core)

RECIPES = {
    "teacher": {"max_steps": 2000, "horizon": 2000, "lr": 1e-5, "warmup": 150, "ema_decay": 0.998, "eval_every": 250,
                "min_steps": 500, "patience": 3, "min_delta": 0.005, "z_drop": 0.02, "micro_batch": 2,
                "eval_guidance": [1.5, 3.0], "sweep": [[2.0, 2.0], [1.5, 2.5], [1.5, 3.0], [2.0, 3.0]]},
    "student": {"max_steps": 3000, "horizon": 3000, "lr": 5e-5, "warmup": 200, "ema_decay": 0.999, "eval_every": 500,
                "min_steps": 1000, "patience": 2, "min_delta": 0.005, "z_drop": 0.05, "micro_batch": 4,
                "eval_guidance": [1.0, 1.0], "sweep": []},
}

NOTEBOOK = r'''
import json, os, subprocess, sys, time, threading, tarfile, shutil, glob, traceback
from pathlib import Path
print("POCKET_NOTEBOOK_STARTED pocket-v2 __NONCE__", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), flush=True)
CODE = __CODE__
CONFIG = __CONFIG__
RUN_ID = CONFIG["run_id"]
BUCKET = "alystria-ai/cyberpunk-pocket-rolling-checkpoints"
work = Path("/kaggle/working/v2"); work.mkdir(parents=True, exist_ok=True)
notelog = work / "notebook.log"
def say(*parts):
    line = time.strftime("%H:%M:%S ") + " ".join(str(p) for p in parts)
    print(line, flush=True)
    with notelog.open("a") as f: f.write(line + "\n")
def upload(files):
    try:
        from huggingface_hub import HfApi
        HfApi().batch_bucket_files(BUCKET, add=[(s, f"runs/{RUN_ID}/{d}") for s, d in files if Path(s).is_file()], token=os.environ["HF_TOKEN"])
        return True
    except Exception as error:
        say("UPLOAD_FAILED", type(error).__name__, str(error)[:200]); return False
try:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--no-input", "einops", "sentencepiece", "tokenizers",
                    "typer", "psutil", "sphn", "soundfile", "speechbrain==1.1.0", "transformers==5.17.0", "huggingface_hub==1.33.0"], check=False)
    import torch, torchaudio
    say("torch", torch.__version__, "torchaudio", torchaudio.__version__, "gpus", torch.cuda.device_count())
    upload_ok = upload([(str(notelog), "logs/notebook.log")])
    say("bucket_reachable", upload_ok)
    code = Path("/kaggle/working/code/pocket_training"); code.mkdir(parents=True, exist_ok=True)
    for name, text in CODE.items():
        (code / name).write_text(text)
    inp = Path("/kaggle/input")
    def find(rel):
        hits = [p for p in inp.rglob(rel.split("/")[-1]) if p.as_posix().endswith(rel)]
        if not hits: raise SystemExit(f"input {rel}: not found")
        return hits[0]
    source = find("pocket-source/pocket_tts/__init__.py").parents[1]
    tokenizer = find("models/tokenizer.json")
    alignment = find("models/alignment/config.json").parent
    fa_root = find("data/train.jsonl").parents[1]
    temp = Path("/kaggle/temp") if Path("/kaggle/temp").is_dir() else Path("/tmp/v2")
    temp.mkdir(parents=True, exist_ok=True)
    mounted = [p.parent for p in inp.rglob("corpus.json")]
    if mounted:
        v2 = mounted[0]
    else:  # payload kept in the private bucket (DATA_PREFIX) instead of a Kaggle dataset
        from huggingface_hub import HfApi
        v2 = temp / "v2data"; v2.mkdir(parents=True, exist_ok=True)
        api = HfApi()
        names = [e.path for e in api.list_bucket_tree(BUCKET, prefix=CONFIG["data_prefix"] + "/", recursive=True,
                                                      token=os.environ["HF_TOKEN"]) if getattr(e, "type", None) == "file"]
        api.download_bucket_files(BUCKET, files=[(n, str(v2 / n.rsplit("/", 1)[1])) for n in names],
                                  raise_on_missing_files=True, token=os.environ["HF_TOKEN"])
        say("payload downloaded from bucket", len(names), "files")
    # Kaggle may have unpacked the archives on ingestion; accept either form.
    unpacked = [p for p in v2.rglob("pool") if p.is_dir() and any(p.rglob("*.flac"))]
    if unpacked:
        pool = unpacked[0].parent
    else:
        pool = temp / "pool"
        if not (pool / "pool").is_dir():
            with tarfile.open(next(v2.rglob("pool-audio.tar"))) as tar: tar.extractall(pool)
    hp = [p.parent for p in v2.rglob("hyperparams.yaml")]
    if hp:
        ecapa = hp[0]
    else:
        ecapa = temp / "ecapa"
        if not (ecapa / "hyperparams.yaml").is_file():
            with tarfile.open(next(v2.rglob("ecapa.tar"))) as tar: tar.extractall(ecapa)
    say("inputs ready", "pool files", sum(1 for _ in pool.rglob("*.flac")))
    cfg = {**CONFIG, "source_dir": str(source), "corpus": str(v2 / "corpus.json"), "pool_root": str(pool),
           "fa_root": str(fa_root), "tokenizer": str(tokenizer), "alignment_dir": str(alignment), "ecapa_dir": str(ecapa),
           "models": {"base24": str(v2 / "base24.safetensors"), "base6": str(v2 / "base6.safetensors"),
                      "student5000": str(v2 / "student5000.safetensors")},
           "work_dir": str(work), "cache_dir": str(temp / "cache"), "ckpt_dir": str(temp / "ckpt")}
    if CONFIG["role"] == "student" and CONFIG.get("teacher_from_base"):
        cfg["teacher_weights"] = cfg["models"]["base24"]
        say("teacher: released 24-layer base (teacher_from_base)")
    elif CONFIG["role"] == "student":
        from huggingface_hub import HfApi
        dest = temp / "teacher" / "teacher-ema.safetensors"; dest.parent.mkdir(parents=True, exist_ok=True)
        HfApi().download_bucket_files(BUCKET, files=[(f"runs/{CONFIG['teacher_run']}/selected/teacher-ema.safetensors", str(dest))],
                                      raise_on_missing_files=True, token=os.environ["HF_TOKEN"])
        sel = temp / "teacher" / "teacher.json"
        HfApi().download_bucket_files(BUCKET, files=[(f"runs/{CONFIG['teacher_run']}/selected/teacher.json", str(sel))],
                                      raise_on_missing_files=True, token=os.environ["HF_TOKEN"])
        say("teacher selected", sel.read_text()[:300])
        cfg["teacher_weights"] = str(dest)
    (work / "config.json").write_text(json.dumps(cfg, indent=1))
except BaseException:
    say("SETUP_FAILED", traceback.format_exc()[-3000:])
    upload([(str(notelog), "logs/notebook.log")])
    raise
stop = threading.Event()
def watchdog():
    import psutil
    while not stop.wait(600):
        vm = psutil.virtual_memory()
        say("RESOURCES host_used_gib", round((vm.total - vm.available) / 2**30, 1), "disk_free_gib",
            round(shutil.disk_usage("/kaggle/working").free / 2**30, 1))
        files = [(str(notelog), "logs/notebook.log"), (str(work / "train.log"), "logs/train.log")]
        files += [(str(p), "logs/" + p.relative_to(work).as_posix()) for p in work.rglob("*")
                  if p.is_file() and p.suffix in (".json", ".jsonl") and p.stat().st_size < 50_000_000]
        upload(files)
threading.Thread(target=watchdog, daemon=True).start()
env = {**os.environ, "PYTHONPATH": "/kaggle/working/code", "PYTHONUNBUFFERED": "1", "OMP_NUM_THREADS": "2"}
cmd = ["torchrun", "--standalone", "--nproc_per_node", str(max(1, torch.cuda.device_count())), "-m",
       "pocket_training.v2_train", "--config", str(work / "config.json")]
say("launch", " ".join(cmd))
with (work / "train.log").open("w") as log:
    proc = subprocess.Popen(cmd, env=env, stdout=log, stderr=subprocess.STDOUT)
    seen = 0
    while proc.poll() is None:
        time.sleep(30)
        lines = (work / "train.log").read_text(errors="replace").splitlines()
        for line in lines[seen:]:
            if ('"event": "train"' in line and '"step": ' in line
                    and not line.split('"step": ')[1].split(",")[0].strip().endswith("0")):
                continue
            if line.startswith("V2 ") or "Error" in line or "Traceback" in line or "error" in line.lower():
                print(line[:600], flush=True)
        seen = len(lines)
say("EXIT", proc.returncode)
print((work / "train.log").read_text(errors="replace")[-4000:], flush=True)
stop.set()
upload([(str(notelog), "logs/notebook.log"), (str(work / "train.log"), "logs/train.log")]
       + [(str(p), "logs/" + p.relative_to(work).as_posix()) for p in work.rglob("*")
          if p.is_file() and p.suffix in (".json", ".jsonl") and p.stat().st_size < 50_000_000])
'''


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 22), b""):
            digest.update(block)
    return digest.hexdigest()


def auth():
    module_spec = importlib.util.spec_from_file_location("v2_auth", core.AUTH)
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        api, token = module.authenticate()
    return api, token


def upload_data() -> dict:
    record = DEST / "data-dataset.json"
    if record.is_file() and json.loads(record.read_text()).get("state") == "verified":
        raise ValueError("The v2 data dataset was already created: " + record.read_text()[:300])
    STAGE.mkdir(parents=True, exist_ok=True)
    for name in ("pool-audio.tar", "corpus.json", "receipt.json"):
        target = STAGE / name
        if not target.is_file() or target.stat().st_size != (PAYLOAD / name).stat().st_size:
            shutil.copy2(PAYLOAD / name, target)
    for name, source in MODELS.items():
        target = STAGE / name
        if not target.is_file() or target.stat().st_size != source.stat().st_size:
            shutil.copy2(source, target)
    with tarfile.open(STAGE / "ecapa.tar", "w") as tar:
        for p in sorted(ECAPA.iterdir()):
            if p.suffix in (".ckpt", ".yaml", ".txt", ".json"):
                tar.add(p, arcname=p.name)
    nonce = uuid.uuid4().hex[:8]
    slug = f"cp2077-pocket-v2-data-{nonce}"
    (STAGE / "dataset-metadata.json").write_text(json.dumps({"title": f"cp2077 pocket v2 data {nonce}",
        "id": f"{OWNER}/{slug}", "licenses": [{"name": "other"}]}))
    inventory = {p.name: {"bytes": p.stat().st_size, "sha256": sha(p)} for p in sorted(STAGE.iterdir()) if p.is_file()}
    api, _ = auth()
    DEST.mkdir(parents=True, exist_ok=True)
    core.atomic(record, {"slug": f"{OWNER}/{slug}", "state": "creating", "inventory": inventory, "at_utc": core.now()})
    result = api.dataset_create_new(str(STAGE), public=False, quiet=False, dir_mode="skip")
    status = str(getattr(result, "status", "")).lower()
    error = getattr(result, "error", None)
    if error or (status and status != "ok"):
        core.atomic(record, {"slug": f"{OWNER}/{slug}", "state": "rejected", "status": status,
                             "error": re.sub(r"https?://\S+", "[url]", str(error))[:500], "at_utc": core.now()})
        raise ValueError(f"Dataset creation rejected: {status} {str(error)[:300]}")
    core.atomic(record, {"slug": f"{OWNER}/{slug}", "state": "created", "inventory": inventory, "at_utc": core.now()})
    return {"slug": f"{OWNER}/{slug}", "files": len(inventory)}


def data_dataset(api) -> dict:
    record = json.loads((DEST / "data-dataset.json").read_text())
    from kagglesdk.datasets.types.dataset_api_service import ApiGetDatasetRequest
    with api.build_kaggle_client() as client:
        request = ApiGetDatasetRequest()
        request.owner_slug, request.dataset_slug = record["slug"].split("/", 1)
        response = client.datasets.dataset_api_client.get_dataset(request).to_json()
        response = json.loads(response) if isinstance(response, str) else response
    if response.get("isPrivate") is not True:
        raise ValueError("v2 data dataset must be private")
    return {"role": "v2-data", "slug": record["slug"], "dataset_id": response["id"],
            "version": response["currentVersionNumber"]}


def prepare(role: str, run_id: str | None, teacher_run: str | None, smoke: bool, hours: float, cache_run: str | None = None,
            teacher_from_base: bool = False) -> dict:
    api, token = auth()
    try:
        data = data_dataset(api)
    except Exception:
        data = None  # dataset not available: the notebook downloads the payload from the bucket
    nonce = uuid.uuid4().hex[:12]
    name = PREFIX + role + "-" + nonce
    folder = DEST / name
    folder.mkdir(parents=True, exist_ok=False)
    resume = run_id is not None
    run_id = run_id or f"pocket-v2-{role}-{nonce[:8]}"
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", run_id):
        raise ValueError("bad run id")
    recipe = dict(RECIPES[role])
    if smoke:
        recipe.update(max_steps=20, horizon=2000, eval_every=10, min_steps=10, patience=9, sweep=[])
    budget = int(hours * 3600)
    config = {"role": role, "run_id": run_id, "seed": 20261006, "bucket": True, "resume": resume,
              "time_budget_seconds": budget - 1500, "eval_reserve_seconds": 1500 if role == "teacher" else 900,
              "guidance": [1.5, 3.0], "precision": "fp16", "qc_max_cer": 0.6, "data_prefix": DATA_PREFIX, **recipe}
    if cache_run:
        config["cache_run_id"] = cache_run
    if role == "student":
        if not teacher_run:
            raise ValueError("--teacher-run is required for the student")
        config["teacher_run"] = teacher_run
        config["cache_run_id"] = teacher_run
        final = DEST / "logs" / teacher_run / "logs" / "teacher" / "final-state.json"  # from `logs --run-id`
        if not final.is_file():
            raise ValueError("Download the teacher logs first (logs --run-id); its selected guidance is required")
        config["guidance"] = json.loads(final.read_text())["selected_guidance"]
        config["teacher_from_base"] = bool(teacher_from_base)
    code = {n: (ROOT / "scripts/pocket_training" / n).read_text(encoding="utf-8") for n in CODE}
    for n, text in code.items():
        compile(text, n, "exec")
    hf = (ROOT / "runtime/huggingface-alystria-token.txt").read_text().strip()
    if not hf.startswith("hf_"):
        raise ValueError("Private checkpoint credential missing")
    source = ('import os\nos.environ["HF_TOKEN"] = ' + repr(hf) + '\n'
              + NOTEBOOK.replace("__NONCE__", nonce).replace("__CODE__", repr(code)).replace("__CONFIG__", repr(config)))
    compile(source, "pocket-v2-notebook.py", "exec")
    if token in source:
        raise ValueError("Kaggle credential leaked into the notebook")
    cell = lambda text: {"id": uuid.uuid4().hex[:12], "cell_type": "code", "execution_count": None,
                         "metadata": {}, "outputs": [], "source": text.splitlines(True)}
    notebook = {"nbformat": 4, "nbformat_minor": 5, "metadata": {"kernelspec": {
        "display_name": "Python 3", "language": "python", "name": "python3"}}, "cells": [cell(source)]}
    core.atomic(folder / "kernel.ipynb", notebook)
    datasets = FIXED + ([data] if data else [])
    meta = {"id": f"{OWNER}/{name}", "title": name.replace("-", " "), "code_file": "kernel.ipynb", "language": "python",
            "kernel_type": "notebook", "is_private": True, "dataset_sources": [d["slug"] for d in datasets], "kernel_sources": []}
    core.atomic(folder / "kernel-metadata.json", meta)
    core.atomic(folder / "approval.json", {
        "slug": meta["id"], "nonce": nonce, "purpose": PURPOSE, "policy": {"teacher": "pocket_crossref_teacher_v1",
        "student": "pocket_voice_guided_distill_v1"}[role], "role": role, "run_id": run_id, "resume": resume,
        "source_sha256": core.sha(folder / "kernel.ipynb"), "datasets": datasets, "timeout_seconds": budget,
        "quota_reserve_seconds": 0, "execution_type": "SAVE_AND_RUN_ALL", "contains_private_checkpoint_credential": True,
        "checkpoint_storage": {"kind": "private_bucket", "bucket_id": "alystria-ai/cyberpunk-pocket-rolling-checkpoints",
                               "path": "runs/" + run_id, "max_slots": 3},
        "automatic_model_promotion": False, "authorized_save_calls": 1, "launcher_sha256": core.sha(CORE_PATH),
        "v2_launcher_sha256": core.sha(Path(__file__)), "selected_ids": [], "config": config, "smoke": smoke,
        "user_approval": "relayed by the coordinator, 2026-10-06 (pre-approved run)"})
    return {"prepared": str(folder), "slug": meta["id"], "run_id": run_id, "timeout_seconds": budget}


def logs(run_id: str) -> dict:
    sys.path.insert(0, str(ROOT / "scripts"))
    token = (ROOT / "runtime/huggingface-alystria-token.txt").read_text().strip()
    from huggingface_hub import HfApi
    api = HfApi()
    out = DEST / "logs" / run_id
    base = f"runs/{run_id}/"
    files = []
    for prefix in ("logs/", "selected/teacher.json", "selected/student.json"):
        try:
            for entry in api.list_bucket_tree("alystria-ai/cyberpunk-pocket-rolling-checkpoints", prefix=base + prefix,
                                              recursive=True, token=token):
                if getattr(entry, "type", None) == "file":
                    files.append(entry.path)
        except Exception:
            pass
    for m in ("slot-0", "slot-1", "slot-2"):
        files.append(base + m + "/manifest.json")
    got = []
    for remote in files:
        local = out / remote[len(base):]
        local.parent.mkdir(parents=True, exist_ok=True)
        try:
            api.download_bucket_files("alystria-ai/cyberpunk-pocket-rolling-checkpoints", files=[(remote, str(local))],
                                      raise_on_missing_files=True, token=token)
            got.append(remote[len(base):])
        except Exception:
            pass
    return {"folder": str(out), "files": got}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=("upload-data", "prepare", "submit", "status", "stream", "logs"))
    parser.add_argument("--folder", type=Path)
    parser.add_argument("--role", choices=("teacher", "student"))
    parser.add_argument("--run-id")
    parser.add_argument("--teacher-run")
    parser.add_argument("--cache-run", help="reuse the latent cache of this earlier run")
    parser.add_argument("--teacher-from-base", action="store_true", help="student distils from the released 24-layer base")
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--hours", type=float, default=6.0)
    args = parser.parse_args()
    try:
        if args.action == "upload-data":
            result = upload_data()
        elif args.action == "prepare":
            result = prepare(args.role, args.run_id, args.teacher_run, args.smoke, args.hours, args.cache_run, args.teacher_from_base)
        elif args.action == "logs":
            result = logs(args.run_id)
        else:
            result = core.connected(args.folder, args.action, allowed_root=DEST, required_purpose=PURPOSE, name_prefix=PREFIX)
        print(json.dumps(result, indent=2, default=str))
    except Exception as error:
        message = re.sub(r"https?://\S+|hf_\w+|KGAT_\w+", "[redacted]", str(error))[:400]
        print(json.dumps({"failed": type(error).__name__, "message": message, "automatic_retry": False}))
        raise SystemExit(1) from None
