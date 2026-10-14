"""Shortlist V's most projected conversational lines (CPU only, plays nothing).

    python scripts/clip-search/v-voice/projection.py INDEX OUT.json [--voices v-male,v-female] [--top 20]

For every reference candidate of the pool the picker's own rules allow (1.5-9 s, three words or more, no effect flag, no combat or shouted
or inner-voice/phone/cyberspace delivery, not one of the held-out real V lines) it measures how the line is delivered, independent of the
level the recording happens to have:
  lufs / gated   BS.1770 integrated loudness and the picker's gated RMS of the raw (un-normalised) pool clip: the mix level of the line
  alpha          dB of energy 1-5 kHz over 50-1000 Hz in the loud speech frames (vocal effort: a projected voice has a flatter tilt than a
                 soft one; the 'alpha ratio' of voice research)
  f0 / f0hi      median and 90th-percentile pitch, in semitones above the voice's own median over all pool clips
  rangeSt        10th-90th percentile pitch range in semitones
  active         share of 20 ms frames within 25 dB of the loudest (a line full of pauses sounds soft)
projection = mean of the z-scores of lufs, alpha and f0, with a small bonus for few pauses.  Not-shouting guards: lines above the 97th
percentile of the combined effort measure, with two or more exclamation marks, a pitch median more than 4 semitones above the voice's
median, or a pitch range wider than 9 semitones (an excited or shouted line) are dropped; so are lines with a peak above -3 dBFS.
Writes OUT.json: per voice the ranked shortlist (id, text, measures) and the pool medians the ranking is relative to.
"""
import argparse, json, math, statistics, sys
from pathlib import Path
import numpy as np, soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
import common  # noqa: E402
import search  # noqa: E402
from loudness import lufs, gated_rms_db, true_peak_db  # noqa: E402
from vcommon import f0_stats  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")


def alpha_ratio(x, rate=24000):
    """dB(1-5 kHz) - dB(50-1000 Hz) summed over the loud 25 ms frames."""
    fr = int(rate * 0.025); n = len(x) // fr
    f = x[: n * fr].reshape(n, fr).astype(np.float64)
    e = (f ** 2).mean(1)
    loud = f[e >= e.max() * 10 ** (-1.5)]                       # within 15 dB of the loudest frame
    sp = (np.abs(np.fft.rfft(loud * np.hanning(fr), axis=1)) ** 2).sum(0)
    fq = np.fft.rfftfreq(fr, 1 / rate)
    lo, hi = sp[(fq >= 50) & (fq < 1000)].sum(), sp[(fq >= 1000) & (fq < 5000)].sum()
    return float(10 * math.log10(hi / max(lo, 1e-20)))


def measure(path):
    x, sr = sf.read(path, dtype="float32")
    assert sr == 24000
    fr = int(sr * 0.02); n = len(x) // fr
    el = 10 * np.log10((x[: n * fr].reshape(n, fr).astype(np.float64) ** 2).mean(1) + 1e-12)
    return {"lufs": round(lufs(x, sr), 2), "gated": round(gated_rms_db(x, sr), 2), "alpha": round(alpha_ratio(x, sr), 2),
            "peak": round(20 * math.log10(max(float(np.abs(x).max()), 1e-9)), 2), "active": round(float((el > el.max() - 25).mean()), 3),
            "f0": f0_stats(x, sr)}


def eligible(index, voice):
    split = search.split_for(index, voice)
    pool = common.VoicePool(index, voice)
    return pool, split, [pool.clip(c) for c in split["candidates"]]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("index"); ap.add_argument("out")
    ap.add_argument("--voices", default="v-male,v-female")
    ap.add_argument("--top", type=int, default=20)
    a = ap.parse_args()
    index = common.load_index(Path(a.index))
    report = {}
    for voice in a.voices.split(","):
        pool, split, cands = eligible(index, voice)
        print(voice, "candidates", len(cands), flush=True)
        rows = []
        for c in cands:
            m = measure(c["path"])
            if not m["f0"]:
                continue
            rows.append({"id": c.id, "text": c["t"], "d": c["d"], **m})
        med_f0 = statistics.median(r["f0"]["median"] for r in rows)
        for r in rows:
            r["f0St"] = round(12 * math.log2(r["f0"]["median"] / med_f0), 2)
            r["f0hiSt"] = round(12 * math.log2(r["f0"]["p90"] / med_f0), 2)
            r["rangeSt"] = round(12 * math.log2(r["f0"]["p90"] / r["f0"]["p10"]), 2)
        z = lambda k: (lambda v: (statistics.mean(v), statistics.pstdev(v) or 1.0))([r[k] for r in rows])
        stats = {k: z(k) for k in ("lufs", "alpha", "f0St", "active")}
        for r in rows:
            zz = {k: (r[k] - stats[k][0]) / stats[k][1] for k in stats}
            r["effort"] = round((zz["lufs"] + zz["alpha"] + zz["f0St"]) / 3, 3)
            r["projection"] = round(r["effort"] + 0.15 * zz["active"], 3)
        cut = sorted(r["effort"] for r in rows)[int(0.97 * len(rows))]
        for r in rows:
            why = []
            if r["effort"] > cut: why.append("top3pct-effort")
            if r["text"].count("!") >= 2: why.append("exclamations")
            if r["f0St"] > 4: why.append("pitch-high")
            if r["rangeSt"] > 9: why.append("pitch-range")
            if r["peak"] > -3: why.append("peak")
            r["guard"] = why
        ok = sorted((r for r in rows if not r["guard"]), key=lambda r: -r["projection"])
        report[voice] = {"n": len(rows), "medians": {"lufs": statistics.median(r["lufs"] for r in rows), "gated": statistics.median(r["gated"] for r in rows),
                                                       "alpha": statistics.median(r["alpha"] for r in rows), "f0": med_f0},
                         "guarded": sum(1 for r in rows if r["guard"]), "shortlist": ok[: a.top], "all": rows}
        print(voice, "medians", report[voice]["medians"], "guarded", report[voice]["guarded"])
        for r in ok[: a.top]:
            print(f"  {r['id']} {r['d']:4.1f}s proj{r['projection']:+.2f} lufs{r['lufs']:6.1f} a{r['alpha']:5.1f} f0{r['f0St']:+.1f}st rng{r['rangeSt']:4.1f} act{r['active']:.2f} | {r['text']}")
    Path(a.out).write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
