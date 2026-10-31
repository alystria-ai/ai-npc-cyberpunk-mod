"""Unit tests for the pure parts of voice_models.py and build_model_voices.py (run: python -m unittest scripts/cast-sweep/test_voice_models.py from the repo root)."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


vm = load("voice_models")


class VoiceOfStem(unittest.TestCase):
    def test_generic_models_are_recognised_with_any_group_after_them(self):
        self.assertEqual(vm.voice_of_stem("civ_high_m_07_enus_40_ziggy"), ("model", "civ_high_m_07_enus_40"))
        self.assertEqual(vm.voice_of_stem("gang_val_m_04_mex_40_sq029"), ("model", "gang_val_m_04_mex_40"))
        self.assertEqual(vm.voice_of_stem("ncpd_mid_m_04_jap_40"), ("model", "ncpd_mid_m_04_jap_40"))
        self.assertEqual(vm.voice_of_stem("sec_high_m_10_mex_30_q307"), ("model", "sec_high_m_10_mex_30"))

    def test_a_named_tag_is_the_words_before_the_group(self):
        self.assertEqual(vm.voice_of_stem("fredrik_sts_wat_nid_04"), ("tag", "fredrik"))
        self.assertEqual(vm.voice_of_stem("sasquatch_q110"), ("tag", "sasquatch"))

    def test_effect_stems_never_count(self):
        for stem in ("ybimb_1_radio", "civ_mid_f_21_enus_25_holocall", "wns_news_05"):
            self.assertTrue(vm.NO_VOICE_STEM.search(stem), stem)


if __name__ == "__main__":
    unittest.main()
