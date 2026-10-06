"""Validate scene-lines.jsonl against the final-corpus dataset rows and the reference-pool catalog.

(i)   dataset rows (final-entry-v5-001/data/*.jsonl): is voice/<stringId>[/gender] found in scene-lines, and in
      the scene(s) the dataset row names?  (exact path, and path modulo \\versions\\<tag>\\)
(ii)  catalog.json (per voice 'entries' with sid/stem/vo): fraction of sids found in some scene (dialog events),
      in orphan screenplay items/options, and a stem-pattern breakdown of the rest.
(iii) the full adam-smasher table (every catalog line with scene(s), cat, vo_context, entry/bark, text).

Writes OUT/validation/{dataset-join.json,catalog-coverage.json,adam-smasher.json}; prints a summary.

    set PYTHONUTF8=1
    python scripts/combat_flags/validate_coverage.py
"""
import collections
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(r'E:\CyberpunkConvai-offload\work\combat-flags')
DATA = ROOT / 'runtime/voice-data-expansion-20261004/final-corpus-assembly/final-entries/final-entry-v5-001/data'
CATALOG = Path(r'E:\CyberpunkConvai-offload\work\reference-pool-expanded\_work\catalog.json')
VER = re.compile(r'\\versions\\[^\\]+')


def norm(p):
    return VER.sub('', p).lower()


def load_lines():
    by_sid = collections.defaultdict(list)
    with open(OUT / 'scene-lines.jsonl', encoding='utf-8') as fh:
        for ln in fh:
            r = json.loads(ln)
            for s in r['sid']:
                by_sid[s].append(r)
    orphans = collections.defaultdict(list)
    with open(OUT / 'scene-orphan-items.jsonl', encoding='utf-8') as fh:
        for ln in fh:
            r = json.loads(ln)
            for s in r['sid']:
                orphans[s].append(r)
    return by_sid, orphans


def stem_class(stem, tag):
    s = stem
    if re.search(r'(^|_)vs_|vset|_vsets$', s):
        return 'voiceset(vs_/vset)'
    if re.search(r'_ow_', s):
        return '_ow_ open-world'
    if re.search(r'_sts_', s):
        return '_sts_ street story'
    if re.search(r'(^|_)(mq|sq|q|sts|ep1)\d', s) or re.search(r'_(mq|sq|q)\d{3}', s):
        return 'quest id (qNNN/mqNNN/sqNNN)'
    if re.search(r'gang|civ|ncpd|scav|tyger|maelstrom|animals|valentino|corpo|sec_|cyberpsycho', s):
        return 'generic crowd/gang/ncpd'
    return 'other'


def dataset(by_sid):
    res = collections.OrderedDict()
    tot = collections.Counter()
    miss = []
    for f in ['train', 'dev', 'test', 'teacher_conditional', 'teacher_regression']:
        c = collections.Counter()
        for ln in open(DATA / f'{f}.jsonl', encoding='utf-8'):
            r = json.loads(ln)
            sid = r['id'].split('/')[1]
            c['rows'] += 1
            hits = by_sid.get(sid, [])
            if not hits:
                c['sid_not_found'] += 1
                miss.append({'file': f, 'id': r['id'], 'scenes': r['scenes'], 'text': r.get('native_text')})
                continue
            c['sid_found'] += 1
            ds = set(r['scenes'])
            hs = {h['scene'] for h in hits}
            if ds & hs:
                c['same_scene_exact'] += 1
            elif {norm(x) for x in ds} & {norm(x) for x in hs}:
                c['same_scene_modulo_version'] += 1
            else:
                c['found_other_scene_only'] += 1
                if len(miss) < 400:
                    miss.append({'file': f, 'id': r['id'], 'dataset_scenes': r['scenes'], 'scene_lines_scenes': sorted(hs)[:5], 'kind': 'other_scene'})
        res[f] = dict(c)
        tot.update(c)
    res['total'] = dict(tot)
    res['mismatches_sample'] = miss[:80]
    return res


