"""Put V's extracted lines into the reference picker's pool format, so the project's automatic picker (scripts/clip-search/search.py, the
"Auto-best" search that scripts/reference-picker/autobest.mjs reads) can choose V's reference sets like it did for the companions.

Usage (vendor/reference-voicestudio/.venv python, CPU; CLIP_SEARCH_ROOT = the main checkout, CLIP_SEARCH_WORK = a work folder):
    python scripts/clip-search/v-voice/build_v_pool.py POOL_DIR INDEX_OUT --male EXTRACT_DIR --female EXTRACT_DIR
        [--live-male WAV --live-male-ids ID ...] [--live-female WAV --live-female-ids ID ...]

EXTRACT_DIR is the output of extract_v.py.  For each voice (keys v-male, v-female) this writes
  POOL_DIR/<voice>/<stringId>.wav   the line trimmed (-45 dBFS, 80 ms margin), 24 kHz mono 16-bit, nothing else done to it
  POOL_DIR/<voice>/metrics.json     per-clip measurements (cached; delete to recompute)
and INDEX_OUT, a pool index with the picker's clip fields (scripts/reference-picker/build-index.py): id, d, t, ty (ECAPA typicality
percentile), lv (gated loudness), p (absolute path), fx (effect/quality reasons) and cb (combat/shouted delivery, from the game's scene
index through scripts/combat_flags/source_signal.py).  The live references (today's clips) are recorded under "live" so the search scores
them as the "today" baseline, and their source lines are kept out of the held-out set (as "proposed").

Quality exclusions (fx), on top of the picker's own band-limited/comb/tone/reverb rules (scripts/phone_detect/effects_flag.py):
  band-limited  the extractor's rule (floor/high bands more than 8 dB under the voice's median, the phone detector's features)
  dull          99% of the energy below 3.5 kHz at the 24 kHz rate (a muffled recording)
  noisy         pauses (silence ratio 0.10 or more) whose quietest frames are above -50 dBFS
  hot           peak over -2 dBFS or a clipped native sample
  comb / tone / reverb   effects_flag.py thresholds
CPU only; plays nothing; reads only the extracted files, the scene index and the ECAPA model.
"""
import argparse, importlib.util, json, os, statistics, sys
from pathlib import Path
import numpy as np, soundfile as sf

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(REPO / "scripts/phone_detect")); sys.path.insert(0, str(REPO / "scripts/combat_flags")); sys.path.insert(0, str(REPO / "scripts/clip-search"))
from vcommon import RATE, load_mono24, trim
import analyze_v
from effects import features as effect_features
from source_signal import load_by_sid, classify_lines

sys.stdout.reconfigure(encoding="utf-8")
spec = importlib.util.spec_from_file_location("bidx", REPO / "scripts/reference-picker/build-index.py")
bidx = importlib.util.module_from_spec(spec); spec.loader.exec_module(bidx)


def measure(extract_dir, pool_dir, by_sid, fights):
    cache_file = pool_dir / "metrics.json"
    cache = json.loads(cache_file.read_text("utf-8")) if cache_file.is_file() else {}
    man = json.loads((Path(extract_dir) / "extract-manifest.json").read_text("utf-8"))
    out = []
    for i, m in enumerate(man):
        sid = m["stringId"]
        wav = pool_dir / f"{sid}.wav"
        if sid in cache and wav.is_file():
            out.append(cache[sid]); continue
        try:
            m24, native, sr, info = load_mono24(m["wavPath"])
            t = trim(m24)
            sf.write(wav, t, RATE, subtype="PCM_16")
            met = analyze_v.metrics(m["wavPath"])
            fx = effect_features(t, RATE) or {}
            verdict = classify_lines(by_sid.get(sid, []), fights)
            expr = sorted({(r.get("vo_expression") or "").replace("Vo_Expression_", "") for r in by_sid.get(sid, [])})
            sp = np.abs(np.fft.rfft(t * np.hanning(len(t)))) ** 2
            fq = np.fft.rfftfreq(len(t), 1 / RATE)
            cum = np.cumsum(sp) / sp.sum()
            met.update({"stringId": sid, "text": m["transcript"], "stem": m["stem"], "scene": m["scene"], "path": str(wav),
                        "d": round(len(t) / RATE, 3), "lv": bidx.gated_rms_db(wav), "f99_24k": round(float(fq[np.searchsorted(cum, 0.99)]), 0),
                        "fx": {k: fx.get(k) for k in ("comb_best", "tone_db", "tail_ms", "am_peak", "f0_std_st")},
                        "tier": verdict["tier"], "tierWhy": verdict["reasons"], "expressions": expr, "nOccurrences": len(by_sid.get(sid, []))})
            out.append(met)
        except Exception as ex:
            print("skip", sid, ex)
        if i % 100 == 0:
            print(f"  measured {i}/{len(man)}", flush=True)
            cache_file.write_text(json.dumps({r["stringId"]: r for r in out}), encoding="utf-8")
    cache_file.write_text(json.dumps({r["stringId"]: r for r in out}), encoding="utf-8")
    return out


