"""Reproduce a small, speaker-verified style specimen from installed game exports.

No archive extraction, network calls, game access, or profile changes. The source
IDs are selected before generation. Separate scenes are held out for evaluation.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
CACHE = ROOT / 'research/cyberpunk/cache/game'

SELECTIONS = {
    'johnny-silverhand': {
        'prompt': [
            ('1934328665788403712', 'Johnny asks for practical help getting the drive-in projector running.'),
            ('1902734616279404544', 'Johnny gives a blunt opinion of the film, rather than a general political speech.'),
            ('1908636192462360576', 'Johnny is frustrated because Rogue is upset and has not explained why.'),
            ('1908640142255214592', 'Johnny defensively rejects the suggestion that he caused the problem.'),
            ('1908646957093244928', 'Johnny needs time to think, and redirects toward a concrete next destination.'),
        ],
    },
    'judy-alvarez': {
        'prompt': [
            ('1754892626880872448', 'After a disputed Clouds outcome, Judy recognizes that her anger has carried her away.'),
            ('1754896129057603584', 'Judy asks for room to cool down rather than narrating her full history.'),
            ('1754902813318561800', 'Judy rejects a justification for the outcome; disagreement is specific and plain.'),
            ('1775167152608755724', 'In an earned-trust branch Judy expresses confidence in V. This is delivery evidence, not trust in this trial.'),
            ('1892499926679248896', 'Judy reflects on the result with resignation and a small laugh, within a particular aftermath branch.'),
        ],
        'held-out': [
            ('1751653949060923392', 'At the lakeside morning scene Judy asks for quiet company; the scene does not grant this trial romance.'),
            ('1751657975072669696', 'Judy hesitates before asking what the previous night meant in the relevant branch.'),
            ('1765043703282384896', 'Judy responds to the idea of moving elsewhere with a guarded observation about cities.'),
            ('1799690050371018752', 'Judy presses for a personal meaning rather than accepting an evasive answer.'),
            ('1799719924435476480', 'Judy gives a short, exasperated response in the personal morning conversation.'),
        ],
    },
    'panam-palmer': {
        'prompt': [
            ('1357560447766646784', 'During a Basilisk demonstration Panam acknowledges the vehicle limitations and the work done on it.'),
            ('1788479741468889088', 'Panam gives V one concrete driving instruction during the demonstration.'),
            ('1788453154631471104', 'Panam invites V to practice while teasing about being watched.'),
            ('1788476704792793088', 'Panam moderates V\'s enthusiasm with a concrete explanation of the vehicle\'s purpose.'),
            ('1788477132897013760', 'Panam immediately allows that the activity can still be enjoyable.'),
        ],
        'held-out': [
            ('1947404463386521600', 'After V collapses, Panam directly asks what is happening; this trial does not establish that event.'),
            ('1947414952367747072', 'Panam softens her approach and asks V to explain bit by bit.'),
            ('1947496595300413440', 'Panam understands Relic advertising, while distinguishing that limited knowledge from the new disclosure.'),
            ('1947503021360017408', 'Panam answers a simple question about hearing old music on the radio.'),
            ('1947505641373954048', 'Panam is confused by the unexpected explanation and seeks clarification.'),
        ],
    },
}

def pointer(obj, path):
    for part in path.split('/')[1:]:
        part = part.replace('~1', '/').replace('~0', '~')
        obj = obj[int(part)] if isinstance(obj, list) else obj[part]
    return obj

requested = {loc for char in SELECTIONS.values() for rows in char.values() for loc, _ in rows}
found = {}
for line in (CACHE / 'localization/queries/scene-joins.jsonl').open(encoding='utf8'):
    row = json.loads(line)
    if row['locstringId'] in requested:
        found.setdefault(row['locstringId'], []).append(row)

loaded = {}
outputs = []
for char, partitions in SELECTIONS.items():
    expected_actor = char.split('-')[0]
    for partition, selections in partitions.items():
        references = []
        for loc, context in selections:
            candidates = found.get(loc, [])
            if not candidates:
                raise ValueError('Missing selected line ' + loc)
            qualified = []
            for row in candidates:
                scene_path = ROOT / row['source']['jsonPath']
                if scene_path not in loaded:
                    loaded[scene_path] = json.load(scene_path.open(encoding='utf8'))
                scene = loaded[scene_path]['Data']['RootChunk']
                actor = next(((i, a) for i, a in enumerate(scene['actors'])
                              if str(a.get('actorName', '')).lower() == expected_actor), None)
                if actor is None:
                    continue
                actor_index, actor_data = actor
                lines = [x for x in row['screenplayItems']
                         if (x.get('speaker') or {}).get('id') == actor_data['actorId']['id']]
                if not lines:
                    continue
                for archive in row['archiveCandidates']:
                    path = CACHE / 'localization' / archive['source']['jsonPath']
                    if path not in loaded:
                        loaded[path] = json.load(path.open(encoding='utf8'))
                    entry = pointer(loaded[path], archive['jsonPointer'])
                    texts = {entry.get('femaleVariant'), entry.get('maleVariant')}
                    if entry.get('stringId') != loc or row['content'] not in texts:
                        continue
                    qualified.append((row, actor_index, actor_data, lines, archive))
            if not qualified:
                raise ValueError('Speaker/localized text not verified for ' + loc)
            row, actor_index, actor_data, lines, archive = qualified[0]
            references.append({
                'id': f'{expected_actor}-{partition}-{len(references)+1:02}',
                'context': context,
                'text': row['content'],
                'provenance': {
                    'scene': row['source'],
                    'speakerActorId': actor_data['actorId']['id'],
                    'speakerName': actor_data['actorName'],
                    'actorPointer': f'/Data/RootChunk/actors/{actor_index}',
                    'locstringId': loc,
                    'variantId': row['variantId'],
                    'descriptorPointer': row['descriptorPointer'],
                    'payloadPointer': row['payloadPointer'],
                    'screenplayPointers': [x['jsonPointer'] for x in lines],
                    'installedEnglishSubtitle': archive,
                },
            })
        folder = HERE / ('references' if partition == 'prompt' else 'held-out')
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / (expected_actor + '.json')
        if partition == 'held-out' and expected_actor == 'johnny':
            raise ValueError('Johnny held-out is owned by the independent reviewer')
        data = {
            'version': 1, 'characterKey': char,
            'purpose': 'prompt delivery examples' if partition == 'prompt' else 'held-out scoring references; never include in generation prompts',
            'scope': 'Brief installed English subtitle excerpts, verified against scene speaker definitions. Context summaries are original. Distinct branches are examples, not an asserted sequence or current-save history.',
            'references': references,
        }
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
        outputs.append({'character': char, 'partition': partition, 'count': len(references)})

# Verify scene-disjointness, including the independent reviewer\'s Johnny file.
for char in SELECTIONS:
    name = char.split('-')[0]
    train = json.loads((HERE / 'references' / (name + '.json')).read_text(encoding='utf8'))
    held_path = HERE / 'held-out' / (name + '.json')
    if not held_path.exists():
        continue
    held = json.loads(held_path.read_text(encoding='utf8'))
    def scene(row):
        p = row['provenance']
        return p['scene']['depotPath'] if 'scene' in p else p['depotPath']
    if {scene(x) for x in train['references']} & {scene(x) for x in held['references']}:
        raise ValueError('Held-out scene leakage: ' + char)
print(json.dumps({'verified': outputs, 'sceneDisjoint': True}))
