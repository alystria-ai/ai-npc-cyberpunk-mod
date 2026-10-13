"""Compare V reference sets objectively and write the files to listen to (CPU only, plays nothing).

    CLIP_SEARCH_ROOT=<main checkout> CLIP_SEARCH_WORK=<work folder> python scripts/clip-search/v-voice/compare_v.py INDEX SEARCH_OUT OUT_DIR
        [--voices v-male,v-female] [--threads 2] [--sets SETS.json] [--seeds 1042 7]

Takes the search run (run_search.py; SEARCH_OUT/pocket-v2/<voice>/result.json) and compares, with the project's own measures:
  old    today's reference clips (the "live" baseline, assets/v-voice/v-<gender>.wav as first shipped)
  auto   the search's pick ("best")
  short  the search's best set of at most 11.5 s with two or more clips (cloud voices cut their reference to about 8.5 s)
  alt    the best set that shares no clip with auto or old (another voice colour, as a check)
  (or any sets named in SETS.json: {"voice": {"name": [clip ids or "live:pocket"]}})
Scores (the search's, on the same 6 held-out real V lines x seeds, never reference clips): ECAPA speaker similarity to the held-out V centroid
(primary), PLS (secondary: fd_mfcc, mcd, ltas_hi mapped with the October 5 anchors).  On the fixed typed test sentences: ECAPA to the same
centroid, ASR similarity (Whisper small.en, CPU, when transformers is importable) and artifact measures (comb, tone, amplitude modulation,
99% energy frequency) next to the same measures of the real held-out V lines.
Writes OUT_DIR/<voice>/ref_<set>.wav (the reference), OUT_DIR/<voice>/test<k>_<set>.wav (the rendered sentences), OUT_DIR/<voice>/real_<n>.wav
(held-out real V lines for comparison) and OUT_DIR/<voice>/comparison.json.
"""
import argparse, difflib, json, shutil, statistics, sys
from pathlib import Path
import numpy as np, soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parents[1] / "phone_detect"))
import common, search, render, score  # noqa: E402
from effects import features as effect_features  # noqa: E402
from vcommon import norm  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
TEST_SENTENCES = [
    "Hey, got a minute? I need to talk to you about something.",
    "Okay, I'm in. Let's see what's behind that door.",
    "I don't know, something about this whole thing feels off to me.",
    "Thanks for watching my back out there. I owe you one.",
]
SHORT_MAX = 11.5


def artifact_metrics(path):
    d, sr = sf.read(path, dtype="float32")
    if d.ndim > 1:
        d = d.mean(1)
    fx = effect_features(d, sr) or {}
    fq = np.fft.rfftfreq(len(d), 1 / sr)
    sp = np.abs(np.fft.rfft(d * np.hanning(len(d)))) ** 2
    cum = np.cumsum(sp) / sp.sum()
    hf = 10 * np.log10(sp[fq >= 4000].sum() / sp.sum() + 1e-12)
    return {"comb": fx.get("comb_best"), "tone": fx.get("tone_db"), "am": fx.get("am_peak"), "f99": float(fq[np.searchsorted(cum, 0.99)]), "hf_db": float(hf)}


class Asr:
    def __init__(self):
        self.ok = False
        try:
            import glob, os, torch
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            from transformers import WhisperForConditionalGeneration, WhisperProcessor
            snap = glob.glob(str(common.ROOT / "vendor/voice-models/hub/models--openai--whisper-small.en/snapshots/*"))[0]
            self.proc = WhisperProcessor.from_pretrained(snap)
            self.model = WhisperForConditionalGeneration.from_pretrained(snap).eval()
            self.torch = torch
            self.ok = True
        except Exception as error:
            print("ASR unavailable:", type(error).__name__, error)

    def similarity(self, wav, text):
        if not self.ok:
            return None, None
        from scipy.signal import resample_poly
        d, sr = sf.read(wav, dtype="float32")
        w16 = resample_poly(d, 2, 3).astype(np.float32) if sr == 24000 else d
        feats = self.proc(w16, sampling_rate=16000, return_tensors="pt").input_features
        with self.torch.inference_mode():
            tokens = self.model.generate(feats, max_new_tokens=80, num_beams=1, do_sample=False)
        heard = self.proc.batch_decode(tokens, skip_special_tokens=True)[0].strip()
        return round(difflib.SequenceMatcher(None, norm(text), norm(heard)).ratio(), 3), heard


