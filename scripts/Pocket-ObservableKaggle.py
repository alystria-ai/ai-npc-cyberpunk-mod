"""Prepare/submit/read one private, bounded 100-update observability probe.

Each generated folder permits one Save call. An uncertain response can only be
read back; it must never trigger an automatic retry. No accepted model is changed.
"""
from contextlib import redirect_stdout, redirect_stderr
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import re
import sys
import threading
import time
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LAUNCH = ROOT / "runtime/voice-data-expansion-20261004/a-continuation-launch-v1"
DEST = ROOT / "runtime/voice-data-expansion-20261005/observable-probes"
AUTH = ROOT / "runtime/research/submit-pocket-student-transfer-ddb133ba.py"
AUTH_SHA = "6d8728bab436a96aa13f73c575eb5c61f57643fa43989c1885f4454b8ffe5427"
OLD = LAUNCH / "full-job-teacher-278f55dd0e944d57"


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def now():
    return datetime.now(timezone.utc).isoformat()


def training_summary(entries, subset_size):
    result = {}
    for entry in entries:
        for line in str(entry.get("data", "")).splitlines():
            try:
                value = json.loads(line)
            except (ValueError, TypeError):
                continue
            if not isinstance(value, dict):
                continue
            if value.get("phase") == "optimizer_update":
                result["latest_update"] = {key: value.get(key) for key in (
                    "step", "total_steps", "loss", "learning_rate", "gradient_norm_unscaled", "seconds_per_update")}
                result["latest_update"]["diagnostic_subset_passes"] = value["step"] * 2 / subset_size
                result["latest_update"]["epoch_number"] = (value["step"] * 2 - 1) // subset_size + 1
            if value.get("phase") == "checkpoint_complete":
                result["last_saved_checkpoint"] = {key: value.get(key) for key in (
                    "checkpoint_step", "checkpoint_bytes", "checkpoint_sha256")}
            if value.get("event") == "phase_started":
                result["bootstrap_phase"] = value.get("phase")
    return result


def atomic(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".writing")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=True, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def download_ranges(url, destination, size):
    """Bound each CDN read; do not keep a gigabyte response in memory."""
    import requests
    width = 8 * 1024**2
    def fetch(start):
        end = min(size, start + width) - 1
        with requests.get(url, headers={"Range": f"bytes={start}-{end}"}, stream=True) as response:
            response.raise_for_status()
            if response.status_code != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{size}":
                raise ValueError("CDN did not honor the exact bounded model range")
            data = response.raw.read(end - start + 2)
            if len(data) != end - start + 1:
                raise ValueError("Model range length differs")
            return start, data
    received, reported = 0, -1
    with destination.open("wb") as stream, ThreadPoolExecutor(max_workers=4) as pool:
        stream.truncate(size)
        jobs = [pool.submit(fetch, start) for start in range(0, size, width)]
        for job in as_completed(jobs):
            start, data = job.result()
            stream.seek(start)
            stream.write(data)
            received += len(data)
            percent = int(received * 100 / size)
            if percent // 10 != reported:
                reported = percent // 10
                print(json.dumps({"event": "model_download_progress", "percent": percent,
                                  "bytes_received": received, "total_bytes": size}), flush=True)
        stream.flush()
        os.fsync(stream.fileno())


