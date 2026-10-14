"""Apply the loudness-aware OmniVoice picks and a -20 LUFS gain match to the 43 non-report voices (2026-10-14).  CPU only, plays nothing.

  python -I scripts/clip-search/loud43/apply_loud43.py [--dry-run]      (run with vendor/reference-voicestudio/.venv/Scripts/python.exe)

For the 43 voices only (the 29 report voices, 8ug8ear and jake-estevez are never read or written):
  OmniVoice  short / long / best  -> the NEW picks of runs3/omni16-loud, rebuilt from the pool clips the clip-search way (whole clips,
                                     0.4 s gaps, mono 24 kHz, 16-bit) and then gain-matched
  Pocket     best                 -> the CURRENT pick (the reference already in the live config, from its backup copy) gain-matched
Gain match: one linear gain towards -20 LUFS integrated (BS.1770-4); where that would push the true peak over -3 dBFS the highest level that
fits is used instead (a voice that cannot reach -20 is listed in the report).  No limiter, no compressor, no EQ.  A set hotter than -20 LUFS
is turned down by the same rule.  Gain is always computed from the raw (un-gained) reference, so re-running changes nothing.

Writes   <runtime>/voice-references/picked/autobest/<omni-short|omni-long|omni|pocket>/<voice>.wav       (43 voices x 4 folders)
         the four autobest configs (entries of the 43 voices only; line endings and every other entry byte for byte), runtime/autobest-sets.json
Backups  <runtime>/backups/clip-search-43-20261014/  (originals of everything written; also the raw source for the Pocket references)
Report   E:/CyberpunkConvai-offload/work/clip-search/loud43/apply-report.json
Then validate with scripts/clip-search/loud43/validate_configs.mjs (the bridge's own Node loaders) and scripts/reference-picker/validate-config.py.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import common  # noqa: E402
import loudband  # noqa: E402
from loud_survey import voices43  # noqa: E402

MAIN = Path(os.environ.get("CLIP_SEARCH_ROOT") or common.ROOT)
RUNTIME = MAIN / "runtime"
REFS = RUNTIME / "voice-references/picked/autobest"
BACKUP = RUNTIME / "backups/clip-search-43-20261014"
TARGET_LUFS, CEILING_DB, MARGIN_DB = -20.0, -3.0, 0.03
RATE = common.REFERENCE_RATE
CONFIGS = {"pocket": "pocket-voices.autobest.json", "omni-short": "local-voices.autobest-short.json",
           "omni-long": "local-voices.autobest-long.json", "omni": "local-voices.autobest.json"}
NEW_TAG = "omni16-loud"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_cfg(path: Path):
    raw = path.read_bytes()
    text = raw.decode("utf-8")
    assert not text.startswith("\ufeff"), f"{path.name} has a BOM"
    crlf = "\r\n" in text
    return json.loads(text.replace("\r\n", "\n")), crlf, raw


def dump_cfg(obj, crlf: bool) -> bytes:
    text = json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    return (text.replace("\n", "\r\n") if crlf else text).encode("utf-8")


def gain_match(x: np.ndarray):
    """(gained float64 samples, info).  Linear gain towards TARGET_LUFS, capped so the 4x true peak stays at or below CEILING_DB (checked after
    16-bit rounding; the gain is trimmed in 0.01 dB steps if rounding pushes it over)."""
    lufs, tp = loudband.L.lufs(x, RATE), loudband.L.true_peak_db(x)
    want = TARGET_LUFS - lufs
    gain = min(want, CEILING_DB - MARGIN_DB - tp)
    for _ in range(40):
        y = np.round(np.clip(x * 10 ** (gain / 20), -1, 1) * 32767) / 32767
        if loudband.L.true_peak_db(y) <= CEILING_DB:
            break
        gain -= 0.01
    after = loudband.measure_signal(y)
    return y, {"raw_lufs": round(lufs, 2), "raw_tp": round(tp, 2), "gain_db": round(gain, 2), "wanted_db": round(want, 2),
               "peak_limited": bool(CEILING_DB - MARGIN_DB - tp < want), "lufs": after["lufs"], "tp": after["tp"], "plr": after["plr"]}


def wav_bytes(y: np.ndarray) -> bytes:
    import io
    buffer = io.BytesIO()
    sf.write(buffer, y.astype(np.float32), RATE, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def main() -> int:
    dry = "--dry-run" in sys.argv
    index = common.load_index()
    voices = voices43()
    runs = common.WORK / "runs3"
    # ---- backups (once; never overwritten) ----
    cfgs = {name: read_cfg(RUNTIME / file) for name, file in CONFIGS.items()}
    sets_path = RUNTIME / "autobest-sets.json"
    sets_raw = sets_path.read_bytes()
    sets = json.loads(sets_raw.decode("utf-8"))
    if not BACKUP.exists() and not dry:
        for name, file in CONFIGS.items():
            (BACKUP / "configs").mkdir(parents=True, exist_ok=True)
            shutil.copy2(RUNTIME / file, BACKUP / "configs" / file)
        shutil.copy2(sets_path, BACKUP / "configs" / "autobest-sets.json")
        for name in CONFIGS:
            for voice in voices:
                src = REFS / name / f"{voice}.wav"
                (BACKUP / "wavs" / name).mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, BACKUP / "wavs" / name / f"{voice}.wav")
    base = BACKUP if BACKUP.exists() else RUNTIME       # raw sources
    cfg0 = {name: read_cfg(base / "configs" / file if base is BACKUP else RUNTIME / file) for name, file in CONFIGS.items()}
    # the untouched originals must round-trip exactly, or this script would rewrite more than the 43 entries
    for name, (obj, crlf, raw) in cfg0.items():
        assert dump_cfg(obj, crlf) == raw, f"{CONFIGS[name]} does not round-trip byte for byte"
    sets_raw0 = (base / "configs" / "autobest-sets.json" if base is BACKUP else sets_path).read_bytes()
    CR = chr(13) + chr(10)
    sets_crlf = CR.encode() in sets_raw0
    sets0 = json.loads(sets_raw0.decode("utf-8").replace(CR, "\n"))

    def dump_sets(obj):
        text = json.dumps(obj, indent=1) + "\n"
        return (text.replace("\n", CR) if sets_crlf else text).encode("utf-8")
    assert dump_sets(sets0) == sets_raw0, "autobest-sets.json does not round-trip"
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    report = {"generated": now, "target_lufs": TARGET_LUFS, "ceiling_tp": CEILING_DB, "voices": {}, "peak_limited": [], "problems": []}
    new_cfgs = {name: json.loads(json.dumps(cfg0[name][0])) for name in CONFIGS}
    new_sets = json.loads(json.dumps(sets0))
    pending: dict = {}                  # nothing is written until every voice has been computed and checked
    comparison = {"version": 2, "generated": now, "note": "43 non-report voices: OmniVoice = loudness-aware picks (omni16-loud), Pocket = current picks; "
                  "references are gain-matched to -20 LUFS (apply_loud43.py). Rebuilding with Build-AutobestConfigs.mjs would NOT apply the gain.",
                  "voices": {}}
    for voice in voices:
        new = json.loads((runs / NEW_TAG / voice / "result.json").read_text(encoding="utf-8"))
        picks = new["picks"]
        row = {}
        pool = common.VoicePool(index, voice)
        omni_ids = {"omni-short": picks["short"]["ids"], "omni-long": picks["long"]["ids"], "omni": picks["best"]["ids"]}
        for name in ("omni-short", "omni-long", "omni", "pocket"):
            entry = new_cfgs[name]["voices"][voice]
            old_entry = cfg0[name][0]["voices"][voice]
            old_raw = (base / "wavs" / name / f"{voice}.wav") if base is BACKUP else (REFS / name / f"{voice}.wav")
            old_samples, old_rate = sf.read(str(old_raw), dtype="float64")
            old_measure = loudband.measure_signal(old_samples)
            assert sha(old_raw.read_bytes()) == old_entry["sha256"], f"{voice}/{name}: backup/raw file does not match its config hash"
            if name == "pocket":
                x = old_samples
                ids = old_entry["pick"]["clips"]
                transcript = old_entry["transcript"]
            else:
                ids = omni_ids[name]
                tmp = common.WORK / "loud43" / "raw" / name / f"{voice}.wav"
                common.build_reference([pool.clip(i)["path"] for i in ids], tmp)
                x, _ = sf.read(str(tmp), dtype="float64")
                transcript = " ".join(pool.clip(i)["t"].strip() for i in ids)
            y, info = gain_match(x)
            seconds = round(len(y) / RATE * 100) / 100
            limit = 30 if name == "pocket" else (10 if name == "omni-short" else 18)
            assert seconds <= limit + 1e-6, f"{voice}/{name}: {seconds} s over its {limit} s limit"
            data = wav_bytes(y)
            import io
            chk = loudband.measure_signal(sf.read(io.BytesIO(data), dtype="float64")[0])
            assert chk["tp"] <= CEILING_DB + 1e-6 and abs(chk["lufs"] - info["lufs"]) < 0.05, f"{voice}/{name}: encoded file measures {chk}"
            digest = sha(data)
            pending[REFS / name / f"{voice}.wav"] = data
            same_set = sorted(ids) == sorted(old_entry["pick"]["clips"])
            note = (f"loudness-aware clip search 2026-10-14 ({'kept the earlier set' if same_set else 'new clip set'}), gain {info['gain_db']:+.2f} dB "
                    f"to {info['lufs']:.1f} LUFS (true peak {info['tp']:.1f} dBFS)" if name != "pocket" else
                    f"{old_entry['pick'].get('note', '')} | gain {info['gain_db']:+.2f} dB to {info['lufs']:.1f} LUFS (true peak {info['tp']:.1f} dBFS), clip-search-43 2026-10-14")
            pick = {"clips": ids, "seconds": seconds, "keptAt": old_entry["pick"]["keptAt"] if name == "pocket" else now, "note": note,
                    "gain": {"db": info["gain_db"], "targetLufs": TARGET_LUFS, "lufs": info["lufs"], "truePeakDb": info["tp"], "peakLimited": info["peak_limited"]}}
            new_cfgs[name]["voices"][voice] = {"reference": old_entry["reference"], "sha256": digest, "transcript": transcript,
                                               "transcriptSha256": sha(transcript.encode("utf-8")), "status": "ready", "pick": pick}
            assert new_cfgs[name]["voices"][voice]["reference"] == f"runtime/voice-references/picked/autobest/{name}/{voice}.wav"
            row[name] = {"ids": ids, "seconds": seconds, "set_changed": not same_set, "before": old_measure, "gain": info,
                         "before_seconds": old_entry["pick"]["seconds"], "before_clips": old_entry["pick"]["clips"]}
            if info["peak_limited"] and info["lufs"] < TARGET_LUFS - 0.05:
                report["peak_limited"].append({"voice": voice, "set": name, "lufs": info["lufs"], "tp": info["tp"], "raw_lufs": info["raw_lufs"]})
        # runtime/autobest-sets.json (the picker/builder data file): new Omni picks; Pocket untouched
        sv = new_sets["voices"][voice]["omni"]
        for key, name in (("short", "omni-short"), ("long", "omni-long"), ("best", "omni")):
            p = picks[key]
            sv[key] = {k: p[k] for k in ("ids", "seconds", "ecapa", "ecapa_se", "ecapa_tgt", "pls", "latency_ms") if k in p}
            sv[key]["note"] = new_cfgs[name]["voices"][voice]["pick"]["note"]
        comparison["voices"][voice] = {"omni": {k: new_sets["voices"][voice]["omni"][k] for k in ("short", "long", "best")},
                                       "pocket": {"best": {"ids": row["pocket"]["ids"], "seconds": row["pocket"]["seconds"], "note": "current pick, unchanged"}}}
        report["voices"][voice] = row
    for name in CONFIGS:
        cfg = new_cfgs[name]
        cfg["proposal"] = {**cfg["proposal"], "loudness_update": {"date": "2026-10-14", "voices": voices,
                           "omni": "loudness-aware picks (runs3/omni16-loud)" if name != "pocket" else "Pocket keeps its current picks",
                           "gain": f"linear gain to {TARGET_LUFS:g} LUFS, true peak at most {CEILING_DB:g} dBFS, no limiter",
                           "script": "scripts/clip-search/loud43/apply_loud43.py", "backup": "runtime/backups/clip-search-43-20261014"}}
    report["peak_limited"].sort(key=lambda r: (r["set"], r["voice"]))
    out = common.WORK / "loud43" / "apply-report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1), encoding="utf-8")
    dest = HERE / "autobest-sets.loud43.json"
    dest.write_text(json.dumps(comparison, indent=1), encoding="utf-8")
    if dry:
        print("dry run: nothing written to runtime;", len(report["peak_limited"]), "set(s) peak-limited")
        return 0
    for path, data in pending.items():
        write_bytes(path, data)
    for name, file in CONFIGS.items():
        data = dump_cfg(new_cfgs[name], cfgs[name][1])
        tmp = RUNTIME / (file + ".tmp43")
        tmp.write_bytes(data)
        os.replace(tmp, RUNTIME / file)
    tmp = sets_path.with_name(sets_path.name + ".tmp43")
    tmp.write_bytes(dump_sets(new_sets))
    os.replace(tmp, sets_path)
    print("written; peak-limited sets:", len(report["peak_limited"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
