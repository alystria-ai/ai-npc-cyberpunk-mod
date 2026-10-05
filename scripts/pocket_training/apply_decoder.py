"""Write a fine-tuned Mimi decoder (policy mimi_decoder_gan_v1) into a copy of a Pocket export.

Only decoder-side ``mimi.*`` tensors are replaced; FlowLM, the Mimi encoder and the latent
space are copied bit-for-bit, so the runtime path and CPU cost are unchanged.

  python scripts/pocket_training/apply_decoder.py --export <dir with model.safetensors> \
      --decoder <decoder.safetensors> --out <new export dir>
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def apply(export: Path, decoder: Path, out: Path) -> dict:
    import safetensors.torch
    from pocket_training.mimi_decoder import DECODER_PREFIXES

    if out.exists():
        raise FileExistsError(out)
    bundle = safetensors.torch.load_file(str(export / "model.safetensors"))
    new = safetensors.torch.load_file(str(decoder))
    expected = {k for k in bundle if k.startswith(tuple("mimi." + p for p in DECODER_PREFIXES))}
    if set(new) != expected:
        raise ValueError(f"Decoder tensors differ from the export's decoder side ({len(new)} vs {len(expected)})")
    for key, tensor in new.items():
        if bundle[key].shape != tensor.shape:
            raise ValueError("Shape mismatch for " + key)
        bundle[key] = tensor.to(bundle[key].dtype).contiguous()
    out.mkdir(parents=True)
    safetensors.torch.save_file(bundle, str(out / "model.safetensors"))
    for name in ("inference.yaml", "tokenizer.json"):
        if (export / name).is_file():
            shutil.copyfile(export / name, out / name)
    receipt = {"policy": "mimi_decoder_gan_v1", "source_export_model_sha256": sha256(export / "model.safetensors"),
               "decoder_sha256": sha256(decoder), "model_sha256": sha256(out / "model.safetensors"),
               "replaced_tensors": len(new), "flow_lm_and_encoder": "unchanged"}
    (out / "decoder-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return receipt


if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--export", type=Path, required=True)
    parser.add_argument("--decoder", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(apply(args.export, args.decoder, args.out), indent=2))
