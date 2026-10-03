"""Opt-in data-only cross-utterance sampler, without a neural speaker-ID feature.

Uses the pinned IndexedBatches/DataLoader and returns the same official Batch.
No target text, tokenizer, architecture, loss, or inference behavior is altered.
Not wired into the real runner. A candidate integration must bind policy/hash/
fraction in spec.identity and resolved checkpoint options before a neural pilot.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
from pathlib import Path

from .runner import IndexedBatches


def keyed_rng(seed, global_index, target_id, policy_id, stream):
    key = json.dumps([seed, global_index, target_id, policy_id, stream], separators=(",", ":")).encode()
    return random.Random(int.from_bytes(hashlib.sha256(key).digest(), "big"))


class PairedIndexedBatches(IndexedBatches):
    """A/B candidate: sample B exactly as baseline, optionally substitute A's prompt.

    `global_index` is the same global draw index already used by the runner for
    rank/microbatch/retry/resume. Pair and donor draws use separate stateless RNGs.
    Sparse or excluded rows retain the exact baseline sample. Unreadable changed
    files raise; they never silently move a draw to another speaker or target.
    """

    def __init__(self, args, model, mimi, *, policy_path, policy_sha256,
                 pair_fraction=.5, allow_subset_for_controls=False,
                 actual_cache_receipt=None, actual_cache_receipt_sha256=None):
        if not 0 <= pair_fraction <= 1 or not math.isfinite(pair_fraction):
            raise ValueError("Pair fraction must be finite and in [0,1]")
        raw = Path(policy_path).read_bytes()
        if hashlib.sha256(raw).hexdigest() != policy_sha256:
            raise ValueError("Pair policy identity differs")
        self.policy = json.loads(raw)
        self.policy_id = self.policy["identity_sha256"]
        identity_value = {k: v for k, v in self.policy.items() if k not in ("summary", "identity_sha256")}
        identity_bytes = json.dumps(identity_value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        if hashlib.sha256(identity_bytes).hexdigest() != self.policy_id:
            raise ValueError("Policy semantic identity is invalid")
        if (self.policy["codec_sha256"] != "29335a056899c615a95664894c691222d4eb3b2c060009bacbaf0f676cb8ce2b"
                or self.policy["prompt_sec"] != args.data.max_voice_prompt_sec
                or self.policy["target_sec"] != args.data.max_duration_sec
                or self.policy["frame_rate"] != mimi.frame_rate
                or self.policy["sample_rate"] != mimi.sample_rate):
            raise ValueError("Real crop/codec recipe differs from the reviewed pairing plan")
        super().__init__(args, model, mimi, balanced=False)
        self.pair_fraction = pair_fraction
        self.plan_rows = {r["id"]: r for r in self.policy["rows"]}
        self.original_indices = {r["index"]: r["id"] for r in self.policy["rows"]}
        self.allowed = {r["id"]: r for r in self.policy["selected_source_records"]}
        self.train_rows = [json.loads(self.loader.entries[i]) for i in range(self.size)]
        self.index_by_id = {r["id"]: i for i, r in enumerate(self.train_rows)}
        if len(self.index_by_id) != self.size or not set(self.index_by_id) <= set(self.allowed):
            raise ValueError("Duplicate or TRAIN-external target/reference rows")
        if not allow_subset_for_controls and set(self.index_by_id) != set(self.allowed):
            raise ValueError("A real pilot must use the exact frozen selected TRAIN set")
        self.control_subset = bool(allow_subset_for_controls)
        self.cached = bool(self.loader.stitch_frames)
        if any(bool(r.get("latents_file")) != self.cached for r in self.train_rows):
            raise ValueError("Official collation does not support mixed raw/cached rows")
        if self.cached:
            metadata = json.loads(Path(args.data.train_jsonl).with_suffix(".meta.json").read_text())
            if metadata.get("mimi_hash") != self.policy["codec_sha256"]:
                raise ValueError("Runtime cache uses another Mimi codec")
        self.runtime_cache_records = {}
        if actual_cache_receipt is not None:
            cache_bytes = Path(actual_cache_receipt).read_bytes()
            if not actual_cache_receipt_sha256 or hashlib.sha256(cache_bytes).hexdigest() != actual_cache_receipt_sha256:
                raise ValueError("Runtime source/cache receipt changed")
            cache_value = json.loads(cache_bytes)
            if (cache_value.get("schema") != "teacher_actual_loader_cache_v2"
                    or cache_value.get("mimi_encode_hash") != self.policy["codec_sha256"]):
                raise ValueError("Runtime source/cache receipt uses another format or codec")
            self.runtime_cache_records = {r["id"]: r for r in cache_value["rows"]}
        self.verified_latents = set()
        for row in self.train_rows:
            expected = self.allowed[row["id"]]
            s = expected["sourceIdentity"]
            if (row["transcript"] != expected["transcript"] or row["duration"] != expected["duration"]
                    or row.get("audio_sha256") != s["wav"]
                    or row.get("source_wem_sha256") != s["wem"]
                    or row.get("pcm_sha256") != s["pcm"]
                    or row.get("source_row_sha256") != s["sourceRow"]):
                raise ValueError("Runtime target/reference source tuple differs")
            if row.get("source_panel") in {"dev", "test", "teacher_conditional", "teacher_regression", "reference"}:
                raise ValueError("An explicit evaluation/reference role cannot enter the TRAIN pool")
            planned = self.plan_rows.get(row["id"])
            if planned and (row.get("words") != planned["words"] or row.get("start", 0) != planned["start"]):
                raise ValueError("Native aligned words/start differ from the plan")
            if hashlib.sha256(Path(row["path"]).read_bytes()).hexdigest() != s["wav"]:
                raise ValueError("Runtime target/reference PCM container changed")
            if self.cached:
                self._check_cache(row)
        self.last_receipts = []
        self.identity_policy = None

    def set_identity_policy(self, ids, mapping_sha256, dropout):
        if set(ids) != set(self.allowed):
            raise ValueError("ID mapping/fallback must cover the exact selected TRAIN rows")
        self.identity_policy = (dict(ids), mapping_sha256, dropout)

    def _check_cache(self, row):
        from pocket_training import teacher_data
        from training.scripts.precompute_latents import _decode_chunk

        planned = self.plan_rows.get(row["id"])
        record = self.runtime_cache_records.get(row["id"]) or (
            planned["cache"]["source_record"] if planned and planned.get("cache") else None)
        if record is None:
            raise ValueError("No independently source-bound actual cache record; use raw mode or qualify a new full-corpus cache")
        path = self.loader.latents_root / row["latents_file"]
        expected = record["latents_sha256"]
        if not expected or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("Runtime cache file changed or has no source-bound hash")
        # Reuse the real cache verifier and actual pinned resampler rather than
        # treating a same-shape tensor or another row's hash as qualification.
        array, lengths = _decode_chunk([(row["path"], float(row.get("start", 0)), float(row["duration"]), self.loader.sample_rate)])
        samples = lengths[0]
        decoded_sha = hashlib.sha256(array[0, 0, :samples].astype("<f4", copy=False).tobytes()).hexdigest()
        teacher_data.verify_cache_row(row, record, path, samples=samples, decoded_sha=decoded_sha,
            sample_rate=self.loader.sample_rate, frame_rate=self.loader.frame_rate,
            codec_hash=self.policy["codec_sha256"], dimension=32)
        # Shape/finiteness inspection only; no Mimi or neural model runs here.
        lat = self.loader._load_latents(row["latents_file"])
        import torch
        if lat.ndim != 2 or lat.shape[0] < 2 or lat.shape[1] != 32 or lat.dtype != torch.float32 or not bool(torch.isfinite(lat).all()):
            raise ValueError("Runtime cache is malformed/nonfinite")
        self.verified_latents.add(row["id"])

    def _index_at(self, global_index):
        # Exactly IndexedBatches balanced=False. No extra speaker repetition.
        epoch, within = divmod(global_index, self.size)
        if epoch != self.epoch:
            self.order = list(range(self.size))
            random.Random(self.args.seed + epoch).shuffle(self.order)
            self.epoch = epoch
        return self.order[within]

    def sample_at(self, global_index):
        if not isinstance(global_index, int) or global_index < 0:
            raise ValueError("A nonnegative exact global sample index is required")
        index = self._index_at(global_index)
        target = self.train_rows[index]
        self.loader.rng.seed(self.args.seed + 104729 * global_index)
        baseline = self.loader._sample(self.loader.get_entry(index))
        receipt = {"global_index": global_index, "target_id": target["id"], "mode": "baseline",
                   "policy_identity": self.policy_id, "neural_forward_called": False}
        planned = self.plan_rows.get(target["id"])
        if not planned:
            return baseline, {**receipt, "fallback": "source/voice-version/delivery ambiguity excluded from cross pairing"}
        candidates = [self.index_by_id[self.original_indices[i]] for i in planned["donors"]
                      if self.original_indices[i] in self.index_by_id]
        if not candidates:
            return baseline, {**receipt, "fallback": "no independent approved TRAIN donor in this manifest"}
        gate = keyed_rng(self.args.seed, global_index, target["id"], self.policy_id, "pair-decision")
        if gate.random() >= self.pair_fraction:
            return baseline, {**receipt, "fallback": "deterministic baseline arm draw"}
        donor_rng = keyed_rng(self.args.seed, global_index, target["id"], self.policy_id, "donor-and-prefix")
        donor_index = donor_rng.choice(candidates)
        donor = self.train_rows[donor_index]
        donor_plan = self.plan_rows[donor["id"]]
        if (donor_plan["voice_signature"] != planned["voice_signature"] or donor["id"] == target["id"]
                or donor_plan["actual_shape_pcm_sha256"] == planned["actual_shape_pcm_sha256"]):
            raise ValueError("Impostor or self-reference escaped source pairing gate")
        # Preserve the baseline cut/punctuation/prompt RNG for diagnostics and any
        # subsequent official use. Donor selection/trim uses its own RNG object.
        saved = self.loader.rng
        self.loader.rng = donor_rng
        try:
            entry = self.loader.get_entry(donor_index)
            if self.cached:
                if donor["id"] not in self.verified_latents:
                    raise ValueError("Donor is not actually cache-qualified")
                lat = self.loader._load_latents(entry.latents_file)
                cut_frames, _ = self.loader._latent_cut(entry, lat.shape[0])
                if cut_frames <= 0:
                    raise ValueError("Donor has no independent aligned-prefix cut")
                prompt = self.loader._latent_prompt(lat, cut_frames)
                paired = (baseline[0], baseline[1], prompt, baseline[3], baseline[4])
                donor_frames = prompt.shape[0]
            else:
                from training.dataloader import audio
                chosen = self.loader._choose_cut(entry)
                if chosen is None:
                    raise ValueError("Donor has no independent aligned-prefix cut")
                cut, _ = chosen
                prompt, samples = self.loader._cap_prompt(audio._load_window(entry.path, entry.start, cut, self.loader.sample_rate))
                paired = (baseline[0], baseline[1], prompt, samples)
                donor_frames = max(1, int(samples * self.loader.frame_rate / self.loader.sample_rate))
        finally:
            self.loader.rng = saved
        if not 1 <= donor_frames <= int(self.loader.max_voice_prompt_sec * self.loader.frame_rate):
            raise ValueError("Donor escaped the actual 5-second codec frame cap")
        return paired, {**receipt, "mode": "cross-utterance", "donor_id": donor["id"], "donor_frames": donor_frames,
                        "donor_scene_policy": planned["donor_scene_policy"], "target_preserved": True,
                        "transcript_name_or_id_added": False}

    def batch(self, global_start):
        samples, receipts = [], []
        for global_index in range(global_start, global_start + self.args.batch_size):
            sample, receipt = self.sample_at(global_index)
            samples.append(sample)
            receipts.append(receipt)
        self.last_receipts = receipts
        batch = self.loader._collate(samples)
        if self.identity_policy is not None:
            import torch
            from pocket_tts.modules.voice_identity import independent_id_keep
            ids, mapping_sha256, dropout = self.identity_policy
            batch.speaker_ids = torch.tensor([ids[r["target_id"]] for r in receipts], dtype=torch.long)
            batch.speaker_id_keep = independent_id_keep(self.args.seed,
                [r["global_index"] for r in receipts], [r["target_id"] for r in receipts],
                mapping_sha256, dropout)
        return batch
