"""Flag lip-sync corpus lines the voice data excludes: combat/shouted delivery and effect-processed audio.

Sources (the same lists the voice pipeline uses; keys are voice/stringId):
  scripts/phone_detect/combat-flags.json      combat: true = combat or shouted delivery
  scripts/phone_detect/effect-exclusions.json holocall/phone/answering-machine or other strong processing
Those lists cover the 88 named voices. Corpus lines of other speakers (generic
NPCs) fall back to the game's own scene metadata through
scripts/combat_flags/source_signal.py: tier strong or moderate counts as combat
(the voice pipeline additionally needs acoustic confirmation for moderate; we
have no acoustics for these speakers, so we stay conservative), and a scene
occurrence with a broadcast/radio/loudspeaker/cyberspace expression counts as effect-processed (phone and
holocall alone do not, as in the voice pipeline). The corpus keeps 16 kHz audio only, so the voice pipeline's
acoustic effect detectors (comb 3-11 kHz, band limit) cannot be rerun for those speakers.

Writes <pack>/clean.json: {key: {"combat": bool, "effect": bool, "how": str}}.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/combat_flags'))
# Phone/holocall expression alone is NOT an effect: the voice pipeline keeps metadata-only phone clips (the plain
# recording sounds normal). Broadcast, radio, loudspeaker and cyberspace lines are processed in the recording itself.
EFFECT_EXPRESSION = ('globaltv', 'radio', 'loudspeaker', 'cyberspace', 'megaphone', 'intercom', 'broadcast')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pack', type=Path, default=Path('E:/CyberpunkConvai-offload/work/lipsync-lab/pack'))
    args = parser.parse_args()
    index = json.loads((args.pack / 'index.json').read_text())
    combat = json.loads((ROOT / 'scripts/phone_detect/combat-flags.json').read_text(encoding='utf8'))['clips']
    effects = json.loads((ROOT / 'scripts/phone_detect/effect-exclusions.json').read_text(encoding='utf8'))['clips']
    combat_sid, effect_sid = {}, {}
    for key, v in combat.items():
        voice, sid = key.split('/', 1)
        if '.' in sid:  # .holocall/.m variants: separate recordings of the same line
            continue
        combat_sid[sid] = combat_sid.get(sid, False) or bool(v['combat'])
    for key in effects:
        effect_sid[key.split('/')[1]] = True
    from source_signal import load_by_sid, classify_lines
    by_sid, fight_scenes = load_by_sid()
    out, how = {}, Counter()
    for r in index:
        sid = str(int(r['key'].rsplit('_', 1)[1], 16))
        rows = by_sid.get(sid, [])
        if sid in combat_sid:
            c, src = combat_sid[sid], 'list'
        else:
            tier = classify_lines(rows, fight_scenes)['tier']
            c, src = tier in ('strong', 'moderate'), f'scene:{tier}'
        expressions = {(x.get('vo_expression') or '').replace('Vo_Expression_', '').lower() for x in rows}
        e_meta = any(any(w in e for w in EFFECT_EXPRESSION) for e in expressions if e and e != 'spoken')
        e = sid in effect_sid or (sid not in combat_sid and e_meta)
        out[r['key']] = dict(combat=bool(c), effect=bool(e), how=src, expr=sorted(expressions))
        how[(src.split(':')[0], c, e)] += 1
    (args.pack / 'clean.json').write_text(json.dumps(out), encoding='utf8')
    split = json.loads((args.pack / 'split2.json').read_text())
    test = set(split['test'])
    def count(keys):
        keys = list(keys)
        return dict(n=len(keys), combat=sum(out[k]['combat'] for k in keys), effect=sum(out[k]['effect'] for k in keys),
                    either=sum(out[k]['combat'] or out[k]['effect'] for k in keys))
    print('all', count(out))
    print('test', count(k for k in out if k in test))
    for w, v in split['charTest'].items():
        print(w, 'all', count(r['key'] for r in index if r['actor'] == w), 'heldout', count(v))
    print('by source', dict(how))
    print('expressions', Counter(e for v in out.values() for e in v['expr']).most_common(20))


if __name__ == '__main__':
    main()
