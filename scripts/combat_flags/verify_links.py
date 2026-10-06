"""Verify cross-links between voiceset scenes, the voice-tag registry, quest scenes and the installed TweakDB/redscripts.

  a) voicetaglist.voicetags (voice id -> voiceTag -> voicesetScenePath) vs the voiceset .scene files and the
     voicetagId carried by their actor.
  b) questPlayVoiceset nodes in quest scenes (voicesetName) vs the entry-point / bark names of voiceset scenes.
  c) are the bark trigger names also literal strings in tweakdb.bin / tweakdb_ep1.bin / final.redscripts?
Writes OUT/validation/links.json and prints it.

    set PYTHONUTF8=1
    python scripts/combat_flags/verify_links.py
"""
import collections
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(r'E:\CyberpunkConvai-offload\work\combat-flags')
GAME = Path(r'E:\SteamLibrary\steamapps\common\Cyberpunk 2077')
VER = re.compile(r'\\versions\\[^\\]+')
TAGDIR = ROOT / 'runtime/voice-data-expansion-20261004/scene-inventory/non-scene-discovery/voice-tags'


def main():
    res = {}
    reg = {}
    for n in ('base', 'ep1'):
        doc = json.loads((TAGDIR / n / 'voicetaglist.voicetags.json').read_text(encoding='utf-8'))
        for v in doc['Data']['RootChunk']['voiceTags']:
            reg[str(v['id'])] = (v['voiceTag']['$value'], (v.get('voicesetScenePath') or '').lower(), n)
    res['registry_rows'] = len(reg)
    res['registry_rows_with_voiceset_scene_path'] = sum(1 for t, p, n in reg.values() if p)
    idx = {}
    for ln in open(OUT / 'scene-index.jsonl', encoding='utf-8'):
        r = json.loads(ln)
        idx[r['scene'].lower()] = r
    # a) registry vs voiceset scenes
    vs_scene_voice = collections.defaultdict(set)
    for ln in open(OUT / 'scene-lines.jsonl', encoding='utf-8'):
        r = json.loads(ln)
        if r['cat'] == 'voiceset':
            vs_scene_voice[r['scene'].lower()].add(r['speaker_voice_id'])
    c = collections.Counter()
    for sc, vids in vs_scene_voice.items():
        c['voiceset_scenes_with_lines'] += 1
        known = [reg[v] for v in vids if v in reg]
        if not known:
            c['no_registry_entry_for_actor_voicetag'] += 1
        elif any(p == VER.sub('', sc) for _, p, _ in known):
            c['registry_voiceset_path_equals_scene'] += 1
        elif any(p for _, p, _ in known):
            c['registry_path_names_a_different_scene'] += 1
        else:
            c['registry_entry_has_empty_voiceset_path'] += 1
    res['voiceset_scene_vs_registry'] = dict(c)
    res['registry_voiceset_paths_that_exist_as_installed_scene'] = sum(1 for t, p, n in reg.values() if p and p in idx)
    res['registry_voiceset_paths_missing_from_install'] = sum(1 for t, p, n in reg.values() if p and p not in idx)
    # b) quest scenes that trigger voiceset barks by name
    names = collections.Counter()
    bark_names = set()
    for r in idx.values():
        if r['cat'] == 'voiceset':
            bark_names.update(r['entry_points'])
            bark_names.update(r['voinfo_triggers'])
    played = collections.Counter()
    for r in idx.values():
        if r['dup_of']:
            continue
        for p in r['play_voiceset']:
            played[p['voiceset']] += 1
    res['questPlayVoiceset_distinct_names'] = len(played)
    res['questPlayVoiceset_names_that_are_voiceset_scene_entry_names'] = sum(1 for n in played if n in bark_names)
    res['questPlayVoiceset_name_examples_found'] = [n for n in played if n in bark_names][:15]
    res['questPlayVoiceset_name_examples_not_found'] = [n for n in played if n not in bark_names][:15]
    # c) bark names in TweakDB / redscripts
    triggers = set()
    for r in idx.values():
        if r['cat'] == 'voiceset':
            triggers.update(r['voinfo_triggers'])
    triggers = {t for t in triggers if t and not t.startswith('Start')}
    blobs = {f: (GAME / 'r6/cache' / f).read_bytes() for f in ('tweakdb.bin', 'tweakdb_ep1.bin', 'final.redscripts')}
    strs = {f: set(re.findall(rb'[\x20-\x7e]{4,}', b)) for f, b in blobs.items()}
    res['bark_trigger_names_in_voiceset_voinfo'] = len(triggers)
    for f in blobs:
        hit = sorted(t for t in triggers if t.encode() in strs[f])
        res[f'bark_triggers_present_as_exact_string_in_{f}'] = len(hit)
        res[f'examples_{f}'] = hit[:25]
    (OUT / 'validation').mkdir(exist_ok=True)
    (OUT / 'validation' / 'links.json').write_text(json.dumps(res, indent=1), encoding='utf-8')
    print(json.dumps(res, indent=1))


if __name__ == '__main__':
    main()