def catalog(by_sid, orphans):
    cat = json.loads(CATALOG.read_text(encoding='utf-8'))
    ent = [(v, e) for v, vd in cat.items() for e in vd['entries']]
    uniq = {e['sid'] for _, e in ent}
    found_u = {s for s in uniq if s in by_sid}
    orph_u = {s for s in uniq if s not in by_sid and s in orphans}
    res = {'entries': len(ent), 'unique_sids': len(uniq), 'entries_found_in_dialog_events': sum(e['sid'] in by_sid for _, e in ent),
           'unique_sids_found': len(found_u), 'unique_sids_only_orphan_items': len(orph_u)}
    nf = [(v, e) for v, e in ent if e['sid'] not in by_sid]
    res['entries_not_found'] = len(nf)
    res['unique_sids_not_found'] = len({e['sid'] for _, e in nf})
    cls = collections.defaultdict(lambda: collections.Counter())
    stems = collections.defaultdict(collections.Counter)
    for v, e in nf:
        k = stem_class(e['stem'], e['tag'])
        cls[k]['entries'] += 1
        cls[k][e['vo']] += 1
        cls[k]['orphan_item_hit'] += e['sid'] in orphans
        stems[k][e['stem']] += 1
    none = [(v, e) for v, e in nf if e['sid'] not in orphans]
    res['in_no_scene_at_all'] = {
        'entries': len(none), 'unique_sids': len({e['sid'] for _, e in none}),
        'entries_with_empty_subtitle_text': sum(not e['text'] for _, e in none),
        'top_voices': collections.Counter(v for v, _ in none).most_common(12),
        'top_stems': collections.Counter(e['stem'] for _, e in none).most_common(15)}
    res['unreferenced_screenplay_line_entries'] = {
        'entries': len(nf) - len(none),
        'entries_with_empty_subtitle_text': sum(not e['text'] for v, e in nf if e['sid'] in orphans)}
    res['found_entries_with_empty_subtitle_text'] = sum(not e['text'] for _, e in ent if e['sid'] in by_sid)
    res['not_found_by_stem_class'] = {k: dict(v) for k, v in cls.items()}
    res['not_found_top_stems'] = {k: v.most_common(15) for k, v in stems.items()}
    byvo = collections.defaultdict(collections.Counter)
    for v, e in ent:
        byvo[e['vo']]['entries'] += 1
        byvo[e['vo']]['found'] += e['sid'] in by_sid
    res['by_vo_bank'] = {k: dict(v) for k, v in byvo.items()}
    # independent content check of the join: catalog subtitle text vs the en_us text embedded in the scene locStore
    tm = collections.Counter()
    for v, e in ent:
        hits = by_sid.get(e['sid'])
        if not hits or not e['text']:
            continue
        scene_texts = {t for h in hits for t in (h.get('text'), h.get('text_alt')) if t}
        tm['compared'] += 1
        tm['text_equal'] += e['text'] in scene_texts
        tm['text_equal_ws_normalized'] += ' '.join(e['text'].split()) in {' '.join(t.split()) for t in scene_texts}
    res['catalog_text_vs_scene_text'] = dict(tm)
    byarch = collections.defaultdict(collections.Counter)
    for v, e in ent:
        byarch[e['archive']]['entries'] += 1
        byarch[e['archive']]['found'] += e['sid'] in by_sid
    res['by_archive'] = {k: dict(v) for k, v in byarch.items()}
    # category of the found ones
    cc = collections.Counter()
    for v, e in ent:
        h = by_sid.get(e['sid'])
        if h:
            cc[tuple(sorted({x['cat'] for x in h}))] += 1
    res['found_by_cat_set'] = {'|'.join(map(str, k)): n for k, n in cc.most_common()}
    # per-voice coverage
    pv = {}
    for v, vd in cat.items():
        es = vd['entries']
        pv[v] = [len(es), sum(e['sid'] in by_sid for e in es)]
    res['per_voice_[entries,found]'] = pv
    # smasher
    sm = []
    for e in cat['adam-smasher']['entries']:
        hits = by_sid.get(e['sid'], [])
        sm.append({'sid': e['sid'], 'stem': e['stem'], 'bank': e['vo'], 'fm': e['fm'], 'text': e['text'],
                   'scenes': sorted({h['scene'] for h in hits}),
                   'cat': sorted({h['cat'] for h in hits}),
                   'vo_context': sorted({str(h['vo_context']) for h in hits}),
                   'vo_expression': sorted({str(h['vo_expression']) for h in hits}),
                   'speaker': sorted({str(h['speaker']) for h in hits}),
                   'entry': sorted({x for h in hits for x in (h.get('entry') or [])}),
                   'bark': sorted({x for h in hits for x in (h.get('bark') or [])}),
                   'custom_vo_event': sorted({str(h['custom_vo_event']) for h in hits if h['custom_vo_event']}),
                   'visual_style': sorted({str(h['visual_style']) for h in hits}),
                   'orphan_scenes': sorted({o['scene'] for o in orphans.get(e['sid'], [])})})
    return res, sm


def main():
    out = OUT / 'validation'
    out.mkdir(exist_ok=True)
    by_sid, orphans = load_lines()
    print('distinct sids in scene-lines:', len(by_sid), 'orphan-item sids:', len(orphans))
    d = dataset(by_sid)
    (out / 'dataset-join.json').write_text(json.dumps(d, indent=1, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({k: v for k, v in d.items() if k != 'mismatches_sample'}, indent=1))
    c, sm = catalog(by_sid, orphans)
    (out / 'catalog-coverage.json').write_text(json.dumps(c, indent=1, ensure_ascii=False), encoding='utf-8')
    (out / 'adam-smasher.json').write_text(json.dumps(sm, indent=1, ensure_ascii=False), encoding='utf-8')
    md = ['| stem | bank | text | scene | cat | vo_context | vo_expression | entry (bark trigger) | in scene only as unreferenced item |', '|---|---|---|---|---|---|---|---|---|']
    for r in sorted(sm, key=lambda r: (r['stem'], r['scenes'][:1], r['text'])):
        sc = sorted({Path(s.replace('\\', '/')).name for s in r['scenes']}) or sorted({Path(s.replace('\\', '/')).name for s in r['orphan_scenes']})
        md.append('| ' + ' | '.join([r['stem'], r['bank'], (r['text'] or '').replace('|', '/')[:70], ','.join(sc),
                                      ','.join(r['cat']), ','.join(x.replace('Vo_Context_', '') for x in r['vo_context'] if x != 'None'),
                                      ','.join(x.replace('Vo_Expression_', '') for x in r['vo_expression'] if x != 'None'),
                                      ','.join(r['bark'] or r['entry'][:2]), 'yes' if not r['scenes'] and r['orphan_scenes'] else '']) + ' |')
    (out / 'adam-smasher.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in c.items() if k not in ('per_voice_[entries,found]', 'not_found_top_stems')}, indent=1))


if __name__ == '__main__':
    sys.exit(main())
