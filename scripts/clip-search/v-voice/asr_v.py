"""ASR check of V candidates against their subtitle text: Whisper small.en on CPU (transformers + torch), word-level similarity.
Run on the shortlist only (a few seconds per clip).  Plays nothing, CPU only (CUDA is never touched).

Usage: python scripts/clip-search/v-voice/asr_v.py EXTRACT_DIR [--top N | --ids ID ...] [--model DIR]
Candidates come from EXTRACT_DIR/analysis.json (eligible clips, best score first; --top N, default 40) or from --ids.  Writes
EXTRACT_DIR/asr.json ({stringId: {"asr", "similarity"}}) and prints one line per clip.  Similarity = difflib ratio between the
normalised word lists (lower case, letters and apostrophes only); the acceptance bar for a reference clip is >= 0.95.
The model defaults to the whisper-small.en snapshot under vendor/voice-models/hub in the main checkout (offline).
Optional environment variable V_ASR_PATHS (os.pathsep separated) appends extra directories to sys.path before the imports, for a
machine where transformers / torch live in different environments.  If transformers or torch cannot be imported the script says so
and exits with status 2 (no ASR available).
"""
import argparse, difflib, glob, json, os, sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
for extra in filter(None, os.environ.get("V_ASR_PATHS", "").split(os.pathsep)):
    sys.path.append(extra)
os.environ.setdefault("HF_HUB_OFFLINE", "1")
sys.path.insert(0, str(Path(__file__).resolve().parent))
MAIN = Path(r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod")

try:
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor
except Exception as ex:                                                   # no ASR stack on this machine
    print("ASR UNAVAILABLE:", type(ex).__name__, ex)
    sys.exit(2)
import numpy as np
from scipy.signal import resample_poly
from vcommon import load_mono24, trim, norm

torch.set_num_threads(4)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("extract_dir")
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--ids", nargs="*")
    ap.add_argument("--model")
    ap.add_argument("--redo", action="store_true", help="re-check clips already in asr.json")
    a = ap.parse_args()
    d = Path(a.extract_dir)
    man = {m["stringId"]: m for m in json.loads((d / "extract-manifest.json").read_text("utf-8"))}
    if a.ids:
        ids = a.ids
    else:
        an = json.loads((d / "analysis.json").read_text("utf-8"))["clips"]
        ids = [x["stringId"] for x in sorted([x for x in an if not x["reject"]], key=lambda x: -x["score"])][: a.top]
    snap = a.model or glob.glob(str(MAIN / "vendor/voice-models/hub/models--openai--whisper-small.en/snapshots/*"))[0]
    proc = WhisperProcessor.from_pretrained(snap)
    model = WhisperForConditionalGeneration.from_pretrained(snap).eval()
    out_path = d / "asr.json"
    out = json.loads(out_path.read_text("utf-8")) if out_path.exists() else {}
    for sid in ids:
        if sid in out and not a.redo:
            continue                                                  # resume: already checked
        m24, _, _, _ = load_mono24(man[sid]["wavPath"])
        w16 = resample_poly(trim(m24), 2, 3).astype(np.float32)
        feats = proc(w16, sampling_rate=16000, return_tensors="pt").input_features
        with torch.inference_mode():
            tokens = model.generate(feats, max_new_tokens=80, num_beams=1, do_sample=False)
        text = proc.batch_decode(tokens, skip_special_tokens=True)[0].strip()
        sim = difflib.SequenceMatcher(None, norm(man[sid]["transcript"]), norm(text)).ratio()
        out[sid] = {"asr": text, "similarity": round(sim, 3)}
        print(f"{sid} {sim:.2f} | sub: {man[sid]['transcript']}\n{'':24s}| asr: {text}", flush=True)
        out_path.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")   # saved after every clip


if __name__ == "__main__":
    main()
