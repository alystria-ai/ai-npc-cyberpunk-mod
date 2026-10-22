"""Make a bfloat16 copy of the Pocket English student export (trial; nothing in the Runtime changes).

  python scripts/Convert-PocketBf16.py --export <student export dir> --out <new dir> [--config-out <pins.json>]

The Runtime build does the same in Node (packaging/lib/pocket-bf16.mjs, no torch needed) and ships the result; this script is the Python reference and gives the
same bytes (the model's and the receipt's sha256 agree).

<student export dir> is the Runtime's app/models/pocket (model.safetensors, inference.yaml, tokenizer.json, receipt.json,
decoder-receipt.json). The new folder gets the same files, with model.safetensors written as bfloat16 (every float32 tensor,
round to nearest even: torch's own cast, the same dtype the five Pocket language models are published in) and a receipt.json whose
model_sha256 names the new file and whose provenance records the conversion (edited as text, the rest of the receipt untouched). Nothing is written into the source folder.

The worker needs no change: it loads the weights into float32 modules (TTSModel.load_model copies into the float32 parameters),
so the bfloat16 file is widened on load and every compute path is the same as for the float32 file. What the worker pins
(model sha256, receipt sha256) differ, so the trial runs with the model block this script prints (or writes with --config-out).
Run it with a Python that has torch and safetensors (the Runtime's own app/python has both).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file


CAST = "float32 to bfloat16, round to nearest even, every float32 tensor"
TOOL = "packaging/lib/pocket-bf16.mjs"  # the Runtime build's converter; this script is its reference in Python


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def convert(source: Path, target: Path) -> dict:
    tensors, report = {}, {"tensors": 0, "maxAbsError": 0.0, "maxRelError": 0.0, "worstTensor": None}
    with safe_open(str(source), framework="pt", device="cpu") as f:
        for name in f.keys():
            t = f.get_tensor(name)
            if t.dtype == torch.float32:
                b = t.to(torch.bfloat16)
                if not torch.isfinite(b.float()).all() and torch.isfinite(t).all():
                    raise ValueError(f"{name}: overflow in the bfloat16 cast")
                error = (b.float() - t).abs()
                scale = t.abs().clamp_min(1e-12)
                rel = float((error / scale).max()) if t.numel() else 0.0
                if rel > report["maxRelError"]:
                    report["maxRelError"], report["worstTensor"] = rel, name
                report["maxAbsError"] = max(report["maxAbsError"], float(error.max()) if t.numel() else 0.0)
                tensors[name] = b.contiguous()
            else:  # an integer or already narrow tensor stays as it is
                tensors[name] = t.contiguous()
            report["tensors"] += 1
    save_file(tensors, str(target))
    return report


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--export", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--config-out", type=Path)
    args = p.parse_args(argv)
    src, out = args.export.resolve(), args.out.resolve()
    if out == src or src in out.parents:
        print("The output folder must be outside the source export.", file=sys.stderr)
        return 2
    out.mkdir(parents=True, exist_ok=True)
    for name in ("inference.yaml", "tokenizer.json", "decoder-receipt.json"):
        if (src / name).is_file():
            shutil.copyfile(src / name, out / name)
    report = convert(src / "model.safetensors", out / "model.safetensors")
    new_sha = digest(out / "model.safetensors")
    # The receipt is edited as text (not parsed and written again) so it keeps its layout, line endings and numbers such as 1.0; the same edit as
    # bf16ReceiptText() in packaging/lib/pocket-bf16.mjs, which the Runtime build uses (the two give the same bytes).
    text = (src / "receipt.json").read_bytes().decode("utf-8")
    eol = "\r\n" if "\r\n" in text else "\n"
    own = re.findall(r'"model_sha256": "([0-9a-f]{64})"', text)
    opening = re.search(r'"provenance": \{\r?\n', text)
    if len(own) != 1 or not opening or '"bfloat16"' in text:
        print("The receipt does not have the expected shape.", file=sys.stderr)
        return 2
    block = eol.join(['    "bfloat16": {', f'      "from_model_sha256": "{own[0]}",', f'      "cast": "{CAST}",', f'      "tool": "{TOOL}"', "    },"]) + eol
    text = text[:opening.end()] + block + text[opening.end():]
    text = text.replace(f'"model_sha256": "{own[0]}"', f'"model_sha256": "{new_sha}"')
    (out / "receipt.json").write_bytes(text.encode("utf-8"))
    receipt = json.loads(text)
    model = {"sha256": new_sha, "configSha256": digest(out / "inference.yaml"), "tokenizerSha256": digest(out / "tokenizer.json"),
             "receiptSha256": digest(out / "receipt.json"), "inputIdentity": receipt["input_identity"], "selectedStep": receipt["selected_step"]}
    result = {"model": model, "report": report, "bytes": (out / "model.safetensors").stat().st_size,
              "sourceBytes": (src / "model.safetensors").stat().st_size}
    if args.config_out:
        args.config_out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
