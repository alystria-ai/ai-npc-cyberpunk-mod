"""Explicit qualified-corpus transfer from an accepted student to a new teacher.

Numeric eligibility selects a listening candidate, never a runtime replacement.
The old student's complete FlowLM is a separate control from step zero, whose
heads have already been replaced by the new teacher in the upstream builder.
"""
from contextlib import contextmanager
import hashlib
import math
from pathlib import Path
from typing import Any

POLICY = "qualified_macro_student_transfer_v1"


def enabled(spec: Any) -> bool:
    return spec.raw.get("student_transfer_policy") == POLICY


def identity_fields(raw: dict, identities: dict, base: Path) -> dict:
    """Bind the entire opt-in recipe, source closure and immutable controls."""
    from . import runner, rollout, teacher_data, teacher_quality, teacher_overlay, conditioning, control_weights
    if raw.get("student_transfer_policy") != POLICY:
        raise ValueError("Unknown student transfer policy")
    if raw.get("teacher_quality_policy") is not None or raw.get("teacher_only_evaluation", False):
        raise ValueError("Student transfer is a separate role, not a teacher improvement run")
    for key in ("teacher_corpus_receipt", "teacher_regression_manifest", "teacher_conditional_manifest",
                "student_anchor_weights", "student_anchor_receipt"):
        identities[key + "_sha256"] = runner.sha256_file(runner.local_path(base, raw[key]))
    receipt = runner.read_json(runner.local_path(base, raw["student_anchor_receipt"]))
    expected_sha = raw["student_anchor_expected_sha256"]
    if (receipt.get("source_revision") != runner.PINNED_REVISION or receipt.get("weights") != "ema"
            or receipt.get("sample_cfg") != 1 or receipt.get("selected_step") != raw["student_anchor_selected_step"]
            or receipt.get("input_identity") != raw["student_anchor_input_identity"]
            or receipt.get("model_sha256") != expected_sha
            or identities["student_anchor_weights_sha256"] != expected_sha
            or identities["student_weight_sha256"] != expected_sha
            or identities.get("student_init_from_sha256") != expected_sha):
        raise ValueError("Student transfer must start from its exact immutable accepted student")
    imported = runner.read_json(runner.local_path(base, raw["import_teacher_receipt"]))
    for field, expected in (("model_sha256", "import_teacher_expected_sha256"),
                            ("source_checkpoint_sha256", "import_teacher_expected_checkpoint_sha256"),
                            ("input_identity", "import_teacher_expected_input_identity"),
                            ("selected_step", "import_teacher_expected_step")):
        if imported.get(field) != raw[expected]:
            raise ValueError("Imported teacher selection differs from the declared accepted teacher")
    if (identities.get("import_teacher_weights_sha256") != raw["import_teacher_expected_sha256"]
            or identities.get("teacher_weight_sha256") != raw["import_teacher_expected_sha256"]
            or identities.get("import_teacher_checkpoint_sha256") != raw["import_teacher_expected_checkpoint_sha256"]):
        raise ValueError("Imported teacher assets differ from the accepted source hashes")
    for key in ("teacher_dev_expected_speakers", "teacher_conditional_expected_speakers"):
        values = raw.get(key)
        if not isinstance(values, list) or not values or len(set(values)) != len(values) or "unknown" in values:
            raise ValueError("Student macro panels need exact speaker coverage")
    if (raw.get("teacher_sample_decode_steps") != 2 or raw.get("student_sample_decode_steps") != 1
            or raw.get("speaker_balanced_sampling", False) is not False):
        raise ValueError("Student transfer requires teacher LSD2, student LSD1 and uniform clip sampling")
    if raw.get("rollout_steps") != conditioning.stage_rollout_steps(raw, "distill", [0, 250, 500, 1000, 1500, 2000]):
        raise ValueError("Student transfer needs its complete declared speech probe schedule")
    for key, default in (("minimum_relative_improvement", .002), ("distill_old_dev_regression_limit", .03),
                         ("distill_conditional_regression_limit", .03)):
        value = float(raw.get(key, default))
        if not math.isfinite(value) or not 0 <= value < 1:
            raise ValueError("Student candidate thresholds must be finite proportions")
    # Original policies retain their old identities. This new explicit policy
    # hashes every optimization/data/sampling knob, including default overrides,
    # and every local runner component which can affect training or selection.
    modules = (runner, rollout, teacher_data, teacher_quality, teacher_overlay, control_weights)
    return {"configuration": {key: value for key, value in raw.items()
                              if key not in ("output_dir", "resume_dir")},
            "source_sha256": {Path(module.__file__).name: runner.sha256_file(Path(module.__file__))
                              for module in modules},
            "policy_source_sha256": runner.sha256_file(Path(__file__))}


