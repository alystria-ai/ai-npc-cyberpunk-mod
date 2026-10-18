"""Shared pieces of the cast-expansion voice pipeline (docs/CAST_EXPANSION_RECIPE.md).

Generalises the per-character hand recipes of 2026-10-13 (scripts/clip-search/missing-two/) and 2026-10-18
(scripts/clip-search/rita-wheeler/) so one spec file per character drives every step:

    survey.py     voice files, subtitles, word counts, seconds and TweakDB record checks for one or more voice prefixes
    attribute.py  scene-level speaker check: which scene actor speaks each line of the prefix (never the voice tag alone)
    extract.py    copy the attributed lines out of the installed archives, decode with vgmstream, write the transcripts
    analyze.py    objective clip checks (loudness, peak, clipping, silence, band limit, pitch) and a WavLM speaker check
    asr.py        Whisper small.en against the installed subtitles
    build.py      pick and build the omni-short, omni-long and Pocket references and write the three config rows to staging

Nothing here plays audio, launches the game or talks to a network.  Game dialogue stays out of the repo: decoded clips go to
WORK (E: offload) and references to runtime/ (git-ignored).  Python: vendor/reference-voicestudio/.venv (torch, torchaudio,
soundfile, transformers); survey.py and attribute.py also run on plain Python 3.12.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sqlite3
import struct
import subprocess
import sys
import zlib
from pathlib import Path

MAIN = Path(os.environ.get("CX_MAIN", r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod"))   # main checkout (runtime, vendor, cache)
REPO = Path(__file__).resolve().parents[3]                                                     # this checkout (scripts, docs)
GAME = Path(os.environ.get("CX_GAME", "E:/SteamLibrary/steamapps/common/Cyberpunk 2077"))
VGM = os.environ.get("CX_VGMSTREAM", r"E:\misc\misc1\modding\fmodel\Output\.data\vgmstream-cli.exe")
WORK = Path(os.environ.get("CX_WORK", r"E:\CyberpunkConvai-offload\work\clip-search\cast-expansion"))
LOOKUP = MAIN / "research/cyberpunk/cache/game/localization/index/lookup.sqlite3"
WEM_LISTS = {label: MAIN / f"runtime/voice-cast-inventory-20261001/{label}-wem-paths.txt" for label in ("base", "ep1")}
RESOURCES = MAIN / "research/cyberpunk/cache/game/index/resources.jsonl"
SCENE_EVIDENCE = MAIN / "research/cyberpunk/cache/game/scene-evidence"
PICKED = MAIN / "runtime/voice-references/picked/autobest"
STAGING = REPO / "staging/cast"
NO_WINDOW = 0x08000000 if os.name == "nt" else 0

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def load_extractor():
    spec = importlib.util.spec_from_file_location("ext", REPO / "scripts/Extract-VoiceReferences.py")
    ext = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ext)
    return ext


def read_json(path: Path):
    return json.loads(Path(path).read_text("utf-8-sig"))


def write_json(path: Path, value) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(json.dumps(value, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def spec_path(key: str) -> Path:
    return STAGING / key / "voice-spec.json"


def load_spec(key: str) -> dict:
    spec = read_json(spec_path(key))
    assert spec["key"] == key, "spec key mismatch"
    return spec


def work_dir(key: str) -> Path:
    path = WORK / key
    path.mkdir(parents=True, exist_ok=True)
    return path


_lists_cache: dict | None = None


def wem_lists() -> dict:
    global _lists_cache
    if _lists_cache is None:
        _lists_cache = {label: path.read_text("utf-8").splitlines() for label, path in WEM_LISTS.items()}
    return _lists_cache


WEM_RE = re.compile(r"\\(vo|vo_holocall|vo_helmet|vo_radio)\\(?P<stem>.+)_(?P<variant>[fm])_(?P<hex>[0-9a-f]{16})\.wem$", re.I)


def parse_wem(path: str):
    """(folder, stem, variant, string id as decimal text) of a voice file path, or None."""
    match = WEM_RE.search(path)
    if not match:
        return None
    return match.group(1).lower(), match.group("stem"), match.group("variant").lower(), str(int(match.group("hex"), 16))


def prefix_paths(prefix: str) -> list[tuple[str, str]]:
    """(archive label, path) of every installed English voice file whose stem starts with the prefix (exact stem match first)."""
    out = []
    for label, lines in wem_lists().items():
        for path in lines:
            parsed = parse_wem(path)
            if parsed and parsed[1].lower().startswith(prefix.lower()):
                out.append((label, path))
    return out


class Subtitles:
    def __init__(self):
        self.db = sqlite3.connect("file:" + LOOKUP.as_posix() + "?mode=ro", uri=True)

    def text(self, string_id: str, variant: str = "f") -> str:
        row = self.db.execute("select female,male from entries where domain='subtitle.stringId' and entry_id=?", (string_id,)).fetchone()
        if not row:
            return ""
        female, male = (row[0] or "").strip(), (row[1] or "").strip()
        return (male or female) if variant == "m" else (female or male)


def words(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9']+", text or ""))


def tweakdb_id(name: str) -> bytes:
    """The 5 identifying bytes of a TweakDBID: CRC32 of the name (little endian) then the name length."""
    raw = name.encode("ascii")
    return struct.pack("<IB", zlib.crc32(raw) & 0xFFFFFFFF, len(raw))


def tweakdb_u64(name: str) -> int:
    """The TweakDBID as the uint64 a scene's specCharacterRecordId holds (CRC32 low, name length in bits 32-39)."""
    raw = name.encode("ascii")
    return (zlib.crc32(raw) & 0xFFFFFFFF) | (len(raw) << 32)


