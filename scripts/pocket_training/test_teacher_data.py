"""Actual-file evidence/cache boundaries; no voice models or GPU."""
import copy
import hashlib
import json
import shutil
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from pocket_training import teacher_data as data
from pocket_training import runner


def original():
    text = "We should leave now."
    return {"id": "judy/line", "speaker_id": "judy", "character": "judy", "source_panel": "train",
        "path": "wave.wav", "staged_archive_path": "data/audio/judy/wave.wav", "duration": 3.0,
        "audio_sha256": "a" * 64, "sha256": "a" * 64, "pcm_sha256": "b" * 64, "source_wem_sha256": "c" * 64,
        "native_text": text, "text": text, "transcript": text, "native_text_sha256": data.text_sha(text),
        "text_sha256": data.text_sha(text), "source_row_sha256": "d" * 64,
        "words": [{"word": "We", "start": .2, "end": .4}, {"word": "should", "start": .5, "end": .8},
                  {"word": "leave", "start": 1.8, "end": 2.1}, {"word": "now.", "start": 2.2, "end": 2.5}]}


def json_file(root, name, value, *, lines=False):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(("".join(json.dumps(row) + "\n" for row in value) if lines else json.dumps(value)), encoding="utf-8")
    return {"path": name, "sha256": data.file_sha(path)}


def tensor_file(path, shape, values=None, key="latents"):
    count = shape[0] * shape[1]
    values = values or [0.0] * count
    blob = struct.pack("<" + "f" * count, *values)
    header = json.dumps({key: {"dtype": "F32", "shape": shape, "data_offsets": [0, len(blob)]}}).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<Q", len(header)) + header + blob)


