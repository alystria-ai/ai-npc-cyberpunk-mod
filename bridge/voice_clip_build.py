"""Build a character's voice reference clips from the player's own game files (docs/VOICE_CLIPS_FROM_GAME.md).

    python voice_clip_build.py build --manifest voice-clip-manifest.json --key judy-alvarez --game <game folder> --vgmstream <vgmstream-cli.exe> --out <folder> [--kinds omni-short,omni-long,pocket]
    python voice_clip_build.py build-language --manifest characters/voice-language-clips/de.json --key panam-palmer --game <game folder> --vgmstream <vgmstream-cli.exe> --out <references>/multilingual/de
    python voice_clip_build.py check --game <game folder>

`build-language` makes the dubbed clip of a multilingual pack (docs/VOICE_LANGUAGE_PACKS.md, "Clips on demand") from the player's own `lang_<xx>_voice.archive`; it exits 3 when the base
game has no voice archive of that language (the caller then downloads the clip).

The manifest names, for every voice and kind, the game's own English voice lines (path inside lang_en_voice.archive), their order, how each line is turned
into 24 kHz mono, the gain and the hash of the clip it must give.  This file does the same work as the pipeline that cut the shipped clips (WolvenKit
unbundle, vgmstream decode, mono, resample, join with 0.4 s of silence, 16-bit PCM) with no WolvenKit: a small reader of the game's .archive format
(RDAR), vgmstream for the .wem decode and numpy or scipy for the rest.  Only numpy and scipy are needed (both are in the Runtime's Python).

Nothing of the game is written: archives are opened read only, the few lines a character needs are read at their offsets, and the decoded audio never
leaves this process except as the finished clip.  Exit code 0 when every requested clip was written, 3 when the game has no English voice archive (the
caller then downloads the clip), 2 for any other failure (one line on stderr says which).
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

RATE = 24000
GAP_SAMPLES = 9600                       # 0.4 s of digital silence between clips
ARCHIVE_NAMES = {"content": "archive/pc/content/lang_en_voice.archive", "ep1": "archive/pc/ep1/lang_en_voice.archive"}
OODLE_DLLS = ("bin/x64/oo2ext_7_win64.dll", "tools/redmod/bin/oo2ext_7_win64.dll")
BELOW_NORMAL_PRIORITY = 0x00004000
NO_WINDOW = 0x08000000
EXIT_NO_ENGLISH_VOICE = 3
EXIT_FAILED = 2

_ENTRY = np.dtype([("hash", "<u8"), ("timestamp", "<i8"), ("flags", "<u4"), ("first", "<u4"), ("end", "<u4"), ("a", "<u4"), ("b", "<u4"), ("sha1", "V20")])
_SEGMENT = np.dtype([("offset", "<u8"), ("size", "<u4"), ("decoded", "<u4")])


class BuildError(Exception):
    pass


# ---- the game's archive format --------------------------------------------------------------------------------------

def depot_hash(path: str) -> int:
    """FNV-1a 64 of the lower-case depot path with backslashes (how the archive names its files)."""
    value = 0xCBF29CE484222325
    for byte in path.lower().replace("/", "\\").encode("ascii"):
        value = ((value ^ byte) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return value


class Oodle:
    """OodleLZ_Decompress from the oo2ext DLL the game ships.  Voice lines are stored whole (no Kraken), so this is only a fall back."""

    def __init__(self, game: Path):
        self.path = next((game / rel for rel in OODLE_DLLS if (game / rel).is_file()), None)
        self.function = None

    def decode(self, data: bytes, size: int) -> bytes:
        if data[:4] != b"KARK" or struct.unpack_from("<I", data, 4)[0] != size:
            raise BuildError("unexpected compression header")
        if self.path is None:
            raise BuildError("the game's oo2ext_7_win64.dll was not found")
        if self.function is None:
            library = ctypes.WinDLL(str(self.path))
            self.function = library.OodleLZ_Decompress
            self.function.argtypes = [ctypes.c_void_p, ctypes.c_int64, ctypes.c_void_p, ctypes.c_int64, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p,
                                      ctypes.c_int64, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int64, ctypes.c_int]
            self.function.restype = ctypes.c_int64
        source = ctypes.create_string_buffer(data[8:])
        target = ctypes.create_string_buffer(size)
        if self.function(source, len(data) - 8, target, size, 1, 0, 0, None, 0, None, None, None, 0, 3) != size:
            raise BuildError("Oodle decompression size mismatch")
        return target.raw


class Archive:
    """Read only view of one .archive.  Opening reads the index (about 7 MB for the English voice archive, 15 ms warm) and nothing else."""

    def __init__(self, path: Path, oodle: Oodle):
        self.path = path
        self.oodle = oodle
        with open(path, "rb") as handle:
            magic, version, index_offset, index_size = struct.unpack("<4sIQI", handle.read(20))
            if magic != b"RDAR" or version != 12:
                raise BuildError(f"{path.name} is not a supported archive")
            handle.seek(index_offset)
            index = handle.read(index_size)
        _, _, _, entries, segments, _ = struct.unpack_from("<IIQIII", index, 0)
        self.entries = np.frombuffer(index, dtype=_ENTRY, count=entries, offset=28)
        self.segments = np.frombuffer(index, dtype=_SEGMENT, count=segments, offset=28 + entries * 56)
        self.order = np.argsort(self.entries["hash"], kind="stable")         # a stable sort keeps the first physical row of a repeated hash, as the game does
        self.sorted_hashes = self.entries["hash"][self.order]

    def read(self, depot_path: str) -> bytes | None:
        wanted = depot_hash(depot_path)
        at = int(np.searchsorted(self.sorted_hashes, wanted))
        if at >= len(self.sorted_hashes) or self.sorted_hashes[at] != wanted:
            return None
        entry = self.entries[self.order[at]]
        if int(entry["end"]) != int(entry["first"]) + 1:
            raise BuildError(f"{depot_path} has more than one segment")
        segment = self.segments[int(entry["first"])]
        with open(self.path, "rb") as handle:
            handle.seek(int(segment["offset"]))
            data = handle.read(int(segment["size"]))
        if len(data) != int(segment["size"]):
            raise BuildError(f"short read of {depot_path}")
        if int(segment["size"]) != int(segment["decoded"]):
            data = self.oodle.decode(data, int(segment["decoded"]))
        if hashlib.sha1(data).digest() != bytes(entry["sha1"]):
            raise BuildError(f"SHA-1 mismatch for {depot_path}")
        return data


def open_archives(game: Path) -> dict[str, Archive]:
    oodle = Oodle(game)
    found = {name: Archive(game / rel, oodle) for name, rel in ARCHIVE_NAMES.items() if (game / rel).is_file()}
    if "content" not in found:
        raise FileNotFoundError("no English voice archive")
    return found


# ---- decode and resample --------------------------------------------------------------------------------------------

def decode_wem(vgmstream: Path, wem: bytes, priority: int = BELOW_NORMAL_PRIORITY) -> tuple[np.ndarray, int]:
    """vgmstream's 16-bit PCM of one .wem as float32 (n, channels) in [-1, 1) and its rate."""
    with tempfile.TemporaryDirectory(prefix="aivx-") as folder:
        source, target = Path(folder) / "line.wem", Path(folder) / "line.wav"
        source.write_bytes(wem)
        flags = (NO_WINDOW | priority) if os.name == "nt" else 0              # no console window, below normal priority unless the caller says otherwise
        done = subprocess.run([str(vgmstream), "-o", str(target), str(source)], capture_output=True, creationflags=flags)
        if done.returncode or not target.exists():
            raise BuildError("vgmstream could not decode a voice line")
        with wave.open(str(target), "rb") as handle:
            channels, width, rate, frames = handle.getnchannels(), handle.getsampwidth(), handle.getframerate(), handle.getnframes()
            raw = handle.readframes(frames)
    if width != 2:
        raise BuildError("vgmstream did not give 16-bit audio")
    return np.frombuffer(raw, dtype="<i2").reshape(-1, channels).astype(np.float32) * np.float32(1 / 32768), rate