def selected_teacher_state(payload: dict, receipt: dict, checkpoint_sha: str) -> tuple[dict, str]:
    """Upstream accepts a dict EMA overlay or an explicitly flattened EMA.

    A flattened quality-best checkpoint has no EMA dictionary: its model is
    already the selected EMA. Do not fabricate one by reusing older shadows.
    """
    if (payload.get("step") != receipt.get("selected_step")
            or payload.get("runner", {}).get("input_identity") != receipt.get("input_identity")):
        raise ValueError("Imported teacher checkpoint does not match its selected export")
    ema = payload.get("ema")
    if isinstance(ema, dict) and ema:
        if receipt.get("source_checkpoint_sha256") and receipt["source_checkpoint_sha256"] != checkpoint_sha:
            raise ValueError("Imported teacher checkpoint hash differs from the original export")
        return {**payload["model"], **ema}, "dict_ema"
    if (ema is not None or payload.get("runner", {}).get("selection_weights") != "ema"
            or receipt.get("source_checkpoint_sha256") != checkpoint_sha):
        raise ValueError("Flattened teacher needs its exact selected EMA checkpoint receipt")
    return dict(payload["model"]), "flattened_selected_ema"


def transfer_receipt(model: Any, stop: Any) -> dict:
    """Inspect actual frozen tensors, including calibration, not just flags."""
    import torch
    from .rollout import _state_digest
    from types import SimpleNamespace
    # This short tensor proof is collective-independent. A rank-local stop
    # cannot make one rank leave before the caller's next stop collective.
    proof_stop = SimpleNamespace(requested=lambda: False)
    teacher = getattr(model, "distill_teacher", None)
    if teacher is None or any(p.requires_grad for p in teacher.parameters()):
        raise ValueError("Student transfer needs the actual frozen teacher")
    result = {}
    for name in ("flow_net", "out_eos"):
        student, source = getattr(model.flow_lm, name), getattr(teacher, name)
        if any(p.requires_grad for p in student.parameters()):
            raise ValueError("Student transferred heads must remain frozen")
        state, original = student.state_dict(), source.state_dict()
        if set(state) != set(original) or any(state[key].dtype != original[key].dtype
                or not torch.equal(state[key], original[key]) for key in state):
            raise ValueError("Student transferred head tensor differs from the accepted teacher")
        result[name] = {"frozen": True, "teacher_copy_identical": True, "state_sha256": _state_digest(student, proof_stop)}
    for name in ("emb_mean", "emb_std"):
        a, b = getattr(model.flow_lm, name), getattr(teacher, name)
        if a.dtype != b.dtype or not torch.equal(a, b):
            raise ValueError("Student transferred calibration differs from the frozen teacher")
        result[name] = {"teacher_copy_identical": True, "dtype": str(a.dtype), "shape": list(a.shape),
                        "tensor_bytes_sha256": hashlib.sha256(a.detach().cpu().contiguous().numpy().tobytes()).hexdigest()}
    return result


@contextmanager
def accepted_student_weights(spec: Any, model: Any, mimi: Any, device: Any, rank: int, world: int):
    """Restore the exact accepted student only inside its separate control."""
    from dataclasses import replace
    from .teacher_overlay import comparison_weights
    control = replace(spec, raw={**spec.raw, "teacher_comparison_weights": str(spec.asset("student_anchor_weights"))})
    with comparison_weights(control, model, mimi, device, rank, world,
                            expected_weight_sha256=spec.raw["student_anchor_expected_sha256"]) as receipt:
        yield receipt


def candidate_reasons(panels: dict, anchor: dict, speech: dict, *, minimum_improvement=.002,
                      regression_limit=.03, conditional_limit=.03) -> list[str]:
    from . import teacher_quality
    reasons = []
    dev, base = panels["dev"], anchor["hybrid"]["dev"]
    if set(dev.get("speaker_scores", {})) != set(base.get("speaker_scores", {})):
        reasons.append("development_speaker_coverage_changed")
    if not dev["score"] < base["score"] - max(abs(base["score"]) * minimum_improvement, 1e-8):
        reasons.append("no_macro_student_mse_improvement")
    for panel, limit in (("old_dev", regression_limit), ("conditional", conditional_limit)):
        now, old = panels[panel], anchor["hybrid"][panel]
        if now.get("sample_ids_sha256") != old.get("sample_ids_sha256"):
            reasons.append(panel + "_panel_changed")
        if panel == "conditional" and set(now.get("speaker_scores", {})) != set(old.get("speaker_scores", {})):
            reasons.append("conditional_speaker_coverage_changed")
        if now["score"] > old["score"] * (1 + limit):
            reasons.append(panel + "_student_mse_regression")
    if not teacher_quality.speech_complete(speech, anchor["accepted"]["speech"]):
        reasons.append("accepted_student_speech_completeness_regression")
    return reasons


