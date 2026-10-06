"""The game's own combat/shouted-delivery signals for a voice line, read from the scene index (scripts/combat_flags/extract_scenes.py,
distill_scenes.py -> E:/CyberpunkConvai-offload/work/combat-flags/scene-lines.jsonl).

Every voice-over line of the game is played by a scene (.scene file): either a quest/world scene (dialogue) or a voiceset scene
(`vset_<character>.scene`: the gameplay barks of a character).  A scene dialogue line carries the context the game gives it
(`Vo_Context_Quest | Community | Combat | Minor_Activity`), the entry points (bark trigger names such as `battlecry_morale`, `danger`,
`q113_13_smasher_low_health_in`) and a custom VO event; the scene itself has a category and a name (`q110_08c_bossfight`).

classify_lines(rows) turns the occurrences of one string id into a verdict:
    {"tier": "strong" | "moderate" | "ambient" | "conversation" | "none", "reasons": [...], "bark": trigger or None}
  strong        the game marks the line as combat: a voiceset bark with a combat trigger, a line in the Combat voice context, or a
                quest line played by a fight trigger (bossfight / low health / reinforcements ...);
  moderate      combat-adjacent: an alert or reprimand bark, a custom shouting VO event, or a scene whose name says it is a fight;
  ambient       a voiceset bark with a social trigger (greeting, bump, phone, curious ...): a bark, but not a combat delivery;
  conversation  only quest/world dialogue in ordinary scenes;
  none          the string id is not in any scene.
The same module is used by scripts/reference-pool/extract.py so that future extractions skip combat lines at the source.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

SCENE_LINES = Path("E:/CyberpunkConvai-offload/work/combat-flags/scene-lines.jsonl")

_SUFFIX = re.compile(r"(_var_?\d+|_ver_?\d+|_courier|_v\d+|_\d+)$")


def norm_trigger(trigger: str) -> str:
    text = re.sub(r"^(apuc_|tech_floor_)", "", trigger.strip().lower())
    for _ in range(3):
        text = _SUFFIX.sub("", text)
    return text


# Voiceset bark triggers (normalised) -> class.  Shouted, panicked or in-the-fight deliveries.
COMBAT_TRIGGER = re.compile(
    r"^(battlecry\w*|danger|grenade\w*|fear_(run|foll|beg|reaction)|grapple|flank\w*|squad_member_died|hitting_player|stlh_blinded|call_in_confusion|"
    r"taunt\w*|madness\w*|combat_(aggro|despair|blinded|quick_hack|ally_(cover|warning))\w*|buff|\w+_charge|attack_fragile\w*|call_backup|defeated\w*|"
    r"reloading|heavy_reloading|hit_reaction|kill|attacked\w*|quickhacked|coop_reports_kill|coop_irritation|ccop_praise|coop_praise|player_fallback|"
    r"(enemy|elite|turret|heavy|sniper|netrunner|mech|drones|octant|camera|detection)_warning|yelling\w*|smasher_\w+|q\d+_\d+_smasher_bossfight_start|"
    r"mask_destroyed|revealed|cover_(order|reaction)|rep_call_guard|scene_johnny_shoot)$")
# Alert, threat and stealth-alert barks: delivery is often raised but is not necessarily a shout.
ALERT_TRIGGER = re.compile(r"^(rep_\w+|stlh_\w+|stlth_\w+|stealth_warning_bark|body_warning|combat_ended|warning_\w+|danger_\w+|urge_impatient|reaction_hostiles|scene_insult|scene_crowd)$")

# Entry points of quest scenes: a fight trigger (the scene line is played during a fight).
FIGHT_ENTRY = re.compile(r"(bossfight|boss_fight|low_health|reinforcement|battlecry|aggro|combat|fight_start|hitting|attack|shoot)", re.I)
ENTRY_NEGATION = re.compile(r"(after|post|pre_|before|intro|outro|aftermath|end_|ended|_end\b|finish|dead|death_talk)", re.I)

# Scene file names that say the scene is (or is played during) a fight; "after_bossfight" and similar are conversations.
FIGHT_SCENE = re.compile(r"(fight|boss|combat|battle|shootout|gunfight|firefight|ambush|assault|raid|brawl|riot|duel|chase|attack|massacre|shooting)")
SCENE_NEGATION = re.compile(r"(after|post_|_post|pre_|_pre|before|intro|outro|aftermath|talk|debrief|dialog|conversation|discuss|about|memories|tutorial|lizzies_boss|boss_clean|meeting|zone)")
# Triggers that only exist in boss fights and big set-piece fights; a scene with two or more such triggers is a fight scene.
BOSS_ENTRY = re.compile(r"(bossfight|boss_fight|low_health)", re.I)

# Names that say the scene IS the fight (spoken lines there are in-fight dialogue); the looser FIGHT_SCENE words are only moderate evidence.
FIGHT_NAME_STRONG = re.compile(r"(boss_?fight|boss_combat|bossfight|(^|_)combat(_|$)|fistfight|shootout|firefight|gunfight|(^|_)fight(_|$))")
SHOUT_EVENT = re.compile(r"(shout|yell|scream|loud|megaphone)", re.I)

QUEST_CATS = {"mainQuests", "sideQuests", "minorQuests", "dialoguesQuests"}


def scene_stem(scene: str) -> str:
    return scene.replace("\\", "/").rsplit("/", 1)[-1].removesuffix(".scene").lower()


def fight_scene(scene: str) -> bool:
    stem = scene_stem(scene)
    return bool(FIGHT_SCENE.search(stem)) and not SCENE_NEGATION.search(stem)


def fight_entry(entries, scene: str = "") -> str | None:
    """The first entry point that is a fight trigger, when at least half of the line's entry points are (a line of a big branching scene
    has dozens of entry points; an entry that merely repeats the scene's own name does not count)."""
    stem = scene_stem(scene) if scene else ""
    entries = list(entries or [])
    hits = [e for e in entries if not (stem and e.lower().startswith(stem)) and FIGHT_ENTRY.search(e) and not ENTRY_NEGATION.search(e)]
    return hits[0] if hits and len(hits) * 2 >= len(entries) else None