def prepare():
    worker = ROOT / "scripts/pocket_training/observable_probe_worker.py"
    tail = ROOT / "scripts/pocket_training/observable_kaggle_bootstrap.py"
    uploader = ROOT / "scripts/pocket_training/remote_checkpoints.py"
    # The user explicitly authorized this credential in the private generated
    # notebook. The token file and generated notebook are both Git ignored.
    private_token = (ROOT / "runtime/huggingface-checkpoint-token.txt").read_text().strip()
    if not re.fullmatch(r"hf_[A-Za-z0-9]+", private_token):
        raise ValueError("Checkpoint credential is missing or malformed")
    # Preserve the frozen long-run source and corpus. This new notebook is a
    # separately identified diagnostic with only selected native audio staged.
    binding = read(OLD / "launch-bindings.json")
    old_approval = read(OLD / "root-approval.json")
    archive = LAUNCH / "final-payload-v2" / binding["payload"]["archive_name"]
    if sha(archive) != binding["payload"]["archive_sha256"]:
        raise ValueError("Frozen input archive changed")
    with zipfile.ZipFile(archive) as bundle:
        rows = [json.loads(line) for line in bundle.read("data/train.jsonl").decode("utf-8").splitlines()]
    names = ["johnny-silverhand", "judy-alvarez", "panam-palmer", "jackie-welles",
             "evelyn-parker", "solomon-reed", "misty-olszewski", "mr-hands",
             "hanako-arasaka", "alex", "songbird", "rogue-amendiares",
             "takemura", "kerry-eurodyne", "viktor-vektor", "wakako-okada"]
    selected = []
    for name in names:
        choices = [row for row in rows if (row.get("character") or row.get("speaker_id") or row.get("speaker")) == name
                   and 2.5 <= row["duration"] <= 5.0 and len(row.get("words", [])) >= 3]
        if not choices:
            raise ValueError("No short qualified native training row for " + name)
        selected.append(sorted(choices, key=lambda row: row["id"])[0])
    nonce = uuid.uuid4().hex[:16]
    name = "cp2077-observable-" + nonce
    folder = DEST / name
    folder.mkdir(parents=True, exist_ok=False)
    binding.update(segment_id="probe-" + nonce, experiment_id="observable-" + nonce,
                   available_execution_seconds=3300, probe_steps=100,
                   selected_members=[row["path"] for row in selected], selected_rows=selected,
                   worker_source=worker.read_text(encoding="utf-8"), worker_sha256=sha(worker),
                   remote_checkpoint_source=uploader.read_text(encoding="utf-8"),
                   remote_checkpoint_sha256=sha(uploader))
    template = (LAUNCH / "kernel-template.py").read_text(encoding="utf-8")
    template = template.split("\ndef main():", 1)[0]
    # A Python string literal is necessary: rows contain quotes and line escapes.
    template = template.replace('"__FULL_A_BINDINGS_JSON__"', repr(json.dumps(binding)))
    template = template.replace('OUTPUT = Path("/kaggle/working") / (BINDINGS["role"] + "-results")',
                                'OUTPUT = Path("/kaggle/working/probe-results")')
    source = ('print("POCKET_PYTHON_ENTRY ' + nonce + '", flush=True)\n' + template
              + '\nos.environ["HF_TOKEN"] = ' + repr(private_token) + '\n' + tail.read_text(encoding="utf-8"))
    compile(source, "observable-kernel.py", "exec")
    cell = lambda value: {"id": uuid.uuid4().hex[:12], "cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": value.splitlines(True)}
    notebook = {"nbformat": 4, "nbformat_minor": 5, "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}},
        "cells": [cell('import datetime\nprint("POCKET_NOTEBOOK_STARTED ' + nonce + '", datetime.datetime.now(datetime.timezone.utc).isoformat(), flush=True)\n'), cell(source)]}
    atomic(folder / "kernel.ipynb", notebook)
    datasets = [item for item in old_approval["datasets"] if item["role"] in ("common", "a-initialization", "full-a-input")]
    metadata = {"id": "akshit40392/" + name, "title": name.replace("-", " "),
        "code_file": "kernel.ipynb", "language": "python", "kernel_type": "notebook",
        "is_private": True, "enable_gpu": True, "enable_tpu": False, "enable_internet": True,
        "dataset_sources": [item["slug"] for item in datasets], "kernel_sources": []}
    atomic(folder / "kernel-metadata.json", metadata)
    atomic(folder / "approval.json", {"slug": metadata["id"], "nonce": nonce,
        "purpose": "user_requested_100_update_observability_check", "updates": 100,
        "source_sha256": sha(folder / "kernel.ipynb"), "datasets": datasets,
        "timeout_seconds": 3600, "execution_type": "SAVE_AND_RUN_ALL",
        "contains_private_checkpoint_credential": True,
        "automatic_model_promotion": False, "authorized_save_calls": 1,
        "scope": "one GPU, two native samples per update; not full-recipe throughput or voice qualification",
        "worker_sha256": sha(worker), "bootstrap_sha256": sha(tail),
        "launcher_sha256": sha(__file__), "selected_ids": [row["id"] for row in selected]})
    return {"prepared": str(folder), "steps": 100, "source_sha256": sha(folder / "kernel.ipynb")}