def quantise_sf(signal: np.ndarray) -> np.ndarray:
    """float -> 16-bit PCM the way python-soundfile's libsndfile 1.2 writes it.

    Measured against soundfile 0.14 on 3.7 million values (edge cases included, none differ): floor(x * 32768 + 2**-17) in double precision, clipped.  The 2**-17
    is why a float that is a hair below a whole step (or a hair below zero) still lands on that step.
    """
    scaled = np.floor(signal.astype(np.float64) * 32768.0 + 2.0 ** -17)
    return np.clip(scaled, -32768, 32767).astype(np.int16)


def quantise_js(signal: np.ndarray) -> np.ndarray:
    """float -> 16-bit PCM the way the reference picker's encoder wrote it (scripts/reference-picker/audio.mjs): Math.round(clamp(v) * 32767), halves up."""
    scaled = np.floor(np.clip(signal.astype(np.float64), -1, 1) * 32767 + 0.5)
    return scaled.astype(np.int16)


QUANTISERS = {"sf": quantise_sf, "js": quantise_js}


def dequantise(samples: np.ndarray) -> np.ndarray:
    """16-bit PCM -> float32 the way libsndfile and the picker read it (scale 1/32768)."""
    return samples.astype(np.float32) * np.float32(1 / 32768)


def resample_torch_style(signal: np.ndarray, source_rate: int, target_rate: int = RATE) -> np.ndarray:
    """torchaudio.functional.resample with its defaults (sinc_interp_hann, lowpass_filter_width 6, rolloff 0.99), float32.

    The same torch operations torchaudio runs (its kernel in float32, then one strided conv1d), written out here because the Runtime carries torch and not torchaudio.
    The result is the sample-for-sample result of torchaudio on the same torch build.  Without torch, `resample_torch_numpy` (within one 16-bit step) is used.
    """
    try:
        import torch
    except ImportError:
        return resample_torch_numpy(signal, source_rate, target_rate)
    divisor = math.gcd(source_rate, target_rate)
    orig, new = source_rate // divisor, target_rate // divisor
    base = min(orig, new) * 0.99
    width = math.ceil(6 * orig / base)
    with torch.no_grad():
        idx = torch.arange(-width, width + orig, dtype=torch.float32)[None, None] / orig
        t = torch.arange(0, -new, -1, dtype=torch.float32)[:, None, None] / new + idx
        t *= base
        t = t.clamp_(-6, 6)
        window = torch.cos(t * math.pi / 6 / 2) ** 2
        t *= math.pi
        kernels = torch.where(t == 0, torch.tensor(1.0).to(t), t.sin() / t)
        kernels *= window * (base / orig)
        wave = torch.from_numpy(np.ascontiguousarray(signal, dtype=np.float32))[None]
        padded = torch.nn.functional.pad(wave, (width, width + orig))
        out = torch.nn.functional.conv1d(padded[:, None], kernels, stride=orig).transpose(1, 2).reshape(1, -1)
        return out[0, : math.ceil(new * len(signal) / orig)].numpy().copy()


