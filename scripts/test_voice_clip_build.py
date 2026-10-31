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


class LanguageClips(unittest.TestCase):
    """The dub (language pack) clips: the pack builder's recipe (float lines, no 16-bit file between, linear gain, rint writer) from a made-up dub archive."""

    def test_the_pack_writer_is_rint_and_the_gain_is_linear_in_double_precision(self):
        x = np.array([0.0, 0.4 / 32767, 1.6 / 32767, -0.4 / 32767, 1.0, -1.0, 0.4], dtype=np.float32)
        self.assertEqual(V.quantise_pack(x).tolist(), [0, 0, 2, 0, 32767, -32767, 13107])
        self.assertEqual(V.quantise_pack(x, 2.0).tolist(), [0, 1, 3, -1, 32767, -32767, 26214])

    def test_exact_pack_gain_finds_the_factor_and_none_when_there_is_none(self):
        rng = np.random.default_rng(11)
        joined = (rng.standard_normal(30000) * 0.05).astype(np.float32)
        shipped = V.quantise_pack(joined, 3.1416)
        found = V.exact_pack_gain(joined, shipped)
        self.assertIsNotNone(found)
        self.assertTrue(np.array_equal(V.quantise_pack(joined, found), shipped))
        self.assertIsNone(V.exact_pack_gain(joined, np.flip(shipped)))
        self.assertIsNone(V.exact_pack_gain(joined[:10], shipped))
        hot = (rng.standard_normal(30000) * 0.4).astype(np.float32)
        clipped = V.quantise_pack(hot, 4.0)
        self.assertTrue((np.abs(clipped) == 32767).any())
        self.assertTrue(np.array_equal(V.quantise_pack(hot, V.exact_pack_gain(hot, clipped)), clipped))

    def test_a_pack_line_is_the_mono_mean_resampled_in_float32_with_no_16_bit_file_between(self):
        from scipy.signal import resample_poly
        rng = np.random.default_rng(3)
        stereo = (rng.standard_normal((4800, 2)) * 0.1).astype(np.float32)
        made = V.pack_line_to_24k(stereo, 48000, "pack")
        expected = resample_poly(stereo.mean(axis=1, dtype=np.float32), 1, 2).astype(np.float32)
        self.assertTrue(np.array_equal(made, expected))
        self.assertFalse(np.array_equal(made, V.dequantise(V.quantise_sf(expected))), "not rounded to 16 bits")
        same = np.zeros((10, 1), dtype=np.float32)
        self.assertEqual(len(V.pack_line_to_24k(same, 24000, "pack")), 10)

    def test_v_keeps_the_left_channel_of_decorrelated_channels_and_trims_the_silence(self):
        rate = 24000
        tone = (np.sin(np.arange(rate) * 0.05) * 0.3).astype(np.float32)
        silence = np.zeros(rate, dtype=np.float32)
        left = np.concatenate([silence, tone, silence])
        # the right channel is silent: the mean is half the left, so the left alone is kept (not the mean) and the silence at both ends is cut with 80 ms of margin
        made = V.pack_line_to_24k(np.stack([left, np.zeros_like(left)], axis=1), rate, "packv")
        self.assertLess(len(made), len(left))
        self.assertGreater(len(made), rate)
        self.assertLess(len(made), rate + 2 * int(0.08 * rate) + 480)
        self.assertAlmostEqual(float(np.abs(made).max()), 0.3, places=2)
        both = V.pack_line_to_24k(np.stack([left, left], axis=1), rate, "packv")
        self.assertEqual(len(both), len(made))

    def test_a_language_clip_is_built_from_the_dub_archive_and_the_missing_archive_is_reported(self):
        locale = "de-de"
        with tempfile.TemporaryDirectory() as folder:
            game = Path(folder) / "game"
            (game / "archive" / "pc" / "content").mkdir(parents=True)
            (game / "archive" / "pc" / "ep1").mkdir(parents=True)
            tiny_archive(game / "archive" / "pc" / "content" / "lang_de_voice.archive", {f"base\\localization\\{locale}\\vo\\a_f_0000000000000001.wem": b"one"})
            tiny_archive(game / "archive" / "pc" / "ep1" / "lang_de_voice.archive", {f"ep1\\localization\\{locale}\\vo\\b_m_0000000000000002.wem": b"two"})
            archives = V.open_language_archives(game, "de")
            self.assertEqual(sorted(archives), ["content", "ep1"])
            lines = {b"one": np.array([[0.25], [-0.5]], dtype=np.float32), b"two": np.array([[0.125], [0.0]], dtype=np.float32)}
            original = V.decode_wem
            V.decode_wem = lambda vgmstream, wem, priority=0: (lines[wem], V.RATE)
            try:
                spec = {"lines": [["content", "vo\\a_f_0000000000000001.wem"], ["ep1", "vo\\b_m_0000000000000002.wem"]], "how": "pack", "gain": None}
                samples = V.build_language_clip(spec, locale, archives, Path("none.exe"))
                self.assertEqual(len(samples), 2 + V.GAP_SAMPLES + 2)
                self.assertEqual(samples[:2].tolist(), [8192, -16384])
                self.assertEqual(samples[2 + V.GAP_SAMPLES:].tolist(), [4096, 0])
                self.assertFalse(samples[2:2 + V.GAP_SAMPLES].any())
                self.assertEqual(V.build_language_clip({**spec, "gain": 2.0}, locale, archives, Path("none.exe"))[:2].tolist(), [16384, -32767])
                with self.assertRaises(V.BuildError):
                    V.build_language_clip({**spec, "lines": [["content", "vo\\missing_f_0000000000000009.wem"]]}, locale, archives, Path("none.exe"))
                only_content = {"content": archives["content"]}
                with self.assertRaises(V.BuildError):
                    V.build_language_clip(spec, locale, only_content, Path("none.exe"))
            finally:
                V.decode_wem = original
            with self.assertRaises(FileNotFoundError):
                V.open_language_archives(Path(folder) / "empty", "fr")
            (game / "archive" / "pc" / "ep1" / "lang_de_voice.archive").unlink()
            self.assertEqual(sorted(V.open_language_archives(game, "de")), ["content"], "Phantom Liberty not installed: the base game's archive alone opens")

    def test_the_language_file_name_check_refuses_a_path_outside_the_language_folder(self):
        for good in ("picked/panam-palmer.wav", "archetypes/npc-maelstrom-male-v2.wav", "v-voice/v-male.wav"):
            self.assertTrue(V.LANGUAGE_FILE.match(good), good)
        for bad in ("../x.wav", "picked/../x.wav", "other/x.wav", "picked/x.mp3", "/picked/x.wav", "picked\\x.wav"):
            self.assertFalse(V.LANGUAGE_FILE.match(bad), bad)


if __name__ == "__main__":
    unittest.main()
