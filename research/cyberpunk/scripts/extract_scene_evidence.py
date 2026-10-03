"""Export an explicit, bounded list of native resources for source review.

This shares the archive verification/indexer used by the quest inventory. It
does not discover all scenes, modify game data, or print screenplay text. Every
requested depot path is kept in the batch manifest, including missing paths.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from types import SimpleNamespace

from index_game_knowledge import (ARCHIVES, Job, contained, digest, fnv,
                                  index_exports, read_archive_index, write_json)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True)
    parser.add_argument('--game', required=True)
    parser.add_argument('--batch', required=True)
    parser.add_argument('--depot', action='append', required=True)
    parser.add_argument('--resource-kind', choices=('scene', 'gamedef', 'questphase'), default='scene')
    parser.add_argument('--max-decoded-mib', type=float, default=256)
    parser.add_argument('--max-cache-gib', type=float, default=2)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', args.batch):
        parser.error('Batch must be a short lowercase directory name')
    depots = sorted(set(path.replace('/', '\\').lower() for path in args.depot))
    if not 1 <= len(depots) <= 32:
        parser.error('Request between 1 and 32 exact scene paths per batch')
    extension = '.' + args.resource_kind
    if any(not path.endswith(extension) or '..' in path.split('\\') or ':' in path
           or path.startswith('\\') for path in depots):
        parser.error(f'Only relative {extension} depot paths are accepted')
    output = Path(args.project) / 'research/cyberpunk/cache/game/scene-evidence' / args.batch
    job = Job(SimpleNamespace(project=args.project, game=args.game, output=output,
                              max_cache_gib=args.max_cache_gib))
    entries, winners = [], {}
    for priority, (archive, relative) in enumerate(ARCHIVES):
        archive_path = Path(args.game) / relative
        if not archive_path.is_file():
            continue
        index = read_archive_index(archive_path)
        stat = archive_path.stat()
        for depot in depots:
            hashed = str(fnv(depot, 64))
            if hashed not in index:
                continue
            raw = output / 'raw' / archive / Path(*depot.split('\\'))
            if not contained(raw, output):
                raise ValueError('Unsafe output path')
            entry = {'archive': archive, 'archivePath': relative, 'priority': priority,
                     'archiveBytes': stat.st_size, 'archiveMtimeNs': str(stat.st_mtime_ns),
                     'depotPath': depot, 'pathHash64': hashed, **index[hashed],
                     'rawPath': raw.relative_to(output).as_posix(),
                     'jsonPath': raw.relative_to(output).as_posix() + '.json'}
            entries.append(entry)
            winners[depot] = entry
    for entry in entries:
        entry['winner'] = winners[entry['depotPath']] is entry
    decoded = sum(entry['decodedBytes'] for entry in entries)
    if decoded > args.max_decoded_mib * 1024 ** 2:
        raise RuntimeError(f'Bounded scene decode budget exceeded: {decoded} bytes')
    missing = sorted(set(depots) - set(winners))
    manifest = {'version': 1, 'createdAt': datetime.now(timezone.utc).isoformat(),
                'scope': 'Explicit native ' + args.resource_kind + ' resources requested for rule review',
                'tool': 'WolvenKit.CLI 9.0.1', 'precedence': [item[0] for item in ARCHIVES],
                'requestedPaths': depots, 'missingPaths': missing,
                'winnerCount': len(winners), 'assetCount': len(entries),
                'totals': {'decodedBytes': decoded}, 'assets': entries}
    manifest_path = output / 'inventory.json'
    previous_assets = {}
    if manifest_path.is_file():
        old = json.loads(manifest_path.read_text(encoding='utf-8'))
        keys = lambda items: {(e['archive'], e['depotPath']): e['archiveEntrySha1'] for e in items}
        if keys(old['assets']) != keys(entries):
            raise RuntimeError('Batch evidence differs from previous export; use a new batch name')
        previous_assets = {(entry['archive'], entry['depotPath']): entry
                           for entry in old['assets']}
        # Preserve qualified hashes in the resumable manifest even if a later
        # integrity check fails or the export process is interrupted.
        for entry in entries:
            previous = previous_assets[(entry['archive'], entry['depotPath'])]
            for field in ('assetSha256', 'jsonSha256'):
                if field in previous:
                    entry[field] = previous[field]
    write_json(manifest_path, manifest)
    for archive, relative in ARCHIVES:
        assets = [entry for entry in entries if entry['archive'] == archive]
        if not assets:
            continue
        root = output / 'raw' / archive
        root.mkdir(parents=True, exist_ok=True)
        absent = [entry for entry in assets if not (output / entry['rawPath']).is_file()]
        if absent:
            pattern = '^(' + '|'.join(re.escape(entry['depotPath']) for entry in absent) + ')$'
            job.run(['extract', Path(args.game) / relative, '--outpath', root, '--regex', pattern],
                    f'extract-scenes-{archive}', len(assets))
        convert = []
        for entry in assets:
            raw = output / entry['rawPath']
            if digest(raw, 'sha1') != entry['archiveEntrySha1']:
                raise RuntimeError(f'Scene archive payload mismatch: {entry["depotPath"]}')
            entry['assetSha256'] = digest(raw)
            previous_hash = previous_assets.get((entry['archive'], entry['depotPath']), {}).get('jsonSha256')
            try:
                serialized = output / entry['jsonPath']
                doc = json.loads(serialized.read_text(encoding='utf-8-sig'))
                if Path(doc['Header']['ArchiveFileName']).resolve() != raw.resolve():
                    raise ValueError('Serialization source mismatch')
                # Existing unbound exports are serialized again. Hashing them
                # in place cannot authenticate their original decoded bytes.
                if previous_hash is None:
                    convert.append(str(raw))
                elif digest(serialized) != previous_hash:
                    raise RuntimeError('Previously qualified JSON changed: ' + entry['depotPath'])
            except (OSError, ValueError, KeyError):
                convert.append(str(raw))
        if convert:
            job.run(['convert', 'serialize', *convert], f'serialize-scenes-{archive}', len(assets))
        for entry in assets:
            serialized = output / entry['jsonPath']
            doc = json.loads(serialized.read_text(encoding='utf-8-sig'))
            if Path(doc['Header']['ArchiveFileName']).resolve() != (output / entry['rawPath']).resolve():
                raise RuntimeError('Serialization source mismatch: ' + entry['depotPath'])
            entry['jsonSha256'] = digest(serialized)
        write_json(manifest_path, manifest)
    summary = index_exports(job, manifest)
    print(json.dumps({'batch': args.batch, 'missingPaths': missing,
                      'decodedBytes': decoded, 'complete': summary['complete']}), flush=True)
    return 0 if summary['complete'] and not missing else 2


if __name__ == '__main__':
    raise SystemExit(main())