def speech(spec: Any, model: Any, mimi: Any, device: Any, step: int, stop: Any,
           rank: int, world: int, *, kind="ema", accepted=False) -> dict:
    import torch
    from . import runner, rollout
    if runner.distributed_any(torch, stop.requested(), device, world):
        return {"status": "paused", "aggregate": {}, "diagnostic_failure": True}
    result, failed = None, False
    if rank == 0:
        previous = spec.raw.get("rollout_weight_kind")
        try:
            spec.raw["rollout_weight_kind"] = kind
            result = rollout.evaluate_rollout(spec, model, mimi, device, step, stop,
                role="accepted_student" if accepted else "student",
                label_prefix="accepted-student-control" if accepted else None)
        except Exception as exc:
            failed = True
            try:
                runner.atomic_json(spec.output / "distill/quality-error.json", {"step": step, "error_type": type(exc).__name__,
                                                                              "message": str(exc)[:1000]})
            except OSError:
                pass  # All ranks still reach the common failure collective.
        finally:
            if previous is None:
                spec.raw.pop("rollout_weight_kind", None)
            else:
                spec.raw["rollout_weight_kind"] = previous
    if runner.distributed_any(torch, failed, device, world):
        raise RuntimeError("Student transfer speech probe failed")
    if world > 1:
        values = [result]
        torch.distributed.broadcast_object_list(values, src=0)
        result = values[0]
    return result


def anchor(spec: Any, model: Any, mimi: Any, ema: Any, args: Any, device: Any,
           rank: int, world: int, stop: Any, start_step: int) -> dict | None:
    import torch
    from . import runner, teacher_quality
    path = spec.output / "distill/quality-anchor.json"
    if start_step:
        existing = runner.read_json(path, {})
        if (existing.get("input_identity") != spec.identity
                or existing.get("accepted_student_weights_sha256") != spec.raw["student_anchor_expected_sha256"]
                or existing.get("target_teacher_weights_sha256") != spec.raw["import_teacher_expected_sha256"]):
            raise ValueError("Student transfer resume requires the exact original dual control")
        return existing
    with accepted_student_weights(spec, model, mimi, device, rank, world) as control_receipt:
        accepted_panels = runner.teacher_panel_scores(spec, model, mimi, args, device, rank, world, stop)
        if accepted_panels is None:
            return None
        accepted_speech = speech(spec, model, mimi, device, 0, stop, rank, world, accepted=True)
    with runner.ema_weights(model, ema):
        transfer = transfer_receipt(model, stop)
        hybrid_panels = runner.teacher_panel_scores(spec, model, mimi, args, device, rank, world, stop)
        if hybrid_panels is None:
            return None
        hybrid_speech = speech(spec, model, mimi, device, 0, stop, rank, world)
    if runner.distributed_any(torch, stop.requested(), device, world):
        return None
    if not teacher_quality.speech_complete(accepted_speech) or not teacher_quality.speech_complete(hybrid_speech):
        raise ValueError("Accepted student and hybrid step-zero controls must complete all eighteen probes")
    result = {"input_identity": spec.identity, "new_run_step": 0,
              "accepted_student_weights_sha256": spec.raw["student_anchor_expected_sha256"],
              "target_teacher_weights_sha256": spec.raw["import_teacher_expected_sha256"],
               "accepted": {**accepted_panels, "speech": accepted_speech, "heads": "original_accepted_student",
                            "control_weight_receipt": control_receipt},
              "hybrid": {**hybrid_panels, "speech": hybrid_speech, "heads": "new_frozen_teacher_copy"},
              "transferred_tensors": transfer, "listening_qualified": False}
    runner.teacher_rank_zero_commit(lambda: runner.atomic_json(path, result), device, rank, world)
    return result


