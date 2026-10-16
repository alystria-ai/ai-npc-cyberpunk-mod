"""Read/download an exact private checkpoint; no writes to cloud."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
REPO = "alystria-ai/cyberpunk-pocket-training-checkpoints"
BUCKET = "alystria-ai/cyberpunk-pocket-rolling-checkpoints"
PROBE_ROOT = ROOT / "runtime/voice-data-expansion-20261005/observable-probes"
FULL_TEACHER_ROOT = ROOT / "runtime/voice-data-expansion-20261005/full-a-live"
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")


def now():
    return datetime.now(timezone.utc).isoformat()


def full_teacher_identity(folder, step):
    """Use the latest verified live publication, never infer a remote folder."""
    bindings = json.loads((folder / "launch-bindings.json").read_text(encoding="utf-8"))
    base = bindings.get("remote_checkpoint_run_id")
    if (bindings.get("role") != "teacher" or not isinstance(base, str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", base)):
        raise ValueError("Full teacher launch bindings are invalid")
    starts = set()
    events_path = folder / "live-events.ndjson"
    if not events_path.is_file():
        return None
    selected = None
    with events_path.open(encoding="utf-8") as stream:
        for line in stream:
            try:
                wrapper = json.loads(line)
                event = json.loads(wrapper["entry"]["data"])
            except (KeyError, TypeError, ValueError):
                continue
            if not isinstance(event, dict):
                continue
            if event.get("step") != step:
                continue
            if event.get("event") == "private_checkpoint_upload_start":
                run_id = event.get("run_id")
                if isinstance(run_id, str) and (run_id == base or re.fullmatch(re.escape(base) + r"-[0-9a-f]{12}", run_id)):
                    starts.add(run_id)
            if event.get("event") == "private_checkpoint_verified":
                if event.get("bucket_id") == BUCKET:
                    slot = event.get("slot")
                    prefix = event.get("path_in_bucket")
                    snapshot = event.get("snapshot_id")
                    manifest_sha = event.get("manifest_sha256")
                    if (base in starts and type(slot) is int and slot in (0, 1, 2)
                            and prefix == f"runs/{base}/slot-{slot}"
                            and isinstance(snapshot, str) and SHA256.fullmatch(snapshot)
                            and isinstance(manifest_sha, str) and SHA256.fullmatch(manifest_sha)):
                        selected = {"kind": "bucket", "run_id": base, "prefix": prefix,
                                    "slot": slot, "snapshot_id": snapshot,
                                    "manifest_sha256": manifest_sha}
                else:
                    prefix = event.get("path_in_repo")
                    commit = event.get("commit_oid")
                    if not isinstance(prefix, str) or not isinstance(commit, str) or not COMMIT.fullmatch(commit):
                        continue
                    match = re.fullmatch(r"runs/(" + re.escape(base) + r"-[0-9a-f]{12})/step-" + f"{step:06d}", prefix)
                    if match and match.group(1) in starts:
                        selected = {"kind": "repo", "run_id": match.group(1),
                                    "prefix": prefix, "commit_oid": commit}
    return selected


def read_bucket_manifest(api, token, folder, identity, step):
    """Fetch fresh marker bytes; Xet hash is a transport hash, not SHA-256."""
    remote = identity["prefix"] + "/manifest.json"
    temporary = folder / "remote-downloads" / f".bucket-manifest-{uuid.uuid4().hex}.json"
    temporary.parent.mkdir(exist_ok=True)
    try:
        api.download_bucket_files(BUCKET, files=[(remote, temporary)],
                                  raise_on_missing_files=True, token=token)
        with temporary.open("rb") as stream:
            actual_sha = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual_sha != identity["manifest_sha256"]:
            raise ValueError("Rolling checkpoint marker changed after its verified event")
        manifest = json.loads(temporary.read_text(encoding="utf-8"))
    finally:
        temporary.unlink(missing_ok=True)
    if (manifest.get("schema") != "private_pocket_rolling_checkpoint_v1"
            or manifest.get("bucket_id") != BUCKET
            or manifest.get("path_in_bucket") != identity["prefix"]
            or manifest.get("run_id") != identity["run_id"]
            or manifest.get("slot") != identity["slot"]
            or manifest.get("snapshot_id") != identity["snapshot_id"]
            or manifest.get("step") != step
            or manifest.get("quality_replacement") is not False
            or not isinstance(manifest.get("input_identity"), str)
            or not SHA256.fullmatch(manifest["input_identity"])):
        raise ValueError("Rolling checkpoint marker does not match the live run")
    return manifest


def read_bucket_checkpoint(api, token, folder, identity, step, download_checkpoint):
    info = api.bucket_info(BUCKET, token=token)
    if getattr(info, "id", None) != BUCKET or getattr(info, "private", None) is not True:
        raise ValueError("Checkpoint bucket is not the verified private target")
    manifest = read_bucket_manifest(api, token, folder, identity, step)
    expected = manifest.get("files", {}).get("last.pt")
    if (not isinstance(expected, dict) or type(expected.get("bytes")) is not int
            or expected["bytes"] <= 0 or not isinstance(expected.get("sha256"), str)
            or not SHA256.fullmatch(expected["sha256"])
            or not isinstance(expected.get("xet_hash"), str)):
        raise ValueError("Rolling checkpoint file metadata is invalid")
    remote_file = identity["prefix"] + "/last.pt"
    metadata = api.get_bucket_file_metadata(BUCKET, remote_file, token=token)
    if (metadata.size != expected["bytes"]
            or getattr(metadata.xet_file_data, "file_hash", None) != expected["xet_hash"]):
        raise ValueError("Rolling checkpoint object differs from its marker")
    record = {"at_utc": now(), "available": True, "step": step,
              "bucket_id": BUCKET, "bucket_private_verified": True,
              "slot": identity["slot"], "path_in_bucket": identity["prefix"],
              "snapshot_id": identity["snapshot_id"],
              "manifest_sha256": identity["manifest_sha256"],
              "input_identity": manifest["input_identity"],
              "checkpoint_bytes": expected["bytes"],
              "checkpoint_sha256_expected": expected["sha256"],
              "xet_transport_hash": expected["xet_hash"], "remote_mutations": 0}
    if download_checkpoint:
        out = folder / "remote-downloads" / "rolling" / identity["snapshot_id"]
        out.mkdir(parents=True, exist_ok=True)
        local = out / "last.pt"
        progress_file = folder / f"remote-step{step}-checkpoint-retrieval.json"
        record.update(download_started_utc=now(), state="downloading")
        progress_file.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"event": "checkpoint_download_started", "step": step,
                          "bucket_id": BUCKET, "snapshot_id": identity["snapshot_id"],
                          "bytes": expected["bytes"], "at_utc": now()}), flush=True)
        api.download_bucket_files(BUCKET, files=[(remote_file, local)],
                                  raise_on_missing_files=True, token=token)
        with local.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != expected["sha256"] or local.stat().st_size != expected["bytes"]:
            raise ValueError("Downloaded rolling checkpoint failed full SHA-256/size verification")
        # Slot contents are mutable. A rotation during download invalidates
        # this read even if the downloaded bytes happen to hash correctly.
        if read_bucket_manifest(api, token, folder, identity, step) != manifest:
            raise ValueError("Rolling checkpoint marker changed during download")
        latest_metadata = api.get_bucket_file_metadata(BUCKET, remote_file, token=token)
        if (latest_metadata.size != expected["bytes"]
                or getattr(latest_metadata.xet_file_data, "file_hash", None) != expected["xet_hash"]):
            raise ValueError("Rolling checkpoint slot rotated during download")
        record.update(state="download_verified", download_verified_utc=now(),
                      checkpoint_sha256=actual, local_checkpoint=str(local))
        progress_file.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", type=Path, required=True)
    parser.add_argument("--step", type=int, default=1)
    parser.add_argument("--download-model", action="store_true")
    parser.add_argument("--full-teacher", action="store_true")
    parser.add_argument("--download-checkpoint", action="store_true")
    parser.add_argument("--wait-seconds", type=int, default=0)
    args = parser.parse_args()
    folder = args.folder.resolve()
    expected_parent = FULL_TEACHER_ROOT if args.full_teacher else PROBE_ROOT
    if folder.parent != expected_parent or not folder.is_dir():
        raise ValueError("Exact owned checkpoint folder required")
    if args.step < 1 or (args.full_teacher and args.download_model) or (not args.full_teacher and args.download_checkpoint):
        raise ValueError("Invalid checkpoint identity")
    if not args.full_teacher:
        approval = json.loads((folder / "approval.json").read_text())
        nonce = approval["nonce"]
        if not re.fullmatch(r"[0-9a-f]{16}", nonce):
            raise ValueError("Invalid probe identity")
        run_id = "probe-" + nonce
        prefix = f"runs/{run_id}/step-{args.step:06d}"
    os.environ.update(HF_HUB_OFFLINE="0", HF_HUB_DISABLE_PROGRESS_BARS="1", HF_HUB_DISABLE_TELEMETRY="1")
    from huggingface_hub import HfApi, hf_hub_download
    token = (ROOT / "runtime/huggingface-alystria-token.txt").read_text().strip()
    api = HfApi(token=token)
    if str(api.whoami()["name"]).casefold() != "alystria-ai":
        raise ValueError("Wrong checkpoint account")
    if not 0 <= args.wait_seconds <= 1800:
        raise ValueError("Checkpoint wait must be bounded to at most thirty minutes")
    deadline = time.monotonic() + args.wait_seconds
    while True:
        if args.full_teacher:
            identity = full_teacher_identity(folder, args.step)
            if identity is None:
                if time.monotonic() >= deadline:
                    print(json.dumps({"at_utc": now(), "available": False, "step": args.step,
                                      "reason": "verified_publication_event_pending"}))
                    return
                time.sleep(min(10, max(0, deadline-time.monotonic())))
                continue
            if identity["kind"] == "bucket":
                print(json.dumps(read_bucket_checkpoint(api, token, folder, identity,
                    args.step, args.download_checkpoint), indent=2))
                return
            run_id, prefix, exact_commit = (identity["run_id"], identity["prefix"],
                                             identity["commit_oid"])
        manifest_name = prefix + "/manifest.json"
        repo = api.repo_info(REPO, repo_type="model", revision=exact_commit if args.full_teacher else None)
        if repo.private is not True:
            raise ValueError("Checkpoint repository is not private")
        revision = exact_commit if args.full_teacher else repo.sha
        if args.full_teacher and repo.sha != exact_commit:
            raise ValueError("Verified publication commit differs from private repository readback")
        paths = api.get_paths_info(REPO, paths=[manifest_name], revision=revision, repo_type="model")
        if paths or time.monotonic() >= deadline:
            break
        time.sleep(min(10, max(0, deadline-time.monotonic())))
    if not paths:
        print(json.dumps({"at_utc": now(), "available": False, "step": args.step}))
        return
    out = folder / "remote-downloads"
    out.mkdir(exist_ok=True)
    manifest_path = hf_hub_download(REPO, manifest_name, revision=revision, token=token, local_dir=out)
    manifest = json.loads(Path(manifest_path).read_text())
    if (manifest.get("schema") != "private_pocket_checkpoint_v1" or manifest.get("run_id") != run_id
            or manifest.get("step") != args.step or manifest.get("quality_replacement") is not False
            or manifest.get("repo_id") != REPO or manifest.get("path_in_repo") != prefix
            or not isinstance(manifest.get("input_identity"), str)
            or not SHA256.fullmatch(manifest["input_identity"])):
        raise ValueError("Remote checkpoint manifest does not match the requested run")
    record = {"at_utc": now(), "available": True, "step": args.step, "commit_oid": revision,
              "repo_private_verified": True, "input_identity": manifest["input_identity"],
              "files": manifest["files"], "remote_mutations": 0}
    if args.download_model:
        name = "export/model.safetensors"
        expected = manifest["files"][name]
        progress_file = folder / f"remote-step{args.step}-retrieval.json"
        record.update(download_started_utc=now(), state="downloading", model_bytes=expected["bytes"])
        progress_file.write_text(json.dumps(record, indent=2) + "\n")
        print(json.dumps({"event": "model_download_started", "step": args.step,
                          "commit_oid": revision, "bytes": expected["bytes"], "at_utc": now()}), flush=True)
        local = Path(hf_hub_download(REPO, prefix + "/" + name, revision=revision,
                                    token=token, local_dir=out))
        with local.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != expected["sha256"] or local.stat().st_size != expected["bytes"]:
            raise ValueError("Downloaded checkpoint model failed its hash/size check")
        record.update(state="download_verified", download_verified_utc=now(), model_sha256=actual,
                      local_model=str(local))
        progress_file.write_text(json.dumps(record, indent=2) + "\n")
    if args.download_checkpoint:
        name = "last.pt"
        expected = manifest["files"].get(name)
        if (not isinstance(expected, dict) or type(expected.get("bytes")) is not int
                or expected["bytes"] <= 0 or not isinstance(expected.get("sha256"), str)
                or not SHA256.fullmatch(expected["sha256"])):
            raise ValueError("Remote resumable checkpoint metadata is invalid")
        progress_file = folder / f"remote-step{args.step}-checkpoint-retrieval.json"
        record.update(download_started_utc=now(), state="downloading", checkpoint_bytes=expected["bytes"])
        progress_file.write_text(json.dumps(record, indent=2) + "\n")
        print(json.dumps({"event": "checkpoint_download_started", "step": args.step,
                          "commit_oid": revision, "bytes": expected["bytes"], "at_utc": now()}), flush=True)
        local = Path(hf_hub_download(REPO, prefix + "/" + name, revision=revision,
                                    token=token, local_dir=out))
        with local.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != expected["sha256"] or local.stat().st_size != expected["bytes"]:
            raise ValueError("Downloaded resumable checkpoint failed its hash/size check")
        record.update(state="download_verified", download_verified_utc=now(), checkpoint_sha256=actual,
                      local_checkpoint=str(local))
        progress_file.write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"failed": type(error).__name__, "remote_mutations": 0}))
        raise SystemExit(1) from None
