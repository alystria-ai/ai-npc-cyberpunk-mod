"""Teacher policy and role boundaries; tiny/stub models, no assets or GPU."""
from pathlib import Path
import json
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import random

from pocket_training import rollout, teacher_quality
from pocket_training.runner import Spec, atomic_json, selected_checkpoint, teacher_quality_check, teacher_speech, teacher_rank_zero_commit


def panel(score, voice="judy"):
    return {"score": score, "speaker_scores": {voice: {"score": score, "samples": 2}},
            "sample_ids_sha256": "frozen-panel"}


def speech(deletions=0, count=18):
    return {"status": "completed", "diagnostic_failure": False, "selection_identity": "speech-fixture",
            "aggregate": {"expected_samples": count, "natural_eos_samples": count,
                          "finite_samples": count, "transcribed_samples": count, "deletions": deletions}}


class TeacherPolicyTests(unittest.TestCase):
    def test_all_runner_option_calls_supply_the_required_default(self):
        import ast
        import inspect
        from pocket_training import runner
        missing = [node.lineno for node in ast.walk(ast.parse(inspect.getsource(runner)))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == "option" and len(node.args) < 2
            and not any(keyword.arg == "default" for keyword in node.keywords)]
        self.assertEqual(missing, [])

    def test_teacher_anchor_initialization_and_resume_use_the_expected_hash(self):
        from contextlib import nullcontext
        from pocket_training import runner
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            spec = Spec(root / "spec", {"teacher_anchor_expected_sha256": "accepted-sha"},
                root, root, root / "out", "fixture", {})
            panels = {"dev": panel(.5), "old_dev": panel(.4), "conditional": panel(.7)}
            with patch.object(runner, "ema_weights", return_value=nullcontext()), \
                 patch.object(runner, "teacher_panel_scores", return_value=panels), \
                 patch.object(runner, "teacher_speech", return_value=speech()), \
                 patch.object(runner, "distributed_any", return_value=False), \
                 patch.object(runner, "teacher_rank_zero_commit", side_effect=lambda action, *args: action()):
                anchor = runner.teacher_anchor(spec, None, None, None, None, None,
                    0, 1, SimpleNamespace(requested=lambda: False), 0)
                resumed = runner.teacher_anchor(spec, None, None, None, None, None,
                    0, 1, SimpleNamespace(requested=lambda: False), 500)
            self.assertEqual(anchor["source_weight_sha256"], "accepted-sha")
            self.assertEqual(resumed, anchor)

    def test_teacher_only_dispatch_uses_an_explicit_safe_false_default(self):
        import sys
        from pocket_training import runner
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            spec = Spec(root / "spec", {"teacher_quality_policy": teacher_quality.POLICY,
                "teacher_only_evaluation": True}, root, root, root / "out", "fixture", {})
            with patch.object(runner, "load_spec", return_value=spec), \
                 patch.object(runner, "supervise", return_value=0) as supervised, \
                 patch.object(sys, "argv", ["runner", "--spec", str(spec.path), "--mode", "teacher-only"]):
                self.assertEqual(runner.main(), 0)
                self.assertEqual(supervised.call_args.args[1], ["prepare", "teacher", "evaluate"])
                del spec.raw["teacher_only_evaluation"]
                with self.assertRaisesRegex(ValueError, "explicit, hashed quality policy"):
                    runner.main()

    def test_unqualified_wording_and_loader_evidence_refuse_the_staged_bundle(self):
        from pocket_training import runner
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            audio = root / "native.wav"
            audio.write_bytes(b"unchanged-native-fixture")
            row = {"id": "fixture", "path": "native.wav"}
            manifests = {}
            for name in ("train", "dev", "test", "teacher_regression", "teacher_conditional"):
                path = root / (name + ".jsonl")
                path.write_text(json.dumps(row) + "\n")
                manifests[name] = path
            ledgers = []
            for purpose in ("historical_training", "reference_exclusions", "original_regression"):
                path = root / (purpose + ".json")
                path.write_text("{}")
                ledgers.append({"path": path.name, "sha256": runner.sha256_file(path), "purpose": purpose})
            integrity = dict.fromkeys(("historical_train_into_dev", "reference_into_train", "test_into_train",
                "unverified_native_sources", "unverified_derivatives", "unverified_wording", "invalid_loader_cuts",
                "floor_frame_lastword_loss", "tier_a_seen_training_scenes", "tier_b_previously_trained_utterances"), 0)
            bundle = {"schema": "teacher_staged_bundle_v1", "derivativePolicy": "native_raw_upstream_word_cuts",
                "manifests": {name: {"sha256": runner.sha256_file(path)} for name, path in manifests.items()},
                "audio_assets": {"native.wav": {"sha256": runner.sha256_file(audio)}}, "ledgers": ledgers,
                "integrity": integrity}
            receipt = root / "receipt.json"
            spec = Spec(root / "spec", {"teacher_regression_manifest": str(manifests["teacher_regression"]),
                "teacher_conditional_manifest": str(manifests["teacher_conditional"]), "teacher_corpus_receipt": str(receipt)},
                root, root, root / "out", "fixture", {key: manifests[key] for key in ("train", "dev", "test")})
            runner.atomic_json(receipt, bundle)
            with patch.object(runner.teacher_data, "verify_input"):
                runner.verify_teacher_bundle(spec)
            for key in ("unverified_wording", "invalid_loader_cuts", "floor_frame_lastword_loss"):
                for value in (1, None):
                    runner.atomic_json(receipt, {**bundle, "integrity": {**integrity, key: value}})
                    with self.assertRaisesRegex(ValueError, "integrity"):
                        runner.verify_teacher_bundle(spec)

    def test_asymmetric_rank_stop_exits_before_a_teacher_collective_branch(self):
        import torch
        for local_stop in (False, True):
            with patch("pocket_training.runner.distributed_any", return_value=True), \
                 patch("pocket_training.rollout.evaluate_rollout") as generated:
                result = teacher_speech(None, None, None, torch.device("cpu"), 500,
                    SimpleNamespace(requested=lambda: local_stop), 0, 2, weight_kind="ema")
                self.assertEqual(result["status"], "paused")
                generated.assert_not_called()

    def test_rank_zero_io_failure_is_common_to_every_rank(self):
        import torch
        for rank in (0, 1):
            action = unittest.mock.Mock(side_effect=OSError("fixture disk full"))
            with patch("pocket_training.runner.distributed_any", return_value=True), self.assertRaisesRegex(RuntimeError, "I/O failed"):
                teacher_rank_zero_commit(action, torch.device("cpu"), rank, 2)
            self.assertEqual(action.call_count, 1 if rank == 0 else 0)

    def test_cross_panel_aliases_cannot_hide_under_new_ids_paths_or_scenes(self):
        original = {"id": "old", "path": "old.wav", "scene_id": "old-scene", "source_wem_sha256": "wem",
                    "pcm_sha256": "pcm", "transcript": "A unique original spoken line"}
        changed = {**original, "id": "new", "path": "new.wav", "scene_id": "new-scene"}
        with self.assertRaisesRegex(ValueError, "alias"):
            teacher_quality.fence_recording_panels({"train": [original], "tier_a": [changed]})

    def test_decode_steps_reach_the_actual_sampler_and_audio_receipt(self):
        import numpy as np
        import torch
        from pocket_training import runner
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            reference = root / "reference.wav"
            reference.write_bytes(b"fixture-reference")
            manifest = root / "refs.json"
            atomic_json(manifest, {"references": [{"id": "johnny", "path": str(reference), "texts": ["A complete fixture sentence."]}]})
            spec = Spec(root / "spec", {"reference_manifest": str(manifest), "sample_decode_steps": 2},
                        root, root, root / "out", "fixture", {})
            model = SimpleNamespace(eval=lambda: None,
                flow_lm=SimpleNamespace(conditioner=SimpleNamespace(tokenizer=SimpleNamespace(encode=lambda text: [1, 2]))))
            model.generate = unittest.mock.Mock(return_value=[torch.zeros(8, 2)])
            mimi = SimpleNamespace(sample_rate=24000, frame_rate=12.5, encoder_frame_rate=25,
                encode_to_latent=lambda pcm: torch.zeros(1, 2, 2),
                decode_from_latent=lambda latent, state: torch.zeros(1, 1, 15360))
            with patch("sphn.read", return_value=(np.zeros((1, 24000), dtype=np.float32), 24000)), \
                 patch("training.dataloader.audio._load_window", return_value=np.zeros(24000, dtype=np.float32)), \
                 patch("pocket_tts.modules.stateful_module.init_states", return_value={}):
                runner.generate_samples(spec, model, mimi, torch.device("cpu"), "two-steps", 2,
                    SimpleNamespace(requested=lambda: False), selection_identity="fixed-two-step-probe")
            self.assertEqual(model.generate.call_args.kwargs["n_steps"], 2)
            receipt = json.loads((spec.output / "comparisons/two-steps/samples.json").read_text())[0]
            self.assertEqual(receipt["decode_steps"], 2)
            for bad in (True, 0, 3, -1, 1.5):
                with self.assertRaises(ValueError):
                    runner.sample_decode_steps(bad)
            self.assertEqual(runner.sample_decode_steps(), 1)

    def test_actual_validation_macro_preserves_a_rare_voice_beyond_sample_cap(self):
        import torch
        from pocket_training import runner
        class Loader:
            def __init__(self, *args, **kwargs):
                self.rng = random.Random()
            def get_entry(self, index):
                return rows[index]
            def _sample(self, entry):
                return entry
            def _collate(self, entries):
                return SimpleNamespace(text_tokens=entries[0]["diagnostic"])
        class Model:
            distill_teacher = None
            training = True
            ldim = 2
            flow = SimpleNamespace(p_equal=.25)
            flow_lm = SimpleNamespace(conditioner=SimpleNamespace(tokenizer=SimpleNamespace(encode=lambda text: text)))
            def eval(self):
                self.training = False
            def train(self, flag):
                self.training = flag
            def __call__(self, *args, **kwargs):
                value = torch.tensor(float(args[2]))
                return value, {"loss": value, "flow_loss": value, "flow_diag": value,
                               "flow_distill": torch.tensor(0.), "eos_loss": torch.tensor(0.)}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            rows = [{"id": str(i), "path": "fixture.wav", "character": "many", "diagnostic": 4} for i in range(10)]
            rows.append({"id": "rare", "path": "fixture.wav", "character": "rare", "diagnostic": 20})
            spec = Spec(root / "spec", {"teacher_quality_policy": teacher_quality.POLICY,
                         "teacher_dev_expected_speakers": ["many", "rare"], "max_valid_samples": 1},
                        root, root, root / "output", "fixture", {})
            runner.atomic_rows(spec.output / "data/dev.jsonl", rows)
            encoded = (torch.zeros(1, 1, 2), torch.ones(1, 1, dtype=torch.bool), torch.zeros(1, 1, 2), torch.ones(1, dtype=torch.int64))
            with patch("training.dataloader.DataLoader", Loader), patch("training.dataloader.encode_batch", return_value=encoded), \
                 patch.object(runner, "capture_rng", return_value={}), patch.object(runner, "restore_rng"):
                result = runner.validate(spec, Model(), SimpleNamespace(sample_rate=24000, frame_rate=12.5), SimpleNamespace(seed=42, data=SimpleNamespace(max_duration_sec=30, max_voice_prompt_sec=5), eos_loss_weight=.1),
                                         torch.device("cpu"), 0, 1, SimpleNamespace(requested=lambda: False))
            self.assertEqual(result["samples"], 11)
            self.assertEqual(result["speaker_count"], 2)
            self.assertAlmostEqual(result["score"], 1.5)
            self.assertEqual(result["selection"], "tier_a_macro_unseen_scene")

    def test_macro_gives_sparse_voice_equal_weight(self):
        scores = {"many": {"score": .1, "samples": 100}, "rare": {"score": .9, "samples": 1}}
        self.assertEqual(teacher_quality.macro_speakers(scores, {"many", "rare"}), .5)
        with self.assertRaisesRegex(ValueError, "coverage"):
            teacher_quality.macro_speakers(scores, {"many", "rare", "missing"})

    def test_macro_score_preserves_unweighted_lsd_diagnostic(self):
        score = teacher_quality.objective({"flow_diag": 4, "flow_distill": 2, "eos_loss": .5},
                                         p_equal=.25, ldim=2, eos_weight=.1)
        self.assertAlmostEqual(score, 1.3)

    def test_tier_b_cannot_hide_primary_or_old_development_regression(self):
        anchor = {"dev": panel(.5), "old_dev": panel(.4), "conditional": panel(.8), "speech": speech()}
        self.assertEqual(teacher_quality.candidate_reasons(panel(.49), panel(.4), anchor, speech(), conditional=panel(.7)), [])
        self.assertIn("no_macro_development_improvement", teacher_quality.candidate_reasons(panel(.51), panel(.4), anchor, speech(), conditional=panel(.1)))
        self.assertIn("old_development_regression", teacher_quality.candidate_reasons(panel(.49), panel(.42), anchor, speech(), conditional=panel(.7)))
        self.assertIn("conditional_development_regression", teacher_quality.candidate_reasons(panel(.49), panel(.4), anchor, speech(), conditional=panel(.83)))

    def test_same_anchor_asr_noise_is_tolerated_but_new_omissions_are_not(self):
        self.assertTrue(teacher_quality.speech_complete(speech(1), speech(1)))
        self.assertFalse(teacher_quality.speech_complete(speech(2), speech(1)))
        self.assertFalse(teacher_quality.speech_complete(speech(count=17)))

    def test_conditional_tier_allows_scene_overlap_but_not_seen_audio_or_text(self):
        old = {"id": "old", "source_wem_sha256": "old-wem", "pcm_sha256": "old-pcm", "transcript": "Existing ordinary words"}
        new = {"id": "new", "source_wem_sha256": "new-wem", "pcm_sha256": "new-pcm", "transcript": "Different ordinary words",
               "scene_id": "same-scene", "validation_tier": "B_unseen_utterance_seen_scene",
               "previous_training_seen": False, "previous_training_scene_seen": True}
        teacher_quality.fence_conditionals([new], [old])
        for changed in ({**new, "previous_training_seen": True}, {**new, "validation_tier": "A_unseen_scene"},
                        {**new, "source_wem_sha256": "old-wem"}, {**new, "original_pcm_sha256": "old-pcm"},
                        {**new, "transcript": "EXISTING ordinary words!"}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                teacher_quality.fence_conditionals([changed], [old])

    def test_unqualified_teacher_never_falls_back_to_latent_best(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            spec = Spec(root / "spec", {"teacher_quality_policy": teacher_quality.POLICY}, root, root, root / "output", "fixture", {})
            (spec.output / "teacher").mkdir(parents=True)
            (spec.output / "teacher/best.pt").write_bytes(b"latent-only")
            self.assertEqual(selected_checkpoint(spec, "teacher"), spec.output / "teacher/quality-best.pt")
            self.assertFalse(selected_checkpoint(spec, "teacher").exists())

    def test_eligible_ema_is_only_a_listening_candidate_and_has_source_hash(self):
        import torch
        from torch import nn
        from training.checkpointing import EMA
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            spec = Spec(root / "spec", {"teacher_quality_policy": teacher_quality.POLICY,
                        "teacher_rollout_steps": [500]}, root, root, root / "output", "fixture", {})
            model = nn.Module()
            model.flow_lm = nn.Linear(2, 2)
            anchor = {"dev": panel(.5), "old_dev": panel(.4), "conditional": panel(.8), "speech": speech()}
            measured = {"dev": panel(.49), "old_dev": panel(.4), "conditional": panel(.7)}
            with patch("pocket_training.runner.teacher_panel_scores", return_value=measured), \
                 patch("pocket_training.runner.teacher_speech", return_value=speech()) as generated:
                teacher_quality_check(spec, model, nn.Identity(), EMA(model, .999), SimpleNamespace(),
                                      torch.device("cpu"), 0, 1, 500, SimpleNamespace(requested=lambda: False), anchor, measured["dev"])
            candidate = selected_checkpoint(spec, "teacher")
            self.assertTrue(candidate.exists())
            receipt = json.loads(candidate.with_suffix(".json").read_text())
            self.assertFalse(receipt["listening_qualified"])
            self.assertFalse(receipt["automatic_promotion"])
            self.assertFalse(receipt["tier_b_generalization_claim"])
            self.assertEqual([call.kwargs["weight_kind"] for call in generated.call_args_list], ["ema", "raw"])
            candidate.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "quality selection"):
                selected_checkpoint(spec, "teacher")

    def test_teacher_receipt_allows_trainable_heads_without_weakening_student_guard(self):
        def head():
            return SimpleNamespace(parameters=lambda: [SimpleNamespace(requires_grad=True)])
        model = SimpleNamespace(distill_teacher=None, flow_lm=SimpleNamespace(flow_net=head(), out_eos=head()))
        with patch.object(rollout, "_state_digest", return_value="a" * 64):
            result = rollout._weights_receipt(model, SimpleNamespace(), "ema", role="teacher")
            self.assertTrue(result["trainable_heads"]["flow_net"])
            with self.assertRaisesRegex(ValueError, "frozen distillation"):
                rollout._weights_receipt(model, SimpleNamespace(), "ema")
            model.distill_teacher = object()
            with self.assertRaisesRegex(ValueError, "disguise"):
                rollout._weights_receipt(model, SimpleNamespace(), "ema", role="teacher")


if __name__ == "__main__":
    unittest.main()
