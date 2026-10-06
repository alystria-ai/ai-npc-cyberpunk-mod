"""Distil WolvenKit-serialized .scene JSON into scene-lines.jsonl and scene-index.jsonl.

Input : OUT/scenes-raw/{base,ep1}/<depot path>.scene(.json)   (see extract_scenes.py)
Output: OUT/scene-lines.jsonl  one row per scnDialogLineEvent
        OUT/scene-index.jsonl  one row per scene
        OUT/scene-orphan-items.jsonl  screenplay lines not referenced by any dialog event + player choice options (sid joins)
Column meanings are documented in OUT/STATUS.md.

The line -> string-id join is the verified one: scnDialogLineEvent.screenplayLineId.id is matched against
screenplayStore.lines[].itemId.id (NOT the array position); that line's locstringId.ruid is the subtitle
stringId / the 16-hex tail of the VO .wem name.  Speaker comes from the screenplay line (speaker actor id),
resolved through actors[] and the voicetaglist.voicetags registry (actor.voicetagId -> voiceTag name).

    set PYTHONUTF8=1
    python scripts/combat_flags/distill_scenes.py [--workers 4] [--limit N]
"""
import argparse
import hashlib
import json
import multiprocessing as mp
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(r'E:\CyberpunkConvai-offload\work\combat-flags')
VOICETAG_FILES = [ROOT / 'runtime/voice-data-expansion-20261004/scene-inventory/non-scene-discovery/voice-tags' / n / 'voicetaglist.voicetags.json'
                  for n in ('base', 'ep1')]

COMBAT_RE = re.compile(r'combat|fight|\bboss|shootout|battle|brawl|melee|firefight|gunfight|attack|assault|hostile|aggro|'
                       r'enemy|enemies|ambush|explo|grenade|shoot|damage|kill|weapon|pistol|rifle|shotgun|katana|punch|'
                       r'stagger|knock|bark|taunt|battlecry|scream|shout|yell|danger|panic|flee|scared|threat|alert|wound|dying',
                       re.I)
NAME_RE = re.compile(r'fight|combat|boss|shootout|battle|brawl|melee|firefight|gunfight|attack|ambush|raid|assault|chase|escape|low_health|reinforce|kill|death|dies|defeat|bark|shout|yell|scream|panic|danger|alarm|riot|explo', re.I)
COMBAT_EVENT_RE = re.compile(r'Damage|Combat|Attack|Weapon|Shoot|Hit|Equip|Holster|Kill|Death|Ragdoll|Incapac|Stagger|Aim|Fire', re.I)
KNOWN_EV = {'$type', 'additionalSpeakers', 'duration', 'executionTagFlags', 'id', 'scalingData', 'screenplayLineId', 'startTime', 'type', 'visualStyle', 'voParams'}
KNOWN_VO = {'$type', 'alwaysUseBrainGender', 'customVoEvent', 'disableHeadMovement', 'ignoreSpeakerIncapacitation', 'isHolocallSpeaker', 'voContext', 'voExpression'}
KNOWN_SP = {'$type', 'addressee', 'femaleLipsyncAnimationName', 'itemId', 'locstringId', 'maleLipsyncAnimationName', 'speaker', 'usage'}
SKIP_TOP = {'locStore', 'screenplayStore', 'debugSymbols'}
_TAGS = {}


def voicetags():
    if not _TAGS:
        for p in VOICETAG_FILES:
            doc = json.loads(p.read_text(encoding='utf-8'))
            for v in doc['Data']['RootChunk']['voiceTags']:
                _TAGS[str(v['id'])] = {'tag': v['voiceTag']['$value'], 'vset': v.get('voicesetScenePath') or ''}
    return _TAGS


def cn(x):
    """CName / ResourcePath wrapper or plain value -> str."""
    if isinstance(x, dict):
        if '$value' in x:
            return str(x['$value'])
        if 'DepotPath' in x:
            return cn(x['DepotPath'])
    return None if x is None else str(x)


def stu(x):
    return x.get('stu') if isinstance(x, dict) else x


