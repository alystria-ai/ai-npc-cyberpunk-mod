"""Explicit conditioning pilots and separately admitted teacher/student stages.

No speaker identifier is inserted into text. Each draw retains the official
target crop/token RNG. Pairing and ID dropout use separate stateless streams.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

POLICY = "matched-pocket-conditioning-pilot-v2"
TRAINING_POLICY = "pocket-conditioning-training-v1"
WEIGHT_KEY = "flow_lm.voice_identity.embedding.weight"


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def speaker_key(signature):
    canonical, native_voice, game, package, locale, *_ = signature
    performer = "cyberpunk2077-en-v1"
    if canonical == "mr-hands":
        performer = "phantom-cast" if package == "phantom-liberty" else "base-cast"
    return [canonical, native_voice, locale, performer]


def options(spec):
    return spec.raw.get("speaker_conditioning")


def bound(base, value, field):
    path = Path(value[field])
    path = path if path.is_absolute() else base / path
    if file_hash(path) != value[field + "_sha256"]:
        raise ValueError(f"Conditioning {field} bytes changed")
    return path


def read_mapping(base, value):
    mapping = json.loads(bound(base, value, "mapping").read_text(encoding="utf-8"))
    keys = mapping["keys"]
    if keys != sorted(set(keys)) or not keys:
        raise ValueError("Conditioning mapping needs sorted unique native identities")
    digest = hashlib.sha256(encoded(keys)).hexdigest()
    if digest != mapping["mapping_sha256"]:
        raise ValueError("Conditioning mapping identity differs")
    rows = mapping["rows"]
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Conditioning mapping repeats a target row")
    for row in rows:
        sid = row["speaker_id"]
        if type(sid) is not int or not 1 <= sid <= len(keys) or encoded(row["speaker_identity"]).decode() != keys[sid - 1]:
            raise ValueError("Conditioning target ID does not match its native signature")
        if row["speaker_identity"] != speaker_key(row["voice_signature"]):
            raise ValueError("Speaker ID does not derive from authenticated native identity")
    return mapping


def identity_fields(raw, base):
    value = raw.get("speaker_conditioning")
    if value is None:
        return None
    required = {"policy", "arm", "pair_fraction", "id_dropout", "plan", "plan_sha256", "mapping", "mapping_sha256"}
    reference_fields = {"reference_bindings", "reference_bindings_sha256"}
    training = value.get("policy") == TRAINING_POLICY
    heldout_fields = {"heldout_bindings", "heldout_bindings_sha256", "heldout_selection_mode"}
    required |= {"stages"} if training else {"pilot_max_steps"}
    optional = reference_fields | (heldout_fields if training else {"id_learning_rate_scale"})
    if set(value) - required - optional or not required <= set(value):
        raise ValueError("Conditioning pilot fields differ from the explicit v2 contract")
    if value["policy"] not in {POLICY, TRAINING_POLICY} or value["arm"] not in {"baseline", "paired", "hybrid"}:
        raise ValueError("Unknown conditioning pilot")
    for key in ("pair_fraction", "id_dropout"):
        if not isinstance(value[key], (int, float)) or not math.isfinite(value[key]) or not 0 <= value[key] <= 1:
            raise ValueError("Conditioning probabilities must be finite proportions")
    if value["arm"] == "baseline" and value["pair_fraction"] != 0:
        raise ValueError("Baseline arm must retain the official same-utterance prompt")
    if value["arm"] != "hybrid" and value["id_dropout"] != 0:
        raise ValueError("Audio-only arms have no ID-dropout feature")
    if training:
        validate_stage_contract(raw, value)
    id_lr_scale = value.get("id_learning_rate_scale", 1.)
    if type(id_lr_scale) not in (int, float) or not math.isfinite(id_lr_scale) or not .1 <= id_lr_scale <= 10:
        raise ValueError("ID learning-rate scale must be explicit and within0.1..10")
    if value["arm"] != "hybrid" and id_lr_scale != 1:
        raise ValueError("Audio-only arms cannot use an ID learning-rate override")
    if not training:
        maximum = value["pilot_max_steps"]
        if type(maximum) is not int or not 1 <= maximum <= 500 or raw.get("teacher_max_steps") != maximum:
            raise ValueError("The finite pilot must declare the same 1..500 teacher step bound")
    if raw.get("speaker_balanced_sampling", False):
        raise ValueError("Matched pilot uses the frozen unique-row permutation, not repeated speaker sampling")
    plan = json.loads(bound(base, value, "plan").read_text(encoding="utf-8"))
    mapping = read_mapping(base, value)
    if (mapping["source_plan_sha256"] != value["plan_sha256"] or mapping["selected_sha256"] != plan["selected_sha256"]
            or mapping["choice_sha256"] != plan["choice_sha256"]):
        raise ValueError("Mapping, pairing and selected-corpus identities differ")
    expected_rows = {row["id"]: row["voice_signature"] for row in plan["rows"]}
    if {row["id"]: row["voice_signature"] for row in mapping["rows"]} != expected_rows:
        raise ValueError("Mapping rows differ from the native pairing policy")
    if set(mapping["fallback_row_ids"]) != {row["id"] for row in plan["source_blocked_fallback"]}:
        raise ValueError("Unknown-ID fallback rows differ from the pairing plan")
    if value["arm"] == "hybrid":
        if not reference_fields <= set(value):
            raise ValueError("Hybrid evaluation needs a source-reviewed reference-ID binding file")
        validate_reference_bindings(base, value, mapping)
        if training:
            if not heldout_fields <= set(value) or value["heldout_selection_mode"] not in {"id0", "bound"}:
                raise ValueError("Hybrid training needs reviewed heldout IDs and an explicit selection mode")
            validate_heldout_bindings(base, value, mapping)
    elif set(value) & reference_fields:
        raise ValueError("Audio-only pilots must not claim ID-bound references")
    if value["arm"] != "hybrid" and set(value) & heldout_fields:
        raise ValueError("Audio-only training cannot claim ID-bound heldout evaluation")
    return {**value, **({"id_learning_rate_scale": id_lr_scale} if not training else {}), "implementation_sha256": file_hash(__file__),
            "sampler_sha256": file_hash(Path(__file__).with_name("paired_sampler.py")),
            "control_weights_sha256": file_hash(Path(__file__).with_name("control_weights.py")),
            "known_ids": len(mapping["keys"]), "table_capacity": len(mapping["keys"])}


def validate_stage_contract(raw, value):
    """A post-pilot run declares each trained role; no inherited ID LR multiplier."""
    stages = value.get("stages")
    if not isinstance(stages, dict) or not stages or set(stages) - {"teacher", "distill"}:
        raise ValueError("Conditioning training needs explicit teacher/distill stage settings")
    if raw.get("pilot_diagnostic_manifest"):
        raise ValueError("Post-pilot training cannot retain diagnostic-only pilot admission")
    for stage, settings in stages.items():
        if set(settings) != {"max_steps", "learning_rate", "id_learning_rate_scale", "rollout_steps"}:
            raise ValueError("Each conditioning stage must bind steps, base LR, ID LR scale and speech schedule")
        maximum, lr, scale = settings["max_steps"], settings["learning_rate"], settings["id_learning_rate_scale"]
        if type(maximum) is not int or maximum < 1 or raw.get(stage + "_max_steps") != maximum:
            raise ValueError("Conditioning stage execution bound differs from the actual runner")
        if type(lr) not in (int, float) or not math.isfinite(lr) or not 0 < lr <= .01 or raw.get(stage + "_learning_rate") != lr:
            raise ValueError("Conditioning stage base learning rate must be explicitly bound")
        if type(scale) not in (int, float) or not math.isfinite(scale) or not .1 <= scale <= 10:
            raise ValueError("Conditioning stage ID LR scale must be in0.1..10")
        if value["arm"] != "hybrid" and scale != 1:
            raise ValueError("An audio-only stage cannot change ID learning rate")
        schedule = settings["rollout_steps"]
        field = "teacher_rollout_steps" if stage == "teacher" else "rollout_steps"
        if (not isinstance(schedule, list) or len(schedule) < 2 or any(type(n) is not int for n in schedule)
                or schedule != sorted(set(schedule)) or schedule[0] != 0 or schedule[-1] != maximum
                or raw.get(field) != schedule):
            raise ValueError("Conditioning stage speech schedule must cover its exact0..max_steps")


def stage_settings(spec, stage):
    value = options(spec)
    if not value or value["policy"] != TRAINING_POLICY:
        return None
    if stage not in value["stages"]:
        raise ValueError("This conditioning run did not authorize training the requested role")
    return value["stages"][stage]


def verify_resolved_stage(spec, args, stage):
    settings = stage_settings(spec, stage)
    if settings and (args._execution_max_steps != settings["max_steps"] or args.optim.lr != settings["learning_rate"]):
        raise ValueError("Resolved exposure or base LR differs from the explicit conditioning stage")


def stage_rollout_steps(raw, stage, fallback):
    value = raw.get("speaker_conditioning")
    if value and value["policy"] == TRAINING_POLICY:
        if stage not in value["stages"]:
            raise ValueError("No conditioning speech schedule is declared for this role")
        return value["stages"][stage]["rollout_steps"]
    return fallback


def validate_heldout_bindings(base, value, mapping):
    """Consume reviewed native evidence; this reader never guesses a speaker ID."""
    data = json.loads(bound(base, value, "heldout_bindings").read_text(encoding="utf-8"))
    if data.get("schema") != "reviewed-heldout-speaker-ids-v1" or data.get("mapping_sha256") != mapping["mapping_sha256"]:
        raise ValueError("Heldout IDs use another mapping or schema")
    seen = set()
    for row in data["rows"]:
        key = (row["split"], row["row_id"])
        if (row["split"] not in {"dev", "test", "teacher_regression", "teacher_conditional"}
                or not row["row_id"] or len(row["audio_sha256"]) != 64 or key in seen):
            raise ValueError("Heldout binding repeats or omits an exact source row")
        seen.add(key)
        sid = row["speaker_id"]
        if type(sid) is not int or not 0 <= sid <= len(mapping["keys"]):
            raise ValueError("Invalid heldout speaker ID")
        if sid:
            identity = json.loads(mapping["keys"][sid - 1])
            if row.get("speaker_identity") != identity or not row.get("segment_proofs"):
                raise ValueError("Known heldout ID needs matching native source evidence")
            for proof in row["segment_proofs"]:
                path = Path(proof["path"])
                path = path if path.is_absolute() else base / path
                if proof.get("speaker_identity") != identity or file_hash(path) != proof["sha256"]:
                    raise ValueError("Heldout native evidence changed")
        elif not row.get("fallback_reason"):
            raise ValueError("ID0 heldout fallback must state why no trained ID is bound")
    return data


def heldout_modes(spec):
    value = options(spec)
    if value and value["policy"] == TRAINING_POLICY and value["arm"] == "hybrid":
        return ("id0", "bound"), value["heldout_selection_mode"]
    return ("id0",), "id0"


def heldout_ids(spec, split, rows):
    from .runner import stable_row_id
    value = options(spec)
    mapping = read_mapping(spec.base, value)
    data = validate_heldout_bindings(spec.base, value, mapping)
    lookup = {(row["split"], row["row_id"], row["audio_sha256"]): row["speaker_id"] for row in data["rows"]}
    result = []
    for row in rows:
        key = (split, stable_row_id(row), row.get("audio_sha256"))
        if key not in lookup:
            raise ValueError("Heldout row has no reviewed exact ID or explicit ID0 binding")
        result.append(lookup[key])
    return result


def verify_heldout_coverage(spec):
    from .runner import rows_at
    modes, _ = heldout_modes(spec)
    if "bound" not in modes:
        return
    paths = {split: path for split, path in spec.manifests.items() if split != "train"}
    for split, field in (("teacher_regression", "teacher_regression_manifest"),
                         ("teacher_conditional", "teacher_conditional_manifest")):
        if spec.raw.get(field):
            paths[split] = spec.asset(field)
    if not paths:
        raise ValueError("Hybrid training requires actual heldout manifests before model allocation")
    for split, path in paths.items():
        heldout_ids(spec, split, rows_at(path))


def validate_reference_bindings(base, value, mapping):
    data = json.loads(bound(base, value, "reference_bindings").read_text(encoding="utf-8"))
    if data.get("schema") != "reviewed-reference-speaker-ids-v1" or data.get("mapping_sha256") != mapping["mapping_sha256"]:
        raise ValueError("Reference-ID bindings use another mapping")
    seen = set()
    for row in data["references"]:
        identity = (row["reference_id"], row["reference_sha256"])
        if identity in seen or len(row["reference_sha256"]) != 64:
            raise ValueError("Reference-ID bindings repeat or omit an exact reference hash")
        seen.add(identity)
        sid = row["speaker_id"]
        if type(sid) is not int or not 0 <= sid <= len(mapping["keys"]):
            raise ValueError("Invalid reference speaker ID")
        if sid:
            if row.get("speaker_identity") != json.loads(mapping["keys"][sid - 1]) or not row.get("segment_proofs"):
                raise ValueError("Known reference ID needs matching native segment provenance")
            for proof in row["segment_proofs"]:
                if proof.get("speaker_identity") != row["speaker_identity"]:
                    raise ValueError("A concatenated reference mixes native performance identities")
                path = Path(proof["path"])
                path = path if path.is_absolute() else base / path
                if file_hash(path) != proof["sha256"]:
                    raise ValueError("Reference segment proof changed")
        elif not row.get("fallback_reason"):
            raise ValueError("Reference-only fallback must state its uncertainty")
    return data


def configure(spec, config):
    value = options(spec)
    if value and value["arm"] == "hybrid":
        mapping = read_mapping(spec.base, value)
        config["flow_lm"]["voice_identity"] = {"abi": "pocket-voice-identity-residual-v1",
            "keys": mapping["keys"], "mapping_sha256": mapping["mapping_sha256"], "capacity": len(mapping["keys"])}
    elif config["flow_lm"].get("voice_identity") is not None:
        raise ValueError("Audio-only arm cannot silently load hybrid configuration")


def configure_args(spec, args, stage):
    value = options(spec)
    if value and value["arm"] == "hybrid":
        # Explicit new feature only for the pinned baseline teacher warm start.
        # Distillation starts from the trained hybrid teacher instead.
        args.voice_identity_new_init = stage == "teacher"
        import yaml
        config = yaml.safe_load(Path(args.model_config).read_text(encoding="utf-8"))
        args.voice_identity_init_source_sha256 = file_hash(config["weights_path"]) if stage == "teacher" else ""


def make_loader(spec, args, model, mimi):
    from .runner import IndexedBatches
    value = options(spec)
    if value is None:
        return IndexedBatches(args, model, mimi, balanced=bool(spec.option("speaker_balanced_sampling", False)))
    from .paired_sampler import PairedIndexedBatches
    cache_path = spec.output / "prepare/teacher-loader-cache.json"
    cache_kwargs = {}
    if cache_path.is_file():
        prepared = json.loads((spec.output / "prepared.json").read_text())
        cache_sha = file_hash(cache_path)
        if prepared.get("input_identity") != spec.identity or prepared.get("loader_cache_receipt_sha256") != cache_sha:
            raise ValueError("Prepared pilot does not bind the exact actual cache receipt")
        cache_kwargs = {"actual_cache_receipt": cache_path, "actual_cache_receipt_sha256": cache_sha}
    loader = PairedIndexedBatches(args, model, mimi, policy_path=bound(spec.base, value, "plan"),
        policy_sha256=value["plan_sha256"], pair_fraction=value["pair_fraction"], **cache_kwargs)
    if value["arm"] == "hybrid":
        mapping = read_mapping(spec.base, value)
        bank = getattr(model.flow_lm, "voice_identity", None)
        if bank is None or bank.mapping_sha256 != mapping["mapping_sha256"] or bank.capacity != len(mapping["keys"]):
            raise ValueError("Actual training model and loader speaker mappings differ")
        ids = {row["id"]: row["speaker_id"] for row in mapping["rows"]}
        ids.update({rid: 0 for rid in mapping["fallback_row_ids"]})
        loader.set_identity_policy(ids, mapping["mapping_sha256"], value["id_dropout"])
    elif getattr(model.flow_lm, "voice_identity", None) is not None:
        raise ValueError("Audio-only pilot loader received a hybrid model")
    return loader


def forward_kwargs(batch):
    return {"speaker_ids": batch.speaker_ids, "speaker_id_keep": batch.speaker_id_keep}


def reference_id(spec, reference):
    value = options(spec)
    if not value or value["arm"] != "hybrid":
        return None
    mapping = read_mapping(spec.base, value)
    bindings = validate_reference_bindings(spec.base, value, mapping)
    matches = [r for r in bindings["references"] if (r["reference_id"], r["reference_sha256"]) == (reference["id"], reference["sha256"])]
    if len(matches) != 1:
        raise ValueError("No unique reviewed ID/fallback for this exact conditioning reference")
    return matches[0]["speaker_id"]


def checkpoint_headers(spec, payload):
    """Used by the runner's actual atomic writer, including all best snapshots."""
    value = options(spec)
    state = payload.get("model", {})
    vector = state.get(WEIGHT_KEY)
    if not value or value["arm"] != "hybrid":
        if vector is not None:
            raise ValueError("Audio-only checkpoint contains an unbound identity table")
        return {}
    mapping = read_mapping(spec.base, value)
    from pocket_tts.modules.voice_identity import ABI
    import torch
    if vector is None or vector.ndim != 2 or vector.shape[0] != len(mapping["keys"]) + 1:
        raise ValueError("Hybrid runner checkpoint omitted or reshaped its identity table")
    def header(tensor):
        if tensor.shape != vector.shape or not bool(torch.isfinite(tensor).all()) or not bool((tensor[0] == 0).all()):
            raise ValueError("Invalid hybrid checkpoint table or nonzero unknown slot")
        return {"abi": ABI, "mapping_sha256": mapping["mapping_sha256"], "capacity": len(mapping["keys"]),
            "known_ids": len(mapping["keys"]), "dim": vector.shape[1], "unknown_id": 0,
            "table_sha256": hashlib.sha256(tensor.detach().float().cpu().contiguous().numpy().astype("<f4", copy=False).tobytes()).hexdigest()}
    headers = {"voice_identity": header(vector)}
    if payload.get("ema") is not None:
        if WEIGHT_KEY not in payload["ema"]:
            raise ValueError("Hybrid runner EMA omitted its identity table")
        headers["voice_identity_ema"] = header(payload["ema"][WEIGHT_KEY])
    return headers


