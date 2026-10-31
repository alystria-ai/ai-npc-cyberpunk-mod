"""Step 4b of the cast sweep: one clean, non-phone reference clip for every person who has voice files of their own.

    python scripts/cast-sweep/voices.py [--people staging/cast-sweep/final-people.json] [--stems staging/cast-sweep/stems.json]

The owner's rule (30 Oct): any clean clip that is not phone audio.  Only the plain `vo` folder is used (never vo_holocall,
vo_helmet, vo_radio), stems of news, radio, loading screens, chip-ins and calls are skipped, and every decoded candidate is checked:
duration 3.5 to 9.5 s (so the one clip fits the OmniVoice short, long and Pocket sets), at least 6 words, no clipping,
peak at most 0.99 and the share of energy above 4 kHz at least 0.4 percent (a telephone line has none).  The best of up to
four candidates per person is decoded to 24 kHz mono 16-bit PCM in WORK/<key>.wav (E: offload, never in the repo).

Writes staging/cast-sweep/voices.json: {key: {stem, id, variant, seconds, words, hf, peak, wav, repo: {stem, id, seconds}}}.
The repo-safe part (`repo`) holds no dialogue text.  Nothing is uploaded and no config is changed.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly, welch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0] / "clip-search" / "cast-expansion"))
from cx_common import GAME, MAIN, Subtitles, decode, load_extractor, parse_wem, wem_lists, words  # noqa: E402

WORK = Path(r"E:\CyberpunkConvai-offload\work\cast-sweep")
SKIP_STEM = re.compile(r"radio|media|news|tv_|_ad_|loading_screen|infoflash|chip_in|holocall|phone|call|broadcast|segment|helmet|crowd|bark|combat", re.I)


def analyse(wav: Path):
    data, rate = sf.read(str(wav), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    peak = float(np.abs(data).max())
    clipped = int((np.abs(data) >= 0.999).sum())
    freqs, power = welch(mono, fs=rate, nperseg=4096)
    band = (freqs >= 100) & (freqs <= min(10000, rate / 2 - 1))
    hf = float(power[(freqs >= 4000) & band].sum() / max(power[band].sum(), 1e-12))
    return {"seconds": len(mono) / rate, "peak": peak, "clipped": clipped, "hf": hf, "rate": rate}


class AsrCheck:
    """Whisper small.en (the project's copy) against the game subtitle: difflib ratio of the lower case words."""

    def __init__(self):
        import glob
        import torch
        from transformers import pipeline
        snap = glob.glob(str(MAIN / "vendor/voice-models/hub/models--openai--whisper-small.en/snapshots/*"))[0]
        self.pipe = pipeline("automatic-speech-recognition", model=snap, device=-1)

    @staticmethod
    def norm(text: str) -> list[str]:
        return re.sub(r"[^a-z0-9' ]", " ", (text or "").lower().replace("–", " ").replace("—", " ").replace("’", "'")).split()

    def check(self, wav: Path, text: str):
        import difflib
        data, rate = sf.read(str(wav), dtype="float32", always_2d=True)
        mono = data.mean(axis=1)
        g = int(np.gcd(rate, 16000))
        mono = resample_poly(mono, 16000 // g, rate // g)
        heard = self.pipe({"raw": mono.astype(np.float32), "sampling_rate": 16000})["text"].strip()
        return round(difflib.SequenceMatcher(None, self.norm(text), self.norm(heard)).ratio(), 3), heard


def to_24k_mono(src: Path, dst: Path):
    data, rate = sf.read(str(src), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if rate != 24000:
        g = np.gcd(rate, 24000)
        mono = resample_poly(mono, 24000 // g, rate // g)
    sf.write(str(dst), mono, 24000, subtype="PCM_16")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--people", default="staging/cast-sweep/final-people.json")
    ap.add_argument("--stems", default="staging/cast-sweep/stems.json")
    ap.add_argument("--out", default="staging/cast-sweep/voices.json")
    ap.add_argument("--asr", action="store_true", help="also require Whisper small.en to hear the game subtitle (similarity at least 0.85) and the line to be in the 2.31 archive too")
    ap.add_argument("--game231", default="E:/SteamLibrary/Cyberpunk2077-2.31")
    args = ap.parse_args()
    people = {p["key"]: p for p in json.loads(Path(args.people).read_text(encoding="utf-8"))}
    stems = json.loads(Path(args.stems).read_text(encoding="utf-8"))
    subs = Subtitles()
    ext = load_extractor()
    oodle = ext.Oodle(GAME / "tools/redmod/bin/oo2ext_7_win64.dll")
    archives = [ext.Archive(GAME, r) for r in ext.ARCHIVES[:2]]
    old_archives = [ext.Archive(Path(args.game231), r) for r in ext.ARCHIVES[:2]] if args.asr else []
    asr = AsrCheck() if args.asr else None
    # path index: stem -> {id: (variant -> path)}
    wanted = {s["stem"] for rows in stems.values() for s in rows if not SKIP_STEM.search(s["stem"])}
    index: dict[str, dict[str, dict[str, str]]] = {}
    for label, lines in wem_lists().items():
        for path in lines:
            parsed = parse_wem(path)
            if parsed and parsed[0] == "vo" and parsed[1].lower() in wanted:
                index.setdefault(parsed[1].lower(), {}).setdefault(parsed[3], {})[parsed[2]] = path
    WORK.mkdir(parents=True, exist_ok=True)
    result = {}
    for key, rows in stems.items():
        if key not in people:
            continue
        cands = []
        for row in rows:
            if SKIP_STEM.search(row["stem"]):
                continue
            for sid, variants in index.get(row["stem"], {}).items():
                if row.get("ids") and sid not in row["ids"]:
                    continue                      # only the lines a scene proves are this person's (voice_models.py)
                variant = "f" if "f" in variants else "m"
                text = subs.text(sid, variant)
                n = words(text)
                if n < 6 or n > 32 or re.search(r"[\[\]<>*]", text):
                    continue
                cands.append((abs(n - 14), sid, variant, variants[variant], row["stem"], n, text))
        cands.sort()
        best = None
        tried = 0
        why: list[str] = []
        for _, sid, variant, path, stem, n, text in cands:
            if tried >= (10 if args.asr else 6):
                break
            got = None
            for a in archives:
                got = a.read(path, oodle)
                if got:
                    break
            if not got:
                continue
            tried += 1
            raw = WORK / "raw" / f"{key}-{sid}.wem"
            raw.parent.mkdir(parents=True, exist_ok=True)
            raw.write_bytes(got[0])
            full = raw.with_suffix(".wav")
            try:
                decode(raw, full)
                q = analyse(full)
            except Exception as exc:  # noqa: BLE001
                print("decode failed", key, sid, exc)
                continue
            ok = 3.5 <= q["seconds"] <= 9.5 and q["clipped"] == 0 and q["peak"] <= 0.99 and q["hf"] >= 0.004
            similarity, heard, in_both = None, None, None
            if ok and asr:
                older = next((r for r in (x.read(path, oodle) for x in old_archives) if r), None)
                in_both = bool(older) and older[0] == got[0]          # the same bytes in the 2.31 copy, so both game versions rebuild it
                similarity, heard = asr.check(full, text)
                ok = bool(in_both) and similarity >= 0.85
                if not ok:
                    why.append(f"{sid}: {'not in 2.31 ' if not in_both else ''}asr {similarity}")
            elif not ok:
                why.append(f"{sid}: {q['seconds']:.1f}s peak {q['peak']:.2f} clipped {q['clipped']} hf {q['hf']:.3f}")
            score = -abs(q["seconds"] - 7.0) + 0.05 * min(n, 20)
            if ok and (best is None or score > best[0]):
                best = (score, sid, variant, stem, n, q, full, path, similarity, heard, text)
        if best:
            _, sid, variant, stem, n, q, full, path, similarity, heard, text = best
            out = WORK / f"{key}.wav"
            to_24k_mono(full, out)
            result[key] = {"stem": stem, "id": sid, "variant": variant, "seconds": round(q["seconds"], 2), "words": n, "hf": round(q["hf"], 4),
                           "peak": round(q["peak"], 3), "wav": str(out), "wemPath": path, "similarity": similarity, "heard": heard, "text": text,
                           "repo": {"stem": stem, "id": sid, "seconds": round(q["seconds"], 2)}}
            print(f"{key}: {stem} {sid} {q['seconds']:.1f}s {n}w hf={q['hf']:.3f}")
        else:
            print(f"{key}: no clip passed ({len(cands)} candidates, {tried} tried) {'; '.join(why[:4])}")
    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"clips picked for {len(result)} of {len(stems)} people with stems")
    return 0


if __name__ == "__main__":
    sys.exit(main())
