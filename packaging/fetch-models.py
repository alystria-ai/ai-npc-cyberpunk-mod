"""Download the trained models a release needs from the private Hugging Face bucket.

Called by packaging/build-release.mjs (--models hf). The token comes from the HF_TOKEN
environment variable (a GitHub Actions secret) and is never printed. Every file is
checked against the SHA-256 recorded in the bucket's final/MANIFEST.json, so a release
can only contain the exact files that were backed up.

    python packaging/fetch-models.py --config packaging/release.config.json --cache DIR --report OUT.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    token = (os.environ.get("HF_TOKEN") or "").strip()
    if not token:
        print("HF_TOKEN is not set: add the HF_TOKEN secret, or build with --dry-run.", file=sys.stderr)
        return 2
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::add-mask::{token}", flush=True)
    from huggingface_hub import HfApi

    config = json.loads(args.config.read_text(encoding="utf-8"))["models"]
    api = HfApi(token=token)
    bucket = config["bucket"]
    cache = args.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)

    manifest_path = cache / config["manifest"]
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    api.download_bucket_files(bucket, [(config["manifest"], str(manifest_path))], raise_on_missing_files=True)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {entry["path"]: entry for entry in manifest["files"]}

    def fetch(paths: list[str]) -> dict[str, str]:
        wanted = []
        for remote in paths:
            if remote not in expected:
                raise SystemExit(f"{remote} is not listed in {config['manifest']}")
            local = cache / remote
            if local.is_file() and local.stat().st_size == expected[remote]["size"] and sha256(local) == expected[remote]["sha256"]:
                continue
            local.parent.mkdir(parents=True, exist_ok=True)
            wanted.append((remote, str(local)))
        if wanted:
            print(f"Downloading {len(wanted)} of {len(paths)} files.", flush=True)
            api.download_bucket_files(bucket, wanted, raise_on_missing_files=True)
        result = {}
        for remote in paths:
            local = cache / remote
            if sha256(local) != expected[remote]["sha256"]:
                raise SystemExit(f"{remote} does not match MANIFEST.json")
            result[remote] = str(local)
        return result

    files = fetch([group["bucket"] + name for group in config["groups"] for name in group["files"]])
    references = set()
    for group in config["groups"]:
        for name in group["files"]:
            if not name.endswith(".json") or "voices" not in name:
                continue
            voices = json.loads(Path(files[group["bucket"] + name]).read_text(encoding="utf-8")).get("voices", {})
            for descriptor in voices.values():
                if descriptor.get("status", "ready") == "ready":
                    reference = descriptor["reference"]
                    prefix = "runtime/voice-references/"
                    if not reference.startswith(prefix):
                        raise SystemExit(f"Unexpected reference path {reference}")
                    references.add(config["references"]["bucket"] + reference[len(prefix):])
    files.update(fetch(sorted(references)))
    args.report.write_text(json.dumps({"manifest": config["manifest"], "files": files}, indent=1), encoding="utf-8")
    print(f"Verified {len(files)} model files against {config['manifest']}.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
