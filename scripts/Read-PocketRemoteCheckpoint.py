"""Read/download a private checkpoint at an immutable Hub commit; no writes to cloud."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
REPO = "akshitireddy/cyberpunk-pocket-training-checkpoints"


def now():
    return datetime.now(timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", type=Path, required=True)
    parser.add_argument("--step", type=int, default=1)
    parser.add_argument("--download-model", action="store_true")
    args = parser.parse_args()
    folder = args.folder.resolve()
    if folder.parent != ROOT / "runtime/voice-data-expansion-20261005/observable-probes":
        raise ValueError("Exact owned probe folder required")
    approval = json.loads((folder / "approval.json").read_text())
    nonce = approval["nonce"]
    if not re.fullmatch(r"[0-9a-f]{16}", nonce) or args.step < 1:
        raise ValueError("Invalid checkpoint identity")
    run_id = "probe-" + nonce
    prefix = f"runs/{run_id}/step-{args.step:06d}"
    os.environ.update(HF_HUB_OFFLINE="0", HF_HUB_DISABLE_PROGRESS_BARS="1", HF_HUB_DISABLE_TELEMETRY="1")
    from huggingface_hub import HfApi, hf_hub_download
    token = (ROOT / "runtime/huggingface-checkpoint-token.txt").read_text().strip()
    api = HfApi(token=token)
    if api.whoami()["name"] != "akshitireddy":
        raise ValueError("Wrong checkpoint account")
    repo = api.repo_info(REPO, repo_type="model")
    if repo.private is not True:
        raise ValueError("Checkpoint repository is not private")
    manifest_name = prefix + "/manifest.json"
    paths = api.get_paths_info(REPO, paths=[manifest_name], revision=repo.sha)
    if not paths:
        print(json.dumps({"at_utc": now(), "available": False, "step": args.step}))
        return
    out = folder / "remote-downloads"
    out.mkdir(exist_ok=True)
    manifest_path = hf_hub_download(REPO, manifest_name, revision=repo.sha, token=token, local_dir=out)
    manifest = json.loads(Path(manifest_path).read_text())
    if (manifest.get("schema") != "private_pocket_checkpoint_v1" or manifest.get("run_id") != run_id
            or manifest.get("step") != args.step or manifest.get("quality_replacement") is not False):
        raise ValueError("Remote checkpoint manifest does not match the requested run")
    record = {"at_utc": now(), "available": True, "step": args.step, "commit_oid": repo.sha,
              "repo_private_verified": True, "input_identity": manifest["input_identity"],
              "files": manifest["files"], "remote_mutations": 0}
    if args.download_model:
        name = "export/model.safetensors"
        expected = manifest["files"][name]
        progress_file = folder / f"remote-step{args.step}-retrieval.json"
        record.update(download_started_utc=now(), state="downloading", model_bytes=expected["bytes"])
        progress_file.write_text(json.dumps(record, indent=2) + "\n")
        print(json.dumps({"event": "model_download_started", "step": args.step,
                          "commit_oid": repo.sha, "bytes": expected["bytes"], "at_utc": now()}), flush=True)
        local = Path(hf_hub_download(REPO, prefix + "/" + name, revision=repo.sha,
                                    token=token, local_dir=out))
        with local.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != expected["sha256"] or local.stat().st_size != expected["bytes"]:
            raise ValueError("Downloaded checkpoint model failed its hash/size check")
        record.update(state="download_verified", download_verified_utc=now(), model_sha256=actual,
                      local_model=str(local))
        progress_file.write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"failed": type(error).__name__, "remote_mutations": 0}))
        raise SystemExit(1) from None
