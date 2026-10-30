"""Checks of bridge/voice_clip_build.py that need no game: the hash of a depot path, the 16-bit writer, the exact gain, the archive reader on a made-up archive and the join."""
import hashlib
import json
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import voice_clip_build as V  # noqa: E402


def tiny_archive(path: Path, files: dict[str, bytes]) -> None:
    """A made-up RDAR version 12 file: header, the files back to back, then the index (entries, segments)."""
    body, entries, segments = bytearray(), [], []
    for name, data in files.items():
        segments.append((20 + len(body), len(data), len(data)))
        body += data
        entries.append((V.depot_hash(name), len(segments) - 1, hashlib.sha1(data).digest()))
    entries.sort()
    index = struct.pack("<IIQIII", 0, 0, 0, len(entries), len(segments), 0) + b"\0" * 0
    index = index[:28] if len(index) >= 28 else index.ljust(28, b"\0")
    for hash_, first, sha in entries:
        index += struct.pack("<QqIIIII", hash_, 0, 0, first, first + 1, 0, 0) + sha
    for offset, size, decoded in segments:
        index += struct.pack("<QII", offset, size, decoded)
    header = struct.pack("<4sIQI", b"RDAR", 12, 20 + len(body), len(index))
    path.write_bytes(header + bytes(body) + index)


class VoiceClipBuild(unittest.TestCase):
    def test_depot_hash_is_fnv1a_of_the_lower_case_backslash_path(self):
        self.assertEqual(V.depot_hash("A/B"), V.depot_hash("a" + chr(92) + "b"))
        value = 0xCBF29CE484222325
        for byte in b"a" + bytes([92]) + b"b":
            value = ((value ^ byte) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
        self.assertEqual(V.depot_hash("a/b"), value)

    def test_writer_rounds_down_with_the_soundfile_margin(self):
        x = np.array([0.0, -2.8e-23, -1e-9, 1.0 / 32768, 1.5 / 32768, -0.5 / 32768, 1.0, -1.0, 2.0], dtype=np.float32)
        self.assertEqual(V.quantise_sf(x).tolist(), [0, 0, -1, 1, 1, -1, 32767, -32768, 32767])

    def test_the_js_writer_rounds_halves_up_and_clips(self):
        x = np.array([0.5 / 32767, -0.5 / 32767, 1.0, 2.0, -2.0], dtype=np.float64)
        self.assertEqual(V.quantise_js(x).tolist(), [1, 0, 32767, 32767, -32767])

    def test_exact_gain_finds_the_gain_and_none_when_there_is_none(self):
        rng = np.random.default_rng(5)
        raw = (rng.standard_normal(20000) * 3000).astype(np.int16)
        gained = V.quantise_sf(V.apply_gain(raw, 2.3456))
        found = V.exact_gain(raw, gained)
        self.assertIsNotNone(found)
        self.assertTrue(np.array_equal(V.quantise_sf(V.apply_gain(raw, found)), gained))
        self.assertIsNone(V.exact_gain(raw, np.flip(gained)))
        self.assertIsNone(V.exact_gain(raw[:10], gained))

    def test_the_reader_finds_a_file_checks_its_hash_and_says_none_for_a_missing_one(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "lang_en_voice.archive"
            tiny_archive(path, {"base/localization/en-us/vo/a_f_1.wem": b"first", "base/localization/en-us/vo/b_f_2.wem": b"second line"})
            archive = V.Archive(path, V.Oodle(Path(folder)))
            self.assertEqual(archive.read("BASE/localization/en-us/vo/b_f_2.wem"), b"second line")
            self.assertEqual(archive.read("base/localization/en-us/vo/a_f_1.wem"), b"first")
            self.assertIsNone(archive.read("base/nothing.wem"))
            raw = bytearray(path.read_bytes())
            raw[20] ^= 1                                    # a changed byte in the first file
            path.write_bytes(bytes(raw))
            with self.assertRaises(V.BuildError):
                V.Archive(path, V.Oodle(Path(folder))).read("base/localization/en-us/vo/a_f_1.wem")

    def test_a_game_with_no_english_voice_archive_is_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(FileNotFoundError):
                V.open_archives(Path(folder))

    def test_clips_are_joined_with_four_tenths_of_a_second_of_silence(self):
        with tempfile.TemporaryDirectory() as folder:
            line = np.array([0.25, -0.25, 0.5], dtype=np.float32)
            cache = {("a", "poly"): line, ("b", "poly"): line}
            spec = {"lines": [{"path": "a", "archive": "content", "how": "poly"}, {"path": "b", "archive": "content", "how": "poly"}], "writer": "sf", "gainDb": None}
            samples = V.build_clip(spec, {}, Path(folder) / "none.exe", cache)
            self.assertEqual(len(samples), 3 + V.GAP_SAMPLES + 3)
            self.assertEqual(samples[:3].tolist(), [8192, -8192, 16384])
            self.assertFalse(samples[3:3 + V.GAP_SAMPLES].any())
            target = Path(folder) / "x" / "clip.wav"
            V.write_wav(target, samples)
            with wave.open(str(target), "rb") as handle:
                self.assertEqual((handle.getnchannels(), handle.getsampwidth(), handle.getframerate(), handle.getnframes()), (1, 2, 24000, len(samples)))

    def test_the_numpy_torch_resampler_matches_the_torch_one_within_a_step(self):
        try:
            import torch  # noqa: F401
        except ImportError:
            self.skipTest("no torch")
        rng = np.random.default_rng(2)
        signal = (rng.standard_normal(9000) * 0.1).astype(np.float32)
        a, b = V.resample_torch_style(signal, 48000), V.resample_torch_numpy(signal, 48000)
        self.assertEqual(len(a), len(b))
        self.assertLess(float(np.abs(a - b).max()), 1e-6)


if __name__ == "__main__":
    unittest.main()
