"""Prepare a private, scene-separated cast corpus from installed English speech.

Uses cached eligibility metadata and authenticated native casting receipts. No
network, inference, game writes, or audio processing is performed. Existing
evaluation scenes and original reference recordings are reserved. Output must
be a new pocket-expanded-* directory below runtime/voice-references.
"""
from __future__ import annotations

import argparse
import array
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unicodedata
import wave
import zipfile


ROOT = Path(__file__).resolve().parents[1]
CORE = {"johnny-silverhand": "johnny", "judy-alvarez": "judy", "panam-palmer": "panam"}
SPLITS = ("train", "dev", "test")
UNSUPPORTED = {"8ug8ear", "jake-estevez", "resident-male", "resident-female"}
REFERENCE_RECEIPTS = (
    "runtime/pocket-30s-reference-20261002/measurements.json",
    "runtime/pocket-reference-test-20261002/measurements.json",
)
ORIGINAL_COMPARISON_ID = "3743548582201815040"
MAX_CANDIDATES = 50000
MAX_JSON_BYTES = 128 * 1024 * 1024
EVENT_CACHE = {}


def load_helper(filename, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    old = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = old
    return module


CAST = load_helper("Cast-VoiceReferenceCandidates.py", "pocket_cast_validation")
EXTRACT = CAST.extract


def read_json(path):
    if not 0 < path.stat().st_size <= MAX_JSON_BYTES:
        raise ValueError("JSON exceeds corpus input bounds: " + str(path))
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def digest(path):
    return CAST.digest(path)


def canonical_text(text):
    return re.sub(r"[^\w]+", " ", unicodedata.normalize("NFKC", text).casefold()).strip()


def canonical_scene(path):
    return CAST.depot(path, ".scene")


def project_file(value):
    return CAST.project_file(str(value) if isinstance(value, Path) else value, ROOT)


def output_directory(value):
    path = Path(value)
    path = (path if path.is_absolute() else ROOT / path).resolve()
    parent = (ROOT / "runtime/voice-references").resolve()
    if path.parent != parent or not re.fullmatch(r"pocket-expanded-[a-zA-Z0-9-]+", path.name):
        raise ValueError("Output must be an immediate runtime/voice-references/pocket-expanded-* directory")
    return path


def plain_text_reason(text, duration=None):
    if isinstance(text, str) and re.search(r"mothertongue|translated[_ -]?speech", text, re.I):
        return "translated_or_unverifiable_spoken_language"
    if (not isinstance(text, str) or not text.strip() or len(text) > 4000
            or "\ufffd" in text or re.search(r"[<>\[\]{}\x00-\x1f\x7f]", text)
            or text.count("!") > 1):
        return "non_plain_spoken_text"
    words = len(canonical_text(text).split())
    if words < 5:
        return "too_few_words"
    if duration is not None and (not 3 <= duration <= 12 or not .9 <= words / duration <= 4.2):
        return "duration_or_text_rate"
    return None


def special_scene(paths):
    return any(re.search(r"(?:call|holo|underwater|diving|singing|singalong|braindance|finalboards)", p, re.I)
               for p in paths)


class Rejections:
    def __init__(self):
        self.rows = []

    def add(self, key, string_id, reason, detail=None, phase="metadata"):
        row = {"speaker_id": key, "id": str(string_id), "reason": reason, "phase": phase}
        if detail:
            row["detail"] = str(detail)[:1800]
        self.rows.append(row)

    def counts(self, key=None):
        return dict(Counter(r["reason"] for r in self.rows if key is None or r["speaker_id"] == key))


class SceneStore:
    """Authenticated installed scene Data, using output-owned temporary exports."""
    def __init__(self, game, out):
        self.game, self.out = game, out
        self.archives = [EXTRACT.Archive(game, p) for p in CAST.SCENE_ARCHIVES]
        self.oodle = EXTRACT.Oodle(game / "tools/redmod/bin/oo2ext_7_win64.dll")
        self.documents, self.receipts, self.verified = {}, {}, {}
        self.errors = {}
        self.frozen_verifications = {}

    def cached(self, scene):
        depot = canonical_scene(scene["depotPath"])
        if depot in self.errors:
            raise ValueError(self.errors[depot])
        if depot in self.documents:
            if self.receipts[depot]["scene"]["entrySha1"] != scene["entrySha1"]:
                raise ValueError("Conflicting cached native scene receipts")
            if self.receipts[depot]["scene"]["jsonSha256"] != scene["jsonSha256"]:
                document = CAST.validate_native_source(scene, ROOT)
                if document["Data"] != self.documents[depot]["Data"]:
                    raise ValueError("Alternate scoped serialization does not match authenticated installed native Data")
                verification = {**self.receipts[depot]["serializationVerification"], "cachedJsonSha256": scene["jsonSha256"]}
                return document, {"scene": scene, "archiveSource": self.receipts[depot]["archiveSource"],
                                  "serializationVerification": verification}
            return self.documents[depot], self.receipts[depot]
        document = CAST.validate_native_source(scene, ROOT)
        CAST.verify_live_scene(scene, self.archives)
        data, live = CAST.winning(self.archives, depot, self.oodle)
        if live["sha256"] != scene["rawSha256"] or live["archiveEntrySha1"] != scene["entrySha1"]:
            raise ValueError("Cached scene differs from decoded installed archive")
        verification = self.frozen_verifications.get((scene["rawSha256"], scene["jsonSha256"]))
        if verification:
            actual_data_hash = hashlib.sha256(json.dumps(document["Data"], ensure_ascii=False, sort_keys=True,
                separators=(",", ":")).encode("utf-8")).hexdigest()
            if (verification.get("verified") is not True or verification.get("toolSha256") != CAST.WOLVENKIT_SHA256
                    or verification.get("rawSha256") != scene["rawSha256"]
                    or verification.get("cachedJsonSha256") != scene["jsonSha256"]
                    or verification.get("dataSha256") != actual_data_hash):
                raise ValueError("Frozen pinned native serialization receipt does not match current raw/JSON/Data")
        else:
            verification = CAST.authenticate_serialization(scene, ROOT, self.out, self.verified)
        receipt = {"scene": scene, "archiveSource": live, "serializationVerification": verification}
        self.documents[depot], self.receipts[depot] = document, receipt
        return document, receipt

    def installed(self, depot_path):
        depot = canonical_scene(depot_path)
        if depot in self.errors:
            raise ValueError(self.errors[depot])
        if depot in self.documents:
            return self.documents[depot], self.receipts[depot]
        data, live = CAST.winning(self.archives, depot, self.oodle)
        target = self.out / "native-scenes" / str(EXTRACT.depot_hash(depot))
        target.mkdir(parents=True, exist_ok=True)
        raw, serialized = target / "source.scene", target / "source.scene.json"
        saved_path = target / "provenance.json"
        if raw.exists() and digest(raw) != live["sha256"]:
            raise ValueError("Expanded scene snapshot no longer matches installed resource")
        if not raw.exists():
            raw.write_bytes(data)
        cli = ROOT / "vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe"
        CAST.checked_hash(cli, CAST.WOLVENKIT_SHA256, "Pinned native serializer")
        env = {**os.environ, "DOTNET_ROOT": str(ROOT / "vendor/dotnet-runtime-10.0.12"), "DOTNET_PROCESSOR_COUNT": "2"}
        saved = read_json(saved_path) if saved_path.is_file() else None
        if saved:
            if (saved["scene"]["rawSha256"] != live["sha256"] or saved["scene"]["entrySha1"] != live["archiveEntrySha1"]
                    or saved["scene"]["archive"] != live["archive"] or digest(serialized) != saved["scene"]["jsonSha256"]
                    or saved["serializationVerification"]["toolSha256"] != CAST.WOLVENKIT_SHA256
                    or saved["serializationVerification"].get("verified") is not True):
                raise ValueError("Completed expanded native serialization receipt changed")
        # Incomplete exports have no authenticated receipt and are serialized
        # again. Merely finding a well-formed JSON file never proves its source.
        if not serialized.exists() or saved is None:
            subprocess.run([str(cli), "convert", "serialize", str(raw)], cwd=ROOT, env=env,
                           capture_output=True, check=True, timeout=120,
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        document = read_json(serialized)
        if Path(document["Header"]["ArchiveFileName"]).resolve() != raw:
            raise ValueError("Expanded native serialization points at a different source")
        data_hash = hashlib.sha256(json.dumps(document["Data"], ensure_ascii=False, sort_keys=True,
                                             separators=(",", ":")).encode("utf-8")).hexdigest()
        if saved and data_hash != saved["serializationVerification"]["dataSha256"]:
            raise ValueError("Completed expanded native Data hash changed")
        receipt = {"scene": {"depotPath": depot, "archive": live["archive"], "entrySha1": live["archiveEntrySha1"],
                              "rawPath": raw.relative_to(ROOT).as_posix(), "rawSha256": live["sha256"],
                              "jsonPath": serialized.relative_to(ROOT).as_posix(), "jsonSha256": digest(serialized)},
                   "archiveSource": live, "serializationVerification": {"verified": True,
                       "tool": "WolvenKit.CLI 9.0.1", "toolSha256": CAST.WOLVENKIT_SHA256,
                       "rawSha256": live["sha256"], "cachedJsonSha256": digest(serialized), "dataSha256": data_hash}}
        self.documents[depot], self.receipts[depot] = document, receipt
        write_json(saved_path, receipt)
        return document, receipt

    def prefetch(self, items, cached=False):
        """Two independent CPU serializers, each restricted to its allowlist."""
        unique = {}
        for item in items:
            depot = canonical_scene(item["depotPath"] if cached else item)
            unique.setdefault(depot, item)
        pending = [(p, item) for p, item in unique.items() if p not in self.documents]
        if not pending:
            return
        actual_method = self.cached if cached else self.installed
        def method(item):
            with CAST.CpuSlots(ROOT, timeout=300):
                return actual_method(item)
        # Load the Oodle function synchronously before concurrent decoding.
        first, item = pending.pop(0)
        try:
            method(item)
        except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
            self.errors[first] = str(error)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = {pool.submit(method, item): depot for depot, item in pending}
            for i, future in enumerate(as_completed(futures), 1):
                depot = futures[future]
                try:
                    future.result()
                except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
                    self.errors[depot] = str(error)
                if i % 10 == 0 or i == len(futures):
                    print(json.dumps({"phase": "native_export", "completed": i + 1, "requested": len(unique),
                                      "authenticatedScenes": len(self.receipts), "failedScenes": len(self.errors)}), flush=True)

    def reuse_completed_verifications(self, selection=None, supplements=()):
        """Only hash-bound parser receipts are reusable; game bytes are reread."""
        bindings = []
        if selection:
            for row in selection.get("candidates", []):
                bindings.extend(row.get("nativeBindings", []))
        for path in sorted((ROOT / "runtime/voice-cast").glob("*/manifest.json")):
            for row in read_json(path).get("candidates", []):
                binding = row.get("provenance", {}).get("nativeActor")
                if binding:
                    bindings.append(binding)
        for source in supplements:
            for row in source.get("candidates", []) + source.get("sources", []):
                bindings.extend(row.get("nativeBindings", []))
        for binding in bindings:
            scene, verification = binding.get("scene"), binding.get("serializationVerification")
            if scene and verification:
                self.frozen_verifications[(scene["rawSha256"], scene["jsonSha256"])] = verification


def walk(value, pointer=""):
    if isinstance(value, dict):
        yield pointer, value
        for key, child in value.items():
            yield from walk(child, pointer + "/" + key.replace("~", "~0").replace("/", "~1"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, pointer + "/" + str(index))


def event_index(document):
    token = id(document)
    if token in EVENT_CACHE:
        return EVENT_CACHE[token]
    events = defaultdict(list)
    for pointer, row in walk(document["Data"]["RootChunk"].get("sceneGraph", {}), "/Data/RootChunk/sceneGraph"):
        if row.get("$type") == "scnDialogLineEvent":
            events[CAST.ident(row["screenplayLineId"]["id"])].append((pointer, row))
    EVENT_CACHE[token] = events
    return events


def english_entries(document, string_id, transcript=None):
    store = document["Data"]["RootChunk"]["locStore"]
    rows = []
    for index, descriptor in enumerate(store.get("vdEntries", [])):
        if descriptor.get("localeId") != "en_us" or CAST.ident(descriptor["locstringId"]["ruid"]) != string_id:
            continue
        vpe = descriptor.get("vpeIndex")
        if isinstance(vpe, bool) or not isinstance(vpe, int) or not 0 <= vpe < len(store["vpEntries"]):
            raise ValueError("Malformed exact English native localization join")
        payload = store["vpEntries"][vpe]
        if descriptor.get("variantId") != payload.get("variantId") or not isinstance(payload.get("content"), str):
            raise ValueError("Native English variant identity does not agree")
        text = payload["content"]
        if transcript is None or text == transcript:
            rows.append({"descriptorPointer": f"/Data/RootChunk/locStore/vdEntries/{index}",
                         "payloadPointer": f"/Data/RootChunk/locStore/vpEntries/{vpe}", "transcript": text,
                         "variantId": CAST.ident(descriptor["variantId"]["ruid"]),
                         "signature": descriptor.get("signature")})
    if not rows or len({r["transcript"] for r in rows}) != 1:
        raise ValueError("Missing or ambiguous exact native English text")
    return rows


def actor_binding(document, receipt, actor_pointer, roster, proof):
    actor = CAST.pointer(document, actor_pointer)
    if actor.get("$type") != "scnActorDef":
        raise ValueError("Actor binding points outside a native actor definition")
    verified = CAST.validate_identity(actor, proof, roster, document, ROOT, receipt["scene"], actor_pointer)
    return {"scene": receipt["scene"], "serializationVerification": receipt["serializationVerification"],
            "actor": {"pointer": actor_pointer, "id": CAST.ident(actor["actorId"]["id"]),
                      "name": actor["actorName"], "voicetagId": CAST.ident(actor["voicetagId"]["id"]),
                      "identityProof": proof, "identityVerification": verified}}


def describe_delivery(event):
    params = event.get("voParams", {})
    custom = params.get("customVoEvent")
    custom = custom.get("$value", "None") if isinstance(custom, dict) else custom
    custom = "None" if custom in (None, "None", "", "0") else custom
    expression, holo = params.get("voExpression"), bool(params.get("isHolocallSpeaker"))
    kind = ("canonical-custom-performance" if custom != "None" else
            "canonical-media-performance" if expression == "Vo_Expression_GlobalTV" else
            "canonical-phone-performance" if expression == "Vo_Expression_Phone" or holo else "ordinary-spoken")
    supplied = {"kind": kind, "isHolocallSpeaker": holo, "voExpression": expression, "customVoEvent": custom,
                "waveformProcessingAssessed": False,
                "reason": "Original installed canonical delivery. Event flags do not establish processing embedded in the WEM; original PCM is unchanged."}
    return CAST.source_delivery(event, supplied)


def line_binding(document, binding, line_index, english_text=None, allow_canonical=False):
    line = document["Data"]["RootChunk"]["screenplayStore"]["lines"][line_index]
    if line.get("$type") != "scnscreenplayDialogLine" or CAST.ident(line["speaker"]["id"]) != binding["actor"]["id"]:
        raise ValueError("Native screenplay line does not belong to the authenticated actor")
    item, loc = CAST.ident(line["itemId"]["id"]), CAST.ident(line["locstringId"]["ruid"])
    events = event_index(document).get(item, [])
    if not events:
        raise ValueError("Native speech line has no typed dialogue event")
    observed = []
    for pointer, event in events:
        delivery = describe_delivery(event) if allow_canonical else CAST.source_delivery(event)
        if event.get("additionalSpeakers", {}).get("speakers"):
            raise ValueError("Additional native speakers make the performance ambiguous")
        if not allow_canonical and delivery["kind"] != "ordinary-spoken":
            raise ValueError("Native delivery is not ordinary speech")
        observed.append({"pointer": pointer, "durationSeconds": event["duration"] / 1000, "delivery": delivery})
    english = english_entries(document, loc, english_text)
    return {**binding, "line": {"pointer": f"/Data/RootChunk/screenplayStore/lines/{line_index}",
              "itemId": item, "speakerId": binding["actor"]["id"], "locstringId": loc},
            "events": observed, "english": english}


class SubtitleIndex:
    def __init__(self, path):
        self.path = path
        self.db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
        self.cache = {}

    def rows(self, string_id):
        if string_id not in self.cache:
            self.cache[string_id] = CAST.indexed_subtitles(self.db, string_id)
        return self.cache[string_id]

    def close(self):
        self.db.close()


def manifest_bindings(supported, scenes, rejections):
    bindings, inputs = {}, []
    native_scenes = []
    for path in sorted((ROOT / "runtime/voice-cast").glob("*/manifest.json")):
        for row in read_json(path).get("candidates", []):
            if row.get("key") in supported and row.get("key") not in CORE:
                scene = row.get("provenance", {}).get("nativeActor", {}).get("scene")
                if scene:
                    native_scenes.append(scene)
    for path in sorted((ROOT / "runtime/voice-cast").glob("*/candidates*.json")):
        for row in read_json(path).get("candidates", []):
            if row.get("key") in supported and row.get("key") not in CORE and isinstance(row.get("scene"), dict) and row.get("actor"):
                native_scenes.append(row["scene"])
    scenes.prefetch(native_scenes, cached=True)
    for path in sorted((ROOT / "runtime/voice-cast").glob("*/manifest.json")):
        manifest = read_json(path)
        inputs.append({"path": path.relative_to(ROOT).as_posix(), "sha256": digest(path)})
        for row in manifest.get("candidates", []):
            key = row.get("key")
            if key not in supported or key in CORE:
                continue
            native = row.get("provenance", {}).get("nativeActor", {})
            if row.get("attributionVerified") is not True or not native.get("scene"):
                continue
            token = (key, canonical_scene(native["scene"]["depotPath"]), native["pointer"])
            if token in bindings:
                continue
            try:
                document, receipt = scenes.cached(native["scene"])
                binding = actor_binding(document, receipt, native["pointer"], supported[key], native["identityProof"])
                bindings[token] = (document, binding)
            except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
                rejections.add(key, row.get("stringId", "unknown"), "native_actor_binding_failed", error)
    for path in sorted((ROOT / "runtime/voice-cast").glob("*/candidates*.json")):
        manifest = read_json(path)
        inputs.append({"path": path.relative_to(ROOT).as_posix(), "sha256": digest(path)})
        for row in manifest.get("candidates", []):
            key = row.get("key")
            if key not in supported or key in CORE or not isinstance(row.get("scene"), dict) or not row.get("actor"):
                continue
            scene, actor = row["scene"], row["actor"]
            token = (key, canonical_scene(scene["depotPath"]), actor["pointer"])
            if token in bindings:
                continue
            try:
                CAST.validate_native(row, supported[key], ROOT)
                document, receipt = scenes.cached(scene)
                binding = actor_binding(document, receipt, actor["pointer"], supported[key], actor["identityProof"])
                bindings[token] = (document, binding)
            except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
                rejections.add(key, row.get("stringId", "unknown"), "native_actor_binding_failed", error)
    return bindings, inputs


def native_candidate(key, document, binding, line_index, index, wem_paths, source, allow_canonical=True, source_only=False):
    line = document["Data"]["RootChunk"]["screenplayStore"]["lines"][line_index]
    string_id = CAST.ident(line["locstringId"]["ruid"])
    subtitles = index.rows(string_id)
    texts = {r.get("femaleVariant") for r in subtitles}
    if len(texts) != 1 or not isinstance(next(iter(texts)), str) or not next(iter(texts)).strip():
        return None, "native_indexed_subtitle_disagreement"
    text = next(iter(texts))
    native = line_binding(document, binding, line_index, text, allow_canonical=allow_canonical)
    hint = native["events"][0]["durationSeconds"]
    reason = None if source_only else plain_text_reason(text, hint)
    if reason:
        return None, reason
    special_context = special_scene([binding["scene"]["depotPath"]])
    if not allow_canonical and special_context:
        return None, "processed_or_special_scene"
    # Exact native voicetag and actor binding establish the speaker. The WEM
    # suffix establishes localization/gender; no prefix guesses establish identity.
    suffix = f"_f_{int(string_id):016x}.wem"
    paths = wem_paths.get(suffix, [])
    if len(paths) != 1:
        return None, "ambiguous_or_missing_english_wem"
    kinds = sorted({e["delivery"]["kind"] for e in native["events"]})
    partition = "canonical_delivery" if special_context or kinds != ["ordinary-spoken"] else "ordinary"
    return {"key": key, "stringId": string_id, "wemPath": paths[0], "partition": partition,
            "deliveryKinds": kinds, "specialContextPath": special_context,
            "subtitlePaths": sorted({CAST.depot(r["source"]["depotPath"], ".json") for r in subtitles}),
            "scenePaths": [canonical_scene(binding["scene"]["depotPath"])], "indexedTranscript": text,
            "durationHintSeconds": hint, "durationHintKind": "native-event", "nativeBindings": [native],
            "metadataSource": source}, None


def discover_native(supported, scenes, index, wem_paths, rejections):
    bindings, inputs = manifest_bindings(supported, scenes, rejections)
    candidates = {}
    observed_scenes = defaultdict(set)
    for (key, depot, _), (document, binding) in bindings.items():
        for i, line in enumerate(document["Data"]["RootChunk"].get("screenplayStore", {}).get("lines", [])):
            if line.get("$type") != "scnscreenplayDialogLine" or CAST.ident(line["speaker"]["id"]) != binding["actor"]["id"]:
                continue
            string_id = CAST.ident(line["locstringId"]["ruid"])
            observed_scenes[(key, string_id)].add(depot)
            try:
                row, reason = native_candidate(key, document, binding, i, index, wem_paths, "authenticated_cast_scene")
                if reason:
                    rejections.add(key, string_id, reason)
                    continue
                token = (key, string_id)
                if token in candidates:
                    previous = candidates[token]
                    if previous["wemPath"] != row["wemPath"] or previous["indexedTranscript"] != row["indexedTranscript"]:
                        raise ValueError("Reused native line has inconsistent original audio or transcript")
                    previous["scenePaths"] = sorted(set(previous["scenePaths"] + row["scenePaths"]))
                    previous["nativeBindings"].extend(row["nativeBindings"])
                    previous["deliveryKinds"] = sorted(set(previous["deliveryKinds"] + row["deliveryKinds"]))
                    if row["partition"] == "canonical_delivery":
                        previous["partition"] = "canonical_delivery"
                else:
                    candidates[token] = row
            except (ValueError, KeyError, TypeError) as error:
                rejections.add(key, string_id, "native_line_join_failed", error)
    for token, row in candidates.items():
        row["scenePaths"] = sorted(observed_scenes[token])
    return list(candidates.values()), inputs, len(bindings)


def discover_core(supported, scenes, rejections):
    result, inputs = [], []
    requested_scenes = set()
    for key in CORE:
        source = read_json(ROOT / "runtime/voice-references/training" / key / "eligible.json")
        for row in source["candidates"]:
            if not plain_text_reason(row["indexedTranscript"], row["durationFromRemoteIndexSeconds"]):
                requested_scenes.update(row["scenePaths"])
    scenes.prefetch(sorted(requested_scenes))
    for key, actor_name in CORE.items():
        path = ROOT / "runtime/voice-references/training" / key / "eligible.json"
        source = read_json(path)
        inputs.append({"path": path.relative_to(ROOT).as_posix(), "sha256": digest(path),
                       "cachedEligibleClips": len(source["candidates"])})
        for row in source["candidates"]:
            string_id = row["stringId"]
            reason = plain_text_reason(row["indexedTranscript"], row["durationFromRemoteIndexSeconds"])
            if {x.casefold() for x in row.get("speakerNames", [])} != {actor_name} or row.get("expressions") != ["Vo_Expression_Spoken"]:
                reason = "speaker_or_delivery_not_unambiguous"
            if reason:
                rejections.add(key, string_id, reason)
                continue
            native, failed = [], None
            for depot in row["scenePaths"]:
                try:
                    document, receipt = scenes.installed(depot)
                    aliases = {CAST.normalized(x) for x in [supported[key]["name"], *supported[key].get("aliases", []), actor_name]}
                    actors = [(i, a) for i, a in enumerate(document["Data"]["RootChunk"].get("actors", []))
                              if CAST.normalized(a.get("actorName", "")) in aliases]
                    if len(actors) != 1:
                        raise ValueError("Core native scene actor is missing or ambiguous")
                    actor_index, actor = actors[0]
                    proof = {"kind": "reviewed_actor_alias", "canonicalKey": key, "actorName": actor["actorName"],
                             "reviewer": "pocket-cast-corpus", "reason": "Cached explicit single-speaker eligibility and exact named core actor; typed native actor/speaker/localization/event joins are rechecked."}
                    binding = actor_binding(document, receipt, f"/Data/RootChunk/actors/{actor_index}", supported[key], proof)
                    lines = [(i, line) for i, line in enumerate(document["Data"]["RootChunk"].get("screenplayStore", {}).get("lines", []))
                             if line.get("$type") == "scnscreenplayDialogLine" and CAST.ident(line["locstringId"]["ruid"]) == string_id]
                    if len(lines) != 1:
                        raise ValueError("Core exact native localization line is missing or reused ambiguously")
                    native.append(line_binding(document, binding, lines[0][0], row["indexedTranscript"], allow_canonical=True))
                except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
                    failed = error
                    break
            if failed:
                rejections.add(key, string_id, "native_core_join_failed", failed)
                continue
            kinds = sorted({e["delivery"]["kind"] for b in native for e in b["events"]})
            context = special_scene(row["scenePaths"])
            result.append({"key": key, "stringId": string_id, "wemPath": CAST.depot(row["wemPath"], ".wem"),
                "partition": "canonical_delivery" if context or kinds != ["ordinary-spoken"] else "ordinary",
                "deliveryKinds": kinds, "specialContextPath": context,
                "subtitlePaths": sorted({CAST.depot(p, ".json") for p in row["subtitlePaths"]}),
                "scenePaths": sorted({canonical_scene(p) for p in row["scenePaths"]}),
                "indexedTranscript": row["indexedTranscript"], "durationHintSeconds": row["durationFromRemoteIndexSeconds"],
                "durationHintKind": "remote-index", "nativeBindings": native, "metadataSource": row["metadataSource"]})
        print(json.dumps({"phase": "native_core", "speaker_id": key, "eligible": len(source["candidates"]),
                          "verified": sum(r["key"] == key for r in result), "rejections": rejections.counts(key)}), flush=True)
    return result, inputs


def load_supplementals(path, supported, roster):
    if path is None:
        return None
    source = read_json(project_file(path))
    if source.get("schemaVersion") != 1 or not isinstance(source.get("characters"), list):
        raise ValueError("Supplemental native actor inventory needs schemaVersion1 and characters")
    for row in source["characters"]:
        key = row["key"]
        if key in roster or not CAST.KEY.fullmatch(key) or not row.get("records") or not row.get("bindings"):
            raise ValueError("Supplemental identity is duplicate or missing exact record/bindings")
        identity = {"key": key, "name": row["name"], "aliases": row.get("aliases", []), "records": row["records"]}
        roster[key], supported[key] = identity, identity
    return source


def discover_supplementals(source, supported, scenes, index, wem_paths, rejections):
    candidates = {}
    if source is None:
        return []
    requested = [b["scene"] for r in source["characters"] for b in [r.get("anchor", {}), *r["bindings"]] if b.get("scene")]
    scenes.prefetch(requested, cached=True)
    for row in source["characters"]:
        key = row["key"]
        anchor = row.get("anchor")
        anchor_binding = None
        if anchor:
            document, receipt = scenes.cached(anchor["scene"])
            anchor_binding = actor_binding(document, receipt, anchor["actorPointer"], supported[key], anchor["identityProof"])
            if anchor["identityProof"]["kind"] != "direct_actor_record":
                raise ValueError("Supplemental cross-scene actor anchor must be a typed active canonical record")
        for supplied in row["bindings"]:
            try:
                document, receipt = scenes.cached(supplied["scene"])
                binding = actor_binding(document, receipt, supplied["actorPointer"], supported[key], supplied["identityProof"])
                if anchor_binding:
                    if binding["actor"]["voicetagId"] != anchor_binding["actor"]["voicetagId"]:
                        raise ValueError("Supplemental alias voice does not match its typed canonical record anchor")
                    binding["canonicalRecordAnchor"] = anchor_binding
                for i, line in enumerate(document["Data"]["RootChunk"].get("screenplayStore", {}).get("lines", [])):
                    if line.get("$type") != "scnscreenplayDialogLine" or CAST.ident(line["speaker"]["id"]) != binding["actor"]["id"]:
                        continue
                    string_id = CAST.ident(line["locstringId"]["ruid"])
                    try:
                        candidate, reason = native_candidate(key, document, binding, i, index, wem_paths, "supplemental_authenticated_native_actor")
                        spoken_language = row.get("spokenLanguage", "eng")
                        source_only = row.get("englishTrainingEligible") is False or spoken_language != "eng"
                        if source_only:
                            candidate, reason = native_candidate(key, document, binding, i, index, wem_paths,
                                "supplemental_authenticated_native_actor", source_only=True)
                        if reason:
                            rejections.add(key, string_id, reason)
                            continue
                        candidate["spokenLanguage"] = spoken_language
                        candidate["englishTrainingEligible"] = not source_only
                        if source_only:
                            candidate["partition"] = "source_only"
                        token = (key, string_id)
                        if token in candidates:
                            previous = candidates[token]
                            if previous["wemPath"] != candidate["wemPath"] or previous["indexedTranscript"] != candidate["indexedTranscript"]:
                                raise ValueError("Supplemental reused line disagrees across source scenes")
                            previous["scenePaths"] = sorted(set(previous["scenePaths"] + candidate["scenePaths"]))
                            previous["nativeBindings"].extend(candidate["nativeBindings"])
                            previous["deliveryKinds"] = sorted(set(previous["deliveryKinds"] + candidate["deliveryKinds"]))
                            if candidate["partition"] == "canonical_delivery":
                                previous["partition"] = "canonical_delivery"
                        else:
                            candidates[token] = candidate
                    except (ValueError, KeyError, TypeError) as error:
                        rejections.add(key, string_id, "supplemental_native_line_failed", error)
            except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
                rejections.add(key, "unknown", "supplemental_native_actor_failed", error)
    return list(candidates.values())


def ingest_qualified_supplement(source, supported, roster, scenes, index, rejections):
    """Recheck caller-reviewed, exact native/public rows without harvesting aliases."""
    for speaker in source.get("speakers", []):
        key = speaker["key"]
        if key not in roster:
            if not CAST.KEY.fullmatch(key) or not isinstance(speaker.get("name"), str):
                raise ValueError("Invalid supplemental corpus speaker")
            identity = {"key": key, "name": speaker["name"], "aliases": speaker.get("aliases", []),
                        "records": speaker.get("records", [])}
            roster[key], supported[key] = identity, identity
    result = []
    for row in source.get("candidates", []):
        key, string_id = row["key"], row["stringId"]
        try:
            if key not in supported or not row.get("nativeBindings"):
                raise ValueError("Supplemental candidate has no enrolled exact native speaker")
            reason = plain_text_reason(row["indexedTranscript"], row["durationHintSeconds"])
            if reason:
                rejections.add(key, string_id, reason)
                continue
            for supplied in row["nativeBindings"]:
                document, receipt = scenes.cached(supplied["scene"])
                actor = supplied["actor"]
                binding = actor_binding(document, receipt, actor["pointer"], supported[key], actor["identityProof"])
                pointer = supplied["line"]["pointer"]
                if not re.fullmatch(r"/Data/RootChunk/screenplayStore/lines/[0-9]+", pointer):
                    raise ValueError("Supplemental line pointer is outside typed native store")
                native = line_binding(document, binding, int(pointer.rsplit("/", 1)[-1]), row["indexedTranscript"], allow_canonical=True)
                if native["line"] != supplied["line"] or native["line"]["locstringId"] != string_id:
                    raise ValueError("Supplemental exact actor/speaker/item/localization join changed")
            subtitle_rows = index.rows(string_id)
            if any(r.get("femaleVariant") != row["indexedTranscript"] for r in subtitle_rows):
                raise ValueError("Supplemental native/indexed exact English subtitles disagree")
            if not CAST.depot(row["wemPath"], ".wem").endswith(f"_f_{int(string_id):016x}.wem"):
                raise ValueError("Explicit supplemental WEM gender/localization suffix disagrees")
            # Multiple installed suffix paths require this exact reviewed path;
            # only the provided native/public row is accepted, never a guess.
            result.append({**row, "spokenLanguage": "eng", "englishTrainingEligible": True})
        except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
            rejections.add(key, string_id, "qualified_supplement_revalidation_failed", error)
    return result


def ingest_source_only(source, supported, roster, scenes, index, rejections):
    result = []
    for supplied in source.get("sources", []):
        key, string_id = supplied["speaker_id"], supplied["stringId"]
        try:
            if key not in supported or supplied.get("englishTrainingEligible") is not False:
                raise ValueError("Foreign source-only original is not explicitly excluded from English training")
            bindings = []
            subtitle_rows = index.rows(string_id)
            texts = {r.get("femaleVariant") for r in subtitle_rows}
            if len(texts) != 1 or not isinstance(next(iter(texts)), str):
                raise ValueError("Source-only exact native subtitle is missing or ambiguous")
            text = next(iter(texts))
            if not re.search(r'<kiroshi\b[^>]*\bl=["\']jpn["\']', text):
                raise ValueError("Source-only Japanese language declaration is missing from exact native markup")
            for raw in supplied["nativeBindings"]:
                document, receipt = scenes.cached(raw["scene"])
                actor = raw["actor"]
                binding = actor_binding(document, receipt, actor["pointer"], supported[key], actor["identityProof"])
                native = line_binding(document, binding, int(raw["line"]["pointer"].rsplit("/", 1)[-1]), text, allow_canonical=True)
                if native["line"] != raw["line"] or native["line"]["locstringId"] != string_id:
                    raise ValueError("Japanese source-only actor/localization joins changed")
                bindings.append(native)
            result.append({"key": key, "stringId": string_id, "wemPath": supplied["wemPath"],
                "subtitlePaths": sorted({CAST.depot(r["source"]["depotPath"], ".json") for r in subtitle_rows}),
                "scenePaths": sorted({canonical_scene(b["scene"]["depotPath"]) for b in bindings}),
                "indexedTranscript": text, "durationHintSeconds": bindings[0]["events"][0]["durationSeconds"],
                "durationHintKind": "native-event", "nativeBindings": bindings, "partition": "source_only",
                "deliveryKinds": sorted({e["delivery"]["kind"] for b in bindings for e in b["events"]}),
                "spokenLanguage": "jpn", "englishTrainingEligible": False, "audioSourceExpectation": supplied["audioSource"],
                "metadataSource": "exact native/public Japanese original; translated English supervision excluded"})
        except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
            rejections.add(key, string_id, "source_only_revalidation_failed", error)
    return result


def waveform(path):
    """Read original PCM without changing it; hashes ignore WAV header variants."""
    with wave.open(str(path), "rb") as stream:
        channels, width, rate, frames = (stream.getnchannels(), stream.getsampwidth(),
                                         stream.getframerate(), stream.getnframes())
        if channels not in (1, 2) or width != 2 or not 8000 <= rate <= 192000 or not 0 < frames <= rate * 120:
            raise ValueError("Expected complete original 16-bit PCM speech")
        pcm = stream.readframes(frames)
    if len(pcm) != frames * channels * width or not 44 <= path.stat().st_size <= EXTRACT.MAX_RESOURCE_BYTES * 4:
        raise ValueError("Original decoded WAV is truncated or exceeds its byte bound")
    header = struct.pack("<HHIQ", channels, width * 8, rate, frames)
    pcm_hash = hashlib.sha256(header + pcm).hexdigest()
    try:
        import numpy as np
        values = np.frombuffer(pcm, dtype="<i2").astype(np.int32)
        peak = int(np.abs(values).max())
        rms = float(np.sqrt(np.mean(values.astype(np.float64) ** 2)))
        clipped = int(np.count_nonzero(np.abs(values) >= 32767))
        block = max(1, round(rate * .02)) * channels
        full = len(values) // block
        power = values[:full * block].astype(np.float64).reshape(full, block)
        active = np.sqrt(np.mean(power ** 2, axis=1)) >= 32768 * 10 ** (-55 / 20)
        active_fraction = float(np.mean(active)) if full else float(bool(peak))
        indices = np.flatnonzero(active)
        leading = float(indices[0] * .02) if len(indices) else frames / rate
        trailing = float((full - indices[-1] - 1) * .02) if len(indices) else frames / rate
    except ImportError:
        values = array.array("h", pcm)
        if sys.byteorder != "little":
            values.byteswap()
        peak = max(abs(v) for v in values)
        rms = math.sqrt(sum(v * v for v in values) / len(values))
        clipped = sum(abs(v) >= 32767 for v in values)
        block = max(1, round(rate * .02)) * channels
        active = [math.sqrt(sum(v * v for v in values[i:i + block]) / len(values[i:i + block]))
                  >= 32768 * 10 ** (-55 / 20) for i in range(0, len(values), block)]
        active_fraction = sum(active) / len(active)
        positions = [i for i, a in enumerate(active) if a]
        leading = positions[0] * .02 if positions else frames / rate
        trailing = (len(active) - positions[-1] - 1) * .02 if positions else frames / rate
    return {"channels": channels, "sampleRate": rate, "bitsPerSample": width * 8, "frames": frames,
            "durationSeconds": frames / rate, "peakAbsolute": peak,
            "rmsDbfs": 20 * math.log10(rms / 32768) if rms else None,
            "clippedSamples": clipped, "nonSilent": bool(peak), "sha256": digest(path),
            "pcmSha256": pcm_hash, "activeFrameFractionAtMinus55Dbfs": active_fraction,
            "leadingLowEnergySeconds": round(leading, 3), "trailingLowEnergySeconds": round(trailing, 3)}


def holdouts(registry, extra_receipts):
    """Reserve all original references, not generated utterances or private data."""
    ids, texts, wav_hashes, pcm_hashes, wem_hashes = set(), set(), set(), set(), set()
    rows, sources, old_scenes = [], [], {"dev": set(), "test": set()}
    old_eval_pcm, old_eval_texts = set(), set()
    paths_seen = set()
    known_rows = []

    def add(row, key=None, source=None):
        key = key or row.get("key")
        string_id = row.get("stringId") or row.get("id")
        if key and string_id:
            ids.add((key, str(string_id)))
        text = row.get("transcript") or row.get("text")
        if text:
            texts.add(canonical_text(text))
        wav = row.get("wavPath") or row.get("reference") or row.get("path") or row.get("audio_path")
        if wav:
            path = Path(wav)
            path = (path if path.is_absolute() else ROOT / path).resolve()
            if not EXTRACT.contained(path, ROOT) or not path.is_file():
                raise ValueError("Reserved original reference is missing or outside project: " + str(path))
            if path not in paths_seen:
                quality = waveform(path)
                expected = row.get("sha256") or row.get("wav", {}).get("sha256")
                if expected and quality["sha256"] != expected:
                    raise ValueError("Reserved original reference hash changed: " + str(path))
                wav_hashes.add(quality["sha256"])
                pcm_hashes.add(quality["pcmSha256"])
                paths_seen.add(path)
            if key and path.stem.isdigit():
                ids.add((key, path.stem))
        wem_hash = row.get("source", {}).get("sha256") or row.get("provenance", {}).get("audio", {}).get("sha256")
        if wem_hash:
            wem_hashes.add(wem_hash)
        if key:
            rows.append({"key": key, "stringId": str(string_id) if string_id else None,
                         "scenePaths": row.get("scenePaths", []), "transcript": text,
                         "source": source, "audio": wav})

    for key, row in registry["voices"].items():
        if key in UNSUPPORTED or not row.get("reference"):
            continue
        add(row, key, "runtime/local-voices.json")
        receipt_path = row.get("sourceReceipt")
        if receipt_path:
            path = project_file(receipt_path)
            if row.get("sourceReceiptSha256") and digest(path) != row["sourceReceiptSha256"]:
                raise ValueError("Accepted source receipt changed")
            source = read_json(path)
            known_rows.append(source)
            add({**source, "wavPath": source.get("reference"), "scenePaths": [source["provenance"]["nativeActor"]["scene"]["depotPath"]]},
                key, receipt_path)
    reference_paths = [ROOT / "runtime/voice-references/extracted/manifest.json",
                       ROOT / "runtime/voice-references/panam-extracted/manifest.json"]
    reference_paths += sorted((ROOT / "runtime/voice-cast").glob("*/manifest.json"))
    for path in reference_paths:
        if not path.exists():
            continue
        sources.append({"path": path.relative_to(ROOT).as_posix(), "sha256": digest(path)})
        for row in read_json(path).get("candidates", []):
            if row.get("key") in UNSUPPORTED:
                continue
            add(row, source=path.relative_to(ROOT).as_posix())
            known_rows.append(row)
    for key in CORE:
        directory = ROOT / "runtime/voice-references/training" / key
        old_manifest = read_json(directory / "manifest.json")
        known_rows.extend(old_manifest["candidates"])
        old_by_id = {r["stringId"]: r for r in old_manifest["candidates"]}
        path = directory / "selection.json"
        sources.append({"path": path.relative_to(ROOT).as_posix(), "sha256": digest(path)})
        for row in read_json(path)["candidates"]:
            if row["split"] in old_scenes:
                old_scenes[row["split"]].update(canonical_scene(p) for p in row["scenePaths"])
                # Evaluation PCM remains eligible for its old evaluation split.
                original = old_by_id.get(row["stringId"])
                if original:
                    quality = waveform(Path(original["wavPath"]))
                    if quality["sha256"] != original["wav"]["sha256"]:
                        raise ValueError("Original evaluation WAV hash changed")
                    old_eval_pcm.add(quality["pcmSha256"])
                    old_eval_texts.add(canonical_text(original["transcript"]))
                    rows.append({"key": key, "stringId": original["stringId"], "scenePaths": original["scenePaths"],
                                 "transcript": original["transcript"], "source": "old_" + row["split"],
                                 "wav": quality})
    for receipt_name in dict.fromkeys((*REFERENCE_RECEIPTS, *extra_receipts)):
        receipt = ROOT / receipt_name if not Path(receipt_name).is_absolute() else Path(receipt_name)
        if not receipt.is_file():
            if receipt_name in extra_receipts:
                raise ValueError("Explicit reference receipt is missing")
            continue
        if not EXTRACT.contained(receipt, ROOT):
            raise ValueError("Reference receipt escapes the project")
        source = read_json(receipt)
        sources.append({"path": receipt.relative_to(ROOT).as_posix(), "sha256": digest(receipt)})
        source_rows = source.get("sources", []) + source.get("combined_sources", [])
        if not source_rows:
            raise ValueError("Reference receipt has no resolvable original conditioning sources")
        for row in source_rows:
            name = row.get("path") or row.get("file")
            if not isinstance(name, str) or not name:
                raise ValueError("Conditioning source has no exact original path/filename")
            stem, expected = Path(name).stem, row.get("sha256")
            if row.get("path"):
                actual_path = project_file(row["path"])
                actual = digest(actual_path)
                if expected and actual != expected:
                    raise ValueError("Experimental conditioning source hash changed")
                expected = actual
            matches = [known for known in known_rows
                       if (expected is None or (known.get("wav", {}).get("sha256") or known.get("sha256")) == expected)
                       and (not stem.isdigit() or str(known.get("stringId")) == stem)]
            identities = {(r.get("key"), str(r.get("stringId"))) for r in matches}
            if len(identities) != 1:
                raise ValueError("Experimental source lacks an unambiguous known native recording: " + name)
            add(matches[0], source=receipt.relative_to(ROOT).as_posix())
    ids.add(("johnny-silverhand", ORIGINAL_COMPARISON_ID))
    return {"ids": ids, "texts": texts, "wav_hashes": wav_hashes, "pcm_hashes": pcm_hashes,
            "wem_hashes": wem_hashes, "rows": rows, "sources": sources, "old_scenes": old_scenes,
            "old_eval_pcm": old_eval_pcm, "old_eval_texts": old_eval_texts}


class Components:
    def __init__(self):
        self.parents = {}

    def find(self, key):
        self.parents.setdefault(key, key)
        if self.parents[key] != key:
            self.parents[key] = self.find(self.parents[key])
        return self.parents[key]

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            low, high = sorted((a, b))
            self.parents[high] = low

    def connect(self, paths):
        if not paths:
            return
        paths = [canonical_scene(p) for p in paths]
        for path in paths:
            self.union(paths[0], path)


def assign_splits(candidates, reserved, seed):
    graph = Components()
    transcripts, audio = {}, {}
    for row in [*candidates, *reserved["rows"]]:
        paths = row.get("scenePaths", [])
        graph.connect(paths)
        if not paths:
            continue
        root = canonical_scene(paths[0])
        text = canonical_text(row.get("indexedTranscript") or row.get("transcript") or "")
        if text:
            if text in transcripts:
                graph.union(root, transcripts[text])
            transcripts[text] = root
        pcm = row.get("wav", {}).get("pcmSha256")
        if pcm:
            if pcm in audio:
                graph.union(root, audio[pcm])
            audio[pcm] = root
    labels = defaultdict(set)
    for split, paths in reserved["old_scenes"].items():
        for path in paths:
            labels[graph.find(path)].add(split)
    result, groups = [], defaultdict(list)
    for row in candidates:
        group = graph.find(canonical_scene(row["scenePaths"][0]))
        group_id = hashlib.sha256((seed + group).encode("utf-8")).hexdigest()[:24]
        marked = labels[group]
        split = "eval_conflict" if len(marked) > 1 else next(iter(marked)) if marked else "train"
        result.append({**row, "split": split, "sceneGroup": group_id})
        groups[group_id].append(row)
    # Sparse cast members retain their available source scenes in training.
    # Old, independently reserved scenes supply the comparison sets; no row is
    # moved out of an existing evaluation component merely to hit a ratio.
    return result, {group: {"clips": len(rows), "scenes": sorted({s for r in rows for s in r["scenePaths"]})}
                    for group, rows in groups.items()}


def decoded_candidate(candidate, out, voice_archives, text_archives, oodle, tools):
    key, string_id = candidate["key"], candidate["stringId"]
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", key) or CAST.ident(string_id) != string_id:
        raise ValueError("Invalid exact speaker/localization identity")
    wem_path = CAST.depot(candidate["wemPath"], ".wem")
    if not wem_path.endswith(f"_f_{int(string_id):016x}.wem"):
        raise ValueError("Original WEM localization suffix/gender disagrees")
    matches = [x for archive in voice_archives if (x := archive.read(wem_path, oodle))]
    expectation = candidate.get("audioSourceExpectation")
    if expectation:
        matches = [x for x in matches if x[1]["archive"] == expectation["archive"]]
    if len(matches) != 1:
        raise ValueError("English WEM is missing or ambiguous across installed archives")
    wem, voice_source = matches[0]
    if expectation and any(voice_source[field] != expectation[field] for field in ("archive", "archiveEntrySha1", "sha256")):
        raise ValueError("Explicit source-only original differs from its installed archive receipt")
    if len(wem) < 12 or wem[:4] != b"RIFF" or wem[8:12] != b"WAVE" or int.from_bytes(wem[4:8], "little") + 8 != len(wem):
        raise ValueError("Original WEM is not a complete bounded RIFF container")
    subtitle_sources = []
    for subtitle_path in candidate["subtitlePaths"]:
        if "\\localization\\en-us\\subtitles\\" not in subtitle_path:
            raise ValueError("Not an exact English subtitle resource")
        data, source = CAST.winning(text_archives, subtitle_path, oodle)
        parsed = EXTRACT.local_subtitle(data, string_id, "femaleVariant")
        if parsed is None:
            continue
        if parsed[0] != candidate["indexedTranscript"]:
            raise ValueError("Exact installed subtitle disagrees with indexed/native text")
        subtitle_sources.append({**source, **parsed[1]})
    if not subtitle_sources:
        raise ValueError("Exact installed subtitle entry is missing")
    directory = out / "clips" / key / string_id
    if directory.exists():
        saved = read_json(directory / "receipt.json")
        if (saved["source"]["sha256"] != voice_source["sha256"] or saved["transcript"] != candidate["indexedTranscript"]
                or saved["candidate"] != candidate):
            raise ValueError("Existing expanded clip has different immutable provenance")
        if digest(directory / "source.wem") != voice_source["sha256"] or digest(directory / "speech.wav") != saved["wav"]["sha256"]:
            raise ValueError("Existing expanded original WEM/WAV hash changed")
        if (directory / "transcript.txt").read_text(encoding="utf-8").removesuffix("\n") != candidate["indexedTranscript"]:
            raise ValueError("Existing expanded exact transcript changed")
        return saved
    directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".decode-", dir=directory.parent) as temporary:
        stage = Path(temporary)
        wem_file, wav_file = stage / "source.wem", stage / "speech.wav"
        wem_file.write_bytes(wem)
        decoder = EXTRACT.hidden_run([tools["vgmstream-cli"]["path"], "-i", "-o", str(wav_file), str(wem_file)])
        quality = waveform(wav_file)
        probe = json.loads(EXTRACT.hidden_run([tools["ffprobe"]["path"], "-v", "error", "-show_streams",
                           "-show_format", "-of", "json", str(wav_file)]).stdout)
        CAST.verify_probe(probe, quality)
        (stage / "transcript.txt").write_text(candidate["indexedTranscript"] + "\n", encoding="utf-8")
        item = {"key": key, "stringId": string_id, "scenePaths": candidate["scenePaths"],
                "transcript": candidate["indexedTranscript"], "transcriptSource": "installed_game_subtitle_entry",
                "source": voice_source, "subtitleSources": subtitle_sources, "candidate": candidate,
                "wav": quality, "decoderOutput": decoder.stdout.strip(), "ffprobe": probe,
                "audioProcessing": "Original vgmstream PCM decode only; no gain/EQ/denoise/resample/trim/concat",
                "wavPath": str(directory / "speech.wav"), "wemPath": str(directory / "source.wem"),
                "listeningVerified": False, "attributionVerified": True, "localTranscriptVerified": True}
        item["spokenLanguage"] = candidate.get("spokenLanguage", "eng")
        item["englishTrainingEligible"] = candidate.get("englishTrainingEligible", True)
        item["transcriptRole"] = "spoken_english" if item["englishTrainingEligible"] else "native_markup_with_translated_english_subtitle"
        write_json(stage / "receipt.json", item)
        stage.rename(directory)
    return item


def quality_reason(row, reserved):
    quality, candidate = row["wav"], row["candidate"]
    if not quality["nonSilent"] or quality["rmsDbfs"] is None or quality["rmsDbfs"] < -35:
        return "silent_or_low_audio_level"
    if quality["clippedSamples"]:
        return "clipped_audio"
    if quality["activeFrameFractionAtMinus55Dbfs"] < .2 or max(quality["leadingLowEnergySeconds"], quality["trailingLowEnergySeconds"]) > 1.5:
        return "mostly_silent_or_excessive_edge_silence"
    duration = quality["durationSeconds"]
    source_only = candidate.get("englishTrainingEligible") is False
    if not source_only and not 3 <= duration <= 12.35:
        return "decoded_duration_out_of_bounds"
    tolerance = .35 if row["key"] == "johnny-silverhand" else .15
    hints = ([candidate["durationHintSeconds"]] if candidate["durationHintKind"] == "remote-index" else
             [e["durationSeconds"] for b in candidate["nativeBindings"] for e in b["events"]])
    if not source_only and min(abs(duration - hint) for hint in hints) > tolerance:
        return "unexpected_duration"
    if (quality["sha256"] in reserved["wav_hashes"] or quality["pcmSha256"] in reserved["pcm_hashes"]
            or row["source"]["sha256"] in reserved["wem_hashes"]):
        return "reserved_reference_audio"
    return None


def prepare(candidates, reserved, out, game, tools, seed, rejections):
    voices = [EXTRACT.Archive(game, p) for p in EXTRACT.ARCHIVES[:2]]
    if any(r.get("audioSourceExpectation", {}).get("archive") == "archive/pc/content/audio_1_general.archive" for r in candidates):
        voices.append(EXTRACT.Archive(game, "archive/pc/content/audio_1_general.archive"))
    texts = [EXTRACT.Archive(game, p) for p in EXTRACT.ARCHIVES[2:]]
    oodle = EXTRACT.Oodle(game / "tools/redmod/bin/oo2ext_7_win64.dll")
    decoded = []
    for i, candidate in enumerate(candidates):
        key, string_id = candidate["key"], candidate["stringId"]
        if (key, string_id) in reserved["ids"]:
            rejections.add(key, string_id, "reserved_reference_id", phase="holdout")
            continue
        if candidate.get("englishTrainingEligible", True) and canonical_text(candidate["indexedTranscript"]) in reserved["texts"]:
            rejections.add(key, string_id, "reserved_reference_transcript", phase="holdout")
            continue
        try:
            row = decoded_candidate(candidate, out, voices, texts, oodle, tools)
            reason = quality_reason(row, reserved)
            if reason:
                rejections.add(key, string_id, reason, phase="waveform")
                continue
            decoded.append(row)
        except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
            rejections.add(key, string_id, "installed_extraction_failed", error, phase="extraction")
        if (i + 1) % 50 == 0:
            print(json.dumps({"phase": "decode", "visited": i + 1, "candidates": len(candidates), "accepted": len(decoded),
                              "rejections": rejections.counts()}), flush=True)
            write_json(out / "progress.json", {"visited": i + 1, "candidates": len(candidates), "accepted": len(decoded),
                                               "rejections": rejections.counts()})
    # Graph includes every original candidate, even recordings rejected by a
    # quality gate, so reused scenes cannot silently lose their connection.
    labels, groups = assign_splits([*candidates, *decoded], reserved, seed)
    by_identity = {(r["key"], r["stringId"]): (r["split"], r["sceneGroup"]) for r in labels}
    rows, audio_seen, text_seen = [], {}, {}
    priority = {"test": 0, "dev": 1, "train": 2, "eval_conflict": 3}
    for row in sorted(decoded, key=lambda r: (priority[by_identity[(r["key"], r["stringId"])][0]], r["key"], int(r["stringId"]))):
        split, group = by_identity[(row["key"], row["stringId"])]
        if split == "eval_conflict":
            rejections.add(row["key"], row["stringId"], "connected_old_dev_test_conflict", phase="split")
            continue
        text_key, pcm = canonical_text(row["transcript"]), row["wav"]["pcmSha256"]
        if text_key in text_seen or pcm in audio_seen:
            rejections.add(row["key"], row["stringId"], "duplicate_canonical_transcript_or_pcm", phase="deduplication")
            continue
        text_seen[text_key], audio_seen[pcm] = split, split
        rows.append({**row, "split": split, "sceneGroup": group})
    return rows, groups


def verify_rows(rows, reserved, out):
    sets = {split: {"scenes": set(), "texts": set(), "pcm": set(), "ids": set()} for split in SPLITS}
    for row in rows:
        split = row["split"]
        path = Path(row["wavPath"])
        if not EXTRACT.contained(path, out) or digest(path) != row["wav"]["sha256"]:
            raise ValueError("Final original WAV integrity failure")
        measured = waveform(path)
        if any(measured[field] != row["wav"][field] for field in
               ("channels", "sampleRate", "bitsPerSample", "frames", "durationSeconds", "pcmSha256", "sha256")):
            raise ValueError("Final measured original PCM differs from its provenance receipt")
        wem_path = Path(row["wemPath"])
        if not EXTRACT.contained(wem_path, out) or wem_path != path.with_name("source.wem") or digest(wem_path) != row["source"]["sha256"]:
            raise ValueError("Final original WEM integrity failure")
        if path.with_name("transcript.txt").read_text(encoding="utf-8").removesuffix("\n") != row["transcript"]:
            raise ValueError("Final exact original transcript changed")
        sets[split]["scenes"].update(row["scenePaths"])
        sets[split]["texts"].add(canonical_text(row["transcript"]))
        sets[split]["pcm"].add(measured["pcmSha256"])
        sets[split]["ids"].add((row["key"], row["stringId"]))
    for first, second in (("train", "dev"), ("train", "test"), ("dev", "test")):
        for category in ("scenes", "texts", "pcm", "ids"):
            if sets[first][category] & sets[second][category]:
                raise ValueError("Final split leakage in " + category)
    if sets["train"]["scenes"] & (reserved["old_scenes"]["dev"] | reserved["old_scenes"]["test"]):
        raise ValueError("Original evaluation scene entered expanded training")
    if sets["train"]["ids"] & reserved["ids"] or sets["train"]["pcm"] & reserved["pcm_hashes"]:
        raise ValueError("Original comparison/reference recording entered expanded training")
    if sets["train"]["pcm"] & reserved["old_eval_pcm"] or sets["train"]["texts"] & reserved["old_eval_texts"]:
        raise ValueError("Original evaluation audio/transcript entered expanded training")
    return {"sceneOverlap": 0, "canonicalTranscriptOverlap": 0, "canonicalPcmOverlap": 0,
            "oldEvaluationSceneTrainOverlap": 0, "reservedOriginalReferenceTrainOverlap": 0,
            "allOriginalWavHashesVerified": True}


def emit(rows, supported, roster, reserved, out, inputs, scenes, groups, rejections, seed):
    integrity = verify_rows(rows, reserved, out)
    records = []
    for row in rows:
        key, string_id = row["key"], row["stringId"]
        records.append({"id": key + "/" + string_id, "string_id": string_id,
            "audio_path": Path(row["wavPath"]).relative_to(out).as_posix(), "text": row["transcript"],
            "speaker_id": key, "speaker_name": supported[key]["name"], "language_id": "en", "locale": "en_us",
            "duration": row["wav"]["durationSeconds"], "sha256": row["wav"]["sha256"],
            "pcm_sha256": row["wav"]["pcmSha256"], "source_wem_sha256": row["source"]["sha256"],
            "scenes": row["scenePaths"], "scene_group": row["sceneGroup"], "split": row["split"],
            "partition": row["candidate"].get("partition", "ordinary"),
            "delivery_kinds": row["candidate"].get("deliveryKinds", ["ordinary-spoken"]),
            "spoken_language": row["candidate"].get("spokenLanguage", "eng"),
            "english_training_eligible": row["candidate"].get("englishTrainingEligible", True),
            "provenance_path": f"clips/{key}/{string_id}/receipt.json"})
        if not records[-1]["english_training_eligible"]:
            records[-1]["language_id"] = None
    for split in SPLITS:
        selected = [r for r in records if r["split"] == split and r["english_training_eligible"]]
        (out / (split + ".jsonl")).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in selected), encoding="utf-8")
        (out / (split + ".local.jsonl")).write_text("".join(json.dumps({**r, "audio_path": str(out / r["audio_path"])}, ensure_ascii=False)
                                                          + "\n" for r in selected), encoding="utf-8")
        for partition in ("ordinary", "canonical_delivery"):
            (out / (partition + "-" + split + ".jsonl")).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n"
                for r in selected if r["partition"] == partition), encoding="utf-8")
    source_only = [{**{k: v for k, v in r.items() if k != "text"}, "english_subtitle": r["text"],
                    "english_training_exclusion": "Original spoken language differs from the translated English subtitle; no transcription is guessed."}
                   for r in records if not r["english_training_eligible"]]
    (out / "source-only.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in source_only), encoding="utf-8")
    train_records = [r for r in records if r["english_training_eligible"]]
    speaker_report = []
    for key, character in roster.items():
        speaker_rows = [r for r in train_records if r["speaker_id"] == key]
        splits = {s: {"clips": sum(r["split"] == s for r in speaker_rows),
                      "seconds": round(sum(r["duration"] for r in speaker_rows if r["split"] == s), 3),
                      "sceneCount": len({p for r in speaker_rows if r["split"] == s for p in r["scenes"]})} for s in SPLITS}
        seconds = sum(r["duration"] for r in speaker_rows)
        source_only_count = sum(r["speaker_id"] == key for r in source_only)
        status = ("unsupported_original_voice" if key not in supported else "no_eligible_training_recordings" if not splits["train"]["clips"]
                  else "sparse_training_voice" if splits["train"]["clips"] < 20 or splits["train"]["seconds"] < 60 else "training_voice")
        if source_only_count and not speaker_rows:
            status = "source_only_non_english_voice"
        speaker_report.append({"speaker_id": key, "speaker_name": character["name"], "status": status,
                               "clips": len(speaker_rows), "seconds": round(seconds, 3), "hours": round(seconds / 3600, 6),
                               "splits": splits, "rejections": rejections.counts(key),
                               "sourceOnlyClips": source_only_count,
                               "independentEvaluationAvailable": bool(splits["dev"]["clips"] and splits["test"]["clips"])})
    summary = {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(), "seed": seed,
        "audioProcessing": "Original vgmstream PCM decode; no denoise/EQ/pitch/gain/resample/trim/concat",
        "speakerAttribution": "Authenticated installed native scene actor/speaker/item/event/localization joins; exact installed English subtitles and SHA-1 checked WEMs",
        "privateLocalOnly": True, "listeningVerified": False,
        "notes": "Metadata and waveform gates do not establish audible identity similarity or cloned-output acceptance. Sparse speakers have no invented extra data or scene-independent evaluation.",
        "portableAudioPathsRelativeTo": ".", "requestedRosterSpeakers": len(roster), "supportedOriginalSpeakers": len(supported),
        "speakersWithTrainRecordings": sum(s["splits"]["train"]["clips"] > 0 for s in speaker_report),
        "splits": {s: {"clips": sum(r["split"] == s for r in train_records),
                       "seconds": round(sum(r["duration"] for r in train_records if r["split"] == s), 3),
                       "hours": round(sum(r["duration"] for r in train_records if r["split"] == s) / 3600, 6)} for s in SPLITS},
        "clips": len(train_records), "hours": round(sum(r["duration"] for r in train_records) / 3600, 6),
        "partitions": {p: {"clips": sum(r["partition"] == p for r in records),
                           "hours": round(sum(r["duration"] for r in records if r["partition"] == p) / 3600, 6)}
                       for p in ("ordinary", "canonical_delivery", "source_only")},
        "sourceOnlyClips": len(source_only),
        "rejections": rejections.counts(), "integrity": integrity, "speakers": speaker_report}
    write_json(out / "dataset-report.json", summary)
    write_json(out / "rejections.json", rejections.rows)
    write_json(out / "manifest.json", {"schemaVersion": 1, "inputs": inputs, "sceneComponents": groups,
                                      "nativeSceneReceipts": list(scenes.receipts.values()), "candidates": rows})
    write_json(out / "holdouts.json", {"ids": sorted([list(x) for x in reserved["ids"]]),
        "canonicalTexts": sorted(reserved["texts"]), "wavSha256": sorted(reserved["wav_hashes"]),
        "pcmSha256": sorted(reserved["pcm_hashes"]), "wemSha256": sorted(reserved["wem_hashes"]),
        "oldEvaluationScenes": {s: sorted(v) for s, v in reserved["old_scenes"].items()}, "sources": reserved["sources"]})
    write_json(out / "data-provenance.json", {"schemaVersion": 1, "inputs": inputs, "tools": tools_summary(),
        "noNetworkCalls": True, "noGameWrites": True, "noInferenceOrGpuWork": True,
        "decoderOnly": True, "speakerMapping": [{"speaker_id": k, "speaker_name": v["name"], "records": v.get("records", [])} for k, v in supported.items()],
        "integrity": integrity, "reservedReferenceAndEvaluationSources": reserved["sources"]})
    (out / "README.md").write_text("# Private Pocket cast corpus\n\n"
        "Portable train/dev/test JSONL paths are relative to this directory. The matching .local.jsonl files contain absolute local paths. "
        "Each row carries the exact roster speaker key and a provenance receipt. Original game PCM is unchanged.\n\n"
        "All old evaluation scene components stay outside training. Original reference and experimental conditioning recordings are reserved by identity, canonical text, and PCM/WEM hashes. "
        "The report distinguishes sparse or missing voices and states whether independent evaluation exists. Technical gates have passed; listening review is unverified. "
        "This corpus and its audio are private local artifacts.\n", encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ("clips", "hours", "speakersWithTrainRecordings", "splits", "rejections", "integrity")}), flush=True)
    return records, summary