def check(spec: Any, model: Any, mimi: Any, ema: Any, args: Any, device: Any,
          rank: int, world: int, step: int, stop: Any, original: dict, dev: dict) -> None:
    import torch
    from . import runner
    if step not in spec.option("rollout_steps", []):
        return
    with runner.ema_weights(model, ema):
        transfer = transfer_receipt(model, stop)
        panels = runner.teacher_panel_scores(spec, model, mimi, args, device, rank, world, stop, dev)
        if panels is None:
            return
        spoken = speech(spec, model, mimi, device, step, stop, rank, world)
        if runner.distributed_any(torch, stop.requested(), device, world):
            return
        reasons = candidate_reasons(panels, original, spoken,
            minimum_improvement=float(spec.option("minimum_relative_improvement", .002)),
            regression_limit=float(spec.option("distill_old_dev_regression_limit", .03)),
            conditional_limit=float(spec.option("distill_conditional_regression_limit", .03)))
        def commit():
            record = {"input_identity": spec.identity, "step": step, "weights": "ema", **panels,
                      "transferred_tensors": transfer, "speech_selection_identity": spoken.get("selection_identity"),
                      "rejection_reasons": reasons, "numeric_candidate": not reasons, "listening_qualified": False,
                      "automatic_promotion": False, "student_transfer_policy": POLICY}
            destination = spec.output / "distill/quality-best.pt"
            prior = runner.read_json(destination.with_suffix(".json"), {})
            if not reasons and panels["dev"]["score"] < prior.get("dev", {}).get("score", float("inf")):
                payload = {"step": step, "model": runner.cpu_tree(model.state_dict(), torch), "ema": None,
                           "runner": {"schema": runner.SCHEMA, "input_identity": spec.identity, "selection_weights": "ema",
                                      "selection_metrics": record, "validated_probe_count": 18}}
                runner.atomic_torch_save(destination, payload, spec)
                record["checkpoint_sha256"] = runner.sha256_file(destination)
                runner.atomic_json(destination.with_suffix(".json"), record)
            runner.atomic_json(spec.output / f"distill/quality-step{step:06d}.json", record)
        runner.teacher_rank_zero_commit(commit, device, rank, world)
    if not runner.distributed_any(torch, stop.requested(), device, world):
        speech(spec, model, mimi, device, step, stop, rank, world, kind="raw")


def verify_export(spec: Any, model: Any, mimi: Any, *, export_path: Path | None = None) -> dict:
    """Before export, compare selected heads/calibration to the frozen target."""
    import safetensors
    import torch
    from .rollout import _state_digest
    from types import SimpleNamespace
    flow = model.flow_lm.state_dict()
    selected = [key for key in flow if key.startswith(("flow_net.", "out_eos.")) or key in ("emb_mean", "emb_std")]
    with safetensors.safe_open(str(spec.asset("import_teacher_weights")), framework="pt", device="cpu") as source:
        for key in selected:
            tensor, original = flow[key].detach().cpu(), source.get_tensor("flow_lm." + key)
            if tensor.dtype != original.dtype or not torch.equal(tensor, original):
                raise ValueError("Student export changed its transferred teacher head or calibration")
        codec = mimi.state_dict()
        if {key.removeprefix("mimi.") for key in source.keys() if key.startswith("mimi.")} != set(codec):
            raise ValueError("Student export codec inventory differs from its teacher")
        if any(value.dtype != source.get_tensor("mimi." + key).dtype
               or not torch.equal(value.detach().cpu(), source.get_tensor("mimi." + key)) for key, value in codec.items()):
            raise ValueError("Student export codec differs from its teacher")
        if export_path is not None:
            with safetensors.safe_open(str(export_path), framework="pt", device="cpu") as actual:
                for key in selected:
                    saved, original = actual.get_tensor("flow_lm." + key), source.get_tensor("flow_lm." + key)
                    if saved.dtype != original.dtype or not torch.equal(saved, original):
                        raise ValueError("Serialized student export changed a transferred teacher tensor")
                for key in codec:
                    saved, original = actual.get_tensor("mimi." + key), source.get_tensor("mimi." + key)
                    if saved.dtype != original.dtype or not torch.equal(saved, original):
                        raise ValueError("Serialized student export changed the frozen codec")
    stop = SimpleNamespace(requested=lambda: False)
    return {"target_teacher_weights_sha256": spec.raw["import_teacher_expected_sha256"],
            "flow_net_state_sha256": _state_digest(model.flow_lm.flow_net, stop),
            "out_eos_state_sha256": _state_digest(model.flow_lm.out_eos, stop),
            "calibration_and_codec_identical": True, "serialized_export_verified": export_path is not None}
