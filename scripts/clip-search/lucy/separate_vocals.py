"""Lucy Kushinada: split the vocals off the downloaded clips with Demucs (htdemucs), step D of the external flow.

Runs in a SEPARATE venv (never the mod's vendor, omni or packaged Pythons), see docs/NCA_FOLLOWERS_PLAN.md section 8 for how to recreate it:
    python -m venv %TEMP%\\demucs-venv
    %TEMP%\\demucs-venv\\Scripts\\python.exe -I -m pip install torch==2.8.0 torchaudio==2.8.0 demucs==4.1.0
The htdemucs weights (about 80 MB, signature 955717e8) come from Meta's own host (dl.fbaipublicfiles.com/demucs/) through demucs itself;
TORCH_HOME is pointed inside the venv folder so no user cache is written.

Usage: python -I separate_vocals.py <out_dir> <name>=<44.1 kHz stereo float32 or 16-bit WAV> ...
Only the vocals stem is written (float32 stereo WAV, 44.1 kHz).  The WAV reader and writer are stdlib + numpy so nothing else is installed.
The input WAVs are decoded downloaded data: read as bytes only, never executed.
"""
import os, struct, sys, time
sys.stdout.reconfigure(encoding="utf-8")
import numpy as np
import torch

out_dir = sys.argv[1]
items = [a.split("=", 1) for a in sys.argv[2:]]
os.makedirs(out_dir, exist_ok=True)


def read_wav(path):
    b = open(path, "rb").read()
    assert b[:4] == b"RIFF" and b[8:12] == b"WAVE"
    pos, fmt, data = 12, None, None
    while pos + 8 <= len(b):
        cid, size = b[pos:pos + 4], struct.unpack("<I", b[pos + 4:pos + 8])[0]
        body = b[pos + 8:pos + 8 + size]
        if cid == b"fmt ": fmt = struct.unpack("<HHIIHH", body[:16])
        elif cid == b"data": data = body
        pos += 8 + size + (size & 1)
    tag, ch, sr, _, _, bits = fmt
    if tag == 0xFFFE: tag = 3 if bits == 32 else 1  # extensible header: float at 32 bits, PCM otherwise
    if bits == 32 and tag == 3: x = np.frombuffer(data, dtype="<f4")
    elif bits == 16: x = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768
    else: raise SystemExit(f"unsupported wav {tag} {bits}")
    return x.reshape(-1, ch).T.copy(), sr


def write_wav(path, x, sr):
    ch, n = x.shape
    data = np.ascontiguousarray(x.T.astype("<f4")).tobytes()
    hdr = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE" + b"fmt " + struct.pack("<IHHIIHH", 16, 3, ch, sr, sr * ch * 4, ch * 4, 32) + b"data" + struct.pack("<I", len(data))
    open(path, "wb").write(hdr + data)


from demucs.pretrained import get_model
from demucs.apply import apply_model
model = get_model("htdemucs")
model.eval()
print("model sources", model.sources, "samplerate", model.samplerate, flush=True)
vi = model.sources.index("vocals")
torch.set_num_threads(max(2, (os.cpu_count() or 4) // 2))

for name, path in items:
    x, sr = read_wav(path)
    assert sr == model.samplerate and x.shape[0] == 2, (sr, x.shape)
    wav = torch.from_numpy(x)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std()
    t0 = time.time()
    with torch.no_grad():
        out = apply_model(model, ((wav - mean) / std)[None], device="cpu", shifts=1, split=True, overlap=0.25, progress=False)[0]
    voc = (out[vi] * std + mean).numpy()
    dst = os.path.join(out_dir, name + ".vocals.wav")
    write_wav(dst, voc, sr)
    print(name, "seconds", round(x.shape[1] / sr, 1), "took", round(time.time() - t0, 1), "->", dst, flush=True)
