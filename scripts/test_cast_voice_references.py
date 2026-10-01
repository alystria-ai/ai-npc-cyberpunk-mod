"""Offline native-casting boundaries, immutable PCM and real OS-lock tests."""
from __future__ import annotations
import copy
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("Cast-VoiceReferenceCandidates.py")
spec = importlib.util.spec_from_file_location("cast", SCRIPT)
cast = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cast)


def encoded_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def archive(path, entries):
    index_size = 28 + len(entries) * (56 + 16)
    payload_offset = 20 + index_size
    header = struct.pack("<4sIQI", b"RDAR", 12, 20, index_size)
    directory = struct.pack("<IIQIII", 0, 0, 0, len(entries), len(entries), 0)
    payload, entry_table, segment_table = b"", b"", b""
    for i, (depot, data) in enumerate(entries):
        entry_table += struct.pack("<QqIIIII20s", cast.extract.depot_hash(depot), 0, 0, i, i + 1, 0, 0, hashlib.sha1(data).digest())
        segment_table += struct.pack("<QII", payload_offset + len(payload), len(data), len(data))
        payload += data
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + directory + entry_table + segment_table + payload)


def subtitle_bytes(text, string_id=9):
    names = ["None", "localizationPersistenceSubtitleEntries", "stringId", "CRUID", "femaleVariant", "maleVariant", "String"]
    strings, offsets = b"", []
    for name in names:
        offsets.append(len(strings)); strings += name.encode() + b"\0"
    string_offset = 64
    names_offset = string_offset + len(strings)
    data = bytearray(64)
    data[:8] = struct.pack("<4sI", b"CR2W", 195)
    struct.pack_into("<III", data, 40, string_offset, len(strings), 0)
    struct.pack_into("<III", data, 52, names_offset, len(names), 0)
    data.extend(strings)
    data.extend(b"".join(struct.pack("<II", x, 0) for x in offsets))
    data.extend(struct.pack("<HHIQ", 2, 3, 12, string_id))
    for variant in (4, 5):
        encoded = text.encode()
        assert len(encoded) < 64
        payload = bytes([len(encoded) | 0x80]) + encoded
        data.extend(struct.pack("<HHI", variant, 6, len(payload) + 4) + payload)
    data.extend(b"\0\0")
    return bytes(data)


