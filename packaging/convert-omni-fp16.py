"""Converts the OmniVoice language model's float32 weights to float16, the precision the worker loads them in.

    python packaging/convert-omni-fp16.py <upstream model.safetensors> <output model.safetensors>

Why: the resident worker loads OmniVoice with `from_pretrained(..., dtype=torch.float16)` (the VoiceStudio adapter's model_manager, and
bridge/resident-voice-worker.py refuses any other precision), so a float32 file is read, rounded to float16 and discarded. Shipping the float16
file gives the worker the very same values, and the pack 1.2 GB less. Every floating-point tensor is rounded to the nearest float16 (round half
to even, what torch's `.to(torch.float16)` does and what the loader does too), integer tensors are kept as they are, and the file's metadata is
kept. The conversion is exact for the values that matter: the check below fails when a finite value would overflow to infinity, a tensor is
missing or changed in shape, or the converted file does not equal the input rounded again.

The audio tokenizer (audio_tokenizer/model.safetensors) is NOT converted: OmniVoice loads it without a dtype, so it runs as float32 (its config says
float32), and a float16 file would change the audio.

Run with the OmniVoice pack's Python (torch and safetensors are in it) or any environment with both. Prints a JSON summary on the last line.
"""
import hashlib
import json
import sys

import torch
from safetensors import safe_open
from safetensors.torch import load_file, save_file


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 22), b""):
            digest.update(block)
    return digest.hexdigest()


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    source, target = argv[1], argv[2]
    with safe_open(source, framework="pt") as handle:
        metadata = handle.metadata()
    tensors = load_file(source)
    converted, report = {}, {"float32": 0, "other": 0, "maxAbs": 0.0, "underflowed": 0}
    for name, tensor in tensors.items():
        if tensor.dtype == torch.float32:
            half = tensor.to(torch.float16)
            if not torch.isfinite(half).all() and torch.isfinite(tensor).all():
                raise SystemExit(f"{name}: a finite float32 value overflows float16")
            report["float32"] += 1
            report["maxAbs"] = max(report["maxAbs"], float(tensor.abs().max()))
            report["underflowed"] += int(((tensor != 0) & (half == 0)).sum())
            converted[name] = half.contiguous()
        elif tensor.dtype.is_floating_point:
            raise SystemExit(f"{name}: {tensor.dtype} is not float32; this converter only knows the upstream float32 file")
        else:
            report["other"] += 1
            converted[name] = tensor
    save_file(converted, target, metadata=metadata)
    check = load_file(target)
    if check.keys() != tensors.keys():
        raise SystemExit("the converted file has other tensor names")
    for name, tensor in tensors.items():
        again = check[name]
        expected = tensor.to(torch.float16) if tensor.dtype == torch.float32 else tensor
        if again.shape != tensor.shape or again.dtype != expected.dtype or not torch.equal(again, expected):
            raise SystemExit(f"{name}: the converted file differs from the input rounded to float16")
    report.update({"tensors": len(tensors), "metadata": metadata, "sha256": sha256(target), "bytes": __import__("os").path.getsize(target)})
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
