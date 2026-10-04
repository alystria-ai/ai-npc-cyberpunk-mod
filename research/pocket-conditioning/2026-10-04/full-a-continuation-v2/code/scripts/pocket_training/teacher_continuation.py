"""Patient A-only continuation policy; numeric recipes are supplied by the final corpus owner."""
from __future__ import annotations
from contextlib import nullcontext
import hashlib
import json
import math
from pathlib import Path
import time
import uuid

POLICY = "patient_audio_reference_teacher_v1"
STUDENT_POLICY = "patient_audio_reference_student_v1"


def enabled(spec, stage="teacher"):
    key, policy = ("teacher_continuation", POLICY) if stage == "teacher" else ("student_continuation", STUDENT_POLICY)
    return spec.raw.get(key, {}).get("policy") == policy


def settings(spec, stage="teacher"):
    return spec.raw["teacher_continuation" if stage == "teacher" else "student_continuation"]


def file_sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def identity_fields(raw, stage="teacher"):
    if stage not in ("teacher", "distill"):
        raise ValueError("Unknown continuation stage")
    policy_key, expected_policy = ("teacher_continuation", POLICY) if stage == "teacher" else ("student_continuation", STUDENT_POLICY)
    policy = raw.get(policy_key)
    if policy is None:
        return None
    required = {"policy", "minimum_corpus_passes", "minimum_speech_evaluations", "stop_on_plateau",
                "plateau_patience", "candidate_weights", "keep_candidates", "per_speaker_regression_limits"}
    if set(policy) != required or policy["policy"] != expected_policy:
        raise ValueError("Unknown or incomplete A-only continuation policy")
    if raw.get("speaker_conditioning") is not None or raw.get("pilot_diagnostic_only"):
        raise ValueError("Full A continuation cannot use a speaker-ID or diagnostic-pilot policy")
    if raw.get("precision") not in ("fp16", "bf16", "fp32") or type(raw.get("allow_fp32_fallback")) is not bool:
        raise ValueError("Continuation precision and fallback policy must be explicit")
    for name in (*(stage + "_" + suffix for suffix in ("max_steps", "schedule_steps", "min_steps", "warmup_steps")),
                 "valid_freq", "ckpt_freq", "checkpoint_seconds", "checkpoint_reserve_seconds"):
        if type(raw.get(name)) is not int or raw[name] < 1:
            raise ValueError("Final corpus recipe must explicitly provide " + name)
    for name in (stage+"_learning_rate", stage+"_ema_decay", "minimum_relative_improvement",
                 stage+"_old_dev_regression_limit", stage+"_conditional_regression_limit"):
        if type(raw.get(name)) not in (int, float) or not math.isfinite(raw[name]):
            raise ValueError("Final corpus recipe must explicitly provide finite " + name)
    if not 0 < raw[stage+"_learning_rate"] or not 0 < raw[stage+"_ema_decay"] < 1:
        raise ValueError("Invalid learning rate or EMA decay")
    schedule = raw.get(stage+"_learning_rate_schedule")
    if schedule not in ("constant", "cosine"):
        raise ValueError("Declare the learning-rate schedule; do not inherit a pilot schedule")
    if schedule == "cosine" and (type(raw.get(stage+"_lr_min_ratio")) not in (int, float)
            or not math.isfinite(raw[stage+"_lr_min_ratio"]) or not 0 <= raw[stage+"_lr_min_ratio"] <= 1):
        raise ValueError("Cosine continuation needs an explicit final LR ratio")
    if (type(policy["minimum_corpus_passes"]) not in (int, float)
            or not math.isfinite(policy["minimum_corpus_passes"]) or policy["minimum_corpus_passes"] <= 0
            or type(policy["stop_on_plateau"]) is not bool):
        raise ValueError("Explicit minimum exposure and plateau choice required")
    for key in ("minimum_speech_evaluations", "plateau_patience", "keep_candidates"):
        if type(policy[key]) is not int or policy[key] < 2:
            raise ValueError("Patient continuation needs multiple evaluations/candidates: " + key)
    kinds = policy["candidate_weights"]
    if not isinstance(kinds, list) or not kinds or len(set(kinds)) != len(kinds) or not set(kinds) <= {"ema", "raw"}:
        raise ValueError("Candidate weight kinds must explicitly name EMA and/or raw")
    steps = raw.get("teacher_rollout_steps" if stage == "teacher" else "rollout_steps")
    if (not isinstance(steps, list) or len(steps) < 3 or any(type(x) is not int or x < 0 for x in steps)
            or steps != sorted(set(steps)) or steps[0] != 0 or steps[-1] != raw[stage+"_max_steps"]):
        raise ValueError("Speech evaluation schedule must include baseline, intermediate and final checkpoints")
    expected = raw.get("teacher_reference_expectations" if stage == "teacher" else "student_reference_expectations")
    if not isinstance(expected, dict) or not expected or any(not isinstance(k,str) or type(v) is not int or v<1 for k,v in expected.items()):
        raise ValueError("Declare exact reference IDs and per-reference prompt counts")
    limits = policy["per_speaker_regression_limits"]
    if not isinstance(limits, dict) or set(limits) != {"dev", "old_dev", "conditional"}:
        raise ValueError("Per-character regression criteria need all three evaluation roles")
    for role, values in limits.items():
        if not isinstance(values,dict) or not values or any(not isinstance(k,str) or type(v) not in (int,float)
                or not math.isfinite(v) or not 0<=v<1 for k,v in values.items()):
            raise ValueError("Invalid explicit per-character regression limits for " + role)
    return {"settings": policy, "reference_expectations": expected, "learning_rate_schedule": schedule,
            "lr_min_ratio": raw.get(stage+"_lr_min_ratio"), "precision": raw["precision"],
            "allow_fp32_fallback": raw["allow_fp32_fallback"], "implementation_sha256": file_sha(__file__)}