class Fixture:
    def __init__(self, project):
        self.project = project
        self.game = project.parent / (project.name + "-game")
        self.text = "A complete ordinary spoken test line."
        self.raw = b"CR2W native fixture payload"
        self.scene_path = "base\\quest\\test.scene"
        self.wem_path = "base\\localization\\en-us\\vo\\different_actor_prefix_f_0000000000000009.wem"
        self.subtitle_path = "base\\localization\\en-us\\subtitles\\test.json"
        self.wem = b"RIFF" + struct.pack("<I", 4) + b"WAVE"
        self.subtitle = subtitle_bytes(self.text)
        self.raw_path = project / "evidence/source.scene"
        self.raw_path.parent.mkdir(parents=True)
        self.raw_path.write_bytes(self.raw)
        self.doc = {"Header": {"ArchiveFileName": str(self.raw_path)}, "Data": {"RootChunk": {
            "actors": [{"$type": "scnActorDef", "actorId": {"id": 0}, "actorName": "8ug8ear", "voicetagId": {"id": "17"}}],
            "screenplayStore": {"lines": [{"$type": "scnscreenplayDialogLine", "speaker": {"id": 0}, "itemId": {"id": 2}, "locstringId": {"ruid": "9"}}]},
            "sceneGraph": {"Data": {"events": [{"$type": "scnDialogLineEvent", "screenplayLineId": {"id": 2}, "voParams": {"voExpression": "Vo_Expression_Spoken", "isHolocallSpeaker": 0}}]}},
            "locStore": {"vdEntries": [{"localeId": "en_us", "locstringId": {"ruid": "9"}, "vpeIndex": 0, "variantId": {"ruid": "31"}}],
                         "vpEntries": [{"variantId": {"ruid": "31"}, "content": self.text}]}}}}
        encoded_json(project / "evidence/source.scene.json", self.doc)
        self.roster = [{"key": "8ug8ear", "name": "8ug8ear", "aliases": ["8ug8ear"], "records": ["Character.bugbear"]}]
        encoded_json(project / "characters/roster.json", self.roster)
        roster_hash = cast.digest(project / "characters/roster.json")
        encoded_json(project / "inventory.json", {"summary": {"rosterSha256": roster_hash}, "characters": self.roster})
        self.lanes_path = project / "runtime/voice-cast-inventory-20261001/casting-lanes.json"
        encoded_json(self.lanes_path, {"lanes": [{"name": "test-lane", "keys": ["8ug8ear"], "mode": "metadata_then_bounded_decode"}]})
        self.scene = {"manifestPath": "evidence/inventory.json", "depotPath": self.scene_path,
                      "archive": cast.SCENE_ARCHIVES[0], "entrySha1": hashlib.sha1(self.raw).hexdigest(),
                      "rawPath": "evidence/source.scene", "rawSha256": cast.digest(self.raw_path),
                      "jsonPath": "evidence/source.scene.json", "jsonSha256": cast.digest(project / "evidence/source.scene.json")}
        encoded_json(project / "evidence/inventory.json", {"assets": [{"winner": True, "depotPath": self.scene_path,
           "archivePath": self.scene["archive"], "archiveEntrySha1": self.scene["entrySha1"], "assetSha256": self.scene["rawSha256"],
           "rawPath": "source.scene", "jsonPath": "source.scene.json"}, {"winner": True, "depotPath": "base\\unrelated.quest"}]})
        self.candidate = {"key": "8ug8ear", "stringId": "9", "wemPath": self.wem_path, "genderVariant": "female", "scene": self.scene,
          "actor": {"pointer": "/Data/RootChunk/actors/0", "id": "0", "name": "8ug8ear", "voicetagId": "17", "identityProof": {"kind": "exact_actor", "canonicalKey": "8ug8ear"}},
          "line": {"pointer": "/Data/RootChunk/screenplayStore/lines/0", "itemId": "2", "speakerId": "0", "locstringId": "9"},
          "event": {"pointer": "/Data/RootChunk/sceneGraph/Data/events/0"},
          "english": {"descriptorPointer": "/Data/RootChunk/locStore/vdEntries/0", "payloadPointer": "/Data/RootChunk/locStore/vpEntries/0",
                      "variant": "femaleVariant", "transcript": self.text, "transcriptSha256": hashlib.sha256(self.text.encode()).hexdigest()}}
        self.tools = []
        self.pinned = {}
        for name in ("vgmstream-cli", "ffprobe"):
            tool = project / (name + ".exe"); tool.write_bytes(name.encode())
            sha = cast.digest(tool)
            self.tools.append({"name": name, "path": str(tool), "version": "fixture", "sha256": sha})
            self.pinned[name] = (str(tool), sha)
        cli = project / "vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe"
        cli.parent.mkdir(parents=True); cli.write_bytes(b"serializer fixture")
        self.cli_hash = cast.digest(cli)
        db_path = project / "lookup.sqlite3"
        with closing(sqlite3.connect(db_path)) as db:
            db.execute("CREATE TABLE entries(domain TEXT, entry_id TEXT, source_json TEXT)")
            self.subtitle_row = {"id": "9", "domain": "subtitle.stringId", "femaleVariant": self.text, "maleVariant": self.text,
                 "jsonPointer": "/Data/RootChunk/entries/0", "source": {"depotPath": self.subtitle_path,
                     "archivePath": cast.TEXT_ARCHIVES[0], "archiveEntrySha1": hashlib.sha1(self.subtitle).hexdigest(), "assetSha256": hashlib.sha256(self.subtitle).hexdigest()}}
            db.execute("INSERT INTO entries VALUES(?,?,?)", ("subtitle.stringId", "9", json.dumps(self.subtitle_row)))
            db.commit()
        for path, rows in ((cast.VOICE_ARCHIVES[0], [(self.wem_path, self.wem)]), (cast.TEXT_ARCHIVES[0], [(self.subtitle_path, self.subtitle)]),
                           (cast.SCENE_ARCHIVES[0], [(self.scene_path, self.raw)])):
            archive(self.game / path, rows)
        self.manifest = {"schemaVersion": 1, "lane": "test-lane", "rosterInventory": "inventory.json",
                         "laneInventory": self.lanes_path.relative_to(project).as_posix(), "rosterSha256": roster_hash,
                         "gameRoot": str(self.game), "subtitleIndex": "lookup.sqlite3", "tools": self.tools,
                         "candidates": [self.candidate]}
        self.input = project / "candidates.json"
        self.save()

    def save(self): encoded_json(self.input, self.manifest)

    def serializer(self, arguments, **kwargs):
        raw = Path(arguments[-1])
        document = copy.deepcopy(self.doc)
        document["Header"]["ArchiveFileName"] = str(raw)
        encoded_json(raw.with_suffix(".scene.json"), document)
        return subprocess.CompletedProcess(arguments, 0, b"", b"")

    def decode(self, arguments):
        if "-o" in arguments:
            with wave.open(str(arguments[arguments.index("-o") + 1]), "wb") as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
                wav.writeframes(struct.pack("<h", 200) * 64000)
            return subprocess.CompletedProcess(arguments, 0, "fixture decode", "")
        return subprocess.CompletedProcess(arguments, 0, json.dumps({"streams": [{"codec_type": "audio", "codec_name": "pcm_s16le", "sample_rate": "16000", "channels": 1,
                "bits_per_sample": 16, "duration_ts": 64000, "time_base": "1/16000"}], "format": {"duration": "4"}}), "")


class CastingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name) / "project"; self.project.mkdir()
        self.f = Fixture(self.project)
        self.patches = [patch.object(cast, "PINNED_TOOLS", self.f.pinned), patch.object(cast, "WOLVENKIT_SHA256", self.f.cli_hash)]
        for p in self.patches: p.start()

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()

    def run_cast(self, **kwargs):
        self.f.save()
        return cast.run(self.f.input, self.project, **kwargs)

    def test_numeric_key_and_prefix_is_not_proof(self):
        result = self.run_cast()
        self.assertEqual(result["candidates"][0]["key"], "8ug8ear")
        self.f.candidate["actor"]["name"] = "An unrelated speaker"
        with self.assertRaisesRegex(ValueError, "joins"): self.run_cast()

    def test_native_delivery_requires_explicit_exact_qualification(self):
        event = {"voParams": {"isHolocallSpeaker": 1, "voExpression": "Vo_Expression_Phone",
                              "customVoEvent": {"$value": "vo_q305_bunker_screen"}}}
        with self.assertRaisesRegex(ValueError, "sourceDelivery"):
            cast.source_delivery(event)
        delivery = {"kind": "canonical-custom-performance", "isHolocallSpeaker": True,
                    "voExpression": "Vo_Expression_Phone", "customVoEvent": "vo_q305_bunker_screen",
                    "waveformProcessingAssessed": False, "reason": "Authentic distress recording; native delivery retained."}
        self.assertEqual(cast.source_delivery(event, delivery), delivery)
        for field, value in (("kind", "ordinary-spoken"), ("isHolocallSpeaker", False),
                             ("customVoEvent", "None"), ("waveformProcessingAssessed", True)):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "sourceDelivery"):
                cast.source_delivery(event, {**delivery, field: value})

    def test_ordinary_delivery_does_not_invent_audible_cleanliness(self):
        result = self.run_cast()["candidates"][0]["nativeReceipt"]["sourceDelivery"]
        self.assertEqual(result["kind"], "ordinary-spoken")
        self.assertFalse(result["waveformProcessingAssessed"])
        self.assertNotIn("cleanIntelligible", result)

    def test_reviewed_source_scope_cannot_transfer_to_another_actor_or_scene(self):
        proof = self.f.candidate['actor']['identityProof']
        proof['sourceScope'] = {'actorPointer': self.f.candidate['actor']['pointer'], 'nativeVoice': '17',
                               'sceneRawSha256': self.f.scene['rawSha256'], 'sceneJsonSha256': self.f.scene['jsonSha256']}
        self.run_cast()
        proof['sourceScope']['sceneJsonSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'source scope'):
            self.run_cast()

    def test_path_escape_and_cross_lane(self):
        for path in (self.project.parent / "escape", self.project / "runtime/voice-cast/other-lane", self.project / "runtime/voice-cast/test-lane/child"):
            with self.assertRaises(ValueError): self.run_cast(output=path)
        self.f.candidate["scene"]["rawPath"] = "../escape.scene"
        with self.assertRaises(ValueError): self.run_cast()

    def test_native_hash_and_join_failures(self):
        modifications = [("actor", "id", "1"), ("line", "speakerId", "3"), ("line", "itemId", "4"),
                         ("line", "locstringId", "10"), ("scene", "jsonSha256", "0" * 64),
                         ("english", "transcriptSha256", "0" * 64), ("english", "variant", "maleVariant"),
                         ("english", "descriptorPointer", "/Data/RootChunk/locStore/vdEntries/-1")]
        original = copy.deepcopy(self.f.candidate)
        for section, field, value in modifications:
            with self.subTest(field=field):
                self.f.manifest["candidates"] = [copy.deepcopy(original)]
                self.f.manifest["candidates"][0][section][field] = value
                with self.assertRaises(ValueError): self.run_cast()

    def test_gender_resource_marker_is_required(self):
        self.f.candidate["wemPath"] = self.f.wem_path.replace("_f_", "_m_")
        with self.assertRaisesRegex(ValueError, "gender"): self.run_cast()

    def test_canonical_roster_is_rehashed(self):
        encoded_json(self.project / "characters/roster.json", [{**self.f.roster[0], "name": "Wrong"}])
        with self.assertRaisesRegex(ValueError, "canonical identity"): self.run_cast()

    def test_prompt_only_edits_preserve_canonical_identity(self):
        before = self.run_cast()
        changed = [{**self.f.roster[0], "backstory": "Corrected prose only.",
                    "speakingStyleDescription": "Speak naturally.", "speakingStyleSampleDialogues": "An original sample."}]
        encoded_json(self.project / "characters/roster.json", changed)
        after = self.run_cast()
        self.assertEqual(before["identitySha256"], after["identitySha256"])
        self.assertEqual(after["historicalRosterSha256"], self.f.manifest["rosterSha256"])
        self.assertNotEqual(after["currentRosterSha256"], after["historicalRosterSha256"])
        self.assertEqual(after["currentRosterSha256"], cast.digest(self.project / "characters/roster.json"))
        self.assertTrue(after["fullRosterHashChanged"])
        self.assertTrue(after["canonicalIdentityVerified"])

    def test_each_current_identity_dimension_still_fails(self):
        for field, value in (("name", "Another person"), ("aliases", ["SomeoneElse"]),
                             ("records", ["Character.someone_else"]), ("key", "different-key")):
            with self.subTest(field=field):
                encoded_json(self.project / "characters/roster.json", [{**self.f.roster[0], field: value, "backstory": "New prose"}])
                with self.assertRaisesRegex(ValueError, "canonical identity"): self.run_cast()

    def test_spoofed_inventory_cannot_reassign_actor_or_record(self):
        for field, value in (("name", "Forged actor"), ("aliases", ["ForgedAlias"]),
                             ("records", ["Character.unrelated"]), ("key", "wrong-key")):
            with self.subTest(field=field):
                encoded_json(self.project / "inventory.json", {"summary": {"rosterSha256": self.f.manifest["rosterSha256"]},
                             "characters": [{**self.f.roster[0], field: value}]})
                with self.assertRaisesRegex(ValueError, "canonical identity"): self.run_cast()

    def test_historical_hash_and_claimed_identity_hash_still_checked(self):
        encoded_json(self.project / "inventory.json", {"summary": {"rosterSha256": "0" * 64}, "characters": self.f.roster})
        with self.assertRaisesRegex(ValueError, "Historical"): self.run_cast()
        encoded_json(self.project / "inventory.json", {"summary": {"rosterSha256": self.f.manifest["rosterSha256"], "identitySha256": "0" * 64},
                     "characters": self.f.roster})
        with self.assertRaisesRegex(ValueError, "fingerprint"): self.run_cast()

    def test_duplicate_identity_keys_rejected(self):
        encoded_json(self.project / "inventory.json", {"summary": {"rosterSha256": self.f.manifest["rosterSha256"]},
                     "characters": [*self.f.roster, *self.f.roster]})
        with self.assertRaisesRegex(ValueError, "duplicate"): self.run_cast()

    def test_identity_fingerprint_is_stable_but_lists_remain_exact(self):
        rows = [*self.f.roster, {"key": "another", "name": "Another", "aliases": ["One", "Two"], "records": []}]
        self.assertEqual(cast.identity_sha256(rows), cast.identity_sha256(list(reversed(rows))))
        reordered_aliases = [rows[0], {**rows[1], "aliases": ["Two", "One"]}]
        self.assertNotEqual(cast.identity_sha256(rows), cast.identity_sha256(reordered_aliases))

    def test_prompt_only_resume_reuses_original_audio_and_receipt(self):
        calls = []
        def decode(arguments):
            calls.append(arguments)
            return self.f.decode(arguments)
        with patch.object(cast.subprocess, "run", self.f.serializer), patch.object(cast.extract, "hidden_run", decode):
            first = self.run_cast(dry_run=False)
            reference = self.project / first["candidates"][0]["reference"]
            original_audio_sha = cast.digest(reference)
            original_receipt_sha = cast.digest(reference.parent / "receipt.json")
            decode_count = len(calls)
            encoded_json(self.project / "characters/roster.json", [{**self.f.roster[0], "backstory": "Changed only dialogue guidance."}])
            second = self.run_cast(dry_run=False)
        self.assertEqual(len(calls), decode_count)
        self.assertEqual(original_audio_sha, cast.digest(reference))
        self.assertEqual(original_receipt_sha, cast.digest(reference.parent / "receipt.json"))
        self.assertEqual(second["candidates"][0]["validationReceipt"]["currentRosterSha256"], second["currentRosterSha256"])
        self.assertEqual(second["candidates"][0]["provenance"]["historicalRosterSha256"], first["historicalRosterSha256"])

    def test_candidate_limits(self):
        self.f.manifest["candidates"] = [copy.deepcopy(self.f.candidate)] * 49
        with self.assertRaisesRegex(ValueError, "1..48"): self.run_cast()
        self.f.manifest["candidates"] = [copy.deepcopy(self.f.candidate)] * 7
        with self.assertRaises(ValueError): self.run_cast()

    def test_missing_and_conflicting_subtitle(self):
        with closing(sqlite3.connect(self.project / "lookup.sqlite3")) as db:
            db.execute("UPDATE entries SET source_json=?", (json.dumps({**self.f.subtitle_row, "femaleVariant": "Wrong transcript"}),))
            db.commit()
        with self.assertRaisesRegex(ValueError, "conflict"): self.run_cast()
        with closing(sqlite3.connect(self.project / "lookup.sqlite3")) as db:
            db.execute("DELETE FROM entries"); db.commit()
        with self.assertRaisesRegex(ValueError, "absent"): self.run_cast()

    def test_dryrun_has_no_side_effects_or_subprocess(self):
        before = {str(p.relative_to(self.project)): cast.digest(p) for p in self.project.rglob("*") if p.is_file()}
        with patch.object(cast.extract, "hidden_run", side_effect=AssertionError("No subprocess")), patch.object(cast, "CpuSlots", side_effect=AssertionError("No lock")):
            cast.run(self.f.input, self.project)
        after = {str(p.relative_to(self.project)): cast.digest(p) for p in self.project.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.assertFalse((self.project / "runtime/voice-cast").exists())

    def test_decode_original_pcm_and_resume(self):
        with patch.object(cast.subprocess, "run", self.f.serializer), patch.object(cast.extract, "hidden_run", self.f.decode):
            result = self.run_cast(dry_run=False)
            reference = self.project / result["candidates"][0]["reference"]
            sha = cast.digest(reference)
            resumed = self.run_cast(dry_run=False)
        self.assertEqual(len(resumed["candidates"]), 1)
        self.assertEqual(sha, cast.digest(reference))
        self.assertTrue(resumed["candidates"][0]["provenance"]["nativeActor"]["serializationVerification"]["verified"])
        self.assertFalse(resumed["candidates"][0]["listeningVerified"])

    def test_decode_failure_staging_released(self):
        with patch.object(cast.subprocess, "run", self.f.serializer), patch.object(cast.extract, "hidden_run", side_effect=RuntimeError("Decoder failed")):
            with self.assertRaisesRegex(RuntimeError, "Decoder failed"): self.run_cast(dry_run=False)
        root = self.project / "runtime/voice-cast/test-lane"
        self.assertFalse(list(root.rglob("*.wav")))
        self.assertFalse(list(root.rglob("*.wem")))
        with cast.CpuSlots(self.project, timeout=0), cast.CpuSlots(self.project, timeout=0): pass

    def test_fabricated_json_cannot_pass_native_parser(self):
        self.f.doc["Data"]["RootChunk"]["actors"][0]["actorName"] = "NativeDifferent"
        with patch.object(cast.subprocess, "run", self.f.serializer), patch.object(cast.extract, "hidden_run", self.f.decode):
            with self.assertRaisesRegex(ValueError, "serialization"): self.run_cast(dry_run=False)

    def test_kernel_cpu_limit_and_exception_release(self):
        with cast.CpuSlots(self.project, timeout=0), cast.CpuSlots(self.project, timeout=0):
            with self.assertRaises(TimeoutError):
                with cast.CpuSlots(self.project, timeout=.03, poll=.01): pass
        try:
            with cast.CpuSlots(self.project, timeout=0): raise RuntimeError("release")
        except RuntimeError: pass
        with cast.CpuSlots(self.project, timeout=0), cast.CpuSlots(self.project, timeout=0): pass

    def test_subprocess_death_releases_real_lock(self):
        code = "import importlib.util,sys;from pathlib import Path;sys.dont_write_bytecode=True;s=importlib.util.spec_from_file_location('c',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);a=m.CpuSlots(Path(sys.argv[2]),timeout=0);b=m.CpuSlots(Path(sys.argv[2]),timeout=0);a.__enter__();b.__enter__();print('locked',flush=True);sys.stdin.readline()"
        child = subprocess.Popen([sys.executable, "-B", "-c", code, str(SCRIPT), str(self.project)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "locked")
            with self.assertRaises(TimeoutError):
                with cast.CpuSlots(self.project, timeout=.03, poll=.01): pass
        finally:
            child.kill(); child.wait(timeout=5); child.stdout.close(); child.stdin.close()
        with cast.CpuSlots(self.project, timeout=0), cast.CpuSlots(self.project, timeout=0): pass

    def test_lane_output_lock_exclusive(self):
        with cast.LaneLock(self.project, "test-lane", timeout=0):
            with self.assertRaises(TimeoutError):
                with cast.LaneLock(self.project, "test-lane", timeout=.03): pass
            with cast.LaneLock(self.project, "other-lane", timeout=0): pass

    def test_ffprobe_must_match_original_pcm_frames(self):
        quality = {"sampleRate": 16000, "channels": 1, "bitsPerSample": 16, "frames": 64000}
        probe = {"streams": [{"codec_type": "audio", "codec_name": "pcm_s16le", "sample_rate": "16000", "channels": 1,
                            "bits_per_sample": 16, "duration_ts": 64001, "time_base": "1/16000"}]}
        with self.assertRaisesRegex(ValueError, "disagree"): cast.verify_probe(probe, quality)

    def test_transient_directory_publication_retry(self):
        stage = self.project / "stage"; stage.mkdir()
        destination = self.project / "complete"
        original = Path.rename
        attempts = []
        def rename(path, target):
            attempts.append(path)
            if len(attempts) < 3: raise PermissionError("Transient handle")
            return original(path, target)
        with patch.object(Path, "rename", rename): cast.publish_directory(stage, destination, timeout=1)
        self.assertTrue(destination.is_dir())
        self.assertEqual(len(attempts), 3)

    def test_directory_publication_failure_bounded(self):
        stage = self.project / "stage"; stage.mkdir()
        with patch.object(Path, "rename", side_effect=PermissionError("Busy")):
            with self.assertRaises(PermissionError): cast.publish_directory(stage, self.project / "complete", timeout=.03)

    def test_source_proven_tweakdbid_vectors(self):
        for record, value in (("Character.Saul", 63242755000), ("Character.Silverhand", 85903861324),
                              ("Character.Evelyn", 70856865783), ("Character.Judy", 63110975482)):
            self.assertEqual(cast.tweakdbid(record), value)
        self.assertNotEqual(cast.tweakdbid("Character.Judy"), cast.tweakdbid("character.judy"))
        for malformed in ("", "Character.Judý", "x" * 256):
            with self.assertRaises(ValueError): cast.tweakdbid(malformed)

    def test_numeric_tweakdbid_identity_preserves_runtime_offset(self):
        record = "Character.bugbear"
        identity = cast.tweakdbid(record)
        native = {"$type": "TweakDBID", "$storage": "uint64", "$value": str(identity | (0x123456 << 40))}
        receipt = cast.canonical_record(native, [record])
        self.assertEqual(receipt["record"], record)
        self.assertEqual(receipt["runtimeOffsetBits"], str(0x123456))
        self.assertEqual(receipt["observedUint64"], native["$value"])
        self.assertEqual(receipt["identity"], str(identity))
        for value in ("0", str(cast.tweakdbid("Character.other")), "-1"):
            with self.assertRaises(ValueError): cast.canonical_record({**native, "$value": value}, [record])

    def test_direct_actor_record_must_be_active_and_same_actor(self):
        actor = {"actorName": "Generic", "acquisitionPlan": "spawnDespawn", "spawnDespawnParams": {
                 "specRecordId": {"$type": "TweakDBID", "$storage": "uint64", "$value": str(cast.tweakdbid("Character.bugbear"))}}}
        document = {"Data": {"RootChunk": {"actors": [actor]}}}
        proof = {"kind": "direct_actor_record", "canonicalKey": "8ug8ear",
                 "recordPointer": "/Data/RootChunk/actors/0/spawnDespawnParams/specRecordId"}
        result = cast.validate_identity(actor, proof, self.f.roster[0], document, self.project, actor_pointer="/Data/RootChunk/actors/0")
        self.assertEqual(result["record"], "Character.bugbear")
        with self.assertRaises(ValueError):
            cast.validate_identity(actor, {**proof, "recordPointer": proof["recordPointer"].replace("actors/0", "actors/1")},
                                   self.f.roster[0], document, self.project, actor_pointer="/Data/RootChunk/actors/0")
        actor["acquisitionPlan"] = "community"
        with self.assertRaises(ValueError):
            cast.validate_identity(actor, proof, self.f.roster[0], document, self.project, actor_pointer="/Data/RootChunk/actors/0")

    def test_typed_community_entry_does_not_invent_world_binding(self):
        raw = self.project / "evidence/community.community"; raw.write_bytes(b"CR2W community fixture")
        json_path = raw.with_name(raw.name + ".json")
        document = {"Header": {"ArchiveFileName": str(raw)}, "Data": {"RootChunk": {"$type": "communityCommunityTemplate",
          "communityTemplate": {"Data": {"$type": "communityCommunityTemplateData", "entries": [{"Data": {"$type": "communitySpawnEntry",
            "entryName": {"$type": "CName", "$storage": "string", "$value": "target"},
            "characterRecordId": {"$type": "TweakDBID", "$storage": "uint64", "$value": str(cast.tweakdbid("Character.bugbear"))}}}]}}}}}
        encoded_json(json_path, document)
        source = {"manifestPath": "evidence/community-inventory.json", "depotPath": "base\\quest\\test.community",
                  "archive": cast.SCENE_ARCHIVES[0], "entrySha1": cast.digest(raw, "sha1"), "rawPath": raw.relative_to(self.project).as_posix(),
                  "rawSha256": cast.digest(raw), "jsonPath": json_path.relative_to(self.project).as_posix(), "jsonSha256": cast.digest(json_path)}
        encoded_json(self.project / source["manifestPath"], {"assets": [{"winner": True, "depotPath": source["depotPath"],
           "archivePath": source["archive"], "archiveEntrySha1": source["entrySha1"], "assetSha256": source["rawSha256"],
           "rawPath": "community.community", "jsonPath": "community.community.json"}]})
        ptr = "/Data/RootChunk/communityTemplate/Data/entries/0/Data"
        result = cast.community_entry_receipt(source, ptr, self.f.roster[0], self.project, "target")
        self.assertTrue(result["communityEntryRecordVerified"])
        self.assertFalse(result["bindingVerified"])
        self.assertFalse(result["attributionVerified"])
        self.assertEqual(result["canonicalRecord"]["record"], "Character.bugbear")
        with self.assertRaisesRegex(ValueError, "does not match"):
            cast.community_entry_receipt(source, ptr, self.f.roster[0], self.project, "other-target")


if __name__ == "__main__": unittest.main()
