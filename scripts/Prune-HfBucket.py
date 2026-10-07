"""Delete the planned delete-list from the private HF checkpoint bucket.

Usage: vendor/pocket-tts-env/Scripts/python.exe scripts/Prune-HfBucket.py [plan.json] [--dry-run]

Reads the plan (default: the 2026-10-07 plan on E:), re-lists the bucket,
prints every prefix it would delete with live file counts and sizes, refuses
to touch anything under a keep prefix or in any other bucket, and asks for one
typed "yes" before deleting. The token is read from
runtime/huggingface-checkpoint-token.txt and never printed.
"""
import json
import sys
from pathlib import Path

from huggingface_hub import HfApi

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PLAN = Path(r"E:\CyberpunkConvai-offload\backups\hf-bucket-prune-plan-2026-10-07.json")
TOKEN_FILE = ROOT / "runtime" / "huggingface-checkpoint-token.txt"
BATCH = 100


def under(path, prefix):
    prefix = prefix.rstrip("/")
    return path == prefix or path.startswith(prefix + "/")


def gb(n):
    return f"{n / 1e9:.3f} GB"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    plan_path = Path(args[0]) if args else DEFAULT_PLAN
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    bucket = plan["bucket"]
    if bucket != "akshitireddy/cyberpunk-pocket-rolling-checkpoints":
        sys.exit(f"Refusing: plan targets unexpected bucket {bucket}")
    delete_prefixes = [d["prefix"] for d in plan["delete"]]
    keep_prefixes = [k["prefix"] for k in plan["keep"]]

    api = HfApi(token=TOKEN_FILE.read_text().strip())
    files = [(e.path, e.size or 0) for e in api.list_bucket_tree(bucket, recursive=True)
             if getattr(e, "type", None) == "file"]
    total = sum(s for _, s in files)
    print(f"Bucket {bucket}: {len(files)} files, {gb(total)} before.")

    targets, kept = [], []
    for path, size in files:
        in_del = any(under(path, p) for p in delete_prefixes)
        in_keep = any(under(path, p) for p in keep_prefixes)
        if in_del and in_keep:
            sys.exit(f"Refusing: {path} matches both delete and keep prefixes")
        (targets if in_del else kept).append((path, size))

    print("\nWill DELETE:")
    for p in delete_prefixes:
        sub = [(f, s) for f, s in targets if under(f, p)]
        print(f"  {gb(sum(s for _, s in sub)):>10}  {len(sub):4d} files  {p}")
    del_bytes = sum(s for _, s in targets)
    print(f"  {'-' * 40}\n  {gb(del_bytes):>10}  {len(targets):4d} files  TOTAL to delete")
    print("\nWill KEEP:")
    for p in keep_prefixes:
        sub = [(f, s) for f, s in kept if under(f, p)]
        print(f"  {gb(sum(s for _, s in sub)):>10}  {len(sub):4d} files  {p}")
    other = [(f, s) for f, s in kept if not any(under(f, p) for p in keep_prefixes)]
    if other:
        print(f"  {len(other)} files not in any plan list are also left untouched, e.g. {other[0][0]}")
    if not targets:
        print("Nothing to delete.")
        return
    if dry:
        print("\n--dry-run: nothing deleted.")
        return
    print("\nThis permanently deletes the files above from the bucket.")
    if input('Type "yes" to delete: ').strip() != "yes":
        print("Aborted, nothing deleted.")
        return
    paths = [p for p, _ in targets]
    for i in range(0, len(paths), BATCH):
        chunk = paths[i:i + BATCH]
        for p in chunk:
            print("deleting", p)
        api.batch_bucket_files(bucket, delete=chunk)
    left = [(e.path, e.size or 0) for e in api.list_bucket_tree(bucket, recursive=True)
            if getattr(e, "type", None) == "file"]
    print(f"\nDone. Bucket now {len(left)} files, {gb(sum(s for _, s in left))} (was {gb(total)}).")


if __name__ == "__main__":
    main()
