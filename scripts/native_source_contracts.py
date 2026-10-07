"""Isolated native source recovery readers; no decoder or production edits.

Every successful result is METADATA ONLY. Main-map resolution does not identify
an actor, native delivery does not establish clean speech, and original bytes
or captions are never repaired. Runtime integration must authenticate required
resources inside CAST's existing CPU gate before audio access/publication.
"""
from collections import defaultdict
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
PINNED_WK = "7ae9c308da2fe003220b55ce4ca9c122b51f0701a67db1618cca3ff4f7ff6738"
PINNED_EXTRACT = "565077b46ff96bfaf2a44dfd3addf792c1d2bf6b7eb9e14a68acf74a06f3144f"
PINNED_BUNDLE = "2be04d3eae0c1aae2ee8c35ac37147d174692ff0d0eb07ec26884b8661f4d881"
OFFLOAD_ROOT = Path(os.environ.get("CYBERPUNK_CONVAI_OFFLOAD_ROOT", r"E:\CyberpunkConvai-offload"))
UINT64 = (1 << 64) - 1
WEM = re.compile(r"(?:base|ep1)\\localization\\en-us\\(vo(?:_[a-z]+)?)\\[^\\]+_([fm])_([a-f0-9]{16})\.wem")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical_data(data):
    return digest(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode())


def json_no_duplicates(path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate source JSON key")
            result[key] = value
        return result
    return json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=pairs)


