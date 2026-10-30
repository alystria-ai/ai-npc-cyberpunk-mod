"""Upload the packs of a release to the Hugging Face model repository that hosts them.

Run by .github/workflows/release.yml (the omni, localai, mature and micpacks jobs), and by hand for the Full install, the Update and the Runtime.
Each pack is ONE zip, with no parts. The repository is organised in folders by kind, the files carry no version (the version goes in the commit
message), the optional packs no product prefix, and there are NO checksum files:

    AI-NPC-LLM-Companions.zip   AI-NPC-LLM-Companions-Update.zip        (root: the FULL INSTALL, the main file for a new player, and the UPDATE for an
                                                                         install that already has the Runtime base the update names; owner decision 2026-10-28)
    runtime/Runtime.zip                                                 (the Runtime base alone: an input of the full install, and for old two-mod setups; not advertised to new installs)
    local-ai/LocalAI-Standard-Gemma-4-E4B.zip   local-ai/LocalAI-Lite-Bonsai-2-4B.zip
    mature/Mature-Standard-Gemma-4-E4B.zip      mature/Mature-Lite-Qwen3.5-4B.zip
    mic/MicPack-European-Parakeet-TDT-0.6B-v3.zip   mic/MicPack-Asian-SenseVoice-Small-234M.zip
    local-ai/vision/Vision-Gemma-4-E4B-projector.zip   local-ai/vision/Vision-Bonsai-2-4B-projector.zip   (the vision files of the Local AI models: small separate zips, not part of the packs)
    mature/vision/Vision-Gemma-4-E4B-projector.zip     mature/vision/Vision-Qwen3.5-4B-projector.zip      (the same Gemma zip is published at both paths: one build, one file, two paths)
    voice/OmniPack-OmniVoice-0.6B.zip           (OmniVoice is the only downloadable voice model)
    voice/amd/OmniAMD-<family>-PyTorch-<v>-ROCm-<v>.zip    (AMD's ROCm PyTorch for OmniVoice, one zip per card family; packaging/build-omni-amd-packs.mjs)
    updates/Runtime-Update-<from>-to-<to>.zip   and   multilingual/Voices-<Language>.zip, PocketTTS-Model-100M-<Language>.zip   (published by their own tools)

Every model pack carries the model's name and parameter count in its file name (owner decision 2026-10-28): <Type>-<Tier>-<Model>-<Params>.zip. The names
are the "packFiles" block of packaging/release.config.json (the one source; packaging/lib/pack-names.mjs reads the same block). Before 0.3.4 the files were
LocalAI-Standard.zip, LocalAI-Lite.zip, Mature-Standard.zip, Mature-Lite.zip, MicPack-European.zip, MicPack-Asian.zip, voice/OmniPack.zip and
multilingual/PocketTTS-Model-<Language>.zip (docs/PACKAGING.md, "Pack file names"). A build folder that still holds a zip under an old name is accepted and published
under the new name; --also-old-name additionally publishes the same file at the old path (Hugging Face stores identical content once), so links to the old
names keep working for a while.
    game-2.31/AI-NPC-LLM-Companions.zip   game-2.31/AI-NPC-LLM-Companions-Update.zip   game-2.31/runtime/Runtime.zip   updates/game-2.31/...    (the build for the older
    game 2.31, --game 2.31; docs/GAME_VERSIONS.md)

The files at the top (the Full install, the Update, runtime/, updates/) are the build for game 2.5, the default game. updates/ (the Runtime update zips,
Runtime-Update-<from>-to-<to>.zip) is no longer offered to players since 0.3.4 and nothing here uploads to it; what is in it stays.

The zip of a build is named <Title>-<version>.zip (packaging/build-release.mjs). The Full install is AI-NPC-LLM-Companions-<version>.zip (packaging/build-full.mjs)
and the Update AI-NPC-LLM-Companions-Update-<from>-to-<version>.zip, <from> being the Runtime base it needs, with "-and-up" when it covers several releases (packaging/lib/full-package.mjs); both
have -for-2.31 after the version for game 2.31. Before 0.3.4 the update was AI-NPC-Cyberpunk-Mod-Scripts-<version>.zip, published as Scripts.zip: --also-old-name
additionally publishes the Update at Scripts.zip and the Runtime at Runtime.zip (the root, where it was), so the links of older texts keep working for a while.

    python packaging/upload-packs.py --check                                   (can the token write to the repository?)
    python packaging/upload-packs.py --version 0.2.9 --pack omni --packages DIR   (upload the pack's zip from DIR to its folder)
    python packaging/upload-packs.py --version 0.2.9 --pack omni --packages DIR --dry-run   (list what would be uploaded)
    python packaging/upload-packs.py --version 0.3.4 --pack full --packages DIR [--game 2.31]     (the Full install: AI-NPC-LLM-Companions.zip)
    python packaging/upload-packs.py --version 0.3.4 --pack update --packages DIR [--game 2.31]   (the Update: AI-NPC-LLM-Companions-Update.zip)
    python packaging/upload-packs.py --version 0.3.4 --pack omni-amd --packages DIR        (upload every OmniAMD-*.zip in DIR to voice/amd/; the names carry no release version)

The token comes from the HF_PACKS_TOKEN environment variable (the GitHub Actions secret of the account that owns the pack
repository; HF_TOKEN is the fallback for local runs) and is never printed. A missing repository is created, private. Nothing is uploaded
to GitHub releases by this script.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

REPOSITORY = "alystria-ai/ai-npc-cyberpunk-mod-packs"
# The file names of the packs: the "packFiles" block of release.config.json (a model pack's name carries the model and its parameter count).
PACK_FILES = json.loads((Path(__file__).with_name("release.config.json")).read_text(encoding="utf-8"))["packFiles"]
# pack id -> (folder in the repository, title). The zip a build writes is <title>-<version>.zip and is published as <folder>/<title>.zip.
# The Full install and the Update sit at the root (a build names them AI-NPC-LLM-Companions-<version>.zip and
# AI-NPC-LLM-Companions-Update-<from>-to-<version>.zip, the names for Nexus Mods), the Runtime base alone in runtime/.
FULL_TITLE = "AI-NPC-LLM-Companions"
UPDATE_TITLE = f"{FULL_TITLE}-Update"
LAYOUT = {
    "full": ("", FULL_TITLE),
    "update": ("", UPDATE_TITLE),
    "runtime": ("runtime", "Runtime"),
    **{pack: (entry["folder"], entry["title"]) for pack, entry in PACK_FILES["packs"].items()},
}
# pack id -> the title before 0.3.4 (OmniPack, LocalAI-Lite ...): still accepted in a build folder, and the old path of --also-old-name. The vision files are newer than that and have none.
LEGACY_TITLES = {pack: entry["legacyTitle"] for pack, entry in PACK_FILES["packs"].items() if entry.get("legacyTitle")}
# pack id -> the other folders the same zip is published to (the Gemma 4 E4B vision file serves Local AI standard and Mature standard: local-ai/vision and mature/vision).
ALSO_IN = {pack: tuple(entry["alsoIn"]) for pack, entry in PACK_FILES["packs"].items() if entry.get("alsoIn")}
PACKS = tuple(LAYOUT) + ("omni-amd",)
# The AMD packs (packaging/build-omni-amd-packs.mjs) are not part of a release build: the zips are named by what is inside, not by the release,
# and go to voice/amd/ as they are. --pack omni-amd uploads every one found in the folder.
AMD_FOLDER = "voice/amd"
AMD_NAME = re.compile(r"OmniAMD-gfx[0-9a-f]{3,5}-PyTorch-\d+\.\d+-ROCm-\d+\.\d+\.zip")
PRODUCT = "AI-NPC-Cyberpunk-Mod"
# The game versions the mod is built for (packaging/game-variants.json, docs/GAME_VERSIONS.md): the Scripts and Runtime of a game other than
# the default (2.5) carry a suffix in the file name of a build and sit in a folder of their own, game-<version>/. The other packs are shared.
GAME_VARIANTS = json.loads((Path(__file__).with_name("game-variants.json")).read_text(encoding="utf-8"))["variants"]
GAME_PACKS = ("full", "update", "runtime")
# Where the pack lived before 0.3.4, for --also-old-name: the Update was Scripts.zip and the Runtime sat at the root.
LEGACY_REMOTE = {"update": "Scripts.zip", "runtime": "Runtime.zip"}
# The zip a build before 0.3.4 wrote for the update.
LEGACY_UPDATE_BUILD = "AI-NPC-Cyberpunk-Mod-Scripts"


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


def variant_of(game: str, pack: str) -> dict:
    """The game variant (packaging/game-variants.json) a pack is built for; only the Scripts and Runtime differ between games."""
    if game not in GAME_VARIANTS:
        raise SystemExit(f"Unknown game {game}; expected one of {', '.join(GAME_VARIANTS)}.")
    variant = GAME_VARIANTS[game]
    if variant["suffix"] and pack not in GAME_PACKS:
        raise SystemExit(f"The {pack} pack is the same for every game version; upload it without --game.")
    return variant


def built_name(pack: str, version: str, game: str = "2.5") -> str:
    """The name of the zip a build writes for the pack (packaging/build-release.mjs, packaging/build-full.mjs). The Update's name carries the Runtime base it needs
    (Update-0.3.3-to-0.3.4, or Update-0.3.3-and-up-to-0.3.5): update_zip finds it, this returns the pattern with <from> in it."""
    suffix = variant_of(game, pack)["suffix"]
    if pack == "update":
        return f"{UPDATE_TITLE}-<from>-to-{version}{suffix}.zip"
    return f"{LAYOUT[pack][1]}-{version}{suffix}.zip"


def update_zip(packages: Path, version: str, game: str = "2.5") -> Path | None:
    """The one Update zip of this version and game in the folder: AI-NPC-LLM-Companions-Update-<from>-to-<version>[-for-2.31].zip, <from> a version, or a version with "-and-up" (an older "any" is still read)."""
    suffix = variant_of(game, "update")["suffix"]
    pattern = re.compile(rf"{re.escape(UPDATE_TITLE)}-(?:any|\d+(?:\.\d+){{1,3}}(?:-and-up)?)-to-{re.escape(version)}{re.escape(suffix)}\.zip")
    found = sorted(path for path in packages.iterdir() if path.is_file() and pattern.fullmatch(path.name))
    if len(found) > 1:
        raise SystemExit(f"More than one Update zip for {version} in {packages}: {', '.join(path.name for path in found)}.")
    return found[0] if found else None


def legacy_built_name(pack: str, version: str, game: str = "2.5") -> str | None:
    """The name a build before 0.3.4 gave the zip (OmniPack-<version>.zip, AI-NPC-Cyberpunk-Mod-Scripts-<version>.zip), or None for a pack whose name never changed."""
    suffix = variant_of(game, pack)["suffix"]
    if pack == "update":
        return f"{LEGACY_UPDATE_BUILD}-{version}{suffix}.zip"
    title = LEGACY_TITLES.get(pack)
    return f"{title}-{version}{suffix}.zip" if title else None


def legacy_remote_path(pack: str, game: str = "2.5") -> str | None:
    """Where the pack lived before 0.3.4: <folder>/<old title>.zip (the Update was Scripts.zip and the Runtime sat at the root, in the game's folder for another game)."""
    if pack in LEGACY_REMOTE:
        game_folder = variant_of(game, pack)["hfFolder"]
        return f"{game_folder}/{LEGACY_REMOTE[pack]}" if game_folder else LEGACY_REMOTE[pack]
    title = LEGACY_TITLES.get(pack)
    return f"{LAYOUT[pack][0]}/{title}.zip" if title else None


def remote_path(pack: str, game: str = "2.5") -> str:
    """Where the pack lives in the repository: <folder>/<title>.zip, no product prefix, no version. The Scripts and Runtime of
    another game version sit in that game's folder (game-2.31/Runtime.zip)."""
    folder, title = LAYOUT[pack]
    game_folder = variant_of(game, pack)["hfFolder"]
    if game_folder:
        folder = f"{game_folder}/{folder}" if folder else game_folder
    return f"{folder}/{title}.zip" if folder else f"{title}.zip"


def plan(version: str, pack: str, packages: Path, game: str = "2.5", also_old_name: bool = False) -> list[tuple[Path, str]]:
    """The (local file, path in the repository) pair of one pack: its one zip, in the pack's folder. No checksum file goes with it.
    The zip is looked for under its new name, then under the name before 0.3.4; it is published under the new name either way. With
    also_old_name the same file is also published at the old path."""
    if pack not in PACKS:
        raise SystemExit(f"Unknown pack {pack}; expected one of {', '.join(PACKS)}.")
    if not re.fullmatch(r"\d+(\.\d+){1,3}([-+][0-9A-Za-z.-]+)?", version):
        raise SystemExit(f"Invalid version: {version}")
    if pack == "omni-amd":
        if game != "2.5":
            raise SystemExit("The AMD packs are the same for every game version; upload them without --game.")
        found = sorted(path for path in packages.iterdir() if path.is_file() and AMD_NAME.fullmatch(path.name))
        if not found:
            raise SystemExit(f"No OmniAMD-<family>-PyTorch-<v>-ROCm-<v>.zip in {packages} (packaging/build-omni-amd-packs.mjs writes them).")
        return [(path, f"{AMD_FOLDER}/{path.name}") for path in found]
    name = built_name(pack, version, game)
    parts = sorted(packages.glob(f"{name[:-4].replace('<from>', '*')}-part*of*.zip"))
    if parts:
        raise SystemExit(f"{parts[0].name} is a multi-part zip; a pack is uploaded as one zip.")
    zip_path = update_zip(packages, version, game) if pack == "update" else packages / name
    old = legacy_built_name(pack, version, game)
    if (zip_path is None or not zip_path.is_file()) and old and (packages / old).is_file():
        zip_path = packages / old
    if zip_path is None or not zip_path.is_file():
        raise SystemExit(f"Expected exactly one zip for the {pack} pack in {packages}: {name} is missing. A pack is a single zip, never parts.")
    items = [(zip_path, remote_path(pack, game))]
    # A zip that serves two folders (the Gemma 4 E4B vision file) is published at every path, from the one file.
    items += [(zip_path, f"{folder}/{LAYOUT[pack][1]}.zip") for folder in ALSO_IN.get(pack, ())]
    if also_old_name and legacy_remote_path(pack, game):
        items.append((zip_path, legacy_remote_path(pack, game)))
    return items


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
    parser.add_argument("--game", default="2.5", help="the game version a Full install, Update or Runtime zip is built for (2.5 is the default and goes to the top, 2.31 is uploaded to game-2.31/)")
    parser.add_argument("--also-old-name", action="store_true", help="also publish the pack at its path before 0.3.4 (OmniPack.zip, LocalAI-Lite.zip, Scripts.zip, the root Runtime.zip ...), so links to the old names keep working")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.check:
        connect(args.repo)
        print(f"The HF_PACKS_TOKEN secret can write to {args.repo}.", flush=True)
        return 0
    if not (args.version and args.pack and args.packages):
        parser.error("--version, --pack and --packages are required")
    items = plan(args.version, args.pack, args.packages, args.game, args.also_old_name)
    if args.dry_run:
        for local, remote in items:
            print(f"{local} -> {args.repo}/{remote}")
        return 0
    upload(connect(args.repo), args.repo, args.version, args.pack, items)
    return 0


if __name__ == "__main__":
    sys.exit(main())
