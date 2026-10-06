"""Mimi decoder fine-tune policy: frozen boundary, held-out fence and metrics (CPU, no weights)."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "vendor/pocket-tts-training/source"
sys.path[:0] = [str(ROOT / "scripts"), str(SOURCE)]

from pocket_training import mimi_decoder  # noqa: E402


class MimiDecoderPolicyTests(unittest.TestCase):
    def test_only_decoder_side_tensors_are_exported(self):
        state = {"encoder.model.0.conv.weight": 0, "encoder_transformer.x": 0, "downsample.conv.weight": 0,
                 "quantizer.output_proj.weight": 0, "upsample.convtr.weight": 0,
                 "decoder_transformer.layers.0.w": 0, "decoder.model.0.conv.weight": 0}
        self.assertEqual(sorted(mimi_decoder.decoder_keys(state)),
                         ["decoder.model.0.conv.weight", "decoder_transformer.layers.0.w",
                          "quantizer.output_proj.weight", "upsample.convtr.weight"])

    def test_heldout_lines_never_reach_training(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = Path(folder) / "train.jsonl"
            manifest.write_text("\n".join(json.dumps({"id": i, "path": f"a/{i}.wav", "duration": 3.0}) for i in
                                          ("keep-1", "held-1", "keep-2")) + "\n", encoding="utf-8")
            rows = mimi_decoder.read_rows(manifest, {"held-1"}, Path(folder))
            self.assertEqual([r["id"] for r in rows], ["keep-1", "keep-2"])
            with self.assertRaises(ValueError):
                mimi_decoder.read_rows(manifest, {"keep-1", "held-1", "keep-2"}, Path(folder))

    def test_metrics_are_zero_for_identical_audio(self):
        import torch
        torch.manual_seed(0)
        x = torch.randn(1, 1, 24000) * 0.1
        self.assertAlmostEqual(float(mimi_decoder.MelLoss("cpu")(x, x)), 0.0, places=6)
        self.assertAlmostEqual(mimi_decoder.high_band_db(x[0, 0], x[0, 0], "cpu"), 0.0, places=5)
        quieter_highs = torch.nn.functional.avg_pool1d(x, 3, 1, 1)
        self.assertGreater(mimi_decoder.high_band_db(quieter_highs[0, 0], x[0, 0], "cpu"), 1.0)

    def test_excluded_clips_never_reach_training(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = Path(folder) / "train.jsonl"
            lines = [json.dumps({"id": i, "path": f"a/{i}.wav", "duration": 3.0}) for i in ("keep-1", "fx-1", "keep-2")]
            manifest.write_text("\n".join(lines) + "\n", encoding="utf-8")
            listing = Path(folder) / "exclusions.json"
            listing.write_text(json.dumps({"clips": {"fx-1": {"reasons": ["comb"]}}}), encoding="utf-8")
            rows = mimi_decoder.read_rows(manifest, set(), Path(folder), mimi_decoder.load_exclusions(listing))
            self.assertEqual([r["id"] for r in rows], ["keep-1", "keep-2"])
            self.assertEqual(mimi_decoder.load_exclusions(None), set())

    def test_grid_contrast_sees_a_200hz_line_comb(self):
        import torch
        torch.manual_seed(0)
        t = torch.arange(48000) / 24000
        noise = torch.randn(1, 48000) * 0.05
        comb = sum(torch.sin(2 * torch.pi * 200 * k * t) for k in range(15, 55))[None] * 0.01
        clean = mimi_decoder.grid_contrast(mimi_decoder.ltas_db(noise, "cpu"))
        buzzy = mimi_decoder.grid_contrast(mimi_decoder.ltas_db(noise + comb, "cpu"))
        self.assertLess(abs(float(clean)), 1.0)
        self.assertGreater(float(buzzy), 5.0)
        l1, excess = mimi_decoder.ltas_losses((noise + comb)[:, None], noise[:, None], "cpu")
        self.assertGreater(float(excess), 4.0)
        self.assertGreater(float(l1), 0.0)

    def test_anchor_loss_and_mid_coherence_see_only_the_mid_band_phase(self):
        import torch
        torch.manual_seed(0)
        n = 48000
        ref = torch.randn(1, 1, n) * 0.1
        self.assertAlmostEqual(float(mimi_decoder.anchor_loss(ref, ref)), 0.0, places=6)
        self.assertAlmostEqual(mimi_decoder.mid_coherence(ref, ref), 1.0, places=4)
        # Same magnitudes, phase scrambled only inside 1.5-4 kHz.
        spec = torch.stft(ref[0, 0], 1024, 256, window=torch.hann_window(1024), return_complex=True)
        k0, k1 = int(1500 / 23.4375), int(4000 / 23.4375)
        scrambled = spec.clone()
        scrambled[k0:k1] = scrambled[k0:k1].abs() * torch.polar(torch.ones_like(scrambled[k0:k1].abs()), torch.rand_like(scrambled[k0:k1].abs()) * 6.28)
        y = torch.istft(scrambled, 1024, 256, window=torch.hann_window(1024), length=n)[None, None]
        self.assertGreater(float(mimi_decoder.anchor_loss(y, ref, 1500, 4000)), 0.5)
        self.assertLess(mimi_decoder.mid_coherence(y, ref, 1500, 4000), 0.5)
        # A change outside the band is invisible to both.
        out_band = spec.clone()
        out_band[k1 + 20:] = out_band[k1 + 20:] * complex(0.4161468, 0.9092974)
        z = torch.istft(out_band, 1024, 256, window=torch.hann_window(1024), length=n)[None, None]
        self.assertLess(float(mimi_decoder.anchor_loss(z, ref, 1500, 4000)), 0.15)
        self.assertGreater(mimi_decoder.mid_coherence(z, ref, 1500, 4000), 0.9)

    def test_discriminator_scores_every_scale(self):
        import torch
        disc = mimi_decoder.build_discriminator()
        outputs = disc(torch.zeros(2, 1, 12000))
        self.assertEqual(len(outputs), 5)
        for logits, feats in outputs:
            self.assertEqual(logits.shape[0], 2)
            self.assertEqual(len(feats), 5)

    def test_apply_decoder_replaces_only_decoder_tensors(self):
        import torch
        import safetensors.torch
        from pocket_training import apply_decoder
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "export").mkdir()
            bundle = {"flow_lm.w": torch.ones(2), "mimi.encoder.w": torch.ones(2), "mimi.decoder.w": torch.zeros(2),
                      "mimi.upsample.w": torch.zeros(3)}
            safetensors.torch.save_file(bundle, str(root / "export/model.safetensors"))
            safetensors.torch.save_file({"mimi.decoder.w": torch.full((2,), 5.0), "mimi.upsample.w": torch.full((3,), 7.0)},
                                        str(root / "dec.safetensors"))
            receipt = apply_decoder.apply(root / "export", root / "dec.safetensors", root / "out")
            out = safetensors.torch.load_file(str(root / "out/model.safetensors"))
            self.assertEqual(receipt["replaced_tensors"], 2)
            self.assertTrue(torch.equal(out["flow_lm.w"], bundle["flow_lm.w"]))
            self.assertTrue(torch.equal(out["mimi.encoder.w"], bundle["mimi.encoder.w"]))
            self.assertEqual(float(out["mimi.decoder.w"][0]), 5.0)
            safetensors.torch.save_file({"mimi.decoder.w": torch.zeros(2)}, str(root / "partial.safetensors"))
            with self.assertRaises(ValueError):
                apply_decoder.apply(root / "export", root / "partial.safetensors", root / "out2")


if __name__ == "__main__":
    unittest.main()
