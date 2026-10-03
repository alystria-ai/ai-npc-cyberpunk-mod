"""Candidate-only hooks over the independently tested native source contracts.

Metadata may describe a recoverable source; it cannot publish attributed audio.
The candidate CAST must run the explicit dependency gate inside CpuSlots, then
its unchanged original WEM/subtitle payload gates before decode/cache return.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path

POLICY = "registered_native_main_recovery_v1"
MAIN_POLICY = "registered_native_main_for_all_v1"
BUNDLE = "runtime/voice-data-expansion-20261003/source-admission-review/bank-experiment-complete-01.json"
READER_SHA = "46aef2aaecd6ecd23cad9c7d214da440c3e4fd37754405cec3153aefb6e93ddb"
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("candidate_native_source_contracts", HERE / "native_source_contracts.py")
contracts = importlib.util.module_from_spec(spec)
if hashlib.sha256((HERE / "native_source_contracts.py").read_bytes()).hexdigest() != READER_SHA:
    raise ValueError("Reviewed source recovery contract bytes changed")
spec.loader.exec_module(contracts)
_READERS = {}


def enabled(candidate):
    return isinstance(candidate.get("sourceRecovery"), dict) and candidate["sourceRecovery"].get("policy") == POLICY


def reader_for(project, api):
    project = Path(project).resolve()
    if project not in _READERS:
        inventory = api["read_json"](api["project_file"]("runtime/voice-references/inventory.json", project))
        game = Path(inventory["gameRoot"])
        archive_paths = [*api["extract"].ARCHIVES, "archive/pc/content/audio_1_general.archive",
                         *api["SCENE_ARCHIVES"]]
        indexes = {path: api["extract"].Archive(game, path) for path in archive_paths if (game / path).is_file()}
        _READERS[project] = contracts.NativeSourceContracts(project, BUNDLE, indexes)
    return _READERS[project]


def declaration_dependencies(reader):
    # Every declaration read by resolve_main is authenticated: this also binds
    # conflict absence and preserved bank alternatives, not just the chosen map.
    return [{"depotPath": asset["source"]["depotPath"], "archive": asset["source"]["archive"],
             "entrySha1": asset["source"]["archiveEntrySha1"], "rawSha256": asset["rawSha256"],
             "jsonSha256": asset["jsonSha256"], "dataSha256": asset["dataSha256"],
             "rawPath": asset["rawPath"], "jsonPath": asset["jsonPath"], "role": "native-voice-declaration"}
            for asset in reader.bundle["nativeSources"]]


def native_dependencies(reader, scene, english):
    deps = declaration_dependencies(reader)
    doc = reader.scene(scene)
    deps.append({**scene, "dataSha256": contracts.canonical_data(doc["Data"]), "role": "speaking-scene"})
    for evidence in english["externalOriginals"]:
        source = evidence["indexRow"]["source"]
        raw = "research/cyberpunk/cache/game/localization/" + source["rawPath"]
        js = "research/cyberpunk/cache/game/localization/" + source["jsonPath"]
        doc = contracts.json_no_duplicates(reader.project / js)
        deps.append({"depotPath": source["depotPath"], "archive": source["archivePath"],
                     "entrySha1": source["archiveEntrySha1"], "rawSha256": evidence["rawSha256"],
                     "jsonSha256": evidence["jsonSha256"], "dataSha256": contracts.canonical_data(doc["Data"]),
                     "rawPath": raw, "jsonPath": js, "role": "original-english-subtitle"})
    unique = {}
    for dep in deps:
        coordinate = dep["depotPath"]
        if coordinate in unique and any(unique[coordinate][field] != dep[field]
                for field in ("archive", "entrySha1", "rawSha256", "jsonSha256", "dataSha256")):
            raise ValueError("Conflicting native recovery dependency declarations")
        unique[coordinate] = dep
    return list(unique.values())


def validate_candidate(candidate, roster, project, api, *, reader=None):
    recovery = candidate.get("sourceRecovery")
    if not enabled(candidate) or recovery.get("bundlePath") != BUNDLE or recovery.get("bundleSha256") != contracts.PINNED_BUNDLE:
        raise ValueError("Explicit reviewed source recovery policy and exact native bundle required")
    reader = reader or reader_for(project, api)
    source = candidate["scene"]
    doc = reader.scene(source)
    a, l = candidate["actor"], candidate["line"]
    actor, line, event, sid = reader.emitted(doc, a["pointer"], l["pointer"], candidate["event"]["pointer"])
    if (api["ident"](a["id"]) != api["ident"](actor["actorId"]["id"]) or a["name"] != actor["actorName"]
            or api["ident"](a["voicetagId"]) != api["ident"](actor["voicetagId"]["id"])
            or api["ident"](l["speakerId"]) != api["ident"](line["speaker"]["id"])
            or api["ident"](l["itemId"]) != api["ident"](line["itemId"]["id"])
            or api["ident"](l["locstringId"]) != sid or candidate["stringId"] != sid):
        raise ValueError("Recovery native actor/speaker/item/event/localization claims differ")
    identity = reader.require_actor_identity(actor, a["identityProof"], roster, doc, project, source, a["pointer"], api["validate_identity"])
    speakers = event.get("additionalSpeakers", {}).get("speakers", [])
    mirror = None
    if speakers or recovery.get("mirrorReview") is not None:
        review = recovery.get("mirrorReview")
        if not isinstance(review, dict):
            raise ValueError("Additional recipients require the exact scoped Holocall mirror review")
        mirror = reader.mirror(doc, source, a["pointer"], l["pointer"], candidate["event"]["pointer"], review, identity)
    physical = {"female": "f", "male": "m"}.get(candidate["genderVariant"])
    if physical is None:
        raise ValueError("Recovery requires explicit physical audio variant")
    main = reader.resolve_main(sid, physical, requested_path=candidate["wemPath"])
    english = reader.english(doc, source, sid, physical, recovery.get("externalEnglishSources", []))
    e = candidate["english"]
    if (e.get("mode") != english["mode"] or e.get("variant") != english["captionVariant"]
            or e.get("transcript") != english["originalText"]
            or e.get("transcriptSha256") != english["originalTextSha256"]):
        raise ValueError("Recovery exact original English mode/variant/text/hash differs")
    selected = None
    if english["embeddedEnglishDescriptorCount"]:
        selected = next((match for match in english["embeddedEnglish"]
                         if match["descriptorPointer"] == e.get("descriptorPointer") and match["payloadPointer"] == e.get("payloadPointer")), None)
        if selected is None:
            raise ValueError("Recovery embedded English needs its exact matching native pointers")
    elif e.get("descriptorPointer") is not None or e.get("payloadPointer") is not None:
        raise ValueError("External-only recovery cannot fabricate native English descriptor pointers")
    delivery = reader.delivery(event)
    supplied = candidate.get("sourceDelivery")
    observed = {field: delivery[field] for field in ("kind", "isHolocallSpeaker", "voExpression", "customVoEvent", "waveformProcessingAssessed")}
    if (not isinstance(supplied, dict) or any(supplied.get(field) != value or type(supplied.get(field)) is not type(value)
            for field, value in observed.items()) or not isinstance(supplied.get("reason"), str) or not supplied["reason"].strip()):
        raise ValueError("Recovery source delivery must explicitly preserve native flags")
    plan = {"policy": POLICY, "bundleSha256": contracts.PINNED_BUNDLE,
            "mainRepresentation": main, "independentActorIdentity": identity, "mirrorRouting": mirror,
            "originalEnglish": english, "nativeDelivery": delivery, "nativeDependencies": native_dependencies(reader, source, english),
            **contracts.metadata_flags()}
    native_english = {**e, "locale": "en_us"}
    if selected:
        native_english.update(vpeIndex=selected["descriptor"]["vpeIndex"],
                              variantId=api["ident"](selected["descriptor"]["variantId"]["ruid"]))
    return {"scene": source, "actor": {**a, "identityVerification": identity["metadataVerification"]},
            "line": l, "event": {"pointer": candidate["event"]["pointer"], **event},
            "english": native_english, "sourceDelivery": {**observed, "reason": supplied["reason"]},
            "sourceRecovery": plan}


def authenticate(plan, project, out, archives, verified, api):
    if not api["CpuSlots"].held_by_this_process():
        raise RuntimeError("Source recovery authentication requires the existing CPU slot lease")
    # CAST's ordinary archive list does not include audio_1_general.archive,
    # which holds the language registry. Read any required missing index here,
    # inside the lease; do not reuse a pre-lease metadata index as live proof.
    by_archive = {archive.relative: archive for archive in archives}
    missing = {dep["archive"] for dep in plan["nativeDependencies"]} - set(by_archive)
    if missing:
        game = Path(api["read_json"](api["project_file"]("runtime/voice-references/inventory.json", project))["gameRoot"])
        for relative in sorted(missing):
            by_archive[relative] = api["extract"].Archive(game, relative)
    current_archives = list(by_archive.values())
    def winner(dep):
        api["verify_live_scene"](dep, current_archives)
        return {"currentInstalledWinnerAuthenticated": True, "archive": dep["archive"], "entrySha1": dep["entrySha1"]}
    def serialized(dep):
        actual = api["authenticate_serialization"](dep, project, out, verified)
        return {"freshSerializationAuthenticated": True, "rawSha256": actual["rawSha256"],
                "jsonSha256": actual["cachedJsonSha256"], "dataSha256": actual["dataSha256"], "toolSha256": actual["toolSha256"]}
    return contracts.authenticate_recovery_dependencies(plan, winner, serialized)


def validate_main(candidate, project, api, *, reader=None):
    if candidate.get("registeredMainPolicy") != MAIN_POLICY:
        raise ValueError("Unknown job-wide registered MAIN policy")
    physical = {"female": "f", "male": "m"}.get(candidate.get("genderVariant"))
    reader = reader or reader_for(project, api)
    result = reader.resolve_main(candidate["stringId"], physical, requested_path=candidate["wemPath"])
    return {"policy": MAIN_POLICY, "mainRepresentation": result,
            "nativeDependencies": declaration_dependencies(reader), **contracts.metadata_flags()}


def persist_validation(candidate, native, authentication, project, out, receipt, api):
    if not api["CpuSlots"].held_by_this_process():
        raise RuntimeError("Source recovery sidecar requires its CPU slot lease")
    key, sid, gender = candidate["key"], api["ident"](candidate["stringId"]), candidate["genderVariant"]
    if not api["KEY"].fullmatch(key) or gender not in ("female", "male"):
        raise ValueError("Unsafe recovery sidecar coordinates")
    canonical = lambda value: json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    original = out / key / (sid + "-" + gender) / "receipt.json"
    body = {"schema": "registered_native_recovery_revalidation_v1", "inputSha256": receipt["inputSha256"],
            "key": key, "stringId": sid, "genderVariant": gender,
            "identityProof": candidate["actor"]["identityProof"], "recoveryRequest": candidate["sourceRecovery"],
            "metadataPlan": native["sourceRecovery"], "nativeDependencyAuthentication": authentication,
            "originalCandidateReceiptSha256": api["digest"](original) if original.is_file() else None,
            "audioDecodedByThisValidation": False, "originalMediaRewritten": False, "trainingAdmitted": False}
    encoded = canonical(body) + b"\n"
    checksum = hashlib.sha256(encoded).hexdigest()
    directory = out / "recovery-validation" / key / (sid + "-" + gender)
    if not api["extract"].contained(directory, out):
        raise ValueError("Recovery sidecar escaped its lane")
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (checksum + ".json")
    try:
        with target.open("xb") as stream:
            stream.write(encoded)
    except FileExistsError:
        if target.read_bytes() != encoded:
            raise ValueError("Immutable recovery validation sidecar changed")
    return {"path": target.relative_to(project).as_posix(), "sha256": checksum,
            "nativeDependenciesAuthenticated": True, "audioDecodedByThisValidation": False, "trainingAdmitted": False}


def persist_main_validation(candidate, plan, authentication, project, out, receipt, api):
    # Reuse the immutable writer with an explicit request/plan. It records the
    # original independent actor proof and never asserts identity from the map.
    synthetic = {**candidate, "sourceRecovery": {"policy": MAIN_POLICY, "registeredMainPolicy": candidate["registeredMainPolicy"]}}
    native = {"sourceRecovery": {**plan, "actorIdentityInferredFromMap": False}}
    return persist_validation(synthetic, native, authentication, project, out, receipt, api)
