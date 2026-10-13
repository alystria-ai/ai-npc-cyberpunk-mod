"""Objective checks of the extracted V candidates (CPU only, plays nothing): channel choice, duration, gated loudness, peak/clipping,
silence ratio, noise floor and speech-to-floor ratio, hum, band limit / telephone features (scripts/phone_detect/spectral.py, on the
native-rate audio, judged against the median of the same voice), pitch statistics (median F0 also confirms the gender suffix), speech rate.
Writes <EXTRACT_DIR>/analysis.json and prints the eligible shortlist best-first.

Usage: python scripts/clip-search/v-voice/analyze_v.py EXTRACT_DIR [--top N]
Eligible = 2.5-6.5 s after trimming, peak <= -3 dBFS, no clipped sample, >= 7 words, speech rate 2.0-4.2 words/s, silence ratio <= 0.30,
speech-to-floor >= 38 dB, not band-limited (floor_hz >= 9000 and high bands within 8 dB of the median clip), no hum tone > 12 dB.
Rank score (higher is better): small distance of the gated loudness from the voice's median (calm lines sit at the median), a narrow
pitch spread (flat delivery is not what we want, a shout is worse), low noise floor, few pauses.
"""
import argparse, json, math, statistics, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "phone_detect"))
from vcommon import RATE, load_mono24, trim, db, f0_stats
from spectral import features as spectral_features

sys.stdout.reconfigure(encoding="utf-8")


def metrics(path):
    m24, native, sr, info = load_mono24(path)
    t = trim(m24)
    peak = float(np.abs(t).max())
    clipped = int((np.abs(native) >= 0.9995).sum())
    fr = int(RATE * 0.02); n = len(t) // fr
    e = np.sqrt((t[: n * fr].reshape(n, fr) ** 2).mean(axis=1))
    el = 20 * np.log10(e + 1e-9)
    speech_ref = float(np.percentile(el, 95))
    silent = el < speech_ref - 35
    f50 = int(RATE * 0.05); c = len(t) // f50
    en = (t[: c * f50].reshape(c, f50) ** 2).mean(axis=1)
    gated = float(10 * math.log10(en[en >= en.max() * 10 ** (-2.5)].mean()))
    live = np.where(el > -90)[0]                     # frames that are not digital silence (game dialogue is gated to exact zeros between lines)
    floor = float(np.percentile(el[live], 10)) if len(live) >= 5 else -90.0
    quiet = live[np.argsort(el[live])[: max(3, int(0.15 * len(live)))]] if len(live) >= 5 else []
    seg = np.concatenate([t[i * fr:(i + 1) * fr] for i in quiet]) if len(quiet) else np.zeros(0, dtype=np.float32)
    hum = None
    if len(seg) >= 2048 and floor > -70:
        sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2; fq = np.fft.rfftfreq(len(seg), 1 / RATE)
        band = (fq > 30) & (fq < 400); ref = np.median(sp[(fq > 400) & (fq < 2000)]) + 1e-20
        i = np.argmax(sp * band)
        hum = {"peakHz": round(float(fq[i]), 1), "overMedianDb": round(float(10 * math.log10(max(sp[i], 1e-20) / ref)), 1)}
    spec = spectral_features(native, sr)
    return {"seconds": round(len(t) / RATE, 3), "channel": info, "peakDbfs": round(db(peak), 2), "clipped": clipped, "gatedRmsDb": round(gated, 2),
            "silenceRatio": round(float(silent.mean()), 3), "noiseFloorDb": round(floor, 1), "speechToFloorDb": round(speech_ref - floor, 1),
            "hum": hum, "f0": f0_stats(t),
            "spectral": {k: spec.get(k) for k in ("cutoff_hz", "floor_hz", "f99", "hi_rel", "vhi_rel", "lo_rel", "edge_drop")} if spec else None}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("extract_dir")
    ap.add_argument("--top", type=int, default=60)
    a = ap.parse_args()
    d = Path(a.extract_dir)
    man = json.loads((d / "extract-manifest.json").read_text("utf-8"))
    rows = []
    for r in man:
        try:
            met = metrics(r["wavPath"])
        except Exception as ex:                                  # a broken decode is simply not a candidate
            print("skip", r["stringId"], ex); continue
        met.update({"stringId": r["stringId"], "stem": r["stem"], "scene": r["scene"], "text": r["transcript"]})
        words = len(r["transcript"].split())
        met["words"] = words
        met["wordsPerSec"] = round(words / met["seconds"], 2)
        rows.append(met)
    med = lambda k, sub=None: statistics.median([(x[k] if sub is None else x[k][sub]) for x in rows if x[k] is not None and (sub is None or x[k].get(sub) is not None)])
    ref = {"gatedRmsDb": med("gatedRmsDb"), "hi_rel": med("spectral", "hi_rel"), "vhi_rel": med("spectral", "vhi_rel"), "lo_rel": med("spectral", "lo_rel"),
           "f0Median": med("f0", "median")}
    for x in rows:
        s = x["spectral"] or {}
        reasons = []
        if not 2.5 <= x["seconds"] <= 6.5: reasons.append("duration")
        if x["peakDbfs"] > -3.0: reasons.append("peak")
        if x["clipped"]: reasons.append("clipped")
        if x["words"] < 7 or not 2.0 <= x["wordsPerSec"] <= 4.2: reasons.append("rate")
        if x["silenceRatio"] > 0.30: reasons.append("silence")
        if x["speechToFloorDb"] < 38: reasons.append("noise")
        if not s or s["floor_hz"] < 9000 or s["hi_rel"] - ref["hi_rel"] < -8 or s["vhi_rel"] - ref["vhi_rel"] < -8 or s["lo_rel"] - ref["lo_rel"] < -8:
            reasons.append("bandlimited")
        if x["hum"] and x["hum"]["overMedianDb"] > 12: reasons.append("hum")
        if not x["f0"]: reasons.append("nopitch")
        x["reject"] = reasons
        if not reasons:
            spread = (x["f0"]["p90"] - x["f0"]["p10"]) / x["f0"]["median"]
            x["score"] = round(-abs(x["gatedRmsDb"] - ref["gatedRmsDb"]) - 3 * spread - 0.05 * max(0.0, x["noiseFloorDb"] + 60) - 8 * x["silenceRatio"], 3)
    (d / "analysis.json").write_text(json.dumps({"reference": ref, "clips": rows}, indent=1, ensure_ascii=False), encoding="utf-8")
    ok = sorted([x for x in rows if not x["reject"]], key=lambda x: -x["score"])
    print("reference (voice medians):", ref)
    print("analysed", len(rows), "eligible", len(ok), "F0 median of all clips", ref["f0Median"], "Hz")
    from collections import Counter
    print("rejections:", Counter(r for x in rows for r in x["reject"]).most_common())
    for x in ok[: a.top]:
        s = x["spectral"]
        print(f"{x['stringId']} {x['scene']:7s} {x['seconds']:5.2f}s sc{x['score']:7.2f} L{x['gatedRmsDb']:6.1f} pk{x['peakDbfs']:6.1f} f0 {x['f0']['median']:5.0f}"
              f" ({x['f0']['p10']:.0f}-{x['f0']['p90']:.0f}) sil{x['silenceRatio']:.2f} fl{x['noiseFloorDb']:6.1f} ch:{x['channel']['used']} bw{s['floor_hz']:.0f} | {x['text']}")


if __name__ == "__main__":
    main()