def expected_samples(spec, stage="teacher"):
    return sum(spec.raw["teacher_reference_expectations" if stage == "teacher" else "student_reference_expectations"].values())


def verify_references(spec, references, stage="teacher"):
    actual = {row["id"]: len(row["texts"]) for row in references}
    expected = spec.raw["teacher_reference_expectations" if stage == "teacher" else "student_reference_expectations"]
    if actual != expected or len(actual) != len(references):
        raise ValueError("Actual voice/prompt coverage differs from the declared continuation panel")


def speaker_regressions(spec, panels, anchor, stage="teacher"):
    limits = settings(spec, stage)["per_speaker_regression_limits"]
    reasons = []
    for role in ("dev", "old_dev", "conditional"):
        current = panels[role].get("speaker_scores", {})
        baseline = anchor[role].get("speaker_scores", {})
        if set(current) != set(baseline) or set(current) != set(limits[role]):
            raise ValueError("Per-character coverage/limits differ for " + role)
        for name, row in current.items():
            score, before = float(row["score"]), float(baseline[name]["score"])
            if not math.isfinite(score) or row.get("samples", 0) <= 0:
                raise ValueError("Nonfinite or empty per-character evaluation")
            if score > before + max(abs(before) * limits[role][name], 1e-8):
                reasons.append("speaker_regression:" + role + ":" + name)
    return reasons


def _owned(spec, relative, stage="teacher"):
    path = (spec.output / relative).resolve()
    root = (spec.output / stage / "candidates").resolve()
    if not path.is_relative_to(root):
        raise ValueError("Candidate path escaped the owned candidate directory")
    return path


def selected_checkpoint(spec, stage="teacher"):
    from . import runner
    index = runner.read_json(spec.output / stage / "candidate-index.json", {})
    selected = index.get("selected")
    if not selected:
        return spec.output / stage / "candidates/no-qualified-candidate.pt"
    if index.get("input_identity") != spec.identity:
        raise ValueError("Candidate index belongs to another corpus/recipe")
    path = _owned(spec, selected["path"], stage)
    if not path.is_file() or runner.sha256_file(path) != selected["sha256"]:
        raise ValueError("Selected compact candidate changed")
    return path


