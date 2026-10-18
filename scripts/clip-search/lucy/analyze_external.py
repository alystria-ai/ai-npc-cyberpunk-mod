"""Lucy Kushinada: find candidate speech spans in downloaded web audio (the official Netflix Anime clips, English dub).

Step A of the external-reference flow (docs/NCA_FOLLOWERS_PLAN.md section 7): decode with ffmpeg, Whisper small.en word timestamps, group words
into utterances, then measure every utterance objectively. Nothing is played and nothing is cut here.

Per utterance: start/end, text, median pitch (a woman's voice is above about 160 Hz, David's is not), speech level, the floor level of the
gaps right before and after (a music or effects bed shows up as a floor close to the speech level), the stereo side/mid energy ratio
(dialogue sits in the centre; music and effects are wide), and the fraction of the span's frames that are voiced.

Usage: python -I analyze_external.py <out_json> <name>=<audio file> [<name>=<audio file> ...]
The audio files are downloaded data: they are only ever opened by ffmpeg and soundfile, never executed or imported.
"""
import glob, json, math, os, subprocess, sys, tempfile
sys.stdout.reconfigure(encoding="utf-8")
os.environ["HF_HUB_OFFLINE"] = "1"
import numpy as np, soundfile as sf, torch
import torchaudio.functional as AF

FFMPEG = r"C:\FFmpeg\bin\ffmpeg.exe"
ROOT = r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod"
out_json = sys.argv[1]
items = [a.split("=", 1) for a in sys.argv[2:]]
work = os.path.join(ROOT, "runtime", "voice-references", "external", "lucy", "work")
os.makedirs(work, exist_ok=True)

from transformers import pipeline
snap = glob.glob(ROOT + "/vendor/voice-models/hub/models--openai--whisper-small.en/snapshots/*")[0]
asr = pipeline("automatic-speech-recognition", model=snap, device=-1)

def db(x): return 20 * math.log10(max(float(x), 1e-9))

def frames_rms(x, sr, hop=0.01, win=0.025):
    h, w = int(sr * hop), int(sr * win)
    n = max(0, (len(x) - w) // h + 1)
    idx = np.arange(n)[:, None] * h + np.arange(w)[None, :]
    return np.sqrt((x[idx] ** 2).mean(axis=1) + 1e-12)

def pitch(x, sr, lo=70, hi=400):
    f0 = AF.detect_pitch_frequency(torch.from_numpy(x.astype(np.float32))[None], sr, freq_low=lo, freq_high=hi)[0].numpy()
    return f0

result = {}
for name, path in items:
    wav = os.path.join(work, name + ".wav")
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", path, "-ac", "2", "-ar", "44100", "-c:a", "pcm_f32le", wav], check=True, creationflags=0x08000000)
    data, sr = sf.read(wav, dtype="float32", always_2d=True)
    mid, side = data.mean(axis=1), (data[:, 0] - data[:, 1]) / 2
    mono16 = AF.resample(torch.from_numpy(mid), sr, 16000).numpy()
    out = asr({"raw": mono16, "sampling_rate": 16000}, return_timestamps="word", chunk_length_s=30, stride_length_s=5)
    words = [{"w": c["text"].strip(), "s": c["timestamp"][0], "e": c["timestamp"][1]} for c in out["chunks"] if c["timestamp"][0] is not None]
    # group words into utterances on gaps of 0.4 s or more
    utts, cur = [], []
    for w in words:
        if cur and w["s"] - cur[-1]["e"] >= 0.4: utts.append(cur); cur = []
        cur.append(w)
    if cur: utts.append(cur)
    rm = frames_rms(mid, sr); rs = frames_rms(side, sr)
    f0_all = pitch(mid, sr)
    hopf = len(mid) / len(f0_all)  # samples per pitch frame
    rows = []
    for u in utts:
        s, e = u[0]["s"], u[-1]["e"] or u[-1]["s"] + 0.3
        a, b = int(s * 100), int(e * 100)
        seg = rm[a:b]
        if len(seg) < 5: continue
        level = db(np.percentile(seg, 90))
        def floor(t0, t1):
            i0, i1 = max(0, int(t0 * 100)), min(len(rm), int(t1 * 100))
            return db(np.percentile(rm[i0:i1], 10)) if i1 - i0 >= 5 else None
        pre, post = floor(s - 0.35, s - 0.02), floor(e + 0.02, e + 0.35)
        sideratio = db(np.sqrt((rs[a:b] ** 2).mean())) - db(np.sqrt((rm[a:b] ** 2).mean()))
        fa, fb = int(s * sr / hopf), int(e * sr / hopf)
        f0 = f0_all[fa:fb]
        gate = rm[a:b]
        voiced = f0[(f0 > 75) & (f0 < 395)]
        rows.append({"start": round(s, 2), "end": round(e, 2), "text": " ".join(w["w"] for w in u),
                     "f0Median": round(float(np.median(voiced)), 1) if len(voiced) > 3 else None,
                     "levelDb": round(level, 1), "floorBeforeDb": None if pre is None else round(pre, 1), "floorAfterDb": None if post is None else round(post, 1),
                     "sideToMidDb": round(sideratio, 1)})
    result[name] = {"seconds": round(len(mid) / sr, 2), "utterances": rows, "wav": wav}
    print("====", name, round(len(mid) / sr, 1), "s")
    for r in rows:
        print(f"{r['start']:7.2f}-{r['end']:7.2f} f0 {r['f0Median']} lvl {r['levelDb']} floor {r['floorBeforeDb']}/{r['floorAfterDb']} side-mid {r['sideToMidDb']} | {r['text']}")
json.dump(result, open(out_json, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print("work dir", work)
