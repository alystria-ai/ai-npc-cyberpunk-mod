"""Small, offline generated-speech diagnostics during student distillation.

The fixed Johnny/Judy/Panam references are conditioning/probe inputs, not the
heldout training split. ASR is an imperfect diagnostic of omitted words; these
receipts do not qualify voice similarity, naturalness, or release quality. The
caller owns rank synchronization, weight selection, and any stopping policy.
"""

from __future__ import annotations

from dataclasses import replace
import gc
import hashlib
import json
import math
from pathlib import Path
import re
import time
from typing import Any
import unicodedata

from . import runner

SCHEMA = 1
MAX_SECONDS = 30.0
ASR_NOTICE = "Tentative local ASR diagnostic; proper names, accents, and contractions can be misrecognized. Not a listening or voice-quality acceptance gate."


class _Stopped(Exception):
    pass


def normalized_words(text: str) -> list[str]:
    """Case/punctuation normalization, preserving words and joining apostrophes."""
    value = unicodedata.normalize("NFKC", str(text)).casefold().replace("’", "'")
    return [word.replace("'", "") for word in re.findall(r"[^\W_]+(?:'[^\W_]+)*", value)]


def word_errors(reference: str, hypothesis: str) -> dict[str, Any]:
    """Levenshtein word counts; WER may exceed one when there are insertions."""
    expected, observed = normalized_words(reference), normalized_words(hypothesis)
    # Cells hold (distance, substitutions, deletions, insertions). Prefer a
    # diagonal on equal cost, then deletion, so ambiguous alignments are stable.
    previous = [(i, 0, 0, i) for i in range(len(observed) + 1)]
    for i, word in enumerate(expected, 1):
        current = [(i, 0, i, 0)]
        for j, token in enumerate(observed, 1):
            diagonal = previous[j - 1]
            if word != token:
                diagonal = (diagonal[0] + 1, diagonal[1] + 1, diagonal[2], diagonal[3])
            before = previous[j]
            deletion = (before[0] + 1, before[1], before[2] + 1, before[3])
            before = current[j - 1]
            insertion = (before[0] + 1, before[1], before[2], before[3] + 1)
            current.append(min((diagonal, deletion, insertion), key=lambda item: item[0]))
        previous = current
    edits, substitutions, deletions, insertions = previous[-1]
    return {"reference_words": len(expected), "hypothesis_words": len(observed),
            "edits": edits, "substitutions": substitutions, "deletions": deletions,
            "insertions": insertions, "wer": edits / len(expected) if expected else None,
            "deletion_rate": deletions / len(expected) if expected else None,
            "normalized_reference": expected, "normalized_hypothesis": observed}


def summarize_samples(samples: list[dict[str, Any]], expected_samples: int) -> dict[str, Any]:
    """Aggregate word counts, never an unweighted average of per-line WER."""
    recognized = [sample["word_errors"] for sample in samples if isinstance(sample.get("word_errors"), dict)]
    totals = {name: sum(int(item[name]) for item in recognized) for name in (
        "reference_words", "hypothesis_words", "edits", "substitutions", "deletions", "insertions")}
    denominator = totals["reference_words"]
    generated = sum(not bool(sample.get("generation_failed")) for sample in samples)
    return {**totals, "wer": totals["edits"] / denominator if denominator else None,
            "deletion_rate": totals["deletions"] / denominator if denominator else None,
            "expected_samples": expected_samples, "generated_samples": generated,
            "transcribed_samples": len(recognized),
            "capped_samples": sum(bool(item.get("hit_frame_cap")) for item in samples),
            "finite_samples": sum(item.get("finite") is True for item in samples),
            "nonfinite_samples": sum(item.get("finite") is False for item in samples),
            "generation_failed_samples": sum(bool(item.get("generation_failed")) for item in samples),
            "invalid_audio_samples": sum(bool(item.get("audio_error")) for item in samples),
            "natural_eos_samples": sum(item.get("eos_natural") is True for item in samples),
            "premature_stop_suspected_samples": sum(bool(item.get("premature_stop_suspected")) for item in samples),
            "missing_samples": max(0, expected_samples - generated),
            "omitted_words_detected_samples": sum(item.get("word_errors", {}).get("deletions", 0) > 0 for item in samples),
            "asr_tentative": True}


