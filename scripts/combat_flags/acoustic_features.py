"""Per-clip acoustic features for the combat / shouted-delivery flag (research only; nothing live is touched).

    PYTHONUTF8=1 vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/combat_flags/acoustic_features.py \
        [--paths E:/.../combat-flags/paths.jsonl] [--out E:/.../combat-flags] [--workers 4] [--limit N] [--keys a/1,b/2] [--merge-only]

Input is paths.jsonl from acoustic_paths.py (one row per key 'voice/stringId' with the audio path to use and a transcript).
Output: <out>/acoustic-features.jsonl and .csv (one row per key), built from resumable shards in <out>/shards/ (a key that is
already in a shard is skipped, so a re-run continues).  Praat comes from <out>/pylibs (praat-parselmouth, pyloudnorm).
Feature definitions are in <out>/STATUS.md and in the comments below.

Signal path: native-rate mono (channel mean) is kept for peak and the >8 kHz native band; a 24 kHz copy (scipy resample_poly,
only when the native rate differs) feeds everything else.  Frames: 25 ms window / 10 ms hop for levels, 32 ms Hann / 10 ms hop,
1024-point FFT for spectra.  ACTIVE frames = 25 ms frames whose RMS is within 30 dB of the loudest 400 ms window.
"""
from __future__ import annotations

import argparse
import csv
import ctypes
import json
import math
import os
import re
import sys
import time
from pathlib import Path

OUT_DEFAULT = Path(r"E:\CyberpunkConvai-offload\work\combat-flags")
for _p in (OUT_DEFAULT / "pylibs",):
    if str(_p) not in sys.path:
        sys.path.append(str(_p))             # appended: the venv's numpy/scipy must win over anything in pylibs

SR = 24000
WIN, HOP = 600, 240                          # 25 ms / 10 ms at 24 kHz
NFFT, SWIN = 1024, 768                       # spectra: 32 ms Hann, 23.4 Hz bins
EPS = 1e-12


def db10(x):
    return 10.0 * math.log10(max(float(x), EPS))


def frames_of(x, size, hop):
    import numpy as np
    if len(x) < size:
        x = np.pad(x, (0, size - len(x)))
    n = 1 + (len(x) - size) // hop
    idx = np.arange(size)[None, :] + hop * np.arange(n)[:, None]
    return x[idx]


class Meter:
    """ITU-R BS.1770 K-weighting filters (pyloudnorm's coefficients) at 24 kHz."""

    def __init__(self):
        import pyloudnorm as pyln
        self.filters = list(pyln.Meter(SR)._filters.values())

    def weight(self, x):
        from scipy.signal import lfilter
        y = x
        for f in self.filters:
            y = lfilter(f.b, f.a, y)
        return y


METER = None


def text_features(text: str, span_s: float, dur_s: float) -> dict:
    words = re.findall(r"[A-Za-z0-9']+", text or "")
    caps = [w for w in re.findall(r"[A-Za-z][A-Za-z']*", text or "") if len(re.sub(r"[^A-Za-z]", "", w)) >= 2 and w == w.upper()]
    return {"n_words": len(words), "n_chars": len(text or ""), "n_exclaim": (text or "").count("!"), "n_question": (text or "").count("?"),
            "n_allcaps_words": len(caps),
            "wps_speech": (len(words) / span_s) if span_s > 0.2 and words else None,
            "wps_total": (len(words) / dur_s) if dur_s > 0.2 and words else None}


