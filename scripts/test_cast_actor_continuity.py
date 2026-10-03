"""Actual native identity fixtures and bounded decoder/authentication seams.

Native parser execution is evidenced separately by ACTUAL_SOURCE_FREEZE.json.
The decoder seam tests use callbacks and temporary synthetic cached media; they
do not run an audio decoder or modify any original reference/receipt.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
PROJECT = Path(__file__).resolve().parents[1]
ACTUAL = PROJECT / "runtime/voice-data-expansion-20261003/identity-continuity/production-source-freeze-27b7e1d42a8b/ACTUAL_SOURCE_FREEZE.json"
OLD_PATH = PROJECT / "runtime/voice-data-expansion-20261003/source-admission-review/prototype/Cast-Identity-Snapshot.py"


def module_at(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cast = module_at("cast_actor_continuity", PROJECT / "scripts/Cast-VoiceReferenceCandidates.py")
old = module_at("cast_actor_before_continuity", OLD_PATH)


class ActorContinuityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proof_freeze = cast.read_json(ACTUAL)
        cls.proofs = cls.proof_freeze["proposals"]
        cls.roster = next(row for row in cast.read_json(PROJECT / "characters/roster.json") if row["key"] == "pepe-najarro")
        cls.review = cast.read_json(PROJECT / "runtime/voice-data-expansion-20261003/lanes/minor-quests-a/pepe-identity-continuity-01.json")

    def fixture(self, index=0):
        proof = copy.deepcopy(self.proofs[index]["proof"])
        target = proof["continuity"]["target"]
        document = cast.validate_native_source(target["scene"], PROJECT)
        actor = cast.pointer(document, target["actorPointer"])
        return proof, target["scene"], document, actor, target["actorPointer"]

    def validate(self, fixture):
        proof, source, document, actor, pointer = fixture
        return cast.validate_identity(actor, proof, self.roster, document, PROJECT, source, pointer)

    def wrong_voice(self):
        fixture = self.fixture(2)
        proof, source, document, _, _ = fixture
        pointer = self.review["rejects"][0]["actorPointer"]
        actor = cast.pointer(document, pointer)
        target = proof["continuity"]["target"]
        target.update(actorPointer=pointer, actorName=actor["actorName"], nativeVoice=cast.ident(actor["voicetagId"]["id"]),
                      activeAcquisitionPointer=pointer + "/spawnSetParams", activeAcquisition=copy.deepcopy(actor["spawnSetParams"]))
        target["review"]["sourceScope"] = cast._continuity_scope(source, actor, pointer)
        proof.update(actorName=actor["actorName"], sourceScope=copy.deepcopy(target["review"]["sourceScope"]))
        return proof, source, document, actor, pointer

    def test_actual_bartender_fallback_fails_before_and_is_closed_now(self):
        self.assertEqual(cast.digest(OLD_PATH), "a1416398b45fd9cf11aad40eb7931fd241c6f933dcac1de8dffdb378e6503b1b")
        proof, source, document, actor, pointer = self.wrong_voice()
        weak = {"kind": "reviewed_actor_alias", "canonicalKey": self.roster["key"], "actorName": actor["actorName"],
                "reviewer": "source-scoped test review", "reason": "A reviewer cannot authorize a generic bartender alias alone.",
                "sourceScope": proof["sourceScope"]}
        self.assertIsNone(old.validate_identity(actor, weak, self.roster, document, PROJECT, source, pointer))
        with self.assertRaisesRegex(ValueError, "Generic actors require native"):
            cast.validate_identity(actor, weak, self.roster, document, PROJECT, source, pointer)
        with self.assertRaisesRegex(ValueError, "different native voice"):
            self.validate((proof, source, document, actor, pointer))

    def test_three_real_aliases_and_legitimate_legacy_bartender_pass_strong_metadata(self):
        for index in range(4):
            with self.subTest(index=index):
                result = self.validate(self.fixture(index))
                self.assertTrue(result["acquisitionContinuityVerified"])
                self.assertEqual(result["nativeVoice"], "1624173162027037464")
                self.assertFalse(result["canonicalRecordEdgeVerified"])
                self.assertFalse(result["freshSerializationAuthenticated"])
        legacy = self.proofs[3]
        self.assertEqual({row["stringId"] for row in legacy["legacyRows"]}, {"1926933095683911680", "1912893701184483328"})
        for row in legacy["legacyRows"]:
            self.assertEqual(cast.digest(PROJECT / row["originalNativeReceiptPath"]), row["originalNativeReceiptSha256"])

    def test_real_current_winner_and_parser_evidence_remains_separate_from_metadata(self):
        self.assertEqual(self.proof_freeze["sourcesFreshAuthenticated"], 5)
        self.assertTrue(self.proof_freeze["actualCpuSlotLease"])
        self.assertEqual(self.proof_freeze["wemReads"], 0)
        for proposal in self.proofs:
            self.assertFalse(proposal["metadataVerification"]["freshSerializationAuthenticated"])
            for role in ("anchor", "target"):
                fresh = proposal["actualSourceAuthentication"][role]
                self.assertTrue(fresh["currentInstalledWinnerAuthenticated"])
                self.assertTrue(fresh["freshSerializationAuthenticated"])
                self.assertEqual(fresh["serializationVerification"], proposal["proof"]["continuity"][role]["serializationVerification"])

    def test_frozen_manifest_and_scope_changes_are_rejected(self):
        for role in ("anchor", "target"):
            proof, *tail = self.fixture()
            proof["continuity"][role]["manifestSha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "source manifest hash mismatch"):
                self.validate((proof, *tail))
            proof, *tail = self.fixture()
            proof["continuity"][role]["review"]["sourceScope"]["actorPointer"] = "/Data/RootChunk/actors/99"
            with self.assertRaisesRegex(ValueError, "own reviewer"):
                self.validate((proof, *tail))

    def test_authentication_refuses_no_cpu_lease_before_any_callback(self):
        proof = self.fixture()[0]
        with patch.object(cast, "verify_live_scene") as winner, patch.object(cast, "authenticate_serialization") as parser, \
                self.assertRaisesRegex(RuntimeError, "CPU slot lease"):
            cast.authenticate_native_continuity(proof, PROJECT, ACTUAL.parent, [], {})
        winner.assert_not_called(); parser.assert_not_called()

    def test_actual_sources_are_rechecked_under_lease_and_both_callbacks_run(self):
        proof = self.fixture()[0]
        calls = []
        def winner(source, archives):
            self.assertTrue(cast.CpuSlots.held_by_this_process())
            calls.append(("winner", source["depotPath"]))
        def parser(source, *args):
            self.assertTrue(cast.CpuSlots.held_by_this_process())
            calls.append(("parser", source["depotPath"]))
            return next(proof["continuity"][role]["serializationVerification"] for role in ("anchor", "target")
                        if proof["continuity"][role]["scene"] == source)
        with cast.CpuSlots(PROJECT, timeout=1), patch.object(cast, "verify_live_scene", side_effect=winner), \
                patch.object(cast, "authenticate_serialization", side_effect=parser):
            result = cast.authenticate_native_continuity(proof, PROJECT, ACTUAL.parent, [], {})
            self.assertEqual(set(result), {"anchor", "target"})
        self.assertEqual([kind for kind, _ in calls], ["winner", "parser", "winner", "parser"])
        self.assertFalse(cast.CpuSlots.held_by_this_process())

    def decoder_fixture(self, out):
        proof, source, document, actor, pointer = self.fixture()
        event = {"voParams": {"voExpression": "Vo_Expression_Spoken", "isHolocallSpeaker": 0,
                             "customVoEvent": {"$type": "CName", "$storage": "string", "$value": "None"}}}
        native = {"scene": source, "actor": {"identityVerification": self.validate((proof, source, document, actor, pointer))},
                  "event": event, "sourceDelivery": cast.source_delivery(event, None)}
        candidate = {"key": "pepe-najarro", "stringId": "999", "genderVariant": "female", "scene": source,
                     "actor": {"identityProof": proof}, "nativeReceipt": native,
                     "wemPath": "base\\localization\\en-us\\vo\\fixture_f_00000000000003e7.wem",
                     "subtitleRows": [], "english": {"transcript": "Immutable cached test sentence."}}
        wem = b"RIFF" + struct.pack("<I", 4) + b"WAVE"
        directory = out / "pepe-najarro/999-female"
        directory.mkdir(parents=True)
        (directory / "source.wem").write_bytes(wem)
        (directory / "reference.wav").write_bytes(b"unchanged cached PCM fixture")
        (directory / "transcript.txt").write_text(candidate["english"]["transcript"] + "\n", encoding="utf-8")
        saved = {"key": candidate["key"], "stringId": "999", "transcript": candidate["english"]["transcript"],
                 "sha256": cast.digest(directory / "reference.wav"), "attributionVerified": True,
                 "provenance": {"nativeActor": {"scene": source}, "nativeLine": {"event": event},
                                "sourceDelivery": native["sourceDelivery"],
                                "audio": {"sha256": hashlib.sha256(wem).hexdigest(), "genderVariant": "female"}}}
        (directory / "receipt.json").write_text(json.dumps(saved), encoding="utf-8")
        return candidate, native, wem, directory

    def test_either_source_authentication_failure_prevents_wem_and_cached_return(self):
        for failing_role in ("anchor", "target"):
            with tempfile.TemporaryDirectory(dir=ACTUAL.parent) as temporary:
                out = Path(temporary)
                candidate, native, wem, directory = self.decoder_fixture(out)
                proof = candidate["actor"]["identityProof"]
                def parser(source, *args):
                    role = next(role for role in ("anchor", "target") if proof["continuity"][role]["scene"] == source)
                    return {} if role == failing_role else proof["continuity"][role]["serializationVerification"]
                originals = {p.name: p.read_bytes() for p in directory.iterdir()}
                with cast.CpuSlots(PROJECT, timeout=1), patch.object(cast, "validate_native", return_value=native), \
                        patch.object(cast, "verify_live_scene"), patch.object(cast, "authenticate_serialization", side_effect=parser), \
                        patch.object(cast, "winning") as winning, self.assertRaisesRegex(ValueError, "fresh parser output differs"):
                    cast.decode_candidate(candidate, {"pepe-najarro": self.roster}, PROJECT, out, ([], [], []), None, {},
                                          {"inputSha256": "a" * 64}, {}, PROJECT / "unused.sqlite3")
                winning.assert_not_called()
                self.assertEqual({p.name: p.read_bytes() for p in directory.iterdir()}, originals)

    def test_cached_return_requires_both_sources_and_appends_separate_evidence(self):
        with tempfile.TemporaryDirectory(dir=ACTUAL.parent) as temporary:
            out = Path(temporary)
            candidate, native, wem, directory = self.decoder_fixture(out)
            proof = candidate["actor"]["identityProof"]
            originals = {p.name: p.read_bytes() for p in directory.iterdir()}
            calls = []
            def parser(source, *args):
                role = next(role for role in ("anchor", "target") if proof["continuity"][role]["scene"] == source)
                calls.append(role)
                return proof["continuity"][role]["serializationVerification"]
            def winning(*args):
                self.assertEqual(calls, ["anchor", "target"])
                return wem, {"sha256": hashlib.sha256(wem).hexdigest()}
            with cast.CpuSlots(PROJECT, timeout=1), patch.object(cast, "validate_native", return_value=native), \
                    patch.object(cast, "verify_live_scene"), patch.object(cast, "authenticate_serialization", side_effect=parser), \
                    patch.object(cast, "winning", side_effect=winning), patch.object(cast.extract, "hidden_run") as decoded:
                returned = cast.decode_candidate(candidate, {"pepe-najarro": self.roster}, PROJECT, out, ([], [], []), None, {},
                                                 {"inputSha256": "a" * 64}, {}, PROJECT / "unused.sqlite3")
            decoded.assert_not_called()
            self.assertEqual({p.name: p.read_bytes() for p in directory.iterdir()}, originals)
            tag = returned["identityRevalidation"]
            self.assertEqual(cast.digest(PROJECT / tag["path"]), tag["sha256"])
            sidecar = cast.read_json(PROJECT / tag["path"])
            self.assertEqual(sidecar["originalCandidateReceiptSha256"], hashlib.sha256(originals["receipt.json"]).hexdigest())
            self.assertFalse(sidecar["canonicalRecordEdgeVerified"])
            self.assertFalse(sidecar["audioDecodedByThisValidation"])
            self.assertEqual(set(sidecar["sourceAuthentication"]), {"anchor", "target"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