def classify_lines(rows: list[dict], fight_scenes: dict[str, dict] | None = None) -> dict:
    """Verdict for one string id from every scene occurrence (rows of scene-lines.jsonl).

    fight_scenes: scene path -> {trigger, n_fight, n, dominant, node} (load_by_sid builds it).  When at least half of a scene's lines (and two or
    more) are played by fight triggers, the scene is a fight and all its lines are in-fight dialogue (strong); with a few fight triggers or a
    fight-like name the evidence is moderate; a combat quest node alone is weak."""
    fight_scenes = fight_scenes or {}
    if not rows:
        return {"tier": "none", "reasons": [], "bark": None}
    strong, moderate, weak, ambient, conversation = [], [], [], [], 0
    bark = None
    for row in rows:
        scene, cat, context = row["scene"], row["cat"], (row.get("vo_context") or "").replace("Vo_Context_", "")
        stem = scene_stem(scene)
        expression = (row.get("vo_expression") or "").replace("Vo_Expression_", "")
        if cat == "voiceset":
            triggers = sorted({norm_trigger(t) for t in row.get("entry") or []})
            combat = [t for t in triggers if COMBAT_TRIGGER.match(t)]
            alert = [t for t in triggers if ALERT_TRIGGER.match(t)]
            if combat:
                strong.append(f"voiceset bark '{combat[0]}' ({stem})"); bark = bark or combat[0]
            elif alert:
                moderate.append(f"alert/threat bark '{alert[0]}' ({stem})"); bark = bark or alert[0]
            elif context == "Combat" or context == "Minor_Activity":
                ambient.append(f"social bark '{triggers[0] if triggers else '?'}' ({stem})"); bark = bark or (triggers[0] if triggers else None)
            else:
                conversation += 1
            continue
        if context == "Combat":
            strong.append(f"scene line in the Combat voice context ({stem})")
        entry = fight_entry(row.get("entry"), scene)
        if entry:
            strong.append(f"played by fight trigger '{entry}' ({stem})")
        elif (scene in fight_scenes and fight_scenes[scene]["boss"] and row.get("speaker_tag") in fight_scenes[scene]["boss_speakers"]
              and not any(ENTRY_NEGATION.search(e) for e in row.get("entry") or [])):
            info = fight_scenes[scene]
            strong.append(f"line of a boss-fight scene, same speaker as the fight-triggered lines ({info['n_boss']} boss triggers, e.g. '{info['trigger']}') ({stem})")
        elif scene in fight_scenes and fight_scenes[scene]["dominant"]:
            info = fight_scenes[scene]
            strong.append(f"line of a fight scene ({info['n_fight']} of {info['n']} lines are played by fight triggers, e.g. '{info['trigger']}') ({stem})")
        elif scene in fight_scenes and fight_scenes[scene]["trigger"]:
            moderate.append(f"scene with fight triggers ('{fight_scenes[scene]['trigger']}') ({stem})")
        elif fight_scene(scene) and expression in ("Spoken", "") and FIGHT_NAME_STRONG.search(stem):
            strong.append(f"line of a scene named as a fight ({stem})")
        elif fight_scene(scene) and expression in ("Spoken", ""):
            moderate.append(f"scene named like a fight ({stem})")
        elif scene in fight_scenes and fight_scenes[scene]["node"]:
            weak.append(f"scene has a combat quest node ({stem})")
        event = row.get("custom_vo_event")
        if event and SHOUT_EVENT.search(event):
            moderate.append(f"custom VO event '{event}'")
        if not (context == "Combat" or entry or fight_scene(scene) or (scene in fight_scenes and (fight_scenes[scene]["trigger"] or fight_scenes[scene]["node"])) or (event and SHOUT_EVENT.search(event))):
            conversation += 1
    if strong:
        return {"tier": "strong", "reasons": sorted(set(strong))[:3], "bark": bark}
    if moderate:
        return {"tier": "moderate", "reasons": sorted(set(moderate))[:3], "bark": bark}
    if weak:
        return {"tier": "weak", "reasons": sorted(set(weak))[:2], "bark": bark}
    if ambient and not conversation:
        return {"tier": "ambient", "reasons": sorted(set(ambient))[:2], "bark": bark}
    return {"tier": "conversation", "reasons": [], "bark": bark}


