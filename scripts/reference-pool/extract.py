"""Step 2: pull the candidate voice lines out of the game archives and decode them to 24 kHz mono WAV.

    python scripts/reference-pool/extract.py [--voices a,b,c | --priority | --all] [--limit N]

For each voice of WORK/_work/catalog.json (step 1) this
  1. pre-filters the lines that can never be references: held-out evaluation lines, the dataset's dev/test lines, lines
     without a subtitle, foreign-language lines, effect-named files (radio, media, helmet, rewind ...), too few words,
     non-lexical shouts and combat barks;
  2. unbundles the remaining .wem files from lang_en_voice.archive (base game and Phantom Liberty) with WolvenKit;
  3. decodes them with vgmstream, mixes to mono and resamples to 24 kHz (nothing else: no EQ, denoise or gain), writes
     WORK/<voice>/<clip id>.wav;
  4. measures duration, speech loudness (same gated RMS as the picker index) and the phone-band spectral features, and
     records the line's metadata in WORK/<voice>/clips.jsonl (resumable: finished lines are skipped).

Step 3 (embed.py) adds ECAPA typicality; step 4 (finalize.py) applies the post-decode filters and writes manifests.
The game may be running: archive reads only, hidden below-normal-priority helpers, no GPU.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import ctypes
import hashlib
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from common import *  # noqa

sys.path.insert(0, str(ROOT / "scripts/phone_detect"))
from spectral import features as spectral_features  # noqa: E402

PRIORITY = read_json(ROOT / "scripts/reference-picker/shown-voices.json")
OUT_RATE = 24000
CHUNK = 160                      # wem files per WolvenKit call
MARKUP = re.compile(r'<mothertongue l="[^"]*" m="([^"]*)" b="((?:[^"\\]|\\.)*)" a="((?:[^"\\]|\\.)*)"\s*/>')
NONLEXICAL = {"ah", "aah", "aaah", "ahh", "ahhh", "argh", "aargh", "aaargh", "arrgh", "ugh", "uh", "uhh", "oh", "ohh", "hh", "hnn", "hmm", "hm", "mm", "mmm",
              "grr", "grrr", "gah", "aagh", "eh", "ha", "haha", "heh", "huh", "hah", "whoa", "woah", "yah", "hyah", "hyaa", "agh", "aaagh", "nngh", "ngh", "khe", "hrgh", "gh"}
BARK = re.compile(r"vs_vset|_vset_|_vsets?(_|$)")


def set_low_priority():
    if sys.platform == "win32":
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)   # BELOW_NORMAL


def clean_text(text: str) -> str:
    text = MARKUP.sub(lambda m: m[2].replace('\\"', '"') + m[1] + m[3].replace('\\"', '"'), text)
    text = re.sub(r"<Rich[^>]*>", "", text).replace("</>", "")
    return re.sub(r"\s+", " ", text).strip()


def words_of(text: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9']+", text)


_SOURCE = {}


def source_combat(sid: str) -> str | None:
    """The game's own verdict that a line is combat (a voiceset bark with a combat trigger, a Combat-context line, a fight-triggered quest line;
    scripts/combat_flags/source_signal.py over the scene index), or None.  Skipped when the scene index has not been built."""
    if "by_sid" not in _SOURCE:
        sys.path.insert(0, str(ROOT / "scripts/combat_flags"))
        try:
            import source_signal
            _SOURCE["module"] = source_signal
            _SOURCE["by_sid"], _SOURCE["fight"] = source_signal.load_by_sid() if source_signal.SCENE_LINES.is_file() else ({}, {})
        except Exception:      # the pool builder must keep working without the combat tools
            _SOURCE["by_sid"], _SOURCE["fight"] = {}, {}
    rows = _SOURCE["by_sid"].get(str(sid))
    if not rows:
        return None
    verdict = _SOURCE["module"].classify_lines(rows, _SOURCE["fight"])
    return verdict["reasons"][0] if verdict["tier"] == "strong" else None


def prefilter(entry: dict) -> str | None:
    """Why a catalogued line can never be a reference, or None."""
    if entry["heldOut"]:
        return "held-out"
    if entry["devTest"]:
        return "dev-test"
    if entry["vo"] in ("vo_helmet", "vo_rewinded") or entry["effectName"]:
        return "effect-name"
    raw = entry["text"]
    if not raw:
        return "no-text"
    if "<kiroshi" in raw or raw.startswith("[") and re.match(r"\[[a-z]{2}_[a-z]{2}\]", raw):
        return "foreign"
    text = clean_text(raw)
    tokens = [w.lower() for w in words_of(text)]
    if len(tokens) < 3:
        return "few-words"
    if sum(1 for t in tokens if t in NONLEXICAL or re.fullmatch(r"[aeiouhgr]+", t)) / len(tokens) >= 0.5:
        return "non-lexical"
    if re.search(r"<[^>]+>|\[[^\]]*\]", text):
        return "markup"
    if BARK.search(entry["stem"]) and "!" in text:
        return "bark"
    if source_combat(entry["sid"]):
        return "combat"        # the game marks it as combat (scripts/combat_flags); weaker evidence is judged later by build_flags.py
    return None


def gated_rms_db(mono: np.ndarray, rate: int):
    frame = max(1, int(rate * 0.05))
    count = len(mono) // frame
    if count < 2:
        return None
    energy = (mono[: count * frame].reshape(count, frame) ** 2).mean(axis=1)
    peak = energy.max()
    if peak <= 0:
        return None
    active = energy[energy >= peak * 10 ** (-25 / 10)]
    return round(float(10 * math.log10(active.mean())), 2)


def clip_id(entry: dict) -> str:
    suffix = "" if entry["vo"] == "vo" else "." + entry["vo"].replace("vo_", "")
    suffix += "" if entry["fm"] == "f" else ".m"
    suffix += "" if not entry["rest"] else "." + re.sub(r"\W+", "", entry["rest"])
    return f"{entry['sid']}{suffix}"


def decode_one(job):
    """wem -> (wav path, metadata) or (None, reason).  Runs in a worker thread (the heavy lifting is vgmstream)."""
    wem, wav, entry = job
    set_low_priority()
    try:
        raw_bytes = wem.read_bytes()
        with tempfile.TemporaryDirectory(dir=str(SRC)) as tmp:
            native = Path(tmp) / "native.wav"
            done = subprocess.run([str(VGM), "-o", str(native), str(wem)], capture_output=True, creationflags=FLAGS)
            if done.returncode or not native.exists():
                return None, "decode-failed"
            data, rate = sf.read(native, dtype="float32", always_2d=True)
        mono = data.mean(axis=1)
        feats = dict(spectral_features(mono, rate) or {}, rate=rate)   # phone-band features at the native rate (full 24 kHz band)
        if rate != OUT_RATE:
            g = math.gcd(rate, OUT_RATE)
            mono = resample_poly(mono, OUT_RATE // g, rate // g).astype(np.float32)
        peak = float(np.abs(mono).max()) if len(mono) else 0.0
        if len(mono) < OUT_RATE * 0.3:
            return None, "too-short"
        wav.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(wav), np.clip(mono, -1, 1), OUT_RATE, subtype="PCM_16")
        return wav, {"d": round(len(mono) / OUT_RATE, 3), "lv": gated_rms_db(mono, OUT_RATE), "peak": round(peak, 4), "channels": int(data.shape[1]), "srcRate": rate,
                     "spec": {k: (round(float(v), 3) if isinstance(v, (int, float, np.floating)) and math.isfinite(float(v)) else None) for k, v in (feats or {}).items()},
                     "wemSha": hashlib.sha256(raw_bytes).hexdigest()}
    except Exception as error:  # noqa: BLE001
        return None, f"error:{type(error).__name__}"


def spec_only(job):
    """Recompute the native-rate phone features of an already decoded line from its .wem."""
    wem, key = job
    set_low_priority()
    try:
        with tempfile.TemporaryDirectory(dir=str(SRC)) as tmp:
            native = Path(tmp) / "native.wav"
            done = subprocess.run([str(VGM), "-o", str(native), str(wem)], capture_output=True, creationflags=FLAGS)
            if done.returncode or not native.exists():
                return key, None
            data, rate = sf.read(native, dtype="float32", always_2d=True)
        feats = dict(spectral_features(data.mean(axis=1), rate) or {}, rate=rate)
        return key, {k: (round(float(v), 3) if isinstance(v, (int, float, np.floating)) and math.isfinite(float(v)) else None) for k, v in (feats or {}).items()}
    except Exception:  # noqa: BLE001
        return key, None


def spec_pass(voice: str):
    manifest = WORK / voice / "clips.jsonl"
    if not manifest.exists():
        return
    rows = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
    todo = [(SRC / "wem" / r["archive"] / r["wem"].replace("\\", "/"), r["id"]) for r in rows if r.get("sid") and (r.get("spec") or {}).get("rate") is None]
    if not todo:
        return
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = dict(pool.map(spec_only, todo))
    for row in rows:
        if row["id"] in results and results[row["id"]]:
            row["spec"] = results[row["id"]]
    tmp = manifest.with_name("clips.jsonl.tmp")
    tmp.write_text("".join(json.dumps(r, ensure_ascii=False) + chr(10) for r in rows), encoding="utf-8")
    tmp.replace(manifest)
    print(f"[{voice}] spectral features refreshed for {len(results)} lines", flush=True)


def unbundle(paths: list[str], archive_name: str, log: Path):
    out = SRC / "wem" / archive_name
    todo = [p for p in paths if not (out / p.replace("\\", "/")).exists()]
    for start in range(0, len(todo), CHUNK):
        batch = todo[start:start + CHUNK]
        rx = "^(" + "|".join(re.escape(p) for p in batch) + ")$"
        wolven(["unbundle", ARCHIVES[archive_name] / "lang_en_voice.archive", "--outpath", out, "--regex", rx], log)
    return out


def process_voice(voice: str, item: dict, limit: int | None, unbundle_only: bool = False):
    folder = WORK / voice
    folder.mkdir(parents=True, exist_ok=True)
    manifest = folder / "clips.jsonl"
    done = {}
    if manifest.exists():
        for line in manifest.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                done[row["id"]] = row
    rejected = {}
    candidates = []
    used = {}                                  # id -> wem path: one line can exist as several recordings (scene re-takes)
    for entry in item["entries"]:
        reason = prefilter(entry)
        if reason:
            rejected[reason] = rejected.get(reason, 0) + 1
            continue
        cid = clip_id(entry)
        if cid in used and used[cid] != entry["wem"]:
            cid = f"{cid}-{hashlib.md5(entry['wem'].encode()).hexdigest()[:4]}"
        used[cid] = entry["wem"]
        entry = {**entry, "id": cid}
        if entry["id"] in done:
            continue
        candidates.append(entry)
    if limit:
        candidates = candidates[:limit]
    print(f"[{voice}] {len(item['entries'])} lines, prefilter dropped {sum(rejected.values())} {rejected}, {len(candidates)} to extract, {len(done)} done", flush=True)
    if not candidates:
        return
    by_archive: dict[str, list[dict]] = {}
    for entry in candidates:
        by_archive.setdefault(entry["archive"], []).append(entry)
    log = SRC / "logs" / f"{voice}.log"
    jobs = []
    for archive_name, entries in by_archive.items():
        base = unbundle([e["wem"] for e in entries], archive_name, log)
        if unbundle_only:
            continue
        for entry in entries:
            wem = base / entry["wem"].replace("\\", "/")
            if wem.exists():
                jobs.append((wem, folder / f"{entry['id']}.wav", entry))
    if unbundle_only:
        print(f"[{voice}] unbundled {len(candidates)} files", flush=True)
        return
    started = time.time()
    written = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool, manifest.open("a", encoding="utf-8") as handle:
        for (wem, wav, entry), (path, meta) in zip(jobs, pool.map(decode_one, jobs)):
            if path is None:
                row = {"id": entry["id"], "failed": meta}
            else:
                row = {"id": entry["id"], "sid": entry["sid"], "wem": entry["wem"], "vo": entry["vo"], "fm": entry["fm"], "stem": entry["stem"], "archive": entry["archive"],
                       "text": clean_text(entry["text"]), "inDataset": entry["inDataset"], **meta}
                written += 1
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            handle.flush()
    print(f"[{voice}] decoded {written}/{len(jobs)} in {time.time() - started:.0f} s", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--voices", help="comma-separated voice keys")
    parser.add_argument("--priority", action="store_true", help="the 29 priority voices")
    parser.add_argument("--all", action="store_true", help="every voice with a runtime reference")
    parser.add_argument("--limit", type=int, help="at most this many lines per voice (testing)")
    parser.add_argument("--spec-pass", action="store_true", help="recompute the native-rate phone features of already decoded lines")
    parser.add_argument("--unbundle-only", action="store_true", help="only copy the .wem files out of the archives (no decoder needed)")
    args = parser.parse_args()
    set_low_priority()
    if not args.unbundle_only and not VGM.exists():
        sys.exit(f"vgmstream-cli not found at {VGM}")
    catalog = read_json(SRC / "catalog.json")
    if args.voices:
        voices = args.voices.split(",")
    elif args.priority:
        voices = [v for v in PRIORITY if v in catalog]
    else:
        voices = [v for v in PRIORITY if v in catalog] + [v for v in catalog if v not in PRIORITY]
    for voice in voices:
        if args.spec_pass:
            spec_pass(voice)
            continue
        process_voice(voice, catalog[voice], args.limit, args.unbundle_only)
    return 0


if __name__ == "__main__":
    sys.exit(main())