class TeacherDataTests(unittest.TestCase):
    def test_retained_new_native_times_must_match_actual_raw_alignment(self):
        row = original(); row["source_panel"] = "new_native"
        audits = {"actual": {"alignments": {row["id"]: copy.deepcopy(row["words"])}}}
        data.require_native_alignment(row, audits)
        row["words"][2]["start"] = 1.7
        with self.assertRaisesRegex(ValueError, "actual raw alignment"):
            data.require_native_alignment(row, audits)

    def test_loader_words_cannot_hide_different_content_behind_approved_caption(self):
        row = original()
        data.require_word_caption(row)
        row["words"][2]["word"] = "stay"
        with self.assertRaisesRegex(ValueError, "word stream"):
            data.require_word_caption(row)

    def test_seen_native_scene_cannot_be_relabelled_as_unrelated_unused_component(self):
        row = {"scenes": ["quest\\seen.scene"], "connected_scene_group": "seen"}
        native = {"scenePaths": ["quest\\seen.scene"]}
        components = {"seen": {"scenes": ["quest/seen.scene"], "exposure": ["train"]},
                      "unused": {"scenes": ["quest/unused.scene"], "exposure": []}}
        self.assertEqual(data.require_scene_membership(row, components, native), "seen")
        row["connected_scene_group"] = "unused"
        with self.assertRaisesRegex(ValueError, "actual native scene"):
            data.require_scene_membership(row, components, native)
        row["scenes"] = ["quest/unused.scene"]
        with self.assertRaisesRegex(ValueError, "actual native scene"):
            data.require_scene_membership(row, components, native)

    def test_actual_protected_original_scene_and_word_metadata_cannot_change(self):
        project = Path(__file__).resolve().parents[2]
        source = project / "runtime/voice-references/teacher-augmentation-20261003/staging-policy-v4/protected-evaluation-snapshot.json"
        snapshot = data.read(source)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for ordinal, item in enumerate(snapshot["inputs"]):
                raw = Path(item["path"])
                if str(raw).startswith("C:\\"):
                    raw = Path("/mnt/c/" + str(raw)[3:].replace("\\", "/"))
                target = root / (str(ordinal) + ".json")
                shutil.copyfile(raw, target)
                item["path"] = target.name
            panels = {role: [{**entry["content"], "protected_source_metadata": entry["protected_source_metadata"]}
                            for entry in snapshot["panels"][role]["rows"]] for role in data.PROTECTED}
            data.verify_protected(root, panels, snapshot)
            panels["teacher_regression"][0]["protected_source_metadata"]["scenes"] = ["a_changed_scene"]
            with self.assertRaisesRegex(ValueError, "original words/scenes"):
                data.verify_protected(root, panels, snapshot)

    def audit_fixture(self, root, hypothesis):
        row = original()
        source = json_file(root, "source.py", {})
        inputs = json_file(root, "inputs.jsonl", [row], lines=True)
        raw = {**row, "status": "audited", "ctc_raw_hypothesis": hypothesis,
               "exact_normalized_agreement": True}  # The gate must ignore this claim.
        ledger = json_file(root, "raw.jsonl", [raw], lines=True)
        launch_value = {"ctc_assets": {"models/alignment/model.safetensors": data.CTC_SHA},
            "transcript_tokens_supplied_to_model": False, "runtime_source_sha256": source["sha256"],
            "audit_manifest_sha256": inputs["sha256"]}
        launch = json_file(root, "launch.json", launch_value)
        summary = json_file(root, "summary.json", {"output_sha256": ledger["sha256"], "provenance": launch_value})
        return row, {"adapter": "ctc_local_v1", "input_manifest": inputs, "hypotheses_ledger": ledger,
                     "launch_receipt": launch, "summary": summary, "source_code": source}

    def wording_fixture(self, root, hypothesis):
        row, audit = self.audit_fixture(root, hypothesis)
        native_receipt = json_file(root, "native.json", {"key": "judy", "stringId": "line", "transcript": row["text"],
            "source": {"sha256": row["source_wem_sha256"]}, "wav": {"sha256": row["sha256"], "pcmSha256": row["pcm_sha256"]}})
        native = json_file(root, "native-index.json", {"recordings": {row["id"]: {
            "source_identity": data.identity(row), "verified": True, "native_provenance_receipt": native_receipt}}})
        panels = {role: json_file(root, role + ".jsonl", [row] if role == "train" else [], lines=True) for role in data.ROLES}
        decision = {"id": row["id"], "role": "train", "source_identity": data.identity(row),
            "final_caption_sha256": data.text_sha(row["transcript"]), "audit_ids": ["actual"], "action": "retain_native_exact_agreement"}
        policy = {"admission_roles": list(data.ADMISSION), "protected_roles": list(data.PROTECTED),
            "unverified_wording_scope": "admission_roles_only", "protected_snapshot": json_file(root, "protected.json", {}),
            "protected_diagnostics": json_file(root, "diag.json", {"changes_protected_rows_or_metrics": False, "rows": []}),
            "decisions_ledger": json_file(root, "decisions.jsonl", [decision], lines=True), "audits": {"actual": audit}}
        return SimpleNamespace(base=root), {"manifests": panels, "wording_qualification": policy,
                                          "semantic_ledgers": {"native_sources": native}}

    def test_actual_hypothesis_overrules_normalized_agreement_claim(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            spec, bundle = self.wording_fixture(root, "We should stay here.")
            with patch.object(data, "verify_protected"), patch.object(data, "verify_history"), \
                 self.assertRaisesRegex(ValueError, "actual free hypothesis"):
                data.verify_input(spec, bundle)

    def test_actual_raw_tuple_or_launch_tamper_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            _, item = self.audit_fixture(root, "We should leave now.")
            data.load_audit(root, item)
            raw = data.rows(root / "raw.jsonl")[0]
            raw["source_panel"] = "dev"
            item["hypotheses_ledger"] = json_file(root, "raw.jsonl", [raw], lines=True)
            launch = data.read(root / "launch.json")
            item["summary"] = json_file(root, "summary.json", {"output_sha256": item["hypotheses_ledger"]["sha256"], "provenance": launch})
            with self.assertRaisesRegex(ValueError, "original source tuple"):
                data.load_audit(root, item)

    def test_same_role_duplicate_id_cannot_hide_in_set_closure(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            spec, bundle = self.wording_fixture(root, "We should leave now.")
            bundle["manifests"]["train"] = json_file(root, "train.jsonl", [original(), original()], lines=True)
            with self.assertRaisesRegex(ValueError, "Duplicate ID"):
                data.verify_input(spec, bundle)

    def test_protected_tuple_sidecar_is_not_an_id_only_gate(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            spec, bundle = self.wording_fixture(root, "We should leave now.")
            protected = original(); protected["id"] = "protected/line"; protected["source_panel"] = "test"
            bundle["manifests"]["test"] = json_file(root, "test.jsonl", [protected], lines=True)
            wrong = data.identity(protected); wrong["speaker_id"] = "another"
            bundle["wording_qualification"]["protected_diagnostics"] = json_file(root, "diag.json",
                {"changes_protected_rows_or_metrics": False, "rows": [{"role": "test", "source_identity": wrong}]})
            with patch.object(data, "verify_protected"), patch.object(data, "verify_history"), \
                 self.assertRaisesRegex(ValueError, "Protected diagnostics"):
                data.verify_input(spec, bundle)

    def test_cache_producer_measures_decode_and_rechecks_hits_and_tensor_bytes(self):
        import numpy as np
        import torch
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); output = root / "out"
            row = original(); row["path"] = str(root / "wave.wav")
            for role in data.ROLES:
                runner.atomic_rows(output / "data" / (role + ".jsonl"), [row] if role == "train" else [])
            config = output / "configs/teacher-inference.yaml"; config.parent.mkdir(parents=True)
            config.write_text("mimi:\n  inner_dim: 2\n  sample_rate: 24000\n  frame_rate: 12.5\n")
            spec = runner.Spec(root / "spec", {"teacher_quality_policy": "macro_speaker_cfg2_old_dev_v1"},
                               root, root, output, "fixture", {})
            mimi = SimpleNamespace(sample_rate=24000, frame_rate=12.5, frame_size=1920)
            mimi.encode_to_latent = unittest.mock.Mock(return_value=torch.zeros(1, 40, 2))
            decode = lambda jobs: (np.zeros((len(jobs), 1, 72000), dtype=np.float32), [72000] * len(jobs))
            with patch("training.scripts.precompute_latents.mimi_encode_hash", return_value="codec"), \
                 patch("training.scripts.precompute_latents.measure_stitch_frames", return_value=(1, .001)), \
                 patch("training.scripts.precompute_latents._decode_chunk", side_effect=decode) as decoded:
                self.assertTrue(runner.precompute(spec, mimi, torch.device("cpu"), SimpleNamespace(requested=lambda: False)))
                receipt = data.read(output / "prepare/teacher-loader-cache.json")
                self.assertEqual(receipt["rows"][0]["actual_resampled_samples"], 72000)
                self.assertEqual(receipt["rows"][0]["shape"], [37, 2])
                self.assertTrue(runner.precompute(spec, mimi, torch.device("cpu"), SimpleNamespace(requested=lambda: False)))
                self.assertEqual(mimi.encode_to_latent.call_count, 1)
                self.assertGreaterEqual(decoded.call_count, 3)  # Cached use actually decodes again.
                path = output / "data" / receipt["rows"][0]["latents_file"]
                with path.open("ab") as stream:
                    stream.write(b"tamper")
                with self.assertRaisesRegex(ValueError, "actual latent"):
                    runner.precompute(spec, mimi, torch.device("cpu"), SimpleNamespace(requested=lambda: False))

    def test_cached_decode_boolean_cannot_replace_actual_samples_or_pcm(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "latent.safetensors"
            tensor_file(path, [37, 2])
            row = original()
            record = {"source": data.cache_source(row), "mimi_encode_hash": "codec", "actual_resampled_samples": 72000,
                "decoded_float32_sha256": "observed", "encoded_frames_available": 40, "sample_rate": 24000,
                "frame_rate": 12.5, "shape": [37, 2], "latents_sha256": data.file_sha(path), "actual_decode_observed": True}
            with self.assertRaisesRegex(ValueError, "actual decoded waveform"):
                data.verify_cache_row(row, record, path, samples=71900, decoded_sha="real",
                    sample_rate=24000, frame_rate=12.5, codec_hash="codec", dimension=2)

    def test_encoder_hash_is_derived_from_actual_fp32_weight_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "anchor.safetensors"
            tensor_file(path, [1, 1], [1.0], key="mimi.encoder.weight")
            expected = hashlib.sha256(b"encoder.weight:(1, 1)" + struct.pack("<f", 1.0)).hexdigest()
            self.assertEqual(data.encoder_file_hash(path), expected)

    def actual_cache_fixture(self, root, *, student):
        """Build real WAV/tensor/manifests observed by the complete verifier.

        These tiny artifacts test cache binding; they are not an admission
        receipt for the real corpus and do not instantiate/encode a model.
        """
        import numpy as np
        import wave
        from training.scripts.precompute_latents import _load_window
        from pocket_training import student_transfer
        waveform = root / "wave.wav"
        with wave.open(str(waveform), "wb") as stream:
            stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(24000)
            samples = (np.arange(72000, dtype=np.int32) % 301 - 150).astype("<i2")
            stream.writeframes(samples.tobytes())
        pcm = _load_window(str(waveform), 0, 3, 24000)
        row = original()
        row.update(path="wave.wav", audio_sha256=data.file_sha(waveform), sha256=data.file_sha(waveform),
                   pcm_sha256=hashlib.sha256(np.asarray(pcm, dtype="<f4").tobytes()).hexdigest())
        output = root / "out"
        source = {}
        staged = {**row, "path": str(waveform.resolve())}
        for role in data.ROLES:
            path = root / (role + ".jsonl")
            runner.atomic_rows(path, [row] if role == "train" else [])
            runner.atomic_rows(output / "data" / (role + ".jsonl"), [staged] if role == "train" else [])
            source[role] = path
        weights = root / "accepted-encoder.safetensors"
        tensor_file(weights, [1, 1], [1.], key="mimi.encoder.weight")
        codec_hash = data.encoder_file_hash(weights)
        latent_path = output / "data/latents/train_00000000.safetensors"
        tensor_file(latent_path, [37, 2])
        annotated = {**staged, "latents_file": "latents/train_00000000.safetensors"}
        runner.atomic_rows(output / "data/train_latents.jsonl", [annotated])
        calibration = output / "data/latents/calibration.json"
        runner.atomic_json(calibration, {"stitch_frames": 1, "noise_floor": .001})
        runner.atomic_text(output / "configs/teacher-inference.yaml",
                          "mimi:\n  inner_dim: 2\n  sample_rate: 24000\n  frame_rate: 12.5\n")
        raw = {"teacher_regression_manifest": str(source["teacher_regression"]),
               "teacher_conditional_manifest": str(source["teacher_conditional"])}
        if student:
            raw.update(student_transfer_policy=student_transfer.POLICY, import_teacher_weights=str(weights))
        else:
            raw.update(teacher_quality_policy="macro_speaker_cfg2_old_dev_v1", teacher_anchor_weights=str(weights))
        spec = runner.Spec(root / "spec", raw, root, root, output, "actual-cache-fixture",
                           {key: source[key] for key in ("train", "dev", "test")})
        observation = {"id": staged["id"], "source": data.cache_source(staged), "mimi_encode_hash": codec_hash,
            "actual_resampled_samples": len(pcm), "decoded_float32_sha256": hashlib.sha256(np.asarray(pcm, dtype="<f4").tobytes()).hexdigest(),
            "encoded_frames_available": 40, "sample_rate": 24000, "frame_rate": 12.5, "shape": [37, 2],
            "latents_sha256": data.file_sha(latent_path), "latents_file": annotated["latents_file"]}
        cache = {"schema": "teacher_actual_loader_cache_v2", "input_identity": spec.identity,
            "verifier_sha256": data.file_sha(data.__file__), "mimi_encode_hash": codec_hash,
            "sample_rate": 24000, "frame_rate": 12.5, "latent_dimension": 2,
            "prepared_manifest_sha256": {role: data.file_sha(output / "data" / (role + ".jsonl")) for role in data.ROLES},
            "annotated_manifest_sha256": data.file_sha(output / "data/train_latents.jsonl"),
            "ordered_rows_sha256": data.digest([data.cache_source(staged)]), "rows": [observation],
            "calibration_path": "latents/calibration.json", "calibration_sha256": data.file_sha(calibration)}
        cache_path = output / "prepare/teacher-loader-cache.json"
        runner.atomic_json(cache_path, cache)
        runner.atomic_json(output / "prepared.json", {"input_identity": spec.identity,
                          "loader_cache_receipt_sha256": data.file_sha(cache_path)})
        return spec, weights, latent_path, waveform

    def test_student_actual_cache_uses_imported_encoder_without_teacher_anchor_alias(self):
        with tempfile.TemporaryDirectory() as folder:
            spec, weights, latent, waveform = self.actual_cache_fixture(Path(folder), student=True)
            self.assertNotIn("teacher_anchor_weights", spec.raw)
            self.assertTrue(waveform.is_file())
            self.assertEqual(data.latent_shape(latent), [37, 2])
            result = data.verify_actual_cache(spec)  # Actual decoder, files and all cache gates; no mocks.
            self.assertEqual(result["status"], "passed")
            self.assertEqual(result["actual_decoded_rows"], 1)
            wrong = Path(folder) / "wrong-imported-encoder.safetensors"
            tensor_file(wrong, [1, 1], [2.], key="mimi.encoder.weight")
            spec.raw["import_teacher_weights"] = str(wrong)
            with self.assertRaisesRegex(ValueError, "accepted Mimi encode weights"):
                data.verify_actual_cache(spec)

    def test_teacher_actual_cache_preserves_anchor_and_ignores_imported_weight_alias(self):
        with tempfile.TemporaryDirectory() as folder:
            spec, weights, latent, waveform = self.actual_cache_fixture(Path(folder), student=False)
            wrong = Path(folder) / "wrong-imported-encoder.safetensors"
            tensor_file(wrong, [1, 1], [2.], key="mimi.encoder.weight")
            spec.raw["import_teacher_weights"] = str(wrong)
            self.assertEqual(data.verify_actual_cache(spec)["status"], "passed")
            spec.raw["teacher_anchor_weights"] = str(wrong)
            with self.assertRaisesRegex(ValueError, "accepted Mimi encode weights"):
                data.verify_actual_cache(spec)


if __name__ == "__main__":
    unittest.main()