def choose_references(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep manifest order among the requested cast; fall back if absent."""
    relevant = []
    for item in items:
        name = " ".join(str(item.get(key, "")) for key in ("id", "character", "name"))
        name = " ".join(normalized_words(name))
        if any(re.search(rf"\b{character}\b", name) for character in ("johnny", "judy", "panam")):
            relevant.append(item)
    return (relevant or items)[:3]


def sample_diagnostics(record: dict[str, Any], audio: dict[str, Any]) -> dict[str, Any]:
    """EOS is inferred from the pinned generator's sole EOS-or-cap exit path."""
    duration = float(audio.get("duration_seconds", 0))
    finite = bool(audio.get("finite", False))
    valid_duration = math.isfinite(duration) and duration > 0
    capped = bool(record.get("hit_frame_cap", False))
    natural = finite and valid_duration and not capped
    words = len(normalized_words(record.get("text", "")))
    # This intentionally conservative duration flag is descriptive. ASR errors
    # provide the separate omitted-word signal without asserting their cause.
    premature = natural and bool(words) and (duration < .8 or words > max(3, duration * 8))
    errors = []
    if not valid_duration:
        errors.append("empty_or_invalid_duration")
    if not finite:
        errors.append("nonfinite_pcm")
    if audio.get("wave_subtype") != "FLOAT":
        errors.append("unexpected_wave_subtype")
    if duration > MAX_SECONDS + .1:
        errors.append("audio_exceeds_generation_bound")
    return {**record, "finite": finite, "measured_duration_seconds": duration if math.isfinite(duration) else None,
            "eos_natural": natural, "eos_evidence": "inferred_from_official_generator_exit",
            "premature_stop_suspected": premature, "audio_error": errors or None}


def _state_digest(module: Any, stop: Any) -> str:
    """Hash only this module's exact state, without retaining a second model."""
    digest = hashlib.sha256()
    for name, tensor in sorted(module.state_dict().items()):
        if stop.requested():
            raise _Stopped()
        value = tensor.detach().cpu().contiguous()
        digest.update(json.dumps([name, str(value.dtype), list(value.shape)], separators=(",", ":")).encode() + b"\0")
        digest.update(value.numpy().tobytes())
    return digest.hexdigest()


def _weights_receipt(model: Any, stop: Any, weight_kind: str) -> dict[str, Any]:
    if weight_kind not in ("raw", "ema"):
        raise ValueError("rollout_weight_kind must be raw or ema")
    teacher = getattr(model, "distill_teacher", None)
    if teacher is None:
        raise ValueError("The student rollout requires its frozen distillation teacher")
    heads = {}
    for name in ("flow_net", "out_eos"):
        head, source = getattr(model.flow_lm, name), getattr(teacher, name)
        if any(parameter.requires_grad for parameter in head.parameters()):
            raise ValueError(f"Student {name} must remain frozen during rollout")
        if any(parameter.requires_grad for parameter in source.parameters()):
            raise ValueError(f"Teacher {name} must remain frozen during rollout")
        student_hash, teacher_hash = _state_digest(head, stop), _state_digest(source, stop)
        if student_hash != teacher_hash:
            raise ValueError(f"Student {name} differs from the frozen teacher-copy head")
        heads[name] = {"frozen": True, "teacher_copy_identical": True, "state_sha256": student_hash}
    return {"weights": weight_kind, "ema_applied_by_helper": False,
            "weight_kind_declared_by_caller": True,
            "flow_lm_state_sha256": _state_digest(model.flow_lm, stop), "frozen_heads": heads}


def _capture_modes(model: Any, mimi: Any) -> list[tuple[Any, bool]]:
    modules, seen = [], set()
    for root in (model, mimi, getattr(model, "distill_teacher", None)):
        if root is None:
            continue
        for module in root.modules():
            if id(module) not in seen:
                seen.add(id(module))
                modules.append((module, module.training))
    return modules


def _inspect_audio(path: Path) -> dict[str, Any]:
    import numpy as np
    import soundfile as sf
    import sphn

    pcm, sample_rate = sphn.read(str(path))
    return {"finite": bool(np.isfinite(pcm).all()), "duration_seconds": pcm.shape[-1] / sample_rate,
            "sample_rate": sample_rate, "wave_subtype": sf.info(str(path)).subtype}


def _load_ctc(spec: Any) -> tuple[Any, Any]:
    from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

    if not spec.raw.get("align_model_dir"):
        raise ValueError("Rollout ASR requires a staged local align_model_dir; no download is allowed")
    path = spec.asset("align_model_dir")
    processor = Wav2Vec2Processor.from_pretrained(str(path), local_files_only=True)
    model = Wav2Vec2ForCTC.from_pretrained(str(path), local_files_only=True).float().to("cpu").eval()
    return processor, model


def _transcribe(path: Path, duration: float, processor: Any, ctc: Any, torch: Any) -> str:
    from training.dataloader.audio import _load_window

    sample_rate = int(processor.feature_extractor.sampling_rate)
    wav = _load_window(str(path), 0, duration, sample_rate)
    if not len(wav) or not torch.isfinite(torch.from_numpy(wav)).all():
        raise ValueError("Invalid audio supplied to local rollout ASR")
    inputs = processor(wav, sampling_rate=sample_rate, return_tensors="pt")
    with torch.no_grad(), torch.autocast(device_type="cpu", enabled=False):
        logits = ctc(**inputs).logits.float()
        if not torch.isfinite(logits).all():
            raise RuntimeError("Local rollout ASR produced nonfinite logits")
        return str(processor.batch_decode(logits.argmax(dim=-1))[0]).strip()


def evaluate_rollout(spec: Any, model: Any, mimi: Any, device: Any, step: int, stop: Any) -> dict[str, Any]:
    """Generate and transcribe a bounded CFG1 student probe on rank zero.

    All train/eval flags (including individually frozen/eval children), CPU and
    current CUDA/Python/model RNG, NumPy RNG, and Torch CPU thread count are
    restored even on cancellation or failure. This function does not mutate
    weights, apply EMA, select checkpoints, or cancel the training run.
    """
    import numpy as np
    import torch

    if isinstance(step, bool) or not isinstance(step, int) or step < 0:
        raise ValueError("Rollout step must be a nonnegative integer")
    weight_kind = str(spec.option("rollout_weight_kind", "raw"))
    if weight_kind not in ("raw", "ema"):
        raise ValueError("rollout_weight_kind must be raw or ema")
    label = f"rollout-step{step:06d}-{weight_kind}"
    folder = spec.output / "comparisons" / label
    folder.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    receipt: dict[str, Any] = {
        "schema": SCHEMA, "input_identity": spec.identity, "source_revision": runner.PINNED_REVISION,
        "source_digest": spec.raw.get("source_digest"),
        "step": step, "label": label, "status": "running", "cfg": 1.0, "weights": weight_kind,
        "max_audio_seconds": MAX_SECONDS, "postprocessing": "none", "wave_subtype": "FLOAT",
        "asr_device": "cpu", "asr_threads": 2, "local_assets_only": True,
        "asr_tentative": True, "asr_notice": ASR_NOTICE, "listening_qualified": False,
        "voice_similarity_qualified": False, "quality_acceptance": False,
        "samples": [], "failure_reasons": [], "score": None, "expected_samples": 0,
    }
    rng = runner.capture_rng(torch, model)
    numpy_rng, old_threads = np.random.get_state(), torch.get_num_threads()
    modes = _capture_modes(model, mimi)
    processor = ctc = None
    try:
        if stop.requested():
            raise _Stopped()
        receipt.update(_weights_receipt(model, stop, weight_kind))
        selected = choose_references(runner.references(spec))
        expected = {(item["id"], index): text for item in selected for index, text in enumerate(item["texts"])}
        receipt["expected_samples"] = len(expected)
        receipt["reference_ids"] = [item["id"] for item in selected]
        receipt["reference_manifest_sha256"] = runner.sha256_file(spec.asset("reference_manifest"))
        manifest = folder / "references.json"
        runner.atomic_json(manifest, {"references": selected})
        probe = replace(spec, raw={**spec.raw, "reference_manifest": str(manifest), "sample_max_seconds": MAX_SECONDS})
        identity = {key: receipt[key] for key in ("input_identity", "step", "weights", "flow_lm_state_sha256", "reference_manifest_sha256")}
        identity.update(reference_ids=receipt["reference_ids"], cfg=1, max_seconds=MAX_SECONDS,
                        sample_seed=spec.option("sample_seed", 1337), sample_temperature=spec.option("sample_temperature", .3))
        selection = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        receipt["selection_identity"] = selection
        mimi.eval()
        generation_error = None
        try:
            generated = runner.generate_samples(probe, model, mimi, device, label, 1.0, stop,
                                                selection_identity=selection, limit_references=3)
            if not generated:
                raise _Stopped()
        except _Stopped:
            raise
        except Exception as exc:
            generation_error = {"type": type(exc).__name__, "message": str(exc)[:800]}
            receipt["generation_error"] = generation_error
            receipt["failure_reasons"].append("generation_failed")
        records = runner.read_json(folder / "samples.json", [])
        seen = set()
        for record in records:
            if stop.requested():
                raise _Stopped()
            key = (record.get("reference_id"), record.get("text_index"))
            if key not in expected or key in seen or record.get("selection_identity") != selection or record.get("text") != expected[key]:
                raise ValueError("Rollout sample does not match its exact selected probe")
            seen.add(key)
            name = record.get("audio", "")
            if not isinstance(name, str) or Path(name).name != name or not name.endswith(".wav"):
                raise ValueError("Rollout audio must be a WAV directly inside its owned comparison directory")
            path = folder / name
            if runner.sha256_file(path) != record.get("audio_sha256"):
                raise ValueError("Rollout audio hash changed after generation")
            sample = sample_diagnostics(record, _inspect_audio(path))
            sample["generation_failed"] = False
            receipt["samples"].append(sample)
        if generation_error:
            first_missing = True
            error_message = generation_error["message"].casefold()
            for key, text in expected.items():
                if key in seen:
                    continue
                # Only the first missing entry is known to have raised. Later
                # entries were never attempted, so do not invent PCM/EOS data.
                actual_error = first_missing
                sample = {"reference_id": key[0], "text_index": key[1], "text": text,
                    "selection_identity": selection, "generation_failed": True,
                    "sample_status": "generation_failed" if actual_error else "not_attempted_after_generation_failure",
                    "finite": False if actual_error and "non-finite" in error_message and "empty" not in error_message else None,
                    "eos_natural": None, "hit_frame_cap": None,
                    "premature_stop_suspected": actual_error and "empty" in error_message,
                    "generation_error": generation_error if actual_error else None}
                receipt["samples"].append(sample)
                first_missing = False
        if any(sample.get("finite") and not sample.get("audio_error") and not sample.get("generation_failed") for sample in receipt["samples"]) and not stop.requested():
            torch.set_num_threads(2)
            processor, ctc = _load_ctc(spec)
            for sample in receipt["samples"]:
                if stop.requested():
                    raise _Stopped()
                if not sample.get("finite") or sample.get("audio_error") or sample.get("generation_failed"):
                    continue
                try:
                    sample["transcript"] = _transcribe(folder / sample["audio"], sample["measured_duration_seconds"], processor, ctc, torch)
                    sample["word_errors"] = word_errors(sample["text"], sample["transcript"])
                    sample["asr_tentative"] = True
                except Exception as exc:
                    sample["asr_error"] = {"type": type(exc).__name__, "message": str(exc)[:800]}
                runner.atomic_json(folder / "transcripts.json", {"selection_identity": selection,
                    "asr_tentative": True, "asr_notice": ASR_NOTICE, "samples": receipt["samples"]})
        receipt["status"] = "failed" if generation_error else "completed"
    except _Stopped:
        receipt.update(status="paused", stop_reason=str(getattr(stop, "reason", "owner_stop")))
        # Generation writes its manifest after every completed WAV. Preserve
        # that evidence when an owner stop arrives before our inspection/ASR;
        # do not spend the cancellation reserve reopening or hashing audio.
        if receipt.get("selection_identity"):
            seen = {(item.get("reference_id"), item.get("text_index")) for item in receipt["samples"]}
            for record in runner.read_json(folder / "samples.json", []):
                key = (record.get("reference_id"), record.get("text_index"))
                if key in seen or record.get("selection_identity") != receipt["selection_identity"]:
                    continue
                receipt["samples"].append({**record, "generation_failed": False,
                    "sample_status": "uninspected_after_stop", "finite": None, "eos_natural": None,
                    "premature_stop_suspected": False})
                seen.add(key)
    except Exception as exc:
        receipt.update(status="failed", error={"type": type(exc).__name__, "message": str(exc)[:800]})
        receipt["failure_reasons"].append("evaluation_failed")
    finally:
        # Direct assignment preserves children that were in eval while their
        # parent was in train, unlike a recursive model.train(original_flag).
        for module, training in modes:
            module.training = training
        runner.restore_rng(torch, model, rng)
        np.random.set_state(numpy_rng)
        torch.set_num_threads(old_threads)
        del processor, ctc
        gc.collect()
    aggregate = summarize_samples(receipt["samples"], receipt["expected_samples"])
    receipt["aggregate"] = aggregate
    receipt["score"] = aggregate["wer"] if receipt["status"] == "completed" and aggregate["transcribed_samples"] == receipt["expected_samples"] else None
    for count, reason in (("capped_samples", "frame_cap"), ("nonfinite_samples", "nonfinite_pcm"),
                          ("invalid_audio_samples", "invalid_audio"), ("missing_samples", "missing_samples"),
                          ("premature_stop_suspected_samples", "premature_stop_suspected")):
        if aggregate[count]:
            receipt["failure_reasons"].append(reason)
    if aggregate["transcribed_samples"] != receipt["expected_samples"]:
        receipt["failure_reasons"].append("incomplete_asr")
        if receipt["status"] == "completed":
            receipt["status"] = "failed"
    receipt["failure_reasons"] = sorted(set(receipt["failure_reasons"]))
    receipt["diagnostic_failure"] = bool(receipt["failure_reasons"])
    receipt["elapsed_seconds"] = time.monotonic() - started
    runner.atomic_json(folder / "transcripts.json", {"selection_identity": receipt.get("selection_identity"),
        "asr_tentative": True, "asr_notice": ASR_NOTICE, "samples": receipt["samples"]})
    runner.atomic_json(folder / "metrics.json", receipt)
    print(json.dumps({"event": "student_rollout", "step": step, "label": label,
        "status": receipt["status"], "weights": receipt.get("weights"), "wer": aggregate["wer"],
        "deletion_rate": aggregate["deletion_rate"], "capped": aggregate["capped_samples"],
        "premature_suspected": aggregate["premature_stop_suspected_samples"],
        "failure_reasons": receipt["failure_reasons"], "asr_tentative": True}, allow_nan=False), flush=True)
    return receipt
