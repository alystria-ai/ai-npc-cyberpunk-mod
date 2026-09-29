"""Read-only, bounded extraction/index of installed Cyberpunk English game text.

The ignored corpus is research evidence, not distributable character prompt data.
No game/save mutation, audio extraction, network access or GPU use. IDs remain
decimal strings; an ambiguous cross-resource localization ID is never collapsed.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import sys

from index_game_knowledge import Job, contained, digest, fnv, read_archive_index, walk, write_json


ARCHIVES = (
    ('base', 'archive/pc/content/lang_en_text.archive'),
    ('ep1', 'archive/pc/ep1/lang_en_text.archive'),
)
PATTERN = r'\\localization\\en-us\\(subtitles|onscreens)\\.*(?<!\.json)\.json$'
RAW_PATTERN = r'(?<!\.json)\.json$'


def inventory(job):
    assets, archives, winners = [], [], {}
    for priority, (name, relative) in enumerate(ARCHIVES):
        archive = job.game / relative
        if not archive.is_file():
            if name == 'ep1':
                continue
            raise FileNotFoundError(archive)
        stat = archive.stat()
        archive_sha = digest(archive)
        archive_row = {'id': name, 'path': relative, 'priority': priority,
                       'bytes': stat.st_size, 'mtimeNs': str(stat.st_mtime_ns),
                       'sha256': archive_sha}
        archives.append(archive_row)
        index = read_archive_index(archive)
        listing = job.run(['archive', archive, '--list', '--regex', PATTERN], 'inventory-' + name)
        paths = [line.strip() for line in listing.splitlines() if re.search(PATTERN, line.strip())]
        if len(paths) != len(set(paths)):
            raise ValueError('Duplicate localization depot path from CLI')
        for depot in paths:
            path_hash = str(fnv(depot.replace('/', '\\').lower(), 64))
            if path_hash not in index:
                raise ValueError('Depot path did not match the archive directory hash')
            raw = job.output / 'raw' / name / Path(*depot.split('\\'))
            if not contained(raw, job.output / 'raw' / name):
                raise ValueError('Unsafe depot path')
            row = {'archive': name, 'archivePath': relative, 'archiveSha256': archive_sha,
                   'priority': priority, 'depotPath': depot, 'pathHash64': path_hash,
                   **index[path_hash], 'rawPath': raw.relative_to(job.output).as_posix(),
                   'jsonPath': raw.relative_to(job.output).as_posix() + '.json'}
            assets.append(row)
            winners[depot.lower()] = row
    for row in assets:
        row['winner'] = winners[row['depotPath'].lower()] is row
    totals = {key: sum(row[key] for row in assets) for key in ('storedBytes', 'decodedBytes')}
    result = {'version': 1, 'createdAt': datetime.now(timezone.utc).isoformat(),
              'scope': 'Shipped base and EP1 English subtitles and onscreens only; excludes mods',
              'precedence': ['base', 'ep1'], 'archives': archives, 'assetCount': len(assets),
              'winnerCount': len(winners), 'totals': totals, 'assets': assets}
    old_path = job.output / 'inventory.json'
    if old_path.is_file():
        old = json.loads(old_path.read_text(encoding='utf-8'))
        if [(r['id'], r['sha256']) for r in old['archives']] != [(r['id'], r['sha256']) for r in archives]:
            raise RuntimeError('Archive inputs changed; use a new output subdirectory')
    if totals['decodedBytes'] > 512 * 1024 ** 2 or len(assets) > 10000:
        raise RuntimeError('English corpus exceeds bounded review budget')
    if shutil.disk_usage(job.output).free < 2 * 1024 ** 3:
        raise RuntimeError('Less than 2 GiB free space; preserve existing evidence and stop')
    write_json(old_path, result)
    print(json.dumps({'stage': 'inventory', 'assets': len(assets), **totals}), flush=True)
    return result


def extract(job, manifest):
    for name, relative in ARCHIVES:
        rows = [row for row in manifest['assets'] if row['archive'] == name]
        if not rows:
            continue
        raw_root = job.output / 'raw' / name
        raw_root.mkdir(parents=True, exist_ok=True)
        if any(not (job.output / row['rawPath']).is_file() for row in rows):
            job.run(['extract', job.game / relative, '--outpath', raw_root, '--regex', PATTERN],
                    'extract-' + name, len(rows))
        for row in rows:
            raw = job.output / row['rawPath']
            if not raw.is_file() or digest(raw, 'sha1') != row['archiveEntrySha1']:
                raise RuntimeError('Localization payload hash mismatch: ' + row['depotPath'])
            row['assetSha256'] = digest(raw)
        write_json(job.output / 'inventory.json', manifest)
        missing = []
        for row in rows:
            try:
                document = json.loads((job.output / row['jsonPath']).read_text(encoding='utf-8-sig'))
                if Path(document['Header']['ArchiveFileName']).resolve() != (job.output / row['rawPath']).resolve():
                    raise ValueError('Serialized source mismatch')
            except (OSError, ValueError, KeyError):
                missing.append(row)
        if missing:
            # No --outpath: basename flattening would collide. Exclude existing
            # .json.json serializations from the CR2W .json resource input list.
            job.run(['convert', 'serialize', raw_root, '--regex', RAW_PATTERN],
                    'serialize-' + name, len(rows))
        print(json.dumps({'stage': 'exported', 'archive': name, 'assets': len(rows)}), flush=True)


def index(job, manifest):
    out = job.output / 'index'
    out.mkdir(parents=True, exist_ok=True)
    db_path = out / 'lookup.sqlite3.tmp'
    if db_path.exists():
        # A task-owned interrupted staging DB is safely recreated through SQLite.
        db_path.unlink()
    db = sqlite3.connect(db_path)
    db.execute('CREATE TABLE entries (row_id INTEGER PRIMARY KEY, domain TEXT NOT NULL, '
               'entry_id TEXT NOT NULL, secondary_key TEXT, male TEXT, female TEXT, source_json TEXT NOT NULL)')
    db.execute('CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
    counts = Counter()
    errors = []
    jsonl_path = out / 'entries.jsonl.tmp'
    with jsonl_path.open('w', encoding='utf-8') as stream:
        for row in manifest['assets']:
            if not row['winner']:
                continue
            try:
                json_path = job.output / row['jsonPath']
                document = json.loads(json_path.read_text(encoding='utf-8-sig'))
                if Path(document['Header']['ArchiveFileName']).resolve() != (job.output / row['rawPath']).resolve():
                    raise ValueError('Serialized source mismatch')
                source = {key: row[key] for key in ('archive', 'archivePath', 'archiveSha256',
                          'depotPath', 'pathHash64', 'archiveEntrySha1', 'assetSha256', 'rawPath', 'jsonPath')}
                found = 0
                for pointer, value in walk(document):
                    kind = value.get('$type')
                    if kind == 'localizationPersistenceSubtitleEntry':
                        domain, key = 'subtitle.stringId', 'stringId'
                    elif kind == 'localizationPersistenceOnScreenEntry':
                        domain, key = 'onscreen.primaryKey', 'primaryKey'
                    else:
                        continue
                    if key not in value or ('femaleVariant' not in value and 'maleVariant' not in value):
                        raise ValueError('Unexpected localization entry schema at ' + pointer)
                    ident = str(value[key])
                    record = {'domain': domain, 'id': ident, 'type': kind,
                              'femaleVariant': value.get('femaleVariant'),
                              'maleVariant': value.get('maleVariant'),
                              'secondaryKey': value.get('secondaryKey'),
                              'source': source, 'jsonPointer': pointer,
                              'idPointer': pointer + '/' + key,
                              'malePointer': pointer + '/maleVariant',
                              'femalePointer': pointer + '/femaleVariant'}
                    encoded = json.dumps(record, ensure_ascii=False, separators=(',', ':'))
                    stream.write(encoded + '\n')
                    db.execute('INSERT INTO entries(domain,entry_id,secondary_key,male,female,source_json) '
                               'VALUES (?,?,?,?,?,?)', (domain, ident, value.get('secondaryKey'),
                               value.get('maleVariant'), value.get('femaleVariant'), encoded))
                    found += 1
                    counts[domain] += 1
                counts['assets'] += 1
                if not found:
                    counts['emptyAssets'] += 1
            except Exception as exc:
                errors.append({'source': row['jsonPath'], 'error': type(exc).__name__ + ': ' + str(exc)})
        db.execute('CREATE INDEX by_id ON entries(domain,entry_id)')
        db.execute('CREATE INDEX by_secondary ON entries(secondary_key)')
        duplicate_groups = db.execute('SELECT COUNT(*) FROM (SELECT domain,entry_id FROM entries '
                                      'GROUP BY domain,entry_id HAVING COUNT(*) > 1)').fetchone()[0]
        conflicting_groups = db.execute("SELECT COUNT(*) FROM (SELECT domain,entry_id FROM entries GROUP BY domain,entry_id "
                                        "HAVING COUNT(DISTINCT COALESCE(male,'') || char(0) || COALESCE(female,'')) > 1)").fetchone()[0]
        summary = {'version': 1, 'createdAt': datetime.now(timezone.utc).isoformat(),
                   'counts': dict(counts), 'expectedAssets': manifest['winnerCount'],
                   'duplicateIdGroups': duplicate_groups, 'conflictingTextIdGroups': conflicting_groups,
                   'errors': errors, 'complete': not errors and counts['assets'] == manifest['winnerCount'],
                   'lookupPolicy': 'Return all candidates for (domain,id); do not silently choose between differing resources',
                   'localeEvidence': 'English is established by each shipped depot path containing localization/en-us'}
        db.execute('INSERT INTO metadata(name,value) VALUES (?,?)', ('summary', json.dumps(summary)))
        db.commit()
        db.close()
    from index_game_knowledge import replace_with_retry
    replace_with_retry(jsonl_path, out / 'entries.jsonl')
    replace_with_retry(db_path, out / 'lookup.sqlite3')
    write_json(out / 'summary.json', summary)
    (job.output / 'README.md').write_text('''# Installed English localization evidence

This private cache contains shipped text, not material to publish in a mod.
`inventory.json` records original archive SHA-256, entry SHA-1, raw payload
SHA-256, depot path, base/EP1 priority and winning resource selection.
`raw/{base,ep1}` preserves original CR2W `.json` assets and `.json.json`
WolvenKit serializations without basename flattening.

`index/entries.jsonl` is one object per exact entry, with RFC 6901 source
pointers and both gender variants. IDs are strings to preserve uint64 values.
`index/lookup.sqlite3` has indexed `entries(domain,entry_id,secondary_key,male,
female,source_json)`. Query `subtitle.stringId` separately from
`onscreen.primaryKey`; `secondary_key` is also indexed. Always retain all
candidates when a key occurs in multiple resources. Winner priority applies
only to the same depot path, not arbitrary duplicate keys across resources.

English is established by `localization/en-us` in the source depot path.
Do not assume any fixed scene `localeId` means English. A scene `locstringId`,
`variantId`, `vpeIndex`, or screenplay `itemId` belongs to its own identifier
domain. Join only using the scene's explicit local tables and verify against
these text keys/content; never guess by nearby numeric values or a filename.
Scene locStore `vdEntries` can point to `vpEntries` through `vpeIndex`; retain
the exact variant and source-hashed scene pointer in any reviewed mapping.

## Commands

Run `python research/cyberpunk/scripts/index_native_localization.py` from the
project root to inventory, extract, index and verify this bounded corpus.
`--index-only` reuses verified extracted resources. `--verify-only` resolves
every indexed value to its source pointer and checks the SQLite/JSONL agree.
For explicit scenes already extracted by the quest research tool, use
`--audit-only --audit-scene PATH` (repeat `--audit-scene` for each file).
This writes `queries/scene-joins.jsonl` and `scene-join-summary.json`.

The audit requires explicit `localeId == en_us`, checks the zero-based
`vpeIndex` bounds and matching `variantId`, then independently queries the
English archive by `subtitle.stringId == locstringId.ruid`. Scene English
may differ from shipped language resources; every discrepancy/missing key
is retained for review. The shipped language entry is the evidence for its
display text, while the scene provides the screenplay/branch linkage.
These links do not establish which branch ran or who knows an event.

No player history, save mutation, localization replacement, audio, scene,
texture, or GPU operation is performed by this tool.
''', encoding='utf-8')
    print(json.dumps(summary), flush=True)
    if not summary['complete']:
        raise RuntimeError('Localization evidence index incomplete; inspect summary errors')


def audit_scenes(job, paths):
    """Qualify explicit scene-local joins; never guess a fixed locale position."""
    requested = list(dict.fromkeys(Path(p).resolve() for p in paths))
    scene_root = job.project / 'research/cyberpunk/cache/game/scene-evidence'
    if len(requested) > 100 or any(not contained(p, scene_root) for p in requested):
        raise ValueError('Scene audit must use at most 100 already exported research scenes')
    if sum(p.stat().st_size for p in requested) > 512 * 1024 ** 2:
        raise ValueError('Scene audit exceeds 512 MiB input bound')
    db = sqlite3.connect('file:' + (job.output / 'index/lookup.sqlite3').as_posix() + '?mode=ro', uri=True)
    out = job.output / 'queries'
    out.mkdir(parents=True, exist_ok=True)
    counts, locales, errors, scenes = Counter(), Counter(), [], []
    differences, absent, batches = [], [], {}
    with (out / 'scene-joins.jsonl').open('w', encoding='utf-8') as stream:
        for path in requested:
            manifest_path = next((p / 'inventory.json' for p in path.parents
                                  if contained(p, scene_root) and (p / 'inventory.json').is_file()), None)
            if manifest_path is None:
                raise ValueError('Scene has no source inventory: ' + str(path))
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            asset = next((a for a in manifest['assets']
                          if (manifest_path.parent / a['jsonPath']).resolve() == path), None)
            if asset is None:
                raise ValueError('Scene is absent from its source inventory')
            raw_path = manifest_path.parent / asset['rawPath']
            if digest(raw_path) != asset['assetSha256']:
                raise ValueError('Scene raw payload no longer matches source inventory')
            source = {k: asset[k] for k in ('archive', 'archivePath', 'archiveEntrySha1',
                       'depotPath', 'pathHash64', 'assetSha256')}
            source['jsonPath'] = path.relative_to(job.project).as_posix()
            source['batch'] = manifest_path.parent.name
            batch_counts = batches.setdefault(source['batch'], Counter())
            batch_counts['scenes'] += 1
            document = json.loads(path.read_text(encoding='utf-8-sig'))
            if Path(document['Header']['ArchiveFileName']).resolve() != raw_path.resolve():
                raise ValueError('Scene serialization source mismatch')
            root = document['Data']['RootChunk']
            store = root['locStore']
            payloads = store['vpEntries']
            screen_items = {}
            for category in ('lines', 'options'):
                for i, item in enumerate(root.get('screenplayStore', {}).get(category, [])):
                    loc = str(item.get('locstringId', {}).get('ruid', ''))
                    screen_items.setdefault(loc, []).append({
                        'jsonPointer': f'/Data/RootChunk/screenplayStore/{category}/{i}',
                        'type': item.get('$type'), 'itemId': item.get('itemId'),
                        'speaker': item.get('speaker'), 'addressee': item.get('addressee'),
                        'usage': item.get('usage')})
            scene_counts = Counter()
            for i, descriptor in enumerate(store['vdEntries']):
                counts['descriptors'] += 1
                scene_counts['descriptors'] += 1
                locale = descriptor['localeId']
                locales[str(locale)] += 1
                pointer = f'/Data/RootChunk/locStore/vdEntries/{i}'
                vpe = descriptor['vpeIndex']
                if not isinstance(vpe, int) or not 0 <= vpe < len(payloads):
                    errors.append({'source': source, 'jsonPointer': pointer, 'error': 'vpeIndex out of range'})
                    continue
                payload = payloads[vpe]
                if payload['variantId'] != descriptor['variantId']:
                    errors.append({'source': source, 'jsonPointer': pointer, 'error': 'variantId mismatch'})
                    continue
                counts['variantJoinsVerified'] += 1
                if locale != 'en_us':
                    continue
                counts['englishDescriptors'] += 1
                scene_counts['englishDescriptors'] += 1
                batch_counts['englishDescriptors'] += 1
                loc_id = str(descriptor['locstringId']['ruid'])
                candidates = []
                for (encoded,) in db.execute('SELECT source_json FROM entries WHERE domain=? AND entry_id=?',
                                              ('subtitle.stringId', loc_id)):
                    localized = json.loads(encoded)
                    match = payload['content'] in (localized['maleVariant'], localized['femaleVariant'])
                    candidates.append({'id': localized['id'], 'domain': localized['domain'],
                                       'contentMatchesOneGenderVariant': match,
                                       'source': localized['source'], 'jsonPointer': localized['jsonPointer']})
                if candidates:
                    counts['subtitleIdFound'] += 1
                    if any(c['contentMatchesOneGenderVariant'] for c in candidates):
                        counts['subtitleContentMatched'] += 1
                    else:
                        counts['subtitleContentDifference'] += 1
                        batch_counts['subtitleContentDifference'] += 1
                        differences.append({'source': source, 'descriptorPointer': pointer,
                                            'payloadPointer': f'/Data/RootChunk/locStore/vpEntries/{vpe}',
                                            'locstringId': loc_id, 'archiveCandidates': candidates})
                else:
                    counts['subtitleIdAbsent'] += 1
                    batch_counts['subtitleIdAbsent'] += 1
                    absent.append({'source': source, 'descriptorPointer': pointer,
                                   'locstringId': loc_id})
                record = {'source': source, 'descriptorPointer': pointer,
                          'payloadPointer': f'/Data/RootChunk/locStore/vpEntries/{vpe}',
                          'localeId': locale, 'locstringId': loc_id,
                          'variantId': str(descriptor['variantId']['ruid']), 'content': payload['content'],
                          'screenplayItems': screen_items.get(loc_id, []), 'archiveCandidates': candidates}
                stream.write(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n')
            scenes.append({'source': source, 'counts': dict(scene_counts)})
    db.close()
    summary = {'version': 1, 'scenes': scenes, 'counts': dict(counts), 'locales': dict(locales),
               'batches': {k: dict(v) for k, v in batches.items()},
               'contentDifferences': differences, 'absentSubtitleIds': absent,
               'errors': errors, 'complete': not errors,
               'interpretation': 'localeId is the serialized scnlocLocaleId enum name; require en_us explicitly. '
               'vpeIndex is checked as a zero-based position and variantId must match. '
               'subtitle.stringId lookup uses the exact locstringId ruid, with content agreement recorded per candidate. '
               'No actor identity, branch semantics or player choice is inferred from these text joins.'}
    write_json(out / 'scene-join-summary.json', summary)
    print(json.dumps({'stage': 'scene-audit', 'scenes': len(scenes), 'counts': dict(counts),
                      'errors': len(errors)}), flush=True)
    if errors:
        raise RuntimeError('Some scene-local joins failed validation; inspect scene-join-summary.json')


def verify(job):
    """Independently resolve every normalized pointer back into source JSON."""
    db = sqlite3.connect('file:' + (job.output / 'index/lookup.sqlite3').as_posix() + '?mode=ro', uri=True)
    integrity = db.execute('PRAGMA quick_check').fetchone()[0]
    if integrity != 'ok':
        raise RuntimeError('SQLite integrity failed: ' + integrity)
    current_path, document, count = None, None, 0
    payload_hashes, sql_stream = {}, hashlib.sha256()

    def resolve(pointer):
        value = document
        for token in pointer.lstrip('/').split('/'):
            token = token.replace('~1', '/').replace('~0', '~')
            value = value[int(token)] if isinstance(value, list) else value[token]
        return value

    for (encoded,) in db.execute('SELECT source_json FROM entries ORDER BY row_id'):
        record = json.loads(encoded)
        source = record['source']
        path = job.output / source['jsonPath']
        if path != current_path:
            document = json.loads(path.read_text(encoding='utf-8-sig'))
            current_path = path
        raw = job.output / source['rawPath']
        if source['rawPath'] not in payload_hashes:
            payload_hashes[source['rawPath']] = digest(raw)
        if payload_hashes[source['rawPath']] != source['assetSha256']:
            raise ValueError('Source binary fingerprint changed')
        entry = resolve(record['jsonPointer'])
        if (str(resolve(record['idPointer'])) != record['id'] or
                resolve(record['malePointer']) != record['maleVariant'] or
                resolve(record['femalePointer']) != record['femaleVariant'] or
                entry.get('secondaryKey') != record['secondaryKey'] or entry['$type'] != record['type']):
            raise ValueError('Normalized row does not match source pointer')
        sql_stream.update((encoded + '\n').encode('utf-8'))
        count += 1
    db.close()
    # Text files may use CRLF on Windows; compare canonical lines while also
    # recording the physical JSONL hash below for byte-level provenance.
    jsonl_stream = hashlib.sha256()
    with (job.output / 'index/entries.jsonl').open('r', encoding='utf-8') as stream:
        for line in stream:
            jsonl_stream.update(line.encode('utf-8'))
    if sql_stream.hexdigest() != jsonl_stream.hexdigest():
        raise ValueError('SQLite and JSONL entries disagree')
    result = {'version': 1, 'verifiedAt': datetime.now(timezone.utc).isoformat(),
              'rowsResolvedExactly': count, 'nonemptyAssetsHashed': len(payload_hashes),
              'sqliteIntegrity': integrity, 'jsonlMatchesSqlite': True,
              'entriesSha256': digest(job.output / 'index/entries.jsonl'),
              'canonicalEntriesSha256': sql_stream.hexdigest(), 'complete': True,
              'scope': 'Every indexed identifier and text value matched its exact source JSON pointer; '
              'all referenced raw asset SHA256 hashes matched. Does not validate narrative interpretation.'}
    write_json(job.output / 'index/verification.json', result)
    print(json.dumps(result), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', default=str(Path(__file__).resolve().parents[3]))
    parser.add_argument('--game', default=r'E:\SteamLibrary\steamapps\common\Cyberpunk 2077')
    parser.add_argument('--output')
    parser.add_argument('--index-only', action='store_true')
    parser.add_argument('--audit-scene', action='append', default=[], help='Already exported scene JSON to qualify')
    parser.add_argument('--audit-only', action='store_true', help='Use the existing text index; only audit explicit scenes')
    parser.add_argument('--verify-only', action='store_true', help='Resolve every existing lookup entry to its source pointer')
    parser.add_argument('--max-cache-gib', type=float, default=3)
    args = parser.parse_args()
    args.output = args.output or str(Path(args.project) / 'research/cyberpunk/cache/game/localization')
    job = Job(args)
    if not contained(job.output, job.project / 'research/cyberpunk/cache/game/localization'):
        raise ValueError('Localization output must remain inside its owned research cache')
    if args.verify_only:
        verify(job)
        return
    if args.audit_only:
        if not args.audit_scene:
            parser.error('--audit-only requires at least one --audit-scene')
        audit_scenes(job, args.audit_scene)
        return
    if args.index_only:
        manifest = json.loads((job.output / 'inventory.json').read_text(encoding='utf-8'))
    else:
        manifest = inventory(job)
        extract(job, manifest)
    index(job, manifest)
    verify(job)
    if args.audit_scene:
        audit_scenes(job, args.audit_scene)


if __name__ == '__main__':
    main()
