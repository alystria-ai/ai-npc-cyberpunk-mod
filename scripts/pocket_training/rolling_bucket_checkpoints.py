"""Keep at most three verified, resumable checkpoints in a private HF bucket.

This is intentionally a mutable bucket, not a model repository with Git history.
The three slot prefixes are fixed for one experiment. A manifest is the last
file written in a slot; an absent manifest means that slot is incomplete.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import uuid
from typing import Any, Mapping

BUCKET_ID = "alystria-ai/cyberpunk-pocket-rolling-checkpoints"
SCHEMA = "private_pocket_rolling_checkpoint_v1"
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_RUN = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
_SLOTS = range(3)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, sort_keys=True, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _exclusive_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, sort_keys=True, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def _safe_name(name: str) -> str:
    if (not isinstance(name, str) or not name or name.startswith("/") or "\\" in name
            or any(part in ("", ".", "..") for part in name.split("/"))
            or PurePosixPath(name).as_posix() != name
            or name in ("last.pt", "manifest.json")):
        raise ValueError("Unsafe checkpoint export name")
    return name


def _credential(explicit: str | None) -> str:
    if explicit is not None:
        if not explicit.strip():
            raise ValueError("Checkpoint token is empty")
        return explicit
    value = os.environ.get("HF_TOKEN")
    if not value:
        try:
            from kaggle_secrets import UserSecretsClient
            value = UserSecretsClient().get_secret("HF_TOKEN")
        except Exception as exc:
            raise RuntimeError("Private checkpoint credential is unavailable") from exc
    if not value:
        raise RuntimeError("Private checkpoint credential is empty")
    return value


def _private_owner(api: Any, token: str) -> None:
    account = api.whoami(token=token)
    info = api.bucket_info(BUCKET_ID, token=token)
    if (not isinstance(account, dict) or str(account.get("name", "")).casefold() != "alystria-ai"
            or getattr(info, "id", None) != BUCKET_ID or getattr(info, "private", None) is not True):
        raise RuntimeError("Checkpoint bucket/account is not the verified private target")


def _prefix(run_id: str, slot: int) -> str:
    if slot not in _SLOTS:
        raise ValueError("Checkpoint slot must be 0, 1 or 2")
    return f"runs/{run_id}/slot-{slot}"


def _tree(api: Any, token: str, run_id: str) -> dict[str, Any]:
    base = f"runs/{run_id}/"
    result: dict[str, Any] = {}
    for entry in api.list_bucket_tree(BUCKET_ID, prefix=base, recursive=True, token=token):
        if getattr(entry, "type", None) != "file":
            continue
        path = getattr(entry, "path", None)
        if not isinstance(path, str) or not path.startswith(base):
            raise RuntimeError("Bucket listing escaped the owned experiment prefix")
        relative = path[len(base):]
        if not re.fullmatch(r"slot-[012]/.+|slot-[012]-reservation\.json", relative):
            raise RuntimeError("Unexpected object inside the checkpoint experiment")
        result[path] = entry
    return result


def _download_manifest(api: Any, token: str, remote: str, state_dir: Path) -> dict[str, Any]:
    temporary = state_dir / f".readback-{uuid.uuid4().hex}.json"
    try:
        api.download_bucket_files(BUCKET_ID, files=[(remote, temporary)],
                                  raise_on_missing_files=True, token=token)
        return json.loads(temporary.read_text(encoding="utf-8"))
    finally:
        temporary.unlink(missing_ok=True)


def _manifest_at(api: Any, token: str, tree: dict[str, Any],
                 run_id: str, slot: int, state_dir: Path) -> dict[str, Any] | None:
    prefix = _prefix(run_id, slot)
    path = prefix + "/manifest.json"
    if path not in tree:
        return None
    manifest = _download_manifest(api, token, path, state_dir)
    if (manifest.get("schema") != SCHEMA or manifest.get("bucket_id") != BUCKET_ID
            or manifest.get("run_id") != run_id or manifest.get("slot") != slot
            or manifest.get("path_in_bucket") != prefix
            or type(manifest.get("sequence")) is not int or manifest["sequence"] < 1
            or type(manifest.get("step")) is not int or manifest["step"] < 1
            or not isinstance(manifest.get("snapshot_id"), str)
            or not _HASH.fullmatch(manifest["snapshot_id"])
            or not isinstance(manifest.get("input_identity"), str)
            or not _HASH.fullmatch(manifest["input_identity"])
            or not isinstance(manifest.get("files"), dict)
            or "last.pt" not in manifest["files"]):
        raise RuntimeError("Completed bucket slot has an invalid manifest")
    for name, expected in manifest["files"].items():
        if name != "last.pt":
            _safe_name(name)
        remote = prefix + "/" + name
        item = tree.get(remote)
        if (item is None or type(expected.get("bytes")) is not int
                or expected["bytes"] <= 0 or getattr(item, "size", None) != expected["bytes"]
                or not isinstance(expected.get("sha256"), str) or not _HASH.fullmatch(expected["sha256"])
                or not isinstance(expected.get("xet_hash"), str)
                or getattr(item, "xet_hash", None) != expected["xet_hash"]):
            raise RuntimeError("Completed bucket slot has missing or changed files")
    expected_paths = {prefix + "/" + name for name in manifest["files"]} | {path}
    if {name for name in tree if name.startswith(prefix + "/")} != expected_paths:
        raise RuntimeError("Completed bucket slot has unexpected files")
    return manifest


def _result(manifest: dict[str, Any], manifest_hash: str) -> dict[str, Any]:
    return {"status": "remote_checkpoint_available", "bucket_id": BUCKET_ID,
            "step": manifest["step"], "slot": manifest["slot"],
            "path_in_bucket": manifest["path_in_bucket"],
            "snapshot_id": manifest["snapshot_id"], "manifest_sha256": manifest_hash,
            "input_identity": manifest["input_identity"]}


def _reservation_path(run_id: str, slot: int) -> str:
    return f"runs/{run_id}/slot-{slot}-reservation.json"


def _reservation_record(attempt: dict[str, Any]) -> dict[str, Any]:
    return {key: attempt[key] for key in ("schema", "run_id", "snapshot_id",
        "input_identity", "step", "files", "slot", "sequence")}


def publish_checkpoint(*, checkpoint: Path, step: int, input_identity: str,
                       run_id: str, state_dir: Path,
                       exports: Mapping[str, Path] | None = None,
                       token: str | None = None, api: Any = None) -> dict[str, Any]:
    """Replace only the oldest of three fixed slots; verify before marking complete.

    A failed or interrupted replacement leaves its slot without a manifest.
    The other two complete slots remain readable. The local attempt pins the
    selected slot for an idempotent restart of the same snapshot.
    """
    if not _RUN.fullmatch(run_id) or type(step) is not int or step < 1:
        raise ValueError("Invalid experiment ID or optimizer step")
    if not _HASH.fullmatch(input_identity):
        raise ValueError("Input identity must be a SHA-256 digest")
    checkpoint = Path(checkpoint).resolve(strict=True)
    if checkpoint.name != "last.pt" or not checkpoint.is_file():
        raise ValueError("Only a full resumable last.pt can be published")
    state_dir = Path(state_dir).resolve()
    state_dir.mkdir(parents=True, exist_ok=True)
    sources: dict[str, Path] = {"last.pt": checkpoint}
    for name, path in (exports or {}).items():
        sources[_safe_name(name)] = Path(path).resolve(strict=True)
    files = {name: {"bytes": path.stat().st_size, "sha256": _sha256(path)}
             for name, path in sorted(sources.items())}
    if any(item["bytes"] <= 0 for item in files.values()):
        raise ValueError("Empty checkpoint file")
    snapshot_id = hashlib.sha256(json.dumps({"step": step, "input_identity": input_identity,
        "files": files}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    secret = _credential(token)
    if api is None:
        from huggingface_hub import HfApi
        api = HfApi(token=secret)
    _private_owner(api, secret)
    tree = _tree(api, secret, run_id)
    complete = {slot: _manifest_at(api, secret, tree, run_id, slot, state_dir) for slot in _SLOTS}
    reservations = {slot: _download_manifest(api, secret, _reservation_path(run_id, slot), state_dir)
                    for slot in _SLOTS if _reservation_path(run_id, slot) in tree}
    if len(reservations) > 1:
        raise RuntimeError("More than one rolling replacement is in progress")
    for slot, manifest in complete.items():
        if manifest is not None and manifest["snapshot_id"] == snapshot_id:
            if (manifest["step"] != step or manifest["input_identity"] != input_identity
                    or {name: {key: value[key] for key in ("bytes", "sha256")}
                        for name, value in manifest["files"].items()} != files):
                raise RuntimeError("Snapshot identity collided with different checkpoint files")
            if reservations:
                if reservations.get(slot, {}).get("snapshot_id") != snapshot_id:
                    raise RuntimeError("A different replacement owns another bucket slot")
                api.batch_bucket_files(BUCKET_ID, delete=[_reservation_path(run_id, slot)], token=secret)
                if _reservation_path(run_id, slot) in _tree(api, secret, run_id):
                    raise RuntimeError("Completed slot reservation remains")
            return _result(manifest, hashlib.sha256(json.dumps(manifest, sort_keys=True,
                indent=2, allow_nan=False).encode() + b"\n").hexdigest())
    attempt_path = state_dir / f"{run_id}-{snapshot_id[:16]}-attempt.json"
    attempt = json.loads(attempt_path.read_text(encoding="utf-8")) if attempt_path.exists() else None
    if attempt is None:
        if reservations:
            slot, reservation = next(iter(reservations.items()))
            if (reservation.get("schema") != SCHEMA or reservation.get("run_id") != run_id
                    or reservation.get("snapshot_id") != snapshot_id
                    or reservation.get("input_identity") != input_identity
                    or reservation.get("step") != step or reservation.get("files") != files
                    or reservation.get("slot") != slot
                    or type(reservation.get("sequence")) is not int):
                raise RuntimeError("Another snapshot owns an unfinished bucket replacement")
            attempt = {**reservation, "status": "uploading", "uploaded_xet": {}}
            _exclusive_json(attempt_path, attempt)
        else:
            unfinished = [slot for slot in _SLOTS if complete[slot] is None and any(
                path.startswith(_prefix(run_id, slot) + "/") for path in tree)]
            if unfinished:
                raise RuntimeError("A prior bucket slot is incomplete without a recovery reservation")
            empty = [slot for slot in _SLOTS if complete[slot] is None]
            slot = min(empty) if empty else min(_SLOTS, key=lambda index: complete[index]["sequence"])
            sequence = max((item["sequence"] for item in complete.values() if item), default=0) + 1
            attempt = {"schema": SCHEMA, "run_id": run_id, "snapshot_id": snapshot_id,
                       "input_identity": input_identity, "step": step, "files": files,
                       "slot": slot, "sequence": sequence, "status": "planned",
                       "created_utc": datetime.now(timezone.utc).isoformat(), "uploaded_xet": {}}
            try:
                _exclusive_json(attempt_path, attempt)
            except FileExistsError:
                raise RuntimeError("Another publisher reserved the same checkpoint") from None
    elif (attempt.get("schema") != SCHEMA or attempt.get("run_id") != run_id
          or attempt.get("snapshot_id") != snapshot_id or attempt.get("files") != files
          or attempt.get("input_identity") != input_identity or attempt.get("step") != step
          or attempt.get("slot") not in _SLOTS):
        raise RuntimeError("Existing local attempt differs from this checkpoint")
    slot = attempt["slot"]
    prefix = _prefix(run_id, slot)
    marker = prefix + "/manifest.json"
    reservation_path = _reservation_path(run_id, slot)
    reservation = _reservation_record(attempt)
    if reservations and reservations.get(slot) != reservation:
        raise RuntimeError("Bucket reservation differs from the local snapshot")
    other_complete = [item for index, item in complete.items() if index != slot and item]
    if complete[slot] is not None and complete[slot]["sequence"] > attempt["sequence"]:
        raise RuntimeError("A newer completed checkpoint owns this slot")
    if reservation_path not in tree:
        reservation_file = state_dir / f"{run_id}-{snapshot_id[:16]}-reservation.json"
        if reservation_file.exists():
            if json.loads(reservation_file.read_text(encoding="utf-8")) != reservation:
                raise RuntimeError("Local recovery reservation differs")
        else:
            _exclusive_json(reservation_file, reservation)
        api.batch_bucket_files(BUCKET_ID, add=[(reservation_file, reservation_path)], token=secret)
        tree = _tree(api, secret, run_id)
        if reservation_path not in tree or _download_manifest(api, secret, reservation_path, state_dir) != reservation:
            raise RuntimeError("Bucket recovery reservation is not readable")
    # Remove the old marker first. The bucket batch API is non-transactional;
    # read back each phase and never touch either of the other two slots.
    if marker in tree:
        api.batch_bucket_files(BUCKET_ID, delete=[marker], token=secret)
        tree = _tree(api, secret, run_id)
        if marker in tree:
            raise RuntimeError("Old slot completion marker remains after deletion")
    remaining = sorted(path for path in tree if path.startswith(prefix + "/"))
    if remaining and attempt.get("status") == "planned":
        api.batch_bucket_files(BUCKET_ID, delete=remaining, token=secret)
        tree = _tree(api, secret, run_id)
        if any(path.startswith(prefix + "/") for path in tree):
            raise RuntimeError("Old slot objects remain after deletion")
    attempt["status"] = "uploading"
    _atomic_json(attempt_path, attempt)
    observed_xet = dict(attempt.get("uploaded_xet", {}))
    for name, source in sources.items():
        remote = prefix + "/" + name
        current = _tree(api, secret, run_id).get(remote)
        if (current is None or getattr(current, "size", None) != files[name]["bytes"]
                or observed_xet.get(name) != getattr(current, "xet_hash", None)):
            if _sha256(source) != files[name]["sha256"]:
                raise RuntimeError("Local checkpoint changed before upload")
            api.batch_bucket_files(BUCKET_ID, add=[(source, remote)], token=secret)
            current = _tree(api, secret, run_id).get(remote)
        if (current is None or getattr(current, "size", None) != files[name]["bytes"]
                or not isinstance(getattr(current, "xet_hash", None), str)):
            raise RuntimeError("Uploaded checkpoint file is missing or size-mismatched")
        if _sha256(source) != files[name]["sha256"]:
            raise RuntimeError("Local checkpoint changed during upload")
        observed_xet[name] = current.xet_hash
        attempt["uploaded_xet"] = observed_xet
        _atomic_json(attempt_path, attempt)
    manifest = {"schema": SCHEMA, "bucket_id": BUCKET_ID, "run_id": run_id,
                "path_in_bucket": prefix, "slot": slot, "sequence": attempt["sequence"],
                "step": step, "input_identity": input_identity, "snapshot_id": snapshot_id,
                "files": {name: {**details, "xet_hash": observed_xet[name]}
                          for name, details in files.items()},
                "quality_replacement": False}
    manifest_path = state_dir / f"{run_id}-{snapshot_id[:16]}-manifest.json"
    if manifest_path.exists():
        if json.loads(manifest_path.read_text(encoding="utf-8")) != manifest:
            raise RuntimeError("Local immutable slot manifest differs")
    else:
        _exclusive_json(manifest_path, manifest)
    api.batch_bucket_files(BUCKET_ID, add=[(manifest_path, marker)], token=secret)
    final_tree = _tree(api, secret, run_id)
    remote = _manifest_at(api, secret, final_tree, run_id, slot, state_dir)
    if remote != manifest:
        raise RuntimeError("Final private bucket readback differs from local manifest")
    # Ensure an interrupted replacement never modified either retained slot.
    for item in other_complete:
        if _manifest_at(api, secret, final_tree, run_id, item["slot"], state_dir) != item:
            raise RuntimeError("A retained checkpoint changed during slot replacement")
    api.batch_bucket_files(BUCKET_ID, delete=[reservation_path], token=secret)
    if reservation_path in _tree(api, secret, run_id):
        raise RuntimeError("Completed slot recovery reservation remains")
    attempt["status"] = "remote_checkpoint_available"
    attempt["verified_utc"] = datetime.now(timezone.utc).isoformat()
    _atomic_json(attempt_path, attempt)
    return _result(manifest, _sha256(manifest_path))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--step", required=True, type=int)
    parser.add_argument("--input-identity", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--exports-json", type=Path)
    args = parser.parse_args(argv)
    os.environ.update(HF_HUB_OFFLINE="0", TRANSFORMERS_OFFLINE="0",
                      HF_HUB_DISABLE_PROGRESS_BARS="1", HF_HUB_DISABLE_TELEMETRY="1")
    print(json.dumps({"event": "remote_checkpoint_start", "step": args.step}), flush=True)
    try:
        exports = None
        if args.exports_json is not None:
            parsed = json.loads(args.exports_json.read_text(encoding="utf-8"))
            if (not isinstance(parsed, dict) or any(not isinstance(k, str) or not isinstance(v, str)
                                                     or not Path(v).is_absolute() for k, v in parsed.items())):
                raise ValueError("Invalid absolute export mapping")
            exports = {name: Path(path) for name, path in parsed.items()}
        result = publish_checkpoint(checkpoint=args.checkpoint, step=args.step,
            input_identity=args.input_identity, run_id=args.run_id,
            state_dir=args.state_dir, exports=exports)
    except Exception as exc:
        # Network exceptions and URLs may contain credentials. Never print them.
        print(json.dumps({"event": "remote_checkpoint_failed", "step": args.step,
                          "exception_type": type(exc).__name__}), flush=True)
        return 1
    print(json.dumps({"event": "remote_checkpoint_available", "step": result["step"],
                      "bucket_id": result["bucket_id"], "slot": result["slot"],
                      "path_in_bucket": result["path_in_bucket"],
                      "snapshot_id": result["snapshot_id"],
                      "manifest_sha256": result["manifest_sha256"]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