def ident(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not re.fullmatch(r"[0-9]{1,20}", str(value)) or not 0 <= int(value) <= UINT64:
        raise ValueError("Exact uint64 identity required")
    return str(int(value))


def pointer(doc, value):
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError("Typed JSON pointer required")
    for part in value.strip("/").split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        doc = doc[int(part)] if isinstance(doc, list) else doc[part]
    return doc


def bounded_file(project, value, limit=128 * 1024 * 1024):
    if not isinstance(value, str):
        raise ValueError("Explicit project source path required")
    # Offloaded evidence folders are directory junctions inside the project that
    # resolve into one named offload root; the path must stay lexically inside
    # the project and its real location inside the project or that root.
    lexical = Path(os.path.abspath(project / value))
    real = lexical.resolve()
    allowed = real.is_relative_to(project) or (OFFLOAD_ROOT.is_dir() and real.is_relative_to(OFFLOAD_ROOT.resolve()))
    if not lexical.is_relative_to(project) or not allowed or not 0 < real.stat().st_size <= limit:
        raise ValueError("Source escaped project or byte bound")
    return lexical


def extract_module():
    p = HERE / "Extract-VoiceReferences.py"
    if digest(p.read_bytes()) != PINNED_EXTRACT:
        raise ValueError("Pinned metadata parser changed")
    spec = importlib.util.spec_from_file_location("recovery_metadata_extract", p)
    module = importlib.util.module_from_spec(spec)
    old = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = old
    return module


def metadata_flags():
    return {"metadataOnly": True, "freshSerializationAuthenticated": False,
        "audioDecoded": False, "rawAttributionVerified": False,
        "waveformProcessingAssessed": False, "independentWordingQualified": False,
        "cacheQualified": False, "trainingAdmitted": False}


class NativeSourceContracts:
    def __init__(self, project, bundle_path, archive_indexes):
        self.project = Path(project).resolve()
        self.extract = extract_module()
        self.indexes = archive_indexes
        bundle_path = bounded_file(self.project, str(bundle_path), 2 * 1024 * 1024)
        if digest(bundle_path.read_bytes()) != PINNED_BUNDLE:
            raise ValueError("Actual sixteen-source experiment receipt changed")
        self.bundle = json_no_duplicates(bundle_path)
        assets = self.bundle["nativeSources"] + self.bundle["wemAssets"]
        if len(assets) != 16 or len({a["source"]["depotPath"] for a in assets}) != 16:
            raise ValueError("Exact actual sixteen-source receipt membership required")
        self.assets = {a["source"]["depotPath"]: a for a in assets}
        self.native_docs, self.registrations, self.quarantined_entries = {}, defaultdict(list), []
        self.directory_hints = defaultdict(list)
        self.directory_input_hashes = {}
        pins = {"base": "8546c2ee310d9026e026ec64b8620b7677c107847e4a665d3b6b82c83e3cb641",
            "ep1": "ad5371de0bb12a17ab286f9e093aa6c2cd95411dafe2d6f33ae0d84e1c9b58ed"}
        for layer, expected in pins.items():
            path = bounded_file(self.project, f"runtime/voice-cast-inventory-20261001/{layer}-wem-paths.txt")
            if digest(path.read_bytes()) != expected:
                raise ValueError("Reviewed bank path metadata changed")
            self.directory_input_hashes[str(path.relative_to(self.project))] = expected
            for depot in path.read_text(encoding="utf-8").splitlines():
                matched = WEM.fullmatch(depot)
                if matched:
                    self.directory_hints[(str(int(matched[3], 16)), matched[2], matched[1])].append(depot)
        for asset in assets:
            doc = self.verify_bundle_asset(asset)
            if doc is not None:
                self.native_docs[asset["source"]["depotPath"]] = doc
        registry_path = "base\\localization\\volanguagedatamap.json"
        self.registry_asset = self.assets[registry_path]
        registry = self.native_docs[registry_path]["Data"]["RootChunk"]["root"]["Data"]
        if registry.get("$type") != "locVoLanguageDataMap":
            raise ValueError("Actual language registry is not typed")
        english = [e for e in registry["entries"] if e.get("languageCode", {}).get("$type") == "CName" and e["languageCode"].get("$storage") == "string" and e["languageCode"].get("$value") == "en-us"]
        if len(english) != 1:
            raise ValueError("Language registry needs one exact English declaration")
        self.registry_entry = english[0]
        self.base_chunks = {r["DepotPath"]["$value"] for r in english[0]["voMapChunks"]
            if r.get("DepotPath", {}).get("$type") == "ResourcePath" and r["DepotPath"].get("$storage") == "string"}
        for path, doc in self.native_docs.items():
            if path == registry_path:
                continue
            asset = self.assets[path]
            root = doc["Data"]["RootChunk"]["root"]["Data"]
            if root.get("$type") != "locVoiceoverMap":
                raise ValueError("Actual native declaration is not a locVoiceoverMap")
            bank = ("vo_holocall" if "_holocall" in path else "vo_helmet" if "_helmet" in path else "vo_rewinded" if "_rewinded" in path else "vo")
            if path.startswith("base\\") and path not in self.base_chunks:
                raise ValueError("Base map is not declared by the authenticated English registry")
            if path.startswith("ep1\\") and asset["source"]["archive"] != "archive/pc/ep1/lang_en_voice.archive":
                raise ValueError("EP1 English map is not the current installed EP1 declaration")
            for i, entry in enumerate(root["entries"]):
                if entry.get("$type") != "locVoLineEntry":
                    raise ValueError("Map entry has no exact native type")
                sid = ident(entry["stringId"])
                for branch in ("femaleResPath", "maleResPath"):
                    ref = entry[branch]["DepotPath"]
                    if ref.get("$type") != "ResourcePath" or ref.get("$storage") != "string":
                        raise ValueError("Unresolved native resource path needs a separate hash-bound resolver")
                    resource = ref["$value"]
                    match = WEM.fullmatch(resource)
                    if sid == "0" or not match or match[1] != bank or int(match[3], 16) != int(sid):
                        self.quarantined_entries.append({"map": path, "entryPointer": f"/Data/RootChunk/root/Data/entries/{i}",
                            "branch": branch, "originalEntry": entry, "reason": "zero-id-or-nonmatching-bank-variant-suffix"})
                        continue
                    self.registrations[(sid, match[2], bank)].append({"mapPath": path,
                        "mapRawSha256": asset["rawSha256"], "mapJsonSha256": asset["jsonSha256"],
                        "mapDataSha256": asset["dataSha256"], "entryPointer": f"/Data/RootChunk/root/Data/entries/{i}",
                        "branch": branch, "physicalAudioVariant": match[2], "resourcePath": resource,
                        "originalEntry": entry, "baseRegistryDeclared": path in self.base_chunks,
                        "runtimeDlcLoadingObserved": False})

    def current_index(self, depot, expected_archive=None, expected_sha1=None):
        hashed = self.extract.depot_hash(depot)
        options = [(relative, arc.entries[hashed]) for relative, arc in self.indexes.items() if hashed in arc.entries]
        if not options:
            raise ValueError("Current indexed native resource is missing")
        # The caller supplies the existing archive precedence order, as CAST does.
        archive, (first, end, sha1) = options[-1]
        if expected_archive is not None and archive != expected_archive or expected_sha1 is not None and sha1 != expected_sha1:
            raise ValueError("Declared resource is not the current indexed winner")
        return {"depotPath": depot, "archive": archive, "archiveEntrySha1": sha1,
            "currentIndexedWinnerVerified": True, "currentPayloadRead": False,
            "earlierArchiveAlternatives": [a for a, _ in options[:-1]]}

    def verify_bundle_asset(self, asset):
        source = asset["source"]
        raw = bounded_file(self.project, asset["rawPath"], 32 * 1024 * 1024)
        data = raw.read_bytes()
        if digest(data) != asset["rawSha256"] or hashlib.sha1(data).hexdigest() != source["archiveEntrySha1"] or len(data) != source["decodedBytes"]:
            raise ValueError("Original cached source bytes differ from sixteen-source receipt")
        self.current_index(source["depotPath"], source["archive"], source["archiveEntrySha1"])
        if asset["kind"] != "native-json":
            return None
        p = bounded_file(self.project, asset["jsonPath"])
        if digest(p.read_bytes()) != asset["jsonSha256"]:
            raise ValueError("Native serialized source bytes changed")
        doc = json_no_duplicates(p)
        if Path(doc["Header"]["ArchiveFileName"]).resolve() != raw.resolve() or canonical_data(doc["Data"]) != asset["dataSha256"]:
            raise ValueError("Native JSON source path/Data does not match original bytes")
        ser = asset["serialization"]
        if ser.get("tool") != "WolvenKit.CLI 9.0.1" or ser.get("toolSha256") != PINNED_WK or ser.get("sourcePathMatches") is not True or ser.get("exitCode") != 0:
            raise ValueError("Recorded native serialization receipt is not pinned and successful")
        return doc

    def resolve_main(self, sid, physical_variant, *, requested_path=None):
        sid = ident(sid)
        if sid == "0" or physical_variant not in ("f", "m"):
            raise ValueError("Nonzero ID and explicit physical recording variant required")
        rows = self.registrations.get((sid, physical_variant, "vo"), [])
        paths = sorted({r["resourcePath"] for r in rows})
        if len(paths) != 1:
            raise ValueError("Missing or conflicting exact registered main representation")
        path = paths[0]
        if requested_path is not None and requested_path != path:
            raise ValueError("Requested matching-suffix asset is not the registered main representation")
        indexed = self.current_index(path)
        alternatives = {bank: list(self.registrations.get((sid, physical_variant, bank), [])) for bank in ("vo_holocall", "vo_helmet", "vo_rewinded")}
        physical_alternatives = []
        for bank in ("vo", "vo_holocall", "vo_helmet", "vo_rewinded"):
            for alternative in self.directory_hints.get((sid, physical_variant, bank), []):
                try:
                    info = self.current_index(alternative)
                except ValueError:
                    info = {"depotPath": alternative, "currentIndexedWinnerVerified": False,
                        "status": "cached-directory-hint-no-current-entry"}
                physical_alternatives.append({"depotPath": alternative, "bank": bank,
                    "selectedRegisteredMain": alternative == path, "ownershipClaim": False, "currentIndex": info})
        return {**metadata_flags(), "contract": "registered-main-representation-v1", "stringId": sid,
            "physicalAudioVariant": physical_variant, "captionVariant": {"f": "femaleVariant", "m": "maleVariant"}[physical_variant],
            "resourcePath": path, "routingBranches": sorted({r["branch"] for r in rows}),
            "nativeMainDeclarations": list(rows), "otherBankDeclarations": alternatives,
            "allPhysicalDirectoryAlternatives": physical_alternatives,
            "directoryHintInputHashes": self.directory_input_hashes,
            "voiceIndexedWinner": indexed, "registryRawSha256": self.registry_asset["rawSha256"],
            "registryJsonSha256": self.registry_asset["jsonSha256"], "actorIdentityInferredFromMap": False,
            "speakerGenderInferred": False}

    def scene(self, source):
        raw = bounded_file(self.project, source["rawPath"], 32 * 1024 * 1024)
        js = bounded_file(self.project, source["jsonPath"])
        if digest(raw.read_bytes()) != source["rawSha256"] or hashlib.sha1(raw.read_bytes()).hexdigest() != source["entrySha1"] or digest(js.read_bytes()) != source["jsonSha256"]:
            raise ValueError("Native scene raw/entry/JSON hash mismatch")
        self.current_index(source["depotPath"], source["archive"], source["entrySha1"])
        doc = json_no_duplicates(js)
        if Path(doc["Header"]["ArchiveFileName"]).resolve() != raw.resolve() or doc["Data"]["RootChunk"].get("$type") != "scnSceneResource":
            raise ValueError("Actor source is not its exact serialized native scene")
        manifest = json_no_duplicates(bounded_file(self.project, source["manifestPath"]))
        rows = [r for r in manifest["assets"] if r.get("winner") is True and r.get("depotPath") == source["depotPath"]]
        if len(rows) != 1:
            raise ValueError("Scene must have one winning native export declaration")
        row = rows[0]
        parent = (self.project / source["manifestPath"]).parent
        ser = row.get("serializationVerification", {})
        if (row.get("archivePath") != source["archive"] or row.get("archiveEntrySha1") != source["entrySha1"]
                or row.get("assetSha256") != source["rawSha256"] or row.get("jsonSha256") != source["jsonSha256"]
                or (parent / row["rawPath"]).resolve() != raw.resolve() or (parent / row["jsonPath"]).resolve() != js.resolve()
                or row.get("serializationVerified") is not True or ser.get("verified") is not True
                or ser.get("toolSha256") != PINNED_WK or ser.get("rawSha256") != source["rawSha256"]
                or ser.get("cachedJsonSha256") != source["jsonSha256"] or ser.get("dataSha256") != canonical_data(doc["Data"])):
            raise ValueError("Scene declaration/recorded parser does not bind exact raw/JSON/Data")
        return doc

    @staticmethod
    def emitted(doc, actor_pointer, line_pointer, event_pointer):
        if not re.fullmatch(r"/Data/RootChunk/actors/[0-9]+", actor_pointer) or not re.fullmatch(r"/Data/RootChunk/screenplayStore/lines/[0-9]+", line_pointer) or not event_pointer.startswith("/Data/RootChunk/sceneGraph/"):
            raise ValueError("Emitted source pointers escaped their typed stores")
        actor, line, event = [pointer(doc, p) for p in (actor_pointer, line_pointer, event_pointer)]
        if (actor.get("$type") != "scnActorDef" or line.get("$type") != "scnscreenplayDialogLine" or event.get("$type") != "scnDialogLineEvent"
                or ident(actor["actorId"]["id"]) != ident(line["speaker"]["id"])
                or ident(line["itemId"]["id"]) != ident(event["screenplayLineId"]["id"])):
            raise ValueError("Typed actor/speaker/item/emitted-event joins differ")
        sid = ident(line["locstringId"]["ruid"])
        if sid == "0":
            raise ValueError("Unemitted/zero localization identity cannot become speech")
        return actor, line, event, sid

    @staticmethod
    def require_actor_identity(actor, proof, roster, doc, project, source, actor_pointer, validator):
        if not callable(validator) or not isinstance(proof, dict) or proof.get("canonicalKey") != roster["key"]:
            raise ValueError("Independent canonical actor proof/validator is mandatory")
        scope = {"actorPointer": actor_pointer, "nativeVoice": ident(actor["voicetagId"]["id"]),
            "sceneRawSha256": source["rawSha256"], "sceneJsonSha256": source["jsonSha256"]}
        if proof.get("sourceScope") != scope:
            raise ValueError("Actor proof does not bind this exact voice/actor/source scope")
        result = validator(actor, proof, roster, doc, project, source, actor_pointer)
        return {"canonicalKey": roster["key"], "proof": proof, "metadataVerification": result,
            "canonicalIdentityCheckedIndependentlyOfMap": True, "freshSerializationAuthenticated": False}

    def english(self, doc, source, sid, physical_variant, external_sources):
        if doc != self.scene(source):
            raise ValueError("English reader received a changed/unbound native document")
        sid = ident(sid)
        field = {"f": "femaleVariant", "m": "maleVariant"}.get(physical_variant)
        if not field:
            raise ValueError("Explicit physical caption variant required")
        store = doc["Data"]["RootChunk"].get("locStore", {})
        embedded = []
        for i, descriptor in enumerate(store.get("vdEntries", [])):
            if descriptor.get("localeId") != "en_us" or ident(descriptor["locstringId"]["ruid"]) != sid:
                continue
            index = descriptor.get("vpeIndex")
            if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(store["vpEntries"]):
                raise ValueError("Malformed English descriptor index")
            payload = store["vpEntries"][index]
            if descriptor["variantId"] != payload["variantId"] or not isinstance(payload.get("content"), str):
                raise ValueError("Native English variant/payload does not agree")
            embedded.append({"descriptorPointer": f"/Data/RootChunk/locStore/vdEntries/{i}",
                "payloadPointer": f"/Data/RootChunk/locStore/vpEntries/{index}", "descriptor": descriptor, "payload": payload})
        originals = []
        for evidence in external_sources:
            row = evidence["indexRow"] if "indexRow" in evidence else evidence
            if row.get("type") != "localizationPersistenceSubtitleEntry" or ident(row["id"]) != sid:
                raise ValueError("External caption is not the exact typed ID")
            s = row["source"]
            if not re.fullmatch(r"(?:base|ep1)\\localization\\en-us\\subtitles\\.+\.json", s["depotPath"]):
                raise ValueError("External caption is not the original English locale")
            raw = bounded_file(self.project, "research/cyberpunk/cache/game/localization/" + s["rawPath"], 32 * 1024 * 1024)
            js = bounded_file(self.project, "research/cyberpunk/cache/game/localization/" + s["jsonPath"])
            b = raw.read_bytes()
            if digest(b) != s["assetSha256"] or hashlib.sha1(b).hexdigest() != s["archiveEntrySha1"]:
                raise ValueError("External original subtitle byte hash mismatch")
            self.current_index(s["depotPath"], s["archivePath"], s["archiveEntrySha1"])
            decoded, variants = self.extract.local_subtitle(b, sid, field)
            entry = pointer(json_no_duplicates(js), row["jsonPointer"])
            if entry.get("$type") != "localizationPersistenceSubtitleEntry" or ident(entry["stringId"]) != sid or entry.get(field) != decoded or row.get(field) != decoded:
                raise ValueError("Raw/typed JSON/index exact caption variant disagrees")
            if "jsonSha256" in evidence and digest(js.read_bytes()) != evidence["jsonSha256"]:
                raise ValueError("Recorded external caption JSON hash changed")
            originals.append({"indexRow": row, "originalText": decoded, "originalTextSha256": digest(decoded.encode()),
                "rawSha256": digest(b), "jsonSha256": digest(js.read_bytes()), "rawVariants": variants})
        texts = {r["originalText"] for r in originals}
        if len(texts) != 1 or not originals:
            raise ValueError("Missing or conflicting exact original English variant")
        text = next(iter(texts))
        matches = [r for r in embedded if r["payload"]["content"] == text]
        if embedded and not matches:
            raise ValueError("Present embedded English needs separate disagreement/variant review")
        return {**metadata_flags(), "mode": "embedded-scene-and-original-external-agreement" if embedded else "external-native-english-zero-embedding",
            "sourceScene": source, "stringId": sid, "physicalAudioVariant": physical_variant, "captionVariant": field,
            "originalText": text, "originalTextSha256": digest(text.encode()), "embeddedEnglish": matches,
            "embeddedEnglishDescriptorCount": len(embedded), "externalOriginals": originals,
            "captionChanged": False, "spokenEnglishInferredFromSubtitle": False}

    @staticmethod
    def delivery(event):
        if event.get("$type") != "scnDialogLineEvent":
            raise ValueError("Delivery is not a typed emitted line")
        p = event.get("voParams", {})
        holo = p.get("isHolocallSpeaker")
        if type(holo) not in (bool, int) or holo not in (0, 1):
            raise ValueError("Invalid native Holocall flag")
        custom = p.get("customVoEvent")
        if not isinstance(custom, dict) or custom.get("$type") != "CName" or custom.get("$storage") != "string":
            raise ValueError("Exact native custom event required")
        value, expression = custom.get("$value"), p.get("voExpression")
        if value == "vo_3d_important" and expression == "Vo_Expression_Spoken":
            kind = "canonical-custom-performance"
        elif value not in ("None", ""):
            raise ValueError("Unreviewed custom voice event remains quarantined")
        elif expression == "Vo_Expression_InnerDialog":
            kind = "canonical-inner-dialog-performance"
        elif expression == "Vo_Expression_Phone" or expression == "Vo_Expression_Spoken" and bool(holo):
            kind = "canonical-phone-performance"
        elif expression == "Vo_Expression_Spoken":
            kind = "ordinary-spoken"
        elif expression == "Vo_Expression_GlobalTV":
            kind = "canonical-media-performance"
        else:
            raise ValueError("Unreviewed expression remains quarantined")
        return {**metadata_flags(), "kind": kind, "voExpression": expression, "customVoEvent": value,
            "isHolocallSpeaker": bool(holo), "originalVoParams": dict(p), "eventFlagsPreserved": True,
            "nativeExpressionRelabeled": False, "nativeCustomEventRelabeled": False}

    def mirror(self, doc, source, actor_pointer, line_pointer, event_pointer, review, primary_identity):
        if doc != self.scene(source):
            raise ValueError("Mirror reader received a changed/unbound native document")
        actor, line, event, sid = NativeSourceContracts.emitted(doc, actor_pointer, line_pointer, event_pointer)
        if not primary_identity.get("canonicalIdentityCheckedIndependentlyOfMap"):
            raise ValueError("A native voice tag/map alone cannot establish primary canonical identity")
        expected_scope = {"actorPointer": actor_pointer, "nativeVoice": ident(actor["voicetagId"]["id"]),
            "sceneRawSha256": source["rawSha256"], "sceneJsonSha256": source["jsonSha256"]}
        if primary_identity.get("proof", {}).get("sourceScope") != expected_scope:
            raise ValueError("Primary canonical proof is stale for this mirror source")
        if (review.get("sceneRawSha256") != source["rawSha256"] or review.get("sceneJsonSha256") != source["jsonSha256"]
                or review.get("primaryActorPointer") != actor_pointer or review.get("linePointer") != line_pointer
                or review.get("eventPointer") != event_pointer or review.get("canonicalKey") != primary_identity["canonicalKey"]
                or not str(review.get("reviewer", "")).strip() or not str(review.get("reason", "")).strip()):
            raise ValueError("Mirror exception requires this explicit reviewed source scope")
        container = event["additionalSpeakers"]
        if container.get("$type") != "scnAdditionalSpeakers" or container.get("role") != "Full" or container.get("executionTag") != 1 or len(container.get("speakers", [])) != 1:
            raise ValueError("Outside reviewed one-recipient Full/Holocall mirror family")
        tags = doc["Data"]["RootChunk"].get("executionTagEntries", [])
        if not any(t.get("$type") == "scnExecutionTagEntry" and t.get("flags") == 1 and t.get("name", {}).get("$value") == "holo" for t in tags):
            raise ValueError("Mirror tag is not the native declared holo branch")
        extra = container["speakers"][0]
        mp = review.get("mirrorActorPointer")
        if not isinstance(mp, str) or not re.fullmatch(r"/Data/RootChunk/actors/[0-9]+", mp):
            raise ValueError("Reviewed canonical mirror actor pointer required")
        mirror = pointer(doc, mp)
        if (extra.get("$type") != "scnAdditionalSpeaker" or extra.get("type") != "Holocall"
                or mirror.get("$type") != "scnActorDef" or ident(extra["actorId"]["id"]) != ident(mirror["actorId"]["id"])
                or ident(mirror["voicetagId"]["id"]) != ident(actor["voicetagId"]["id"])
                or ident(actor["voicetagId"]["id"]) == "0"
                or actor.get("actorName") != review.get("primaryActorName") or mirror.get("actorName") != review.get("mirrorActorName")
                or review.get("mirrorCanonicalKey") != primary_identity["canonicalKey"]
                or actor.get("acquisitionPlan") != review.get("primaryAcquisitionPlan")
                or mirror.get("acquisitionPlan") != review.get("mirrorAcquisitionPlan")
                or actor.get("spawnSetParams") != review.get("primaryActiveAcquisition")
                or mirror.get("spawnSetParams") != review.get("mirrorActiveAcquisition")):
            raise ValueError("Mirror canonical name/voice/actor/acquisition scope differs")
        return {**metadata_flags(), "contract": "reviewed-canonical-full-holocall-mirror-v1", "stringId": sid,
            "primaryIdentity": primary_identity, "review": review, "originalAdditionalSpeakers": container,
            "primaryActorDefinition": actor, "mirrorActorDefinition": mirror, "originalEvent": event,
            "singleOriginalMainRecordingSelectedSeparately": True, "liveRoutingObserved": False,
            "canonicalWorldRecordEdgeClaimed": False}


def authenticate_recovery_dependencies(plan, verify_current_winner, authenticate_native_json):
    """Integration seam: caller MUST hold existing CAST CpuSlots before audio.

    This function invokes only supplied hooks. Metadata tests use spies and do
    not claim a native parser execution. Subtitle bytes are re-read by CAST's
    existing exact native subtitle parser before decode; do not fake that proof.
    """
    if not callable(verify_current_winner) or not callable(authenticate_native_json):
        raise ValueError("Independent current-winner and fresh-parser hooks required")
    roles = plan.get("nativeDependencies")
    if not isinstance(roles, list) or not roles:
        raise ValueError("Bound native dependencies required before raw admission")
    results = []
    for dependency in roles:
        winner = verify_current_winner(dependency)
        if not winner or winner.get("currentInstalledWinnerAuthenticated") is not True:
            raise ValueError("Recovery native dependency lacks current winner authentication")
        fresh = authenticate_native_json(dependency)
        if not fresh or fresh.get("freshSerializationAuthenticated") is not True or fresh.get("rawSha256") != dependency["rawSha256"] or fresh.get("jsonSha256") != dependency["jsonSha256"] or fresh.get("dataSha256") != dependency["dataSha256"] or fresh.get("toolSha256") != PINNED_WK:
            raise ValueError("Recovery native dependency lacks exact fresh serialization")
        results.append({"dependency": dependency, "winner": winner, "fresh": fresh})
    return {"nativeDependenciesAuthenticated": results, "freshSerializationAuthenticated": True,
        "audioDecoded": False, "rawAttributionVerified": False, "trainingAdmitted": False,
        "actualWemAndSubtitlePayloadQualificationStillRequired": True}
