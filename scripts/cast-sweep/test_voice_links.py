"""Unit tests for the pure helpers of voice_links.py (run: python -m unittest scripts/cast-sweep/test_voice_links.py from the repo root)."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("voice_links", HERE / "voice_links.py")
vl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vl)


class TagRules(unittest.TestCase):
    def test_tag_and_group_split(self):
        self.assertEqual(vl.tag_of("fredrik_sts_wat_nid_04"), ("fredrik", "sts_wat_nid_04"))
        self.assertEqual(vl.tag_of("sasquatch_q110"), ("sasquatch", "q110"))
        self.assertEqual(vl.tag_of("micheal_maldonado_sts_ep1_06"), ("micheal_maldonado", "sts_ep1_06"))
        self.assertEqual(vl.tag_of("tom"), ("tom", ""))

    def test_generic_and_role_tags_are_never_a_person(self):
        for tag in ("civ_high_f_07_enus_40", "gang_val_m_04_mex_40", "ncpd_mid_m_04_jap_40", "sec_high_m_10_mex_30", "v", "mq304_assassin_male", "lizzies_boss", "riot_barman", "trauma_team_paramedic"):
            self.assertIsNotNone(vl.is_generic(tag), tag)
        for tag in ("fredrik", "roh_chi_won", "mark_muratovitch", "scorpion", "sasquatch", "reverend_colver"):
            self.assertIsNone(vl.is_generic(tag), tag)

    def test_record_group(self):
        self.assertEqual(vl.record_group("Character.sts_wat_nid_04_fredrik"), ("sts_wat_nid_04", "fredrik"))
        self.assertEqual(vl.record_group("Character.q110_animals_boss"), ("q110", "animals_boss"))
        self.assertEqual(vl.record_group("Character.Scorpion"), (None, "scorpion"))

    def test_a_one_letter_slip_in_a_first_word(self):
        self.assertTrue(vl.slip("micheal", "michael"))
        self.assertTrue(vl.slip("jon", "john") is False)           # too short to trust
        self.assertFalse(vl.slip("michael", "michael"))
        self.assertFalse(vl.slip("daniel", "samuel"))
        self.assertFalse(vl.slip("annabel", "rannabel"))           # a different first letter

    def test_name_words_keep_nicknames_apart(self):
        self.assertEqual(vl.name_words('Driss "Scorpion" Meriana'), (["driss", "meriana"], ["scorpion"]))
        self.assertEqual(vl.name_words("Roh Chi-Won")[0], ["roh", "chi", "won"])


if __name__ == "__main__":
    unittest.main()