def _commit(spec, model, step, kind, panels, speech, reasons, stage="teacher"):
    from . import runner
    import torch
    root = spec.output / stage
    index_path = root / "candidate-index.json"
    index = runner.read_json(index_path, {"input_identity": spec.identity, "candidates": [], "evaluations": []})
    if index.get("input_identity") != spec.identity:
        raise ValueError("Continuation candidate history belongs to another run")
    prefix = "teacher-" if stage == "teacher" else ""
    speech_path = spec.output / f"comparisons/{prefix}rollout-step{step:06d}-{kind}/metrics.json"
    record = {"input_identity": spec.identity, "evaluation_ticket": spec.raw.get("_pending_evaluation"),
              "step": step, "weights": kind, "score": panels["dev"]["score"], "panels": panels,
              "speech_metrics": {"path": speech_path.relative_to(spec.output).as_posix(), "sha256": runner.sha256_file(speech_path)},
              "speech_selection_identity": speech.get("selection_identity"), "rejection_reasons": reasons,
              "numeric_candidate": not reasons, "listening_qualified": False, "automatic_promotion": False,
              "asr_tentative": True, "expected_samples": expected_samples(spec, stage)}
    index["evaluations"] = [r for r in index["evaluations"] if (r["step"],r["weights"]) != (step,kind)] + [record]
    allowed = settings(spec, stage)["candidate_weights"]
    if kind in allowed:
        relative = f"{stage}/candidates/step{step:09d}-{kind}.pt"
        path = _owned(spec, relative, stage); path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"step": step, "model": runner.cpu_tree(model.state_dict(), torch), "ema": None,
                   "runner": {"schema": runner.SCHEMA, "input_identity": spec.identity, "selection_weights": kind,
                              "selection_metrics": record, "validated_probe_count": expected_samples(spec, stage)}}
        compact_bytes = math.ceil(runner.tensor_bytes(payload, torch) * 1.05)
        latest = spec.output / stage / "last.pt"
        if not latest.is_file():
            raise ValueError("Save full resumable state before retaining speech candidates")
        # Leave room for the next atomic full-checkpoint rewrite and the final
        # compact inference export. Only old, unselected owned copies may go.
        reserve = math.ceil(latest.stat().st_size * 1.05) + 2 * compact_bytes
        limit = min(float(spec.option("max_output_gib", 18))*1024**3, 18_000_000_000)
        used = sum(p.stat().st_size for p in spec.output.rglob('*') if p.is_file())
        selected_path = (index.get("selected") or {}).get("path")
        removable = sorted((r for r in index["candidates"] if r["path"] not in (selected_path, relative)),
                           key=lambda r:(r["step"],r["weights"]))
        while used + compact_bytes + reserve > limit and removable:
            old = removable.pop(0); old_path = _owned(spec, old["path"], stage)
            if not old_path.is_file() or runner.sha256_file(old_path) != old["sha256"]:
                raise ValueError("Owned candidate changed before storage pruning")
            used -= old_path.stat().st_size
            index["candidates"] = [r for r in index["candidates"] if r["path"] != old["path"]]
            runner.atomic_json(index_path, index)
            old_path.unlink()
        if used + compact_bytes + reserve > limit:
            raise RuntimeError("Saved-output space cannot retain candidate plus full resume/export reserve")
        runner.atomic_torch_save(path, payload, spec)
        del payload
        candidate = {"step": step, "weights": kind, "score": record["score"], "eligible": not reasons,
                     "path": relative, "sha256": runner.sha256_file(path)}
        index["candidates"] = [r for r in index["candidates"] if r["path"] != relative] + [candidate]
    eligible = [r for r in index["candidates"] if r["eligible"]]
    index["selected"] = min(eligible, key=lambda r:(r["score"],r["step"],r["weights"])) if eligible else None
    keep = settings(spec, stage)["keep_candidates"]
    protected = {index["selected"]["path"]} if index["selected"] else set()
    newest = sorted(index["candidates"], key=lambda r:(r["step"],r["weights"]), reverse=True)
    for candidate in newest:
        if len(protected) >= keep: break
        protected.add(candidate["path"])
    removed = [r for r in index["candidates"] if r["path"] not in protected]
    index["candidates"] = [r for r in index["candidates"] if r["path"] in protected]
    # Write the new index before discarding only obsolete owned compact copies.
    runner.atomic_json(index_path, index)
    for candidate in removed:
        path = _owned(spec, candidate["path"], stage)
        if not path.is_file() or runner.sha256_file(path) != candidate["sha256"]:
            raise ValueError("Obsolete candidate changed before owned cleanup")
        path.unlink()
    runner.atomic_json(root / f"quality-step{step:09d}-{kind}.json", record)


