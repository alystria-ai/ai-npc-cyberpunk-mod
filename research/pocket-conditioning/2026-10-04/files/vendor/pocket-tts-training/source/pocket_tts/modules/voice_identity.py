"""Experimental ABI1: small internal ID residual on audio conditioning.

No ID is a spoken token. This module adds no prefix positions and consumes no
global RNG. Mapping/config/weight identities are mandatory for hybrid exports.
The unknown slot and unallocated slots are always an audio-only zero residual.
"""
from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

import torch
from torch import nn

ABI = "pocket-voice-identity-residual-v1"
WEIGHT_KEY = "voice_identity.embedding.weight"


def mapping_hash(keys):
    raw = json.dumps(list(keys), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def independent_id_keep(seed, global_indices, target_ids, mapping_sha256, dropout):
    """Stateless CPU mask shared by student/teacher and reused on retry/resume."""
    if not 0 <= dropout <= 1:
        raise ValueError("ID dropout must be in [0,1]")
    if len(global_indices) != len(target_ids):
        raise ValueError("One exact draw and target ID are required per row")
    mask = []
    for index, target in zip(global_indices, target_ids, strict=True):
        if type(index) is not int or index < 0:
            raise ValueError("Invalid global sample index")
        raw = json.dumps([seed, index, target, mapping_sha256, "identity-dropout-v1"], separators=(",", ":")).encode()
        rng = random.Random(int.from_bytes(hashlib.sha256(raw).digest(), "big"))
        mask.append(rng.random() >= dropout)
    return torch.tensor(mask, dtype=torch.bool)


class VoiceIdentityResidual(nn.Module):
    def __init__(self, dim, keys, expected_mapping_sha256, capacity=None):
        super().__init__()
        capacity = len(keys) if capacity is None else capacity
        if dim < 1 or capacity < 1 or len(keys) > capacity or list(keys) != sorted(set(keys)):
            raise ValueError("Sorted unique mapping and sufficient shared capacity required")
        if mapping_hash(keys) != expected_mapping_sha256:
            raise ValueError("Voice identity mapping hash differs")
        self.dim, self.keys, self.mapping_sha256 = dim, tuple(keys), expected_mapping_sha256
        self.capacity = capacity
        # Providing _weight bypasses nn.Embedding's random initialization. New
        # experimental parameters are explicit zero init, not old learned weights.
        self.embedding = nn.Embedding(capacity + 1, dim, padding_idx=0,
                                      _weight=torch.zeros(capacity + 1, dim, dtype=torch.float32))

    @classmethod
    def from_config(cls, config, dim):
        if config.abi != ABI:
            raise ValueError("Unsupported voice identity ABI")
        return cls(dim, config.keys, config.mapping_sha256, config.capacity)

    def canonical_ids(self, ids, batch_size, device):
        if ids is None:
            return torch.zeros(batch_size, dtype=torch.long, device=device)
        if not isinstance(ids, torch.Tensor) or ids.ndim != 1 or ids.shape[0] != batch_size or ids.dtype not in (torch.int32, torch.int64):
            raise ValueError("Speaker IDs must be a [B] integer tensor")
        ids = ids.to(device=device, dtype=torch.long)
        return torch.where((ids >= 1) & (ids <= len(self.keys)), ids, torch.zeros_like(ids))

    def canonical_id(self, identity):
        if identity is None:
            return 0
        if type(identity) is not int:
            raise ValueError("Internal speaker ID must be an integer or absent")
        return identity if 1 <= identity <= len(self.keys) else 0

    def forward(self, voice_embeddings, ids=None, keep=None, valid_frames=None):
        if voice_embeddings.ndim != 3 or voice_embeddings.shape[-1] != self.dim:
            raise ValueError("Voice residual expects [B,T,d_model] projected audio")
        batch, frames, _ = voice_embeddings.shape
        ids = self.canonical_ids(ids, batch, self.embedding.weight.device)
        if keep is None:
            keep = torch.ones(batch, dtype=torch.bool, device=ids.device)
        elif not isinstance(keep, torch.Tensor) or keep.dtype != torch.bool or keep.shape != (batch,):
            raise ValueError("ID keep mask must be a [B] boolean tensor")
        else:
            keep = keep.to(ids.device)
        ids = torch.where(keep, ids, torch.zeros_like(ids))
        # Do not depend on mutable row0 weights: absent/unknown always has zero.
        residual = self.embedding(ids) * (ids > 0)[:, None]
        residual = residual.to(device=voice_embeddings.device, dtype=voice_embeddings.dtype)
        if valid_frames is None:
            valid = torch.ones(batch, frames, dtype=torch.bool, device=voice_embeddings.device)
        else:
            if valid_frames.shape != (batch,):
                raise ValueError("One valid prefix length is required per row")
            valid = torch.arange(frames, device=voice_embeddings.device)[None] < valid_frames.to(voice_embeddings.device)[:, None]
        return voice_embeddings + residual[:, None] * valid[:, :, None]

    def validate_unused_zero(self):
        unused = torch.cat([self.embedding.weight[:1], self.embedding.weight[len(self.keys) + 1:]], dim=0)
        if not bool((unused == 0).all()):
            raise ValueError("Unknown/unallocated residual slots must remain zero")

    def metadata(self):
        self.validate_unused_zero()
        return {"abi": ABI, "mapping_sha256": self.mapping_sha256, "capacity": self.capacity,
                "known_ids": len(self.keys), "dim": self.dim, "unknown_id": 0,
                "table_sha256": self.table_hash()}

    def table_hash(self):
        arr = self.embedding.weight.detach().float().cpu().contiguous().numpy()
        return hashlib.sha256(arr.astype("<f4", copy=False).tobytes()).hexdigest()


def identity_metadata(flow_lm):
    bank = getattr(flow_lm, "voice_identity", None)
    return bank.metadata() if bank is not None else None


def abi_weight_metadata(flow_lm):
    meta = identity_metadata(flow_lm)
    return {} if meta is None else {"voice_identity": json.dumps(meta, sort_keys=True)}


def assert_weight_abi(flow_lm, path, *, allow_fresh_init=False, expected_init_sha256=None, use_ema=False,
                      checkpoint_payload=None):
    """Validate metadata before any hybrid state is loaded; inference is strict.

    Explicit training-only warm start can add a fresh zero table to a pinned
    baseline export. It never invents tensor fields in that original checkpoint.
    """
    import safetensors
    path = Path(path)
    bank = getattr(flow_lm, "voice_identity", None)
    if path.suffix == ".safetensors":
        if checkpoint_payload is not None:
            raise ValueError("A safetensors import cannot substitute a checkpoint payload")
        with safetensors.safe_open(str(path), framework="pt", device="cpu") as file:
            meta = (file.metadata() or {}).get("voice_identity")
            has = "flow_lm." + WEIGHT_KEY in file.keys() or WEIGHT_KEY in file.keys()
    else:
        # The caller already loads training checkpoint state; small ABI header
        # validation shares the serialized conditioning contract, never backfills it.
        payload = checkpoint_payload if checkpoint_payload is not None else torch.load(path, map_location="cpu", weights_only=True)
        meta = payload.get("voice_identity_ema") if use_ema and payload.get("ema") else payload.get("voice_identity")
        state = payload.get("model", payload)
        has = "flow_lm." + WEIGHT_KEY in state or WEIGHT_KEY in state
    if bank is None:
        if meta is not None or has:
            raise ValueError("Hybrid checkpoint cannot be loaded as a baseline model")
        return {"mode": "baseline"}
    if meta is None and not has:
        if not allow_fresh_init or not expected_init_sha256 or hashlib.sha256(path.read_bytes()).hexdigest() != expected_init_sha256:
            raise ValueError("Hybrid model requires trained ABI weights or explicit pinned fresh-feature initialization")
        if not bool((bank.embedding.weight == 0).all()):
            raise ValueError("Fresh hybrid initialization must be an exactly zero table")
        return {"mode": "explicit_new_zero_feature", "source_sha256": expected_init_sha256,
                "new_parameter": WEIGHT_KEY, "mapping_sha256": bank.mapping_sha256}
    if meta is None or not has:
        raise ValueError("Incomplete hybrid weight ABI")
    meta = json.loads(meta) if isinstance(meta, str) else meta
    expected = {"abi": ABI, "mapping_sha256": bank.mapping_sha256, "capacity": bank.capacity,
                "known_ids": len(bank.keys), "dim": bank.dim, "unknown_id": 0}
    if any(meta.get(k) != v for k, v in expected.items()):
        raise ValueError("Hybrid weight/config mapping or shape ABI differs")
    return {"mode": "trained_hybrid", **meta}


def load_flow_state_with_fresh_identity(flow_lm, state, receipt, *, dropped=()):
    """Only exact explicit-new feature keys may be absent during training import."""
    missing, unexpected = flow_lm.load_state_dict(state, strict=False)
    allowed = set(dropped)
    if receipt.get("mode") == "explicit_new_zero_feature":
        allowed.add(WEIGHT_KEY)
    if unexpected or set(missing) != allowed:
        raise ValueError(f"Unexpected weight import differences: missing={missing}, unexpected={unexpected}")
    bank = getattr(flow_lm, "voice_identity", None)
    if bank is not None:
        bank.validate_unused_zero()
        if receipt.get("mode") == "trained_hybrid" and bank.table_hash() != receipt["table_sha256"]:
            raise ValueError("Actual hybrid table bytes differ from weight metadata")


def assert_shared_mapping(student, teacher):
    a, b = getattr(student, "voice_identity", None), getattr(teacher, "voice_identity", None)
    if (a is None) != (b is None):
        raise ValueError("Teacher/student conditioning ABIs differ")
    if a is not None and (a.mapping_sha256, a.capacity, a.dim) != (b.mapping_sha256, b.capacity, b.dim):
        raise ValueError("Teacher/student identity mapping or dimension differs")


def voice_state_key(flow_lm, model_sha256, reference_sha256, speaker_id, truncate):
    bank = getattr(flow_lm, "voice_identity", None)
    if bank is None:
        raise ValueError("A hybrid state key requires the hybrid ABI")
    if len(model_sha256 or "") != 64 or len(reference_sha256 or "") != 64:
        raise ValueError("Exact model/reference hashes are required for hybrid voice states")
    return (ABI, model_sha256, bank.mapping_sha256, bank.table_hash(),
            bank.canonical_id(speaker_id), reference_sha256, bool(truncate))
