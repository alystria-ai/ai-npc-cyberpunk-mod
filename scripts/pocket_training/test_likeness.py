"""PLS metric invariants (CPU, synthetic audio, no models)."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "scripts")]

from pocket_training import likeness  # noqa: E402


class LikenessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import torch
        torch.manual_seed(0)
        cls.analyzer = likeness.Analyzer("cpu")
        t = torch.arange(int(2.0 * likeness.SR)) / likeness.SR
        tone = 0.2 * torch.sin(2 * torch.pi * 220 * t) * (1 + 0.5 * torch.sin(2 * torch.pi * 3 * t))
        cls.voice = tone + 0.02 * torch.randn_like(tone)
        cls.dull = torch.nn.functional.avg_pool1d(cls.voice[None, None], 9, 1, 4)[0, 0]

    def test_high_band_starts_at_8_khz(self):
        self.assertTrue(40 < likeness.HIGH_BIN < 80)

    def test_identical_line_has_zero_distance(self):
        f = self.analyzer.features(self.voice)
        self.assertAlmostEqual(likeness.mcd_dtw(f, f), 0.0, places=4)
        self.assertGreater(likeness.mcd_dtw(self.analyzer.features(self.dull), f), 1.0)

    def test_dtw_on_identical_sequences_is_diagonal(self):
        import torch
        x = torch.randn(12, 5)
        self.assertEqual(likeness.dtw_path(x, x), [(i, i) for i in range(12)])

    def test_frechet_is_zero_for_the_same_distribution(self):
        import numpy as np
        x = np.random.default_rng(0).normal(size=(500, 4))
        self.assertAlmostEqual(likeness.frechet(x, x), 0.0, places=6)
        self.assertGreater(likeness.frechet(x, x + 1.0), 3.9)

    def test_pls_maps_anchors_to_60_and_90(self):
        metrics = {"low": {"fd_mfcc": 1400.0, "mcd": 385.0, "ltas_hi": 8.0},
                   "high": {"fd_mfcc": 900.0, "mcd": 355.0, "ltas_hi": 4.0},
                   "mid": {"fd_mfcc": 1150.0, "mcd": 370.0, "ltas_hi": 6.0}}
        scores = likeness.pls(metrics, "low", "high")
        self.assertAlmostEqual(scores["low"], 60.0)
        self.assertAlmostEqual(scores["high"], 90.0)
        self.assertAlmostEqual(scores["mid"], 75.0)

    def test_duller_audio_loses_high_band_and_timbre(self):
        real = [self.analyzer.features(self.voice)]
        stats = likeness.voice_reference_stats(real)
        good = likeness.condition_metrics([("v", real[0], real[0])], {"v": stats})
        dull = likeness.condition_metrics([("v", self.analyzer.features(self.dull), real[0])], {"v": stats})
        self.assertGreater(dull["ltas_hi"], good["ltas_hi"] + 3)
        self.assertGreater(dull["fd_mfcc"], good["fd_mfcc"])


if __name__ == "__main__":
    unittest.main()
