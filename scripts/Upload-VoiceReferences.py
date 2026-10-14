"""Put the voice reference WAVs and voice configs from runtime/ into the private Hugging Face bucket's final/ and keep final/MANIFEST.json in sync.

Usage: vendor/pocket-tts-env/Scripts/python.exe scripts/Upload-VoiceReferences.py --runtime RUNTIME_DIR --note TEXT [--dry-run] [--report OUT.json]

What it uploads: every WAV under runtime/voice-references/picked/autobest/ and the voice configs named below, but only the files whose
size or SHA-256 differs from the manifest entry (or that have none). Existing remote files are never deleted. Before it writes anything it
checks that every ready reference in the four autobest configs exists locally, matches its descriptor hash, and is listed in the manifest
afterwards. The manifest is uploaded last. The token is read from RUNTIME_DIR/huggingface-checkpoint-token.txt and never printed.
The report lists every replaced remote file with its old and new size and hash.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

from huggingface_hub import HfApi

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "packaging" / "release.config.json").read_text(encoding="utf-8"))["models"]
CONFIGS = ["pocket-voices.autobest.json", "local-voices.autobest-short.json", "local-voices.autobest-long.json", "local-voices.autobest.json"]
REFERENCES = "picked/autobest/"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--note", required=True)
    parser.add_argument("--date", default="2026-10-15")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    runtime = args.runtime.resolve()
    token = (runtime / "huggingface-checkpoint-token.txt").read_text(encoding="utf-8").strip()
    api = HfApi(token=token)
    bucket = CONFIG["bucket"]
    refs_remote = CONFIG["references"]["bucket"]
    refs_local = runtime / "voice-references"
    config_remote = next(g["bucket"] for g in CONFIG["groups"] if g["target"] == "voice-configs/")

    with tempfile.TemporaryDirectory() as work:
        manifest_path = Path(work) / "MANIFEST.json"
        api.download_bucket_files(bucket, [(CONFIG["manifest"], str(manifest_path))], raise_on_missing_files=True)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        known = {entry["path"]: entry for entry in manifest["files"]}

        wanted = []  # (local, remote, group, description suffix)
        for wav in sorted((refs_local / REFERENCES).glob("*/*.wav")):
            wanted.append((wav, refs_remote + REFERENCES + wav.parent.name + "/" + wav.name))
        for name in CONFIGS:
            wanted.append((runtime / name, config_remote + name))

        # Pre-flight: every ready reference in the four configs exists, matches its descriptor and will be in the manifest.
        listed = set(known) | {remote for _, remote in wanted}
        problems = []
        for name in CONFIGS:
            voices = json.loads((runtime / name).read_text(encoding="utf-8")).get("voices", {})
            for key, descriptor in voices.items():
                if descriptor.get("status", "ready") != "ready":
                    continue
                reference = descriptor["reference"]
                if not reference.startswith("runtime/voice-references/"):
                    problems.append(f"{name}:{key}: unexpected path {reference}")
                    continue
                relative = reference[len("runtime/voice-references/"):]
                local = refs_local / relative
                if not local.is_file() or sha256(local) != descriptor["sha256"]:
                    problems.append(f"{name}:{key}: local file missing or hash differs ({relative})")
                if refs_remote + relative not in listed:
                    problems.append(f"{name}:{key}: {relative} would not be in the manifest")
        if problems:
            print("\n".join(problems[:30]))
            raise SystemExit(f"{len(problems)} pre-flight problems, nothing uploaded.")

        replaced, added, same, uploads = [], [], 0, []
        for local, remote in wanted:
            size, digest = local.stat().st_size, sha256(local)
            current = known.get(remote)
            if current and current["size"] == size and current["sha256"] == digest:
                same += 1
                continue
            row = {"path": remote, "new_size": size, "new_sha256": digest}
            if current:
                row.update(old_size=current["size"], old_sha256=current["sha256"])
                replaced.append(row)
            else:
                added.append(row)
            uploads.append((str(local), remote, size, digest, current))
        print(f"{len(wanted)} candidates: {same} already identical, {len(replaced)} replace a remote file, {len(added)} are new, "
              f"{sum(u[2] for u in uploads) / 1e6:.1f} MB to send.")
        report = {"replaced": replaced, "added": added, "unchanged": same}
        if args.report:
            args.report.write_text(json.dumps(report, indent=1), encoding="utf-8")
        if args.dry_run or not uploads:
            return 0

        api.batch_bucket_files(bucket, add=[(local, remote) for local, remote, *_ in uploads])

        by_path = {entry["path"]: entry for entry in manifest["files"]}
        for local, remote, size, digest, current in uploads:
            if current:
                entry = by_path[remote]
                entry["size"], entry["sha256"] = size, digest
                entry["source"] = str(Path(local).relative_to(runtime.parent)).replace("\\", "/")
                entry["description"] = entry["description"] + f" [refreshed {args.date}: {args.note}]"
            else:
                manifest["files"].append({"path": remote, "size": size, "sha256": digest,
                                          "source": str(Path(local).relative_to(runtime.parent)).replace("\\", "/"),
                                          "group": "5-voice-references" if remote.startswith(refs_remote) else "5-voice-configs",
                                          "description": args.note})
        manifest["file_count"] = len(manifest["files"])
        manifest["total_bytes"] = sum(entry["size"] for entry in manifest["files"])
        manifest["updated"] = args.date
        manifest["updated_note"] = args.note + ". Previous: " + str(manifest.get("updated_note", ""))
        manifest_path.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
        api.batch_bucket_files(bucket, add=[(str(manifest_path), CONFIG["manifest"])])

        check = Path(work) / "check.json"
        api.download_bucket_files(bucket, [(CONFIG["manifest"], str(check))], raise_on_missing_files=True)
        again = {entry["path"]: entry for entry in json.loads(check.read_text(encoding="utf-8"))["files"]}
        for _, remote, size, digest, _ in uploads:
            if again.get(remote, {}).get("sha256") != digest:
                raise SystemExit(f"{remote} is not listed correctly after the upload")
        print(f"Uploaded {len(uploads)} files and updated {CONFIG['manifest']}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
