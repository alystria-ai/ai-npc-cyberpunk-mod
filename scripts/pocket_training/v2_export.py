"""Build a runtime-loadable six-layer Pocket export from a v2 student's selected EMA weights.

    python scripts/pocket_training/v2_export.py --selected <student-ema.safetensors> --meta <student.json>
        --run <run id> --out <export dir> [--template E:/.../exports/s5000-raw]

Every flow_lm.* tensor comes from the selected student; Mimi tensors, inference.yaml and tokenizer.json come from the
template export (the current runtime student, pretrained decoder). Writes receipt.json in the format
bridge/pocket_voice_runtime.py verifies (source revision, weights, sample_cfg 1.0, selected step, identities).
Nothing is installed: switching the runtime is a separate, user-approved step.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

SOURCE_REVISION = "41cbc84af539ea78a804ffca5f9c6edc1a22ce44"


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 22), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selected", type=Path, required=True)
    parser.add_argument("--meta", type=Path, required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--template", type=Path, default=Path(r"E:\CyberpunkConvai-offload\work\student-ranking\exports\s5000-raw"))
    args = parser.parse_args()
    import safetensors.torch
    meta = json.loads(args.meta.read_text())
    student = safetensors.torch.load_file(str(args.selected))
    template = safetensors.torch.load_file(str(args.template / "model.safetensors"))
    flow_keys = {k for k in template if k.startswith("flow_lm.")}
    if set(student) != flow_keys:
        raise ValueError(f"flow_lm keys differ: missing {sorted(flow_keys - set(student))[:3]} extra {sorted(set(student) - flow_keys)[:3]}")
    merged = {k: (student[k].float().contiguous() if k in student else v) for k, v in template.items()}
    for k in student:
        if tuple(student[k].shape) != tuple(template[k].shape):
            raise ValueError(f"shape differs for {k}")
    args.out.mkdir(parents=True, exist_ok=True)
    safetensors.torch.save_file(merged, str(args.out / "model.safetensors"))
    for name in ("inference.yaml", "tokenizer.json"):
        shutil.copy2(args.template / name, args.out / name)
    identity = hashlib.sha256(json.dumps({"run": args.run, "selected": sha(args.selected)}, sort_keys=True).encode()).hexdigest()
    receipt = {"selected_step": int(meta["step"]), "checkpoint_step": int(meta["step"]), "weights": "ema", "sample_cfg": 1.0,
               "model_sha256": sha(args.out / "model.safetensors"), "input_identity": identity,
               "source_revision": SOURCE_REVISION,
               "provenance": {"run": args.run, "policy": meta.get("policy"), "selection_metric": meta.get("metric"),
                              "selection_score": meta.get("best"), "selected_weights_sha256": sha(args.selected),
                              "layout": "flow_lm tensors from the v2 student's EMA weights; Mimi, inference.yaml and tokenizer.json from the template export",
                              "template": str(args.template)}}
    (args.out / "receipt.json").write_text(json.dumps(receipt, indent=2))
    print(json.dumps({"out": str(args.out), "model_sha256": receipt["model_sha256"], "step": receipt["selected_step"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
