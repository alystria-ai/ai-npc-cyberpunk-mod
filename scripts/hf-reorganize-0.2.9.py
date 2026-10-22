"""One-time reorganisation of the Hugging Face pack repository for release 0.2.9.

    python -I scripts/hf-reorganize-0.2.9.py                 (dry run, the default: lists the planned operations, changes nothing)
    python -I scripts/hf-reorganize-0.2.9.py --apply         (ONE commit: server-side copies, deletes of the old paths, deletes of every checksum file)
    python -I scripts/hf-reorganize-0.2.9.py --listing files.json   (plan from a saved listing instead of the repository: a JSON list of paths
                                                             or of {"path": ..., "size": ...}; used by the tests, only valid as a dry run)

Repository: alystria-ai/ai-npc-cyberpunk-mod-packs. Decided by the owner on 2026-10-22, in effect with release 0.2.9:

  * Folders by kind and NO "AI-NPC-Cyberpunk-Mod-" prefix on any file name:
        Scripts.zip, Runtime.zip                                   (root, with README.md, LICENSE, .gitattributes)
        local-ai/LocalAI-Standard.zip, local-ai/LocalAI-Lite.zip
        mature/Mature-Standard.zip,    mature/Mature-Lite.zip
        mic/MicPack-European.zip,      mic/MicPack-Asian.zip
        voice/OmniPack.zip
        updates/Runtime-Update-<from>-to-<to>.zip                  (every step, renamed)
        multilingual/Voices-<Language>.zip, multilingual/PocketTTS-Model-<Language>.zip   (the Pocket language models are now PocketTTS models)
  * NO SHA256SUMS files anywhere (root, updates/, multilingual/): they are deleted.

The commit copies each file to its new path (CommitOperationCopy, server side: nothing is downloaded or uploaded), deletes the old path, and
deletes every checksum file. The same commit also replaces the three README files (the model card at the root, updates/README.md and
multilingual/README.md) with the texts of this checkout (packaging/HF_MODEL_CARD.md, HF_UPDATES_README.md, HF_MULTILINGUAL_README.md), because
the old ones name the old paths and the checksum files: --no-readmes leaves them out. The release step adds its own row to updates/README.md.
The commit message carries no version: the file list of the repository shows it beside every file, and these files keep their own versions.

The token is read from runtime/huggingface-alystria-token.txt (of this checkout, or of the main checkout when this is a git worktree) and is never
printed. A dry run only reads the repository's file list.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPOSITORY = "alystria-ai/ai-npc-cyberpunk-mod-packs"
TOKEN_FILE = "runtime/huggingface-alystria-token.txt"
# No version in the message: Hugging Face shows the last commit message beside every file, and the moved files keep the version they were uploaded in.
COMMIT_MESSAGE = ("Reorganised into folders by kind (local-ai, mature, mic, voice), file names without the product prefix, "
                  "PocketTTS models, no checksum files (the files themselves are unchanged)")
PREFIX = "AI-NPC-Cyberpunk-Mod-"

# Exact old path -> new path. A pack missing from the repository is reported; --apply refuses unless --allow-missing is given for it.
PACKS = {
    f"{PREFIX}Scripts.zip": "Scripts.zip",
    f"{PREFIX}Runtime.zip": "Runtime.zip",
    f"{PREFIX}LocalAI-Standard.zip": "local-ai/LocalAI-Standard.zip",
    f"{PREFIX}LocalAI-Lite.zip": "local-ai/LocalAI-Lite.zip",
    f"{PREFIX}Mature-Standard.zip": "mature/Mature-Standard.zip",
    f"{PREFIX}Mature-Lite.zip": "mature/Mature-Lite.zip",
    f"{PREFIX}MicPack-European.zip": "mic/MicPack-European.zip",
    f"{PREFIX}MicPack-Asian.zip": "mic/MicPack-Asian.zip",
    f"{PREFIX}OmniPack.zip": "voice/OmniPack.zip",
}
REQUIRED = ("Scripts.zip", "Runtime.zip")
# Renames by pattern inside the two folders that stay.
PATTERNS = (
    (re.compile(rf"^updates/{re.escape(PREFIX)}(Runtime-Update-.+\.zip)$"), r"updates/\1"),
    (re.compile(rf"^multilingual/{re.escape(PREFIX)}(Voices-.+\.zip)$"), r"multilingual/\1"),
    (re.compile(rf"^multilingual/{re.escape(PREFIX)}Pocket-(.+\.zip)$"), r"multilingual/PocketTTS-Model-\1"),
)
CHECKSUM = re.compile(r"(?:^|/)SHA256SUMS[^/]*$", re.IGNORECASE)
# Files that stay exactly where they are.
KEEP = {"README.md", "LICENSE", ".gitattributes", "updates/README.md", "multilingual/README.md"}
# The three README files replaced in the same commit: path in the repository -> (source file in this checkout, True when the text starts below the first '---' line).
READMES = {
    "README.md": ("packaging/HF_MODEL_CARD.md", False),
    "updates/README.md": ("packaging/HF_UPDATES_README.md", True),
    "multilingual/README.md": ("packaging/HF_MULTILINGUAL_README.md", True),
}
CHECKOUT = Path(__file__).resolve().parent.parent


def new_path(path: str) -> str | None:
    if path in PACKS:
        return PACKS[path]
    for pattern, replacement in PATTERNS:
        if pattern.match(path):
            return pattern.sub(replacement, path)
    return None


def plan(files: dict[str, int | None]) -> dict:
    """files: path in the repository -> size (None when unknown). Returns the copies, deletes, checksum deletes, and what is left alone or wrong."""
    copies, deletes, sums, left, problems = [], [], [], [], []
    for path in sorted(files):
        if CHECKSUM.search(path):
            sums.append(path)
            continue
        target = new_path(path)
        if target is None:
            left.append(path)
            continue
        if target in files:
            problems.append(f"{path} -> {target}: the target already exists")
            continue
        copies.append((path, target, files[path]))
        deletes.append(path)
    targets = [target for _, target, _ in copies]
    if len(set(targets)) != len(targets):
        problems.append("two files would be copied to the same path")
    missing = [new for old, new in PACKS.items() if old not in files and new not in files]
    return {"copies": copies, "deletes": deletes, "sums": sums, "left": left, "problems": problems, "missing": missing}


def readme_text(source: str, below_rule: bool) -> bytes:
    text = (CHECKOUT / source).read_text(encoding="utf-8").replace("\r\n", "\n")
    if below_rule:
        head, rule, rest = text.partition("\n---\n")
        if not rule:
            raise SystemExit(f"{source} has no '---' line above the text of the file.")
        text = rest.lstrip("\n")
    return text.encode("utf-8")


def find_token() -> str:
    here = Path(__file__).resolve().parent.parent
    roots = [here]
    git = here / ".git"
    if git.is_file():  # a worktree: its gitdir is <main>/.git/worktrees/<name>
        match = re.match(r"gitdir:\s*(.+)", git.read_text(encoding="utf-8").strip())
        if match:
            roots.append(Path(match.group(1)).resolve().parents[2])
    for root in roots:
        candidate = root / TOKEN_FILE
        if candidate.is_file():
            token = candidate.read_text(encoding="utf-8").strip()
            if token:
                return token
    raise SystemExit(f"{TOKEN_FILE} was not found (looked in {', '.join(str(root) for root in roots)}).")


def human(size: int | None) -> str:
    if size is None:
        return "?"
    return f"{size / 1024 ** 3:.2f} GiB" if size >= 1024 ** 3 else f"{size / 1024 ** 2:.1f} MiB"


def show(result: dict) -> None:
    print(f"Repository: {REPOSITORY}")
    print(f"\nCopy (server side) and delete the old path: {len(result['copies'])}")
    for old, new, size in result["copies"]:
        print(f"  COPY   {old}  ->  {new}   ({human(size)})")
        print(f"  DELETE {old}")
    print(f"\nDelete checksum files: {len(result['sums'])}")
    for path in result["sums"]:
        print(f"  DELETE {path}")
    replaced = {path for path, _ in result.get("readmes", [])}
    left = [path for path in result["left"] if path not in replaced]
    print(f"\nLeft alone: {len(left)}")
    for path in left:
        print(f"  keep   {path}")
    if result["missing"]:
        print(f"\nExpected but not in the repository ({len(result['missing'])}):")
        for path in result["missing"]:
            print(f"  missing {path}")
    for problem in result["problems"]:
        print(f"\nPROBLEM: {problem}")
    readmes = result.get("readmes", [])
    print(f"\nReplace the README files: {len(readmes)}")
    for path, source in readmes:
        print(f"  WRITE  {path}  (text of {source})")
    total = len(result["copies"]) * 2 + len(result["sums"]) + len(readmes)
    print(f"\nOne commit with {len(result['copies'])} copies, {len(result['copies']) + len(result['sums'])} deletes and {len(readmes)} README files ({total} operations).")


def read_listing(path: Path) -> dict[str, int | None]:
    data = json.loads(path.read_text(encoding="utf-8"))
    files: dict[str, int | None] = {}
    for item in data:
        if isinstance(item, str):
            files[item] = None
        else:
            files[item["path"]] = item.get("size")
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="list the planned operations and change nothing (the default)")
    mode.add_argument("--apply", action="store_true", help="make the one commit")
    parser.add_argument("--allow-missing", action="store_true", help="with --apply: go on although an optional pack is not in the repository (the Scripts and the Runtime are always required)")
    parser.add_argument("--no-readmes", action="store_true", help="leave the three README files (model card, updates, multilingual) as they are")
    parser.add_argument("--listing", type=Path, help="plan from this JSON listing instead of the repository (dry run only)")
    args = parser.parse_args()
    if args.listing and args.apply:
        parser.error("--listing is only for a dry run")

    api = None
    parent = None
    if args.listing:
        files = read_listing(args.listing)
    else:
        from huggingface_hub import HfApi

        api = HfApi(token=find_token())
        info = api.model_info(REPOSITORY, files_metadata=True)
        files = {sibling.rfilename: getattr(sibling, "size", None) for sibling in info.siblings}
        parent = info.sha
    result = plan(files)
    result["readmes"] = [] if args.no_readmes else [(path, source) for path, (source, _) in READMES.items()]
    show(result)
    if not args.apply:
        print("\nDry run: nothing was changed. Run with --apply to make the commit.")
        return 1 if result["problems"] else 0
    if result["problems"]:
        raise SystemExit("Not applying: fix the problems above first.")
    absent = [path for path in result["missing"] if path in REQUIRED] or ([] if args.allow_missing else result["missing"])
    if absent:
        raise SystemExit(f"Not applying: {', '.join(absent)} is not in the repository (use --allow-missing for an optional pack).")
    if not result["copies"] and not result["sums"] and not result["readmes"]:
        print("Nothing to do.")
        return 0

    from huggingface_hub import CommitOperationAdd, CommitOperationCopy, CommitOperationDelete

    operations = [CommitOperationCopy(src_path_in_repo=old, path_in_repo=new) for old, new, _ in result["copies"]]
    operations += [CommitOperationDelete(path_in_repo=path) for path in result["deletes"] + result["sums"]]
    for path, _ in result["readmes"]:
        source, below_rule = READMES[path]
        operations.append(CommitOperationAdd(path_in_repo=path, path_or_fileobj=readme_text(source, below_rule)))
    # parent_commit: refused when the repository changed since the plan was made.
    commit = api.create_commit(REPOSITORY, operations, commit_message=COMMIT_MESSAGE, repo_type="model", parent_commit=parent)
    print(f"\nCommitted: {getattr(commit, 'commit_url', commit)}")
    # Verify: every new path is there with the size the old one had, and no old path or checksum file is left.
    after = {sibling.rfilename: getattr(sibling, "size", None) for sibling in api.model_info(REPOSITORY, files_metadata=True).siblings}
    bad = [new for old, new, size in result["copies"] if new not in after or (size is not None and after[new] != size)]
    bad += [path for path in result["deletes"] + result["sums"] if path in after]
    if bad:
        raise SystemExit(f"Committed, but these paths are not as planned: {', '.join(bad)}")
    print("Checked: every copy is there with its size, and every old path and checksum file is gone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
