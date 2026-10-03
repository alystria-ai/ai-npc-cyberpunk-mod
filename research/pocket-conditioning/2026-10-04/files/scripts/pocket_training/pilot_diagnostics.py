"""Small, opt-in diagnostic panel for the matched500-update conditioning pilot.

This never selects a best model or grants final teacher/student acceptance.
The normal eighteen-probe teacher quality path remains in runner.py.
"""
from __future__ import annotations

from contextlib import nullcontext
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import time

VOICES = ["johnny-silverhand", "judy-alvarez", "panam-palmer", "jackie-welles", "evelyn-parker", "kerry-eurodyne", "misty-olszewski", "alex"]


def enabled(spec):
    return spec.raw.get("pilot_diagnostic_only") is True


def identity_fields(raw, base):
    from . import conditioning
    value = raw.get("speaker_conditioning")
    if not value or value["pilot_max_steps"] <= 1:
        return None
    if raw.get("pilot_diagnostic_only") is not True:
        raise ValueError("A conditioning pilot must explicitly be diagnostic-only")
    path = Path(raw["pilot_diagnostic_manifest"])
    path = path if path.is_absolute() else base / path
    if conditioning.file_hash(path) != raw["pilot_diagnostic_manifest_sha256"]:
        raise ValueError("Pilot diagnostic panel changed")
    panel = json.loads(path.read_text(encoding="utf-8"))
    rows = panel if isinstance(panel, list) else panel["references"]
    if isinstance(rows, dict):
        rows = list(rows.values())
    if [row["id"] for row in rows] != VOICES or any(len(row["texts"]) != 2 for row in rows):
        raise ValueError("Pilot panel must contain the exact8 known-ID voices and2 common prompts")
    if any(row["texts"] != rows[0]["texts"] for row in rows):
        raise ValueError("Pilot voices must use common prompts")
    audio_hashes = []
    for row in rows:
        audio = Path(row["path"])
        audio = audio if audio.is_absolute() else base / audio
        digest = conditioning.file_hash(audio)
        if digest != row["sha256"]:
            raise ValueError("Pilot reference audio changed")
        audio_hashes.append(digest)
    expected = [{"step": 0, "weights": ["ema"], "shared_across_arms": True},
        {"step": 250, "weights": ["raw"], "reference_ids": VOICES[:6], "text_indices": [0], "optional": True},
        {"step": 500, "weights": ["raw", "ema"]}]
    if value["pilot_max_steps"] != 500 or raw.get("pilot_diagnostic_schedule") != expected:
        raise ValueError("Diagnostic pilot schedule must be exactly shared0, optional raw250, raw+EMA500")
    if not raw.get("pilot_shared_initial_dir"):
        raise ValueError("Pilot needs an explicit common initial-panel result directory")
    for key, expected_value in (("sample_decode_steps", 2), ("sample_temperature", .3), ("sample_seed", 1337), ("sample_max_seconds", 30)):
        if raw.get(key) != expected_value:
            raise ValueError("Pilot teacher sampling must retain CFG2/decode2/temp.3/seed1337/max30s")
    return {"panel": raw["pilot_diagnostic_manifest"], "panel_sha256": raw["pilot_diagnostic_manifest_sha256"],
        "reference_audio_sha256": audio_hashes, "schedule": expected, "shared_initial_dir": raw["pilot_shared_initial_dir"],
        "implementation_sha256": conditioning.file_hash(__file__), "diagnostic_only": True, "automatic_promotion": False}


def _base_model_digest(model, stop):
    digest = hashlib.sha256()
    for name, tensor in sorted(model.flow_lm.state_dict().items()):
        if stop.requested():
            raise TimeoutError("Pilot diagnostic weight hashing interrupted")
        if name.startswith("voice_identity."):
            if bool((tensor != 0).any()):
                raise ValueError("Initial panel reuse requires an exactly zero new ID table")
            continue
        value = tensor.detach().cpu().contiguous()
        digest.update(name.encode() + b"\0" + str(value.dtype).encode() + b"\0")
        digest.update(str(tuple(value.shape)).encode() + b"\0" + value.numpy().tobytes())
    return digest.hexdigest()