def tools_summary():
    inventory = read_json(ROOT / "runtime/voice-references/inventory.json")
    items = []
    for name, (_, expected) in CAST.PINNED_TOOLS.items():
        path = Path(next(t["path"] for t in inventory["tools"] if t["name"] == name))
        actual = digest(path)
        if actual != expected:
            raise ValueError("Installed decoder/probe differs from pinned tool")
        items.append({"name": name, "path": str(path), "sha256": actual})
    return items


def package(records, out):
    destination = out / "private-cast-corpus.zip"
    temporary = destination.with_suffix(".zip.tmp")
    files = {out / name for name in ("train.jsonl", "dev.jsonl", "test.jsonl", "manifest.json", "dataset-report.json",
                                    "data-provenance.json", "holdouts.json", "rejections.json", "README.md", "source-only.jsonl")}
    files.update(out / (partition + "-" + split + ".jsonl") for partition in ("ordinary", "canonical_delivery") for split in SPLITS)
    for row in records:
        files.add(out / row["audio_path"])
        files.add(out / row["provenance_path"])
        files.add((out / row["audio_path"]).with_name("transcript.txt"))
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
        for path in sorted(files):
            archive.write(path, path.relative_to(out).as_posix())
    temporary.replace(destination)
    receipt = {"path": str(destination), "bytes": destination.stat().st_size, "sha256": digest(destination),
               "files": len(files), "privateLocalOnly": True, "audio": "Original decoded WAV only; no transcoding"}
    write_json(out / "package-receipt.json", receipt)
    print(json.dumps({"package": receipt}), flush=True)


