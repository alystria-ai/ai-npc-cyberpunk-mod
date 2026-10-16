"""Download the trained models a release needs from the private Hugging Face bucket.

Called by packaging/build-release.mjs (--models hf). The token comes from the HF_TOKEN
environment variable (a GitHub Actions secret) and is never printed. Every file is
checked against the SHA-256 recorded in the bucket's final/MANIFEST.json, so a release
can only contain the exact files that were backed up.

    python packaging/fetch-models.py --config packaging/release.config.json --cache DIR --report OUT.json
    python packaging/fetch-models.py --config packaging/release.config.json --cache DIR --report OUT.json --mature

With --mature it fetches only the two Mature pack models from the bucket's mirror (maturePack.mirror in the config: a
prefix outside final/, with its own MANIFEST.json), each checked against the size and SHA-256 pinned in maturePack.tiers.
A model the mirror does not have (or a missing token) is left out of the report, and the builder then downloads that
model from its pinned public Hugging Face URL instead. A mirror file that is present but differs from the pin is an error.
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


def fetch_mature(full_config: dict, api, cache: Path, report: Path) -> int:
    bucket = full_config["models"]["bucket"]
    spec = full_config["maturePack"]
    mirror = spec["mirror"]
    manifest_path = cache / mirror["manifest"]
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    files: dict[str, str] = {}
    try:
        api.download_bucket_files(bucket, [(mirror["manifest"], str(manifest_path))], raise_on_missing_files=True)
        listed = {entry["path"]: entry for entry in json.loads(manifest_path.read_text(encoding="utf-8"))["files"]}
    except Exception as error:  # a missing mirror is not fatal: the builder uses the public URL
        print(f"Mature mirror manifest unavailable ({type(error).__name__}); using the public Hugging Face URLs.", flush=True)
        report.write_text(json.dumps({"files": files}, indent=1), encoding="utf-8")
        return 0
    for key in ("lite", "good"):
        tier = spec["tiers"][key]
        remote = mirror["bucket"] + tier["file"]
        entry = listed.get(remote)
        if not entry or entry["size"] != tier["size"] or entry["sha256"] != tier["sha256"]:
            print(f"{remote} is not in the mirror manifest with the pinned size and SHA-256; using the public URL.", flush=True)
            continue
        local = cache / remote
        if not (local.is_file() and local.stat().st_size == tier["size"] and sha256(local) == tier["sha256"]):
            local.parent.mkdir(parents=True, exist_ok=True)
            try:
                api.download_bucket_files(bucket, [(remote, str(local))], raise_on_missing_files=True)
            except Exception as error:
                print(f"{remote} could not be downloaded from the bucket ({type(error).__name__}); using the public URL.", flush=True)
                continue
            if local.stat().st_size != tier["size"] or sha256(local) != tier["sha256"]:
                local.unlink(missing_ok=True)
                raise SystemExit(f"{remote} does not match the pinned SHA-256 in release.config.json")
        files[tier["file"]] = str(local)
    report.write_text(json.dumps({"files": files}, indent=1), encoding="utf-8")
    print(f"Verified {len(files)} of 2 Mature models from the bucket mirror.", flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--mature", action="store_true")
    args = parser.parse_args()
    token = (os.environ.get("HF_TOKEN") or "").strip()
    if args.mature and not token:
        print("HF_TOKEN is not set: the Mature models come from their public Hugging Face URLs.", flush=True)
        args.report.write_text(json.dumps({"files": {}}, indent=1), encoding="utf-8")
        return 0
    if not token:
        print("HF_TOKEN is not set: add the HF_TOKEN secret, or build with --dry-run.", file=sys.stderr)
        return 2
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::add-mask::{token}", flush=True)
    from huggingface_hub import HfApi

    full_config = json.loads(args.config.read_text(encoding="utf-8"))
    if args.mature:
        return fetch_mature(full_config, HfApi(token=token), args.cache.resolve(), args.report)
    config = full_config["models"]
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
