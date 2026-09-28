"""Extract an explicit, small voice-reference allowlist from local Cyberpunk archives.

No network calls, game writes, model inference, audio filtering, or archive-wide
extraction. The metadata files under runtime/voice-references are the allowlist.
Archive/CR2W/Oodle layouts follow WolvenKit's publicly documented implementation;
this deliberately supports only the single-segment resources needed here.
"""

from __future__ import annotations

import argparse
import array
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import wave


MAX_RESOURCE_BYTES = 32 * 1024 * 1024
MAX_CANDIDATES = 48
ARCHIVES = (
    "archive/pc/content/lang_en_voice.archive",
    "archive/pc/ep1/lang_en_voice.archive",
    "archive/pc/content/lang_en_text.archive",
    "archive/pc/ep1/lang_en_text.archive",
)


def depot_hash(path: str) -> int:
    value = 0xCBF29CE484222325
    for byte in path.lower().replace("/", "\\").encode("ascii"):
        value = ((value ^ byte) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


def contained(path: Path, parent: Path) -> bool:
    return path.resolve().is_relative_to(parent.resolve())


class Archive:
    def __init__(self, game: Path, relative: str):
        self.path = game / relative
        self.relative = relative
        self.entries = {}
        length = self.path.stat().st_size
        with self.path.open("rb") as handle:
            magic, version, index_offset, index_size = struct.unpack("<4sIQI", handle.read(20))
            if magic != b"RDAR" or version != 12 or index_offset + index_size > length:
                raise ValueError(f"Unsupported archive header: {relative}")
            handle.seek(index_offset)
            _, _, _, entries, segments, dependencies = struct.unpack("<IIQIII", handle.read(28))
            if 28 + entries * 56 + segments * 16 + dependencies * 8 > index_size:
                raise ValueError(f"Invalid archive index bounds: {relative}")
            for _ in range(entries):
                hashed, _, _, first, end, _, _, sha1 = struct.unpack("<QqIIIII20s", handle.read(56))
                self.entries[hashed] = (first, end, sha1.hex())
            self.segments = [struct.unpack("<QII", handle.read(16)) for _ in range(segments)]

    def read(self, depot_path: str, oodle: "Oodle") -> tuple[bytes, dict] | None:
        hashed = depot_hash(depot_path)
        if hashed not in self.entries:
            return None
        first, end, expected_sha1 = self.entries[hashed]
        if end != first + 1 or end > len(self.segments):
            raise ValueError(f"Only single-segment resources are supported: {depot_path}")
        offset, stored_size, decoded_size = self.segments[first]
        if not 0 < max(stored_size, decoded_size) <= MAX_RESOURCE_BYTES:
            raise ValueError(f"Resource exceeds extraction bound: {depot_path}")
        if offset + stored_size > self.path.stat().st_size:
            raise ValueError(f"Segment exceeds archive bounds: {depot_path}")
        with self.path.open("rb") as handle:
            handle.seek(offset)
            data = handle.read(stored_size)
        if len(data) != stored_size:
            raise ValueError(f"Short archive read: {depot_path}")
        if stored_size != decoded_size:
            data = oodle.decode(data, decoded_size)
        actual_sha1 = hashlib.sha1(data).hexdigest()
        if actual_sha1 != expected_sha1:
            raise ValueError(f"Archive SHA-1 mismatch: {depot_path}")
        return data, {
            "archive": self.relative,
            "depotPath": depot_path,
            "pathHash": str(hashed),
            "segmentOffset": str(offset),
            "storedBytes": stored_size,
            "decodedBytes": decoded_size,
            "archiveEntrySha1": expected_sha1,
            "sha1Verified": True,
            "sha256": hashlib.sha256(data).hexdigest(),
        }


class Oodle:
    def __init__(self, path: Path):
        self.path = path
        self.library = None

    def decode(self, data: bytes, expected_size: int) -> bytes:
        if data[:4] != b"KARK" or struct.unpack_from("<I", data, 4)[0] != expected_size:
            raise ValueError("Unexpected compression header")
        if self.library is None:
            self.library = ctypes.WinDLL(str(self.path))
            self.function = self.library.OodleLZ_Decompress
            self.function.argtypes = [
                ctypes.c_void_p, ctypes.c_int64, ctypes.c_void_p, ctypes.c_int64,
                ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p,
                ctypes.c_int64, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                ctypes.c_int64, ctypes.c_int,
            ]
            self.function.restype = ctypes.c_int64
        source = ctypes.create_string_buffer(data[8:])
        target = ctypes.create_string_buffer(expected_size)
        size = self.function(source, len(data) - 8, target, expected_size,
                             1, 0, 0, None, 0, None, None, None, 0, 3)
        if size != expected_size:
            raise ValueError("Oodle decompression size mismatch")
        return target.raw


def read_string(payload: bytes) -> str:
    """Read REDengine's signed VLQ length and UTF-8/UTF-16LE CString."""
    first = payload[0]
    negative = bool(first & 0x80)
    length, position, shift = first & 0x3F, 1, 6
    more = bool(first & 0x40)
    while more:
        if position >= 5:
            raise ValueError("Invalid CString length")
        byte = payload[position]
        position += 1
        length |= (byte & 0x7F) << shift
        shift += 7
        more = bool(byte & 0x80)
    count = length if negative else length * 2
    if position + count != len(payload):
        raise ValueError("CString property size mismatch")
    return payload[position:].decode("utf-8" if negative else "utf-16-le")


def local_subtitle(data: bytes, string_id: str) -> tuple[str, dict] | None:
    """Read a specific typed subtitle entry, never a nearby text substring."""
    if data[:4] != b"CR2W" or struct.unpack_from("<I", data, 4)[0] != 195:
        raise ValueError("Unsupported subtitle CR2W version")
    string_offset, string_size, _ = struct.unpack_from("<III", data, 40)
    names_offset, name_count, _ = struct.unpack_from("<III", data, 52)
    names = []
    for index in range(name_count):
        offset, _ = struct.unpack_from("<II", data, names_offset + index * 8)
        if offset >= string_size:
            raise ValueError("Name offset exceeds CR2W string table")
        start = string_offset + offset
        end = data.index(0, start, string_offset + string_size)
        names.append(data[start:end].decode("utf-8"))
    if "localizationPersistenceSubtitleEntries" not in names:
        raise ValueError("Resource is not a subtitle table")
    pattern = struct.pack("<HHIQ", names.index("stringId"), names.index("CRUID"),
                          12, int(string_id))
    position = data.find(pattern)
    if position < 0:
        return None
    if data.find(pattern, position + 1) >= 0:
        raise ValueError("Ambiguous subtitle StringID")
    position += len(pattern)
    variants = {}
    while True:
        name_index = struct.unpack_from("<H", data, position)[0]
        if name_index == 0:
            break
        name_index, type_index, size = struct.unpack_from("<HHI", data, position)
        if size < 4 or position + 4 + size > len(data):
            raise ValueError("Invalid subtitle property bounds")
        name, kind = names[name_index], names[type_index]
        payload = data[position + 8:position + 4 + size]
        if name not in {"femaleVariant", "maleVariant"} or kind != "String":
            raise ValueError(f"Unexpected subtitle property: {name}/{kind}")
        variants[name] = read_string(payload)
        position += 4 + size
    if not variants.get("femaleVariant"):
        raise ValueError("Expected nonempty default/female subtitle variant")
    return variants["femaleVariant"], {"variant": "femaleVariant", "variants": variants}


def hidden_run(arguments: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(arguments, capture_output=True, text=True, check=True,
                          timeout=60, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)


def wav_quality(path: Path) -> dict:
    with wave.open(str(path), "rb") as handle:
        channels, width, rate, frames = handle.getnchannels(), handle.getsampwidth(), handle.getframerate(), handle.getnframes()
        if width != 2:
            raise ValueError("Expected vgmstream's unfiltered 16-bit PCM output")
        samples = array.array("h", handle.readframes(frames))
    if sys.byteorder != "little":
        samples.byteswap()
    peak = max(abs(value) for value in samples)
    rms = math.sqrt(sum(value * value for value in samples) / len(samples))
    return {"channels": channels, "sampleRate": rate, "bitsPerSample": 16,
            "frames": frames, "durationSeconds": frames / rate,
            "peakAbsolute": peak, "rmsDbfs": 20 * math.log10(rms / 32768) if rms else None,
            "clippedSamples": sum(abs(value) >= 32767 for value in samples),
            "nonSilent": bool(peak), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, default=Path("runtime/voice-references/inventory.json"))
    parser.add_argument("--extra-candidates", type=Path, default=Path("runtime/voice-references/longer-candidates.json"))
    parser.add_argument("--output", type=Path, default=Path("runtime/voice-references/extracted"))
    args = parser.parse_args()
    workspace = Path(__file__).resolve().parents[1]
    output = args.output.resolve()
    if not contained(output, workspace / "runtime" / "voice-references"):
        raise ValueError("Output must remain in ignored runtime/voice-references")
    inventory = json.loads(args.inventory.read_text(encoding="utf-8-sig"))
    game = Path(inventory["gameRoot"]).resolve()
    if contained(output, game):
        raise ValueError("Refusing output inside the game directory")
    tool = next(item["path"] for item in inventory["tools"] if item["name"] == "vgmstream-cli")
    ffprobe = next(item["path"] for item in inventory["tools"] if item["name"] == "ffprobe")
    oodle = Oodle(game / "tools/redmod/bin/oo2ext_7_win64.dll")
    archives = [Archive(game, relative) for relative in ARCHIVES]
    candidates = list(inventory["candidates"])
    if args.extra_candidates.exists():
        for query in json.loads(args.extra_candidates.read_text(encoding="utf-8-sig")):
            for item in query["items"]:
                candidates.append({"key": query["key"], "stringId": item["id"],
                    "speakerNames": item["actors"], "wemPath": item["main"],
                    "subtitlePaths": item["paths"], "scenePaths": item["scenePaths"],
                    "durationFromRemoteIndexSeconds": item["duration"], "metadataSource": query["url"]})
    candidates = list({item["wemPath"]: item for item in candidates}.values())
    if len(candidates) > MAX_CANDIDATES:
        raise ValueError("Candidate allowlist exceeds the extraction cap")
    output.mkdir(parents=True, exist_ok=True)
    manifest = {"schemaVersion": 1, "gameRoot": str(game), "audioProcessing": "vgmstream decode only; no gain, filtering, resampling, trimming, or concatenation",
        "speakerAttribution": "SoundDB indexed scene speaker and character-specific WEM path; local archive hash and exact subtitle entry verified",
        "listeningVerified": False, "voiceCloneApproved": False, "candidates": []}
    subtitle_cache = {}
    for candidate in candidates:
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", candidate["key"]):
            raise ValueError("Invalid character key")
        if not re.fullmatch(r"[0-9]{1,20}", candidate["stringId"]):
            raise ValueError("Invalid subtitle StringID")
        if Path(candidate["wemPath"]).stem.rsplit("_", 1)[-1].lower() != f"{int(candidate['stringId']):016x}":
            raise ValueError("WEM filename localization ID does not match the requested subtitle")
        if candidate["key"] == "8ug8ear" or not candidate["speakerNames"] or not candidate["scenePaths"]:
            raise ValueError("Unverified speaker ownership is not eligible for extraction")
        matches = [match for archive in archives if (match := archive.read(candidate["wemPath"], oodle))]
        if len(matches) != 1:
            raise ValueError(f"Expected one local voice resource: {candidate['wemPath']}")
        wem_data, voice_source = matches[0]
        if wem_data[:4] != b"RIFF" or wem_data[8:12] != b"WAVE" or struct.unpack_from("<I", wem_data, 4)[0] + 8 != len(wem_data):
            raise ValueError("Voice resource is not a complete RIFF WAVE container")
        subtitle_matches = []
        for subtitle_path in candidate["subtitlePaths"]:
            if subtitle_path not in subtitle_cache:
                subtitle_cache[subtitle_path] = [match for archive in archives if (match := archive.read(subtitle_path, oodle))]
            for subtitle_data, source in subtitle_cache[subtitle_path]:
                parsed = local_subtitle(subtitle_data, candidate["stringId"])
                if parsed:
                    text, variant_data = parsed
                    subtitle_matches.append((text, dict(source, **variant_data)))
        if not subtitle_matches or len({item[0] for item in subtitle_matches}) != 1:
            raise ValueError(f"Missing or inconsistent installed subtitle text: {candidate['stringId']}")
        text = subtitle_matches[0][0]
        directory = output / candidate["key"]
        directory.mkdir(exist_ok=True)
        stem = candidate["stringId"]
        wem_path, wav_path, text_path = (directory / (stem + suffix) for suffix in (".wem", ".wav", ".txt"))
        wem_path.write_bytes(wem_data)
        decoder = hidden_run([tool, "-i", "-o", str(wav_path), str(wem_path)])
        quality = wav_quality(wav_path)
        if not quality["nonSilent"]:
            raise ValueError("Decoded clip is silent")
        probe = json.loads(hidden_run([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(wav_path)]).stdout)
        text_path.write_text(text + "\n", encoding="utf-8")
        item = {"key": candidate["key"], "stringId": candidate["stringId"],
            "speakerNames": candidate["speakerNames"], "scenePaths": candidate["scenePaths"],
            "sceneSpeakerMappingSource": candidate.get("metadataSource") or next(query["url"] for query in inventory["queries"] if query["key"] == candidate["key"]),
            "source": voice_source, "subtitleSources": [item[1] for item in subtitle_matches],
            "transcript": text, "transcriptSource": "installed_game_subtitle_entry", "wemPath": str(wem_path), "wavPath": str(wav_path),
            "transcriptPath": str(text_path), "wav": quality,
            "durationFromRemoteIndexSeconds": candidate["durationFromRemoteIndexSeconds"],
            "durationDifferenceSeconds": quality["durationSeconds"] - candidate["durationFromRemoteIndexSeconds"],
            "decoderOutput": decoder.stdout.strip(), "ffprobe": probe,
            "status": "extracted_and_local_transcript_verified",
            "listeningVerified": False, "voiceCloneApproved": False}
        manifest["candidates"].append(item)
        (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"key": item["key"], "id": stem, "duration": quality["durationSeconds"], "sha1Verified": True, "localTranscriptVerified": True}), flush=True)
    print(json.dumps({"manifest": str(output / "manifest.json"), "clips": len(manifest["candidates"])}))


if __name__ == "__main__":
    main()
