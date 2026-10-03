"""Exact old-model controls inside a temporary hybrid-shaped comparison owner.

The only permitted extension is an all-zero ID table. This is never a trained
hybrid import and must not be used to initialize the candidate student.
"""
from pathlib import Path
import hashlib

TABLE = "voice_identity.embedding.weight"


def load_control(flow_lm, source, *, source_path, expected_sha256, allow_zero_identity=False):
    import safetensors
    import torch
    from pocket_tts.modules.voice_identity import assert_weight_abi, load_flow_state_with_fresh_identity

    source_path = Path(source_path)
    digest = hashlib.sha256()
    with source_path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    if not expected_sha256 or digest.hexdigest() != expected_sha256:
        raise ValueError("Control weights differ from their immutable selected source")
    current = flow_lm.state_dict()
    missing, unexpected = set(current) - set(source), set(source) - set(current)
    zero_extension = bool(missing)
    if unexpected or (missing and (not allow_zero_identity or missing != {TABLE}
                                   or getattr(flow_lm, "voice_identity", None) is None)):
        raise ValueError("Control inventory differs beyond the sole optional zero-ID table")
    for key, tensor in source.items():
        if tensor.shape != current[key].shape or tensor.dtype != current[key].dtype:
            raise ValueError("Control tensor shape or dtype changed: " + key)
    if zero_extension:
        with safetensors.safe_open(str(source_path), framework="pt", device="cpu") as bundle:
            if (bundle.metadata() or {}).get("voice_identity") is not None:
                raise ValueError("Missing-table control must not claim a trained hybrid ABI")
        state = dict(source)
        state[TABLE] = torch.zeros_like(current[TABLE])
        flow_lm.load_state_dict(state, strict=True)
    else:
        receipt = assert_weight_abi(flow_lm, source_path)
        load_flow_state_with_fresh_identity(flow_lm, source, receipt)
    loaded = flow_lm.state_dict()
    for key, tensor in source.items():
        if loaded[key].dtype != tensor.dtype or not torch.equal(loaded[key].detach().cpu(), tensor.detach().cpu()):
            raise ValueError("Loaded control differs from an original tensor: " + key)
    if zero_extension and not bool((loaded[TABLE] == 0).all()):
        raise ValueError("Old-model control acquired a nonzero identity residual")
    return {"source_weight_sha256": expected_sha256, "original_tensors_identical": True,
            "identity_control": "explicit_zero_residual_extension" if zero_extension else "native_weight_abi",
            "candidate_initialization": False}
