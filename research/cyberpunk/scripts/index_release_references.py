"""Index source-located resource-reference chains from the native main quest.

This is structural reference closure, NOT proof a node/branch executes. Review
socket flow, conditions, event gates and supported production scope separately.
"""
from __future__ import annotations

import argparse
from collections import defaultdict, deque
import json
from pathlib import Path

from index_game_knowledge import utc, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', required=True)
    parser.add_argument('--root', default=r'base\quest\cyberpunk2077.quest')
    args = parser.parse_args()
    cache = Path(args.cache).resolve()
    inventory = json.loads((cache / 'inventory.json').read_text(encoding='utf-8'))
    winners = {entry['depotPath'].lower(): entry for entry in inventory['assets'] if entry['winner']}
    root = args.root.replace('/', '\\').lower()
    if root not in winners:
        raise ValueError('Requested root is absent from winning native resource inventory')
    links = defaultdict(list)
    with (cache / 'index/resources.jsonl').open(encoding='utf-8') as stream:
        for line in stream:
            row = json.loads(line)
            target = row['depotPath'].replace('/', '\\').lower()
            if target.endswith(('.quest', '.questphase', '.scene')):
                links[row['source']['depotPath'].lower()].append((target, row))
    reached = {root: {'depth': 0, 'parent': None, 'via': None}}
    external = {}
    queue = deque([root])
    while queue:
        parent = queue.popleft()
        for target, evidence in sorted(links[parent], key=lambda pair: (pair[0], pair[1]['jsonPointer'])):
            if target not in winners:
                external.setdefault(target, {'parent': parent, 'via': evidence})
                continue
            if target in reached:
                continue
            reached[target] = {'depth': reached[parent]['depth'] + 1, 'parent': parent, 'via': evidence}
            queue.append(target)
    result = {'version': 1, 'createdAt': utc(),
              'qualification': 'Reference closure only; not executable node, branch, or runtime state reachability',
              'root': root, 'rootAssetSha256': winners[root]['assetSha256'],
              'reachedAssetCount': len(reached), 'unreachedAssetCount': len(winners) - len(reached),
              'externalReferenceCount': len(external), 'assets': reached,
              'unreachedAssets': sorted(set(winners) - set(reached)), 'externalReferences': external}
    write_json(cache / 'index/release-reference-closure.json', result)
    print(json.dumps({key: value for key, value in result.items()
                      if key not in ('assets', 'unreachedAssets', 'externalReferences')}), flush=True)


if __name__ == '__main__':
    main()
