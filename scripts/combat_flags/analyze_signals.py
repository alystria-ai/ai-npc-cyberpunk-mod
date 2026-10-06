"""Summarize which game-data signals could mark a line as combat / shouted (task 4 evidence).

Reads scene-lines.jsonl + scene-index.jsonl and prints / writes OUT/validation/signals.json:
  * vo_context x category, voiceset bark trigger x vo_context (the per-line Combat flag lives in voiceset scenes)
  * non-voiceset scenes whose lines carry Vo_Context_Combat
  * scene-name / entry-point / interruption-scenario cues (fight, combat, boss, shootout...) vs the vo_context
    actually stored on their lines (shows how reliable name cues are)
  * scenes with questCombatNodeDefinition / questVoicesetManager nodes / AI manager nodes

    set PYTHONUTF8=1
    python scripts/combat_flags/analyze_signals.py
"""
import collections
import json
import re
from pathlib import Path

OUT = Path(r'E:\CyberpunkConvai-offload\work\combat-flags')
BS = chr(92)
NAME = re.compile(r'fight|combat|boss|shootout|battle|brawl|melee|firefight|gunfight|attack|ambush|raid|assault|chase|escape', re.I)


def main():
    idx = {}
    for ln in open(OUT / 'scene-index.jsonl', encoding='utf-8'):
        r = json.loads(ln)
        idx[r['scene']] = r
    res = {}
    ctx_cat = collections.defaultdict(collections.Counter)
    bark_ctx = collections.defaultdict(collections.Counter)
    comb_nonvs = collections.Counter()
    comb_nonvs_ex = {}
    cue = collections.defaultdict(collections.Counter)
    scene_ctx = collections.defaultdict(collections.Counter)
    for ln in open(OUT / 'scene-lines.jsonl', encoding='utf-8'):
        r = json.loads(ln)
        if r['dup_of']:
            continue  # canonical scenes only
        ctx = r['vo_context'].replace('Vo_Context_', '')
        ctx_cat[r['cat']][ctx] += 1
        scene_ctx[r['scene']][ctx] += 1
        if r['cat'] == 'voiceset':
            for b in (r.get('bark') or ['<no-bark-map>']):
                bark_ctx[b][ctx] += 1
        elif ctx == 'Combat':
            comb_nonvs[r['scene']] += 1
            comb_nonvs_ex.setdefault(r['scene'], (r['text'], r['speaker'], r['entry']))
    res['vo_context_by_cat_canonical'] = {k: dict(v) for k, v in ctx_cat.items()}
    res['voiceset_bark_trigger_by_context'] = {k: dict(v) for k, v in sorted(bark_ctx.items(), key=lambda kv: -sum(kv[1].values()))}
    res['non_voiceset_scenes_with_combat_lines'] = [
        {'scene': s, 'combat_lines': n, 'of': sum(scene_ctx[s].values()), 'cat': idx[s]['cat'], 'example': comb_nonvs_ex[s]}
        for s, n in comb_nonvs.most_common(60)]
    res['n_non_voiceset_scenes_with_combat_lines'] = len(comb_nonvs)
    # name cues
    def cue_scene(s):
        r = idx[s]
        out = []
        if NAME.search(s.split(BS)[-1]):
            out.append('scene-file-name')
        if any(NAME.search(e or '') for e in r['entry_points']):
            out.append('entry-point-name')
        if any(NAME.search(e or '') for e in r['interruption_scenarios']):
            out.append('interruption-scenario')
        if r['quest_node_types'].get('questCombatNodeDefinition'):
            out.append('questCombatNode')
        if r['quest_node_types'].get('questVoicesetManagerNodeDefinition'):
            out.append('questVoicesetManagerNode')
        if r['quest_node_types'].get('questPuppetAIManagerNodeDefinition'):
            out.append('questPuppetAIManagerNode')
        if r['n_play_voiceset']:
            out.append('questPlayVoiceset')
        return out
    for s, r in idx.items():
        if r['dup_of'] or r['cat'] == 'voiceset' or not r['n_lines']:
            continue
        for c in cue_scene(s) or ['<none>']:
            cue[c]['scenes'] += 1
            cue[c]['lines'] += r['n_lines']
            cue[c]['combat_ctx_lines'] += r['vo_context'].get('Vo_Context_Combat', 0)
            cue[c]['community_ctx_lines'] += r['vo_context'].get('Vo_Context_Community', 0)
    res['name_cues_non_voiceset_canonical'] = {k: dict(v) for k, v in cue.items()}
    inter = collections.Counter()
    for s, r in idx.items():
        if r['dup_of']:
            continue
        for n in r['interruption_scenarios']:
            if n and n.lower() in ('combat', 'distract'):
                inter[n] += 1
    res['interruption_combat_named_scenes'] = dict(inter)
    cats = collections.Counter(r['cat'] for r in idx.values() if not r['dup_of'])
    res['canonical_scenes_by_cat'] = dict(cats)
    res['canonical_scenes'] = sum(cats.values())
    (OUT / 'validation').mkdir(exist_ok=True)
    (OUT / 'validation' / 'signals.json').write_text(json.dumps(res, indent=1, ensure_ascii=False), encoding='utf-8')
    for k in ('vo_context_by_cat_canonical', 'name_cues_non_voiceset_canonical', 'interruption_combat_named_scenes', 'canonical_scenes_by_cat', 'canonical_scenes', 'n_non_voiceset_scenes_with_combat_lines'):
        print(k, json.dumps(res[k], indent=1))
    print('bark triggers (top 40):')
    for k, v in list(res['voiceset_bark_trigger_by_context'].items())[:40]:
        print(' ', k, v)


if __name__ == '__main__':
    main()
