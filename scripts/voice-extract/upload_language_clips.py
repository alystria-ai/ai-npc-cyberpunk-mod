"""Upload the flagged rows of packaging/voice-language-clips-upload-list.json to Hugging Face and read every one back.

    python scripts/voice-extract/upload_language_clips.py --token-file <runtime/huggingface-alystria-token.txt> [--list packaging/voice-language-clips-upload-list.json]
            [--batch 150] [--pause 45] [--retries 8] [--dry-run] [--read-back-only] [--clear-flags]

Only rows with "toUpload": true are sent, in commits of --batch files (default 150) to the repository named in the list, with --pause seconds between commits (Hugging Face rate-limits
big commits, 400-file commits were refused on 31 Oct 2026).  A commit that answers 429 or 503 (or drops the connection) is retried after the server's Retry-After or an increasing wait,
at most --retries times.  A file that is already on the repository with the same size and LFS SHA-256 is not sent again, so a stopped run can be started again.
After the last commit every flagged row is read back: the repository's size and LFS SHA-256 must equal the row's.  With --clear-flags the "toUpload" flags and `newFilesToUpload` are removed
from the list when (and only when) every flagged row matched.  The token is read from the file and never printed, logged or put in a URL.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def remote_state(api, repository: str, paths: list[str]) -> dict:
    """{path: (size, lfs sha256)} of the files that exist on the repository."""
    state = {}
    for start in range(0, len(paths), 100):
        for info in api.get_paths_info(repository, paths[start:start + 100], expand=True):
            lfs = getattr(info, "lfs", None)
            sha = lfs.get("sha256") if isinstance(lfs, dict) else getattr(lfs, "sha256", None)
            state[info.path] = (info.size, sha)
    return state


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--list", default=str(REPO / "packaging/voice-language-clips-upload-list.json"))
    ap.add_argument("--batch", type=int, default=150)
    ap.add_argument("--pause", type=float, default=45)
    ap.add_argument("--retries", type=int, default=8)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--read-back-only", action="store_true")
    ap.add_argument("--clear-flags", action="store_true")
    args = ap.parse_args()
    from huggingface_hub import CommitOperationAdd, HfApi
    from huggingface_hub.errors import HfHubHTTPError

    list_path = Path(args.list)
    data = json.loads(list_path.read_text(encoding="utf-8"))
    repository = data["repository"]
    flagged = [row for row in data["rows"] if row.get("toUpload")]
    log(f"{len(flagged)} flagged rows, {sum(row['bytes'] for row in flagged) / 1e6:.1f} MB, to {repository}")
    for row in flagged:
        source = Path(row["source"])
        if not source.is_file() or source.stat().st_size != row["bytes"]:
            raise SystemExit(f"{row['path']}: the source file is missing or its size differs")
    if args.dry_run:
        return 0
    api = HfApi(token=Path(args.token_file).read_text(encoding="utf-8").strip())

    if not args.read_back_only:
        already = remote_state(api, repository, [row["path"] for row in flagged])
        todo = [row for row in flagged if already.get(row["path"]) != (row["bytes"], row["sha256"])]
        log(f"{len(flagged) - len(todo)} already on the repository with the right size and hash, {len(todo)} to send")
        for number, start in enumerate(range(0, len(todo), args.batch), 1):
            batch = todo[start:start + args.batch]
            operations = [CommitOperationAdd(path_in_repo=row["path"], path_or_fileobj=row["source"]) for row in batch]
            for attempt in range(1, args.retries + 1):
                try:
                    api.create_commit(repo_id=repository, operations=operations, commit_message=f"Dubbed voice clips for the side characters and the new archetype voices ({start + len(batch)} of {len(todo)})")
                    log(f"commit {number}: {len(batch)} files sent ({sum(row['bytes'] for row in batch) / 1e6:.1f} MB)")
                    break
                except HfHubHTTPError as error:
                    status = getattr(error.response, "status_code", None)
                    if status not in (429, 503, 502, 504) or attempt == args.retries:
                        raise SystemExit(f"commit {number} failed with HTTP {status}")
                    wait = float(error.response.headers.get("Retry-After") or 0) or min(600, 60 * attempt)
                    log(f"commit {number}: HTTP {status}, attempt {attempt} of {args.retries}, waiting {wait:.0f} s")
                    time.sleep(wait)
                except (ConnectionError, TimeoutError, OSError) as error:
                    if attempt == args.retries:
                        raise SystemExit(f"commit {number} failed: {type(error).__name__}")
                    wait = min(600, 60 * attempt)
                    log(f"commit {number}: {type(error).__name__}, attempt {attempt} of {args.retries}, waiting {wait} s")
                    time.sleep(wait)
            if start + args.batch < len(todo):
                time.sleep(args.pause)

    state = remote_state(api, repository, [row["path"] for row in flagged])
    bad = [row["path"] for row in flagged if state.get(row["path"]) != (row["bytes"], row["sha256"])]
    log(f"read back: {len(flagged) - len(bad)} of {len(flagged)} files have the listed size and LFS SHA-256, {len(bad)} do not")
    for path in bad[:20]:
        log(f"  mismatch or missing: {path} {state.get(path)}")
    if bad:
        return 1
    if args.clear_flags:
        for row in data["rows"]:
            row.pop("toUpload", None)
        data.pop("newFilesToUpload", None)
        list_path.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
        log("flags removed from the list")
    return 0


if __name__ == "__main__":
    sys.exit(main())