def walk_strings(o, key=''):
    """Yield (key, string) for every CName/ResourcePath/plain string value outside dialogue text tables."""
    if isinstance(o, dict):
        if '$value' in o and isinstance(o['$value'], str):
            yield key, o['$value']
            return
        for k, v in o.items():
            if k == '$type':
                continue
            yield from walk_strings(v, k)
    elif isinstance(o, list):
        for v in o:
            yield from walk_strings(v, key)
    elif isinstance(o, str) and key not in ('content',):
        yield key, o


def anim_names(ev):
    """Animation-ish names carried by one event (scnPlayAnimEvent / scnPlaySkAnimEvent and friends)."""
    out = []
    an = ev.get('animName')
    if isinstance(an, dict):
        d = an.get('Data', an)
        for u in d.get('unk1', []) if isinstance(d, dict) else []:
            out.append(cn(u))
        if '$value' in an:
            out.append(cn(an))
    for k in ('animSet', 'workspotName', 'animationName', 'animName2'):
        if k in ev:
            out.append(cn(ev[k]))
    return [x for x in out if x and x != 'None']


def distill(path, depot, archive):
    raw = Path(str(path)[:-5])  # strip .json
    raw_sha1 = hashlib.sha1(raw.read_bytes()).hexdigest() if raw.exists() else None
    doc = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    r = doc['Data']['RootChunk']
    cat = r.get('sceneCategoryTag')
    tags = voicetags()
    vm = re.search(r'\\versions\\([^\\]+)\\', depot)
    version = vm.group(1) if vm else None  # None = live (unversioned) path
    stem = Path(depot.replace(chr(92), '/')).stem.lower()
    # actors
    actors = {}
    for a in r.get('actors', []):
        vid = str(a.get('voicetagId', {}).get('id', '0'))
        actors[a['actorId']['id']] = {'name': a.get('actorName'), 'voice_id': vid, 'tag': tags.get(vid, {}).get('tag')}
    for a in r.get('playerActors', []):
        actors[a['actorId']['id']] = {'name': a.get('actorName') or 'player', 'voice_id': '0', 'tag': None, 'player': True}
    # screenplay: itemId -> line
    sp = {}
    for kind in ('lines', 'options'):
        for ln in r.get('screenplayStore', {}).get(kind, []):
            sp[(kind, ln['itemId']['id'])] = ln
    # locStore en_us text per locstringId
    payload = r.get('locStore', {}).get('vpEntries', [])
    texts, nvar = {}, Counter()
    for vd in r.get('locStore', {}).get('vdEntries', []):
        if vd.get('localeId') == 'en_us':
            rid = str(vd['locstringId']['ruid'])
            nvar[rid] += 1
            if 0 <= vd['vpeIndex'] < len(payload):
                t = payload[vd['vpeIndex']].get('content')
                if t is not None and t not in texts.setdefault(rid, []):
                    texts[rid].append(t)
    # graph
    sg = r.get('sceneGraph', {}).get('Data', {}) or {}
    nodes = {n['Data']['nodeId']['id']: n['Data'] for n in sg.get('graph', [])}
    # entry points -> reachable nodes (bark trigger / entry names per section)
    eps = r.get('entryPoints', [])
    vinfo = r.get('voInfo', [])
    reach = {}
    for i, ep in enumerate(eps):
        nm = cn(ep.get('name'))
        stack, seen = [ep['nodeId']['id']], set()
        while stack:
            nid = stack.pop()
            if nid in seen or nid not in nodes:
                continue
            seen.add(nid)
            reach.setdefault(nid, []).append((i, nm))
            for sock in nodes[nid].get('outputSockets', []):
                for dst in sock.get('destinations', []):
                    stack.append(dst['nodeId']['id'])
    ep_vo_match = (len(eps) == len(vinfo) and all(cn(e['name']) == cn(v['outVoTrigger']) for e, v in zip(eps, vinfo))) if vinfo else None

    ntypes, etypes, qtypes = Counter(), Counter(), Counter()
    vctx, vexp, vstyle = Counter(), Counter(), Counter()
    anims, hints, hint_ex, combat_ev = Counter(), Counter(), [], Counter()
    lines, play_vs, vs_state, extra_keys = [], [], 0, Counter()
    for nid, n in nodes.items():
        ntypes[n['$type']] += 1
        if n['$type'] == 'scnQuestNode' and n.get('questNode'):
            qd = n['questNode']['Data']
            qtypes[qd['$type']] += 1
            qt = (qd.get('type') or {}).get('Data') or {}
            if qt.get('$type') == 'questPlayVoiceset_NodeType':
                for prm in qt.get('params', []):
                    play_vs.append({'voiceset': cn(prm.get('voicesetName')), 'player': prm.get('isPlayer'),
                                    'ctx': prm.get('overridingVoiceoverContext') if prm.get('overrideVoiceoverExpression') else None,
                                    'puppet': [cn(x) for x in (prm.get('puppetRef') or {}).get('names', [])][:2]})
            elif qt.get('$type') == 'questChangeVoicesetState_NodeType':
                vs_state += 1
        evs = [e['Data'] for e in n.get('events', []) if e.get('Data')]
        sec_anims = []
        for e in evs:
            for a in anim_names(e):
                sec_anims.append(a)
                anims[a] += 1
        for e in evs:
            t = e['$type']
            etypes[t] += 1
            if COMBAT_EVENT_RE.search(t):
                combat_ev[t] += 1
            if t != 'scnDialogLineEvent':
                continue
            vp = e.get('voParams', {}) or {}
            sid_item = e.get('screenplayLineId', {}).get('id')
            ln = sp.get(('lines', sid_item)) or sp.get(('options', sid_item))
            rid = str(ln['locstringId']['ruid']) if ln else None
            spk = actors.get(ln['speaker']['id']) if ln else None
            adr = actors.get(ln['addressee']['id']) if ln else None
            extra = [actors.get(s['actorId']['id'], {}).get('name', s['actorId']['id']) for s in (e.get('additionalSpeakers') or {}).get('speakers', [])]
            ep_hits = reach.get(nid, [])
            row = {
                'scene': depot, 'version': version, 'archive': archive, 'cat': cat, 'section': nid,
                'entry': sorted({nm for _, nm in ep_hits}) or None,
                'event': str(e['id']['id']),
                'speaker': spk['name'] if spk else None,
                'speaker_id': ln['speaker']['id'] if ln else None,
                'speaker_tag': spk['tag'] if spk else None,
                'speaker_voice_id': spk['voice_id'] if spk else None,
                'addressee': adr['name'] if adr else None,
                'additional_speakers': extra,
                'sid': [rid] if rid else [],
                'item_id': sid_item,
                'gender_mask': ln.get('usage', {}).get('playerGenderMask', {}).get('mask') if ln else None,
                'n_en_variants': nvar.get(rid, 0) if rid else 0,
                'text': (texts.get(rid) or [None])[0] if rid else None,
                'text_alt': (texts.get(rid) or [None, None])[1] if rid and len(texts.get(rid, [])) > 1 else None,
                'vo_context': vp.get('voContext'), 'vo_expression': vp.get('voExpression'),
                'custom_vo_event': (lambda c: None if c in (None, 'None') else c)(cn(vp.get('customVoEvent'))),
                'holocall': vp.get('isHolocallSpeaker'),
                'vo_flags': {k: vp[k] for k in ('alwaysUseBrainGender', 'disableHeadMovement', 'ignoreSpeakerIncapacitation') if vp.get(k)} or None,
                'visual_style': e.get('visualStyle'), 'type': e.get('type'),
                'start_ms': stu(e.get('startTime')), 'duration_ms': stu(e.get('duration')),
                'section_duration_ms': stu(n.get('sectionDuration')),
                'sec_anims': sorted(set(sec_anims))[:8],
                'sec_n_lines': sum(1 for x in evs if x['$type'] == 'scnDialogLineEvent'),
            }
            # voiceset bark trigger: voInfo[i].inVoTrigger for the entry points (entry[i].name == voInfo[i].outVoTrigger)
            # that reach this section; bark_var = the most specific (fewest-reach) hit
            if ep_vo_match and ep_hits:
                row['bark'] = sorted({cn(vinfo[i]['inVoTrigger']) for i, _ in ep_hits})
                row['bark_var'] = [nm for _, nm in ep_hits if nm not in row['bark']] or [nm for _, nm in ep_hits]
                row['bark_vo_duration_s'] = vinfo[ep_hits[0][0]].get('duration')
            elif cat == 'voiceset' and ep_hits:
                # voiceset without a usable voInfo table: derive the trigger from the entry-point names themselves
                names = [nm for _, nm in ep_hits if nm and not nm.startswith('Start')]
                row['bark'] = sorted({re.sub(r'_var_\d+$', '', nm) for nm in names}) or None
                row['bark_var'] = [nm for nm in names if nm not in (row['bark'] or [])] or names
                row['bark_derived_from_names'] = True
            lines.append(row)
            vctx[vp.get('voContext')] += 1
            extra_keys.update(('ev.' + k) for k in e if k not in KNOWN_EV)
            extra_keys.update(('vo.' + k) for k in vp if k not in KNOWN_VO)
            if ln:
                extra_keys.update(('sp.' + k) for k in ln if k not in KNOWN_SP)
            vexp[vp.get('voExpression')] += 1
            vstyle[e.get('visualStyle')] += 1
    # combat-ish strings anywhere outside dialogue text
    for top, val in r.items():
        if top in SKIP_TOP:
            continue
        for key, s in walk_strings(val, top):
            if not s or 'lipsync' in s or s.endswith('.anims'):
                continue  # lipsync resource paths repeat the scene's own file name
            s2 = s.lower().replace(stem, '') if stem else s
            m = COMBAT_RE.search(s2)
            if m:
                hints[m.group(0).lower()] += 1
                if len(hint_ex) < 40 and s not in hint_ex:
                    hint_ex.append(s[:100])
    name_cues = sorted({m.group(0).lower() for src in [depot] + [cn(e.get('name')) or '' for e in eps] +
                        [cn(s.get('name')) or '' for s in r.get('interruptionScenarios', [])]
                        for m in NAME_RE.finditer(src)})
    refs = r.get('resouresReferences', {}) or {}
    for k in ('cinematicAnimNames', 'gameplayAnimNames', 'dynamicAnimNames'):
        for grp in refs.get(k, []):
            for a in grp.get('animationNames', []):
                anims[cn(a)] += 1
    ws = []
    for w in r.get('workspots', []):
        w = w.get('Data', w) if isinstance(w, dict) else {}
        p = cn(w.get('workspotResource'))
        if p and p != 'None':
            ws.append(p)
            anims[p] += 1
    index = {
        'scene': depot, 'version': version, 'archive': archive, 'cat': cat, 'raw_sha1': raw_sha1,
        'n_lines': len(lines),
        'vo_context': dict(vctx), 'vo_expression': dict(vexp), 'visual_style': dict(vstyle),
        'entry_points': sorted({cn(e.get('name')) for e in eps})[:80],
        'n_entry_points': len(eps),
        'voinfo_triggers': sorted({cn(v['inVoTrigger']) for v in vinfo})[:80],
        'entry_voinfo_aligned': ep_vo_match,
        'node_types': dict(ntypes), 'event_types': dict(etypes), 'quest_node_types': dict(qtypes),
        'anims': [a for a, _ in anims.most_common(80)], 'n_anims': len(anims), 'workspots': ws[:20],
        'actors': [{'id': i, 'name': a['name'], 'tag': a['tag']} for i, a in actors.items()][:40],
        'n_actors': len(actors),
        'play_voiceset': play_vs[:40], 'n_play_voiceset': len(play_vs), 'n_voiceset_state_changes': vs_state,
        'interruption_scenarios': [cn(s.get('name')) for s in r.get('interruptionScenarios', [])][:10],
        'name_cues': name_cues,
        'combat_event_types': dict(combat_ev),
        'combat_hint_tokens': dict(hints.most_common(15)), 'combat_hint_examples': hint_ex[:15],
        'n_screenplay_lines': len(r.get('screenplayStore', {}).get('lines', [])),
        'extra_keys': dict(extra_keys),
        'n_screenplay_options': len(r.get('screenplayStore', {}).get('options', [])),
        'lines_sig': hashlib.sha1(json.dumps(sorted((l['sid'][0] if l['sid'] else '', l['vo_context'] or '', l['custom_vo_event'] or '') for l in lines)).encode()).hexdigest()[:16],
    }
    used = {(l['item_id']) for l in lines}
    orphans = []
    for (kind, iid), ln in sp.items():
        if kind == 'options' or iid not in used:
            rid = str(ln['locstringId']['ruid'])
            orphans.append({'scene': depot, 'archive': archive, 'cat': cat, 'kind': kind, 'item_id': iid, 'sid': [rid],
                            'speaker': (actors.get(ln['speaker']['id']) or {}).get('name') if kind == 'lines' else None,
                            'text': (texts.get(rid) or [None])[0]})
    index['n_orphan_items'] = len(orphans)
    return lines, index, orphans