def resample_torch_numpy(signal: np.ndarray, source_rate: int, target_rate: int = RATE) -> np.ndarray:
    """The same resampler in float32 numpy, for a machine without torch (a few samples in a clip differ by one 16-bit step from torchaudio's)."""
    divisor = math.gcd(source_rate, target_rate)
    orig, new = source_rate // divisor, target_rate // divisor
    base = np.float32(min(orig, new) * 0.99)
    width = math.ceil(6 * orig / float(base))
    taps = 2 * width + orig
    idx = np.arange(-width, width + orig, dtype=np.float32)[None, :] / np.float32(orig)
    t = np.arange(0, -new, -1, dtype=np.float32)[:, None] / np.float32(new) + idx
    t = np.clip(t * base, -6, 6).astype(np.float32)
    window = np.cos(t * np.float32(math.pi) / np.float32(6) / np.float32(2)) ** 2
    t = t * np.float32(math.pi)
    safe = np.where(t == 0, np.float32(1), t)
    kernel = np.where(t == 0, np.float32(1), np.sin(safe) / safe).astype(np.float32) * window.astype(np.float32) * np.float32(base / orig)
    length = len(signal)
    padded = np.zeros(width + length + width + orig, dtype=np.float32)
    padded[width:width + length] = signal
    frames = (len(padded) - taps) // orig + 1
    starts = np.arange(frames) * orig
    out = np.empty((frames, new), dtype=np.float32)
    block = 4096
    for first in range(0, frames, block):
        rows = starts[first:first + block, None] + np.arange(taps)[None, :]
        out[first:first + block] = padded[rows] @ kernel.T
    return out.reshape(-1)[: math.ceil(new * length / orig)]


