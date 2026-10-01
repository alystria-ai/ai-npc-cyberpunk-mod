"""Decode bounded, natively attributed wider-cast candidates; never promote them.

Input schema (all paths relative to project unless absolute and contained):
  schemaVersion: 1, lane: casting-lanes.json lane name, rosterSha256: roster hash,
  rosterInventory: inventory JSON, laneInventory: casting-lanes.json,
  gameRoot: installed game, subtitleIndex: installed localization lookup.sqlite3,
  tools: [{name: 'vgmstream-cli'|'ffprobe', path, sha256, version}],
  candidates: [{key, stringId, wemPath, genderVariant: 'female'|'male',
    scene: {manifestPath, depotPath, archive, entrySha1, rawPath, rawSha256,
            jsonPath, jsonSha256},
    actor: {pointer, id, name, voicetagId, identityProof: {
       kind: 'exact_actor'|'reviewed_actor_alias'|'direct_actor_record'|'quest_acquisition', canonicalKey,
       actorName, reviewer, reason,
       # direct_actor_record: recordPointer (same actor/active acquisition field),
       # canonicalRecord (optional exact current-roster record expectation),
       # quest_acquisition currently only within the same authenticated scene:
       # resourcePath, resourceSha256, acquisitionPointer, actorPointer,
       # recordPointer, recordValue matching a canonical roster record}},
    line: {pointer, itemId, speakerId, locstringId},
    event: {pointer},
    # Required for a Phone/GlobalTV/custom-event canonical performance:
    sourceDelivery: {kind, isHolocallSpeaker, voExpression, customVoEvent,
                     waveformProcessingAssessed: false, reason},
    english: {descriptorPointer, payloadPointer,
              variant: 'femaleVariant'|'maleVariant', transcript, transcriptSha256}}]

The actual same-scene actor/speaker/item/event and en_us variant joins are
rechecked. A reviewed alias is an explicit human/native-research attribution
decision, not an automatic assertion from the WEM filename. Generic actors need
a typed same-scene acquisition object with a canonical record pointer. External
quest/community linkage remains unprepared pending separate native receipt
support. All indexed
subtitle resources are queried read-only and reread from winning game archives.
Typed TweakDBID string/numeric canonical record matches use the pinned primary
algorithm sources below. The community_entry_receipt API records exact native
entry->record evidence but never treats a missing world-instance edge as passed.

Output: runtime/voice-cast/<lane>/manifest.json, plus atomic <key>/<id>-<gender>/
directories containing source.wem, reference.wav, transcript.txt and receipt.json.
Original WEM/decoded PCM are preserved, resumable and never overwritten. Each candidate keeps
identity/discovery/nativeActor/nativeLine/subtitle/audio/quality provenance,
separate attribution/transcript/listening flags and status 'decoded_verified'.
No listening approval, profile promotion, model inference or cloud calls occur.
Native event delivery is recorded independently of audible waveform processing.
An explicitly source-qualified Phone/GlobalTV/custom-event performance preserves
its actual event metadata and never becomes an ordinary clean reference.
--dry-run validates local receipts and queries the index, but creates no paths,
locks or subprocesses and does not read/decompress archives. Its status is only
'attributed_receipt_validated', never 'decoded_verified'.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import zlib


_spec = importlib.util.spec_from_file_location("voice_extract", Path(__file__).with_name("Extract-VoiceReferences.py"))
extract = importlib.util.module_from_spec(_spec)
_previous_bytecode = sys.dont_write_bytecode
try:
    sys.dont_write_bytecode = True
    _spec.loader.exec_module(extract)
finally:
    sys.dont_write_bytecode = _previous_bytecode
VOICE_ARCHIVES = extract.ARCHIVES[:2]
TEXT_ARCHIVES = extract.ARCHIVES[2:]
SCENE_ARCHIVES = ("archive/pc/content/basegame_4_gamedata.archive", "archive/pc/ep1/ep1_2_gamedata.archive")
MAX_PER_CHARACTER = 6
MAX_BATCH = 48
MAX_JSON_BYTES = 64 * 1024 * 1024
KEY = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
PINNED_TOOLS = {
    "vgmstream-cli": (r"C:\Users\akshi\Downloads\misc\modding\fmodel\Output\.data\vgmstream-cli.exe", "71027230c2f12a8bd63067d304c399290c287e45c258e20b4ddc85dce8349374"),
    "ffprobe": (r"C:\ffmpeg\bin\ffprobe.exe", "0bf5018ea49d2ebf0235e893f1c725acbcc2e257837f691ee9ba12ef876a1365"),
}
WOLVENKIT_SHA256 = "7ae9c308da2fe003220b55ce4ca9c122b51f0701a67db1618cca3ff4f7ff6738"
LANE_INVENTORY = "runtime/voice-cast-inventory-20261001/casting-lanes.json"
TWEAKDBID_SOURCES = (
    "https://github.com/WolvenKit/WolvenKit/blob/b900c6bb645d0a60c0e5ad791fc87166465f8aca/WolvenKit.RED4/Types/Primitives/Simples/TweakDBID.cs#L32",
    "https://github.com/WolvenKit/WolvenKit/blob/b900c6bb645d0a60c0e5ad791fc87166465f8aca/WolvenKit.Core/CRC/Crc32Algorithm.cs#L90",
    "https://github.com/WopsS/RED4ext.SDK/blob/ad7277714ad30d6885d7050c5ba24fa0102f6920/include/RED4ext/NativeTypes.hpp#L59",
    "https://github.com/WopsS/RED4ext.SDK/blob/ad7277714ad30d6885d7050c5ba24fa0102f6920/include/RED4ext/NativeTypes-inl.hpp#L31",
)


def tweakdbid(record: str) -> int:
    """Source-verified canonical ASCII TDBID, preserving exact record case.

    WolvenKit TweakDBID.cs uses CRC32 plus string.Length <<32; its CRC overload
    uses ASCII. RED4ext stores uint32 CRC at byte0, uint8 length at byte4, runtime
    offset in bytes5..7. SDK equality compares CRC+length, while uint64 conversion
    includes offset. ASCII <=255 is the shared unambiguous supported domain.
    Native raw corroboration: Character.Saul=63242755000,
    Character.Silverhand=85903861324, Character.Evelyn=70856865783 (little-endian
    bytes checked in original cached scenes against typed WK string values).
    """
    if not isinstance(record, str) or not record.isascii() or not 1 <= len(record) <= 255:
        raise ValueError("Canonical TweakDBID record must be 1..255 ASCII characters")
    return (zlib.crc32(record.encode("ascii")) & 0xFFFFFFFF) | (len(record) << 32)


def canonical_record(value, records, expected=None):
    """Match a typed native TweakDBID to one exact current-roster record."""
    if not isinstance(value, dict) or value.get("$type") != "TweakDBID":
        raise ValueError("Canonical record proof requires a typed native TweakDBID")
    if not isinstance(records, list) or not records or any(not isinstance(x, str) for x in records):
        raise ValueError("Canonical roster record list is missing")
    if expected is not None and expected not in records:
        raise ValueError("Expected record is not in the current canonical roster")
    storage, raw = value.get("$storage"), value.get("$value")
    if storage == "string":
        matches = [record for record in records if raw == record]
        observed = None
    elif storage == "uint64":
        observed = int(ident(raw))
        if not observed:
            raise ValueError("Zero native record is not character identity proof")
        identity = observed & 0xFFFFFFFFFF
        matches = [record for record in records if tweakdbid(record) == identity]
    else:
        raise ValueError("Unsupported native TweakDBID storage")
    if len(matches) != 1 or expected is not None and matches[0] != expected:
        raise ValueError("Native TweakDBID does not uniquely match the canonical roster record")
    record = matches[0]
    return {"record": record, "identity": str(tweakdbid(record)), "storage": storage,
            "observedUint64": str(observed) if observed is not None else None,
            "runtimeOffsetBits": str(observed >> 40) if observed is not None else "0",
            "algorithmSources": list(TWEAKDBID_SOURCES)}


def digest(path: Path, algorithm="sha256") -> str:
    h = hashlib.new(algorithm)
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def read_json(path: Path):
    if not 0 < path.stat().st_size <= MAX_JSON_BYTES:
        raise ValueError("JSON evidence exceeds size bound")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def project_file(value, project: Path) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError("A contained evidence path is required")
    path = Path(value)
    path = (path if path.is_absolute() else project / path).resolve()
    if not extract.contained(path, project) or not path.is_file():
        raise ValueError("Evidence path must be an existing project file")
    return path


def output_path(project: Path, lane: str, supplied=None) -> Path:
    if not isinstance(lane, str) or not KEY.fullmatch(lane):
        raise ValueError("Invalid casting lane")
    root = (project / "runtime" / "voice-cast" / lane).resolve()
    path = root if supplied is None else Path(supplied)
    path = (path if path.is_absolute() else project / path).resolve()
    # Exact lane root prevents writing another lane or accepted-existing assets.
    if path != root or not extract.contained(path, project / "runtime" / "voice-cast"):
        raise ValueError("Output must be the assigned runtime/voice-cast/<lane> directory")
    return path


def depot(value, extension: str) -> str:
    if not isinstance(value, str):
        raise ValueError("Expected relative depot path")
    path = value.replace("/", "\\").lower()
    if (not path.endswith(extension) or path.startswith("\\") or ":" in path
            or any(part in {"", ".", ".."} for part in path.split("\\"))
            or not path.isascii()):
        raise ValueError("Unsafe or mismatched depot path")
    return path


def ident(value) -> str:
    if isinstance(value, bool) or not re.fullmatch(r"[0-9]{1,20}", str(value)) or int(value) > 0xFFFFFFFFFFFFFFFF:
        raise ValueError("Invalid native identifier")
    return str(int(value))


def pointer(document, path: str):
    if not isinstance(path, str) or not path.startswith("/"):
        raise ValueError("An explicit native JSON pointer is required")
    value = document
    try:
        for token in path[1:].split("/"):
            token = token.replace("~1", "/").replace("~0", "~")
            if isinstance(value, list):
                if not re.fullmatch(r"0|[1-9][0-9]*", token):
                    raise ValueError("Invalid JSON array index")
                value = value[int(token)]
            else:
                value = value[token]
    except (KeyError, IndexError, ValueError, TypeError) as e:
        raise ValueError("Native JSON pointer does not resolve") from e
    return value


def normalized(value) -> str:
    return re.sub(r"[\W_]", "", str(value).casefold())


def identity_projection(rows):
    """Stable canonical identity only; dialogue/prompt prose is not attribution.

    Preserve exact name, aliases, records and their array order. Only absent/null
    optional lists normalize to [], matching resident profiles' original shape.
    Sort profiles by their keys so JSON/source presentation order is immaterial.
    Duplicate, unknown/malformed keys or malformed identity fields fail closed.
    """
    if not isinstance(rows, list) or not rows:
        raise ValueError("Canonical identity roster must be a nonempty list")
    projected, seen = [], set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("key"), str) or not KEY.fullmatch(row["key"]):
            raise ValueError("Canonical identity key is malformed")
        key = row["key"]
        if key in seen:
            raise ValueError("Canonical identity roster has duplicate keys")
        seen.add(key)
        if not isinstance(row.get("name"), str) or not row["name"].strip():
            raise ValueError("Canonical identity name is missing")
        fields = {}
        for field in ("aliases", "records"):
            values = row.get(field)
            if values is None:
                values = []
            if not isinstance(values, list) or any(not isinstance(value, str) or not value for value in values):
                raise ValueError("Canonical identity aliases/records must be explicit string lists")
            fields[field] = list(values)
        projected.append({"key": key, "name": row["name"], **fields})
    return sorted(projected, key=lambda row: row["key"])


def identity_sha256(rows):
    """Version1 UTF-8 canonical projection SHA256, no BOM/newline/prose."""
    return hashlib.sha256(json.dumps(identity_projection(rows), ensure_ascii=False,
                                     sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def validate_roster_identity(manifest, project):
    """Separate historical collection receipt from the current source hash.

    A biography/style edit may change the full roster file while the canonical
    identities remain byte-for-byte equivalent. Inventory+input historical full
    hashes must still match; the identity projection must exactly equal current
    production identities. Do not relabel a historical full hash as current.
    """
    inventory = read_json(project_file(manifest["rosterInventory"], project))
    historical = inventory["summary"]["rosterSha256"]
    if (manifest.get("rosterSha256") != historical or not isinstance(historical, str)
            or not re.fullmatch(r"[a-f0-9]{64}", historical)):
        raise ValueError("Historical manifest/inventory roster hash mismatch")
    current_path = project_file("characters/roster.json", project)
    current_bytes = current_path.read_bytes()
    if not 0 < len(current_bytes) <= MAX_JSON_BYTES:
        raise ValueError("Current roster exceeds its bounded JSON size")
    # Hash and parse the same snapshot; an atomic prompt-only replacement must
    # not produce a receipt containing identities from one file and another hash.
    current = json.loads(current_bytes.decode("utf-8-sig"))
    historical_identities = identity_projection(inventory["characters"])
    current_identities = identity_projection(current)
    if historical_identities != current_identities:
        raise ValueError("Inventory canonical identity differs from the current production roster")
    fingerprint = identity_sha256(current)
    for claimed in (manifest.get("identitySha256"), inventory["summary"].get("identitySha256")):
        if claimed is not None and claimed != fingerprint:
            raise ValueError("Claimed canonical identity fingerprint is mismatched")
    current_hash = hashlib.sha256(current_bytes).hexdigest()
    validation = {"identityProjectionVersion": 1, "identitySha256": fingerprint,
                  "historicalRosterSha256": historical, "currentRosterSha256": current_hash,
                  "fullRosterHashChanged": historical != current_hash, "canonicalIdentityVerified": True}
    return {row["key"]: row for row in inventory["characters"]}, validation


def checked_hash(value, expected: str, label: str, algorithm="sha256"):
    if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{" + str(hashlib.new(algorithm).digest_size * 2) + r"}", expected):
        raise ValueError(label + " hash is malformed")
    actual = digest(value, algorithm) if isinstance(value, Path) else hashlib.new(algorithm, value).hexdigest()
    if actual != expected:
        raise ValueError(label + " hash mismatch")


class CpuSlots:
    """Two real kernel file locks. Process exit releases ownership automatically.

    Files persist, but file existence is never used as ownership. Windows uses
    msvcrt byte-range locks; Unix test hosts use flock. Each held stream stays
    open until exit, exception or explicit release. Do not nest this gate.
    """
    def __init__(self, project: Path, timeout=120.0, poll=0.1):
        if not 0 <= timeout <= 300 or not 0.01 <= poll <= 1:
            raise ValueError("CPU lock wait must be bounded (0..300 seconds)")
        self.directory = project / "runtime" / "voice-cast" / ".locks"
        if not extract.contained(self.directory, project / "runtime" / "voice-cast"):
            raise ValueError("CPU lock directory escapes voice-cast")
        self.timeout, self.poll, self.handle, self.slot = timeout, poll, None, None

    @staticmethod
    def _acquire(stream):
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    @staticmethod
    def _release(stream):
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)

    def __enter__(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self.timeout
        while True:
            for index in range(2):
                path = self.directory / ("cpu-" + str(index) + ".lock")
                if not extract.contained(path, self.directory):
                    raise ValueError("CPU lock file escapes the owned lock directory")
                stream = path.open("a+b", buffering=0)
                try:
                    # Lock length may extend beyond EOF on Windows; no marker
                    # bytes are written while another process holds the lock.
                    self._acquire(stream)
                except (BlockingIOError, PermissionError, OSError):
                    stream.close()
                    continue
                self.handle, self.slot = stream, index
                return self
            if time.monotonic() >= deadline:
                raise TimeoutError("Both voice archive/decoder CPU slots are busy")
            time.sleep(min(self.poll, max(0, deadline - time.monotonic())))

    def __exit__(self, *args):
        if self.handle is not None:
            try:
                self._release(self.handle)
            finally:
                self.handle.close()
                self.handle = None


class LaneLock(CpuSlots):
    """Exclusive output ownership in addition to the global two-job CPU gate."""
    def __init__(self, project, lane, timeout=120):
        super().__init__(project, timeout)
        if not KEY.fullmatch(lane):
            raise ValueError("Invalid output lane lock")
        self.lane = lane

    def __enter__(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self.timeout
        while True:
            path = self.directory / ("lane-" + self.lane + ".lock")
            if not extract.contained(path, self.directory):
                raise ValueError("Lane lock file escapes the owned lock directory")
            stream = path.open("a+b", buffering=0)
            try:
                self._acquire(stream)
            except OSError:
                stream.close()
                if time.monotonic() >= deadline:
                    raise TimeoutError("Casting lane already has an output owner")
                time.sleep(min(self.poll, max(0, deadline - time.monotonic())))
                continue
            self.handle = stream
            return self


def validate_identity(actor, proof, roster, document, project, scene=None, actor_pointer=None):
    if not isinstance(proof, dict) or proof.get("canonicalKey") != roster["key"]:
        raise ValueError("Canonical actor identity proof is missing or mismatched")
    scope = proof.get("sourceScope")
    if scope is not None and (not isinstance(scope, dict) or scene is None or scope != {
            "actorPointer": actor_pointer, "nativeVoice": ident(actor["voicetagId"]["id"]),
            "sceneRawSha256": scene["rawSha256"], "sceneJsonSha256": scene["jsonSha256"]}):
        raise ValueError("Reviewed identity source scope does not match this exact scene actor")
    kind = proof.get("kind")
    actor_name = actor["actorName"]
    if kind == "exact_actor":
        aliases = [roster["name"], *roster.get("aliases", [])]
        if normalized(actor_name) not in {normalized(x) for x in aliases}:
            raise ValueError("Native actor is not an exact canonical roster alias")
    elif kind == "reviewed_actor_alias":
        if (proof.get("actorName") != actor_name or not str(proof.get("reviewer", "")).strip()
                or not str(proof.get("reason", "")).strip()):
            raise ValueError("Native alias requires a named reviewer and attribution reason")
        # Shared demographic/crowd names cannot be promoted by alias review.
        if re.search(r"(^|[ _-])(civ|civilian|generic|crowd|gang|npc|vendor|barman)([ _-]|$)", actor_name, re.I):
            raise ValueError("Generic actors require native quest-acquisition proof")
    elif kind == "direct_actor_record":
        active_fields = {"spawnDespawn": "spawnDespawnParams/specRecordId",
                         "findInContext": "findActorInContextParams/specRecordId"}
        suffix = active_fields.get(actor.get("acquisitionPlan"))
        if actor_pointer is None or suffix is None or proof.get("recordPointer") != actor_pointer + "/" + suffix:
            raise ValueError("Direct canonical record must belong to this actor's active acquisition plan")
        return canonical_record(pointer(document, proof["recordPointer"]), roster.get("records"), proof.get("canonicalRecord"))
    elif kind == "quest_acquisition":
        resource = project_file(proof.get("resourcePath"), project)
        # External community/quest acquisition proof is an independently scoped
        # resource job. Until its archive+raw+serialization receipt is supported,
        # do not accept arbitrary JSON co-occurrence as character ownership.
        if scene is None or resource != project_file(scene["jsonPath"], project):
            raise ValueError("External acquisition resource needs coordinator-reviewed native provenance support")
        checked_hash(resource, proof.get("resourceSha256"), "Acquisition resource")
        acquisition = read_json(resource)
        object_pointer = proof.get("acquisitionPointer")
        native_object = pointer(acquisition, object_pointer)
        if (not isinstance(native_object, dict) or not native_object.get("$type")
                or native_object.get("$type") not in {"scnActorDef", "questSpawnEntityNodeDefinition", "questActorRegistrationNodeDefinition", "communitySpawnEntry"}
                or any(not isinstance(proof.get(field), str) or not proof[field].startswith(object_pointer + "/")
                       for field in ("recordPointer", "actorPointer"))):
            raise ValueError("Acquisition proof requires an explicit typed actor-to-record object")
        record = pointer(acquisition, proof.get("recordPointer"))
        if isinstance(record, dict) and record.get("$type") == "TweakDBID":
            resolved = canonical_record(record, roster.get("records"), proof.get("recordValue"))
        elif record == proof.get("recordValue") and record in roster.get("records", []):
            resolved = {"record": record}
        else:
            raise ValueError("Acquisition pointer does not establish the canonical spawn record")
        # Require the native actor linkage itself, not an unrelated record.
        link = pointer(acquisition, proof.get("actorPointer"))
        if isinstance(link, dict):
            link = link.get("actorName", link.get("$value", link))
        if link != actor_name:
            raise ValueError("Acquisition record does not link this scene actor")
        return resolved
    else:
        raise ValueError("Unsupported actor identity proof")


def validate_native_source(source, project, extensions=(".scene",)):
    """Hash-bound CR2W export receipt; decoded-native authentication is separate."""
    raw = project_file(source["rawPath"], project)
    json_path = project_file(source["jsonPath"], project)
    checked_hash(raw, source["rawSha256"], "Native resource raw")
    checked_hash(raw, source["entrySha1"], "Native resource entry", "sha1")
    checked_hash(json_path, source["jsonSha256"], "Native resource serialization")
    document = read_json(json_path)
    if Path(document["Header"]["ArchiveFileName"]).resolve() != raw:
        raise ValueError("Native resource serialization source mismatch")
    manifest_path = project_file(source["manifestPath"], project)
    manifest = read_json(manifest_path)
    extension = Path(source["depotPath"]).suffix.lower()
    if extension not in extensions:
        raise ValueError("Unsupported native attribution resource kind")
    source_depot = depot(source["depotPath"], extension)
    rows = [x for x in manifest["assets"] if x.get("winner") is True and str(x.get("depotPath", "")).lower().endswith(extension)
            and depot(x["depotPath"], extension) == source_depot]
    if len(rows) != 1:
        raise ValueError("Resource must have one winning native export receipt")
    row = rows[0]
    if (row["archivePath"] != source["archive"] or row["archiveEntrySha1"] != source["entrySha1"]
            or row["assetSha256"] != source["rawSha256"]
            or (manifest_path.parent / row["rawPath"]).resolve() != raw
            or (manifest_path.parent / row["jsonPath"]).resolve() != json_path):
        raise ValueError("Resource receipt does not match native export provenance")
    if source["archive"] not in SCENE_ARCHIVES:
        raise ValueError("Unsupported native attribution archive")
    return document


def community_entry_receipt(source, entry_pointer, roster, project, expected_entry_name=None):
    """Verify a community entry->record while preserving the missing world edge.

    This is deliberately NOT identity authorization. A scene NodeRef and a
    similarly named .community filename do not establish which world instance
    owns that resource. Registry templates are embedded Data handles, not depot
    references. Callers must retain this gap until an authenticated actual world
    reference/registry chain is available. No guessing of absent fields occurs.
    """
    document = validate_native_source(source, project, (".community",))
    root = document["Data"]["RootChunk"]
    if root.get("$type") not in {"communityCommunityTemplate", "communityCommunitySpawnSetTemplate"}:
        raise ValueError("Native resource is not a typed community template")
    template = root.get("communityTemplate", {}).get("Data", {})
    if template.get("$type") != "communityCommunityTemplateData" or not re.fullmatch(r"/Data/RootChunk/communityTemplate/Data/entries/[0-9]+/Data", entry_pointer):
        raise ValueError("Community entry pointer is outside its typed template")
    entry = pointer(document, entry_pointer)
    if entry.get("$type") != "communitySpawnEntry":
        raise ValueError("Community entry is not a typed spawn entry")
    name = entry.get("entryName", {})
    if name.get("$type") != "CName" or name.get("$storage") != "string" or not name.get("$value"):
        raise ValueError("Community entry name must be an explicit native string")
    if expected_entry_name is not None and name["$value"] != expected_entry_name:
        raise ValueError("Community entry name does not match scene acquisition")
    record = canonical_record(entry.get("characterRecordId"), roster.get("records"))
    return {"source": source, "entryPointer": entry_pointer, "entryName": name["$value"],
            "canonicalRecord": record, "communityEntryRecordVerified": True,
            "bindingVerified": False, "attributionVerified": False,
            "gap": "Scene NodeRef to this community template has no authenticated native world edge"}


def source_delivery(event, supplied=None):
    """Describe the native event, without inferring the WEM's audible filtering.

    Nonordinary canonical performances need an explicit source qualification.
    Original PCM and attribution checks apply unchanged to every delivery kind.
    """
    params = event.get("voParams", {})
    holo = params.get("isHolocallSpeaker")
    if type(holo) not in (bool, int) or holo not in (0, 1):
        raise ValueError("Native holocall metadata is missing or invalid")
    expression = params.get("voExpression")
    if expression not in {"Vo_Expression_Spoken", "Vo_Expression_Phone", "Vo_Expression_GlobalTV"}:
        raise ValueError("Unsupported native dialogue delivery")
    custom = params.get("customVoEvent")
    custom = custom.get("$value", "None") if isinstance(custom, dict) else custom
    custom = "None" if custom in (None, "None", "", "0") else custom
    if not isinstance(custom, str) or not custom.strip() or len(custom) > 400:
        raise ValueError("Native custom voice event is invalid")
    if custom != "None":
        kind = "canonical-custom-performance"
    elif expression == "Vo_Expression_GlobalTV":
        kind = "canonical-media-performance"
    elif expression == "Vo_Expression_Phone" or holo:
        kind = "canonical-phone-performance"
    elif expression == "Vo_Expression_Spoken":
        kind = "ordinary-spoken"
    else:
        raise ValueError("Unsupported native dialogue delivery")
    observed = {"kind": kind, "isHolocallSpeaker": bool(holo),
                "voExpression": expression, "customVoEvent": custom,
                "waveformProcessingAssessed": False}
    if supplied is None:
        if kind != "ordinary-spoken":
            raise ValueError("Nonordinary reference requires explicit sourceDelivery qualification")
        return {**observed, "reason": "Native ordinary spoken event; original waveform processing is not assessed."}
    if (not isinstance(supplied, dict) or any(supplied.get(k) != v or
            type(supplied.get(k)) is not type(v) for k, v in observed.items())
            or not isinstance(supplied.get("reason"), str) or not supplied["reason"].strip()
            or len(supplied["reason"]) > 2000):
        raise ValueError("sourceDelivery does not exactly describe the native event")
    return {**observed, "reason": supplied["reason"]}


def validate_native(candidate, roster, project):
    scene = candidate["scene"]
    document = validate_native_source(scene, project)
    for section, pattern in (("actor", r"/Data/RootChunk/actors/[0-9]+"),
                             ("line", r"/Data/RootChunk/screenplayStore/lines/[0-9]+")):
        if not re.fullmatch(pattern, candidate[section]["pointer"]):
            raise ValueError("Native actor/line pointer is outside its typed store")
    if not re.fullmatch(r"/Data/RootChunk/locStore/vdEntries/[0-9]+", candidate["english"]["descriptorPointer"]):
        raise ValueError("Descriptor pointer is outside the native locStore")
    actor = pointer(document, candidate["actor"]["pointer"])
    line = pointer(document, candidate["line"]["pointer"])
    event = pointer(document, candidate["event"]["pointer"])
    if actor.get("$type") != "scnActorDef" or line.get("$type") != "scnscreenplayDialogLine" or event.get("$type") != "scnDialogLineEvent":
        raise ValueError("Native pointers resolve to unexpected actor/line/event types")
    a, l = candidate["actor"], candidate["line"]
    actor_id, speaker_id = ident(actor["actorId"]["id"]), ident(line["speaker"]["id"])
    item_id, loc_id = ident(line["itemId"]["id"]), ident(line["locstringId"]["ruid"])
    if (ident(a["id"]) != actor_id or a["name"] != actor["actorName"]
            or ident(a["voicetagId"]) != ident(actor["voicetagId"]["id"])
            or ident(l["speakerId"]) != speaker_id or actor_id != speaker_id
            or ident(l["itemId"]) != item_id or item_id != ident(event["screenplayLineId"]["id"])
            or ident(l["locstringId"]) != loc_id or loc_id != candidate["stringId"]):
        raise ValueError("Native actor/speaker/item/event/localization joins do not agree")
    identity_verification = validate_identity(actor, a["identityProof"], roster, document, project, scene, a["pointer"])
    delivery = source_delivery(event, candidate.get("sourceDelivery"))
    english = candidate["english"]
    descriptor = pointer(document, english["descriptorPointer"])
    payload = pointer(document, english["payloadPointer"])
    payloads = document["Data"]["RootChunk"]["locStore"]["vpEntries"]
    vpe = descriptor.get("vpeIndex")
    if (descriptor.get("localeId") != "en_us" or isinstance(vpe, bool) or not isinstance(vpe, int)
            or not 0 <= vpe < len(payloads) or payloads[vpe] is not payload
            or english["payloadPointer"] != f"/Data/RootChunk/locStore/vpEntries/{vpe}"
            or descriptor.get("variantId") != payload.get("variantId")
            or ident(descriptor["locstringId"]["ruid"]) != loc_id):
        raise ValueError("Exact English scene descriptor/payload variant join failed")
    text = english["transcript"]
    if not isinstance(text, str) or not text.strip() or payload["content"] != text:
        raise ValueError("Scene English transcript does not match reviewed candidate")
    checked_hash(text.encode("utf-8"), english["transcriptSha256"], "Transcript")
    expected_variant = {"female": "femaleVariant", "male": "maleVariant"}.get(candidate.get("genderVariant"))
    if expected_variant is None or english.get("variant") != expected_variant:
        raise ValueError("Explicit WEM gender and subtitle variant do not agree")
    # Require WEM basename localization suffix, never use its actor prefix.
    wem = depot(candidate["wemPath"], ".wem")
    wem_parts = re.fullmatch(r"(?:base|ep1)\\localization\\en-us\\vo\\[^\\]+_(f|m)_([a-f0-9]{16})\.wem", wem)
    if (not wem_parts or wem_parts[2] != f"{int(loc_id):016x}"
            or wem_parts[1] != {"female": "f", "male": "m"}[candidate["genderVariant"]]):
        raise ValueError("WEM English path/gender/localization suffix does not match native reference")
    return {"scene": scene, "actor": {**a, "identityVerification": identity_verification}, "line": l, "event": {"pointer": candidate["event"]["pointer"], **event},
            "english": {**english, "vpeIndex": vpe, "variantId": ident(descriptor["variantId"]["ruid"]), "locale": "en_us"},
            "sourceDelivery": delivery}


def indexed_subtitles(db, string_id):
    rows = db.execute("SELECT source_json FROM entries WHERE domain=? AND entry_id=?", ("subtitle.stringId", string_id)).fetchall()
    if not rows:
        raise ValueError("Exact English subtitle ID absent from installed text index")
    results = [json.loads(x[0]) for x in rows]
    if any(x.get("domain") != "subtitle.stringId" or ident(x.get("id")) != string_id for x in results):
        raise ValueError("Malformed exact subtitle index row")
    return results


def tool_info(manifest):
    result = {}
    for name in ("vgmstream-cli", "ffprobe"):
        matches = [x for x in manifest.get("tools", []) if x.get("name") == name]
        if len(matches) != 1:
            raise ValueError("One verified " + name + " tool is required")
        tool = matches[0]
        path = Path(tool["path"]).resolve()
        pinned_path, pinned_hash = PINNED_TOOLS[name]
        if path != Path(pinned_path).resolve() or tool.get("sha256") != pinned_hash:
            raise ValueError("Decoder executable is not the pinned reviewed tool")
        if not path.is_file() or not str(tool.get("version", "")).strip():
            raise ValueError("Verified decoder path/version is missing")
        checked_hash(path, tool.get("sha256"), name)
        result[name] = {**tool, "path": str(path)}
    return result


def validate_input(manifest, project: Path, output=None):
    if manifest.get("schemaVersion") != 1:
        raise ValueError("Unsupported casting candidate schema")
    out = output_path(project, manifest.get("lane"), output)
    roster, roster_validation = validate_roster_identity(manifest, project)
    manifest["_rosterValidation"] = roster_validation
    lane_inventory = project_file(manifest["laneInventory"], project)
    if lane_inventory != project_file(LANE_INVENTORY, project):
        raise ValueError("Only the coordinator's canonical casting-lanes inventory is allowed")
    lanes = read_json(lane_inventory)
    assignments = [key for item in lanes["lanes"] for key in item["keys"]]
    if len(assignments) != len(set(assignments)) or set(assignments) != set(roster):
        raise ValueError("Lane partition must assign every canonical profile exactly once")
    lane = next((x for x in lanes["lanes"] if x["name"] == manifest["lane"]), None)
    if not lane or lane.get("mode") == "preserve_and_hash_check_only":
        raise ValueError("No extraction is allowed for this lane")
    candidates = manifest.get("candidates")
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= MAX_BATCH:
        raise ValueError("Batch must contain 1..48 candidates")
    counts, unique = Counter(), set()
    game = Path(manifest["gameRoot"]).resolve()
    if extract.contained(out, game) or extract.contained(game, out):
        raise ValueError("Casting output overlaps game directory")
    for item in candidates:
        key = item.get("key", "")
        if not KEY.fullmatch(key) or key not in roster or key not in lane["keys"]:
            raise ValueError("Candidate character is not assigned to this lane")
        if key in {"resident-male", "resident-female"}:
            raise ValueError("Generic crowd profiles have no canonical voice selection policy")
        item["stringId"] = ident(item.get("stringId"))
        counts[key] += 1
        if counts[key] > MAX_PER_CHARACTER:
            raise ValueError("At most six candidates per character")
        unique_key = (key, item["stringId"], item.get("genderVariant"))
        if unique_key in unique:
            raise ValueError("Duplicate canonical candidate")
        unique.add(unique_key)
        item["nativeReceipt"] = validate_native(item, roster[key], project)
    return out, roster


def winning(archives, path, oodle):
    result = None
    for archive in archives:
        if (match := archive.read(path, oodle)) is not None:
            result = match
    if result is None:
        raise ValueError("Native resource is absent from installed allowlisted archives")
    return result


def verify_live_scene(scene, archives):
    selected = [(archive, archive.entries[extract.depot_hash(scene["depotPath"])]) for archive in archives
                if extract.depot_hash(scene["depotPath"]) in archive.entries]
    if not selected:
        raise ValueError("Cached native scene is absent from installed archives")
    archive, entry = selected[-1]
    if archive.relative != scene["archive"] or entry[2] != scene["entrySha1"]:
        raise ValueError("Cached native scene is not the current installed winner")


def authenticate_serialization(scene, project, out, verified):
    """Authenticate JSON to raw bytes through the independently pinned parser.

    Copy and serialize raw into temporary owned output so original evidence is
    never overwritten. Compare CR2W Data only, excluding source paths/export time.
    All calls occur inside the global CPU gate. No scene archive payload rewrite.
    """
    key = (scene["rawSha256"], scene["jsonSha256"])
    if key in verified:
        return verified[key]
    cli = project / "vendor" / "wolvenkit-console-9.0.1" / "WolvenKit.CLI.exe"
    checked_hash(cli, WOLVENKIT_SHA256, "Pinned native serializer")
    with tempfile.TemporaryDirectory(prefix=".native-", dir=out) as temporary:
        stage = Path(temporary).resolve()
        if not extract.contained(stage, out):
            raise ValueError("Native serialization staging escapes lane")
        extension = Path(scene["rawPath"]).suffix.lower()
        if extension not in {".scene", ".community", ".quest", ".questphase", ".gamedef"}:
            raise ValueError("Unsupported native serialization resource kind")
        raw = stage / ("source" + extension)
        shutil.copyfile(project_file(scene["rawPath"], project), raw)
        checked_hash(raw, scene["rawSha256"], "Copied native scene")
        env = {**os.environ, "DOTNET_ROOT": str(project / "vendor" / "dotnet-runtime-10.0.12"), "DOTNET_PROCESSOR_COUNT": "2"}
        subprocess.run([str(cli), "convert", "serialize", str(raw)], cwd=project, env=env,
                       capture_output=True, check=True, timeout=120,
                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        actual = read_json(raw.with_name(raw.name + ".json"))
        expected = read_json(project_file(scene["jsonPath"], project))
        if (Path(actual["Header"]["ArchiveFileName"]).resolve() != raw
                or actual["Data"] != expected["Data"]):
            raise ValueError("Cached actor/line JSON is not the serialization of verified native raw")
        receipt = {"verified": True, "tool": "WolvenKit.CLI 9.0.1", "toolSha256": WOLVENKIT_SHA256,
                   "rawSha256": scene["rawSha256"], "cachedJsonSha256": scene["jsonSha256"],
                   "dataSha256": hashlib.sha256(json.dumps(actual["Data"], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()}
    verified[key] = receipt
    return receipt


def write_json(path: Path, data):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def publish_directory(stage: Path, directory: Path, timeout=10.0):
    """Windows scanners/readers may briefly hold a completed original WAV.

    Retry only the atomic rename; never copy, overwrite or re-encode originals.
    Caller owns the lane lock and staging. Failure remains bounded and its owned
    temporary directory is cleaned by the surrounding context.
    """
    deadline = time.monotonic() + timeout
    while True:
        try:
            stage.rename(directory)
            return
        except PermissionError:
            if directory.exists() or time.monotonic() >= deadline:
                raise
            time.sleep(min(.1, max(0, deadline - time.monotonic())))


def verify_probe(probe, quality):
    streams = [x for x in probe.get("streams", []) if x.get("codec_type") == "audio"]
    if len(streams) != 1:
        raise ValueError("ffprobe must identify exactly one original PCM audio stream")
    stream = streams[0]
    try:
        valid = (stream["codec_name"] == "pcm_s16le" and int(stream["sample_rate"]) == quality["sampleRate"]
                 and int(stream["channels"]) == quality["channels"] and int(stream["bits_per_sample"]) == quality["bitsPerSample"]
                 and Fraction(stream["time_base"]) * int(stream["duration_ts"]) == Fraction(quality["frames"], quality["sampleRate"]))
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as e:
        raise ValueError("ffprobe original PCM receipt is malformed") from e
    if not valid:
        raise ValueError("ffprobe PCM channels/rate/bits/frame-duration disagree with WAV")


def decode_candidate(candidate, roster, project, out, archives, oodle, tools, receipt, verified, db_path):
    native = candidate["nativeReceipt"]
    voice_archives, text_archives, scene_archives = archives
    verify_live_scene(candidate["scene"], scene_archives)
    serialization = authenticate_serialization(candidate["scene"], project, out, verified)
    wem, audio_source = winning(voice_archives, depot(candidate["wemPath"], ".wem"), oodle)
    if (len(wem) < 12 or wem[:4] != b"RIFF" or wem[8:12] != b"WAVE"
            or int.from_bytes(wem[4:8], "little") + 8 != len(wem)):
        raise ValueError("WEM is not a complete bounded RIFF WAVE container")
    subtitle_sources = []
    for row in candidate["subtitleRows"]:
        path = depot(row["source"]["depotPath"], ".json")
        if "\\localization\\en-us\\subtitles\\" not in path:
            raise ValueError("Subtitle index resource is not English subtitles")
        data, source = winning(text_archives, path, oodle)
        if (source["archive"] != row["source"]["archivePath"]
                or source["archiveEntrySha1"] != row["source"]["archiveEntrySha1"]
                or source["sha256"] != row["source"]["assetSha256"]):
            raise ValueError("Indexed subtitle receipt is not the current installed resource")
        parsed = extract.local_subtitle(data, candidate["stringId"], candidate["english"]["variant"])
        if parsed is None or parsed[0] != candidate["english"]["transcript"]:
            raise ValueError("Exact installed subtitle disagrees with native scene")
        subtitle_sources.append({**source, "indexPointer": row["jsonPointer"],
                                 "variantPointer": row["jsonPointer"] + "/" + candidate["english"]["variant"],
                                 **parsed[1], "indexedSource": row["source"]})
    key_root = out / candidate["key"]
    if not extract.contained(key_root, out):
        raise ValueError("Candidate output escapes lane")
    key_root.mkdir(exist_ok=True)
    stem = candidate["stringId"] + "-" + candidate["genderVariant"]
    directory = key_root / stem
    text = candidate["english"]["transcript"]
    if directory.exists():
        saved = read_json(directory / "receipt.json")
        if (saved.get("key") != candidate["key"] or saved.get("stringId") != candidate["stringId"]
                or saved.get("transcript") != text
                or saved["provenance"]["nativeActor"]["scene"] != native["scene"]
                or saved["provenance"]["audio"]["sha256"] != audio_source["sha256"]
                or saved["provenance"]["audio"]["genderVariant"] != candidate["genderVariant"]
                or source_delivery(saved["provenance"]["nativeLine"]["event"],
                                   saved["provenance"].get("sourceDelivery")) != native["sourceDelivery"]):
            raise ValueError("Existing original candidate has different immutable provenance")
        checked_hash(directory / "source.wem", audio_source["sha256"], "Existing original WEM")
        checked_hash(directory / "reference.wav", saved["sha256"], "Existing original WAV")
        if (directory / "transcript.txt").read_text(encoding="utf-8").removesuffix("\n") != text:
            raise ValueError("Existing exact transcript was changed")
        return saved
    with tempfile.TemporaryDirectory(prefix=".decode-", dir=key_root) as temporary:
        stage = Path(temporary).resolve()
        if not extract.contained(stage, out):
            raise ValueError("Decode staging escapes lane")
        wem_path, wav_path, text_path = [stage / name for name in ("source.wem", "reference.wav", "transcript.txt")]
        wem_path.write_bytes(wem)
        decoder = extract.hidden_run([tools["vgmstream-cli"]["path"], "-i", "-o", str(wav_path), str(wem_path)])
        quality = extract.wav_quality(wav_path)
        if not quality["nonSilent"]:
            raise ValueError("Decoded clip is silent")
        probe = json.loads(extract.hidden_run([tools["ffprobe"]["path"], "-v", "error", "-show_streams", "-show_format", "-of", "json", str(wav_path)]).stdout)
        verify_probe(probe, quality)
        text_path.write_text(text + "\n", encoding="utf-8")
        quality["originalPcm"] = True
        quality["completeReferenceDuration"] = 3 <= quality["durationSeconds"] <= 12
        quality["spokenWordCount"] = len(text.split())
        item = {"key": candidate["key"], "stringId": candidate["stringId"], "status": "decoded_verified",
                "attributionVerified": True, "transcriptAgreement": True, "listeningVerified": False, "voiceCloneApproved": False,
                "reference": (directory / "reference.wav").relative_to(project).as_posix(), "transcript": text,
                "transcriptSha256": candidate["english"]["transcriptSha256"], "sha256": quality["sha256"],
                "provenance": {"rosterSha256": receipt["rosterSha256"], **receipt["rosterValidation"], "gameVersion": "2.31", "locale": "en_us",
                  "identity": {**identity_projection([roster[candidate["key"]]])[0], "proof": candidate["actor"]["identityProof"]},
                  "discovery": candidate.get("discovery", {"inputSha256": receipt["inputSha256"]}),
                  "nativeActor": {"scene": native["scene"], "serializationVerification": serialization, **native["actor"]},
                  "nativeLine": {**native["line"], "event": native["event"]},
                  "sourceDelivery": native["sourceDelivery"],
                  "subtitle": {**native["english"], "sources": subtitle_sources, "indexSha256": digest(db_path), "indexPath": db_path.relative_to(project).as_posix()},
                  "audio": {**audio_source, "genderVariant": candidate["genderVariant"],
                            "wemPath": (directory / "source.wem").relative_to(project).as_posix(),
                            "wavPath": (directory / "reference.wav").relative_to(project).as_posix(),
                            "decoder": tools["vgmstream-cli"], "ffprobe": tools["ffprobe"],
                            "decoderOutput": decoder.stdout.strip(), "ffprobeReceipt": probe, "processing": receipt["audioProcessing"]},
                  "quality": quality}}
        write_json(stage / "receipt.json", item)
        # Whole directory publishes atomically. A process death after rename is
        # recovered from its immutable receipt rather than redecoding/overwriting.
        publish_directory(stage, directory)
    return item


def run(manifest_path: Path, project: Path, output=None, *, dry_run=True, lock_timeout=120):
    project = project.resolve()
    manifest = read_json(manifest_path.resolve())
    out, roster = validate_input(manifest, project, output)
    tools = tool_info(manifest)
    db_path = project_file(manifest["subtitleIndex"], project)
    receipt = {"schemaVersion": 1, "lane": manifest["lane"], "createdAt": datetime.now(timezone.utc).isoformat(),
               "rosterSha256": manifest["rosterSha256"], **manifest["_rosterValidation"],
               "rosterValidation": manifest["_rosterValidation"], "inputSha256": digest(manifest_path),
               "audioProcessing": "Original vgmstream PCM decode only; no gain/EQ/denoise/resample/trim/concat",
               "listeningVerified": False, "voiceCloneApproved": False, "candidates": []}
    with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
        for candidate in manifest["candidates"]:
            rows = indexed_subtitles(db, candidate["stringId"])
            variant = candidate["english"]["variant"]
            text = candidate["english"]["transcript"]
            if any(row.get(variant) != text for row in rows):
                raise ValueError("Indexed installed subtitle variants conflict with native scene transcript")
            candidate["subtitleRows"] = rows
        if dry_run:
            return {**receipt, "dryRun": True, "output": str(out), "status": "attributed_receipt_validated",
                    "candidates": [{"key": x["key"], "stringId": x["stringId"], "nativeReceipt": x["nativeReceipt"],
                                    "indexedSubtitleResources": len(x["subtitleRows"])} for x in manifest["candidates"]]}
        with LaneLock(project, manifest["lane"], timeout=lock_timeout), CpuSlots(project, timeout=lock_timeout):
            game = Path(manifest["gameRoot"]).resolve()
            oodle = extract.Oodle(game / "tools/redmod/bin/oo2ext_7_win64.dll")
            voice_archives = [extract.Archive(game, x) for x in VOICE_ARCHIVES if (game / x).is_file()]
            text_archives = [extract.Archive(game, x) for x in TEXT_ARCHIVES if (game / x).is_file()]
            scene_archives = [extract.Archive(game, x) for x in SCENE_ARCHIVES if (game / x).is_file()]
            if not voice_archives or not text_archives or not scene_archives:
                raise ValueError("Installed base voice/text/scene archives are required")
            out.mkdir(parents=True, exist_ok=True)
            prior_path = out / "manifest.json"
            if prior_path.exists():
                prior = read_json(prior_path)
                if prior.get("lane") != receipt["lane"] or prior.get("rosterSha256") != receipt["rosterSha256"]:
                    raise ValueError("Existing lane manifest belongs to a different roster or lane")
                receipt["candidates"] = prior["candidates"]
                receipt["inputBatches"] = prior.get("inputBatches", [prior.get("inputSha256")])
            else:
                receipt["inputBatches"] = []
            if receipt["inputSha256"] not in receipt["inputBatches"]:
                receipt["inputBatches"].append(receipt["inputSha256"])
            existing = {(x["key"], x["stringId"], x["provenance"]["audio"]["genderVariant"]) for x in receipt["candidates"]}
            total_counts = Counter(x[0] for x in existing)
            for candidate in manifest["candidates"]:
                token = (candidate["key"], candidate["stringId"], candidate["genderVariant"])
                if token not in existing:
                    total_counts[candidate["key"]] += 1
            if any(value > MAX_PER_CHARACTER for value in total_counts.values()):
                raise ValueError("Cumulative lane receipts exceed six candidates per character")
            verified = {}
            for candidate in manifest["candidates"]:
                item = decode_candidate(candidate, roster, project, out, (voice_archives, text_archives, scene_archives), oodle, tools, receipt, verified, db_path)
                item = {**item, "validationReceipt": {**receipt["rosterValidation"], "validatedAt": receipt["createdAt"]}}
                token = (candidate["key"], candidate["stringId"], candidate["genderVariant"])
                if token not in existing:
                    receipt["candidates"].append(item)
                    existing.add(token)
                else:
                    # Refresh validation metadata in the cumulative manifest,
                    # preserving the original candidate receipt/audio files.
                    receipt["candidates"] = [item if (row["key"], row["stringId"], row["provenance"]["audio"]["genderVariant"]) == token else row
                                             for row in receipt["candidates"]]
                write_json(out / "manifest.json", receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--decode", action="store_true", help="Actually decode; default is side-effect-free validation")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--lock-timeout", type=float, default=120)
    args = parser.parse_args()
    if args.decode and args.dry_run:
        parser.error("Use either --decode or --dry-run")
    result = run(args.manifest, args.project, args.output, dry_run=not args.decode, lock_timeout=args.lock_timeout)
    print(json.dumps({"lane": result["lane"], "dryRun": result.get("dryRun", False), "candidates": len(result["candidates"]),
                      "status": result.get("status", "decoded_verified"), "output": result.get("output", str(output_path(args.project, result["lane"], args.output))),
                      "identitySha256": result["identitySha256"], "historicalRosterSha256": result["historicalRosterSha256"],
                      "currentRosterSha256": result["currentRosterSha256"], "fullRosterHashChanged": result["fullRosterHashChanged"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
