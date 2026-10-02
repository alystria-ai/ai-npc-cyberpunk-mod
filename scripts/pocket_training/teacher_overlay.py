"""Scoped accepted-teacher comparison; never a second resident provider."""
from contextlib import contextmanager
from typing import Any, Iterator

from . import runner


@contextmanager
def comparison_weights(spec: Any, model: Any, mimi: Any, device: Any, rank: int,
                       world: int) -> Iterator[None]:
    """Overlay once at run step zero, restoring state even on stop/error.

    TrainableTTS.generate constructs fresh FlowLM streaming states for every
    invocation; callers must use that path, not cached public voice/KV states.
    The Mimi encoder/decoder and latent calibration must be bit-identical.
    """
    import numpy as np
    import safetensors
    import torch

    saved = None
    setup_failed = False
    try:
        try:
            # CPU tensors also need a clone: detach().cpu() alone aliases
            # their live storage and cannot restore a modified buffer.
            saved = {"model": {key: value.detach().cpu().clone() for key, value in model.state_dict().items()},
                     "mimi": {key: value.detach().cpu().clone() for key, value in mimi.state_dict().items()},
                     "rng": runner.capture_rng(torch, model), "numpy_rng": np.random.get_state()}
            seen = set()
            saved["modes"] = []
            saved["grad"] = []
            for root in (model, mimi):
                for module in root.modules():
                    if id(module) not in seen:
                        seen.add(id(module))
                        saved["modes"].append((module, module.training))
                saved["grad"].extend((parameter, parameter.requires_grad) for parameter in root.parameters())
            source = {}
            with safetensors.safe_open(str(spec.asset("teacher_comparison_weights")), framework="pt", device="cpu") as bundle:
                codec = mimi.state_dict()
                codec_keys = {key.removeprefix("mimi.") for key in bundle.keys() if key.startswith("mimi.")}
                if codec_keys != set(codec):
                    raise ValueError("Teacher comparison codec inventory differs")
                for key, tensor in codec.items():
                    other = bundle.get_tensor("mimi." + key)
                    if other.dtype != tensor.dtype or not torch.equal(other, tensor.detach().cpu()):
                        raise ValueError("Teacher comparison cannot reuse a different Mimi codec")
                source = {key.removeprefix("flow_lm."): bundle.get_tensor(key)
                          for key in bundle.keys() if key.startswith("flow_lm.")}
            for key in ("emb_mean", "emb_std"):
                if not torch.equal(source[key], model.flow_lm.state_dict()[key].detach().cpu()):
                    raise ValueError("Teacher comparison latent calibration differs")
            model.flow_lm.load_state_dict(source, strict=True)
            del source
        except Exception:
            setup_failed = True
        if runner.distributed_any(torch, setup_failed, device, world):
            raise RuntimeError("Teacher comparison setup failed on a rank")
        yield
    finally:
        restore_failed = False
        if saved is not None:
            try:
                model.load_state_dict(saved["model"], strict=True)
                mimi.load_state_dict(saved["mimi"], strict=True)
                for parameter, requires_grad in saved.get("grad", []):
                    parameter.requires_grad_(requires_grad)
                for module, training in saved.get("modes", []):
                    module.training = training
                runner.restore_rng(torch, model, saved["rng"])
                np.random.set_state(saved["numpy_rng"])
            except Exception:
                restore_failed = True
        if runner.distributed_any(torch, restore_failed, device, world):
            raise RuntimeError("Teacher comparison state restoration failed on a rank")