def job(args):
    path, depot, archive = args
    try:
        return depot, distill(path, depot, archive), None
    except Exception as exc:  # keep going; report at the end
        return depot, None, repr(exc)


def discover():
    items = []
    for archive in ('base', 'ep1'):
        base = OUT / 'scenes-raw' / archive
        for p in sorted(base.rglob('*.scene.json')):
            depot = str(p.relative_to(base))[:-5].replace('/', '\\')
            items.append((str(p), depot, archive))
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--out', default=str(OUT))
    a = ap.parse_args()
    items = discover()
    if a.limit:
        items = items[:a.limit]
    voicetags()
    out = Path(a.out)
    errors = []
    with open(out / 'scene-lines.jsonl', 'w', encoding='utf-8') as lf, open(out / 'scene-index.jsonl', 'w', encoding='utf-8') as xf, \
            open(out / 'scene-orphan-items.jsonl', 'w', encoding='utf-8') as of, \
            mp.Pool(min(a.workers, 4)) as pool:
        for i, (depot, res, err) in enumerate(pool.imap(job, items, chunksize=8)):
            if err:
                errors.append((depot, err))
                continue
            lines, index, orphans = res
            for row in orphans:
                of.write(json.dumps(row, ensure_ascii=False) + '\n')
            for row in lines:
                lf.write(json.dumps(row, ensure_ascii=False) + '\n')
            xf.write(json.dumps(index, ensure_ascii=False) + '\n')
            if i % 500 == 0:
                print(i, len(items), file=sys.stderr, flush=True)
    print('scenes', len(items) - len(errors), 'errors', len(errors))
    for e in errors[:20]:
        print(e)
    mark_duplicates(out)