def evaluate_checkpoint(spec, model, mimi, ema, args, device, rank, world, step, stop, anchor, dev):
    from . import runner, teacher_quality
    import torch
    if step not in spec.raw["teacher_rollout_steps"]:
        return
    for kind in ("ema", "raw"):
        if _rank_zero_result(lambda: evaluation_kind_complete(spec, "teacher", step, kind), device, rank, world):
            continue
        with runner.ema_weights(model, ema) if kind == "ema" else nullcontext():
            panels = runner.teacher_panel_scores(spec, model, mimi, args, device, rank, world, stop,
                                                   dev if kind == "ema" else None)
            if panels is None: return
            panels = {role: {**value, "weights": kind,
                      "selection": str(value.get("selection", "")).replace("ema_", kind + "_", 1)}
                      for role, value in panels.items()}
            speech = runner.teacher_speech(spec, model, mimi, device, step, stop, rank, world, weight_kind=kind)
            if runner.distributed_any(torch, stop.requested(), device, world): return
            reasons = teacher_quality.candidate_reasons(panels["dev"], panels["old_dev"], anchor, speech,
                conditional=panels["conditional"], relative_improvement=spec.raw["minimum_relative_improvement"],
                regression_limit=spec.raw["teacher_old_dev_regression_limit"],
                conditional_limit=spec.raw["teacher_conditional_regression_limit"],
                expected_samples=expected_samples(spec), asr_gate=False)
            reasons += speaker_regressions(spec, panels, anchor)
            runner.teacher_rank_zero_commit(lambda: _commit(spec, model, step, kind, panels, speech, sorted(set(reasons))),
                                            device, rank, world)


def _plateau_reached_local(spec, step, rows, stage="teacher"):
    from . import runner
    policy = settings(spec, stage)
    if not policy["stop_on_plateau"] or step < spec.raw[stage+"_min_steps"] or step < spec.raw[stage+"_warmup_steps"]:
        return False
    if step * spec.raw.get("effective_batch_size",64) / rows < policy["minimum_corpus_passes"]:
        return False
    index = runner.read_json(spec.output / stage / "candidate-index.json", {})
    if index.get("input_identity") != spec.identity:
        return False
    values = sorted((r for r in index["evaluations"] if r["weights"] == "ema"), key=lambda r:r["step"])
    if len(values) < policy["minimum_speech_evaluations"]:
        return False
    best = float("inf"); stagnant = 0
    for row in values:
        score = float(row["score"])
        improved = score < best - max(abs(best)*spec.raw["minimum_relative_improvement"],1e-8) if math.isfinite(best) else True
        if improved and row["numeric_candidate"]: best, stagnant = score, 0
        else: stagnant += 1
    return stagnant >= policy["plateau_patience"]


def _rank_zero_result(action, device, rank, world):
    from . import runner
    import torch
    result, failed = None, False
    if rank == 0:
        try: result = action()
        except Exception: failed = True
    if runner.distributed_any(torch, failed, device, world):
        raise RuntimeError("Rank-zero continuation receipt/decision failed")
    if world > 1:
        values = [result]
        torch.distributed.broadcast_object_list(values, src=0)
        result = values[0]
    return result


def plateau_reached(spec, step, rows, stage, device, rank, world):
    return bool(_rank_zero_result(lambda: _plateau_reached_local(spec, step, rows, stage), device, rank, world))


def begin_evaluation(spec, state, step, stage, device, rank, world):
    """This ticket is inside last.pt before any long evaluation starts."""
    ticket = _rank_zero_result(lambda: {"step": step, "stage": stage, "token": uuid.uuid4().hex}, device, rank, world)
    state["pending_evaluation"] = ticket
    spec.raw["_pending_evaluation"] = ticket