def choose_sets(result, old_ids):
    auto = tuple(result["picks"]["best"]["ids"])
    cands = [tuple(c["ids"]) for c in result["candidates"]]
    by = {tuple(c["ids"]): c for c in result["candidates"]}
    sets = {"old": ("live:pocket",), "auto": auto}
    shorts = [s for s in cands if len(s) >= 2 and by[s]["seconds"] <= SHORT_MAX and s != auto]
    if shorts:
        sets["short"] = max(shorts, key=lambda s: by[s]["ecapa"])
    taken = set(auto) | set(old_ids)
    alts = [s for s in cands if len(s) >= 2 and not (set(s) & taken) and by[s]["seconds"] <= 18]
    if alts:
        sets["alt"] = max(alts, key=lambda s: by[s]["ecapa"])
    return sets


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("index"); ap.add_argument("search_out"); ap.add_argument("out")
    ap.add_argument("--voices", default="v-male,v-female")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--sets")
    ap.add_argument("--seeds", type=int, nargs="*", default=[1042, 7])
    ap.add_argument("--export", default=str(common.ROOT / "runtime/pocket-student-v2-s2000-ema-decv2"))
    a = ap.parse_args()
    index = common.load_index(Path(a.index))
    renderer = render.PocketRenderer(a.export, 1, a.threads, tag="pocket-v2")
    scorer = score.Scorer("cpu")
    asr = Asr()
    out_root = Path(a.search_out)
    custom = json.loads(Path(a.sets).read_text("utf-8")) if a.sets else {}
    report = {}
    try:
        for voice in a.voices.split(","):
            result = json.loads((out_root / "pocket-v2" / voice / "result.json").read_text("utf-8"))
            s = search.Search("pocket", renderer, scorer, voice, index, out_root, search.SIZES["pocket"])
            scorer.load_embeddings(common.WORK / "emb" / f"{voice}.json")
            s.targets = scorer.targets(s.pool, s.split)
            old_ids = [c.split("/", 1)[1] for c in (index["voices"][voice]["proposed"].get("pocket", {}).get("clips") or [])]
            sets = {k: tuple(v) for k, v in custom.get(voice, {}).items()} or choose_sets(result, [f"{voice}/{i}" for i in old_ids])
            final, seeds = s.split["final"], tuple(a.seeds)
            s.evaluate(list(sets.values()), final, seeds, keep=True, stage="compare")
            vdir = Path(a.out) / voice; vdir.mkdir(parents=True, exist_ok=True)
            rows = {}
            for name, ids in sets.items():
                row = s.describe(ids, final, seeds)
                row["name"] = name
                ref, _ = s.reference(ids)
                shutil.copy2(ref, vdir / f"ref_{name}.wav")
                row["refPath"] = f"ref_{name}.wav"
                row["clipTexts"] = [s.clip(i)["t"] for i in ids]
                jobs = [{"ref": ref, "transcript": "", "text": t, "seed": 1042, "out": str(vdir / f"test{k + 1}_{name}.wav")} for k, t in enumerate(TEST_SENTENCES)]
                tests = []
                for job, res in zip(jobs, renderer.render(jobs)):
                    if not res["ok"]:
                        tests.append({"error": res["error"]}); continue
                    emb = scorer.embed(job["out"])
                    sim, heard = asr.similarity(job["out"], job["text"])
                    tests.append({"file": Path(job["out"]).name, "ecapa": round(float(emb @ s.targets["centroid"]), 4), "asr": sim, "heard": heard,
                                  "seconds": round(res["seconds"], 2), "art": artifact_metrics(job["out"])})
                row["tests"] = tests
                good = [t for t in tests if "ecapa" in t]
                row["testEcapa"] = round(statistics.mean(t["ecapa"] for t in good), 4) if good else None
                row["testAsr"] = round(statistics.mean(t["asr"] for t in good if t["asr"] is not None), 3) if asr.ok and good else None
                rows[name] = row
                print(voice, name, row["seconds"], "ecapa", row["ecapa"], "pls", row.get("pls"), "test ecapa", row["testEcapa"], "asr", row["testAsr"], flush=True)
            real = []
            for n, cid in enumerate(final):
                src = s.clip(cid)["path"]
                shutil.copy2(src, vdir / f"real_{n + 1}.wav")
                real.append({"file": f"real_{n + 1}.wav", "text": s.clip(cid)["t"], "art": artifact_metrics(src)})
            report[voice] = {"sets": rows, "real": real, "split": {"holdout": len(s.split["holdout"]), "final": s.split["final"]}, "seeds": list(seeds)}
            (vdir / "comparison.json").write_text(json.dumps(report[voice], indent=1, ensure_ascii=False), encoding="utf-8")
    finally:
        renderer.close()
    (Path(a.out) / "comparison.json").write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
