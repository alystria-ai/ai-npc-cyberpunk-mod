"""Shared pieces of the voice language pack builder (docs/VOICE_LANGUAGE_PACKS.md).

Everything large lives on E: (OUT / WORK); nothing game-derived is ever written inside the repository.

Run with the project's voice environment, isolated:
    vendor/reference-voicestudio/.venv/Scripts/python.exe -I scripts/voice-packs/<script>.py ...
(numpy, soundfile, torch, torchaudio and speechbrain come from that environment.)
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def _main_checkout() -> Path:
    """vendor/, runtime/ and research/ are git-ignored, so a worktree has none of them: use the main checkout's."""
    for candidate in (ROOT, *(p for p in ROOT.parents if p.name != ".claude")):
        if (candidate / "vendor").is_dir():
            return candidate
    raise RuntimeError("Cannot find the main checkout (the folder holding vendor/)")


MAIN = Path(os.environ.get("VOICE_PACKS_MAIN") or _main_checkout())
GAME = Path("E:/SteamLibrary/steamapps/common/Cyberpunk 2077")
RUNTIME = GAME / "red4ext/plugins/AiNpcCyberpunkMod"          # shipped Runtime (READ-ONLY: used for the English proof)
STASH = Path("E:/SteamLibrary/AiNpc-vo-stash")
OUT = Path("E:/SteamLibrary/AiNpc-voice-packs")
WORK = OUT / "work"
WK = MAIN / "vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe"
DOTNET = MAIN / "vendor/dotnet-runtime-10.0.12"
VGM = Path(r"E:\misc\misc1\modding\fmodel\Output\.data\vgmstream-cli.exe")   # moved from C:\Users\akshi\Downloads\misc\modding\fmodel\Output\.data
FFMPEG = Path(r"C:\ffmpeg\bin\ffmpeg.exe")
ECAPA_DIR = Path("E:/CyberpunkConvai-offload/work/likeness-phase1/ecapa-src")
LOOKUP = MAIN / "research/cyberpunk/cache/game/localization/index/lookup.sqlite3"   # English subtitle index (installed game, en)
POOL_INDEX = Path("E:/CyberpunkConvai-offload/work/reference-picker/pool-index.json")
OODLE = GAME / "tools/redmod/bin/oo2ext_7_win64.dll"

RATE = 24000
GAP_SECONDS = 0.4
OMNI_LIMIT_SECONDS = 20.0

# language key (the pack's name) -> locale folder inside the archives, archive name, bridge language tag
LANGUAGES = {
    "en":    {"locale": "en-us", "archive": "en",    "tag": "en", "game": "en-us"},
    "fr":    {"locale": "fr-fr", "archive": "fr",    "tag": "fr", "game": "fr-fr"},
    "it":    {"locale": "it-it", "archive": "it",    "tag": "it", "game": "it-it"},
    "de":    {"locale": "de-de", "archive": "de",    "tag": "de", "game": "de-de"},
    "es-es": {"locale": "es-es", "archive": "es-es", "tag": "es", "game": "es-es"},
    "ja":    {"locale": "jp-jp", "archive": "ja",    "tag": "ja", "game": "ja-jp"},
    "ko":    {"locale": "kr-kr", "archive": "ko",    "tag": "ko", "game": "ko-kr"},
    "pl":    {"locale": "pl-pl", "archive": "pl",    "tag": "pl", "game": "pl-pl"},
    "pt-br": {"locale": "pt-br", "archive": "pt",    "tag": "pt", "game": "pt-br"},
    "ru":    {"locale": "ru-ru", "archive": "ru",    "tag": "ru", "game": "ru-ru"},
    "zh-cn": {"locale": "zh-cn", "archive": "zh-cn", "tag": "zh", "game": "zh-cn"},
}
ARCH_DIR = {"content": "base", "ep1": "ep1"}       # which top folder a stash sub-folder's voice files live under

