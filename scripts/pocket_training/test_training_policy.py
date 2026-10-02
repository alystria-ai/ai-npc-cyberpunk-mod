"""Training configuration/provenance regressions; no model or GPU is loaded."""
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "vendor/pocket-tts-training/source"
sys.path[:0] = [str(ROOT / "scripts"), str(SOURCE)]

from pocket_training.runner import Spec, PINNED_REVISION, atomic_json, import_teacher, make_training_args, read_json, sha256_file


class TrainingPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.output = self.base / "output"
        self.spec = Spec(self.base / "spec.json", {}, self.base, SOURCE, self.output, "new-run", {})
        atomic_json(self.output / "prepared.json", {"input_identity": "new-run", "counts": {"train": 2743}})
        atomic_json(self.output / "teacher/state.json", {"status": "completed"})
        (self.output / "teacher/best.pt").write_bytes(b"test-placeholder")

    def tearDown(self):
        self.temp.cleanup()

    def test_bounded_execution_does_not_compress_learning_schedule(self):
        from training.train_utils import lr_at
        self.spec.raw.update(distill_max_steps=6000, distill_schedule_steps=200000,
                             distill_ema_decay=0.999, distill_learning_rate=1e-4, distill_warmup_steps=1000)
        args, _text, ceiling = make_training_args(self.spec, "distill", 2)
        self.assertEqual((args._execution_max_steps, args.max_steps, ceiling), (6000, 200000, 200000))
        self.assertGreater(lr_at(5999, args), 0.99e-4)
        self.assertLess(args.ema_decay ** 6000, 0.003)

    def test_rejects_schedule_shorter_than_execution(self):
        self.spec.raw.update(distill_max_steps=6000, distill_schedule_steps=3000)
        with self.assertRaisesRegex(ValueError, "schedule horizon"):
            make_training_args(self.spec, "distill", 2)

    def test_imported_stage_is_allowed_without_training_teacher_again(self):
        atomic_json(self.output / "teacher/state.json", {"status": "imported"})
        args, _text, _ceiling = make_training_args(self.spec, "distill", 2)
        self.assertEqual(args.distill_teacher_weights, str(self.output / "teacher/best.pt"))
        self.assertTrue(args.distill_teacher_use_ema)

    def test_resume_rejects_changed_ema_or_learning_policy(self):
        self.spec.raw.update(distill_max_steps=6000, distill_schedule_steps=200000, distill_ema_decay=0.999)
        args, text, _ = make_training_args(self.spec, "distill", 2)
        (args.run_dir / "args.yaml").write_text(text)
        (args.run_dir / "last.pt").write_bytes(b"existing-checkpoint")
        self.spec.raw["distill_ema_decay"] = 0.9999
        with self.assertRaisesRegex(ValueError, "changed on resume"):
            make_training_args(self.spec, "distill", 2)

    def test_generated_word_loss_rejects_an_otherwise_good_checkpoint(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        import torch
        from torch import nn
        from training.checkpointing import EMA
        from pocket_training.runner import run_rollout_checks, selected_checkpoint
        self.spec.raw["rollout_steps"] = [500]
        model = nn.Module()
        model.flow_lm = nn.Linear(2, 2)
        result = {"status": "completed", "score": 0., "diagnostic_failure": True,
                  "aggregate": {"natural_eos_samples": 0, "capped_samples": 9}}
        stop = SimpleNamespace(requested=lambda:False)
        with patch("pocket_training.rollout.evaluate_rollout", return_value=result):
            summary = run_rollout_checks(self.spec, model, nn.Identity(), EMA(model,.999), torch.device("cpu"), 500, stop, 0, 1)
        self.assertFalse(summary["has_speech_candidate"])
        self.assertFalse((self.output / "distill/speech-best.pt").exists())
        self.assertFalse(selected_checkpoint(self.spec,"distill").exists())
        self.assertNotEqual(selected_checkpoint(self.spec,"distill"), self.output / "distill/best.pt")

    def test_selection_saves_raw_when_ema_generation_is_worse(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        import torch
        from torch import nn
        from training.checkpointing import EMA
        from pocket_training.runner import run_rollout_checks, selected_checkpoint
        self.spec.raw["rollout_steps"] = [500]
        model = nn.Module()
        model.flow_lm = nn.Linear(2, 2)
        with torch.no_grad():
            model.flow_lm.weight.fill_(1.)
        ema = EMA(model,.999)
        ema.shadow["flow_lm.weight"].fill_(2.)
        def evaluate(spec,*_args):
            kind = spec.raw["rollout_weight_kind"]
            self.assertEqual(model.flow_lm.weight[0,0].item(), 2. if kind=="ema" else 1.)
            return {"status":"completed", "score":.2 if kind=="ema" else .1, "diagnostic_failure":False,
                    "aggregate":{"natural_eos_samples":9}}
        with patch("pocket_training.rollout.evaluate_rollout", side_effect=evaluate):
            run_rollout_checks(self.spec,model,nn.Identity(),ema,torch.device("cpu"),500,SimpleNamespace(requested=lambda:False),0,1)
        checkpoint = selected_checkpoint(self.spec,"distill")
        payload = torch.load(checkpoint,weights_only=True)
        self.assertEqual(payload["runner"]["selection_weights"],"raw")
        self.assertEqual(payload["model"]["flow_lm.weight"][0,0].item(),1.)
        self.assertEqual(model.flow_lm.weight[0,0].item(),1.)


class TeacherImportTests(unittest.TestCase):
    def setUp(self):
        import torch
        from safetensors.torch import save_file
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.output = self.base / "output"
        self.output.mkdir()
        self.raw = {"import_teacher_checkpoint": "parent.pt", "import_teacher_weights": "teacher.safetensors",
                    "import_teacher_receipt": "receipt.json"}
        self.spec = Spec(self.base / "spec.json", self.raw, self.base, SOURCE, self.output, "new-run", {})
        self.weight = torch.tensor([3., 4.])
        torch.save({"step": 1200, "model": {"flow_lm.test": torch.tensor([1., 2.])},
                    "ema": {"flow_lm.test": self.weight},
                    "runner": {"input_identity": "parent-run", "selection_metrics": {"score": 0.1}}}, self.base / "parent.pt")
        save_file({"flow_lm.test": self.weight}, str(self.base / "teacher.safetensors"))
        self.receipt = {"source_revision": PINNED_REVISION, "weights": "ema", "sample_cfg": 2.,
                        "selected_step": 1200, "input_identity": "parent-run",
                        "model_sha256": sha256_file(self.base / "teacher.safetensors")}
        atomic_json(self.base / "receipt.json", self.receipt)
        (self.output / "configs").mkdir()
        (self.output / "configs/teacher-inference.yaml").write_text("weights_path: " + (self.base / "teacher.safetensors").as_posix())

    def tearDown(self):
        self.temp.cleanup()

    def test_imports_exact_ema_and_retains_parent(self):
        import torch
        import_teacher(self.spec)
        state = read_json(self.output / "teacher/state.json")
        self.assertEqual(state["status"], "imported")
        self.assertEqual(state["origin"]["source_input_identity"], "parent-run")
        payload = torch.load(self.output / "teacher/best.pt", weights_only=True)
        self.assertEqual(payload["runner"]["input_identity"], "new-run")
        self.assertTrue(torch.equal(payload["ema"]["flow_lm.test"], self.weight))
        import_teacher(self.spec)  # Verified idempotent import.

    def test_rejects_valid_hash_but_different_checkpoint_tensors(self):
        import torch
        payload = torch.load(self.base / "parent.pt", weights_only=True)
        payload["ema"]["flow_lm.test"] += 1
        torch.save(payload, self.base / "parent.pt")
        with self.assertRaisesRegex(ValueError, "tensors differ"):
            import_teacher(self.spec)

    def test_rejects_raw_export(self):
        self.receipt["weights"] = "raw"
        atomic_json(self.base / "receipt.json", self.receipt)
        with self.assertRaisesRegex(ValueError, "selected EMA"):
            import_teacher(self.spec)

    def test_rejects_modified_import_on_resume(self):
        import_teacher(self.spec)
        with (self.output / "teacher/best.pt").open("ab") as stream:
            stream.write(b"tampered")
        with self.assertRaisesRegex(ValueError, "changed on resume"):
            import_teacher(self.spec)


if __name__ == "__main__":
    unittest.main()
