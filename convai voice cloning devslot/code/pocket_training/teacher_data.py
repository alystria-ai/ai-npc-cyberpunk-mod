"""Teacher-only wording/protected-data and actual-cache evidence checks.

The admitted caption is compared with bound raw recognizer outputs. Normalized
adapter labels and zero counters are not acoustic evidence. This module never
loads a speech model, trains weights or edits the input corpus.
"""
from __future__ import annotations
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import unicodedata

ROLES = {"train", "dev", "test", "teacher_regression", "teacher_conditional"}
ADMISSION = {"train", "dev", "teacher_conditional"}
PROTECTED = {"teacher_regression", "test"}
CTC_SHA = "8aa76ab2243c81747a1f832954586bc566090c83a0ac167df6f31f0fa917d74a"
ORIGINAL = {
    "immutable original dev": "cc97d49cfc39987fcb8b3c9abc834b80cbe4706da9c4f1c787144131cacb57f2",
    "accepted immutable original word spans dev": "c7d9e8a94e4db43a38b9675d6b5b404480587faa8a772236c4dcace15c06e63c",
    "immutable original test": "6bd75b7ea6aa1f2ad91205fcd3a0a91e14b08fc3e3bb5e1304e36280b82a4ced",
    "accepted immutable original word spans test": "603a9afdd1db4962bd9b9e1dfac0b8005bfaeec05676dffb067f449540893b67",
}
IDENTITY = ("id", "speaker_id", "source_panel", "audio_sha256", "pcm_sha256", "source_wem_sha256",
            "native_text_sha256", "source_row_sha256")


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def text_sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def file_sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def rows(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8-sig").splitlines() if line.strip()]


def bound(base, item):
    p = Path(item["path"])
    if p.is_absolute() or ".." in p.parts or "://" in str(p):
        raise ValueError("Teacher evidence path must be portable inside the staged bundle")
    p = (Path(base) / p).resolve()
    if not p.is_relative_to(Path(base).resolve()) or not p.is_file() or file_sha(p) != item["sha256"]:
        raise ValueError("Teacher bound evidence file changed or escaped staging")
    return p


def unique(values, label):
    indexed = {}
    for row in values:
        if row["id"] in indexed:
            raise ValueError("Duplicate ID within teacher " + label)
        indexed[row["id"]] = row
    return indexed


def compact(text):
    return "".join(c for c in unicodedata.normalize("NFKD", text).casefold()
                   if not unicodedata.combining(c) and c.isalnum())


def identity(row):
    value = {"id": row["id"], "speaker_id": row.get("character", row.get("speaker_id")),
        "source_panel": row["source_panel"], "audio_sha256": row.get("audio_sha256", row.get("sha256")),
        "pcm_sha256": row["pcm_sha256"], "source_wem_sha256": row["source_wem_sha256"],
        "native_text_sha256": row.get("native_text_sha256", row.get("text_sha256")),
        "source_row_sha256": row["source_row_sha256"]}
    native = row.get("native_text", row.get("text"))
    if native is None or value["native_text_sha256"] != text_sha(native):
        raise ValueError("Teacher original caption hash or original source tuple changed")
    if not value["speaker_id"] or any(not re.fullmatch("[0-9a-f]{64}", value[k]) for k in IDENTITY[3:]):
        raise ValueError("Teacher canonical source identity is incomplete")
    return value


def cpu_identity(row):
    # This actual legacy pass predates source_panel/source-row fields. Their
    # only supported derivation is the unchanged, bound667-row rich input.
    value = {**row, "source_panel": "new_native", "source_row_sha256": digest(row),
             "text_sha256": text_sha(row["text"])}
    return identity(value)


def load_audit(base, item):
    adapter = item["adapter"]
    inputs = unique(rows(bound(base, item["input_manifest"])), "audit input")
    actual = unique(rows(bound(base, item["hypotheses_ledger"])), "raw audit output")
    code_sha = file_sha(bound(base, item["source_code"]))
    result = {}
    if adapter == "cpu_greedy_raw_v1":
        assets = read(bound(base, item["assets_receipt"]))
        models = {entry["path"]: entry["sha256"] for entry in assets["files"]}
        if models.get("models/alignment/model.safetensors") != CTC_SHA or len(inputs) != 667 or set(actual) != set(inputs):
            raise ValueError("Legacy CPU greedy input/model/completion inventory differs")
        last = read_log_end(bound(base, item["completion_log"]))
        if last.get("visited") != 667 or last.get("rows") != 667 or last.get("passed", 0) + last.get("rejected", 0) != 667:
            raise ValueError("Legacy CPU greedy completion log does not cover667 actual rows")
        for key, raw in actual.items():
            origin = inputs[key]
            if (raw["speaker_id"] != origin["speaker_id"] or raw["audio_sha256"] != origin["sha256"]
                    or raw.get("alignment_model_sha256") != CTC_SHA or raw.get("device") != "cpu"):
                raise ValueError("Actual CPU greedy recording/model differs from its input")
            if isinstance(raw.get("greedy_transcript"), str):
                result[key] = (cpu_identity(origin), raw["greedy_transcript"])
        return {"family": "ctc", "model_sha256": CTC_SHA, "rows": result, "source_code_sha256": code_sha,
                "alignments": {key: raw["words"] for key, raw in actual.items() if key in result and raw.get("words")}}
    launch = read(bound(base, item["launch_receipt"]))
    summary = read(bound(base, item["summary"]))
    if adapter == "ctc_local_v1":
        model = launch["ctc_assets"]["models/alignment/model.safetensors"]
        if (model != CTC_SHA or launch.get("transcript_tokens_supplied_to_model") is not False
                or launch.get("runtime_source_sha256") != code_sha
                or launch.get("audit_manifest_sha256") != item["input_manifest"]["sha256"]
                or summary.get("output_sha256") != item["hypotheses_ledger"]["sha256"]
                or summary.get("provenance") != launch or set(actual) != set(inputs)):
            raise ValueError("Actual caption-free CTC launch/input/output provenance differs")
        family = "ctc"
    elif adapter == "whisper_second_v1":
        plan = read(bound(base, item["plan"]))
        ctc_path = bound(base, item["ctc_hypotheses_ledger"])
        ctc_rows = unique(rows(ctc_path), "Whisper actual CTC origin")
        model = launch["model_sha256"]
        if (launch.get("original_caption_prompt") is not False
                or launch.get("generation", {}).get("condition_on_prev_tokens") is not False
                or launch.get("script_sha256") != code_sha or plan.get("script_sha256") != code_sha
                or plan.get("caption_prompt") is not False or plan.get("caption_derived_hints") is not False
                or summary.get("launch_receipt_sha256") != item["launch_receipt"]["sha256"]
                or summary.get("results_sha256") != item["hypotheses_ledger"]["sha256"]
                or summary.get("plan_sha256") != item["plan"]["sha256"]
                or plan.get("manifest_sha256") != item["input_manifest"]["sha256"]
                or summary.get("original_manifest_sha256", summary.get("candidate_manifest_sha256")) != item["input_manifest"]["sha256"]
                or plan.get("ctc_results_sha256") != file_sha(ctc_path)
                or summary.get("ctc_results_sha256") != file_sha(ctc_path)
                or set(actual) != set(plan["selected_ids"]) or not set(actual) <= set(inputs)):
            raise ValueError("Actual independent Whisper launch/input/output differs")
        family = "whisper"
        if item.get("candidate_adapter_receipt"):
            adaptation = read(bound(base, item["candidate_adapter_receipt"]))
            if (adaptation["schema"] != "new_candidate_asr_adapter_v1"
                    or summary.get("candidate_adapter_receipt_sha256") != item["candidate_adapter_receipt"]["sha256"]
                    or adaptation["adapter_sha256"] != file_sha(bound(base, item["candidate_adapter_source"]))
                    or adaptation["original_engine_sha256"] != code_sha
                    or adaptation["candidate_manifest_sha256"] != item["input_manifest"]["sha256"]
                    or adaptation["standardized_ctc_ledger_sha256"] != file_sha(ctc_path)
                    or adaptation["caption_or_audio_edits"] is not False
                    or adaptation["model_inference_code_unchanged"] is not True
                    or adaptation["eligibility_receipt_sha256"] != file_sha(bound(base, item["eligibility_receipt"]))
                    or adaptation["actual_ctc_binding_sha256"] != file_sha(bound(base, item["actual_ctc_binding"]))):
                raise ValueError("New Whisper adapter is not bound to its actual engine/input/receipt")
            cpu_item = item["actual_cpu_greedy"]
            cpu = load_audit(base, cpu_item)
            if adaptation["actual_raw_ctc_ledger_sha256"] != cpu_item["hypotheses_ledger"]["sha256"]:
                raise ValueError("New Whisper adapter changed actual retained CPU greedy evidence")
            for key, row in ctc_rows.items():
                if key not in cpu["rows"] or cpu["rows"][key] != (identity(row), row["ctc_raw_hypothesis"]):
                    raise ValueError("Normalized new CTC origin contradicts its actual retained CPU greedy")
    else:
        raise ValueError("Unsupported actual teacher wording adapter")
    for key, raw in actual.items():
        if identity(raw) != identity(inputs[key]):
            raise ValueError("Actual recognizer lost the full original source tuple")
        if raw.get("status") != "audited":
            continue
        if family == "ctc":
            hypothesis = raw["ctc_raw_hypothesis"]
        else:
            decoder = raw["second_decoder"]
            origin = ctc_rows[key]
            if (decoder["model_sha256"] != model or decoder["source_audio_sha256"] != raw["sha256"]
                    or decoder["model_revision"] != launch["model_revision"]
                    or decoder["generation"] != launch["generation"]
                    or identity(origin) != identity(raw)
                    or origin["ctc_raw_hypothesis"] != raw["ctc_raw_hypothesis"]):
                raise ValueError("Actual Whisper row model/audio provenance changed")
            hypothesis = decoder["raw_hypothesis"]
        result[key] = (identity(raw), hypothesis)
    return {"family": family, "model_sha256": model, "rows": result, "source_code_sha256": code_sha}


def read_log_end(path):
    lines = Path(path).read_text().splitlines()
    return json.loads(next(line for line in reversed(lines) if line.strip()))


def model_payload(row):
    return {"id": row["id"], "character": row.get("character", row.get("speaker_id")),
        "transcript": row.get("transcript", row.get("text")), "duration": row["duration"], "start": float(row.get("start", 0.0)),
        "audio_sha256": row.get("audio_sha256", row.get("sha256")), "pcm_sha256": row["pcm_sha256"],
        "source_wem_sha256": row["source_wem_sha256"], "words": row["words"]}


def require_word_caption(row):
    # The pinned loader tokenizes words AFTER its chosen cut, rather than the
    # transcript field. Verify the actual consumed lexical stream as well.
    if compact(" ".join(word["word"] for word in row["words"])) != compact(row["transcript"]):
        raise ValueError("Teacher loader word stream contradicts its approved caption")


def verify_protected(base, panels, snapshot):
    original_files = {}
    for item in snapshot["inputs"]:
        purpose = item["purpose"]
        if purpose in ORIGINAL:
            if item["sha256"] != ORIGINAL[purpose] or purpose in original_files:
                raise ValueError("Protected evaluation source is not the independently frozen original")
            original_files[purpose] = bound(base, item)
    if set(original_files) != set(ORIGINAL):
        raise ValueError("Protected evaluation lacks the four actual original source files")
    for role, source, count in (("teacher_regression", "dev", 94), ("test", "test", 76)):
        original = rows(original_files["immutable original " + source])
        words = read(original_files["accepted immutable original word spans " + source])["rows"]
        got = panels[role]
        if len(got) != count or len(original) != count:
            raise ValueError("Protected94/76 evaluation inventory changed")
        snapshots = snapshot["panels"][role]["rows"]
        if len(snapshots) != count:
            raise ValueError("Protected normalized snapshot inventory changed")
        for ordinal, (native, staged, entry) in enumerate(zip(original, got, snapshots, strict=True)):
            expected = model_payload({**native, "words": words[native["id"]]})
            metadata = {k: v for k, v in native.items() if k != "audio_path"}
            if model_payload(staged) != expected or staged.get("protected_source_metadata") != metadata:
                raise ValueError("Protected original words/scenes/delivery/content/order changed")
            if (entry["ordinal"] != ordinal or entry["content"] != expected or entry["content_sha256"] != digest(expected)
                    or entry.get("protected_source_metadata") != metadata
                    or entry.get("protected_source_metadata_sha256") != digest(metadata)):
                raise ValueError("Protected normalized snapshot is not the actual original metadata/content")
        expected_snapshot = snapshot["panels"][role]
        if [model_payload(row) for row in got] != [entry["content"] for entry in expected_snapshot["rows"]]:
            raise ValueError("Protected normalized snapshot contradicts independently frozen content")


def check_review(base, item, source, caption, action, *, actual=False):
    review = read(bound(base, item))
    if (review.get("source_identity") != source or review.get("approved_caption_sha256") != caption
            or review.get("decision") != action):
        raise ValueError("Teacher wording review lost original source or approved caption")
    if actual and review.get("reviewed_original_audio") is not True:
        raise ValueError("Actual-speech retention/correction lacks a bound original-audio review")
    return review


def require_native_alignment(row, audits):
    if row["source_panel"] != "new_native" or row["transcript"] != row["native_text"]:
        return
    actual = [audit["alignments"][row["id"]] for audit in audits.values()
              if row["id"] in audit.get("alignments", {})]
    if not any(row["words"] == spans for spans in actual):
        raise ValueError("Retained new native teacher spans differ from actual raw alignment output")


def alias_keys(row):
    keys = {("id", row["id"])}
    for name, tag in (("source_wem_sha256", "wem"), ("pcm_sha256", "pcm"), ("audio_sha256", "wav"),
                      ("sha256", "wav"), ("wav_sha256", "wav")):
        if row.get(name):
            keys.add((tag, row[name]))
    for value in (row.get("text"), row.get("transcript"), row.get("native_text"), *row.get("transcript_aliases", [])):
        if value:
            keys.add(("text", compact(value)))
    return keys


def require_scene_membership(row, components, native_receipt):
    normalize = lambda value: str(value).replace("\\", "/").casefold()
    actual = {normalize(value) for value in native_receipt["scenePaths"]}
    declared = {normalize(value) for value in row["scenes"]}
    group = row.get("connected_scene_group", row.get("scene_id"))
    if (not actual or declared != actual or group not in components
            or not actual <= {normalize(value) for value in components[group]["scenes"]}):
        raise ValueError("Teacher declared scene component contradicts actual native scene evidence")
    return group


def verify_history(base, bundle, panels):
    history = read(bound(base, bundle["semantic_ledgers"]["history"]))
    sources = history["source_ledgers"]
    paths = {}
    prior = []
    for item in sources:
        path = bound(base, item)
        purpose = item["purpose"]
        if purpose in ("immutable_original_train", "accepted_original_train_spans", "reference_exclusions", "connected_scene_components"):
            if purpose in paths:
                raise ValueError("Teacher independent history source duplicated")
            paths[purpose] = path
        elif purpose == "conservative_prior_train_content":
            prior.extend(row for row in read(path) if row["panel"] == "train")
        elif purpose == "conservative_prior_train":
            # Rich prior-core content binds waveform/PCM/IDs; these raw manifests
            # add conservative caption exclusions without relying on flat IDs.
            for row in rows(path):
                if row.get("text", row.get("transcript")):
                    prior.append({"id": "prior/" + str(row.get("id", row.get("path", row.get("audio_path")))), **row})
    expected = {"immutable_original_train": "33c6a9b1d60f3aea73d6bab2e8c3b7ccfc802ebdfdb6e8551b6b132a56a3e8af",
        "accepted_original_train_spans": "ed3bb60a9540390d68834943d748679ef2172fa85a236ebb6c31a1140c65e15c",
        "reference_exclusions": "1cbfd1005e48da7dd39717be5c0bca606e320f31a99000dc90b1500df594f30f"}
    if not (set(expected) | {"connected_scene_components"}) <= set(paths) or any(file_sha(paths[k]) != v for k, v in expected.items()):
        raise ValueError("Teacher history lacks independently frozen actual training/reference sources")
    accepted = read(paths["accepted_original_train_spans"])["rows"]
    original = rows(paths["immutable_original_train"])
    trained = [row for row in original if row["id"] in accepted]
    if len(trained) != 2743:
        raise ValueError("Teacher actual historical2743 inventory differs")
    historical = set().union(*(alias_keys(row) for row in [*trained, *prior]))
    exclusion = read(paths["reference_exclusions"])
    excluded = {("id", str(speaker) + "/" + str(line)) for speaker, line in exclusion["ids"]}
    for field, tag in (("wavSha256", "wav"), ("pcmSha256", "pcm"), ("wemSha256", "wem")):
        excluded.update((tag, value) for value in exclusion[field])
    excluded.update(("text", compact(value)) for value in exclusion["canonicalTexts"])
    components = read(paths["connected_scene_components"])["components"]
    native = read(bound(base, bundle["semantic_ledgers"]["native_sources"]))["recordings"]
    seen = {}
    for role, values in panels.items():
        for row in values:
            if role == "train" and row["source_panel"] == "train" and row["id"] in accepted:
                if row["transcript"] == row["native_text"] and row["words"] != accepted[row["id"]]:
                    raise ValueError("Retained historical teacher word spans differ from accepted original alignment")
            keys = alias_keys(row)
            if role in ADMISSION:
                if keys & excluded or role != "train" and keys & historical:
                    raise ValueError("Teacher admission leaked a reference/protected/historical recording or caption")
                native_receipt = read(bound(base, native[row["id"]]["native_provenance_receipt"]))
                group = require_scene_membership(row, components, native_receipt)
                exposure = set(components[group]["exposure"])
                if role == "dev" and exposure & {"train", "reference", "dev", "test", "eval"}:
                    raise ValueError("Teacher Tier A scene was exposed to previous training/evaluation/reference")
                if role == "teacher_conditional" and "train" not in exposure:
                    raise ValueError("Teacher Tier B is not from a previously trained scene")
            for key in keys:
                if key in seen and seen[key] != role:
                    raise ValueError("Teacher cross-panel native/corrected caption or recording alias")
                seen[key] = role


def verify_input(spec, bundle):
    base = spec.base
    panels = {role: rows(bound(base, item)) for role, item in bundle["manifests"].items()}
    if set(panels) != ROLES:
        raise ValueError("Teacher semantic manifest roles differ")
    for role, values in panels.items():
        unique(values, role)
        from .runner import valid_words
        if any(not valid_words(row) for row in values):
            raise ValueError("Teacher objective/protected span would trigger fresh alignment or overlap fallback")
        for row in values:
            require_word_caption(row)
    policy = bundle["wording_qualification"]
    if (set(policy["admission_roles"]) != ADMISSION or set(policy["protected_roles"]) != PROTECTED
            or policy["unverified_wording_scope"] != "admission_roles_only"):
        raise ValueError("Teacher wording zero scope must exclude protected diagnostics")
    verify_protected(base, panels, read(bound(base, policy["protected_snapshot"])))
    verify_history(base, bundle, panels)
    diagnostics = read(bound(base, policy["protected_diagnostics"]))
    protected = {(role, row["id"]): identity(row) for role in PROTECTED for row in panels[role]}
    got = {(row["role"], row["source_identity"]["id"]): row["source_identity"] for row in diagnostics["rows"]}
    if (diagnostics.get("changes_protected_rows_or_metrics") is not False or len(got) != len(diagnostics["rows"])
            or got != protected):
        raise ValueError("Protected diagnostics lost exact role/original tuple or changed evaluation")
    decisions = rows(bound(base, policy["decisions_ledger"]))
    indexed = {(row["role"], row["id"]): row for row in decisions}
    expected = {(role, row["id"]) for role in ADMISSION for row in panels[role]}
    if len(indexed) != len(decisions) or set(indexed) != expected:
        raise ValueError("Teacher wording decisions omit/invent/duplicate admitted rows")
    audits = {key: load_audit(base, item) for key, item in policy["audits"].items()}
    native = read(bound(base, bundle["semantic_ledgers"]["native_sources"]))["recordings"]
    for role in ADMISSION:
        for row in panels[role]:
            source = identity(row)
            require_native_alignment(row, audits)
            decision = indexed[(role, row["id"])]
            caption = text_sha(row["transcript"])
            if decision["source_identity"] != source or decision["final_caption_sha256"] != caption:
                raise ValueError("Teacher caption decision source/final hash differs")
            origin = native.get(row["id"])
            if not origin or origin.get("source_identity") != source or origin.get("verified") is not True:
                raise ValueError("Native attribution lost speaker/text/source-row/original-panel identity")
            raw_native = read(bound(base, origin["native_provenance_receipt"]))
            if (str(raw_native["key"]) != source["speaker_id"]
                    or str(raw_native["key"]) + "/" + str(raw_native["stringId"]) != source["id"]
                    or text_sha(raw_native["transcript"]) != source["native_text_sha256"]
                    or raw_native["source"]["sha256"] != source["source_wem_sha256"]
                    or raw_native["wav"]["sha256"] != source["audio_sha256"]
                    or raw_native["wav"]["pcmSha256"] != source["pcm_sha256"]):
                raise ValueError("Native tuple contradicts actual speaker/localization/WEM/WAV receipt")
            evidence = []
            for audit_id in decision["audit_ids"]:
                audit = audits[audit_id]
                actual = audit["rows"].get(row["id"])
                if actual is None or actual[0] != source:
                    raise ValueError("Teacher wording evidence is not this actual source recording")
                evidence.append((audit["family"], actual[1]))
            if not evidence:
                raise ValueError("Teacher admission lacks a completed actual independent hypothesis")
            action = decision["action"]
            if action == "retain_native_exact_agreement":
                if not any(compact(hypothesis) == compact(row["native_text"]) for _, hypothesis in evidence):
                    raise ValueError("Normalized agreement label contradicts actual free hypothesis")
            elif action in ("retain_native_reviewed_equivalence", "retain_native_supported_by_second_decoder", "retain_native_actual_speech_review"):
                check_review(base, decision["review_receipt"], source, caption, action,
                             actual=action == "retain_native_actual_speech_review")
                if action == "retain_native_supported_by_second_decoder" and (
                        len({family for family, _ in evidence}) < 2
                        or not any(compact(hypothesis) == compact(row["native_text"]) for _, hypothesis in evidence)):
                    raise ValueError("Second recognizer evidence is not independent native-caption support")
            elif action == "corrected_training_text_reviewed":
                if role != "train":
                    raise ValueError("Teacher caption corrections are training-only")
                review = check_review(base, decision["actual_speech_review"], source, caption, action, actual=True)
                if review.get("heard_text") != row["transcript"]:
                    raise ValueError("Teacher corrected text contradicts actual speech review")
                alignment = decision["fresh_alignment"]
                receipt = read(bound(base, alignment["receipt"]))
                actual_rows = unique(rows(bound(base, alignment["rows"])), "fresh raw alignment")
                actual = actual_rows[row["id"]]
                if (receipt["source_code_sha256"] != file_sha(bound(base, alignment["source_code"]))
                        or receipt["alignment_rows_sha256"] != alignment["rows"]["sha256"]
                        or actual["source_identity"] != source or actual["transcript"] != row["transcript"]
                        or actual["words"] != row["words"] or actual["source_audio_sha256"] != source["audio_sha256"]):
                    raise ValueError("Corrected caption lacks actual fresh raw alignment outputs")
            else:
                raise ValueError("Teacher admission action has no reviewed evidence route")
            if action != "corrected_training_text_reviewed" and row["transcript"] != row["native_text"]:
                raise ValueError("Retained native teacher caption was silently changed")
    return {"admission_roles": sorted(ADMISSION), "actual_audits": sorted(audits),
            "protected_rows": sum(len(panels[role]) for role in PROTECTED)}


def latent_shape(path):
    import numpy as np
    with Path(path).open("rb") as stream:
        raw = stream.read(8)
        if len(raw) != 8:
            raise ValueError("Truncated teacher latent header")
        length = struct.unpack("<Q", raw)[0]
        if not 2 <= length <= 1048576:
            raise ValueError("Invalid teacher latent header length")
        header = json.loads(stream.read(length)); tensor = header.get("latents")
        if not tensor or tensor["dtype"] != "F32" or len(tensor["shape"]) != 2 or set(header) - {"latents", "__metadata__"}:
            raise ValueError("Teacher latent cache tensor/dtype/inventory differs")
        if any(type(n) is not int or n < 1 for n in tensor["shape"]) or math.prod(tensor["shape"]) > 1024 ** 2:
            raise ValueError("Teacher latent cache tensor shape is outside the bounded codec window")
        begin, end = tensor["data_offsets"]
        expected = math.prod(tensor["shape"]) * 4
        if begin < 0 or end - begin != expected:
            raise ValueError("Teacher latent shape and actual byte count differ")
        stream.seek(8 + length + begin); data = stream.read(expected)
        if len(data) != expected or not np.isfinite(np.frombuffer(data, dtype="<f4")).all():
            raise ValueError("Teacher actual cached tensor is truncated/nonfinite")
    return tensor["shape"]


def cache_source(row):
    return {"id": row["id"], "source_identity": identity(row), "transcript_sha256": text_sha(row["transcript"]),
            "words_sha256": digest(row["words"]), "start": row.get("start", 0), "duration": row["duration"]}


def verify_cache_row(row, record, path, *, samples, decoded_sha, sample_rate, frame_rate, codec_hash, dimension):
    if record.get("source") != cache_source(row) or record.get("mimi_encode_hash") != codec_hash:
        raise ValueError("Teacher cached latent belongs to different source/words/codec")
    if record.get("actual_resampled_samples") != samples or record.get("decoded_float32_sha256") != decoded_sha:
        raise ValueError("Teacher cache observation differs from actual decoded waveform")
    shape = latent_shape(path)
    available = record["encoded_frames_available"]
    if type(available) is not int or available < 1:
        raise ValueError("Teacher observed encoder frame inventory is invalid")
    expected = min(max(1, int(samples * frame_rate / sample_rate)), available)
    if (shape != [expected, dimension] or record.get("shape") != shape
            or record.get("sample_rate") != sample_rate or record.get("frame_rate") != frame_rate
            or record.get("latents_sha256") != file_sha(path)):
        raise ValueError("Teacher actual latent bytes/frames/dimension differ")
    from .runner import valid_words
    if not valid_words(row):
        raise ValueError("Teacher objective would use an overlapping loader fallback")
    cuts = [(float(row["words"][i - 1]["end"]) + float(word["start"])) / 2
        for i, word in enumerate(row["words"]) if i and row["words"][i - 1].get("end") is not None
        and word.get("start") is not None and (float(row["words"][i - 1]["end"]) + float(word["start"])) / 2 >= 1
        and row["duration"] - (float(row["words"][i - 1]["end"]) + float(word["start"])) / 2 >= 1]
    preferred = [cut for cut in cuts if any(word.get("end") is not None and word["end"] < 5
        and (word["end"] + row["words"][i + 1]["start"]) / 2 == cut
        for i, word in enumerate(row["words"][:-1]) if row["words"][i + 1].get("start") is not None)]
    last = max(word["end"] for word in row["words"] if word.get("end") is not None)
    for cut in preferred or cuts[:1]:
        cut_frames = min(max(round(cut * frame_rate), 1), shape[0] - 1)
        start = cut_frames / frame_rate
        end = min(row["duration"], last + .2) if last > start else row["duration"]
        target_frames = max(1, min(int(min(end - start, 30) * frame_rate), shape[0] - cut_frames))
        if last > (cut_frames + target_frames) / frame_rate + 1e-9:
            raise ValueError("Teacher actual latent target omits an aligned final word")
    return shape


def prepared_row(row):
    return {key: value for key, value in row.items() if key not in ("path", "latents_file")}


def encoder_file_hash(path):
    """The pinned Mimi encode hash, directly from actual accepted FP32 bytes."""
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        length = struct.unpack("<Q", stream.read(8))[0]
        if not 2 <= length <= 16 * 1024 ** 2:
            raise ValueError("Accepted teacher safetensors header is invalid")
        header = json.loads(stream.read(length))
        for module in ("encoder", "encoder_transformer", "downsample"):
            prefix = "mimi." + module + "."
            for key in sorted(name for name in header if name.startswith(prefix)):
                tensor = header[key]
                if tensor["dtype"] != "F32":
                    raise ValueError("Teacher encode weights must retain the declared FP32 precision")
                begin, end = tensor["data_offsets"]
                if end - begin != math.prod(tensor["shape"]) * 4:
                    raise ValueError("Teacher encode weight shape/byte length differs")
                h.update((key.removeprefix("mimi.") + ":" + str(tuple(tensor["shape"]))).encode())
                stream.seek(8 + length + begin); data = stream.read(end - begin)
                if len(data) != end - begin:
                    raise ValueError("Teacher encode weight bytes truncated")
                h.update(data)
    return h.hexdigest()


def verify_actual_cache(spec, *, decode_window=None):
    """Inspect real output receipts/tensors and independently decode each WAV.

    This runs after precompute and before a qualified teacher/student update. Input corpus receipts
    are never rewritten to add observations from a future cache.
    """
    import numpy as np
    from training.scripts.precompute_latents import _load_window
    decode_window = decode_window or _load_window
    prepared = read(spec.output / "prepared.json")
    cache_path = spec.output / "prepare/teacher-loader-cache.json"
    if (prepared.get("input_identity") != spec.identity or prepared.get("loader_cache_receipt_sha256") != file_sha(cache_path)):
        raise ValueError("Teacher prepared output does not bind the actual cache/input identity")
    cache = read(cache_path)
    if (cache.get("schema") != "teacher_actual_loader_cache_v2" or cache.get("input_identity") != spec.identity
            or cache.get("verifier_sha256") != file_sha(__file__)):
        raise ValueError("Teacher actual cache source/verifier identity differs")
    from . import student_transfer
    weights_key = "import_teacher_weights" if student_transfer.enabled(spec) else "teacher_anchor_weights"
    if cache.get("mimi_encode_hash") != encoder_file_hash(spec.asset(weights_key)):
        raise ValueError("Teacher actual cache is not bound to its accepted Mimi encode weights")
    import yaml
    config = yaml.safe_load((spec.output / "configs/teacher-inference.yaml").read_text())["mimi"]
    if (cache["sample_rate"] != config["sample_rate"] or cache["frame_rate"] != config["frame_rate"]
            or cache["latent_dimension"] != (config.get("inner_dim") or config["seanet"]["dimension"])):
        raise ValueError("Teacher cache rate/dimension differs from actual resolved codec config")
    manifests = {**spec.manifests, "teacher_regression": spec.asset("teacher_regression_manifest"),
                 "teacher_conditional": spec.asset("teacher_conditional_manifest")}
    for role, source in manifests.items():
        expected = rows(source)
        actual = rows(spec.output / "data" / (role + ".jsonl"))
        unique(expected, role); unique(actual, "prepared " + role)
        if ([prepared_row(row) for row in actual] != [prepared_row(row) for row in expected]
                or cache["prepared_manifest_sha256"][role] != file_sha(spec.output / "data" / (role + ".jsonl"))):
            raise ValueError("Teacher prepared words/metadata/manifest order changed")
        for original, staged in zip(expected, actual, strict=True):
            source_path = Path(original["path"])
            source_path = (spec.base / source_path).resolve() if not source_path.is_absolute() else source_path.resolve()
            if Path(staged["path"]).resolve() != source_path:
                raise ValueError("Teacher prepared waveform path changed")
    train = rows(spec.output / "data/train.jsonl")
    annotated = rows(spec.output / "data/train_latents.jsonl")
    if (cache.get("annotated_manifest_sha256") != file_sha(spec.output / "data/train_latents.jsonl")
            or [prepared_row(row) for row in annotated] != [prepared_row(row) for row in train]):
        raise ValueError("Teacher loader annotated manifest changed")
    if cache.get("ordered_rows_sha256") != digest([cache_source(row) for row in train]):
        raise ValueError("Teacher cache ordered row/word/caption identity differs")
    observations = unique(cache["rows"], "actual cache observations")
    if set(observations) != {row["id"] for row in train}:
        raise ValueError("Teacher actual cache observations omit/invent rows")
    for row in train:
        observation = observations[row["id"]]
        tagged = next(value for value in annotated if value["id"] == row["id"])
        if tagged.get("latents_file") != observation["latents_file"]:
            raise ValueError("Teacher loader points to another latent file")
        pcm = decode_window(row["path"], float(row.get("start", 0)), float(row["duration"]), cache["sample_rate"])
        decoded_sha = hashlib.sha256(np.asarray(pcm, dtype="<f4").tobytes()).hexdigest()
        path = (spec.output / "data" / observation["latents_file"]).resolve()
        if not path.is_relative_to((spec.output / "data/latents").resolve()):
            raise ValueError("Teacher runtime cache escaped its owned output folder")
        verify_cache_row(row, observation, path, samples=len(pcm), decoded_sha=decoded_sha,
            sample_rate=cache["sample_rate"], frame_rate=cache["frame_rate"],
            codec_hash=cache["mimi_encode_hash"], dimension=cache["latent_dimension"])
    calibration = (spec.output / "data" / cache["calibration_path"]).resolve()
    if not calibration.is_relative_to((spec.output / "data/latents").resolve()) or file_sha(calibration) != cache["calibration_sha256"]:
        raise ValueError("Teacher actual stitch calibration changed")
    value = read(calibration)
    if (type(value.get("stitch_frames")) is not int or value["stitch_frames"] < 1
            or not isinstance(value.get("noise_floor"), (int, float))
            or not math.isfinite(value["noise_floor"]) or value["noise_floor"] < 0):
        raise ValueError("Teacher actual stitch calibration is invalid")
    return {"status": "passed", "input_identity": spec.identity, "actual_decoded_rows": len(train),
            "cache_receipt_sha256": file_sha(cache_path), "verifier_sha256": file_sha(__file__)}
