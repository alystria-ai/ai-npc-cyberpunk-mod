"""Export/measurement gates with tiny fixtures; never load a voice model."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from pocket_training.compare_exports import (
    PINNED_SOURCE_DIGEST, cpu_environment, inspect_export, make_plan,
    run_worker, stream_timing, suite,
)
from pocket_training.runner import PINNED_REVISION, atomic_json, sha256_file


class ExportComparisonTests(unittest.TestCase):
    def setUp(self) -> None:
        import yaml

        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.exports: dict[str, Path] = {}
        for role, layers, cfg in (("teacher", 24, 2), ("student", 6, 1)):
            folder = self.root / role
            folder.mkdir()
            (folder / "model.safetensors").write_bytes(f"tiny-{role}-weights".encode())
            (folder / "tokenizer.json").write_text("{}\n")
            (folder / "inference.yaml").write_text(yaml.safe_dump({
                "weights_path": "model.safetensors",
                "flow_lm": {"transformer": {"num_layers": layers}, "lookup_table": {}},
                "mimi": {}}))
            atomic_json(folder / "receipt.json", {"selected_step": 100, "weights": "ema",
                "input_identity": "a" * 64, "source_revision": PINNED_REVISION,
                "model_sha256": sha256_file(folder / "model.safetensors"), "sample_cfg": cfg})
            self.exports[role] = folder
        self.audio = self.root / "reference.wav"
        self.audio.write_bytes(b"fixture-audio-only-no-models")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def args(self) -> argparse.Namespace:
        return argparse.Namespace(source=self.root, teacher_export=self.exports["teacher"],
            student_export=self.exports["student"], expected_input_identity=None,
            reference=self.audio, original=self.audio, omni32=self.audio,
            output=self.root / "comparison", threads=2, warm_runs=1, max_audio_seconds=30,
            worker_timeout=60, public_student_stream=False)

    def test_model_import_free_plan_preserves_inputs(self) -> None:
        before = {path: path.read_bytes() for folder in self.exports.values() for path in folder.iterdir()}
        with patch("pocket_training.compare_exports.source_digest", return_value=PINNED_SOURCE_DIGEST):
            plan = make_plan(self.args())
        self.assertFalse(plan["model_execution"])
        self.assertEqual([row["sample_cfg"] for row in plan["models"]], [2, 1])
        self.assertEqual([row["layers"] for row in plan["models"]], [24, 6])
        self.assertEqual(before, {path: path.read_bytes() for path in before})
        self.assertFalse(Path(plan["output"]).exists())

    def test_tampered_weights_fail_before_load(self) -> None:
        (self.exports["teacher"] / "model.safetensors").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "selected-checkpoint receipt"):
            inspect_export(self.exports["teacher"], "teacher")

    def test_export_rejects_missing_baseline_or_wrong_source_receipt(self) -> None:
        path = self.exports["teacher"] / "receipt.json"
        initial = json.loads(path.read_text())
        for replacement in ({"selected_step": 0}, {"selected_step": True},
                            {"source_revision": "wrong"}, {"weights": "raw"},
                            {"sample_cfg": 1}, {"input_identity": "z" * 64}):
            with self.subTest(replacement=replacement):
                atomic_json(path, {**initial, **replacement})
                with self.assertRaises(ValueError):
                    inspect_export(self.exports["teacher"], "teacher")
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            inspect_export(self.exports["teacher"], "teacher")

    def test_conflicting_training_input_identity_fails(self) -> None:
        path = self.exports["student"] / "receipt.json"
        atomic_json(path, {**json.loads(path.read_text()), "input_identity": "b" * 64})
        with patch("pocket_training.compare_exports.source_digest", return_value=PINNED_SOURCE_DIGEST):
            with self.assertRaisesRegex(ValueError, "different training inputs"):
                make_plan(self.args())

    def test_raw_student_requires_explicit_choice_and_provenance(self) -> None:
        path = self.exports['student'] / 'receipt.json'
        original = json.loads(path.read_text())
        raw = {**original, 'weights': 'raw', 'checkpoint_step': 100,
               'source_checkpoint_sha256': 'b' * 64, 'validated_probe_count': 2}
        raw.pop('selected_step')
        atomic_json(path, raw)
        with self.assertRaises(ValueError):
            inspect_export(self.exports['student'], 'student')
        accepted = inspect_export(self.exports['student'], 'student', 'raw')
        self.assertEqual((accepted['weights'], accepted['selected_step']), ('raw', 100))
        for change in ({'validated_probe_count': 0}, {'source_checkpoint_sha256': 'bad'}):
            atomic_json(path, {**raw, **change})
            with self.assertRaises(ValueError):
                inspect_export(self.exports['student'], 'student', 'raw')
        with self.assertRaises(ValueError):
            inspect_export(self.exports['teacher'], 'teacher', 'raw')

    def test_owner_can_pin_expected_run(self) -> None:
        args = self.args()
        args.expected_input_identity = "b" * 64
        with patch("pocket_training.compare_exports.source_digest", return_value=PINNED_SOURCE_DIGEST):
            with self.assertRaisesRegex(ValueError, "requested training run"):
                make_plan(args)

    def test_changed_source_fails(self) -> None:
        with patch("pocket_training.compare_exports.source_digest", return_value="b" * 64):
            with self.assertRaisesRegex(ValueError, "pinned official source"):
                make_plan(self.args())

    def test_fresh_output_is_required(self) -> None:
        output = self.root / "comparison"
        output.mkdir()
        (output / "keep.txt").write_text("owned")
        with self.assertRaises(FileExistsError):
            suite({"output": str(output)}, self.root / "entry.py")
        self.assertEqual((output / "keep.txt").read_text(), "owned")

    def test_stream_buffer_metric_tracks_later_underrun(self) -> None:
        measured = stream_timing([{"arrival_seconds": .2, "audio_before_seconds": 0},
                                 {"arrival_seconds": 1.2, "audio_before_seconds": .4}])
        self.assertAlmostEqual(measured["first_pcm_seconds"], .2)
        self.assertAlmostEqual(measured["minimum_start_for_observed_no_underrun_seconds"], .8)
        self.assertAlmostEqual(measured["additional_buffer_after_first_pcm_seconds"], .6)
        with self.assertRaises(ValueError):
            stream_timing([])

    def test_cpu_environment_hides_gpu_and_removes_credentials(self) -> None:
        with patch.dict(os.environ, {"CUDA_VISIBLE_DEVICES": "0", "HF_TOKEN": "not-a-real-token",
                                    "KAGGLE_API_TOKEN": "fixture", "PATH": "preserved"}):
            env = cpu_environment(2)
        self.assertEqual(env["CUDA_VISIBLE_DEVICES"], "-1")
        self.assertEqual(env["HF_HUB_OFFLINE"], "1")
        self.assertEqual(env["OMP_NUM_THREADS"], "2")
        self.assertEqual(env["PATH"], "preserved")
        self.assertNotIn("HF_TOKEN", env)
        self.assertNotIn("KAGGLE_API_TOKEN", env)

    def test_worker_is_fresh_bounded_process_without_shell(self) -> None:
        with patch("pocket_training.compare_exports.subprocess.run") as execute:
            run_worker(self.root / "entry.py", self.root / "request.json", self.root, 2, 60)
        call = execute.call_args
        self.assertEqual(call.args[0][0], sys.executable)
        self.assertEqual(call.kwargs["timeout"], 60)
        self.assertTrue(call.kwargs["check"])
        self.assertNotIn("shell", call.kwargs)
        self.assertEqual(call.kwargs["env"]["CUDA_VISIBLE_DEVICES"], "-1")

    def test_worker_failure_does_not_claim_completed(self) -> None:
        with patch("pocket_training.compare_exports.source_digest", return_value=PINNED_SOURCE_DIGEST):
            plan = make_plan(self.args())
        with patch("pocket_training.compare_exports.relocate_export", return_value={"config": "fixture.yaml"}), \
             patch("pocket_training.compare_exports.run_worker", side_effect=TimeoutError("bounded fixture")):
            with self.assertRaises(TimeoutError):
                suite(plan, self.root / "entry.py")
        receipt = json.loads((Path(plan["output"]) / "comparison.json").read_text())
        self.assertEqual(receipt["status"], "failed")
        self.assertFalse(receipt["model_execution"])
        self.assertEqual(receipt["results"], [])
        self.assertEqual((Path(plan["output"]) / "listen/00-Johnny-original.wav").read_bytes(), self.audio.read_bytes())


if __name__ == "__main__":
    unittest.main()
