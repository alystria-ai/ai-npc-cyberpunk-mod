"""Recover how every shipped voice reference clip was made and write the manifest bridge/voice_clip_build.py builds from.

    vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/voice-extract/recover_manifest.py [--keys a,b] [--out characters/voice-clips-manifest.json] [--report report.json]

Sources, all read only: the live voice configs of the main checkout (`pick.clips`: the lines in order, `pick.gain.db`: the 2026-10-14 loudness stage), the
game's own wem path lists (runtime/voice-cast-inventory-20261001), the reference pool's per-line records and the shipped clips themselves.

A clip is only written into the manifest when the build from the game's files reproduces the shipped file sample for sample (largest difference of one 16-bit step
at most, caused by float rounding of the resampler).  Every other clip is listed in the report with the reason, so "exactly reproducible" is a measured number.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import wave
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "bridge"))
import voice_clip_build as V  # noqa: E402

MAIN = Path(os.environ.get("CX_MAIN", r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod"))
RUNTIME = MAIN / "runtime"
GAME = Path(os.environ.get("CX_GAME", "E:/SteamLibrary/steamapps/common/Cyberpunk 2077"))
VGM = Path(os.environ.get("CX_VGMSTREAM", r"E:\misc\misc1\modding\fmodel\Output\.data\vgmstream-cli.exe"))
CONFIGS = {"omni-short": "local-voices.autobest-short.json", "omni-long": "local-voices.autobest-long.json", "pocket": "pocket-voices.autobest.json"}
WEM_LISTS = {label: RUNTIME / f"voice-cast-inventory-20261001/{label}-wem-paths.txt" for label in ("base", "ep1")}
HOWS = ("poly", "poly64", "torch", "js")
WRITERS = ("sf", "js")
NL = chr(10)


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        assert handle.getnchannels() == 1 and handle.getsampwidth() == 2 and handle.getframerate() == V.RATE, path
        return np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2")


def load_wem_paths() -> dict[str, list[str]]:
    paths: dict[str, list[str]] = {}
    for label, file in WEM_LISTS.items():
        for line in file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            match = re.search(r"_([0-9a-f]{16})([^\\/]*)\.wem$", line)
            if match:
                paths.setdefault(match.group(1), []).append(line)
    return paths


def candidates(clip_id: str, wem_paths: dict[str, list[str]]) -> list[str]:
    """Depot paths a pick id can mean.  Ids are '<voice>/<StringID>[.<vo kind>][.m][.<rest>][/female|/male]'."""
    parts = clip_id.split("/")[1:]
    gender = next((p for p in parts[1:] if p in ("female", "male")), None)
    sid, _, suffix = parts[0].partition(".")
    if not sid.isdigit():
        return []
    found = wem_paths.get(f"{int(sid):016x}", [])
    male = "m" in suffix.split(".") or gender == "male"
    want = "m" if male else "f"
    same = [p for p in found if re.search(r"_" + want + r"_[0-9a-f]{16}", p)]
    return same or found


def gain_of(entry: dict):
    pick = entry.get("pick") or {}
    gain = (pick.get("gain") or {}).get("db")
    if gain is None:
        match = re.search(r"gain ([+-]\d+\.\d+) dB", pick.get("note") or "")
        gain = float(match.group(1)) if match else None
    return gain if gain else None


class Sources:
    def __init__(self):
        self.archives = V.open_archives(GAME)
        self.cache: dict = {}

    def line(self, path: str, how: str) -> np.ndarray | None:
        key = (path, how)
        if key not in self.cache:
            archive = self.archives["ep1" if path.startswith("ep1\\") else "content"]
            try:
                wem = archive.read(path)
            except V.BuildError:
                wem = None
            if wem is None:
                self.cache[key] = None
            else:
                raw = self.cache.get((path, "raw"))
                if raw is None:
                    raw = self.cache[(path, "raw")] = V.decode_wem(VGM, wem, priority=0)
                self.cache[key] = V.line_to_24k(raw[0], raw[1], how)
        return self.cache[key]


def score_of(piece: np.ndarray, window: np.ndarray):
    if len(window) != len(piece):
        return (10 ** 6, 10 ** 6)
    diff = np.abs(piece.astype(np.int32) - window.astype(np.int32))
    return (int(diff.max()), int((diff > 0).sum()))


def fit_gain(piece: np.ndarray, window: np.ndarray, nominal: float) -> tuple[float, tuple]:
    """The loudness stage rounded its gain to two decimals in the config; find the real one: least squares, then a fine scan around it."""
    if len(window) != len(piece) or not piece.any():
        return nominal, (10 ** 6, 10 ** 6)
    x, y = piece.astype(np.float64), window.astype(np.float64)
    estimate = 20 * np.log10(max(float((x * y).sum() / (x * x).sum()), 1e-9))
    best = None
    for step in np.arange(-30, 31):
        gain = round(estimate + step * 2e-5, 6)
        score = score_of(V.quantise_sf(V.apply_gain(piece, gain)), window)
        if best is None or score < best[1]:
            best = (gain, score)
    return best


def recover_one(sources: Sources, wem_paths, ids: list[str], gain_db, shipped: np.ndarray) -> dict:
    """Walk the shipped clip line by line, trying each source path, resampler and 16-bit writer; keeps the writer that matches every line."""
    best_result = None
    tolerance = 1 + (math.ceil(10 ** (gain_db / 20)) if gain_db and gain_db > 0 else 0)     # a gain multiplies the decoder noise of the old pool by itself
    for writer in WRITERS:
        offset, lines, worst, fail, fitted = 0, [], 0, None, None
        for at, clip_id in enumerate(ids):
            options = candidates(clip_id, wem_paths)
            if not options:
                fail = f"no game file for {clip_id}"
                break
            best = None
            for path in options:
                for how in HOWS:
                    audio = sources.line(path, how)
                    if audio is None:
                        continue
                    piece = V.QUANTISERS[writer](audio)
                    window = shipped[offset:offset + len(piece)]
                    if gain_db:
                        if fitted is None:
                            used, score = fit_gain(piece, window, gain_db)
                        else:
                            used = fitted
                            score = score_of(V.quantise_sf(V.apply_gain(piece, used)), window)
                        piece = V.quantise_sf(V.apply_gain(piece, used))
                    else:
                        used, score = None, score_of(piece, window)
                    if best is None or score < best[0]:
                        best = (score, path, how, len(piece), used)
            if best is None:
                fail = f"{clip_id} is not in the game archives"
                break
            score, path, how, size, used = best
            fitted = used if gain_db else None
            worst = max(worst, score[0])
            lines.append({"path": path, "archive": "ep1" if path.startswith("ep1\\") else "content", "how": how, "_max": score[0], "_n": score[1], "_len": size})
            offset += size + (V.GAP_SAMPLES if at < len(ids) - 1 else 0)
            if score[0] > tolerance:
                fail = f"line {at + 1} of {len(ids)} ({clip_id}) best match differs by {score[0]} steps in {score[1]} samples"
                break
        if fail is None and offset != len(shipped):
            fail = f"length {offset} against shipped {len(shipped)}"
        result = {"ok": fail is None, "reason": fail, "lines": lines, "maxDiff": worst, "writer": writer, "gainDb": fitted, "differing": sum(l["_n"] for l in lines)}
        if result["ok"] and (best_result is None or not best_result["ok"] or result["differing"] < best_result["differing"]):
            best_result = result
        elif best_result is None or (not best_result["ok"] and len(result["lines"]) > len(best_result["lines"])):
            best_result = result
    return best_result


def recover_cast_sweep(sources: Sources, wem_paths) -> tuple[dict, list]:
    """The 27 side characters (docs/CAST_SWEEP.md): one decoded line each (scripts/cast-sweep/voices.py: decode, mono, resample_poly, sf.write), shared by every kind."""
    receipt = json.loads((REPO / "characters/cast-sweep-voices.json").read_text(encoding="utf-8"))["characters"]
    work = Path(os.environ.get("CX_CAST_SWEEP", r"E:\CyberpunkConvai-offload\work\cast-sweep"))
    voices, failed = {}, []
    for key, row in receipt.items():
        clip = row.get("clip")
        if not clip:
            continue
        shipped_file = work / f"{key}.wav"
        if not shipped_file.is_file():
            failed.append({"key": key, "kind": "all", "reason": "decoded clip missing"})
            continue
        shipped = read_wav(shipped_file)
        options = [p for p in wem_paths.get(f"{int(clip['id']):016x}", []) if (clip["stem"] + "_") in p]
        best = None
        for path in options:
            for how in HOWS:
                audio = sources.line(path, how)
                if audio is not None:
                    score = score_of(V.quantise_sf(audio), shipped)
                    if best is None or score < best[0]:
                        best = (score, path, how)
        if best is None or best[0][0] > 1:
            failed.append({"key": key, "kind": "all", "reason": f"no match ({best[0] if best else 'no file'})"})
            continue
        spec = {"group": "cast-sweep", "writer": "sf", "lines": [{"path": best[1], "archive": "ep1" if best[1].startswith("ep1\\") else "content", "how": best[2]}], "gainDb": None,
                "samples": int(len(shipped)), "sha256": hashlib.sha256(shipped_file.read_bytes()).hexdigest(), "maxDiff": best[0][0], "differing": best[0][1]}
        voices[key] = {"omni-short": spec, "omni-long": {"sameAs": "omni-short"}, "pocket": {"sameAs": "omni-short"}}
    return voices, failed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--keys")
    parser.add_argument("--cast-sweep", action="store_true", help="recover the 27 side characters instead of the autobest voices")
    parser.add_argument("--shard", help="i/n: this process takes every n-th voice starting at i")
    parser.add_argument("--out", default=str(REPO / "characters/voice-clips-manifest.json"))
    parser.add_argument("--report", default=str(REPO / "research/voice-extract/recovery-report.json"))
    args = parser.parse_args()
    configs = {kind: json.loads((RUNTIME / file).read_text(encoding="utf-8-sig"))["voices"] for kind, file in CONFIGS.items()}
    wem_paths = load_wem_paths()
    sources = Sources()
    if args.cast_sweep:
        voices, failed = recover_cast_sweep(sources, wem_paths)
        Path(args.out).write_text(json.dumps({"version": 1, "rate": V.RATE, "gapSamples": V.GAP_SAMPLES, "voices": voices}, indent=1) + NL, encoding="utf-8")
        Path(args.report).write_text(json.dumps({"ok": sorted(voices), "failed": failed}, indent=1) + NL, encoding="utf-8")
        print(f"cast sweep: {len(voices)} reproduced, {len(failed)} failed")
        return 0
    keys = args.keys.split(",") if args.keys else list(configs["omni-long"])
    if args.shard:
        index, count = map(int, args.shard.split("/"))
        keys = keys[index::count]
    manifest = {"version": 1, "rate": V.RATE, "gapSamples": V.GAP_SAMPLES, "voices": {}}
    report = {"ok": [], "failed": []}
    for number, key in enumerate(keys, 1):
        for kind in CONFIGS:
            entry = configs[kind].get(key)
            if not entry:
                continue
            reference = RUNTIME.parent / entry["reference"]
            if not reference.is_file():
                report["failed"].append({"key": key, "kind": kind, "reason": "shipped file missing"})
                continue
            shipped = read_wav(reference)
            ids = entry["pick"]["clips"]
            gain = gain_of(entry)
            result = recover_one(sources, wem_paths, ids, gain, shipped)
            row = {"key": key, "kind": kind, "group": "archetypes" if "/archetypes/" in entry["reference"] else "picked", "gainDb": gain, "ids": ids}
            if result["ok"]:
                clip = {"group": row["group"], "writer": result["writer"], "lines": [{k: v for k, v in line.items() if not k.startswith("_")} for line in result["lines"]], "gainDb": result["gainDb"],
                        "samples": int(len(shipped)), "sha256": hashlib.sha256(reference.read_bytes()).hexdigest(), "maxDiff": result["maxDiff"],
                        "differing": int(sum(line["_n"] for line in result["lines"]))}
                manifest["voices"].setdefault(key, {})[kind] = clip
                report["ok"].append({**row, "maxDiff": result["maxDiff"]})
            else:
                report["failed"].append({**row, "reason": result["reason"], "lines": [{k: v for k, v in line.items()} for line in result["lines"]]})
        done = len(report["ok"]) + len(report["failed"])
        print(f"[{number}/{len(keys)}] {key}: ok {len(report['ok'])} failed {len(report['failed'])}", flush=True)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    print(f"clips ok {len(report['ok'])}, failed {len(report['failed'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
