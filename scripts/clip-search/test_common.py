"""CPU-only tests for scripts/clip-search/common.py (no renders, no models). Run: python -m unittest scripts/clip-search/test_common.py"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402


def fake_pool(count=30, live_sha=None):
    clips = []
    for i in range(count):
        clips.append({"id": f"v/{i}", "d": 2.0 + (i % 7), "t": "this is a test line number " + str(i), "k": "media" if i == 5 else None,
                      "p": f"audio/v/{live_sha if i == 0 and live_sha else 'sha' + str(i)}.wav", "lv": -23.0})
    index = {"dataRoot": "C:/data", "voices": {"v": {"clips": clips, "loudMedian": -23.0, "live": {"omni": {"sha256": live_sha}} if live_sha else {},
                                                     "proposed": {"omni": {"clips": ["v/1", "v/2"]}}}}}
    return common.VoicePool(index, "v")


class CommonTests(unittest.TestCase):
    def test_joined_seconds_counts_gaps(self):
        self.assertAlmostEqual(common.joined_seconds([4, 5]), 9.4)
        self.assertAlmostEqual(common.joined_seconds([4]), 4)
        self.assertEqual(common.joined_seconds([]), 0)

    def test_split_is_disjoint_deterministic_and_clean(self):
        pool = fake_pool(live_sha="sha0")
        a, b = common.split_voice(pool), common.split_voice(pool)
        self.assertTrue(a["ok"]); self.assertEqual(a, b)
        held, cands = set(a["holdout"]), set(a["candidates"])
        self.assertFalse(held & cands)
        self.assertTrue(set(a["dev"]) | set(a["final"]) <= held)
        self.assertFalse(set(a["dev"]) & set(a["final"]))
        self.assertNotIn("v/0", held)            # today's reference stays out of the holdout
        self.assertFalse({"v/1", "v/2"} & held)  # so do the research proposals
        self.assertNotIn("v/5", cands)           # media-processed clips are not candidates
        self.assertEqual(len(a["dev"]), 2); self.assertEqual(len(a["final"]), 4)

    def test_duplicate_ids_in_the_index_are_dropped(self):
        pool = fake_pool(30)
        index = {"dataRoot": "C:/data", "voices": {"v": {"clips": [{"id": "v/1", "d": 3.0, "t": "a b c d", "p": "a.wav"}, {"id": "v/1", "d": 3.0, "t": "a b c d", "p": "b.wav"}],
                                                         "loudMedian": None, "live": {}, "proposed": {}}}}
        self.assertEqual(len(common.VoicePool(index, "v").clips), 1)
        self.assertEqual(len({c.id for c in pool.clips}), len(pool.clips))

    def test_tiny_pool_is_refused(self):
        self.assertFalse(common.split_voice(fake_pool(4))["ok"])


if __name__ == "__main__":
    unittest.main()
