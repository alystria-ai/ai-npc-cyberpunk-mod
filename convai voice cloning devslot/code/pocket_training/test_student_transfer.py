"""Observed transfer failures covered using tiny CPU tensors, no model assets."""
import json
from pathlib import Path
import random
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from pocket_training import runner, student_transfer, teacher_quality


class StudentTransferTests(unittest.TestCase):
    def fixture(self, root):
        import torch
        from torch import nn
        class Flow(nn.Module):
            def __init__(self):
                super().__init__()
                self.core = nn.Linear(2, 2)
                self.flow_net = nn.Linear(2, 2)
                self.out_eos = nn.Linear(2, 1)
                self.register_buffer("emb_mean", torch.zeros(2))
                self.register_buffer("emb_std", torch.ones(2))
        model = nn.Module()
        model.flow_lm = Flow()
        model.flow = SimpleNamespace()
        teacher = Flow()
        teacher.load_state_dict(model.flow_lm.state_dict())
        teacher.requires_grad_(False).eval()
        model.__dict__["distill_teacher"] = teacher
        model.flow_lm.flow_net.requires_grad_(False)
        model.flow_lm.out_eos.requires_grad_(False)
        mimi = nn.Linear(2, 2).eval().requires_grad_(False)
        raw = {"student_transfer_policy": student_transfer.POLICY}
        spec = runner.Spec(root / "spec", raw, root, root, root / "out", "fixture", {})
        return spec, model, mimi

    def test_flattened_selected_ema_is_not_replaced_by_old_shadow(self):
        import torch
        receipt = {"selected_step": 500, "input_identity": "new-teacher", "source_checkpoint_sha256": "exact-file"}
        raw = {"flow_lm.head": torch.tensor([4.])}
        payload = {"step": 500, "model": raw, "ema": None,
                   "runner": {"input_identity": "new-teacher", "selection_weights": "ema"}}
        selected, storage = student_transfer.selected_teacher_state(payload, receipt, "exact-file")
        self.assertEqual(storage, "flattened_selected_ema")
        self.assertIs(selected["flow_lm.head"], raw["flow_lm.head"])
        for changed in ({**payload, "step": 1200}, {**payload, "runner": {"input_identity": "new-teacher", "selection_weights": "raw"}}):
            with self.assertRaises(ValueError):
                student_transfer.selected_teacher_state(changed, receipt, "exact-file")
        with self.assertRaisesRegex(ValueError, "exact selected EMA"):
            student_transfer.selected_teacher_state(payload, receipt, "other-file")
        legacy = {**payload, "ema": {"flow_lm.head": torch.tensor([6.])}}
        selected, storage = student_transfer.selected_teacher_state(legacy, receipt, "exact-file")
        self.assertEqual(storage, "dict_ema")
        self.assertEqual(selected["flow_lm.head"].item(), 6.)

    def test_actual_import_flat_and_legacy_use_truthful_upstream_storage(self):
        import torch
        from safetensors.torch import save_file
        for flat in (True, False):
            with self.subTest(flat=flat), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                export = {"flow_lm.head": torch.tensor([4.]), "mimi.codec": torch.tensor([2.])}
                weights, checkpoint, receipt_path = root / "weights.safetensors", root / "selected.pt", root / "receipt.json"
                save_file(export, str(weights))
                payload = {"step": 500, "model": {"flow_lm.head": torch.tensor([4. if flat else 2.])},
                           "ema": None if flat else {"flow_lm.head": torch.tensor([4.])},
                           "runner": {"input_identity": "original", "selection_weights": "ema"}}
                torch.save(payload, checkpoint)
                runner.atomic_json(receipt_path, {"selected_step": 500, "input_identity": "original",
                    "source_revision": runner.PINNED_REVISION, "sample_cfg": 2., "weights": "ema",
                    "source_checkpoint_sha256": runner.sha256_file(checkpoint), "model_sha256": runner.sha256_file(weights)})
                spec = runner.Spec(root / "spec", {"import_teacher_checkpoint": str(checkpoint),
                    "import_teacher_weights": str(weights), "import_teacher_receipt": str(receipt_path)},
                    root, root, root / "out", "new-run", {})
                runner.atomic_text(spec.output / "configs/teacher-inference.yaml", "weights_path: '" + str(weights) + "'\n")
                runner.import_teacher(spec)
                imported = torch.load(spec.output / "teacher/best.pt", weights_only=True)
                state = runner.read_json(spec.output / "teacher/state.json")
                self.assertEqual(imported["runner"]["input_identity"], "new-run")
                self.assertEqual(state["origin"]["upstream_use_ema"], not flat)
                self.assertEqual(imported["ema"] is None, flat)
                # Same exact input is a verified read-only import resume.
                runner.import_teacher(spec)

    def test_actual_import_refuses_flow_inventory_dtype_or_tensor_changes(self):
        import torch
        from safetensors.torch import save_file
        for changed in ({}, {"flow_lm.head": torch.tensor([4.], dtype=torch.float64)},
                        {"flow_lm.head": torch.tensor([5.])},
                        {"flow_lm.head": torch.tensor([4.]), "flow_lm.extra": torch.tensor([2.])}):
            with self.subTest(keys=list(changed)), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                weights, checkpoint, receipt = root / "weights.safetensors", root / "selected.pt", root / "receipt.json"
                save_file({"flow_lm.head": torch.tensor([4.])}, str(weights))
                torch.save({"step": 500, "model": changed, "ema": None,
                            "runner": {"input_identity": "original", "selection_weights": "ema"}}, checkpoint)
                runner.atomic_json(receipt, {"selected_step": 500, "input_identity": "original",
                    "source_revision": runner.PINNED_REVISION, "sample_cfg": 2., "weights": "ema",
                    "source_checkpoint_sha256": runner.sha256_file(checkpoint), "model_sha256": runner.sha256_file(weights)})
                spec = runner.Spec(root / "spec", {"import_teacher_checkpoint": str(checkpoint),
                    "import_teacher_weights": str(weights), "import_teacher_receipt": str(receipt)},
                    root, root, root / "out", "new-run", {})
                runner.atomic_text(spec.output / "configs/teacher-inference.yaml", "weights_path: '" + str(weights) + "'\n")
                with self.assertRaisesRegex(ValueError, "tensors differ"):
                    runner.import_teacher(spec)

    def test_transferred_heads_flags_and_calibration_are_actual_tensor_gates(self):
        import torch
        with tempfile.TemporaryDirectory() as folder:
            spec, model, mimi = self.fixture(Path(folder))
            stop = SimpleNamespace(requested=lambda: False)
            result = student_transfer.transfer_receipt(model, stop)
            self.assertTrue(result["flow_net"]["teacher_copy_identical"])
            with torch.no_grad():
                model.flow_lm.flow_net.weight.add_(.01)
            with self.assertRaisesRegex(ValueError, "tensor differs"):
                student_transfer.transfer_receipt(model, stop)
            model.flow_lm.flow_net.load_state_dict(model.distill_teacher.flow_net.state_dict())
            model.flow_lm.emb_std.add_(.01)
            with self.assertRaisesRegex(ValueError, "calibration"):
                student_transfer.transfer_receipt(model, stop)

    def test_accepted_control_preserves_original_heads_then_restores_hybrid(self):
        import torch
        from safetensors.torch import save_file
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            spec, model, mimi = self.fixture(root)
            old = {"flow_lm." + key: value.detach().clone() for key, value in model.flow_lm.state_dict().items()}
            old["flow_lm.flow_net.weight"].fill_(7.)
            old.update({"mimi." + key: value.clone() for key, value in mimi.state_dict().items()})
            weights = root / "accepted.safetensors"
            save_file(old, str(weights))
            spec.raw["student_anchor_weights"] = str(weights)
            original = model.flow_lm.flow_net.weight.detach().clone()
            with student_transfer.accepted_student_weights(spec, model, mimi, torch.device("cpu"), 0, 1):
                self.assertTrue(torch.equal(model.flow_lm.flow_net.weight, torch.full_like(original, 7.)))
            self.assertTrue(torch.equal(model.flow_lm.flow_net.weight, original))
            student_transfer.transfer_receipt(model, SimpleNamespace(requested=lambda: False))

    def test_actual_student_validation_is_macro_mse_not_teacher_loss(self):
        import torch
        class Loader:
            def __init__(self, *args, **kwargs):
                self.rng = random.Random()
            def get_entry(self, index):
                return rows[index]
            def _sample(self, entry):
                return entry
            def _collate(self, entries):
                return SimpleNamespace(text_tokens=entries[0]["mse"])
        class Model:
            distill_teacher = object()
            training = True
            flow_lm = SimpleNamespace(conditioner=SimpleNamespace(tokenizer=SimpleNamespace(encode=lambda text: text)))
            def eval(self):
                self.training = False
            def train(self, value):
                self.training = value
            def __call__(self, *args, **kwargs):
                value = torch.tensor(float(args[2]))
                return value, {"loss": value, "distill_mse": value}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            rows = [{"id": str(i), "path": "fixture.wav", "character": "river", "mse": 1} for i in range(20)]
            rows += [{"id": "judy", "path": "fixture.wav", "character": "judy", "mse": 3}]
            spec = runner.Spec(root / "spec", {"student_transfer_policy": student_transfer.POLICY,
                    "teacher_dev_expected_speakers": ["river", "judy"], "max_valid_samples": 1},
                    root, root, root / "out", "fixture", {})
            runner.atomic_rows(spec.output / "data/dev.jsonl", rows)
            encoded = (torch.zeros(1, 1, 2), torch.ones(1, 1, dtype=torch.bool), torch.zeros(1, 1, 2), torch.ones(1, dtype=torch.int64))
            with patch("training.dataloader.DataLoader", Loader), patch("training.dataloader.encode_batch", return_value=encoded), \
                    patch.object(runner, "capture_rng", return_value={}), patch.object(runner, "restore_rng"), \
                    patch.object(teacher_quality, "objective", side_effect=AssertionError("Student must not use teacher objective")):
                result = runner.validate(spec, Model(), SimpleNamespace(sample_rate=24000, frame_rate=12.5),
                    SimpleNamespace(seed=42, data=SimpleNamespace(max_duration_sec=30, max_voice_prompt_sec=5)),
                    torch.device("cpu"), 0, 1, SimpleNamespace(requested=lambda: False))
            self.assertEqual(result["samples"], 21)
            self.assertEqual(result["score"], 2.)
            self.assertTrue(result["selection"].endswith("_student_cfg2_target_backbone_mse"))

    def test_role_sampling_default_and_transfer_are_separate(self):
        root = Path(".")
        spec = runner.Spec(root / "spec", {}, root, root, root / "out", "fixture", {})
        self.assertEqual(runner.role_decode_steps(spec, "teacher"), 1)
        self.assertEqual(runner.role_decode_steps(spec, "student"), 1)
        spec.raw["sample_decode_steps"] = 2
        self.assertEqual(runner.role_decode_steps(spec, "student"), 2)
        spec.raw.update(teacher_sample_decode_steps=2, student_sample_decode_steps=1)
        self.assertEqual(runner.role_decode_steps(spec, "student"), 2)  # Non-opt-in defaults remain unchanged.
        spec.raw["student_transfer_policy"] = student_transfer.POLICY
        self.assertEqual(runner.role_decode_steps(spec, "teacher"), 2)
        self.assertEqual(runner.role_decode_steps(spec, "student"), 1)
        self.assertEqual(runner.role_decode_steps(spec, "accepted_student"), 1)

    def test_transfer_identity_rejects_anchor_source_sampler_and_step_drift(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ("corpus", "old_dev", "tier_b", "student"):
                (root / name).write_bytes(name.encode())
            student_sha = runner.sha256_file(root / "student")
            student_receipt = {"source_revision": runner.PINNED_REVISION, "weights": "ema", "sample_cfg": 1,
                               "selected_step": 6000, "input_identity": "accepted-student", "model_sha256": student_sha}
            teacher_receipt = {"selected_step": 500, "input_identity": "accepted-teacher", "model_sha256": "teacher-sha",
                               "source_checkpoint_sha256": "checkpoint-sha"}
            runner.atomic_json(root / "student-receipt.json", student_receipt)
            runner.atomic_json(root / "teacher-receipt.json", teacher_receipt)
            raw = {"student_transfer_policy": student_transfer.POLICY, "teacher_corpus_receipt": "corpus",
                   "teacher_regression_manifest": "old_dev", "teacher_conditional_manifest": "tier_b",
                   "student_anchor_weights": "student", "student_anchor_receipt": "student-receipt.json",
                   "student_anchor_expected_sha256": student_sha, "student_anchor_selected_step": 6000,
                   "student_anchor_input_identity": "accepted-student", "import_teacher_receipt": "teacher-receipt.json",
                   "import_teacher_expected_sha256": "teacher-sha", "import_teacher_expected_checkpoint_sha256": "checkpoint-sha",
                   "import_teacher_expected_input_identity": "accepted-teacher", "import_teacher_expected_step": 500,
                   "teacher_dev_expected_speakers": ["judy"], "teacher_conditional_expected_speakers": ["johnny"],
                   "teacher_sample_decode_steps": 2, "student_sample_decode_steps": 1,
                   "rollout_steps": [0, 250, 500, 1000, 1500, 2000], "precision": "auto"}
            pins = {"student_weight_sha256": student_sha, "student_init_from_sha256": student_sha,
                    "import_teacher_weights_sha256": "teacher-sha", "teacher_weight_sha256": "teacher-sha",
                    "import_teacher_checkpoint_sha256": "checkpoint-sha"}
            original = student_transfer.identity_fields(raw, dict(pins), root)
            changed_precision = student_transfer.identity_fields({**raw, "precision": "fp32"}, dict(pins), root)
            self.assertNotEqual(original, changed_precision)
            self.assertIn("runner.py", original["source_sha256"])
            self.assertIn("teacher_overlay.py", original["source_sha256"])
            for change in ({"student_anchor_selected_step": 5000}, {"import_teacher_expected_input_identity": "old-teacher"},
                           {"import_teacher_expected_step": 1200}, {"student_sample_decode_steps": 2}):
                with self.subTest(change=change), self.assertRaises(ValueError):
                    student_transfer.identity_fields({**raw, **change}, dict(pins), root)
            for change in ({"student_init_from_sha256": "other"}, {"teacher_weight_sha256": "old"},
                           {"import_teacher_checkpoint_sha256": "other"}):
                with self.subTest(change=change), self.assertRaises(ValueError):
                    student_transfer.identity_fields(raw, {**pins, **change}, root)

    def test_only_owned_hashed_numerical_fallback_can_override_precision(self):
        import sys
        with tempfile.TemporaryDirectory() as folder:
            spec, _, _ = self.fixture(Path(folder))
            spec.raw.update(precision="auto", allow_fp32_fallback=True)
            def invoke():
                with patch.object(runner, "load_spec", return_value=spec), patch.object(runner, "train", return_value=0) as trained, \
                        patch.object(runner, "Stop"), patch.object(sys, "argv", ["runner", "--spec", str(spec.path),
                            "--mode", "worker", "--stage", "distill", "--deadline", "9999999999", "--precision", "fp32"]):
                    value = runner.main()
                    self.assertEqual(trained.call_args.args[2], "fp32")
                    return value
            with self.assertRaisesRegex(ValueError, "precision override"):
                invoke()
            (spec.output / "distill").mkdir(parents=True)
            (spec.output / "distill/last.pt").write_bytes(b"owned-resume-checkpoint")
            runner.atomic_json(spec.output / "distill/state.json", {"input_identity": spec.identity,
                "status": "requires_fp32", "stop_reason": "nonfinite_gradient"})
            self.assertEqual(invoke(), 0)
            spec.raw["precision"] = "auto"  # main resolves only this worker's effective execution precision.
            runner.atomic_json(spec.output / "distill/state.json", {"input_identity": "other-run",
                "status": "requires_fp32", "stop_reason": "nonfinite_gradient"})
            with self.assertRaisesRegex(ValueError, "precision override"):
                invoke()

    def test_mse_candidate_has_no_latent_or_wer_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            spec, _, _ = self.fixture(Path(folder))
            for name in ("best.pt", "speech-best.pt"):
                target = spec.output / "distill" / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"unqualified")
            self.assertEqual(runner.selected_checkpoint(spec, "distill"), spec.output / "distill/quality-best.pt")
            self.assertFalse(runner.selected_checkpoint(spec, "distill").exists())
            self.assertTrue(runner.qualified_corpus(spec))

    def test_macro_candidate_retains_old94_tier_b_and_speech_guards(self):
        def panel(score):
            return {"score": score, "sample_ids_sha256": "exact-panel", "speaker_scores": {"judy": {"score": score, "samples": 2}}}
        spoken = {"status": "completed", "diagnostic_failure": False,
                  "aggregate": {"expected_samples": 18, "natural_eos_samples": 18,
                                "finite_samples": 18, "transcribed_samples": 18, "deletions": 0}}
        anchor = {"hybrid": {"dev": panel(.5), "old_dev": panel(.4), "conditional": panel(.8)},
                  "accepted": {"speech": spoken}}
        panels = {"dev": panel(.49), "old_dev": panel(.4), "conditional": panel(.8)}
        self.assertEqual(student_transfer.candidate_reasons(panels, anchor, spoken), [])
        for field, value, reason in (("dev", .51, "no_macro_student_mse_improvement"),
                                    ("old_dev", .42, "old_dev_student_mse_regression"),
                                    ("conditional", .83, "conditional_student_mse_regression")):
            altered = {**panels, field: panel(value)}
            self.assertIn(reason, student_transfer.candidate_reasons(altered, anchor, spoken))
        for changed in ({"deletions": 1}, {"natural_eos_samples": 17}):
            speech = {**spoken, "aggregate": {**spoken["aggregate"], **changed}}
            self.assertIn("accepted_student_speech_completeness_regression", student_transfer.candidate_reasons(panels, anchor, speech))

    def test_export_checks_actual_serialized_frozen_tensors(self):
        from safetensors.torch import save_file, load_file
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            spec, model, mimi = self.fixture(root)
            actual = {"flow_lm." + key: value.detach().clone() for key, value in model.flow_lm.state_dict().items()}
            actual.update({"mimi." + key: value.clone() for key, value in mimi.state_dict().items()})
            teacher, output = root / "teacher.safetensors", root / "output.safetensors"
            save_file(actual, str(teacher)); save_file(actual, str(output))
            spec.raw.update(import_teacher_weights=str(teacher), import_teacher_expected_sha256=runner.sha256_file(teacher))
            self.assertTrue(student_transfer.verify_export(spec, model, mimi, export_path=output)["serialized_export_verified"])
            changed = load_file(str(output))
            changed["flow_lm.out_eos.bias"].add_(.01)
            save_file(changed, str(output))
            with self.assertRaisesRegex(ValueError, "Serialized student export"):
                student_transfer.verify_export(spec, model, mimi, export_path=output)


if __name__ == "__main__":
    unittest.main()
