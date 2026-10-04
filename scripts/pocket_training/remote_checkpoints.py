"""Publish a frozen training checkpoint to an existing private model repo.

Call synchronously between optimizer updates, while ``last.pt`` and optional
exports are immutable. Every step gets its own folder and one Hub commit. A
submitted commit with an unknown outcome is read back, never blindly retried.

The default credential source in Kaggle is the ``HF_TOKEN`` secret. A token
argument is intended only for local qualification; tokens are never written to
manifests, receipts, or logs.
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
from typing import Any, Callable, Mapping


DEFAULT_REPO_ID = "akshitireddy/cyberpunk-pocket-training-checkpoints"
SCHEMA = "private_pocket_checkpoint_v1"
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_OID = re.compile(r"[0-9a-f]{40}\Z")
_RUN = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")


class UnknownCommitOutcome(RuntimeError):
    """A mutation may have reached the Hub; inspect the step path before retry."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temp.open("w", encoding="utf-8", newline="\n") as stream:
            json.dump(data, stream, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _exclusive_json(path: Path, data: dict[str, Any]) -> None:
    """Reserve an immutable local object before any remote mutation."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(data, stream, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def _credential(explicit_token: str | None) -> str:
    if explicit_token is not None:
        if not explicit_token.strip():
            raise ValueError("Explicit Hugging Face token is empty")
        return explicit_token
    try:
        from kaggle_secrets import UserSecretsClient

        value = UserSecretsClient().get_secret("HF_TOKEN")
    except Exception as exc:
        raise RuntimeError("Kaggle secret HF_TOKEN is unavailable") from exc
    if not value:
        raise RuntimeError("Kaggle secret HF_TOKEN is empty")
    return value


def _check_private(api: Any, repo_id: str, token: str, *, revision: str | None = None) -> Any:
    info = api.repo_info(repo_id=repo_id, repo_type="model", revision=revision, token=token)
    if getattr(info, "id", repo_id) != repo_id or getattr(info, "private", None) is not True:
        raise RuntimeError("Checkpoint target is not the verified private model repository")
    return info


def _check_account(api: Any, token: str) -> None:
    identity = api.whoami(token=token)
    if not isinstance(identity, dict) or str(identity.get("name", "")).casefold() != "akshitireddy":
        raise RuntimeError("Checkpoint token belongs to a different Hugging Face account")


def _safe_extra_name(name: str) -> str:
    path = PurePosixPath(name)
    if (not name or name.startswith("/") or "\\" in name or
            any(part in ("", ".", "..") for part in name.split("/")) or
            str(path) != name or name == "last.pt" or name == "manifest.json"):
        raise ValueError(f"Unsafe or reserved checkpoint export name: {name!r}")
    return name


def _read_remote_manifest(api: Any, downloader: Callable[..., str], repo_id: str,
                          prefix: str, token: str, *, revision: str) -> dict[str, Any] | None:
    manifest_path = f"{prefix}/manifest.json"
    found = api.get_paths_info(repo_id=repo_id, paths=[manifest_path], revision=revision,
                               repo_type="model", token=token)
    if not any(getattr(file, "path", None) == manifest_path for file in found):
        return None
    downloaded = downloader(repo_id=repo_id, filename=manifest_path, repo_type="model",
                            revision=revision, token=token)
    return json.loads(Path(downloaded).read_text(encoding="utf-8"))


def _lfs_sha(file: Any) -> str | None:
    lfs = getattr(file, "lfs", None)
    if isinstance(lfs, dict):
        return lfs.get("sha256")
    return getattr(lfs, "sha256", None)


def _verify_remote(api: Any, downloader: Callable[..., str], repo_id: str,
                   token: str, prefix: str, manifest: dict[str, Any], oid: str) -> dict[str, Any]:
    if not _OID.fullmatch(oid):
        raise RuntimeError("Hub did not provide an exact commit OID")
    _check_private(api, repo_id, token, revision=oid)
    remote_manifest = _read_remote_manifest(api, downloader, repo_id, prefix, token, revision=oid)
    if remote_manifest != manifest:
        raise RuntimeError("Checkpoint manifest differs at the returned commit")
    paths = [f"{prefix}/{name}" for name in manifest["files"]]
    found = api.get_paths_info(repo_id=repo_id, paths=paths, revision=oid,
                               repo_type="model", token=token)
    by_path = {getattr(file, "path", None): file for file in found}
    for name, expected in manifest["files"].items():
        path = f"{prefix}/{name}"
        remote = by_path.get(path)
        if remote is None or getattr(remote, "size", None) != expected["bytes"]:
            raise RuntimeError(f"Missing or size-mismatched remote checkpoint file: {name}")
        digest = _lfs_sha(remote)
        if digest is not None:
            if digest != expected["sha256"]:
                raise RuntimeError(f"Remote LFS SHA mismatch: {name}")
        elif name == "last.pt" or expected["bytes"] >= 10 * 1024 * 1024:
            raise RuntimeError(f"Large remote file has no verifiable LFS SHA: {name}")
        else:
            downloaded = downloader(repo_id=repo_id, filename=path, repo_type="model",
                                    revision=oid, token=token)
            if _sha256(Path(downloaded)) != expected["sha256"]:
                raise RuntimeError(f"Remote checkpoint file differs: {name}")
    return {"status": "remote_checkpoint_available", "repo_id": repo_id,
            "commit_oid": oid, "step": manifest["step"], "input_identity": manifest["input_identity"],
            "path_in_repo": prefix, "checkpoint_sha256": manifest["files"]["last.pt"]["sha256"]}


def publish_checkpoint(*, checkpoint: Path, step: int, input_identity: str,
                       run_id: str, state_dir: Path,
                       exports: Mapping[str, Path] | None = None,
                       repo_id: str = DEFAULT_REPO_ID, token: str | None = None,
                       api: Any = None, operation_add: Any = None,
                       downloader: Callable[..., str] | None = None) -> dict[str, Any]:
    """Commit one immutable step and verify it at the returned commit.

    ``exports`` maps relative names inside the step folder to local files.
    The caller must not change these files until this function returns.
    A previous ``submitted`` receipt prevents a second mutation if an earlier
    request's result is unknown. Reinvoke to recover it by readback.
    """
    if repo_id != DEFAULT_REPO_ID:
        raise ValueError("Checkpoint publishing is restricted to the configured private repo")
    if not _RUN.fullmatch(run_id) or type(step) is not int or step < 1:
        raise ValueError("run_id or checkpoint step is invalid")
    if not _HASH.fullmatch(input_identity):
        raise ValueError("Input identity must be a SHA-256 digest")
    checkpoint = Path(checkpoint).resolve(strict=True)
    state_dir = Path(state_dir).resolve()
    if checkpoint.name != "last.pt" or not checkpoint.is_file():
        raise ValueError("Only a complete resumable last.pt can be published")
    supplied = {"last.pt": checkpoint}
    for name, path in (exports or {}).items():
        name = _safe_extra_name(name)
        if name in supplied:
            raise ValueError(f"Duplicate checkpoint file name: {name}")
        supplied[name] = Path(path).resolve(strict=True)
    files = {name: {"bytes": path.stat().st_size, "sha256": _sha256(path)}
             for name, path in supplied.items()}
    if not files["last.pt"]["bytes"]:
        raise ValueError("Checkpoint is empty")
    prefix = f"runs/{run_id}/step-{step:06d}"
    local_manifest = state_dir / f"{run_id}-step-{step:06d}-manifest.json"
    attempt_path = state_dir / f"{run_id}-step-{step:06d}-attempt.json"
    if not local_manifest.exists():
        manifest = {"schema": SCHEMA, "repo_id": repo_id, "path_in_repo": prefix,
                    "run_id": run_id, "step": step, "input_identity": input_identity,
                    "created_utc": datetime.now(timezone.utc).isoformat(),
                    "files": files, "quality_replacement": False}
        try:
            _exclusive_json(local_manifest, manifest)
        except FileExistsError:
            pass
    manifest = json.loads(local_manifest.read_text(encoding="utf-8"))
    if (manifest.get("schema") != SCHEMA or manifest.get("step") != step or
            manifest.get("input_identity") != input_identity or
            manifest.get("repo_id") != repo_id or manifest.get("files") != files):
        raise RuntimeError("Existing immutable checkpoint manifest differs from local files")
    attempt = json.loads(attempt_path.read_text(encoding="utf-8")) if attempt_path.exists() else None
    if attempt is not None and (attempt.get("repo_id") != repo_id or
                                attempt.get("manifest_sha256") != _sha256(local_manifest)):
        raise RuntimeError("Existing mutation receipt differs from this immutable checkpoint")

    secret = _credential(token)
    if api is None or operation_add is None or downloader is None:
        from huggingface_hub import CommitOperationAdd, HfApi, hf_hub_download

        api = api if api is not None else HfApi()
        operation_add = operation_add if operation_add is not None else CommitOperationAdd
        downloader = downloader if downloader is not None else hf_hub_download
    _check_account(api, secret)
    info = _check_private(api, repo_id, secret)
    head = getattr(info, "sha", None)
    if not isinstance(head, str) or not _OID.fullmatch(head):
        raise RuntimeError("Private repository has no verifiable HEAD commit")
    remote = _read_remote_manifest(api, downloader, repo_id, prefix, secret, revision=head)
    if remote is not None:
        if remote != manifest:
            raise RuntimeError("Immutable remote step folder already contains different content")
        result = _verify_remote(api, downloader, repo_id, secret, prefix, manifest, head)
        _atomic_json(attempt_path, {"status": result["status"], "repo_id": repo_id,
                    "manifest_sha256": _sha256(local_manifest), "commit_oid": result["commit_oid"],
                    "verified_at_utc": datetime.now(timezone.utc).isoformat()})
        return result
    if attempt is not None:
        raise UnknownCommitOutcome("Earlier commit outcome is still unknown; no second mutation was sent")

    try:
        _exclusive_json(attempt_path, {"status": "submitted", "repo_id": repo_id,
                        "manifest_sha256": _sha256(local_manifest), "parent_commit": head,
                        "submitted_at_utc": datetime.now(timezone.utc).isoformat()})
    except FileExistsError as exc:
        raise UnknownCommitOutcome("Another publisher reserved this step; no duplicate mutation was sent") from exc
    operations = [operation_add(path_in_repo=f"{prefix}/{name}", path_or_fileobj=str(path))
                  for name, path in supplied.items()]
    operations.append(operation_add(path_in_repo=f"{prefix}/manifest.json",
                                    path_or_fileobj=str(local_manifest)))
    try:
        commit = api.create_commit(repo_id=repo_id, repo_type="model", token=secret,
                                   operations=operations, commit_message=f"Save {run_id} step {step}",
                                   parent_commit=head, num_threads=2, run_as_future=False)
    except Exception as exc:
        # A network failure may happen after the server accepted the commit.
        # Read HEAD once. An absent manifest keeps the submitted receipt, which
        # blocks automatic resubmission on the next invocation.
        try:
            current = _check_private(api, repo_id, secret)
            current_oid = getattr(current, "sha", "")
            if _OID.fullmatch(current_oid):
                seen = _read_remote_manifest(api, downloader, repo_id, prefix, secret, revision=current_oid)
                if seen == manifest:
                    result = _verify_remote(api, downloader, repo_id, secret,
                                            prefix, manifest, current_oid)
                    _atomic_json(attempt_path, {"status": result["status"], "repo_id": repo_id,
                                "manifest_sha256": _sha256(local_manifest),
                                "commit_oid": current_oid, "recovered_after_unknown": True})
                    return result
        except Exception:
            pass
        raise UnknownCommitOutcome("Commit outcome unknown; retained submitted receipt for readback") from exc
    oid = getattr(commit, "oid", None)
    result = _verify_remote(api, downloader, repo_id, secret, prefix, manifest, oid)
    for name, path in supplied.items():
        if path.stat().st_size != files[name]["bytes"] or _sha256(path) != files[name]["sha256"]:
            raise RuntimeError(f"Local checkpoint changed while upload was in progress: {name}")
    _atomic_json(attempt_path, {"status": result["status"], "repo_id": repo_id,
                "manifest_sha256": _sha256(local_manifest), "commit_oid": oid,
                "verified_at_utc": datetime.now(timezone.utc).isoformat()})
    return result


def main(argv: list[str] | None = None) -> int:
    """Run in a separate process after the trainer freezes one checkpoint."""
    parser = argparse.ArgumentParser(description="Verify and publish one private training checkpoint")
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--step", required=True, type=int)
    parser.add_argument("--input-identity", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--exports-json", type=Path)
    args = parser.parse_args(argv)
    os.environ["HF_HUB_OFFLINE"] = "0"
    os.environ["TRANSFORMERS_OFFLINE"] = "0"
    print(json.dumps({"event": "remote_checkpoint_start", "step": args.step}), flush=True)
    try:
        exports = None
        if args.exports_json is not None:
            parsed = json.loads(args.exports_json.read_text(encoding="utf-8"))
            if not isinstance(parsed, dict) or any(not isinstance(k, str) or not isinstance(v, str)
                                                   for k, v in parsed.items()):
                raise ValueError("--exports-json must contain a string-to-string path mapping")
            if any(not Path(path).is_absolute() for path in parsed.values()):
                raise ValueError("--exports-json must use absolute local file paths")
            exports = {name: Path(path) for name, path in parsed.items()}
        result = publish_checkpoint(
            checkpoint=args.checkpoint, step=args.step, input_identity=args.input_identity,
            run_id=args.run_id, state_dir=args.state_dir, exports=exports,
            token=os.environ.get("HF_TOKEN") or None,
        )
    except Exception as exc:
        # Authentication and network exceptions can contain credentials or URLs.
        print(json.dumps({"event": "remote_checkpoint_failed", "step": args.step,
                          "exception_type": type(exc).__name__}), flush=True)
        return 1
    print(json.dumps({"event": "remote_checkpoint_available", "step": args.step,
                      "commit_oid": result["commit_oid"], "path_in_repo": result["path_in_repo"]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