def append_qualified(args, out, game, tools, roster, supported, reserved, sources):
    """Add reviewed rows to a completed corpus, preserving every original WAV."""
    if not sources or args.supplemental_actors or args.source_only_supplement:
        raise ValueError("Append accepts only explicit qualified English supplemental files")
    previous = read_json(out / "manifest.json")
    selection = read_json(out / "selection.json")
    existing = previous["candidates"]
    existing_ids = {(r["key"], r["stringId"]) for r in existing}
    # Foreign originals remain source references even when long natural pauses
    # make them unsuitable training examples. Their waveform limits are stated;
    # they never receive English text supervision.
    for candidate in selection["candidates"]:
        token = (candidate["key"], candidate["stringId"])
        if candidate.get("englishTrainingEligible") is False and token not in existing_ids:
            path = out / "clips" / candidate["key"] / candidate["stringId"] / "receipt.json"
            if path.is_file():
                reference = read_json(path)
                reason = quality_reason(reference, reserved)
                existing.append({**reference, "sourceOnlyReviewFlags": [reason] if reason else []})
                existing_ids.add(token)
    provenance = read_json(out / "data-provenance.json")
    for entry in provenance["speakerMapping"]:
        key = entry["speaker_id"]
        if key not in roster:
            identity = {"key": key, "name": entry["speaker_name"], "records": entry["records"], "aliases": []}
            roster[key], supported[key] = identity, identity
    scenes = SceneStore(game, out)
    scenes.reuse_completed_verifications(selection, sources)
    for receipt in previous.get("nativeSceneReceipts", []):
        scenes.receipts[canonical_scene(receipt["scene"]["depotPath"])] = receipt
    rejections = Rejections()
    rejections.rows = read_json(out / "rejections.json")
    index = SubtitleIndex(ROOT / "research/cyberpunk/cache/game/localization/index/lookup.sqlite3")
    additions = []
    try:
        for source in sources:
            additions.extend(ingest_qualified_supplement(source, supported, roster, scenes, index, rejections))
    finally:
        index.close()
    old_keys = {(r["key"], r["stringId"]) for r in selection["candidates"]}
    reused = [r for r in additions if (r["key"], r["stringId"]) in old_keys]
    if reused:
        raise ValueError("Append includes existing localization IDs; provide only separately qualified new originals")
    new_rows, _ = prepare(additions, reserved, out, game, tools, args.seed, rejections)
    merged_candidates = [*selection["candidates"], *additions]
    merged = [*existing, *new_rows]
    labels, groups = assign_splits([*merged_candidates, *merged], reserved, args.seed)
    by_id = {(r["key"], r["stringId"]): (r["split"], r["sceneGroup"]) for r in labels}
    unique, text_seen, pcm_seen = [], set(), set()
    for row in sorted(merged, key=lambda r: (0 if by_id[(r["key"], r["stringId"])][0] in ("dev", "test") else 1,
                                            r["key"], int(r["stringId"]))):
        split, group = by_id[(row["key"], row["stringId"])]
        text, pcm = canonical_text(row["transcript"]), row["wav"]["pcmSha256"]
        if split == "eval_conflict":
            rejections.add(row["key"], row["stringId"], "connected_old_dev_test_conflict", phase="split")
            continue
        if text in text_seen or pcm in pcm_seen:
            rejections.add(row["key"], row["stringId"], "duplicate_canonical_transcript_or_pcm", phase="deduplication")
            continue
        text_seen.add(text); pcm_seen.add(pcm)
        unique.append({**row, "split": split, "sceneGroup": group})
    inputs = [*previous["inputs"], *[{"path": project_file(p).relative_to(ROOT).as_posix(),
                                     "sha256": digest(project_file(p)), "role": "separate_qualified_append"} for p in args.qualified_supplement]]
    write_json(out / "append-receipt.json", {"createdAt": datetime.now(timezone.utc).isoformat(),
        "originalInputsPreserved": previous["inputs"], "newInputs": inputs[len(previous["inputs"]):],
        "qualifiedAdditions": len(additions), "waveformQualifiedAdditions": len(new_rows), "originalAudioOverwritten": False})
    write_json(out / "selection.json", {**selection, "inputs": inputs, "candidates": merged_candidates,
                                         "nativeSceneReceipts": list(scenes.receipts.values())})
    records, _ = emit(unique, supported, roster, reserved, out, inputs, scenes, groups, rejections, args.seed)
    if args.package:
        package(records, out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--phase", choices=("plan", "all", "append", "verify"), default="all")
    parser.add_argument("--seed", default="cyberpunk-pocket-cast-private-v1")
    parser.add_argument("--reference-receipt", action="append", default=[])
    parser.add_argument("--supplemental-actors", type=Path)
    parser.add_argument("--qualified-supplement", type=Path, action="append", default=[])
    parser.add_argument("--source-only-supplement", type=Path, action="append", default=[])
    parser.add_argument("--package", action="store_true")
    args = parser.parse_args()
    out = output_directory(args.output)
    inventory_path, roster_path, registry_path = (ROOT / "runtime/voice-references/inventory.json", ROOT / "characters/roster.json",
                                                 ROOT / "runtime/local-voices.json")
    inventory, registry = read_json(inventory_path), read_json(registry_path)
    roster = {r["key"]: r for r in read_json(roster_path)}
    supported = {k: roster[k] for k, r in registry["voices"].items() if k not in UNSUPPORTED and r.get("reference")}
    supplemental = load_supplementals(args.supplemental_actors, supported, roster)
    qualified_sources = [read_json(project_file(p)) for p in args.qualified_supplement]
    source_only_sources = [read_json(project_file(p)) for p in args.source_only_supplement]
    game = Path(inventory["gameRoot"]).resolve()
    if not game.is_dir() or EXTRACT.contained(out, game):
        raise ValueError("Installed game path is unavailable or contains output")
    out.mkdir(parents=True, exist_ok=True)
    tools = {t["name"]: t for t in tools_summary()}
    inputs = [{"path": p.relative_to(ROOT).as_posix(), "sha256": digest(p)} for p in (inventory_path, roster_path, registry_path)]
    extra_paths = ([args.supplemental_actors] if args.supplemental_actors else []) + args.qualified_supplement + args.source_only_supplement
    inputs += [{"path": project_file(p).relative_to(ROOT).as_posix(), "sha256": digest(project_file(p))} for p in extra_paths]
    reserved = holdouts(registry, args.reference_receipt)
    if args.phase == "append":
        append_qualified(args, out, game, tools, roster, supported, reserved, qualified_sources)
        return
    if args.phase == "verify":
        rows = read_json(out / "manifest.json")["candidates"]
        print(json.dumps(verify_rows(rows, reserved, out)), flush=True)
        return
    scene_store = SceneStore(game, out)
    previous = read_json(out / "selection.json") if (out / "selection.json").is_file() else None
    scene_store.reuse_completed_verifications(previous, [*qualified_sources, *source_only_sources])
    rejections = Rejections()
    core, core_inputs = discover_core(supported, scene_store, rejections)
    index_path = ROOT / "research/cyberpunk/cache/game/localization/index/lookup.sqlite3"
    path_files = [ROOT / "runtime/voice-cast-inventory-20261001" / (s + "-wem-paths.txt") for s in ("base", "ep1")]
    wem_paths = defaultdict(list)
    for path in path_files:
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if line.strip():
                depot = CAST.depot(line.strip(), ".wem")
                match = re.search(r"(_f_[0-9a-f]{16}\.wem)$", depot)
                if match and depot not in wem_paths[match[1]]:
                    wem_paths[match[1]].append(depot)
    inputs += core_inputs + [{"path": p.relative_to(ROOT).as_posix(), "sha256": digest(p)} for p in [index_path, *path_files]]
    index = SubtitleIndex(index_path)
    try:
        native, native_inputs, binding_count = discover_native(supported, scene_store, index, wem_paths, rejections)
        native += discover_supplementals(supplemental, supported, scene_store, index, wem_paths, rejections)
        for source in qualified_sources:
            native += ingest_qualified_supplement(source, supported, roster, scene_store, index, rejections)
        for source in source_only_sources:
            native += ingest_source_only(source, supported, roster, scene_store, index, rejections)
    finally:
        index.close()
    inputs += native_inputs
    candidates = [*core, *native]
    if not 1 <= len(candidates) <= MAX_CANDIDATES:
        raise ValueError("Expanded candidate count is empty or exceeds its explicit bound")
    ownership = defaultdict(set)
    for row in candidates:
        ownership[row["wemPath"]].add(row["key"])
    ambiguous = {p for p, owners in ownership.items() if len(owners) > 1}
    candidates = [r for r in candidates if r["wemPath"] not in ambiguous]
    for path in ambiguous:
        for key in ownership[path]:
            rejections.add(key, path, "ambiguous_shared_wem_ownership")
    write_json(out / "selection.json", {"schemaVersion": 1, "seed": args.seed, "inputs": inputs,
              "nativeActorBindings": binding_count, "nativeSceneReceipts": list(scene_store.receipts.values()), "candidates": candidates})
    write_json(out / "metadata-rejections.json", rejections.rows)
    print(json.dumps({"phase": "plan", "candidates": len(candidates), "speakers": len({r["key"] for r in candidates}),
                      "nativeActorBindings": binding_count, "nativeScenes": len(scene_store.documents),
                      "rejections": rejections.counts()}), flush=True)
    if args.phase == "plan":
        return
    rows, groups = prepare(candidates, reserved, out, game, tools, args.seed, rejections)
    records, report = emit(rows, supported, roster, reserved, out, inputs, scene_store, groups, rejections, args.seed)
    if args.package:
        package(records, out)


if __name__ == "__main__":
    main()
