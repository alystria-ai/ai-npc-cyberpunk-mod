"""Write Viktor Vektor's chosen reference into the three live autobest voice configs (CPU only, plays nothing).

  python apply_viktor.py <picked folder> [--dry-run]

<picked folder> is one candidate folder of the step-2 listening set (deliverables/voice-picks/viktor/step2/<n>): reference.wav + reference-words.txt (the
LONG reference: OmniVoice long and the Pocket set), reference-balanced.wav + reference-balanced-words.txt (the SHORT one: OmniVoice short).  Also needs
--clips-long "<sid>,<sid>" and --clips-short "<sid>" (the game string ids of the lines, in order) for the config's pick record.
CLIP_SEARCH_ROOT must name the main checkout (runtime/ lives there).

What it writes (nothing else is touched; a config must round-trip byte for byte first):
  runtime/voice-references/picked/autobest/<omni-short|omni-long|pocket>/viktor-vektor.wav   (copies of the picked WAVs)
  the viktor-vektor entry of runtime/local-voices.autobest-short.json, local-voices.autobest-long.json and pocket-voices.autobest.json
    {reference, sha256, transcript, transcriptSha256, status "ready", pick {clips, seconds, keptAt, note, gain}}
Backups of the three configs and the three WAVs go to runtime/backups/viktor-voice-<date>/ first (never overwritten).
The references are already built the shipped way (build_refs.py: whole in-person clips, 0.4 s gaps, mono 24 kHz, -20 LUFS gain match, true peak at most -1 dBTP).
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

import soundfile as sf

KEY = "viktor-vektor"
MAIN = Path(os.environ.get("CLIP_SEARCH_ROOT") or Path(__file__).resolve().parents[3])
RUNTIME = MAIN / "runtime"
REFS = RUNTIME / "voice-references/picked/autobest"
CONFIGS = {"omni-short": "local-voices.autobest-short.json", "omni-long": "local-voices.autobest-long.json", "pocket": "pocket-voices.autobest.json"}
LIMITS = {"omni-short": 10.0, "omni-long": 18.0, "pocket": 30.0}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_cfg(path: Path):
    raw = path.read_bytes()
    text = raw.decode("utf-8")
    assert not text.startswith("﻿"), f"{path.name} has a BOM"
    crlf = "\r\n" in text
    return json.loads(text.replace("\r\n", "\n")), crlf, raw


def dump_cfg(obj, crlf: bool) -> bytes:
    text = json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    return (text.replace("\n", "\r\n") if crlf else text).encode("utf-8")


def main() -> int:
    args = sys.argv[1:]
    dry = "--dry-run" in args
    arg = lambda name: args[args.index(name) + 1]
    folder = Path(args[0])
    clips = {"omni-long": arg("--clips-long").split(","), "pocket": arg("--clips-long").split(","), "omni-short": arg("--clips-short").split(",")}
    sources = {"omni-long": ("reference.wav", "reference-words.txt"), "pocket": ("reference.wav", "reference-words.txt"),
               "omni-short": ("reference-balanced.wav", "reference-balanced-words.txt")}
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    backup = RUNTIME / f"backups/viktor-voice-{datetime.date.today():%Y%m%d}"
    cfgs = {name: read_cfg(RUNTIME / file) for name, file in CONFIGS.items()}
    for name, (obj, crlf, raw) in cfgs.items():
        assert dump_cfg(obj, crlf) == raw, f"{CONFIGS[name]} does not round-trip byte for byte"
    plan = {}
    for name in CONFIGS:
        wav_src, words_src = folder / sources[name][0], folder / sources[name][1]
        data = wav_src.read_bytes()
        info = sf.info(str(wav_src))
        seconds = round(info.frames / info.samplerate, 2)
        assert info.samplerate == 24000 and info.channels == 1 and info.subtype == "PCM_16", (name, info)
        assert 5.0 <= seconds <= LIMITS[name], f"{name}: {seconds} s outside 5 to {LIMITS[name]} s"
        transcript = " ".join(words_src.read_text(encoding="utf-8").split())
        assert len(transcript.split()) >= 5
        plan[name] = (data, seconds, transcript)
        print(name, seconds, "s", sha(data)[:12], "|", transcript[:70])
    if dry:
        print("dry run: nothing written")
        return 0
    for name, file in CONFIGS.items():
        (backup / "configs").mkdir(parents=True, exist_ok=True)
        (backup / "wavs" / name).mkdir(parents=True, exist_ok=True)
        if not (backup / "configs" / file).exists():
            shutil.copy2(RUNTIME / file, backup / "configs" / file)
        old = REFS / name / f"{KEY}.wav"
        if old.exists() and not (backup / "wavs" / name / f"{KEY}.wav").exists():
            shutil.copy2(old, backup / "wavs" / name / f"{KEY}.wav")
    for name, file in CONFIGS.items():
        data, seconds, transcript = plan[name]
        target = REFS / name / f"{KEY}.wav"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        obj, crlf, _ = cfgs[name]
        obj["voices"][KEY] = {
            "reference": f"runtime/voice-references/picked/autobest/{name}/{KEY}.wav", "sha256": sha(data), "transcript": transcript,
            "transcriptSha256": sha(transcript.encode("utf-8")), "status": "ready",
            "pick": {"clips": [f"{KEY}/{sid}" for sid in clips[name]], "seconds": seconds, "keptAt": now,
                     "note": f"in-person recordings (the earlier set was built from phone-filtered holocall files), picked by ear by the owner {now[:10]} "
                             f"(candidate 3 of scripts/clip-search/viktor), -20 LUFS gain match held by the -1 dBTP true-peak ceiling"}}
        tmp = RUNTIME / (file + ".tmpviktor")
        tmp.write_bytes(dump_cfg(obj, crlf))
        os.replace(tmp, RUNTIME / file)
        print("wrote", file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