def evaluation_kind_complete(spec, stage, step, kind):
    from . import runner
    record = runner.read_json(spec.output / stage / f"quality-step{step:09d}-{kind}.json", {})
    if (record.get("input_identity") != spec.identity or record.get("step") != step or record.get("weights") != kind
            or record.get("evaluation_ticket") != spec.raw.get("_pending_evaluation") or not record.get("evaluation_ticket")):
        return False
    item = record["speech_metrics"]
    path = (spec.output / item["path"]).resolve()
    if not path.is_relative_to(spec.output.resolve()) or runner.sha256_file(path) != item["sha256"]:
        raise ValueError("Committed speech evaluation changed before reuse")
    speech = runner.read_json(path)
    if speech.get("selection_identity") != record["speech_selection_identity"]:
        raise ValueError("Committed speech selection identity changed")
    for sample in speech.get("samples", []):
        if sample.get("audio"):
            audio = (path.parent / sample["audio"]).resolve()
            if not audio.is_relative_to(path.parent) or runner.sha256_file(audio) != sample["audio_sha256"]:
                raise ValueError("Committed speech audio changed before reuse")
    return True


def _evaluation_files(spec, stage, step):
    from . import runner
    result = [spec.output / stage / "heldout.json"]
    schedule = spec.raw["teacher_rollout_steps" if stage == "teacher" else "rollout_steps"]
    if step in schedule:
        prefix = "teacher-" if stage == "teacher" else ""
        for kind in ("ema", "raw"):
            if not evaluation_kind_complete(spec, stage, step, kind):
                raise ValueError("A scheduled weight-kind evaluation has not committed")
            result.append(spec.output / stage / f"quality-step{step:09d}-{kind}.json")
            folder = spec.output / f"comparisons/{prefix}rollout-step{step:06d}-{kind}"
            result.append(folder / "metrics.json")
            for sample in runner.read_json(folder / "samples.json", []):
                if sample.get("audio"):
                    path = (folder / sample["audio"]).resolve()
                    if not path.is_relative_to(folder.resolve()) or runner.sha256_file(path) != sample["audio_sha256"]:
                        raise ValueError("Completed speech WAV changed")
                    result.append(path)
    return result


def finish_evaluation(spec, state, step, stage, stop, device, rank, world):
    from . import runner
    import torch
    if runner.distributed_any(torch, stop.requested(), device, world):
        return False
    def commit():
        ticket = state.get("pending_evaluation")
        if not ticket or ticket["step"] != step or ticket["stage"] != stage:
            raise ValueError("Evaluation checkpoint ticket differs")
        receipt = {"input_identity": spec.identity, "ticket": ticket,
            "state": {k:state[k] for k in ("best_score", "best_step", "bad_validations")},
            "files": [{"path":p.relative_to(spec.output).as_posix(), "sha256":runner.sha256_file(p)}
                      for p in _evaluation_files(spec, stage, step)]}
        runner.atomic_json(spec.output / stage / "evaluation-completed.json", receipt)
        return receipt
    _rank_zero_result(commit, device, rank, world)
    state["pending_evaluation"] = None
    spec.raw.pop("_pending_evaluation", None)
    return True


