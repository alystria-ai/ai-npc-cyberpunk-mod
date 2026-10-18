"""Lucy Kushinada: cut the candidate review clips from the Demucs vocals stem and measure each one (step E of the external flow).

Input: the vocals stem WAV (float32 stereo 44.1 kHz from separate_vocals.py), a list of candidates `label|start|end|what Lucy says`
(start and end are the SPEECH EDGES in seconds, read from the stem's loud regions: 10 ms frames above -48 dB, regions joined across gaps under 0.1 s;
the Netflix English captions are only a lead for the timing, they are NOT the dub's words).  For each candidate it
  1. keeps a pad of up to 0.12 s of room tone on each side only where that pad is quieter than -50 dB;
  2. writes mono 24 kHz 16-bit PCM (the format a reference would have), with 15 ms fades at the two cut ends and nothing else: no EQ, no denoise, no gain;
  3. measures speech level, pause floor (the quietest 120 ms of the clip), SNR, peak, the strongest tonal peak in the pause (music residue shows as a narrow peak),
     the same window in the ORIGINAL mix for comparison, median pitch;
  4. transcribes the cut with Whisper small.en (no chunking) and compares it with the stated words.
Usage: python -I cut_candidates.py <stem.wav> <orig_mix.wav> <out_dir> <candidates.txt>
The WAVs are decoded downloaded data: read as bytes by the standard wave-chunk walker below and by soundfile, never executed.
"""
import glob, json, math, os, re, struct, sys, wave
sys.stdout.reconfigure(encoding="utf-8")
os.environ["HF_HUB_OFFLINE"] = "1"
import numpy as np, soundfile as sf, torch
import torchaudio.functional as AF

stem_path, mix_path, out_dir, cand_path = sys.argv[1:5]
os.makedirs(out_dir, exist_ok=True)
ROOT = r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod"


def db(x): return 20 * math.log10(max(float(x), 1e-9))


def frames(x, sr, hop=0.01, win=0.025):
    h, w = int(sr * hop), int(sr * win)
    n = max(0, (len(x) - w) // h + 1)
    idx = np.arange(n)[:, None] * h + np.arange(w)[None, :]
    return np.sqrt((x[idx] ** 2).mean(axis=1) + 1e-12)


def pause_floor(x, sr, win=0.12):
    """level of the quietest 120 ms window, and its tonal peak (dB above the smoothed spectrum)"""
    w, h = int(win * sr), int(0.02 * sr)
    best, at = 9e9, 0
    for i in range(0, max(1, len(x) - w), h):
        r = float(np.sqrt((x[i:i + w] ** 2).mean() + 1e-12))
        if r < best: best, at = r, i
    seg = x[at:at + w]
    n = 1024
    if len(seg) < n: return db(best), None
    sp = np.abs(np.fft.rfft(seg[:n] * np.hanning(n))) ** 2 + 1e-18
    lg = np.log(sp); sm = np.convolve(lg, np.ones(21) / 21, mode="same")
    return db(best), float((lg - sm)[3:300].max()) * 10 / math.log(10)


stem, sr = sf.read(stem_path, dtype="float32", always_2d=True)
mix, sr2 = sf.read(mix_path, dtype="float32", always_2d=True)
assert sr == sr2
stem_m, mix_m = stem.mean(axis=1), mix.mean(axis=1)

from transformers import pipeline
snap = glob.glob(ROOT + "/vendor/voice-models/hub/models--openai--whisper-small.en/snapshots/*")[0]
asr = pipeline("automatic-speech-recognition", model=snap, device=-1)

report = []
for line in open(cand_path, encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#"): continue
    label, s, e, caption = line.split("|", 3)
    s, e = float(s), float(e)
    t0, t1 = s, e
    def pad(t, direction):
        p = 0.0
        for step in (0.04, 0.08, 0.12):
            i = int((t - step) * sr) if direction < 0 else int(t * sr)
            j = i + int(step * sr)
            chunk = stem_m[i:j] if direction < 0 else stem_m[int(t * sr):int((t + step) * sr)]
            if len(chunk) and db(np.sqrt((chunk ** 2).mean())) < -50: p = step
            else: break
        return p
    ps, pe = pad(t0, -1), pad(t1, +1)
    c0, c1 = t0 - ps, t1 + pe
    x = stem_m[int(c0 * sr):int(c1 * sr)].copy()
    ref = mix_m[int(c0 * sr):int(c1 * sr)]
    fade = int(0.015 * sr)
    x[:fade] *= np.linspace(0, 1, fade); x[-fade:] *= np.linspace(1, 0, fade)
    x24 = AF.resample(torch.from_numpy(x), sr, 24000).numpy()
    pcm = np.clip(np.round(x24 * 32767), -32768, 32767).astype("<i2")
    dst = os.path.join(out_dir, label + ".wav")
    with wave.open(dst, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(pcm.tobytes())
    fr2 = frames(x, sr)
    lvl = db(np.percentile(fr2, 90))
    pf, tonal = pause_floor(x, sr)
    pfm, tonalm = pause_floor(ref, sr)
    f0 = AF.detect_pitch_frequency(torch.from_numpy(x24.astype(np.float32))[None], 24000, freq_low=70, freq_high=450)[0].numpy()
    v = f0[(f0 > 75) & (f0 < 445)]
    out = asr({"raw": AF.resample(torch.from_numpy(x), sr, 16000).numpy(), "sampling_rate": 16000}, return_timestamps=False)
    heard = out["text"].strip()
    norm = lambda t: re.sub(r"[^a-z0-9 ]", "", t.lower().replace("-", " ")).split()
    ca, he = norm(caption), norm(heard)
    import difflib
    sim = difflib.SequenceMatcher(None, ca, he).ratio()
    r = dict(label=label, file=dst, caption=caption, edgeStart=s, edgeEnd=e, cutStart=round(c0, 2), cutEnd=round(c1, 2), seconds=round(len(x) / sr, 2),
             speechLevelDb=round(lvl, 1), peakDb=round(db(np.abs(x).max()), 1), pauseFloorDb=round(pf, 1), snrDb=round(lvl - pf, 1),
             pauseTonalPeakDb=None if tonal is None else round(tonal, 1), mixPauseFloorDb=round(pfm, 1), mixSnrDb=round(db(np.percentile(frames(ref, sr), 90)) - pfm, 1),
             f0Median=round(float(np.median(v)), 0) if len(v) > 5 else None, whisper=heard, textMatch=round(sim, 2))
    report.append(r)
    print(json.dumps(r, ensure_ascii=False), flush=True)
json.dump(report, open(os.path.join(out_dir, "candidates.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
