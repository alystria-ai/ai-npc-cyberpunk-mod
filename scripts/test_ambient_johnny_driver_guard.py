"""Focused structural safety checks for the ambient-only native asset builder."""
import copy
import importlib.util
import hashlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

_path = Path(__file__).with_name("Build-AmbientJohnnyDriverGuard.py")
_spec = importlib.util.spec_from_file_location("ambient_driver_guard", _path)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)


def reference(name):
    return {"$type": "gameEntityReference", "reference": {"$type": "NodeRef", "$value": name}}


def fixture():
    mount = {"$type": "questCharacterMount_ConditionType", "anyChild": 0,
             "anyParent": 0, "childIsPlayer": 1, "parentIsPlayer": 0,
             "condition": "OnMount", "role": "Invalid", "vehicleOrigin": "NotStolen",
             "vehicleType": "Car", "childRef": reference("#player"),
             "parentRef": reference("#mounted_vehicle")}
    player = {"HandleId": "3", "Data": {"$type": "questCharacterCondition",
              "type": {"HandleId": "4", "Data": mount}}}
    logical = {"$type": "questLogicalCondition", "operation": "AND",
               "conditions": [player, {"HandleId": "5", "Data": {"$type": "questCharacterCondition",
                 "type": {"HandleId": "6", "Data": {"$type": "questCharacterMount_ConditionType",
                 "anyChild": 1, "childIsPlayer": 0, "condition": "OnUnmount", "role": "Passenger"}}}}]}
    condition_node = {"HandleId": "2", "Data": {"$type": "questConditionNodeDefinition", "id": 67,
                       "condition": {"HandleId": "7", "Data": logical}}}
    return {"Header": {"ArchiveFileName": "source", "GameVersion": 2310}, "Data": {"Version": 195,
      "RootChunk": {"$type": "questQuestPhaseResource", "graph": {"HandleId": "0", "Data": {
        "nodes": [{"HandleId": "1", "Data": {"$type": "questPhaseNodeDefinition", "id": 89,
          "phaseGraph": {"HandleId": "8", "Data": {"nodes": [condition_node]}}}},
          {"HandleId": "9", "Data": {"$type": "questPauseConditionNodeDefinition", "id": 157,
            "condition": {"HandleId": "10", "Data": {"$type": "questFactsDBCondition",
              "factName": "delamain_taxi_state", "value": 4}}}},
          {"HandleId": "11", "Data": {"$type": "questSceneNodeDefinition", "id": 10,
            "sceneFile": r"base\open_world\passenger\scenes\thepassenger.scene",
            "sockets": [{"HandleRefId": "10"}]}}]}}}}}


