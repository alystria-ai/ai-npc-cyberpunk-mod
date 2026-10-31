"""Read single files out of the game's archives and turn them into JSON with WolvenKit, for the voice mapping (docs/CAST_SWEEP.md, "Voice models").

    from game_files import GameFiles
    gf = GameFiles(out_dir)                      # out_dir: any scratch folder
    paths = gf.export(["base\\\\quest\\\\tertiary_characters\\\\tom.ent", ...])   # {depot path: parsed JSON root chunk (the "Data"."RootChunk" object) or None}

The archives are only read.  Files are looked up by the FNV-1a 64 hash of the lower case depot path in every `.archive` of the game's content and ep1 folders (a later
archive of Phantom Liberty wins over the base game, as the game does), written under <out_dir>/raw, and converted by `WolvenKit.CLI.exe convert serialize` of the
project's vendor folder (about 2 s plus 0.1 s per file).  Nothing is written to the game folder.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MAIN = Path(os.environ.get("CX_MAIN", r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod"))
GAME = Path(os.environ.get("CX_GAME", "E:/SteamLibrary/steamapps/common/Cyberpunk 2077"))
NO_WINDOW = 0x08000000 if os.name == "nt" else 0

sys.path.insert(0, str(REPO / "scripts"))
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("ext", REPO / "scripts/Extract-VoiceReferences.py")
ext = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ext)


class GameFiles:
    def __init__(self, out_dir: Path, game: Path = GAME):
        self.game = game
        self.out = Path(out_dir)
        self.oodle = ext.Oodle(game / "tools/redmod/bin/oo2ext_7_win64.dll")
        self.archives = []
        for folder in ("content", "ep1"):
            for path in sorted((game / "archive/pc" / folder).glob("*.archive")):
                if path.name.startswith(("lang_", "audio_")):
                    continue
                self.archives.append(ext.Archive(game, f"archive/pc/{folder}/{path.name}"))

    def archive_of(self, depot: str):
        """The archive that wins for a depot path (Phantom Liberty after the base game), or None."""
        hashed = ext.depot_hash(depot)
        found = None
        for archive in self.archives:
            if hashed in archive.entries:
                found = archive
        return found

    def export(self, depots: list[str]) -> dict:
        """{depot path: the RootChunk of the file as JSON, or None when the game has no such file}.  Files already exported are not read again."""
        env = {**os.environ, "DOTNET_ROOT": str(MAIN / "vendor/dotnet-runtime-10.0.12"), "DOTNET_PROCESSOR_COUNT": "2"}
        cli = str(MAIN / "vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe")
        flags = NO_WINDOW | 0x00004000            # no window, below normal priority
        depots = [d.replace("/", "\\").lower() for d in depots]
        todo: dict[str, list[str]] = {}
        for depot in depots:
            raw = self.out / "raw" / Path(*depot.split("\\"))
            if raw.with_name(raw.name + ".json").is_file():
                continue
            archive = self.archive_of(depot)
            if archive is not None:
                todo.setdefault(archive.relative, []).append(depot)
        convert = []
        for relative, group in todo.items():
            for start in range(0, len(group), 25):
                batch = group[start:start + 25]
                pattern = "^(" + "|".join(re.escape(d) for d in batch) + ")$"
                subprocess.run([cli, "extract", str(self.game / relative), "--outpath", str(self.out / "raw"), "--regex", pattern], env=env, cwd=str(MAIN),
                               capture_output=True, creationflags=flags, timeout=3600)
                convert += [str(self.out / "raw" / Path(*d.split("\\"))) for d in batch if (self.out / "raw" / Path(*d.split("\\"))).is_file()]
        for start in range(0, len(convert), 40):
            subprocess.run([cli, "convert", "serialize", *convert[start:start + 40]], env=env, cwd=str(MAIN), capture_output=True, creationflags=flags, timeout=3600)
        result = {}
        for depot in depots:
            raw = self.out / "raw" / Path(*depot.split("\\"))
            js = raw.with_name(raw.name + ".json")
            try:
                result[depot] = json.loads(js.read_text("utf-8-sig"))["Data"]["RootChunk"] if js.is_file() else None
            except (ValueError, KeyError):
                result[depot] = None                # the converter left an empty or partial file for this one
        return result
