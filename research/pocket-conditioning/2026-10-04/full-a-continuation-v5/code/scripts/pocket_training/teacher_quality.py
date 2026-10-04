"""Teacher candidate policy; numeric eligibility never establishes likeness."""
from __future__ import annotations

import math
import re
from typing import Any

POLICY = "macro_speaker_cfg2_old_dev_v1"


def enabled(spec: Any) -> bool:
    return spec.raw.get("teacher_quality_policy") == POLICY


def objective(metrics: dict[str, float], *, p_equal: float, ldim: int, eos_weight: float) -> float:
    score = (p_equal * metrics["flow_diag"] + (1 - p_equal) * metrics["flow_distill"]) / ldim + eos_weight * metrics["eos_loss"]
    if not math.isfinite(score):
        raise ValueError("Teacher selection objective is nonfinite")
    return score


def macro_speakers(speakers: dict[str, dict[str, float]], expected: set[str]) -> float:
    if not expected or set(speakers) != expected or "unknown" in expected:
        raise ValueError("Teacher development speaker coverage differs from its declared manifest")
    if any(row.get("samples", 0) <= 0 or not math.isfinite(row["score"]) for row in speakers.values()):
        raise ValueError("Teacher development lost a speaker or has nonfinite scores")
    return sum(row["score"] for row in speakers.values()) / len(speakers)


def speech_complete(receipt: dict[str, Any], anchor: dict[str, Any] | None = None, *,
                    expected_samples: int = 18, asr_gate: bool = True) -> bool:
    aggregate = receipt.get("aggregate", {})
    count = aggregate.get("expected_samples", 0)
    if asr_gate:
        status_ok = receipt.get("status") == "completed" and not receipt.get("diagnostic_failure")
    else:
        # Native transcript authority and generated-ASR diagnostics are separate.
        # Missing ASR cannot erase real PCM/EOS evidence, while actual generation
        # failures, omissions, frame caps and invalid audio still fail this gate.
        failures = set(receipt.get("failure_reasons", []))
        status_ok = receipt.get("status") in ("completed", "failed") and failures <= {"incomplete_asr"}
    valid = (status_ok and count == expected_samples and aggregate.get("natural_eos_samples") == count
             and aggregate.get("finite_samples") == count
             and (not asr_gate or aggregate.get("transcribed_samples") == count))
    if not valid:
        return False
    # ASR is fallible: compare omissions with the same accepted-anchor probes,
    # rather than mistaking a proper-name transcription error for new damage.
    return not asr_gate or anchor is None or aggregate.get("deletions", 0) <= anchor.get("aggregate", {}).get("deletions", 0)


def candidate_reasons(dev: dict[str, Any], old_dev: dict[str, Any], anchor: dict[str, Any],
                      speech: dict[str, Any], *, relative_improvement: float = .002,
                      regression_limit: float = .03, conditional: dict[str, Any] | None = None,
                      conditional_limit: float = .03, expected_samples: int = 18,
                      asr_gate: bool = True) -> list[str]:
    reasons = []
    if set(dev.get("speaker_scores", {})) != set(anchor["dev"].get("speaker_scores", {})):
        reasons.append("development_coverage_changed")
    if not dev["score"] < anchor["dev"]["score"] - max(abs(anchor["dev"]["score"]) * relative_improvement, 1e-8):
        reasons.append("no_macro_development_improvement")
    if old_dev.get("sample_ids_sha256") != anchor["old_dev"].get("sample_ids_sha256"):
        reasons.append("old_development_ids_changed")
    if old_dev["score"] > anchor["old_dev"]["score"] * (1 + regression_limit):
        reasons.append("old_development_regression")
    if conditional is not None:
        if set(conditional.get("speaker_scores", {})) != set(anchor["conditional"].get("speaker_scores", {})):
            reasons.append("conditional_coverage_changed")
        if conditional["score"] > anchor["conditional"]["score"] * (1 + conditional_limit):
            reasons.append("conditional_development_regression")
    if not speech_complete(speech, anchor["speech"], expected_samples=expected_samples, asr_gate=asr_gate):
        reasons.append("speech_completeness_regression")
    return reasons


def recording_keys(row: dict[str, Any]) -> set[tuple[str, str]]:
    result = set()
    for field in ("id", "source_wem_sha256", "pcm_sha256", "original_pcm_sha256", "source_pcm_sha256", "audio_sha256"):
        if row.get(field):
            result.add(("pcm" if "pcm_sha256" in field else field, str(row[field])))
    text = re.sub(r"\W+", " ", str(row.get("transcript", "")).casefold()).strip()
    if text:
        result.add(("transcript", text))
    return result


def fence_recording_panels(panels: dict[str, list[dict[str, Any]]]) -> None:
    seen = {}
    for panel, rows in panels.items():
        for row in rows:
            for key in recording_keys(row):
                if key in seen and (seen[key] != panel or key[0] != "transcript"):
                    raise ValueError("Teacher panels overlap by recording, PCM, WEM, ID or transcript alias")
                seen[key] = panel


def fence_conditionals(entries: list[dict[str, Any]], other_rows: list[dict[str, Any]]) -> None:
    """Allow explicitly labelled seen-scene monitoring, never repeated utterances."""
    seen = set().union(*(recording_keys(row) for row in other_rows)) if other_rows else set()
    for row in entries:
        if (row.get("validation_tier") != "B_unseen_utterance_seen_scene" or row.get("previous_training_seen") is not False
                or row.get("previous_training_scene_seen") is not True):
            raise ValueError("Conditional development must declare unseen utterances within seen scenes")
        identity = recording_keys(row)
        if not row.get("id") or not row.get("source_wem_sha256") or seen.intersection(identity):
            raise ValueError("Conditional development repeats a recording, transcript or historical utterance")
        seen.update(identity)
