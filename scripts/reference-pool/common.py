"""Shared paths and helpers for the expanded reference-clip pool tools (scripts/reference-pool/).

The pool is built from the game's own English voice archives.  Everything large lives on E: (never C:), under
WORK; nothing here is committed except these scripts.  Game dialogue, audio and transcripts stay in WORK.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = Path("E:/CyberpunkConvai-offload/work/reference-pool-expanded")
SRC = WORK / "_work"                      # listings, extracted subtitle JSON, catalog
GAME = Path("E:/SteamLibrary/steamapps/common/Cyberpunk 2077")
WK = ROOT / "vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe"
DOTNET = ROOT / "vendor/dotnet-runtime-10.0.12"
VGM = Path(r"E:\misc\misc1\modding\fmodel\Output\.data\vgmstream-cli.exe")   # r2055 (sha256 71027230...); it was under C:\Users\akshi\Downloads\misc
LIKENESS = Path("E:/CyberpunkConvai-offload/work/likeness-phase1/out")
DATASET = ROOT / "runtime/voice-data-expansion-20261004/final-corpus-assembly/final-entries/final-entry-v5-001/data"
POOL_INDEX = Path("E:/CyberpunkConvai-offload/work/reference-picker/pool-index.json")
ARCHIVES = {"content": GAME / "archive/pc/content", "ep1": GAME / "archive/pc/ep1"}
# Hidden, below-normal priority (the game is running while this works).
FLAGS = (subprocess.CREATE_NO_WINDOW | 0x00004000) if os.name == "nt" else 0

WEM_RE = re.compile(r"^(?P<dir>[^\\/]*[\\/]localization[\\/]en-us[\\/](?P<vo>vo[^\\/]*))[\\/](?P<stem>.+?)_(?P<fm>[fm])_(?P<hex>[0-9a-f]{16})(?P<rest>[^\\/]*)\.wem$")
# Scene-ish tokens that end the actor tag inside a voice file name (<actor>_<scene>_f_<hex>.wem).
SPLIT = re.compile(r"_(?:q\d{3}|mq\d{3}|sq\d{3}|sts_|vs_vset|vs_|finalboards|scene_|quest|ep1_|ma_|ncpd|civ_|gang_|ep1|cct|mq|sq|q\d|default|generic|boss|minor|main|side|ct_|v_)")
GENERIC_TAG = re.compile(r"^(civ|gang|merc|ncpd|ncpd_|corpo|nomad|fixer)_")


def tag_of(stem: str) -> str:
    stem = re.split(r"_(?:[fm])_[0-9a-f]{16}", stem)[0]
    match = SPLIT.search(stem)
    return stem[: match.start()] if match and match.start() > 0 else stem


def read_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path: Path, value, indent=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=indent, separators=None if indent else (",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def wolven(args, log: Path):
    env = dict(os.environ, DOTNET_ROOT=str(DOTNET))
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "a", encoding="utf8") as out:
        code = subprocess.run([str(WK), *map(str, args)], stdout=out, stderr=subprocess.STDOUT, env=env, creationflags=FLAGS).returncode
    if code:
        raise RuntimeError(f"WolvenKit failed ({code}); see {log}")