def analyse(path: str, text: str) -> dict:
    import numpy as np
    import parselmouth
    import soundfile as sf
    from math import gcd
    from scipy.signal import medfilt, resample_poly

    global METER
    if METER is None:
        METER = Meter()
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    native = data.mean(axis=1).astype(np.float64)
    out: dict = {"native_sr": int(sr), "channels": int(data.shape[1])}
    out["dur_s"] = len(native) / sr
    if len(native) < sr * 0.15:
        out["error"] = "too short"
        return out
    peak = float(np.max(np.abs(native)))
    out["peak_db"] = 20 * math.log10(max(peak, 1e-9))
    if sr != SR:
        g = gcd(int(sr), SR)
        x = resample_poly(native, SR // g, int(sr) // g).astype(np.float64)
    else:
        x = native
    x = x - x.mean()

    # --- active frames -------------------------------------------------------------------------------------------------
    fr = frames_of(x, WIN, HOP)
    p = (fr ** 2).mean(axis=1)
    n_fr = len(p)
    if n_fr >= 40:
        loud400 = np.convolve(p, np.ones(40) / 40, mode="valid").max()
    else:
        loud400 = p.mean()
    thr = 10 ** ((db10(loud400) - 30) / 10)
    active = p >= thr
    if not active.any():
        out["error"] = "no active frames"
        return out
    first, last = int(np.argmax(active)), int(n_fr - 1 - np.argmax(active[::-1]))
    out["active_s"] = float(active.sum() * HOP / SR)
    out["lead_silence_s"] = first * HOP / SR
    out["trail_silence_s"] = max(0.0, (out["dur_s"] - ((last * HOP + WIN) / SR)))
    span_s = ((last * HOP + WIN) / SR) - (first * HOP / SR)
    out["speech_span_s"] = span_s
    out.update(text_features(text, span_s, out["dur_s"]))

    # --- levels ---------------------------------------------------------------------------------------------------------
    rms = math.sqrt(float(p[active].mean()))
    out["rms_active_db"] = 20 * math.log10(max(rms, 1e-9))
    out["crest_db"] = out["peak_db"] - out["rms_active_db"]
    out["rms_all_db"] = 10 * math.log10(max(float((x ** 2).mean()), 1e-18))
    y = METER.weight(x)
    e10 = frames_of(y ** 2, HOP, HOP).mean(axis=1)                       # K-weighted energy per 10 ms block
    n10 = len(e10)
    box = np.convolve(np.pad(e10, (5, 4), mode="edge"), np.ones(10) / 10, mode="valid")[:n10]      # 100 ms short-term
    stl = -0.691 + 10 * np.log10(np.maximum(box, EPS))
    act10 = np.zeros(n10, bool)
    m = min(n10, n_fr)
    act10[:m] = active[:m]
    sel = stl[act10] if act10.any() else stl
    out["stl_p50"], out["stl_p90"], out["stl_p99"] = (float(np.percentile(sel, q)) for q in (50, 90, 99))
    out["stl_push"] = out["stl_p90"] - out["stl_p50"]
    # integrated loudness: 400 ms blocks, 100 ms hop, absolute gate -70 LUFS, relative gate -10 LU
    if n10 >= 40:
        cs = np.concatenate([[0.0], np.cumsum(e10)])
        starts = np.arange(0, n10 - 40 + 1, 10)
        z = (cs[starts + 40] - cs[starts]) / 40
    else:
        z = np.array([e10.mean()])
    lz = -0.691 + 10 * np.log10(np.maximum(z, EPS))
    g1 = z[lz > -70]
    if len(g1):
        rel = -0.691 + 10 * np.log10(g1.mean()) - 10
        g2 = z[lz > rel]
        out["lufs_integrated"] = float(-0.691 + 10 * np.log10(max(float(g2.mean()) if len(g2) else float(g1.mean()), EPS)))
    else:
        out["lufs_integrated"] = None

    # --- spectra (active frames) ----------------------------------------------------------------------------------------
    sf_ = frames_of(x, SWIN, HOP)
    k = min(len(sf_), n_fr)
    amask = active[:k]
    spec_fr = sf_[:k][amask] * np.hanning(SWIN)[None, :]
    if len(spec_fr) == 0:
        spec_fr = sf_[:k] * np.hanning(SWIN)[None, :]
    P = np.abs(np.fft.rfft(spec_fr, NFFT, axis=1)) ** 2
    freqs = np.fft.rfftfreq(NFFT, 1 / SR)
    ltas = P.mean(axis=0)

    def band(lo, hi):
        sel_ = (freqs >= lo) & (freqs < hi)
        return float(ltas[sel_].sum())

    total = band(50, SR / 2) + EPS
    low_total = band(0, 12000) + EPS
    out["alpha_ratio_db"] = db10(band(1000, 5000)) - db10(band(50, 1000))
    l_db = 10 * np.log10(ltas + EPS)
    lo_max = l_db[(freqs >= 0) & (freqs < 2000)].max()
    hi_max = l_db[(freqs >= 2000) & (freqs < 5000)].max()
    out["hammarberg_db"] = float(lo_max - hi_max)
    # tilt: slope (dB per octave) of the long-term average spectrum DENSITY (mean power per bin) in half-octave bands, 100 Hz-5 kHz
    edges = 100 * 2 ** (np.arange(0, 12) / 2.0)
    edges = edges[edges <= 5000.0 * 1.0001]
    cen, bdb = [], []
    for lo, hi in zip(edges[:-1], edges[1:]):
        bsel = (freqs >= lo) & (freqs < hi)
        if bsel.any():
            cen.append(math.sqrt(lo * hi))
            bdb.append(db10(ltas[bsel].mean()))
    out["tilt_db_oct"] = float(np.polyfit(np.log2(cen), bdb, 1)[0])
    sel_ = (freqs >= 50) & (freqs < 12000)
    pw = ltas[sel_]
    out["centroid_hz"] = float((freqs[sel_] * pw).sum() / (pw.sum() + EPS))
    cum = np.cumsum(pw)
    out["rolloff85_hz"] = float(freqs[sel_][int(np.searchsorted(cum, 0.85 * cum[-1]))])
    out["hb4_ratio"] = band(4000, 12000) / low_total
    out["hb8_12_ratio"] = band(8000, 12000) / low_total
    fsel = (freqs >= 100) & (freqs < 8000)
    Pf = P[:, fsel] + EPS
    out["flatness"] = float(np.mean(np.exp(np.log(Pf).mean(axis=1)) / Pf.mean(axis=1)))
    if sr >= 32000:                                                       # native high band (> 8 kHz up to Nyquist)
        nat_fr = frames_of(native, int(sr * 0.032), int(sr * 0.010))
        kk = min(len(nat_fr), n_fr)
        am = active[:kk]
        nsel = nat_fr[:kk][am] if am.any() else nat_fr[:kk]
        nP = (np.abs(np.fft.rfft(nsel * np.hanning(nsel.shape[1])[None, :], 2048, axis=1)) ** 2).mean(axis=0)
        nf = np.fft.rfftfreq(2048, 1 / sr)
        tot_n = nP[nf >= 50].sum() + EPS
        out["hb8_native_ratio"] = float(nP[nf >= 8000].sum() / tot_n)
        out["hb4_native_ratio"] = float(nP[nf >= 4000].sum() / tot_n)
        out["hb16_native_ratio"] = float(nP[nf >= 16000].sum() / tot_n) if sr >= 44100 else None
    else:
        out["hb8_native_ratio"] = out["hb4_native_ratio"] = out["hb16_native_ratio"] = None

    # --- pitch and voice quality (Praat) --------------------------------------------------------------------------------
    snd = parselmouth.Sound(x.astype(np.float64), sampling_frequency=SR)
    try:
        pass1 = snd.to_pitch_ac(time_step=0.01, pitch_floor=60, pitch_ceiling=450, octave_jump_cost=0.5, voicing_threshold=0.55)
        f1 = pass1.selected_array["frequency"]
        f1 = f1[f1 > 0]
        if len(f1) >= 5:
            q1, q3 = np.percentile(f1, [25, 75])
            floor, ceil = max(50.0, 0.75 * q1), min(800.0, max(300.0, 2.5 * q3))   # de Looze & Hirst; the 300 Hz minimum keeps shouts from folding
        else:
            floor, ceil = 60.0, 500.0
        out["pitch_floor"], out["pitch_ceiling"] = float(floor), float(ceil)
        pitch = snd.to_pitch_ac(time_step=0.01, pitch_floor=floor, pitch_ceiling=ceil, octave_jump_cost=0.5, voicing_threshold=0.45,
                                silence_threshold=0.03, very_accurate=False)
        f0 = pitch.selected_array["frequency"].copy()
        t0 = pitch.xs()
        v = f0 > 0
        out["n_pitch_frames"] = int(len(f0))
        out["voiced_frac"] = float(v.mean())
        ai = np.clip((t0 * SR / HOP).astype(int), 0, n_fr - 1)
        out["voiced_frac_active"] = float((v & active[ai]).sum() / max(1, active[ai].sum()))
        fixed = 0
        if v.sum() >= 5:
            st = 12 * np.log2(f0[v] / 100.0)
            ref = medfilt(st, 9)
            d = st - ref
            up, dn = (np.abs(d - 12) < 2.0), (np.abs(d + 12) < 2.0)
            st = np.where(up, st - 12, np.where(dn, st + 12, st))
            fixed = int(up.sum() + dn.sum())
            keep = np.abs(st - ref) < 9.0
            tv = t0[v][keep]
            stk = st[keep]
            f0v = 100.0 * 2 ** (stk / 12)
        else:
            tv, stk, f0v = np.array([]), np.array([]), np.array([])
        out["n_octave_fixed"] = fixed
        out["n_f0_frames"] = int(len(f0v))
        if len(f0v) >= 5:
            out["f0_mean"] = float(f0v.mean())
            out["f0_median"] = float(np.median(f0v))
            out["f0_p10"], out["f0_p90"] = (float(np.percentile(f0v, q)) for q in (10, 90))
            out["f0_range_st"] = float(np.percentile(stk, 95) - np.percentile(stk, 5))
            out["f0_p10_p90_st"] = float(np.percentile(stk, 90) - np.percentile(stk, 10))
            out["f0_std_st"] = float(stk.std())
            out["f0_max"] = float(f0v.max())
            out["f0_slope_st_s"] = float(np.polyfit(tv, stk, 1)[0]) if len(tv) > 3 and np.ptp(tv) > 0.2 else None
            # H1-H2 on up to 120 voiced frames (hann 32 ms, 4096-pt FFT, peak picking around f0 and 2 f0)
            pick = np.linspace(0, len(f0v) - 1, min(120, len(f0v))).astype(int)
            half = SWIN // 2
            xp = np.pad(x, (half, half))
            fidx = (tv[pick] * SR).astype(int)[:, None] + np.arange(SWIN)[None, :]
            seg = xp[np.clip(fidx, 0, len(xp) - 1)] * np.hanning(SWIN)[None, :]
            S = np.abs(np.fft.rfft(seg, 8192, axis=1))
            ff = np.fft.rfftfreq(8192, 1 / SR)
            h1 = np.array([S[i][(ff > 0.9 * f0v[j]) & (ff < 1.1 * f0v[j])].max() for i, j in enumerate(pick)])
            h2 = np.array([S[i][(ff > 1.85 * f0v[j]) & (ff < 2.15 * f0v[j])].max() for i, j in enumerate(pick)])
            out["h1h2_db"] = float(np.median(20 * np.log10((h1 + 1e-12) / (h2 + 1e-12))))
        # harmonicity
        try:
            hnr = snd.to_harmonicity_cc(time_step=0.01, minimum_pitch=floor, silence_threshold=0.1, periods_per_window=4.5)
            hv = hnr.values[0]
            hv = hv[hv > -200]
            if len(hv) >= 3:
                out["hnr_mean_db"] = float(hv.mean())
                out["hnr_median_db"] = float(np.median(hv))
        except Exception:
            pass
        # jitter / shimmer (local)
        try:
            from parselmouth.praat import call
            pp = call(snd, "To PointProcess (periodic, cc)", floor, ceil)
            out["n_pulses"] = int(call(pp, "Get number of points"))
            if out["n_pulses"] >= 6:
                out["jitter_local"] = float(call(pp, "Get jitter (local)", 0, 0, 0.0001, 0.02, 1.3))
                out["shimmer_local"] = float(call([snd, pp], "Get shimmer (local)", 0, 0, 0.0001, 0.02, 1.3, 1.6))
        except Exception:
            pass
    except Exception as error:
        out["pitch_error"] = f"{type(error).__name__}: {str(error)[:100]}"
    return out


# ---- driver -------------------------------------------------------------------------------------------------------------


def _worker(task):
    shard_path, rows = task
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    result = []
    for r in rows:
        started = time.time()
        try:
            feats = analyse(r["audio_path"], r.get("text", ""))
        except Exception as error:
            feats = {"error": f"{type(error).__name__}: {str(error)[:120]}"}
        feats = {k: (None if isinstance(v, float) and not math.isfinite(v) else v) for k, v in feats.items()}
        result.append({"key": r["key"], "voice": r["voice"], "string_id": r["string_id"], "audio_path": r["audio_path"],
                       "sources": r["sources"], "elapsed_s": round(time.time() - started, 3), **feats})
    tmp = Path(str(shard_path) + ".part")
    tmp.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in result) + "\n", encoding="utf-8")
    tmp.replace(shard_path)
    return len(result)