def mark_duplicates(out):
    """Add dup_group / dup_of to scene-index and scene-lines (every version path is kept).

    dup_group = first 12 hex of the raw .scene SHA-1 (byte-identical payloads share a group).
    dup_of    = the canonical path of the group, or null on the canonical row itself.  Canonical = the
                path outside any \\versions\\<tag>\\ folder (the live scene) when the group has one, else
                the lexicographically first path.  same_lines_as = canonical path of the lines_sig group
                (same set of sid/voContext/customVoEvent, different bytes) in scene-index only.
    """
    rows = [json.loads(x) for x in open(out / 'scene-index.jsonl', encoding='utf-8')]

    def canon(group):
        live = [r['scene'] for r in group if '\\versions\\' not in r['scene']]
        return sorted(live or [r['scene'] for r in group])[0]

    for key, name in (('raw_sha1', 'dup'), ('lines_sig', 'same_lines')):
        groups = {}
        for r in rows:
            groups.setdefault(r[key], []).append(r)
        for g in groups.values():
            c = canon(g)
            for r in g:
                if name == 'dup':
                    r['dup_group'] = r['raw_sha1'][:12] if r['raw_sha1'] else None
                    r['dup_of'] = None if r['scene'] == c else c
                else:
                    r['same_lines_as'] = None if r['scene'] == c or not r['n_lines'] else c
    dup = {r['scene']: r['dup_of'] for r in rows}
    with open(out / 'scene-index.jsonl', 'w', encoding='utf-8') as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + '\n')
    tmp = out / 'scene-lines.jsonl.tmp'
    with open(out / 'scene-lines.jsonl', encoding='utf-8') as src, open(tmp, 'w', encoding='utf-8') as dst:
        for ln in src:
            r = json.loads(ln)
            r['dup_of'] = dup[r['scene']]
            dst.write(json.dumps(r, ensure_ascii=False) + '\n')
    tmp.replace(out / 'scene-lines.jsonl')
    n = sum(1 for r in rows if r['dup_of'])
    print('byte-identical duplicate scenes (non-canonical):', n)


if __name__ == '__main__':
    main()
