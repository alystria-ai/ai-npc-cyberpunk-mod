"""Tests for scripts/combat_flags/source_signal.py and the key handling of the flag consumers (no data files needed).
Run: python -B scripts/combat_flags/test_source_signal.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import source_signal as ss  # noqa: E402


def row(scene, cat="mainQuests", entry=(), context="Vo_Context_Quest", expression="Vo_Expression_Spoken", speaker="smasher", event=None):
    return {"scene": scene, "cat": cat, "entry": list(entry), "vo_context": context, "vo_expression": expression, "custom_vo_event": event, "speaker_tag": speaker}


class TriggerTests(unittest.TestCase):
    def test_norm_trigger(self):
        self.assertEqual(ss.norm_trigger("apuc_battlecry_single_enemy_var_2"), "battlecry_single_enemy")
        self.assertEqual(ss.norm_trigger("rep_ask_to_holster_var_1_courier"), "rep_ask_to_holster")
        self.assertEqual(ss.norm_trigger("tech_floor_hit_reaction"), "hit_reaction")

    def test_combat_alert_and_social_barks(self):
        vset = "base/quest/secondary_characters/vsets/vset_jackie.scene"
        strong = ss.classify_lines([row(vset, "voiceset", ["battlecry_morale_var_2"], "Vo_Context_Combat")])
        self.assertEqual(strong["tier"], "strong")
        alert = ss.classify_lines([row(vset, "voiceset", ["rep_ask_to_leave"], "Vo_Context_Combat")])
        self.assertEqual(alert["tier"], "moderate")
        social = ss.classify_lines([row(vset, "voiceset", ["greeting_var_1"], "Vo_Context_Combat")])
        self.assertEqual(social["tier"], "ambient")
        self.assertEqual(ss.classify_lines([row(vset, "voiceset", ["danger_worried"], "Vo_Context_Combat")])["tier"], "moderate")

    def test_no_scene_is_none(self):
        self.assertEqual(ss.classify_lines([])["tier"], "none")


class SceneTests(unittest.TestCase):
    boss = "base/quest/main_quests/part1/q116/scenes/q116_01_adam_smasher.scene"
    after = "base/quest/main_quests/part1/q116/scenes/q116_03b_after_bossfight.scene"
    memories = "base/quest/main_quests/part1/q101/scenes/q101_06c_memories_p2.scene"

    def test_fight_entry_rules(self):
        self.assertEqual(ss.fight_entry(["q116_bossfight_in"], self.boss), "q116_bossfight_in")
        self.assertIsNone(ss.fight_entry(["q116_03b_after_bossfight_in"], self.after))          # an after-fight conversation
        self.assertIsNone(ss.fight_entry(["q005_09_attack_in"], "q005_09_attack.scene"))          # repeats the scene's own name
        self.assertIsNone(ss.fight_entry(["a_in", "b_in", "c_in", "combat_in"], "x.scene"))       # one fight trigger among many entry points
        self.assertEqual(ss.fight_entry(["Start 2", "q115_12d_bossfight_in"], "q115_12d_mikoshi.scene"), "q115_12d_bossfight_in")

    def test_scene_lines(self):
        self.assertEqual(ss.classify_lines([row(self.boss, entry=["q114", "q116_bossfight_in"])])["tier"], "strong")
        self.assertEqual(ss.classify_lines([row(self.after, entry=["q116_03b_after_bossfight_in"])])["tier"], "conversation")
        self.assertEqual(ss.classify_lines([row(self.memories, entry=["enter_av_in"])])["tier"], "conversation")
        self.assertEqual(ss.classify_lines([row("x/street/sts_std_rcr_01_combat_scene.scene", "streetOpenWorld", ["start"], "Vo_Context_Community")])["tier"], "strong")
        self.assertEqual(ss.classify_lines([row("x/q003_06a_boss_combat.scene", entry=["start"], expression="Vo_Expression_Phone")])["tier"], "conversation")
        self.assertEqual(ss.classify_lines([row("x/mq008_02_shooting_contest.scene", entry=["start"])])["tier"], "moderate")

    def test_combat_context_and_shouting_event(self):
        self.assertEqual(ss.classify_lines([row("x/q003_04_shootout_x.scene", context="Vo_Context_Combat")])["tier"], "strong")
        self.assertEqual(ss.classify_lines([row("x/q110_03.scene", event="vo_q110_sc_03_npc_shouting")])["tier"], "moderate")

    def test_boss_scene_extends_to_the_same_speaker_only(self):
        fights = {self.boss: {"trigger": "q113_13_smasher_low_health_in", "n_fight": 3, "n": 30, "dominant": False, "node": False, "boss": True, "n_boss": 3,
                              "boss_speakers": {"smasher"}}}
        same = ss.classify_lines([row(self.boss, entry=["q113_13_smasher_about_oda_in"], speaker="smasher")], fights)
        other = ss.classify_lines([row(self.boss, entry=["q113_13_takemura_in"], speaker="panam")], fights)
        after = ss.classify_lines([row(self.boss, entry=["q116_after_bossfight_in"], speaker="smasher")], fights)
        self.assertEqual(same["tier"], "strong")
        self.assertEqual(other["tier"], "moderate")
        self.assertEqual(after["tier"], "moderate")        # an "after" entry point keeps the line out of the fight


if __name__ == "__main__":
    unittest.main()
