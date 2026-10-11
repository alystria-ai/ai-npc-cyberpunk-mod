"""Put the local speech-recognition model into the private Hugging Face bucket's final/ and list it in final/MANIFEST.json.

Usage: vendor/pocket-tts-env/Scripts/python.exe scripts/Upload-SttModel.py [--dry-run]

Source: runtime/stt-model/moonshine-tiny-en-int8/ (Moonshine Tiny English int8 as converted for sherpa-onnx:
https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-tiny-en-int8, MIT, plus the licence text).
Target: final/stt-model/moonshine-tiny-en-int8/ in the bucket named by packaging/release.config.json. The release build
(packaging/fetch-models.py) downloads exactly the files listed there and checks each against MANIFEST.json.
The token is read from runtime/huggingface-checkpoint-token.txt and never printed. Re-running is safe: files whose size and
SHA-256 already match the manifest are left alone, and manifest entries are replaced, not duplicated.
"""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

from huggingface_hub import HfApi

ROOT = Path(__file__).resolve().parent.parent
TOKEN_FILE = ROOT / "runtime" / "huggingface-checkpoint-token.txt"
CONFIG = json.loads((ROOT / "packaging" / "release.config.json").read_text(encoding="utf-8"))["models"]
GROUP = next(group for group in CONFIG["groups"] if group["target"] == "app/models/stt/moonshine-tiny-en-int8/")
SOURCE = ROOT / GROUP["local"]
DESCRIPTION = "Local speech recognition for the Mistral text route: Moonshine Tiny (English, MIT) int8 ONNX for sherpa-onnx"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    dry = "--dry-run" in sys.argv
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    api = HfApi(token=token)
    bucket = CONFIG["bucket"]
    with tempfile.TemporaryDirectory() as work:
        manifest_path = Path(work) / "MANIFEST.json"
        api.download_bucket_files(bucket, [(CONFIG["manifest"], str(manifest_path))], raise_on_missing_files=True)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        known = {entry["path"]: entry for entry in manifest["files"]}
        entries, uploads = [], []
        for name in GROUP["files"]:
            local = SOURCE / name
            if not local.is_file():
                raise SystemExit(f"Missing {local}")
            remote = GROUP["bucket"] + name
            entry = {"path": remote, "size": local.stat().st_size, "sha256": sha256(local),
                     "source": str(local.relative_to(ROOT)).replace("\\", "/"), "group": "5-stt-model", "description": DESCRIPTION}
            entries.append(entry)
            current = known.get(remote)
            if not current or current["size"] != entry["size"] or current["sha256"] != entry["sha256"]:
                uploads.append((str(local), remote))
        print(f"{len(entries)} files, {len(uploads)} to upload, {sum(e['size'] for e in entries) / 1e6:.1f} MB total.")
        if dry:
            return 0
        if uploads:
            api.batch_bucket_files(bucket, add=uploads)
        paths = {entry["path"] for entry in entries}
        manifest["files"] = [entry for entry in manifest["files"] if entry["path"] not in paths] + entries
        manifest["file_count"] = len(manifest["files"])
        manifest["total_bytes"] = sum(entry["size"] for entry in manifest["files"])
        manifest["updated"] = "2026-10-11"
        manifest["updated_note"] = ("stt-model/moonshine-tiny-en-int8/ added (local speech recognition for the Mistral text route). Previous: "
                                    + str(manifest.get("updated_note", "")))
        manifest_path.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
        api.batch_bucket_files(bucket, add=[(str(manifest_path), CONFIG["manifest"])])
        # Verify by downloading the manifest again and one model file's hash.
        check = Path(work) / "check.json"
        api.download_bucket_files(bucket, [(CONFIG["manifest"], str(check))], raise_on_missing_files=True)
        again = {entry["path"]: entry for entry in json.loads(check.read_text(encoding="utf-8"))["files"]}
        for entry in entries:
            if again.get(entry["path"], {}).get("sha256") != entry["sha256"]:
                raise SystemExit(f"{entry['path']} is not listed correctly after the upload")
        print("Uploaded and listed:", ", ".join(Path(entry["path"]).name for entry in entries))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
