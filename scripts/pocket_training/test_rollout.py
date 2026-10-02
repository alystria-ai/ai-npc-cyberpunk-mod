"""Rollout diagnostics tested with tiny stubs; no model assets are loaded."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from pocket_training import rollout
from pocket_training.runner import Spec, atomic_json, sha256_file


class Module:
    def __init__(self, training=False, children=(), trainable=False):
        self.training = training
        self.children = list(children)
        self.trainable = trainable

    def modules(self):
        yield self
        for child in self.children:
            yield from child.modules()

    def parameters(self):
        return iter([SimpleNamespace(requires_grad=self.trainable)])

    def eval(self):
        for child in self.modules():
            child.training = False
        return self


class Stop:
    reason = "fixture_stop"

    def __init__(self):
        self.force = False

    def requested(self):
        return self.force


class RolloutTests(unittest.TestCase):
    def test_word_normalization_and_edit_counts(self):
        self.assertEqual(rollout.normalized_words("HOW’S life, Dex? Workin' — good."),
                         ["hows", "life", "dex", "workin", "good"])
        exact = rollout.word_errors("Hello, CHOOM!", "hello choom")
        self.assertEqual(exact["wer"], 0)
        errors = rollout.word_errors("one two three four", "one three five")
        self.assertEqual((errors["edits"], errors["substitutions"], errors["deletions"], errors["insertions"]), (2, 1, 1, 0))
        self.assertEqual(rollout.word_errors("one", "one two three")["wer"], 2)

    def test_omitted_words_and_empty_hypothesis_are_visible(self):
        missing = rollout.word_errors("Night City always finds who is paying the price", "Night City finds the price")
        self.assertEqual(missing["deletions"], 4)
        self.assertGreater(missing["deletion_rate"], .4)
        empty = rollout.word_errors("one two three", "")
        self.assertEqual((empty["wer"], empty["deletions"]), (1, 3))
        self.assertIsNone(rollout.word_errors("!!!", "hello")["wer"])

    def test_aggregate_is_word_weighted_not_mean_per_line(self):
        samples = [{"word_errors": rollout.word_errors("one", "")},
                   {"word_errors": rollout.word_errors("one two three four five six seven eight nine", "one two three four five six seven eight nine")}]
        measured = rollout.summarize_samples(samples, 2)
        self.assertEqual(measured["wer"], .1)
        self.assertEqual(measured["deletion_rate"], .1)
        self.assertEqual(measured["omitted_words_detected_samples"], 1)
        self.assertTrue(measured["asr_tentative"])

    def test_cap_is_not_natural_eos_and_short_early_eos_is_flagged(self):
        text = "one two three four five six seven eight nine ten"
        cap = rollout.sample_diagnostics({"text": text, "hit_frame_cap": True},
            {"finite": True, "duration_seconds": 30, "wave_subtype": "FLOAT"})
        self.assertFalse(cap["eos_natural"])
        self.assertFalse(cap["premature_stop_suspected"])
        early = rollout.sample_diagnostics({"text": text, "hit_frame_cap": False},
            {"finite": True, "duration_seconds": .64, "wave_subtype": "FLOAT"})
        self.assertTrue(early["eos_natural"])
        self.assertTrue(early["premature_stop_suspected"])
        aggregate = rollout.summarize_samples([cap, early], 3)
        self.assertEqual((aggregate["capped_samples"], aggregate["premature_stop_suspected_samples"], aggregate["missing_samples"]), (1, 1, 1))

    def test_nonfinite_and_invalid_wave_are_failed_diagnostics(self):
        bad = rollout.sample_diagnostics({"text": "hello", "hit_frame_cap": False},
            {"finite": False, "duration_seconds": float("nan"), "wave_subtype": "PCM_16"})
        self.assertFalse(bad["eos_natural"])
        self.assertIsNone(bad["measured_duration_seconds"])
        self.assertIn("nonfinite_pcm", bad["audio_error"])
        self.assertIn("unexpected_wave_subtype", bad["audio_error"])
        json.dumps(bad, allow_nan=False)

    def test_references_choose_requested_cast_without_mutating_manifest(self):
        refs = [{"id": "aaron"}, {"id": "johnny-silverhand"}, {"id": "judy"}, {"id": "panam"}, {"id": "river"}]
        self.assertEqual([row["id"] for row in rollout.choose_references(refs)], ["johnny-silverhand", "judy", "panam"])
        self.assertEqual(len(refs), 5)
        self.assertEqual(rollout.choose_references(refs[-1:]), refs[-1:])

    def models(self):
        flow = Module(training=True)
        flow.flow_net = Module(training=False)
        flow.out_eos = Module(training=False)
        flow.children = [flow.flow_net, flow.out_eos]
        teacher = Module(training=False)
        teacher.flow_net = Module(training=False)
        teacher.out_eos = Module(training=False)
        teacher.children = [teacher.flow_net, teacher.out_eos]
        model = Module(training=True, children=[flow])
        model.flow_lm, model.distill_teacher = flow, teacher
        mimi = Module(training=False, children=[Module(training=True)])
        return model, mimi

    def test_requires_frozen_identical_teacher_copy_heads(self):
        model, _ = self.models()
        with patch.object(rollout, "_state_digest", return_value="a" * 64):
            receipt = rollout._weights_receipt(model, Stop(), "raw")
        self.assertEqual(receipt["weights"], "raw")
        self.assertFalse(receipt["ema_applied_by_helper"])
        model.flow_lm.out_eos.trainable = True
        with patch.object(rollout, "_state_digest", return_value="a" * 64):
            with self.assertRaisesRegex(ValueError, "must remain frozen"):
                rollout._weights_receipt(model, Stop(), "raw")
        model.flow_lm.out_eos.trainable = False
        with patch.object(rollout, "_state_digest", side_effect=["a" * 64, "b" * 64]):
            with self.assertRaisesRegex(ValueError, "differs"):
                rollout._weights_receipt(model, Stop(), "raw")

    def evaluation_fixture(self, root):
        reference = root / "reference.wav"
        reference.write_bytes(b"fixture-reference")
        manifest = root / "references.json"
        refs = [{"id": name, "path": str(reference), "texts": [f"Hello {name} good morning"]} for name in ("aaron", "johnny", "judy", "panam")]
        atomic_json(manifest, {"references": refs})
        align = root / "local-ctc"
        align.mkdir()
        spec = Spec(root / "spec.json", {"reference_manifest": str(manifest), "align_model_dir": str(align)},
                    root, root / "source", root / "out", "a" * 64, {})
        model, mimi = self.models()
        stop = Stop()
        torch = SimpleNamespace(threads=7)
        torch.get_num_threads = lambda: torch.threads
        torch.set_num_threads = lambda value: setattr(torch, "threads", value)
        numpy = SimpleNamespace(random=SimpleNamespace(state="original-numpy"))
        numpy.random.get_state = lambda: numpy.random.state
        numpy.random.set_state = lambda value: setattr(numpy.random, "state", value)

        def generate(probe, actual_model, actual_mimi, device, label, cfg, actual_stop, **kwargs):
            self.assertEqual((cfg, kwargs["limit_references"], probe.option("sample_max_seconds", None)), (1, 3, 30))
            selected = json.loads(probe.asset("reference_manifest").read_text())["references"]
            self.assertEqual([item["id"] for item in selected], ["johnny", "judy", "panam"])
            actual_model.eval()
            actual_mimi.eval()
            numpy.random.state = "generation-mutated"
            folder = probe.output / "comparisons" / label
            records = []
            for item in selected:
                name = f"{item['id']}-00.wav"
                path = folder / name
                path.write_bytes(b"fixture-pcm")
                records.append({"reference_id": item["id"], "text_index": 0, "text": item["texts"][0],
                    "audio": name, "audio_sha256": sha256_file(path), "hit_frame_cap": False,
                    "selection_identity": kwargs["selection_identity"]})
            atomic_json(folder / "samples.json", records)
            return True

        return spec, model, mimi, stop, torch, numpy, generate

    def run_stubbed(self, root, transcript="exact", generation_error=False, cancelled_asr=False, cancelled_generation=False, weight_kind="raw"):
        spec, model, mimi, stop, torch, numpy, generate = self.evaluation_fixture(root)
        spec.raw["rollout_weight_kind"] = weight_kind
        original_modes = [(module, module.training) for module in (*model.modules(), *mimi.modules(), *model.distill_teacher.modules())]

        def interrupted_generate(*args, **kwargs):
            generate(*args, **kwargs)
            stop.force = True
            return False

        def transcribe(path, *_args):
            if cancelled_asr:
                stop.force = True
            name = path.name.split("-")[0]
            return f"Hello {name} good morning" if transcript == "exact" else "Hello morning"

        with patch.dict("sys.modules", {"torch": torch, "numpy": numpy}), \
             patch.object(rollout.runner, "capture_rng", return_value={"fixture": "exact-rng"}) as capture, \
             patch.object(rollout.runner, "restore_rng") as restore, \
             patch.object(rollout, "_state_digest", return_value="b" * 64), \
             patch.object(rollout.runner, "generate_samples", side_effect=RuntimeError("Official generation produced empty or non-finite latents") if generation_error else interrupted_generate if cancelled_generation else generate), \
             patch.object(rollout, "_inspect_audio", return_value={"finite": True, "duration_seconds": 2, "wave_subtype": "FLOAT"}), \
             patch.object(rollout, "_load_ctc", return_value=(object(), object())), \
             patch.object(rollout, "_transcribe", side_effect=transcribe):
            receipt = rollout.evaluate_rollout(spec, model, mimi, SimpleNamespace(type="cuda"), 500, stop)
        capture.assert_called_once_with(torch, model)
        restore.assert_called_once_with(torch, model, {"fixture": "exact-rng"})
        self.assertEqual([(module, module.training) for module, _ in original_modes], original_modes)
        self.assertEqual(numpy.random.state, "original-numpy")
        self.assertEqual(torch.threads, 7)
        self.assertEqual(json.loads(spec.asset("reference_manifest").read_text())["references"][0]["id"], "aaron")
        saved = json.loads((spec.output / f"comparisons/rollout-step000500-{weight_kind}/metrics.json").read_text())
        self.assertEqual(saved, receipt)
        self.assertFalse(receipt["quality_acceptance"])
        return receipt

    def test_evaluate_generates_and_transcribes_with_exact_state_restored(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = self.run_stubbed(Path(directory))
        self.assertEqual(receipt["status"], "completed")
        self.assertEqual(receipt["aggregate"]["transcribed_samples"], 3)
        self.assertEqual(receipt["score"], 0)
        self.assertFalse(receipt["diagnostic_failure"])

    def test_missing_word_result_is_recorded_without_canceling_training(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = self.run_stubbed(Path(directory), transcript="omitted")
        self.assertEqual(receipt["status"], "completed")
        self.assertEqual(receipt["aggregate"]["deletions"], 6)
        self.assertEqual(receipt["score"], .5)
        self.assertNotIn("stop_reason", receipt)

    def test_ema_label_cannot_overwrite_raw_rollout_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = self.run_stubbed(Path(directory), weight_kind="ema")
        self.assertEqual(receipt["label"], "rollout-step000500-ema")
        self.assertEqual(receipt["weights"], "ema")
        self.assertFalse(receipt["ema_applied_by_helper"])

    def test_generation_failure_restores_modes_and_rng_and_never_claims_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = self.run_stubbed(Path(directory), generation_error=True)
        self.assertEqual(receipt["status"], "failed")
        self.assertEqual(receipt["aggregate"]["missing_samples"], 3)
        self.assertEqual(receipt["aggregate"]["generation_failed_samples"], 3)
        self.assertEqual(receipt["samples"][0]["sample_status"], "generation_failed")
        self.assertEqual(receipt["samples"][1]["sample_status"], "not_attempted_after_generation_failure")
        self.assertIn("generation_failed", receipt["failure_reasons"])

    def test_stop_between_asr_samples_preserves_partial_transcripts_and_training_state(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = self.run_stubbed(Path(directory), cancelled_asr=True)
        self.assertEqual(receipt["status"], "paused")
        self.assertEqual(receipt["aggregate"]["transcribed_samples"], 1)
        self.assertEqual(receipt["stop_reason"], "fixture_stop")

    def test_stop_after_generation_preserves_uninspected_sample_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = self.run_stubbed(Path(directory), cancelled_generation=True)
        self.assertEqual(receipt["status"], "paused")
        self.assertEqual(receipt["aggregate"]["generated_samples"], 3)
        self.assertEqual(receipt["aggregate"]["transcribed_samples"], 0)
        self.assertEqual(receipt["samples"][0]["sample_status"], "uninspected_after_stop")
        self.assertIsNone(receipt["samples"][0]["finite"])

    def test_bad_step_is_rejected_before_any_model_work(self):
        for step in (-1, True, 1.1):
            with self.subTest(step=step), patch.dict("sys.modules", {"torch": object(), "numpy": object()}):
                with self.assertRaisesRegex(ValueError, "nonnegative integer"):
                    rollout.evaluate_rollout(None, None, None, None, step, Stop())


if __name__ == "__main__":
    unittest.main()