def connected(folder, action):
    folder = folder.resolve()
    if folder.parent != DEST or not folder.name.startswith("cp2077-observable-"):
        raise ValueError("Exact owned probe folder required")
    approval, meta = read(folder / "approval.json"), read(folder / "kernel-metadata.json")
    if sha(AUTH) != AUTH_SHA or sha(folder / "kernel.ipynb") != approval["source_sha256"]:
        raise ValueError("Pinned authentication or notebook source changed")
    spec = importlib.util.spec_from_file_location("observable_auth", AUTH)
    auth = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(auth)
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        api, token = auth.authenticate()
    if token in (folder / "kernel.ipynb").read_text(encoding="utf-8"):
        raise ValueError("Credential found in notebook")
    import requests
    original_send = requests.Session.send
    def bounded(session, request, **kwargs):
        kwargs["timeout"] = (5, 35)
        return original_send(session, request, **kwargs)
    requests.Session.send = bounded
    try:
        from kagglesdk.kernels.types.kernels_api_service import (
            ApiSaveKernelRequest, ApiGetKernelSessionStatusRequest,
            ApiListKernelSessionOutputRequest, ApiGetAcceleratorQuotaStatisticsRequest)
        from kagglesdk.kernels.types.kernels_enums import KernelExecutionType
        with api.build_kaggle_client() as client:
            client._http_client._verbose = False
            client._http_client._session.mount("https://", requests.adapters.HTTPAdapter(max_retries=0))
            if action == "submit":
                if (folder / "attempt.json").exists():
                    raise ValueError("Save already claimed; use status, never resubmit")
                if approval["launcher_sha256"] != sha(__file__):
                    raise ValueError("Submission helper changed after preparation")
                from kagglesdk.datasets.types.dataset_api_service import ApiGetDatasetRequest
                for item in approval["datasets"]:
                    request = ApiGetDatasetRequest()
                    request.owner_slug, request.dataset_slug = item["slug"].split("/", 1)
                    response = client.datasets.dataset_api_client.get_dataset(request).to_json()
                    response = json.loads(response) if isinstance(response, str) else response
                    if not (response["id"] == item["dataset_id"] and response["isPrivate"] is True
                            and response["currentVersionNumber"] == item["version"] == 1):
                        raise ValueError("Private input identity changed")
                quota = client.kernels.kernels_api_client.get_accelerator_quota_statistics(ApiGetAcceleratorQuotaStatisticsRequest()).gpu_quota
                remaining = (quota.total_time_allowed - quota.time_used - quota.time_reserved).total_seconds()
                if remaining < approval["timeout_seconds"] + 25200:
                    raise ValueError("Probe would consume the student reserve")
                try:
                    existing = auth.get_kernel(client, approval["slug"])
                    if existing is not None and existing.metadata is not None:
                        raise ValueError("Fresh probe target already exists")
                except Exception as error:
                    if getattr(getattr(error, "response", None), "status_code", None) != 403:
                        raise
                request = ApiSaveKernelRequest()
                request.slug, request.new_title = approval["slug"], meta["title"]
                request.text = (folder / "kernel.ipynb").read_text(encoding="utf-8")
                request.language, request.kernel_type, request.is_private = "python", "notebook", True
                request.kernel_execution_type = KernelExecutionType.SAVE_AND_RUN_ALL
                request.enable_gpu, request.enable_tpu, request.enable_internet = True, False, True
                request.machine_shape, request.session_timeout_seconds = "NvidiaTeslaT4", approval["timeout_seconds"]
                request.dataset_data_sources = meta["dataset_sources"]
                request.kernel_data_sources, request.competition_data_sources, request.model_data_sources = [], [], []
                attempt = {"at_utc": now(), "slug": approval["slug"], "source_sha256": approval["source_sha256"],
                           "save_calls": 1, "state": "claimed_before_save", "quota_before_seconds": remaining}
                with (folder / "attempt.json").open("x", encoding="utf-8") as stream:
                    json.dump(attempt, stream, indent=2)
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    response = client.kernels.kernels_api_client.save_kernel(request)
                    if response.error or response.invalid_dataset_sources or response.invalid_kernel_sources:
                        raise ValueError("Provider rejected probe: " + re.sub(r"(?:KGAT_|hf_)\w+", "[redacted]", response.error))
                    if response.ref.removeprefix('/code/') != approval['slug'] or response.version_number != 1:
                        raise ValueError("Unexpected Save target/version")
                    attempt.update(state="save_acknowledged", kernel_id=response.kernel_id, version=1)
                except Exception as error:
                    attempt.update(state="unknown_or_rejected_no_retry", error_type=type(error).__name__)
                    atomic(folder / "attempt.json", attempt)
                    raise
                atomic(folder / "attempt.json", attempt)
                return attempt
            result = {"at_utc": now(), "slug": approval["slug"], "remote_mutations": 0}
            remote = auth.get_kernel(client, approval["slug"])
            remote_hash = auth.normalized_sha(remote.blob.source)
            # Kaggle normalizes notebook JSON whitespace/metadata. Compare every
            # executable cell verbatim, rather than accepting a changed program
            # or treating a JSON reserialization as a changed program.
            local_nb = read(folder / "kernel.ipynb")
            remote_nb = json.loads(remote.blob.source)
            def cells(notebook):
                return [(cell["cell_type"], ''.join(cell["source"])) for cell in notebook["cells"]]
            same_cells = cells(local_nb) == cells(remote_nb)
            atomic(folder / "source-readback.json", {
                "at_utc": now(), "kernel_id": remote.metadata.id,
                "version": remote.metadata.current_version_number, "private": remote.metadata.is_private,
                "submitted_file_sha256": approval["source_sha256"], "provider_file_sha256": remote_hash,
                "all_executable_cells_equal": same_cells})
            if (remote.metadata.is_private is not True or remote.metadata.current_version_number != 1
                    or not same_cells):
                raise ValueError("Remote source/version/private state differs")
            result["kernel_id"] = remote.metadata.id
            quota = client.kernels.kernels_api_client.get_accelerator_quota_statistics(ApiGetAcceleratorQuotaStatisticsRequest()).gpu_quota
            result["quota_seconds"] = {key: value.total_seconds() for key, value in (
                ("total", quota.total_time_allowed), ("used", quota.time_used), ("reserved", quota.time_reserved))}
            request = ApiGetKernelSessionStatusRequest()
            request.user_name, request.kernel_slug = approval["slug"].split("/", 1)
            status = client.kernels.kernels_api_client.get_kernel_session_status(request)
            result["status"] = str(status.status).rsplit(".", 1)[-1]
            if action == "stream":
                messages = queue.Queue()
                def consume():
                    try:
                        for entry in api.kernels_logs_stream(approval["slug"]):
                            messages.put(entry)
                    except Exception as error:
                        messages.put({"local_stream_error": type(error).__name__})
                    finally:
                        messages.put(None)
                threading.Thread(target=consume, daemon=True).start()
                deadline = time.monotonic() + 45
                result["events"] = []
                while time.monotonic() < deadline:
                    try:
                        entry = messages.get(timeout=min(1, max(.01, deadline-time.monotonic())))
                    except queue.Empty:
                        continue
                    if entry is None:
                        break
                    safe = json.loads(re.sub(r"(?:hf_|KGAT_)[A-Za-z0-9]+", "[redacted]",
                                             json.dumps(entry, default=str).replace(token, "[redacted]")))
                    result["events"].append(safe)
                    with (folder / "live-events.ndjson").open("a", encoding="utf-8") as stream:
                        stream.write(json.dumps({"received_at_utc": now(), "entry": safe}) + "\n")
                        stream.flush()
                        os.fsync(stream.fileno())
                result["live_events_received"] = len(result["events"])
                result.update(training_summary(result["events"], len(approval["selected_ids"])))
                atomic(folder / "live-stream-result.json", result)
                return {**result, "events": result["events"][-8:]}
            request = ApiListKernelSessionOutputRequest()
            request.user_name, request.kernel_slug = approval["slug"].split("/", 1)
            request.page_size = 200
            response = client.kernels.kernels_api_client.list_kernel_session_output(request)
            log = response.log or ""
            # Keep full provider log locally, present only a bounded tail.
            log = re.sub(r"(?:hf_|KGAT_)[A-Za-z0-9]+", "[redacted]", log.replace(token, "[redacted]"))
            (folder / "provider.log").write_text(log, encoding="utf-8")
            result.update(log_tail=log[-10000:], startup_observed="POCKET_NOTEBOOK_STARTED" in log or 'python_started' in log,
                          output_names=[item.file_name for item in response.files or []],
                          more_output_pages=bool(response.next_page_token))
            live_path = folder / "live-events.ndjson"
            if live_path.is_file():
                observed = [json.loads(line) for line in live_path.read_text(encoding="utf-8").splitlines()]
                entries = [item["entry"] for item in observed]
                result["startup_observed"] = result["startup_observed"] or any(
                    "POCKET_NOTEBOOK_STARTED" in str(item.get("data", "")) for item in entries)
                result["last_observed_live_progress"] = {
                    "received_at_utc": observed[-1]["received_at_utc"] if observed else None,
                    **training_summary(entries, len(approval["selected_ids"]))}
            atomic(folder / "status.json", result)
            if action == "download-first":
                if result["status"] != "COMPLETE" or response.next_page_token:
                    raise ValueError("Completed, bounded output inventory required before model retrieval")
                files = {item.file_name: item for item in response.files or []}
                collection_name = "probe-collection.json"
                if collection_name not in files:
                    raise ValueError("Completed probe has no published collection")
                incoming = requests.get(files[collection_name].url)
                incoming.raise_for_status()
                collection = incoming.json()
                if (collection.get("schema") != "pocket_observable_probe_v1"
                        or collection.get("segment_id") != "probe-" + approval["nonce"]
                        or collection.get("status") != "completed"
                        or collection.get("automatic_promotion") is not False):
                    raise ValueError("Published collection does not match this diagnostic")
                out = folder / "downloaded"
                out.mkdir(exist_ok=True)
                atomic(out / collection_name, collection)
                selected = [name for name in collection["files"] if name.startswith("probe-results/export-step000001/")
                            or name in ("probe-results/status.json", "probe-results/events.jsonl", "probe-results/probe-spec.json")]
                verified = []
                for name in selected:
                    destination = (out / name).resolve()
                    if not destination.is_relative_to(out.resolve()) or name not in files:
                        raise ValueError("Published file is outside the exact output inventory")
                    expected = collection["files"][name]
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if not destination.exists() or sha(destination) != expected["sha256"]:
                        temporary = destination.with_suffix(destination.suffix + ".partial")
                        if expected["bytes"] > 32*1024**2:
                            download_ranges(files[name].url, temporary, expected["bytes"])
                        else:
                            with requests.get(files[name].url, stream=True) as download:
                                download.raise_for_status()
                                with temporary.open("wb") as stream:
                                    count = 0
                                    for block in download.iter_content(65536):
                                        count += len(block)
                                        if count > expected["bytes"]:
                                            raise ValueError("Download exceeds its bound size")
                                        stream.write(block)
                                    stream.flush()
                                    os.fsync(stream.fileno())
                        if temporary.stat().st_size != expected["bytes"] or sha(temporary) != expected["sha256"]:
                            raise ValueError("Downloaded model/checkpoint evidence differs")
                        temporary.replace(destination)
                    verified.append({"file": name, **expected})
                completed = read(out / "probe-results/status.json")
                if completed.get("completed_updates") != 100 or completed.get("phase") != "completed":
                    raise ValueError("Worker did not confirm 100 successful updates")
                result = {"downloaded": verified, "completed_updates": 100, "automatic_promotion": False,
                          "folder": str(out), "verified_at_utc": now()}
                atomic(folder / "download-receipt.json", result)
            return result
    finally:
        requests.Session.send = original_send


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "submit", "status", "stream", "download-first"))
    parser.add_argument("--folder", type=Path)
    args = parser.parse_args()
    if args.action != "prepare" and args.folder is None:
        parser.error("--folder is required")
    try:
        print(json.dumps(prepare() if args.action == "prepare" else connected(args.folder, args.action), indent=2))
    except Exception as error:
        # Never echo arbitrary authenticated exception bodies or signed URLs.
        print(json.dumps({"failed": type(error).__name__, "automatic_retry": False}))
        raise SystemExit(1) from None