def load_by_sid(path: Path = SCENE_LINES, index_path: Path | None = None) -> tuple[dict[str, list[dict]], dict[str, dict]]:
    """(string id (decimal) -> its scene occurrences (compact rows), scene path -> fight info for scenes with fight triggers or a combat quest node)."""
    by_sid: dict[str, list[dict]] = {}
    count: dict[str, list] = {}                      # scene -> [lines, fight lines, first trigger, boss-trigger lines, boss speakers]
    keep = ("scene", "cat", "entry", "vo_context", "custom_vo_event", "vo_expression", "visual_style", "speaker_tag")
    with Path(path).open(encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            if row.get("dup_of"):
                continue
            compact = {k: row.get(k) for k in keep}
            if row["cat"] != "voiceset":
                entry = count.setdefault(row["scene"], [0, 0, None, 0, set()])
                entry[0] += 1
                trigger = fight_entry(row.get("entry"), row["scene"])
                if trigger:
                    entry[1] += 1
                    entry[2] = entry[2] or trigger
                    if BOSS_ENTRY.search(trigger):
                        entry[3] += 1
                        entry[4].add(row.get("speaker_tag"))
            for sid in row.get("sid") or []:
                by_sid.setdefault(str(sid), []).append(compact)
    nodes = set()
    index_path = index_path or path.with_name("scene-index.jsonl")
    if index_path.is_file():
        with index_path.open(encoding="utf-8") as stream:
            for line in stream:
                row = json.loads(line)
                if any("Combat" in name for name in (row.get("quest_node_types") or {})):
                    nodes.add(row["scene"])
    fight_scenes = {}
    for scene, (total, fights, trigger, boss, boss_speakers) in count.items():
        if fights or scene in nodes:
            fight_scenes[scene] = {"trigger": trigger, "n_fight": fights, "n": total, "dominant": fights >= 2 and fights * 2 >= total, "node": scene in nodes,
                                   "boss": boss >= 2, "n_boss": boss, "boss_speakers": boss_speakers}
    return by_sid, fight_scenes