def inspect_samples(spec, target, label, samples, stop):
    from . import runner, rollout
    import gc
    import torch
    processor = ctc = None
    inspected = []
    try:
        if spec.raw.get("align_model_dir"):
            processor, ctc = rollout._load_ctc(spec)
        for sample in samples:
            if stop.requested():
                raise TimeoutError("Pilot audio/wording inspection interrupted")
            path = target / "comparisons" / label / sample["audio"]
            if runner.sha256_file(path) != sample["audio_sha256"]:
                raise ValueError("Generated pilot WAV changed")
            measured = rollout.sample_diagnostics(sample, rollout._inspect_audio(path))
            if ctc is not None:
                transcript = rollout._transcribe(path, measured["measured_duration_seconds"], processor, ctc, torch)
                measured.update(transcript=transcript, word_errors=rollout.word_errors(sample["text"], transcript), asr_tentative=True)
            else:
                measured.update(word_errors=None, asr_status="pending_separate_qualification_no_local_asset")
            inspected.append(measured)
        return inspected
    finally:
        del processor, ctc
        gc.collect()


def run(spec, model, mimi, ema, device, step, stop, rank, world):
    from . import runner, conditioning
    if not enabled(spec):
        return
    matches = [entry for entry in spec.raw["pilot_diagnostic_schedule"] if entry["step"] == step]
    if not matches:
        return
    entry = matches[0]
    import torch
    failed = False
    if rank == 0:
        saved_rng = runner.capture_rng(torch, model)
        was_training = model.training
        try:
            arm = conditioning.options(spec)["arm"]
            panel_path = spec.asset("pilot_diagnostic_manifest")
            panel_spec = replace(spec, raw={**spec.raw, "reference_manifest": str(panel_path)})
            references = runner.references(panel_spec)
            if entry.get("optional") and stop.monotonic_deadline - time.monotonic() < 300:
                runner.atomic_json(spec.output / f"pilot-step{step:06d}-skipped.json", {"step": step, "reason": "less_than300seconds_remaining", "diagnostic_only": True})
            else:
                if entry.get("reference_ids"):
                    references = [r for r in references if r["id"] in entry["reference_ids"]]
                if entry.get("text_indices"):
                    references = [{**r, "texts": [r["texts"][i] for i in entry["text_indices"]]} for r in references]
                target = spec.output
                if step == 0:
                    target = runner.local_path(spec.base, spec.raw["pilot_shared_initial_dir"], exists=False)
                    if target == spec.base or target == spec.source or target in spec.source.parents or spec.source in target.parents:
                        raise ValueError("Shared pilot output cannot overwrite source or input root")
                    with runner.ema_weights(model, ema):
                        base_digest = _base_model_digest(model, stop)
                    shared_identity = {"base_weight_state_sha256": base_digest,
                        "teacher_anchor_sha256": spec.raw["teacher_anchor_expected_sha256"],
                        "panel_sha256": spec.raw["pilot_diagnostic_manifest_sha256"],
                        "reference_sha256": [r["sha256"] for r in references],
                        "sampler_sha256": runner.sha256_file(Path(runner.__file__)),
                        "source_digest": spec.raw["source_digest"], "diagnostic_code_sha256": conditioning.file_hash(__file__),
                        "cfg": 2., "decode_steps": 2, "temperature": .3, "seed": 1337, "max_seconds": 30}
                    shared_hash = hashlib.sha256(conditioning.encoded(shared_identity)).hexdigest()
                    receipt_path = target / "shared-initial.json"
                    if arm != "baseline":
                        shared = runner.read_json(receipt_path, {})
                        if shared.get("identity") != shared_identity or shared.get("identity_sha256") != shared_hash or len(shared.get("samples", [])) != 16:
                            raise ValueError("Shared initial baseline is absent or differs; no silent regeneration")
                        for sample in shared["samples"]:
                            if runner.sha256_file(target / "comparisons/pilot-step000000-ema" / sample["audio"]) != sample["audio_sha256"]:
                                raise ValueError("Shared initial baseline WAV changed")
                        runner.atomic_json(spec.output / "pilot-step000000-reuse.json", {"source": str(receipt_path),
                            "source_sha256": runner.sha256_file(receipt_path), "source_arm": "baseline", "zero_id_table": True,
                            "input_identity": spec.identity, "diagnostic_only": True, "automatic_promotion": False})
                        references = []
                if references:
                    target.mkdir(parents=True, exist_ok=True)
                    filtered = target / f"pilot-panel-step{step:06d}.json"
                    runner.atomic_json(filtered, {"references": references})
                    probe = replace(spec, output=target, raw={**spec.raw, "reference_manifest": str(filtered), "sample_decode_steps": 2})
                    for weight_kind in entry["weights"]:
                        label = f"pilot-step{step:06d}-{weight_kind}"
                        with runner.ema_weights(model, ema) if weight_kind == "ema" else nullcontext():
                            from .rollout import _state_digest
                            weights_hash = _state_digest(model.flow_lm, stop)
                            source_identity = shared_hash if step == 0 else spec.identity
                            selection = f"pilot:{source_identity}:{step}:{weight_kind}:{weights_hash}:{spec.raw['pilot_diagnostic_manifest_sha256']}"
                            complete = runner.generate_samples(probe, model, mimi, device, label, 2., stop,
                                selection_identity=selection, role="teacher")
                        if not complete:
                            raise TimeoutError("Pilot diagnostic generation interrupted")
                        samples = runner.read_json(target / "comparisons" / label / "samples.json", [])
                        expected_count = sum(len(r["texts"]) for r in references)
                        if len(samples) != expected_count:
                            raise ValueError("Pilot diagnostic sample coverage differs")
                        receipt = {"step": step, "weights": weight_kind, "input_identity": spec.identity,
                            "weights_sha256": weights_hash, "samples": samples, "cfg": 2., "decode_steps": 2,
                            "diagnostic_only": True, "automatic_promotion": False, "listening_qualified": False}
                        receipt["audio_and_word_diagnostics"] = inspect_samples(spec, target, label, samples, stop)
                        runner.atomic_json(spec.output / f"pilot-step{step:06d}-{weight_kind}.json", receipt)
                        if step == 0:
                            runner.atomic_json(receipt_path, {"identity": shared_identity, "identity_sha256": shared_hash,
                                "source_input_identity": spec.identity, "samples": samples, "diagnostic_only": True,
                                "raw_and_ema_identical_at_initialization": True})
                        if arm == "hybrid" and step == 500:
                            counter = [{**r, "texts": [r["texts"][0]]} for r in references if r["id"] in {"johnny-silverhand", "evelyn-parker"}]
                            counter_path = target / "pilot-ID-omitted-panel.json"
                            runner.atomic_json(counter_path, {"references": counter})
                            counter_spec = replace(probe, raw={**probe.raw, "reference_manifest": str(counter_path)})
                            counter_label = label + "-ID-omitted"
                            with runner.ema_weights(model, ema) if weight_kind == "ema" else nullcontext():
                                complete = runner.generate_samples(counter_spec, model, mimi, device, counter_label, 2., stop,
                                    selection_identity=selection + ":ID-omitted", role="teacher", id_conditioning_mode="omitted")
                            if not complete:
                                raise TimeoutError("ID-omitted counterfactual interrupted")
                            counter_samples = runner.read_json(target / "comparisons" / counter_label / "samples.json", [])
                            if len(counter_samples) != 2:
                                raise ValueError("Counterfactual coverage differs")
                            counter_receipt = {"step": step, "weights": weight_kind, "weights_sha256": weights_hash,
                                "same_ref_text_seed_weights_as": label, "ID_mode": "omitted", "samples": counter_samples,
                                "audio_and_word_diagnostics": inspect_samples(spec, target, counter_label, counter_samples, stop),
                                "scope": "conditioning effect only; no likeness or preference claim", "automatic_promotion": False}
                            runner.atomic_json(spec.output / f"pilot-step{step:06d}-{weight_kind}-ID-omitted.json", counter_receipt)
        except Exception as error:
            failed = True
            runner.atomic_json(spec.output / f"pilot-step{step:06d}-error.json", {"error_type": type(error).__name__, "error": str(error)})
        finally:
            model.train(was_training)
            runner.restore_rng(torch, model, saved_rng)
    if runner.distributed_any(torch, failed, device, world):
        raise RuntimeError("Conditioning pilot diagnostic failed; inspect exact step receipt")
    if world > 1:
        torch.distributed.barrier()
