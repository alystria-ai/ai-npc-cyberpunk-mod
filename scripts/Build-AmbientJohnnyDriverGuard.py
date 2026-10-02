"""Build a bounded Cyberpunk 2.31 ambient Johnny driver-seat guard candidate.

Only thepassenger.questphase phase 89/node 67 changes: its existing AND gains
an explicit player OnMount/Driver predicate. The Taxi branch stays unchanged.
This builds an archive under ignored runtime/verification; it never installs
files, changes quest facts, starts the game, or claims native qualification.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import uuid


DEPOT = r"base\open_world\passenger\phases\thepassenger.questphase"
SOURCE_SHA256 = "a31f799db52defc3fa56c28a0872a3e7aedb312ddfa32fc293bcc80be2bbe2b4"
ARCHIVE_NAME = "cyberpunk_convai_ambient_driver_guard"
ARCHIVES = ("archive/pc/content/basegame_4_gamedata.archive",
            "archive/pc/ep1/ep1_2_gamedata.archive")


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def canonical_handles(value):
    """Compare native graph identities despite serializer handle renumbering."""
    ids = {}
    for node in walk(value):
        if "HandleId" in node:
            key = node["HandleId"]
            if key in ids:
                raise ValueError(f"Duplicate serialized handle: {key}")
            ids[key] = str(len(ids))

    def replace(node):
        if isinstance(node, dict):
            result = {}
            for key, item in node.items():
                if key in ("HandleId", "HandleRefId"):
                    if item not in ids:
                        raise ValueError(f"Dangling serialized handle: {item}")
                    result[key] = ids[item]
                else:
                    result[key] = replace(item)
            return result
        if isinstance(node, list):
            return [replace(item) for item in node]
        return node

    return replace(value)


def node_by_id(nodes, node_id):
    found = [wrapper["Data"] for wrapper in nodes
             if wrapper.get("Data", {}).get("id") == node_id]
    if len(found) != 1:
        raise ValueError(f"Expected exactly one node {node_id}")
    return found[0]


def active_condition(doc):
    phase = node_by_id(doc["Data"]["RootChunk"]["graph"]["Data"]["nodes"], 89)
    if phase.get("$type") != "questPhaseNodeDefinition":
        raise ValueError("Native phase 89 changed type")
    node = node_by_id(phase["phaseGraph"]["Data"]["nodes"], 67)
    if node.get("$type") != "questConditionNodeDefinition":
        raise ValueError("Native node 67 changed type")
    condition = node["condition"]["Data"]
    if condition.get("$type") != "questLogicalCondition" or condition.get("operation") != "AND":
        raise ValueError("Native Active eligibility guard is no longer an AND")
    return condition


def player_driver_template(doc):
    original = active_condition(doc)["conditions"][0]
    if original.get("Data", {}).get("$type") != "questCharacterCondition":
        raise ValueError("Native player mounting predicate changed type")
    mount = original["Data"]["type"]["Data"]
    required = {"$type": "questCharacterMount_ConditionType", "anyChild": 0,
                "anyParent": 0, "childIsPlayer": 1, "parentIsPlayer": 0,
                "condition": "OnMount", "role": "Invalid",
                "vehicleOrigin": "NotStolen", "vehicleType": "Car"}
    if any(mount.get(key) != value for key, value in required.items()):
        raise ValueError("Native player/car eligibility predicate changed")
    if mount["childRef"]["reference"].get("$value") != "#player":
        raise ValueError("Native mounting child is not the player")
    if mount["parentRef"]["reference"].get("$value") != "#mounted_vehicle":
        raise ValueError("Native mounting parent is not V's current vehicle")
    guard = copy.deepcopy(original)
    guard["Data"]["type"]["Data"]["role"] = "Driver"
    return guard


def patch_document(original):
    # Clone the shipped player condition, including its reference schema. Do not
    # infer NPC-only semantics from anyChild/childIsPlayer or change other guards.
    guard = player_driver_template(original)
    result = copy.deepcopy(original)
    existing = [int(node["HandleId"]) for node in walk(original) if "HandleId" in node]
    next_id = max(existing, default=-1) + 1
    for node in walk(guard):
        if "HandleRefId" in node:
            raise ValueError("Player predicate unexpectedly shares native handles")
        if "HandleId" in node:
            node["HandleId"] = str(next_id)
            next_id += 1
    active_condition(result)["conditions"].append(guard)
    verify_roundtrip(original, result)
    return result


def verify_roundtrip(original, actual):
    before = active_condition(original)["conditions"]
    after = active_condition(actual)["conditions"]
    if len(after) != len(before) + 1:
        raise ValueError("Candidate must add exactly one eligibility condition")
    expected = player_driver_template(original)
    if canonical_handles(after[-1]) != canonical_handles(expected):
        raise ValueError("Added condition is not the explicit player Driver guard")
    remainder = copy.deepcopy(actual["Data"])
    # Work on Data only: export time and ArchiveFileName change on serialization.
    remainder_doc = {"Data": remainder}
    active_condition(remainder_doc)["conditions"].pop()
    if canonical_handles(remainder) != canonical_handles(original["Data"]):
        raise ValueError("Candidate changed native content outside the appended guard")
    return {"addedConditions": 1, "changedNativeNodes": ["89/67"],
            "unchangedRemainder": True, "taxiBranchUnchanged": True}


def load_archive_helper(project):
    path = project / "scripts" / "Extract-VoiceReferences.py"
    spec = importlib.util.spec_from_file_location("ambient_archive_reader", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def verify_archive(artifact, expected, helper, oodle):
    """Verify the one packed path and exact body, including empty-digest metadata.

    The pinned CLI emits SHA1(empty) for newly packed CR2W entries on this
    machine. That directory value is recorded, never used as evidence of body
    integrity. Installed inputs still use Archive.read's strict SHA-1 check.
    """
    archive = helper.Archive(artifact.parent, artifact.name)
    if set(archive.entries) != {helper.depot_hash(DEPOT)} or archive.shadowed_entries:
        raise ValueError("Candidate archive contains unexpected or duplicate depot paths")
    first, end, entry_sha1 = archive.entries[helper.depot_hash(DEPOT)]
    if end != first + 1 or end > len(archive.segments):
        raise ValueError("Candidate resource has an unexpected segment layout")
    offset, stored_size, decoded_size = archive.segments[first]
    if decoded_size != len(expected) or not 0 < stored_size <= helper.MAX_RESOURCE_BYTES:
        raise ValueError("Candidate resource segment size differs from the verified binary")
    if offset + stored_size > artifact.stat().st_size:
        raise ValueError("Candidate resource segment exceeds archive bounds")
    with artifact.open("rb") as stream:
        stream.seek(offset)
        stored = stream.read(stored_size)
    if len(stored) != stored_size:
        raise ValueError("Candidate archive payload is truncated")
    decoded = stored if stored_size == decoded_size else oodle.decode(stored, decoded_size)
    if decoded != expected:
        raise ValueError("Packaged resource differs from the verified round-trip binary")
    actual_sha1 = hashlib.sha1(decoded).hexdigest()
    empty_sha1 = hashlib.sha1(b"").hexdigest()
    if entry_sha1 not in (actual_sha1, empty_sha1):
        raise ValueError("Candidate resource has unexpected SHA-1 metadata")
    return decoded, {"depotPath": DEPOT, "pathHash": str(helper.depot_hash(DEPOT)),
                     "storedBytes": stored_size, "decodedBytes": decoded_size,
                     "directorySha1": entry_sha1, "decodedSha1": actual_sha1,
                     "directorySha1MatchesBody": entry_sha1 == actual_sha1,
                     "wolvenkitEmptyDigestMetadata": entry_sha1 == empty_sha1,
                     "decodedByteEqualityVerified": True, "sha256": sha256(decoded)}


def build(project, game, output):
    project, game, output = (Path(path).resolve() for path in (project, game, output))
    allowed = project / "runtime" / "verification"
    if not output.is_relative_to(allowed) or output == allowed:
        raise ValueError("Candidate output must be a new subfolder of runtime/verification")
    if output.exists():
        raise ValueError("Candidate output already exists; use a new folder")
    cli = project / "vendor" / "wolvenkit-console-9.0.1" / "WolvenKit.CLI.exe"
    runtime = project / "vendor" / "dotnet-runtime-10.0.12"
    if not cli.is_file() or not (runtime / "dotnet.exe").is_file():
        raise FileNotFoundError("Pinned WolvenKit 9.0.1/.NET 10.0.12 tools are missing")
    helper = load_archive_helper(project)
    oodle = helper.Oodle(game / "bin/x64/oo2ext_7_win64.dll")
    winner = None
    for relative in ARCHIVES:
        if (game / relative).is_file():
            candidate = helper.Archive(game, relative).read(DEPOT, oodle)
            if candidate:
                winner = candidate
    if not winner:
        raise FileNotFoundError("Installed ambient quest phase was not found")
    source, source_receipt = winner
    if sha256(source) != SOURCE_SHA256:
        raise ValueError("Installed ambient phase does not match the reviewed 2.31 fingerprint")
    output.mkdir(parents=True)
    depot_relative = Path(*DEPOT.split("\\"))
    source_path = output / "original" / depot_relative
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.write_bytes(source)
    logs = output / "logs"
    logs.mkdir()
    env = {**os.environ, "DOTNET_ROOT": str(runtime), "DOTNET_PROCESSOR_COUNT": "2"}

    def run(label, *arguments):
        path = logs / f"{label}.log"
        with path.open("w", encoding="utf-8") as log:
            flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
            completed = subprocess.run([str(cli), *map(str, arguments)], cwd=project,
                                       env=env, stdout=log, stderr=subprocess.STDOUT,
                                       timeout=180, **flags)
        contents = path.read_text(encoding="utf-8", errors="replace")
        if completed.returncode or re.search(r"\[\s*\d+\s*:\s*Error", contents):
            raise RuntimeError(f"WolvenKit {label} failed; inspect {path}")

    run("serialize-original", "convert", "serialize", source_path)
    original_json = Path(str(source_path) + ".json")
    original = json.loads(original_json.read_text(encoding="utf-8-sig"))
    if original["Header"]["GameVersion"] != 2310:
        raise ValueError("Unexpected native resource export version")
    patched = patch_document(original)
    edited = output / "edited" / Path(str(depot_relative) + ".json")
    write_json(edited, patched)
    pack_root = output / "pack-input" / ARCHIVE_NAME
    binary = pack_root / depot_relative
    binary.parent.mkdir(parents=True)
    run("deserialize-guard", "convert", "deserialize", edited, "--outpath", binary.parent)
    if not binary.is_file():
        raise RuntimeError("Native candidate binary was not produced at the exact depot path")
    roundtrip_dir = output / "roundtrip"
    roundtrip_dir.mkdir()
    run("serialize-roundtrip", "convert", "serialize", binary, "--outpath", roundtrip_dir)
    roundtrip = roundtrip_dir / (binary.name + ".json")
    actual = json.loads(roundtrip.read_text(encoding="utf-8-sig"))
    comparison = verify_roundtrip(original, actual)
    if [path for path in pack_root.rglob("*") if path.is_file()] != [binary]:
        raise ValueError("Archive input contains a file outside the one allowed override")
    package = output / "package"
    package.mkdir()
    run("pack-guard", "pack", pack_root, "--outpath", package)
    artifact = package / (ARCHIVE_NAME + ".archive")
    packed = verify_archive(artifact, binary.read_bytes(), helper, oodle)
    receipt = {
        "schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
        "qualification": "source-and-native-roundtrip-only; not installed or live-qualified",
        "source": source_receipt, "sourceSha256": SOURCE_SHA256,
        "tools": {"wolvenkit": "9.0.1", "dotnet": "10.0.12"},
        "archive": str(artifact), "archiveBytes": artifact.stat().st_size,
        "archiveSha256": sha256(artifact.read_bytes()), "depotPaths": [DEPOT],
        "resourceSha256": sha256(packed[0]), "resourceReceipt": packed[1],
        "structuralComparison": comparison,
        "condition": {"child": "#player", "parent": "#mounted_vehicle",
                      "childIsPlayer": True, "anyChild": False,
                      "mountState": "OnMount", "role": "Driver"},
        "limits": ["Only the Active path is guarded; DelamainTaxi is unchanged.",
                   "Already active ambient scenes are not cancelled by this archive.",
                   "Native role evaluation and solo-player behavior require an in-game test.",
                   "The override must not compete with another mod replacing the same depot path."],
        "loadRequirements": ["Install the archive in archive/pc/mod while Cyberpunk is closed.",
                             "Launch the game again; CET Reload All Mods cannot load archive changes.",
                             "Use a fresh vehicle entry so the Active eligibility guard runs."],
    }
    write_json(output / "candidate-receipt.json", receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--game", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--stage-development", action="store_true",
                        help="Stage the verified archive in the project's development input directory, not the game")
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    output = args.output or args.project / "runtime" / "verification" / (
        "ambient-johnny-driver-guard-" + stamp + "-" + uuid.uuid4().hex[:8])
    result = build(args.project, args.game, output)
    if args.stage_development:
        staged = args.project.resolve() / "runtime/ambient-driver-guard/package" / (ARCHIVE_NAME + ".archive")
        if not staged.resolve().is_relative_to(args.project.resolve() / "runtime"):
            raise ValueError("Development stage escaped the project runtime")
        data = Path(result["archive"]).read_bytes()
        if sha256(data) != result["archiveSha256"]:
            raise ValueError("Verified candidate changed before staging")
        staged.parent.mkdir(parents=True, exist_ok=True)
        temporary = staged.with_name(staged.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            temporary.write_bytes(data)
            if sha256(temporary.read_bytes()) != result["archiveSha256"]:
                raise ValueError("Development staging verification failed")
            os.replace(temporary, staged)
        finally:
            if temporary.exists():
                temporary.unlink()
        result["developmentStage"] = str(staged)
        write_json(output / "candidate-receipt.json", result)
    print(json.dumps({"archive": result["archive"], "bytes": result["archiveBytes"],
                      "sha256": result["archiveSha256"],
                      "receipt": str(output / "candidate-receipt.json"),
                      "developmentStage": result.get("developmentStage"),
                      "qualification": result["qualification"]}), flush=True)


if __name__ == "__main__":
    main()