def resume_evaluation(spec, state, model, mimi, ema, args, stage, step, stop, anchor, device, rank, world):
    """Finish/reuse stepN before advancing optimizer toN+1 after a segment boundary."""
    from . import runner, student_transfer
    import torch
    ticket = state.get("pending_evaluation")
    if ticket is None: return True
    if ticket.get("step") != step or ticket.get("stage") != stage:
        raise ValueError("Restored evaluation ticket does not match the full checkpoint")
    spec.raw["_pending_evaluation"] = ticket
    def completed():
        receipt = runner.read_json(spec.output / stage / "evaluation-completed.json", {})
        if receipt.get("input_identity") != spec.identity or receipt.get("ticket") != ticket:
            return None
        for item in receipt["files"]:
            path = (spec.output / item["path"]).resolve()
            if not path.is_relative_to(spec.output.resolve()) or runner.sha256_file(path) != item["sha256"]:
                raise ValueError("Completed evaluation changed before resume")
        return receipt
    receipt = _rank_zero_result(completed, device, rank, world)
    if receipt is not None:
        state.update(receipt["state"]); state["pending_evaluation"] = None
        spec.raw.pop("_pending_evaluation", None)
        return True
    cached = _rank_zero_result(lambda: runner.read_json(spec.output / stage / "heldout.json", {}), device, rank, world)
    if (cached.get("input_identity") == spec.identity and cached.get("step") == step
            and cached.get("evaluation_ticket") == ticket):
        heldout = cached["metrics"]
        state.update({k:cached[k] for k in ("best_score", "best_step", "bad_validations")})
    else:
        with runner.ema_weights(model, ema):
            heldout = runner.validate(spec, model, mimi, args, device, rank, world, stop)
        if heldout is None: return False
        delta = spec.raw["minimum_relative_improvement"]
        if state["best_score"] is None or heldout["score"] < state["best_score"] - max(abs(state["best_score"])*delta,1e-8):
            state.update(best_score=heldout["score"], best_step=step, bad_validations=0)
            if rank == 0: runner.save_best(spec, stage, step, model, ema, heldout)
        else: state["bad_validations"] += 1
        runner.teacher_rank_zero_commit(lambda: runner.atomic_json(spec.output / stage / "heldout.json",
            {"step":step,"input_identity":spec.identity,"evaluation_ticket":ticket,"metrics":heldout,
             **{k:state[k] for k in ("best_score", "best_step", "bad_validations")}}), device, rank, world)
    if stage == "teacher":
        runner.teacher_quality_check(spec, model, mimi, ema, args, device, rank, world, step, stop, anchor, heldout)
    else:
        student_transfer.check(spec, model, mimi, ema, args, device, rank, world, step, stop, anchor, heldout)
    return finish_evaluation(spec, state, step, stage, stop, device, rank, world)


def evaluate_student_checkpoint(spec, model, mimi, ema, args, device, rank, world, step, stop, anchor, dev):
    from . import runner, student_transfer
    import torch
    if step not in spec.raw["rollout_steps"]:
        return
    for kind in ("ema", "raw"):
        if _rank_zero_result(lambda: evaluation_kind_complete(spec, "distill", step, kind), device, rank, world):
            continue
        with runner.ema_weights(model, ema) if kind == "ema" else nullcontext():
            student_transfer.transfer_receipt(model, stop)
            panels = runner.teacher_panel_scores(spec, model, mimi, args, device, rank, world, stop,
                                                  dev if kind == "ema" else None)
            if panels is None: return
            panels = {role: {**value, "weights": kind,
                      "selection": str(value.get("selection", "")).replace("ema_", kind + "_", 1)}
                      for role, value in panels.items()}
            speech = student_transfer.speech(spec, model, mimi, device, step, stop, rank, world, kind=kind)
            if runner.distributed_any(torch, stop.requested(), device, world): return
            reasons = student_transfer.candidate_reasons(panels, anchor, speech,
                minimum_improvement=spec.raw["minimum_relative_improvement"],
                regression_limit=spec.raw["distill_old_dev_regression_limit"],
                conditional_limit=spec.raw["distill_conditional_regression_limit"],
                expected_samples=expected_samples(spec, "distill"), asr_gate=False)
            reasons += speaker_regressions(spec, panels, anchor["hybrid"], "distill")
            runner.teacher_rank_zero_commit(lambda: _commit(spec, model, step, kind, panels, speech,
                sorted(set(reasons)), "distill"), device, rank, world)


def provider_remaining(spec):
    """The notebook sets this deadline once before setup; a resumed notebook sets its own."""
    import os
    value = os.environ.get("POCKET_PROVIDER_DEADLINE_UNIX")
    if (enabled(spec) or enabled(spec, "distill")) and not value:
        raise ValueError("Kaggle continuation requires the execution-start provider deadline from its launcher")
    if not value:
        return 12 * 3600.
    deadline = float(value)
    remaining = deadline - time.time()
    if not math.isfinite(deadline) or remaining > 12*3600+5:
        raise ValueError("Provider deadline is invalid or was reset after setup")
    return remaining