class DriverGuardTests(unittest.TestCase):
    def test_appends_explicit_player_driver_and_preserves_input(self):
        source = fixture()
        frozen = copy.deepcopy(source)
        result = guard.patch_document(source)
        self.assertEqual(source, frozen)
        added = guard.active_condition(result)["conditions"][-1]["Data"]["type"]["Data"]
        self.assertEqual((added["anyChild"], added["childIsPlayer"], added["role"]), (0, 1, "Driver"))
        self.assertEqual(added["childRef"], reference("#player"))
        self.assertEqual(added["parentRef"], reference("#mounted_vehicle"))
        self.assertTrue(guard.verify_roundtrip(source, result)["taxiBranchUnchanged"])

    def test_new_handles_are_unique_and_above_original_range(self):
        source = fixture()
        result = guard.patch_document(source)
        handles = [node["HandleId"] for node in guard.walk(result) if "HandleId" in node]
        self.assertEqual(len(handles), len(set(handles)))
        added = guard.active_condition(result)["conditions"][-1]
        self.assertEqual([node["HandleId"] for node in guard.walk(added) if "HandleId" in node], ["12", "13"])

    def test_roundtrip_accepts_only_handle_renumbering_and_export_header_changes(self):
        source = fixture()
        result = guard.patch_document(source)
        for node in guard.walk(result):
            for key in ("HandleId", "HandleRefId"):
                if key in node:
                    node[key] = str(int(node[key]) + 100)
        result["Header"]["ArchiveFileName"] = "roundtrip"
        guard.verify_roundtrip(source, result)

    def test_rejects_changed_taxi_branch(self):
        source = fixture()
        result = guard.patch_document(source)
        result["Data"]["RootChunk"]["graph"]["Data"]["nodes"][1]["Data"]["condition"]["Data"]["value"] = 0
        with self.assertRaisesRegex(ValueError, "outside"):
            guard.verify_roundtrip(source, result)

    def test_rejects_changed_scene_path(self):
        source = fixture()
        result = guard.patch_document(source)
        result["Data"]["RootChunk"]["graph"]["Data"]["nodes"][2]["Data"]["sceneFile"] = "other.scene"
        with self.assertRaisesRegex(ValueError, "outside"):
            guard.verify_roundtrip(source, result)

    def test_rejects_lost_or_weakened_driver_guard(self):
        source = fixture()
        for mutation in ("remove", "anyChild", "role", "parent"):
            with self.subTest(mutation=mutation):
                result = guard.patch_document(source)
                conditions = guard.active_condition(result)["conditions"]
                mount = conditions[-1]["Data"]["type"]["Data"]
                if mutation == "remove": conditions.pop()
                elif mutation == "anyChild": mount["anyChild"] = 1
                elif mutation == "role": mount["role"] = "Invalid"
                else: mount["parentRef"] = reference("#other_car")
                with self.assertRaises(ValueError):
                    guard.verify_roundtrip(source, result)

    def test_rejects_changed_original_eligibility_condition(self):
        source = fixture()
        result = guard.patch_document(source)
        guard.active_condition(result)["conditions"][1]["Data"]["type"]["Data"]["role"] = "Driver"
        with self.assertRaisesRegex(ValueError, "outside"):
            guard.verify_roundtrip(source, result)

    def test_source_predicate_must_match_native_player_and_current_car(self):
        for field, value in (("anyChild", 1), ("childIsPlayer", 0), ("role", "Passenger")):
            with self.subTest(field=field):
                source = fixture()
                guard.active_condition(source)["conditions"][0]["Data"]["type"]["Data"][field] = value
                with self.assertRaises(ValueError):
                    guard.patch_document(source)

    def test_rejects_dangling_and_duplicate_handles(self):
        with self.assertRaisesRegex(ValueError, "Dangling"):
            guard.canonical_handles({"HandleRefId": "99"})
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            guard.canonical_handles([{"HandleId": "1"}, {"HandleId": "1"}])

    def archive_fixture(self, path, expected_sha1):
        return SimpleNamespace(entries={55: (0, 1, expected_sha1)}, shadowed_entries={},
                               segments=[(4, 7, 7)])

    def test_empty_pack_directory_digest_does_not_replace_exact_body_check(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "candidate.archive"
            path.write_bytes(b"HEADpayload")
            archive = self.archive_fixture(path, hashlib.sha1(b"").hexdigest())
            helper = SimpleNamespace(Archive=lambda *_: archive, depot_hash=lambda _: 55,
                                     MAX_RESOURCE_BYTES=1024)
            decoded, receipt = guard.verify_archive(path, b"payload", helper, None)
            self.assertEqual(decoded, b"payload")
            self.assertTrue(receipt["wolvenkitEmptyDigestMetadata"])
            self.assertTrue(receipt["decodedByteEqualityVerified"])
            with self.assertRaisesRegex(ValueError, "differs"):
                guard.verify_archive(path, b"corrupt", helper, None)

    def test_archive_rejects_unknown_digest_or_extra_depot_path(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "candidate.archive"
            path.write_bytes(b"HEADpayload")
            archive = self.archive_fixture(path, "0" * 40)
            helper = SimpleNamespace(Archive=lambda *_: archive, depot_hash=lambda _: 55,
                                     MAX_RESOURCE_BYTES=1024)
            with self.assertRaisesRegex(ValueError, "SHA-1"):
                guard.verify_archive(path, b"payload", helper, None)
            archive.entries[66] = (0, 1, "0" * 40)
            with self.assertRaisesRegex(ValueError, "depot"):
                guard.verify_archive(path, b"payload", helper, None)


if __name__ == "__main__":
    unittest.main()
