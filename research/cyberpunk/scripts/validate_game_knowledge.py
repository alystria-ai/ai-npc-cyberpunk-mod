"""Check exported evidence integrity without interpreting narrative semantics.

Validates every indexed source fingerprint, node/edge ownership and journal
reference join. Reopens sampled exact native JSON pointers from every asset;
reports structural gaps rather than pretending every shipped asset is live.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path

from index_game_knowledge import scalar, utc, write_json


def rows(path):
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            yield json.loads(line)


def resolve(document, pointer):
    current = document
    for part in pointer.split('/')[1:]:
        part = part.replace('~1', '/').replace('~0', '~')
        current = current[int(part)] if isinstance(current, list) else current[part]
    return current


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', required=True)
    args = parser.parse_args()
    root = Path(args.cache).resolve()
    index = root / 'index'
    inventory = json.loads((root / 'inventory.json').read_text(encoding='utf-8'))
    winners = {entry['jsonPath']: entry for entry in inventory['assets'] if entry['winner']}
    counts, gaps = Counter(), defaultdict(list)
    samples, sources_seen, node_keys, node_pointers = {}, set(), {}, set()

    def gap(name, value):
        counts['gap:' + name] += 1
        if len(gaps[name]) < 20:
            gaps[name].append(value)

    def source(row, kind):
        value = row['source']
        key = value['jsonPath']
        asset = winners.get(key)
        if not asset or value.get('assetSha256') != asset.get('assetSha256'):
            gap('source-mismatch', {'kind': kind, 'source': value})
        sources_seen.add(key)
        # One pointer per index kind and asset, plus every explicit fact writer
        # used later by runtime reviewers. Readers can reopen all other pointers.
        samples.setdefault((key, kind), row)

    for row in rows(index / 'nodes.jsonl'):
        counts['nodes'] += 1
        source(row, 'nodes')
        key = (row['source']['jsonPath'], row.get('graphPointer'), row['id'])
        if key in node_keys:
            gap('duplicate-scoped-node-id', {'key': key, 'a': node_keys[key], 'b': row['jsonPointer']})
        node_keys[key] = row['jsonPointer']
        node_pointers.add((row['source']['jsonPath'], row['jsonPointer']))
        if not row.get('graphPointer'):
            gap('node-without-graph', {'source': row['source'], 'pointer': row['jsonPointer']})

    for row in rows(index / 'edges.jsonl'):
        counts['edges'] += 1
        source(row, 'edges')
        for endpoint_name in ('from', 'to'):
            endpoint = row[endpoint_name]
            if not endpoint['resolved']:
                gap('unresolved-socket', {'source': row['source'], 'pointer': row['jsonPointer'],
                                          'side': endpoint_name, 'handle': endpoint['handleId']})
            node = endpoint.get('node')
            if node is None:
                gap('socket-without-node', {'source': row['source'], 'pointer': row['jsonPointer'],
                                           'side': endpoint_name, 'handle': endpoint['handleId']})
            elif (row['source']['jsonPath'], node['jsonPointer']) not in node_pointers:
                gap('unknown-node-owner', row)
        start, end = row['from'].get('node'), row['to'].get('node')
        if start and end and start.get('graphPointer') != end.get('graphPointer'):
            gap('cross-graph-edge', {'source': row['source'], 'pointer': row['jsonPointer'],
                                     'from': start, 'to': end})

    journal = {}
    for row in rows(index / 'journal.jsonl'):
        counts['journal'] += 1
        source(row, 'journal')
        key = row['path'], row['type']
        if key in journal:
            gap('duplicate-journal-path-class', {'path': row['path'], 'class': row['type']})
        journal[key] = row
    for kind in ('journal-paths', 'facts', 'conditions', 'resources'):
        for row in rows(index / (kind + '.jsonl')):
            counts[kind] += 1
            source(row, kind)
            if kind == 'journal-paths':
                key = row['path'], row['className']
                if key in journal:
                    counts['journal-exact-joins'] += 1
                elif row['path']:
                    gap('journal-reference-not-in-cooked-winners', {'path': row['path'],
                        'class': row['className'], 'source': row['source'], 'pointer': row['jsonPointer']})
            elif kind == 'facts' and any(ord(character) > 127 for character in row['factName']):
                gap('non-ascii-fact-hash-needs-native-verification', row['factName'])

    grouped = defaultdict(list)
    for (json_path, kind), row in samples.items():
        grouped[json_path].append((kind, row))
    for json_path, selected in grouped.items():
        document = json.loads((root / json_path).read_text(encoding='utf-8-sig'))
        for kind, row in selected:
            try:
                native = resolve(document, row['jsonPointer'])
                counts['reopened-pointers'] += 1
                expected_type = row.get('type')
                if expected_type and native.get('$type') != expected_type:
                    raise ValueError('Type differs from source object')
                if kind == 'facts' and scalar(native.get(row['field'])) != row['factName']:
                    raise ValueError('Fact symbol differs from source object')
            except Exception as error:
                gap('pointer-reopen-failed', {'source': row['source'], 'kind': kind,
                                             'pointer': row['jsonPointer'], 'error': str(error)})
    for missing in sorted(set(winners) - sources_seen):
        gap('winning-source-with-no-indexed-objects', missing)
    report = {'version': 1, 'createdAt': utc(), 'scope': 'Structural integrity; no narrative/release-reachability claims',
              'winnerCount': len(winners), 'indexedSourceCount': len(sources_seen),
              'counts': dict(counts), 'gapExamples': dict(gaps)}
    write_json(index / 'integrity.json', report)
    print(json.dumps({key: value for key, value in report.items() if key != 'gapExamples'}), flush=True)


if __name__ == '__main__':
    main()