def verify_checkpoint(spec, payload):
    headers = checkpoint_headers(spec, payload)
    for key in ("voice_identity", "voice_identity_ema"):
        if payload.get(key) != headers.get(key):
            raise ValueError("Checkpoint identity mapping/table metadata does not match selected bytes")


def pilot_rollout_steps(raw):
    value = raw.get("speaker_conditioning")
    if value and value["policy"] == TRAINING_POLICY:
        return stage_rollout_steps(raw, "teacher", None)
    return [0, 250, value["pilot_max_steps"]] if value and value["pilot_max_steps"] > 250 else ([0, value["pilot_max_steps"]] if value else [0, 500, 1000, 1500, 2000])


def diagnostics(model, ema):
    bank = getattr(model.flow_lm, "voice_identity", None)
    if bank is None:
        return {}
    import torch
    with torch.no_grad():
        return {"speaker_id_raw_l2": float(bank.embedding.weight.float().norm()),
            "speaker_id_raw_RMS": float(bank.embedding.weight[1:].float().square().mean().sqrt()),
            "speaker_id_gradient_l2": (None if bank.embedding.weight.grad is None else float(bank.embedding.weight.grad.float().norm())),
            "speaker_id_gradient_RMS": (None if bank.embedding.weight.grad is None else float(bank.embedding.weight.grad[1:].float().square().mean().sqrt())),
            "speaker_id_ema_l2": float(ema.shadow[WEIGHT_KEY].float().norm()),
            "speaker_id_nonzero_rows": int((bank.embedding.weight[1:].abs().sum(dim=1) > 0).sum())}


def configure_optimizer(spec, model, optimizer, *, stage=None):
    value = options(spec)
    if not value or value["arm"] != "hybrid":
        return
    parameter = model.flow_lm.voice_identity.embedding.weight
    matched = [group for group in optimizer.param_groups if any(p is parameter for p in group["params"])]
    if len(matched) != 1 or parameter in optimizer.state:
        raise ValueError("ID optimizer group must be established exactly once before any update/resume")
    original = matched[0]
    if original.get("use_muon", False):
        raise ValueError("Speaker embeddings must use the existing auxiliary Adam optimizer")
    original["params"] = [p for p in original["params"] if p is not parameter]
    group = {key: value for key, value in original.items() if key != "params"}
    settings = stage_settings(spec, stage)
    scale = settings["id_learning_rate_scale"] if settings else value.get("id_learning_rate_scale", 1.)
    group.update(params=[parameter], lr_scale=original.get("lr_scale", 1.) * scale, lr=original["lr"] * scale,
        conditioning_id_group=True)
    optimizer.add_param_group(group)
