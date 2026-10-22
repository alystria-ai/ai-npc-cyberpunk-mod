"""Upload the packs of a release to the Hugging Face model repository that hosts them.

Run by .github/workflows/release.yml (the omni, localai, mature and micpacks jobs), and by hand for the Scripts and Runtime. Each pack is ONE
zip, with no parts. The repository is organised in folders by kind, the files carry no product prefix and no version (the version goes in the
commit message), and there are NO checksum files:

    Scripts.zip   Runtime.zip                                           (root)
    local-ai/LocalAI-Standard.zip   local-ai/LocalAI-Lite.zip
    mature/Mature-Standard.zip      mature/Mature-Lite.zip
    mic/MicPack-European.zip        mic/MicPack-Asian.zip
    voice/OmniPack.zip              (OmniVoice is the only downloadable voice model)
    updates/Runtime-Update-<from>-to-<to>.zip   and   multilingual/Voices-<Language>.zip, PocketTTS-Model-<Language>.zip   (published by their own tools)

The zip of a build is named <Title>-<version>.zip (packaging/build-release.mjs; the Scripts are AI-NPC-Cyberpunk-Mod-Scripts-<version>.zip).

    python packaging/upload-packs.py --check                                   (can the token write to the repository?)
    python packaging/upload-packs.py --version 0.2.9 --pack omni --packages DIR   (upload the pack's zip from DIR to its folder)
    python packaging/upload-packs.py --version 0.2.9 --pack omni --packages DIR --dry-run   (list what would be uploaded)

The token comes from the HF_PACKS_TOKEN environment variable (the GitHub Actions secret of the account that owns the pack
repository; HF_TOKEN is the fallback for local runs) and is never printed. A missing repository is created, private. Nothing is uploaded
to GitHub releases by this script.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path

REPOSITORY = "alystria-ai/ai-npc-cyberpunk-mod-packs"
# pack id -> (folder in the repository, title). The zip a build writes is <title>-<version>.zip and is published as <folder>/<title>.zip.
# The Scripts zip of a build is AI-NPC-Cyberpunk-Mod-Scripts-<version>.zip (the name for Nexus Mods) and sits at the root as Scripts.zip.
LAYOUT = {
    "scripts": ("", "Scripts"),
    "runtime": ("", "Runtime"),
    "omni": ("voice", "OmniPack"),
    "localai-standard": ("local-ai", "LocalAI-Standard"),
    "localai-lite": ("local-ai", "LocalAI-Lite"),
    "mature-lite": ("mature", "Mature-Lite"),
    "mature-standard": ("mature", "Mature-Standard"),
    "micpack-european": ("mic", "MicPack-European"),
    "micpack-asian": ("mic", "MicPack-Asian"),
}
PACKS = tuple(LAYOUT)
PRODUCT = "AI-NPC-Cyberpunk-Mod"


def no_write_message(repository: str, detail: str = "") -> str:
    return (f"The HF_PACKS_TOKEN secret cannot write to the Hugging Face repository {repository}. "
            f"Give the HF_PACKS_TOKEN secret write access to {repository} (a fine-grained token needs write access to that repository's contents), "
            f"then run the workflow again.{(' (' + detail + ')') if detail else ''}")


def write_access(api, repository: str) -> tuple[bool, str]:
    """(True, '') when the token can write to the repository, (False, why) when it clearly cannot, (True, '') when it cannot be told."""
    try:
        who = api.whoami()
    except Exception as error:  # a bad token or no network
        return False, f"whoami failed: {type(error).__name__}"
    access = (who.get("auth") or {}).get("accessToken") or {}
    role = access.get("role")
    if role in ("write", "admin"):
        return True, ""
    if role == "read":
        return False, "the token is read-only"
    if role == "fineGrained":
        owner = repository.split("/")[0]
        names = {repository, owner}
        for scope in (access.get("fineGrained") or {}).get("scoped", []):
            entity = scope.get("entity") or {}
            permissions = set(scope.get("permissions") or [])
            if entity.get("name") in names and ({"repo.write", "repo.content.write"} & permissions):
                return True, ""
        return False, "the fine-grained token has no write permission for it"
    return True, ""


def connect(repository: str):
    token = (os.environ.get("HF_PACKS_TOKEN") or os.environ.get("HF_TOKEN") or "").strip()
    if not token:
        raise SystemExit(no_write_message(repository, "HF_PACKS_TOKEN is empty or not set"))
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::add-mask::{token}", flush=True)
    from huggingface_hub import HfApi

    api = HfApi(token=token)
    ok, why = write_access(api, repository)
    if not ok:
        raise SystemExit(no_write_message(repository, why))
    try:
        api.repo_info(repository, repo_type="model")
    except Exception:
        # A first upload creates the repository, private: it goes public with the release.
        try:
            api.create_repo(repository, repo_type="model", private=True, exist_ok=True)
            print(f"Created the private Hugging Face repository {repository}.", flush=True)
        except Exception as error:
            raise SystemExit(f"The Hugging Face repository {repository} was not found and could not be created ({type(error).__name__}).")
    return api


def built_name(pack: str, version: str) -> str:
    """The name of the zip a build writes for the pack (packaging/build-release.mjs)."""
    title = LAYOUT[pack][1]
    return f"{PRODUCT}-{title}-{version}.zip" if pack == "scripts" else f"{title}-{version}.zip"


def remote_path(pack: str) -> str:
    """Where the pack lives in the repository: <folder>/<title>.zip, no product prefix, no version."""
    folder, title = LAYOUT[pack]
    return f"{folder}/{title}.zip" if folder else f"{title}.zip"


def plan(version: str, pack: str, packages: Path) -> list[tuple[Path, str]]:
    """The (local file, path in the repository) pair of one pack: its one zip, in the pack's folder. No checksum file goes with it."""
    if pack not in LAYOUT:
        raise SystemExit(f"Unknown pack {pack}; expected one of {', '.join(PACKS)}.")
    if not re.fullmatch(r"\d+(\.\d+){1,3}([-+][0-9A-Za-z.-]+)?", version):
        raise SystemExit(f"Invalid version: {version}")
    name = built_name(pack, version)
    parts = sorted(packages.glob(f"{name[:-4]}-part*of*.zip"))
    if parts:
        raise SystemExit(f"{parts[0].name} is a multi-part zip; a pack is uploaded as one zip.")
    zip_path = packages / name
    if not zip_path.is_file():
        raise SystemExit(f"Expected exactly one zip for the {pack} pack in {packages}: {name} is missing. A pack is a single zip, never parts.")
    return [(zip_path, remote_path(pack))]