# <top>\localization\<locale>\<vo dir>\<stem>_<f|m>_<16 hex><rest>.wem
WEM_RE = re.compile(r"^(?P<top>[^\\/]+)[\\/]localization[\\/](?P<loc>[^\\/]+)[\\/](?P<vo>vo[^\\/]*)[\\/](?P<stem>.+?)_(?P<fm>[fm])_(?P<hex>[0-9a-f]{16})(?P<rest>[^\\/]*)\.wem$")


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def read_json(path) -> object:
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, value, indent=2) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=indent) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def sha256_file(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def sid_of(hex16: str) -> str:
    return str(int(hex16, 16))


def hex_of(sid: str) -> str:
    return "%016x" % int(sid)


# ------------------------------------------------------------------ the voice archives
def voice_archive(lang: str, sub: str) -> Path:
    """The stashed lang_<archive>_voice.archive of a language (sub: 'content' or 'ep1')."""
    return STASH / lang / sub / f"lang_{LANGUAGES[lang]['archive']}_voice.archive"


def wolven(args: list, log_file: Path) -> None:
    env = dict(os.environ, DOTNET_ROOT=str(DOTNET))
    log_file.parent.mkdir(parents=True, exist_ok=True)
    flags = (subprocess.CREATE_NO_WINDOW | 0x00004000) if os.name == "nt" else 0     # hidden, below-normal priority
    with open(log_file, "a", encoding="utf8") as out:
        code = subprocess.run([str(WK), *map(str, args)], stdout=out, stderr=subprocess.STDOUT, env=env, creationflags=flags).returncode
    if code:
        raise RuntimeError(f"WolvenKit failed ({code}); see {log_file}")


def list_archive(lang: str, sub: str) -> list[str]:
    """Every depot path in the stashed archive (cached under WORK/<lang>/list-<sub>.txt; WolvenKit resolves the names)."""
    cache = WORK / lang / f"list-{sub}.txt"
    if not cache.is_file():
        env = dict(os.environ, DOTNET_ROOT=str(DOTNET))
        done = subprocess.run([str(WK), "archive", str(voice_archive(lang, sub)), "-l"], capture_output=True, text=True, env=env,
                              encoding="utf8", errors="replace", creationflags=subprocess.CREATE_NO_WINDOW)
        if done.returncode:
            raise RuntimeError(f"WolvenKit could not list {voice_archive(lang, sub)}: {done.stderr[:300]}")
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(done.stdout, encoding="utf-8")
    return [line.strip() for line in cache.read_text(encoding="utf-8").splitlines() if line.strip().endswith(".wem")]


def wem_index(lang: str) -> dict:
    """{(sub, vo dir, stem, fm, hex, rest): depot path} of every voice file of the language in the stash."""
    index = {}
    for sub in ("content", "ep1"):
        if not voice_archive(lang, sub).is_file():
            continue
        for path in list_archive(lang, sub):
            m = WEM_RE.match(path)
            if m:
                index[(sub, m["vo"], m["stem"], m["fm"], m["hex"], m["rest"])] = path
    return index


def unbundle(lang: str, sub: str, paths: list[str], out_dir: Path, chunk: int = 150) -> None:
    """Extract only the listed depot paths (never the whole archive) into out_dir/<depot path>."""
    todo = [p for p in paths if not (out_dir / p.replace("\\", "/")).is_file()]
    for start in range(0, len(todo), chunk):
        batch = todo[start:start + chunk]
        rx = "^(" + "|".join(re.escape(p) for p in batch) + ")$"
        wolven(["unbundle", voice_archive(lang, sub), "--outpath", out_dir, "--regex", rx], WORK / lang / "logs" / "unbundle.log")
        log(f"{lang}/{sub}: unbundled {min(start + chunk, len(todo))}/{len(todo)}")


# ------------------------------------------------------------------ decode + join
def decode_wem(wem: Path, wav: Path) -> bool:
    wav.parent.mkdir(parents=True, exist_ok=True)
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    done = subprocess.run([str(VGM), "-o", str(wav), str(wem)], capture_output=True, creationflags=flags)
    return done.returncode == 0 and wav.is_file() and wav.stat().st_size > 44


def load_mono(path, rate: int = RATE, method: str = "sinc"):
    """Decoded WAV -> mono float32 array at `rate`.
    method 'sinc': torchaudio's default windowed-sinc resampler (the reference builder's own, scripts/clip-search/common.py);
    method 'poly': scipy resample_poly, which the pool extractor (scripts/reference-pool/extract.py decode_one) used for most clips."""
    import numpy as np
    import soundfile as sf
    data, source_rate = sf.read(str(path), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if source_rate == rate:
        return mono
    if method == "poly":
        import math
        from scipy.signal import resample_poly
        g = math.gcd(source_rate, rate)
        return resample_poly(mono, rate // g, source_rate // g).astype(np.float32)
    import torch
    import torchaudio.functional as AF
    return AF.resample(torch.from_numpy(mono), source_rate, rate).numpy()


def load_v(path, rate: int = RATE):
    """V's recipe (scripts/clip-search/v-voice/build_reference.py + vcommon.py): the left channel only when the stereo channels are
    decorrelated, else the mean; scipy polyphase to 24 kHz; leading/trailing silence below -45 dBFS trimmed with 80 ms of margin."""
    import math
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    d, sr = sf.read(str(path), dtype="float32", always_2d=True)
    if d.shape[1] == 1:
        mono = d[:, 0]
    else:
        left, right = d[:, 0].astype(np.float64), d[:, 1].astype(np.float64)
        mean_rms = math.sqrt(float((((left + right) / 2) ** 2).mean()))
        left_rms = math.sqrt(float((left ** 2).mean())) or 1e-9
        mono = ((d[:, 0] + d[:, 1]) / 2).astype(np.float32) if mean_rms / left_rms >= 0.9 else d[:, 0]
    if sr != rate:
        g = math.gcd(int(sr), int(rate))
        mono = resample_poly(mono, rate // g, sr // g).astype(np.float32)
    n = len(mono) // 240 * 240
    frames = np.sqrt((mono[:n].reshape(-1, 240) ** 2).mean(1)) + 1e-9
    loud = np.where(20 * np.log10(frames) > -45.0)[0]
    if not len(loud):
        return mono
    lo = max(0, loud[0] * 240 - int(0.08 * rate))
    hi = min(len(mono), (loud[-1] + 1) * 240 + int(0.08 * rate))
    return mono[lo:hi]


def join_clips(clips: list, rate: int = RATE, gap: float = GAP_SECONDS):
    """Whole clips (float arrays at `rate`) in order with `gap` seconds of silence between them: no EQ, denoise, gain or trim."""
    import numpy as np
    parts = []
    for at, clip in enumerate(clips):
        parts.append(np.asarray(clip, dtype=np.float32))
        if at < len(clips) - 1:
            parts.append(np.zeros(round(gap * rate), dtype=np.float32))
    return np.clip(np.concatenate(parts), -1.0, 1.0) if parts else np.zeros(0, dtype=np.float32)


def write_pcm16(path, samples, rate: int = RATE) -> None:
    import numpy as np
    import soundfile as sf
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(np.rint(np.asarray(samples, dtype=np.float64) * 32767.0), -32768, 32767).astype(np.int16)
    tmp = path.with_name(path.name + ".part")
    sf.write(str(tmp), pcm, rate, format="WAV", subtype="PCM_16")
    os.replace(tmp, path)


def read_pcm16(path):
    import soundfile as sf
    data, rate = sf.read(str(path), dtype="int16", always_2d=True)
    return data[:, 0], rate


def _loudness():
    import importlib.util
    spec = importlib.util.spec_from_file_location("v_loudness", ROOT / "scripts/clip-search/v-voice/loudness.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TARGET_LUFS, CEILING_DB, MARGIN_DB, HOT_ABOVE = -20.0, -1.0, 0.03, -16.0


def gain_match(x):
    """The reference gain stage of scripts/clip-search/loud43/apply_loud43.py: one linear gain towards -20 LUFS (BS.1770-4), capped so the
    4x true peak stays at or below -1 dBTP; a quiet set is never made quieter, sets between -20 and -16 LUFS are left alone, sets hotter
    than -16 LUFS come down to -20; no limiter, no compressor.  Returns (float64 samples, info)."""
    import numpy as np
    L = _loudness()
    x = np.asarray(x, dtype=np.float64)
    lufs, tp = L.lufs(x, RATE), L.true_peak_db(x)
    want = TARGET_LUFS - lufs
    room = CEILING_DB - MARGIN_DB - tp
    if lufs > HOT_ABOVE:
        gain = want
    elif lufs >= TARGET_LUFS:
        gain = 0.0
    else:
        gain = max(0.0, min(want, room))
    y = x
    if gain != 0.0:
        for _ in range(60):
            y = np.round(np.clip(x * 10 ** (gain / 20), -1, 1) * 32767) / 32767
            if gain <= 0 or L.true_peak_db(y) <= CEILING_DB:
                break
            gain = max(0.0, gain - 0.01)
        if gain == 0.0:
            y = x
    after_lufs, after_tp = L.lufs(y, RATE), L.true_peak_db(y)
    return y, {"rawLufs": round(lufs, 2), "rawTruePeakDb": round(tp, 2), "gainDb": round(gain, 2), "wantedDb": round(want, 2),
               "lufs": round(after_lufs, 2), "truePeakDb": round(after_tp, 2), "peakLimited": bool(lufs < TARGET_LUFS and gain < want - 0.005)}


def measure(x) -> dict:
    """Loudness / peak / clipping of a 24 kHz mono float signal (the cheap per-voice check)."""
    import numpy as np
    L = _loudness()
    x = np.asarray(x, dtype=np.float64)
    peak = float(np.abs(x).max()) if len(x) else 0.0
    hit = np.abs(x) >= max(peak - 1e-4, 0.0)
    gated = L.gated_rms_db(x, RATE)
    return {"lufs": round(L.lufs(x, RATE), 2), "truePeakDb": round(L.true_peak_db(x), 2), "peak": round(peak, 4),
            "clipped": bool(peak >= 0.988 and np.any(hit[1:] & hit[:-1])), "gatedRmsDb": None if gated is None else round(gated, 2)}


def seconds_of(samples, rate: int = RATE) -> float:
    return round(len(samples) / rate, 3)


# ------------------------------------------------------------------ English subtitle index (which subtitle file holds a line)
def english_subtitle_files(string_ids: list[str]) -> dict:
    """{string id: depot path of the English subtitle json holding it} from the installed localization index."""
    import sqlite3
    db = sqlite3.connect("file:" + LOOKUP.as_posix() + "?mode=ro", uri=True)
    out = {}
    for sid in string_ids:
        rows = db.execute("select female, male, source_json from entries where domain='subtitle.stringId' and entry_id=?", (sid,)).fetchall()
        for female, male, source in rows:
            depot = json.loads(source)["source"]["depotPath"].replace("\\\\", "\\")
            out.setdefault(sid, []).append({"depot": depot, "female": (female or "").strip(), "male": (male or "").strip()})
    return out
