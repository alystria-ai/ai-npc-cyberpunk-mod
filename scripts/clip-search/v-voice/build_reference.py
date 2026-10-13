"""Build the two V voice references (male V, female V) from clips extracted by extract_v.py and checked by analyze_v.py / asr_v.py.

Usage:
  python scripts/clip-search/v-voice/build_reference.py OUT_DIR --male-dir EXTRACT_DIR --male ID [ID ...] --female-dir EXTRACT_DIR --female ID [ID ...]
IDs are decimal string ids, best clip first (one cloud voice cuts its reference to about the first 8.5 s).  Either gender may be left out.
Each clip: the LEFT channel only when the stereo channels are decorrelated (a mean downmix would comb-filter the voice, as for Delamain),
else the mono mean (V's lines decode as mono, so in practice the clip as is); resampled to 24 kHz (scipy polyphase); leading/trailing
silence below -45 dBFS trimmed with 80 ms of margin; joined with 0.4 s of silence; 16-bit PCM; no EQ, no denoise, no gain.
Refuses a set whose total is over 20 s, under 8 s, or whose clips differ in gated loudness by more than 2 dB.
Writes OUT_DIR/v-male.wav, OUT_DIR/v-female.wav, OUT_DIR/v-voice.json (committed manifest: UTF-8, 2-space indent, LF) and
OUT_DIR/v-voice-build.json (metrics, ASR results and how it was made; status says nobody has listened and nothing is approved).
"""
import argparse, datetime, hashlib, json, sys
from pathlib import Path
import numpy as np, soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vcommon import RATE, GAP, MARGIN, THRESH_DB, load_mono24, trim, db

sys.stdout.reconfigure(encoding="utf-8")
MAX_TOTAL, MIN_TOTAL, MAX_SPREAD_DB, ASR_BAR = 20.0, 8.0, 2.0, 0.95


def write_text_lf(path, text):
    Path(path).write_bytes(text.encode("utf-8"))


def build(gender, extract_dir, ids, out):
    d = Path(extract_dir)
    man = {m["stringId"]: m for m in json.loads((d / "extract-manifest.json").read_text("utf-8"))}
    ana = {c["stringId"]: c for c in json.loads((d / "analysis.json").read_text("utf-8"))["clips"]} if (d / "analysis.json").exists() else {}
    asr = json.loads((d / "asr.json").read_text("utf-8")) if (d / "asr.json").exists() else {}
    parts, clips, detail = [], [], []
    for sid in ids:
        m = man[sid]
        assert m["stem"].startswith("v_") and f"_{'f' if gender == 'female' else 'm'}_" in m["stem"], m["stem"]
        m24, _, _, info = load_mono24(m["wavPath"])
        t = trim(m24)
        if parts:
            parts.append(np.zeros(int(GAP * RATE), dtype=np.float32))
        parts.append(t)
        sec = round(len(t) / RATE, 3)
        clips.append({"stringId": sid, "stem": m["stem"], "scene": m["scene"], "seconds": sec})
        a = ana.get(sid, {})
        detail.append({"stringId": sid, "stem": m["stem"], "text": m["transcript"], "seconds": sec, "channelUsed": info["used"],
                       "gatedRmsDb": a.get("gatedRmsDb"), "peakDbfs": a.get("peakDbfs"), "clipped": a.get("clipped"), "f0": a.get("f0"),
                       "silenceRatio": a.get("silenceRatio"), "noiseFloorDb": a.get("noiseFloorDb"), "speechToFloorDb": a.get("speechToFloorDb"),
                       "spectral": a.get("spectral"), "asr": asr.get(sid), "wemPath": m["wemPath"], "archive": m["source"]["archive"]})
    audio = np.concatenate(parts)
    total = len(audio) / RATE
    assert MIN_TOTAL <= total <= MAX_TOTAL, f"{gender}: total {total:.2f} s outside {MIN_TOTAL}-{MAX_TOTAL}"
    loud = [x["gatedRmsDb"] for x in detail if x["gatedRmsDb"] is not None]
    spread = round(max(loud) - min(loud), 2) if loud else None
    assert spread is None or spread <= MAX_SPREAD_DB, f"{gender}: loudness spread {spread} dB"
    wav = Path(out) / f"v-{gender}.wav"
    sf.write(wav, audio, RATE, subtype="PCM_16")
    data = wav.read_bytes()
    transcript = " ".join(m["transcript"] for m in (man[s] for s in ids))
    entry = {"file": wav.name, "transcript": transcript, "sha256": hashlib.sha256(data).hexdigest(), "seconds": round(total, 3),
             "sampleRate": RATE, "clips": clips}
    asr_ok = bool(detail) and all(x["asr"] and x["asr"]["similarity"] >= ASR_BAR for x in detail)
    info = {"seconds": round(total, 3), "peakDbfs": round(db(np.abs(audio).max()), 2), "loudnessSpreadDb": spread, "clips": detail,
            "asrVerified": asr_ok, "asrBar": ASR_BAR}
    return entry, info


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out_dir")
    ap.add_argument("--male-dir"); ap.add_argument("--male", nargs="*", default=[])
    ap.add_argument("--female-dir"); ap.add_argument("--female", nargs="*", default=[])
    a = ap.parse_args()
    out = Path(a.out_dir); out.mkdir(parents=True, exist_ok=True)
    voices, details = {}, {}
    for gender, ddir, ids in (("male", a.male_dir, a.male), ("female", a.female_dir, a.female)):
        if ids:
            voices[gender], details[gender] = build(gender, ddir, ids, out)
    write_text_lf(out / "v-voice.json", json.dumps({"version": 1, "voices": voices}, ensure_ascii=False, indent=2) + "\n")
    asr_all = all(x["asrVerified"] for x in details.values())
    build_info = {
        "version": 1,
        "status": ("ASR verified: " + ("yes (Whisper small.en on CPU, word similarity >= %.2f for every clip)" % ASR_BAR if asr_all else "NO")
                   + ". Listened: NO - nobody has listened. Approval: NO."),
        "madeWith": {
            "tool": "scripts/clip-search/v-voice (extract_v.py -> analyze_v.py -> asr_v.py -> build_reference.py)",
            "builtAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "the game's own English voice lines of the player character V (male V: Gavin Drea, female V: Cherami Leigh), archive/pc/content and archive/pc/ep1 lang_en_voice.archive",
            "recipe": "chosen channel (left only if the stereo channels are decorrelated, else mean; the V lines are mono) -> 24 kHz polyphase resample -> trim below -45 dBFS with 80 ms margin -> clips joined with 0.4 s silence -> 16-bit PCM; no EQ, no denoise, no gain",
            "selection": "the project's automatic reference search (scripts/clip-search/search.py, Pocket on the CPU) over V's calm quest lines (scripts/clip-search/v-voice/build_v_pool.py: spoken only, no combat/shouted delivery, no band-limited, dull, hot, comb, tone or reverb lines), ECAPA similarity to held-out real V lines; docs/V_VOICE.md has the scores",
        },
        "voices": details,
    }
    write_text_lf(out / "v-voice-build.json", json.dumps(build_info, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"version": 1, "voices": voices}, ensure_ascii=False, indent=2))
    for g, i in details.items():
        print(g, i["seconds"], "s peak", i["peakDbfs"], "spread", i["loudnessSpreadDb"], "asrVerified", i["asrVerified"])


if __name__ == "__main__":
    main()