def _init():
    if sys.platform == "win32":
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)   # below normal
    os.environ["OMP_NUM_THREADS"] = "1"
    os.environ["MKL_NUM_THREADS"] = "1"
    if str(OUT_DEFAULT / "pylibs") not in sys.path:
        sys.path.append(str(OUT_DEFAULT / "pylibs"))


def merge(out: Path):
    shards = sorted((out / "shards").glob("shard-*.jsonl"))
    rows = {}
    for s in shards:
        for line in s.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                rows[r["key"]] = r
    keys = sorted(rows)
    cols: list[str] = []
    for k in keys:
        for c in rows[k]:
            if c not in cols:
                cols.append(c)
    with open(out / "acoustic-features.jsonl.part", "w", encoding="utf-8") as h:
        for k in keys:
            h.write(json.dumps(rows[k], ensure_ascii=False) + "\n")
    (out / "acoustic-features.jsonl.part").replace(out / "acoustic-features.jsonl")
    with open(out / "acoustic-features.csv.part", "w", encoding="utf-8", newline="") as h:
        w = csv.writer(h)
        w.writerow(cols)
        for k in keys:
            r = rows[k]
            w.writerow([("|".join(r[c]) if isinstance(r.get(c), list) else ("" if r.get(c) is None else r.get(c))) for c in cols])
    (out / "acoustic-features.csv.part").replace(out / "acoustic-features.csv")
    print(f"merged {len(keys)} rows from {len(shards)} shards; {sum(1 for r in rows.values() if r.get('error'))} with an error")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--paths", type=Path, default=OUT_DEFAULT / "paths.jsonl")
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--chunk", type=int, default=100)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--keys")
    ap.add_argument("--merge-only", action="store_true")
    args = ap.parse_args()
    out = args.out
    (out / "shards").mkdir(parents=True, exist_ok=True)
    if args.merge_only:
        merge(out)
        return
    done = set()
    top = 0
    for s in (out / "shards").glob("shard-*.jsonl"):
        top = max(top, int(s.stem.split("-")[1]) + 1)
        done.update(json.loads(l)["key"] for l in s.read_text(encoding="utf-8").splitlines() if l.strip())
    rows = []
    wanted = set(args.keys.split(",")) if args.keys else None
    with open(args.paths, encoding="utf-8") as h:
        for line in h:
            r = json.loads(line)
            if r.get("audio_path") and r["key"] not in done and (wanted is None or r["key"] in wanted):
                rows.append({k: r.get(k) for k in ("key", "voice", "string_id", "audio_path", "sources", "text")})
    if args.limit:
        rows = rows[: args.limit]
    print(f"{len(done)} done, {len(rows)} to do", flush=True)
    tasks = [(out / "shards" / f"shard-{top + i:05d}.jsonl", rows[i * args.chunk:(i + 1) * args.chunk]) for i in range((len(rows) + args.chunk - 1) // args.chunk)]
    started, count = time.time(), 0
    if tasks:
        import multiprocessing as mp
        with mp.get_context("spawn").Pool(args.workers, initializer=_init) as pool:
            for n in pool.imap_unordered(_worker, tasks):
                count += n
                print(f"  {count}/{len(rows)}  {count / (time.time() - started):.1f} clips/s", flush=True)
    merge(out)


if __name__ == "__main__":
    main()