def upload(api, repository: str, version: str, pack: str, items: list[tuple[Path, str]]) -> None:
    from huggingface_hub.errors import HfHubHTTPError

    for local, remote in items:
        for attempt in range(1, 4):
            try:
                print(f"Uploading {local.name} ({local.stat().st_size / 1024 ** 3:.2f} GiB) to {repository}/{remote} (attempt {attempt}).", flush=True)
                api.upload_file(path_or_fileobj=str(local), path_in_repo=remote, repo_id=repository, repo_type="model",
                                commit_message=f"AI NPC Cyberpunk Mod {version}: {pack} pack, {remote}")
                break
            except HfHubHTTPError as error:
                status = getattr(getattr(error, "response", None), "status_code", None)
                if status in (401, 403):
                    raise SystemExit(no_write_message(repository, f"HTTP {status}"))
                if attempt == 3:
                    raise
                time.sleep(20 * attempt)
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(20 * attempt)
    # Verify: every file is there with the size it has here.
    paths = [remote for _, remote in items]
    listed = {info.path: info for info in api.get_paths_info(repository, paths, repo_type="model")}
    for local, remote in items:
        found = listed.get(remote)
        if not found or getattr(found, "size", None) != local.stat().st_size:
            raise SystemExit(f"{remote} is not on {repository} with the size it has here.")
    print(f"Uploaded and checked {len(items)} file in {repository}: {', '.join(paths)}.", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=REPOSITORY)
    parser.add_argument("--check", action="store_true", help="only check that the token can write to the repository")
    parser.add_argument("--version")
    parser.add_argument("--pack", choices=PACKS)
    parser.add_argument("--packages", type=Path, help="folder with the built zip")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.check:
        connect(args.repo)
        print(f"The HF_PACKS_TOKEN secret can write to {args.repo}.", flush=True)
        return 0
    if not (args.version and args.pack and args.packages):
        parser.error("--version, --pack and --packages are required")
    items = plan(args.version, args.pack, args.packages)
    if args.dry_run:
        for local, remote in items:
            print(f"{local} -> {args.repo}/{remote}")
        return 0
    upload(connect(args.repo), args.repo, args.version, args.pack, items)
    return 0


if __name__ == "__main__":
    sys.exit(main())