_tdb_cache: dict = {}


def tweakdb_has(name: str) -> dict:
    """Which installed TweakDB files contain this record name's id (a hash hit shows the record exists, not that it is the
    body used in a given scene)."""
    result = {}
    for label, file in (("base", "tweakdb.bin"), ("ep1", "tweakdb_ep1.bin")):
        if label not in _tdb_cache:
            path = GAME / "r6/cache" / file
            _tdb_cache[label] = path.read_bytes() if path.is_file() else b""
        result[label] = tweakdb_id(name) in _tdb_cache[label]
    return result


def wem_seconds(data: bytes) -> float | None:
    """Duration of a Wwise WEM from its RIFF header (sample count of the Vorbis/PCM stream), or None if unknown."""
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None
    pos, rate, samples, fmt_tag, block, channels, data_size = 12, None, None, None, None, None, None
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack_from("<I", data, pos + 4)[0]
        body = data[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            fmt_tag, channels, rate = struct.unpack_from("<HHI", body, 0)
            block = struct.unpack_from("<H", body, 12)[0]
            if fmt_tag == 0xFFFF and size >= 0x1C:      # Wwise Vorbis: sample count follows the extensible header
                samples = struct.unpack_from("<I", body, 0x18)[0]
        elif cid == b"vorb" and size >= 4:
            samples = struct.unpack_from("<I", body, 0)[0]
        elif cid == b"data":
            data_size = size
        pos += 8 + size + (size & 1)
    if rate and samples:
        return samples / rate
    if rate and fmt_tag in (1, 0xFFFE) and block and data_size:
        return data_size / block / rate
    return None


def vgm_seconds(wem_path: Path) -> float | None:
    """Duration from vgmstream metadata (fallback when the header is not understood)."""
    result = subprocess.run([VGM, "-m", str(wem_path)], capture_output=True, text=True, creationflags=NO_WINDOW, timeout=60)
    total = re.search(r"stream total samples:\s*(\d+)", result.stdout)
    rate = re.search(r"sample rate:\s*(\d+)", result.stdout)
    return int(total.group(1)) / int(rate.group(1)) if total and rate else None


def decode(wem: Path, wav: Path) -> None:
    result = subprocess.run([VGM, "-i", "-o", str(wav), str(wem)], capture_output=True, text=True, creationflags=NO_WINDOW, timeout=120)
    assert result.returncode == 0, result.stderr


def scenes_for_tokens(tokens: list[str]) -> list[str]:
    """Scene depot paths referenced by quest phases (resources.jsonl) whose path contains any of the tokens."""
    found = set()
    lowered = [t.lower() for t in tokens]
    with RESOURCES.open("r", encoding="utf-8") as handle:
        for line in handle:
            if '"isScene":true' not in line:
                continue
            depot = json.loads(line).get("depotPath", "")
            low = depot.lower()
            if low.endswith(".scene") and any(t in low for t in lowered):
                found.add(depot)
    return sorted(found)