def resample_poly_style(signal: np.ndarray, source_rate: int, target_rate: int = RATE, wide: bool = False) -> np.ndarray:
    """scipy.signal.resample_poly to float32.  `wide` computes in float64 first (what scipy before 1.16 did with a float32 signal)."""
    try:
        from scipy.signal import resample_poly
    except ImportError as error:
        raise BuildError("scipy is not installed") from error
    divisor = math.gcd(source_rate, target_rate)
    return resample_poly(signal.astype(np.float64) if wide else signal, target_rate // divisor, source_rate // divisor).astype(np.float32)


def resample_js_style(signal: np.ndarray, source_rate: int, target_rate: int = RATE) -> np.ndarray:
    """The reference picker's port of torchaudio's resampler (scripts/reference-picker/audio.mjs): float64 kernel and sums, float32 result."""
    divisor = math.gcd(source_rate, target_rate)
    orig, new = source_rate // divisor, target_rate // divisor
    base = min(orig, new) * 0.99
    width = math.ceil(6 * orig / base)
    taps = 2 * width + orig
    phase = np.arange(new, dtype=np.float64)[:, None]
    k = np.arange(taps, dtype=np.float64)[None, :]
    t = np.clip((-phase / new + (k - width) / orig) * base, -6, 6)
    window = np.cos(t * math.pi / 6 / 2) ** 2
    x = t * math.pi
    safe = np.where(x == 0, 1.0, x)
    kernel = np.where(x == 0, 1.0, np.sin(safe) / safe) * window * (base / orig)
    length = len(signal)
    frames = (length + 2 * width + orig - taps) // orig + 1
    padded = np.zeros(width + length + width + orig + taps, dtype=np.float64)
    padded[width:width + length] = signal
    out = np.zeros((frames, new), dtype=np.float64)
    starts = np.arange(frames) * orig
    for k in range(taps):                          # the picker adds the taps one after the other in double precision: the same order gives the same last bit
        out += padded[starts + k][:, None] * kernel[:, k][None, :]
    return out.reshape(-1)[: math.ceil(new * length / orig)].astype(np.float32)


def line_to_24k(signal: np.ndarray, rate: int, how: str) -> np.ndarray:
    """One decoded line (n, channels) -> 24 kHz mono float32 as the clip is joined.

    'poly'   mono, scipy resample_poly, written as a 16-bit file and read back (the line came from the pool of decoded 24 kHz lines first); 'poly64' computes it in float64.
    'torch'  mono, then torchaudio's resampler when the clip was joined (the line was decoded at the native rate).
    'js'     mono, then the picker's own port of that resampler when the clip was joined.
    """
    mono = signal.mean(axis=1, dtype=np.float32) if signal.shape[1] > 1 else signal[:, 0]
    if how in ("poly", "poly64"):
        mono = resample_poly_style(mono, rate, wide=how == "poly64") if rate != RATE else mono
        return dequantise(quantise_sf(mono))
    if how == "torch":
        return resample_torch_style(mono, rate) if rate != RATE else mono
    if how == "js":
        return resample_js_style(mono, rate) if rate != RATE else mono
    raise BuildError(f"unknown resampler {how!r}")


def apply_gain(samples: np.ndarray, gain_db: float) -> np.ndarray:
    """The loudness stage of 2026-10-14 (scripts/clip-search/loud43/apply_loud43.py) on a clip as written (int16): read back, one linear gain, rounded to 16 bits."""
    raw = dequantise(samples).astype(np.float64)
    return (np.round(np.clip(raw * 10 ** (gain_db / 20), -1, 1) * 32767) / 32767).astype(np.float32)


def exact_gain(raw: np.ndarray, shipped: np.ndarray) -> float | None:
    """The gain in dB that turns `raw` (int16, the clip before the loudness stage) into `shipped` (int16) with every sample equal, or None when no gain does.

    The stage computed its gain from the clip's loudness and the manifest keeps only what is needed to repeat it: each sample says in which interval the linear gain must lie
    (round(raw * gain * 32767) must hit the sample), the intervals are intersected and the middle of what is left is taken.  `quantise_sf` writes k/32767 one step lower for
    a negative k, which is undone here to find k.
    """
    if len(raw) != len(shipped):
        return None
    r = raw.astype(np.float64) / 32768.0
    k = np.where(shipped < 0, shipped.astype(np.int64) + 1, shipped.astype(np.int64)).astype(np.float64)
    live = r != 0
    if (k[~live] != 0).any():
        return None
    r, k = r[live], k[live]
    low, high = (k - 0.5) / (32767.0 * r), (k + 0.5) / (32767.0 * r)
    low, high = np.minimum(low, high), np.maximum(low, high)
    clipped = np.abs(k) == 32767                       # a sample at the ceiling only says the gain is at least this large
    low[clipped] = 32766.5 / (32767.0 * np.abs(r[clipped]))
    high[clipped] = np.inf
    lo, hi = float(low.max()), float(high.min())
    if not lo <= hi:
        return None
    middle = (lo + hi) / 2 if math.isfinite(hi) else lo * 1.0000001
    return 20 * math.log10(middle)


# ---- one clip ---------------------------------------------------------------------------------------------------------

def build_clip(spec: dict, archives: dict[str, Archive], vgmstream: Path, cache: dict | None = None) -> np.ndarray:
    """int16 samples of one clip from its manifest entry: {"lines": [{"path", "archive", "how"}...], "writer": "sf" | "js", "gainDb": float | None}."""
    cache = {} if cache is None else cache
    parts, last = [], len(spec["lines"]) - 1
    for at, line in enumerate(spec["lines"]):
        key = (line["path"], line["how"])
        if key not in cache:
            archive = archives.get(line["archive"])
            if archive is None:
                raise BuildError(f"the {line['archive']} voice archive is not installed")
            wem = archive.read(line["path"])
            if wem is None:
                raise BuildError(f"{line['path']} is not in this game version")
            signal, rate = decode_wem(vgmstream, wem)
            cache[key] = line_to_24k(signal, rate, line["how"])
        parts.append(cache[key])
        if at < last:
            parts.append(np.zeros(GAP_SAMPLES, dtype=np.float32))
    joined = np.concatenate(parts)
    written = QUANTISERS[spec.get("writer", "sf")](joined)
    if spec.get("gainDb"):
        written = quantise_sf(apply_gain(written, float(spec["gainDb"])))
    return written


# ---- the language clips (dubs) ------------------------------------------------------------------------------------------
#
# The multilingual packs (scripts/voice-packs/) were made by a different pipeline than the English clips: each line is decoded and resampled once, kept as float
# (no 16-bit file in between), the lines are joined with 0.4 s of silence, an optional gain (a plain linear factor, recovered per clip) is applied in double
# precision and the result is written with numpy's rint(x * 32767).  A language manifest (characters/voice-language-clips/<lang>.json) names, per voice, the dub's
# lines (archive and path under base\localization\<locale>\), how each is made 24 kHz and the gain; `build-language` repeats that on the player's own dub archive.

LANGUAGE_ARCHIVE_NAMES = {"content": "archive/pc/content/lang_{name}_voice.archive", "ep1": "archive/pc/ep1/lang_{name}_voice.archive"}
LANGUAGE_TOP = {"content": "base", "ep1": "ep1"}
LANGUAGE_HOWS = ("pack", "pack64", "packv")


def quantise_pack(joined: np.ndarray, gain: float | None = None) -> np.ndarray:
    """float -> 16-bit PCM as the pack builder wrote it (scripts/voice-packs/vp_common.py write_pcm16 after the gain stage): optional linear gain in double precision, clipped,
    then rint(x * 32767)."""
    wide = joined.astype(np.float64)
    if gain:
        wide = np.clip(wide * gain, -1.0, 1.0)
    return np.clip(np.rint(wide * 32767.0), -32768, 32767).astype(np.int16)


def pack_line_to_24k(signal: np.ndarray, rate: int, how: str) -> np.ndarray:
    """One decoded dub line (n, channels) -> 24 kHz mono float32 the way the pack builder made it.

    'pack'    mono mean of the channels, scipy resample_poly in float32 (no 16-bit file in between).  'pack64' computes the resampling in float64.
    'packv'   V's own recipe (scripts/clip-search/v-voice): the left channel when the channels are decorrelated, else their mean, then the same resampler, then the
              silence below -45 dBFS at both ends trimmed with 80 ms of margin.
    """
    if how in ("pack", "pack64"):
        mono = signal.mean(axis=1, dtype=np.float32) if signal.shape[1] > 1 else signal[:, 0]
        return resample_poly_style(mono, rate, wide=how == "pack64") if rate != RATE else mono
    if how == "packv":
        if signal.shape[1] == 1:
            mono = signal[:, 0]
        else:
            left, right = signal[:, 0].astype(np.float64), signal[:, 1].astype(np.float64)
            mean_rms = math.sqrt(float((((left + right) / 2) ** 2).mean()))
            left_rms = math.sqrt(float((left ** 2).mean())) or 1e-9
            mono = ((signal[:, 0] + signal[:, 1]) / 2).astype(np.float32) if mean_rms / left_rms >= 0.9 else signal[:, 0]
        if rate != RATE:
            mono = resample_poly_style(mono, rate)
        n = len(mono) // 240 * 240
        frames = np.sqrt((mono[:n].reshape(-1, 240) ** 2).mean(1)) + 1e-9
        loud = np.where(20 * np.log10(frames) > -45.0)[0]
        if not len(loud):
            return mono
        lo = max(0, loud[0] * 240 - int(0.08 * RATE))
        hi = min(len(mono), (loud[-1] + 1) * 240 + int(0.08 * RATE))
        return mono[lo:hi]
    raise BuildError(f"unknown resampler {how!r}")


def language_depot_path(locale: str, line: list) -> tuple[str, str]:
    """(archive name, depot path) of a manifest line [archive, path under localization\\<locale>\\]."""
    archive, rest = line[0], line[1]
    return archive, f"{LANGUAGE_TOP[archive]}\\localization\\{locale}\\{rest}"


def joined_language_clip(spec: dict, locale: str, archives: dict[str, Archive], vgmstream: Path, cache: dict | None = None) -> np.ndarray:
    """The float32 join of a language voice's lines (0.4 s of silence between), clipped to [-1, 1], before any gain."""
    cache = {} if cache is None else cache
    how = spec.get("how", "pack")
    parts = []
    last = len(spec["lines"]) - 1
    for at, line in enumerate(spec["lines"]):
        key = (line[0], line[1], how)
        if key not in cache:
            archive_name, path = language_depot_path(locale, line)
            archive = archives.get(archive_name)
            if archive is None:
                raise BuildError(f"the {archive_name} voice archive of this language is not installed")
            wem = archive.read(path)
            if wem is None:
                raise BuildError(f"{path} is not in this game version")
            signal, rate = decode_wem(vgmstream, wem)
            cache[key] = pack_line_to_24k(signal, rate, how)
        parts.append(cache[key])
        if at < last:
            parts.append(np.zeros(GAP_SAMPLES, dtype=np.float32))
    return np.clip(np.concatenate(parts), -1.0, 1.0) if parts else np.zeros(0, dtype=np.float32)


def build_language_clip(spec: dict, locale: str, archives: dict[str, Archive], vgmstream: Path, cache: dict | None = None) -> np.ndarray:
    """int16 samples of one language voice from its manifest entry: {"lines": [[archive, path]...], "how": "pack" | "pack64" | "packv", "gain": linear factor | None}."""
    return quantise_pack(joined_language_clip(spec, locale, archives, vgmstream, cache), spec.get("gain"))


def exact_pack_gain(joined: np.ndarray, shipped: np.ndarray) -> float | None:
    """The linear gain that turns `joined` (float32, the clip before the gain stage) into `shipped` (int16) with every sample equal under quantise_pack, or None.

    Every sample says in which interval the factor must lie (rint(x * gain * 32767) = k); the intervals are intersected and the middle is taken, then proved by the caller
    with quantise_pack.  A sample at the ceiling only says the gain is at least this large.
    """
    if len(joined) != len(shipped):
        return None
    x = joined.astype(np.float64)
    k = shipped.astype(np.float64)
    live = x != 0
    if (k[~live] != 0).any():
        return None
    x, k = x[live], k[live]
    low, high = (k - 0.5) / (32767.0 * x), (k + 0.5) / (32767.0 * x)
    low, high = np.minimum(low, high), np.maximum(low, high)
    top = np.abs(k) >= 32767
    low[top] = 32766.5 / (32767.0 * np.abs(x[top]))
    high[top] = np.inf
    negative = k <= -32768
    low[negative] = 32767.5 / (32767.0 * np.abs(x[negative]))
    high[negative] = np.inf
    lo, hi = float(low.max()), float(high.min())
    if not lo <= hi:
        return None
    return (lo + hi) / 2 if math.isfinite(hi) else lo * 1.0000001


def write_wav(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    with wave.open(str(temporary), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(samples.astype("<i2").tobytes())
    os.replace(temporary, path)


def find_vgmstream(explicit: str | None) -> Path:
    candidates = [explicit] if explicit else []
    candidates.append(str(Path(__file__).resolve().parent.parent / "vgmstream" / "vgmstream-cli.exe"))
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise BuildError("vgmstream-cli.exe was not found")


def peak_memory_mb() -> float | None:
    """Peak working set of this process in MB (Windows), for the timing line."""
    if os.name != "nt":
        return None
    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_uint32), ("PageFaultCount", ctypes.c_uint32), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
    counters = Counters()
    counters.cb = ctypes.sizeof(Counters)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32]
    if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        return None
    return round(counters.PeakWorkingSetSize / 1048576, 1)


def build(args: argparse.Namespace) -> int:
    started = time.time()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    voice = manifest["voices"].get(args.key)
    if voice is None:
        raise BuildError(f"{args.key} is not in the manifest")
    kinds = [kind for kind in (args.kinds.split(",") if args.kinds else voice) if kind in voice]
    try:
        archives = open_archives(Path(args.game))
    except FileNotFoundError:
        print("no English voice archive in this game folder", file=sys.stderr)
        return EXIT_NO_ENGLISH_VOICE
    vgmstream = find_vgmstream(args.vgmstream)
    cache: dict = {}
    built = {}
    for kind in kinds:
        spec = voice[kind]
        spec = voice[spec["sameAs"]] if "sameAs" in spec else spec
        samples = build_clip(spec, archives, vgmstream, cache)
        target = Path(args.out) / kind / f"{args.key}.wav"
        write_wav(target, samples)
        built[kind] = {"samples": int(len(samples)), "seconds": round(len(samples) / RATE, 3), "sameAsShipped": hashlib.sha256(target.read_bytes()).hexdigest() == spec.get("sha256")}
    print(json.dumps({"key": args.key, "built": built, "ms": round((time.time() - started) * 1000), "peakMb": peak_memory_mb()}))
    return 0


def open_language_archives(game: Path, archive_name: str) -> dict[str, Archive]:
    """The dub's voice archives of a language in the game folder (content, and ep1 when Phantom Liberty is installed); FileNotFoundError when the base game has none."""
    oodle = Oodle(game)
    found = {name: Archive(game / rel.format(name=archive_name), oodle) for name, rel in LANGUAGE_ARCHIVE_NAMES.items() if (game / rel.format(name=archive_name)).is_file()}
    if "content" not in found:
        raise FileNotFoundError("no voice archive for this language")
    return found


LANGUAGE_FILE = re.compile(r"^(picked|archetypes|v-voice)/[a-z0-9][a-z0-9._-]{0,79}\.wav$")


def build_language(args: argparse.Namespace) -> int:
    started = time.time()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    keys = [key for key in args.key.split(",") if key]
    locale, archive_file = manifest["locale"], manifest["archive"]
    name = archive_file[len("lang_"):-len("_voice.archive")]
    try:
        archives = open_language_archives(Path(args.game), name)
    except FileNotFoundError:
        print("no voice archive of this language in this game folder", file=sys.stderr)
        return EXIT_NO_ENGLISH_VOICE
    vgmstream = find_vgmstream(args.vgmstream)
    cache: dict = {}
    built = {}
    for key in keys:
        spec = manifest["voices"].get(key)
        if spec is None:
            raise BuildError(f"{key} is not in the manifest")
        if not spec.get("exact") or not spec.get("lines"):
            raise BuildError(f"{key} cannot be rebuilt exactly, it is downloaded")
        if not LANGUAGE_FILE.match(spec["file"]):
            raise BuildError(f"{key} has an unusable file name")
        samples = build_language_clip(spec, locale, archives, vgmstream, cache)
        target = Path(args.out) / spec["file"]
        write_wav(target, samples)
        built[key] = {"samples": int(len(samples)), "seconds": round(len(samples) / RATE, 3), "sameAsShipped": hashlib.sha256(target.read_bytes()).hexdigest() == spec.get("sha256")}
    print(json.dumps({"keys": keys, "built": built, "ms": round((time.time() - started) * 1000), "peakMb": peak_memory_mb()}))
    return 0


def check(args: argparse.Namespace) -> int:
    try:
        archives = open_archives(Path(args.game))
    except FileNotFoundError:
        return EXIT_NO_ENGLISH_VOICE
    print(json.dumps({"archives": sorted(archives)}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    one = sub.add_parser("build")
    one.add_argument("--manifest", required=True)
    one.add_argument("--key", required=True)
    one.add_argument("--game", required=True)
    one.add_argument("--vgmstream")
    one.add_argument("--out", required=True)
    one.add_argument("--kinds")
    one.set_defaults(run=build)
    language = sub.add_parser("build-language")
    language.add_argument("--manifest", required=True)
    language.add_argument("--key", required=True, help="one voice key, or several separated by commas")
    language.add_argument("--game", required=True)
    language.add_argument("--vgmstream")
    language.add_argument("--out", required=True, help="the language's folder: <references>/multilingual/<lang>")
    language.set_defaults(run=build_language)
    probe = sub.add_parser("check")
    probe.add_argument("--game", required=True)
    probe.set_defaults(run=check)
    args = parser.parse_args()
    try:
        return args.run(args)
    except BuildError as error:
        print(str(error), file=sys.stderr)
        return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