def reasons(x, ref):
    r = []
    s = x["spectral"] or {}
    if not s or s["floor_hz"] < 9000 or s["hi_rel"] - ref["hi_rel"] < -8 or s["vhi_rel"] - ref["vhi_rel"] < -8 or s["lo_rel"] - ref["lo_rel"] < -8:
        r.append("band-limited")
    if x["f99_24k"] < 3500:
        r.append("dull")
    # A noise floor is only visible in pauses: a clip without pauses has speech in its quietest frames, which is not noise.
    # (analyze_v's hum test is not used: it fires on the low harmonics of speech tails in 56% of the clips; the effects "tone" rule covers hum.)
    if x["noiseFloorDb"] > -50 and x["silenceRatio"] >= 0.10:
        r.append("noisy")
    if x["peakDbfs"] > -2.0 or x["clipped"]:
        r.append("hot")
    fx = x["fx"]
    if x["d"] >= 2.0 and (fx.get("comb_best") or 0) >= 5.0: r.append("comb")
    if x["d"] >= 2.0 and (fx.get("tone_db") or 0) >= 15.0: r.append("tone")
    tail = fx.get("tail_ms")
    if x["d"] >= 2.5 and tail is not None and tail == tail and tail >= 590.0: r.append("reverb")
    return r


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pool_dir"); ap.add_argument("index_out")
    ap.add_argument("--male"); ap.add_argument("--female")
    ap.add_argument("--live-male"); ap.add_argument("--live-male-ids", nargs="*", default=[])
    ap.add_argument("--live-female"); ap.add_argument("--live-female-ids", nargs="*", default=[])
    ap.add_argument("--device", default="cpu")
    a = ap.parse_args()
    import common, score
    pool = Path(a.pool_dir)
    by_sid, fights = load_by_sid()
    scorer = score.Scorer(a.device, with_pls=False)
    voices = {}
    for key, gender, edir, live, live_ids in (("v-male", "male", a.male, a.live_male, a.live_male_ids), ("v-female", "female", a.female, a.live_female, a.live_female_ids)):
        if not edir:
            continue
        vdir = pool / key; vdir.mkdir(parents=True, exist_ok=True)
        rows = measure(edir, vdir, by_sid, fights)
        med = lambda k, sub=None: statistics.median([(x[k] if sub is None else x[k][sub]) for x in rows if x[k] is not None and (sub is None or x[k].get(sub) is not None)])
        ref = {"hi_rel": med("spectral", "hi_rel"), "vhi_rel": med("spectral", "vhi_rel"), "lo_rel": med("spectral", "lo_rel")}
        emb_file = common.WORK / "emb" / f"{key}.json"
        scorer.load_embeddings(emb_file)
        embs = {}
        for i, x in enumerate(rows):
            embs[x["stringId"]] = scorer.embed_cached(x["path"])
            if i % 200 == 0:
                print(f"  embedded {i}/{len(rows)}", flush=True)
        scorer.save_embeddings(emb_file)
        import torch
        stack = torch.stack(list(embs.values())); centroid = torch.nn.functional.normalize(stack.mean(0), dim=0)
        vals = {sid: float(e @ centroid) for sid, e in embs.items()}; ranked = sorted(vals.values())
        clips = []
        for x in rows:
            sid = x["stringId"]
            clip = {"id": f"{key}/{sid}", "d": x["d"], "t": x["text"], "ty": round(100 * sum(1 for o in ranked if o < vals[sid]) / max(1, len(ranked) - 1), 1),
                    "g": None, "k": None, "s": "v-pool", "p": x["path"], "lv": x["lv"], "src": "game archive", "ph": False}
            why = reasons(x, ref)
            if why:
                clip["fx"] = why
            if x["tier"] in ("strong", "moderate") or any(e not in ("Spoken", "") for e in x["expressions"]):
                clip["cb"] = {"s": x["tier"], "w": (x["tierWhy"] or []) + [f"expression {e}" for e in x["expressions"] if e not in ("Spoken", "")]}
            clips.append(clip)
        levels = sorted(c["lv"] for c in clips if c["lv"] is not None)
        entry = {"clips": clips, "loudMedian": levels[len(levels) // 2] if levels else None, "lines": [], "live": {}, "proposed": {},
                 "embedded": len(embs), "typicalityRanked": True}
        if live:
            lp = Path(live)
            entry["live"]["pocket"] = {"reference": str(lp), "sha256": "", "transcript": "", "d": round(sf.info(lp).duration, 3), "exists": True,
                                       "lv": bidx.gated_rms_db(lp)}
            if live_ids:
                entry["proposed"]["pocket"] = {"clips": [f"{key}/{i}" for i in live_ids], "seconds": round(sf.info(lp).duration, 3)}
        voices[key] = entry
        print(key, "clips", len(clips), "fx", sum(1 for c in clips if c.get("fx")), "cb", sum(1 for c in clips if c.get("cb")),
              "usable", sum(1 for c in clips if not c.get("fx") and not c.get("cb") and 1.5 <= c["d"] <= 9))
    index = {"version": 1, "built": "v-voice", "dataRoot": str(pool), "lineIds": [], "voices": voices, "sources": {"note": "V pool built by build_v_pool.py"}}
    Path(a.index_out).write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("wrote", a.index_out)


if __name__ == "__main__":
    main()
