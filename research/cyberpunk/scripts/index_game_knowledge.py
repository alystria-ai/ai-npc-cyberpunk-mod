"""Bounded, resumable read-only Cyberpunk quest resource extraction and indexing.

No game/save/fact writes or network access. Raw resources and normalized evidence
remain under the ignored cache/game directory. A fact name is an indexed symbol,
never a claim about what happened in a player's save. JSON pointers are RFC 6901.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import time

ARCHIVES = (
    ('base', 'archive/pc/content/basegame_4_gamedata.archive'),
    ('ep1', 'archive/pc/ep1/ep1_2_gamedata.archive'),
)
RESOURCE_PATTERN = r'(\.quest$|\.questphase$|\\cooked_journal\.journal$)'
INDEX_VERSION = 1


def utc():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    replace_with_retry(temp, path)


def replace_with_retry(source, destination):
    """Windows readers may omit FILE_SHARE_DELETE; preserve the staged file."""
    deadline = time.monotonic() + 60
    while True:
        try:
            source.replace(destination)
            return
        except PermissionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.5)


def publish_index(index_root, summary):
    # Summary is the commit marker. Pending manifest survives a blocked rename,
    # and --publish-only can finish the exact completed generation later.
    pending = index_root / 'publish-pending.json'
    write_json(pending, summary)
    for source in sorted(index_root.glob('*.jsonl.tmp')):
        replace_with_retry(source, source.with_suffix(''))
    write_json(index_root / 'summary.json', summary)
    pending.unlink(missing_ok=True)


def digest(path, algorithm='sha256'):
    result = hashlib.new(algorithm)
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def fnv(value, bits):
    offset, prime = ((0xCBF29CE484222325, 0x100000001B3) if bits == 64 else (0x811C9DC5, 0x1000193))
    for byte in value.encode('utf-8'):
        offset = ((offset ^ byte) * prime) & ((1 << bits) - 1)
    return offset


def read_archive_index(path):
    """Inspect RDAR v12 directory only; do not read/decompress resource payloads."""
    with path.open('rb') as stream:
        magic, version, offset, size = struct.unpack('<4sIQI', stream.read(20))
        if magic != b'RDAR' or version != 12 or offset + size > path.stat().st_size:
            raise ValueError(f'Unsupported or invalid archive: {path.name}')
        stream.seek(offset)
        _, _, _, count, segment_count, dependency_count = struct.unpack('<IIQIII', stream.read(28))
        if 28 + count * 56 + segment_count * 16 + dependency_count * 8 > size:
            raise ValueError('Archive directory exceeds bounds')
        rows = [struct.unpack('<QqIIIII20s', stream.read(56)) for _ in range(count)]
        segments = [struct.unpack('<QII', stream.read(16)) for _ in range(segment_count)]
    result = {}
    for hashed, timestamp, flags, first, end, dep_start, dep_end, sha1 in rows:
        if first >= end or end > len(segments):
            raise ValueError('Invalid segment range')
        selected = segments[first:end]
        result[str(hashed)] = {'archiveEntrySha1': sha1.hex(), 'segments': end - first,
                              'storedBytes': sum(s[1] for s in selected),
                              'decodedBytes': sum(s[2] for s in selected)}
    return result


def contained(path, root):
    return path.resolve().is_relative_to(root.resolve())


class Job:
    def __init__(self, args):
        self.args = args
        self.project, self.game, self.output = (Path(v).resolve() for v in (args.project, args.game, args.output))
        expected = self.project / 'research' / 'cyberpunk' / 'cache' / 'game'
        if not contained(self.output, expected):
            raise ValueError('Output must remain inside this project research/cyberpunk/cache/game')
        self.output.mkdir(parents=True, exist_ok=True)
        self.cli = self.project / 'vendor' / 'wolvenkit-console-9.0.1' / 'WolvenKit.CLI.exe'
        self.env = {**os.environ, 'DOTNET_ROOT': str(self.project / 'vendor' / 'dotnet-runtime-10.0.12'),
                    'DOTNET_PROCESSOR_COUNT': '2'}
        self.byte_limit = int(args.max_cache_gib * 1024 ** 3)

    def progress(self, stage, **values):
        write_json(self.output / 'progress.json', {'version': INDEX_VERSION, 'updatedAt': utc(), 'stage': stage, **values})

    def run(self, arguments, label, expect=None):
        log_path = self.output / 'logs' / (label + '.log')
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open('w', encoding='utf-8') as log:
            options = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
            child = subprocess.Popen([str(self.cli), *map(str, arguments)], env=self.env,
                                     cwd=self.project, stdout=log, stderr=subprocess.STDOUT, **options)
            started = time.monotonic()
            try:
                while child.poll() is None:
                    time.sleep(3)
                    files = list((self.output / 'raw').rglob('*')) if (self.output / 'raw').exists() else []
                    size = sum(p.stat().st_size for p in files if p.is_file())
                    if size > self.byte_limit:
                        raise RuntimeError('Cache byte budget exceeded; completed files remain resumable')
                    if time.monotonic() - started > 2700:
                        raise TimeoutError(f'{label} exceeded 45-minute process bound')
                    completed = sum(p.is_file() and p.suffix == '.json' for p in files)
                    self.progress(label, running=True, completedJson=completed, expected=expect,
                                  cacheBytes=size, elapsedSeconds=round(time.monotonic() - started))
                if child.returncode:
                    raise RuntimeError(f'{label} exited {child.returncode}: {log_path}')
            except BaseException:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
                raise
        return log_path.read_text(encoding='utf-8', errors='replace')

    def inventory(self):
        manifest, winners = [], {}
        for priority, (archive_id, relative) in enumerate(ARCHIVES):
            path = self.game / relative
            if not path.is_file():
                if archive_id == 'ep1':
                    continue
                raise FileNotFoundError(path)
            self.progress('inventory', archive=archive_id)
            lines = self.run(['archive', path, '--list', '--regex', RESOURCE_PATTERN], f'inventory-{archive_id}')
            resources = [s.strip() for s in lines.splitlines() if re.search(RESOURCE_PATTERN, s.strip())]
            if len(resources) != len(set(resources)):
                raise ValueError('Duplicate archive path output')
            index = read_archive_index(path)
            stat = path.stat()
            for depot in resources:
                normalized = depot.replace('/', '\\').lower()
                resource_hash = str(fnv(normalized, 64))
                if resource_hash not in index:
                    raise ValueError(f'CLI path hash is missing in archive: {depot}')
                raw = self.output / 'raw' / archive_id / Path(*depot.split('\\'))
                if not contained(raw, self.output / 'raw' / archive_id):
                    raise ValueError('Unsafe archive depot path')
                entry = {'archive': archive_id, 'archivePath': relative, 'priority': priority,
                         'archiveBytes': stat.st_size, 'archiveMtimeNs': str(stat.st_mtime_ns),
                         'depotPath': depot, 'pathHash64': resource_hash, **index[resource_hash],
                         'rawPath': str(raw.relative_to(self.output)).replace('\\', '/'),
                         'jsonPath': str(raw.relative_to(self.output)).replace('\\', '/') + '.json'}
                manifest.append(entry)
                winners[normalized] = entry
        for entry in manifest:
            entry['winner'] = winners[entry['depotPath'].lower()] is entry
        totals = {name: sum(e[name] for e in manifest) for name in ('storedBytes', 'decodedBytes')}
        document = {'version': INDEX_VERSION, 'createdAt': utc(), 'tool': 'WolvenKit.CLI 9.0.1',
                    'scope': 'Installed base and Phantom Liberty .quest/.questphase/cooked journals; no mod overlays',
                    'precedence': ['base', 'ep1'], 'winnerCount': len(winners), 'assetCount': len(manifest),
                    'totals': totals, 'counts': dict(Counter((e['archive'] + ':' + Path(e['depotPath']).suffix) for e in manifest)),
                    'assets': manifest}
        previous_path = self.output / 'inventory.json'
        if previous_path.is_file() and (self.output / 'raw').exists():
            previous = json.loads(previous_path.read_text(encoding='utf-8'))
            fingerprint = lambda entries: {(e['archive'], e['depotPath']): e['archiveEntrySha1'] for e in entries}
            if fingerprint(previous['assets']) != fingerprint(manifest):
                raise RuntimeError('Archive inputs changed; use a new output subdirectory to preserve old evidence')
        write_json(self.output / 'inventory.json', document)
        if totals['decodedBytes'] > self.args.max_decoded_gib * 1024 ** 3:
            raise RuntimeError(f'Decoded input budget exceeded: {totals["decodedBytes"]} bytes')
        if len(manifest) > 6000:
            raise RuntimeError('Asset budget exceeded (6000); review new archive inventory')
        if shutil.disk_usage(self.output).free < min(self.byte_limit, totals['decodedBytes'] * 20 + 1024 ** 3):
            raise RuntimeError('Insufficient free disk for bounded JSON conversion')
        self.progress('inventoried', assets=len(manifest), winners=len(winners), **totals)
        print(json.dumps({'assets': len(manifest), 'winners': len(winners), **totals}), flush=True)
        return document

    def extract(self, inventory):
        for archive_id, relative in ARCHIVES:
            entries = [e for e in inventory['assets'] if e['archive'] == archive_id]
            if not entries:
                continue
            raw_root = self.output / 'raw' / archive_id
            raw_root.mkdir(parents=True, exist_ok=True)
            missing = [e for e in entries if not (self.output / e['rawPath']).is_file()
                       or (self.output / e['rawPath']).stat().st_size != e['decodedBytes']]
            if missing:
                self.run(['extract', self.game / relative, '--outpath', raw_root, '--regex', RESOURCE_PATTERN],
                         f'extract-{archive_id}', len(entries))
            # Verify byte identity before conversion. Uncompressed CR2W may use several
            # archive segments; the CLI concatenation SHA-1 must match the entry hash.
            for entry in entries:
                raw = self.output / entry['rawPath']
                if not raw.is_file() or digest(raw, 'sha1') != entry['archiveEntrySha1']:
                    raise RuntimeError(f'Archive payload mismatch: {entry["depotPath"]}')
                entry['assetSha256'] = digest(raw)
            write_json(self.output / 'inventory.json', inventory)
            missing_json = []
            for entry in entries:
                try:
                    exported = json.loads((self.output / entry['jsonPath']).read_text(encoding='utf-8-sig'))
                    if Path(exported['Header']['ArchiveFileName']).resolve() != (self.output / entry['rawPath']).resolve():
                        raise ValueError('Mismatched serialization source')
                except (OSError, ValueError, KeyError):
                    missing_json.append(entry)
            if not missing_json:
                continue
            if len(missing_json) == len(entries):
                # Deliberately omit --outpath: WolvenKit otherwise flattens basenames
                # and overwrites distinct quest phases that happen to share a name.
                self.run(['convert', 'serialize', raw_root, '--regex', RESOURCE_PATTERN],
                         f'serialize-{archive_id}', len(entries))
            else:
                batch, length, number = [], 0, 0
                for entry in missing_json:
                    path = str(self.output / entry['rawPath'])
                    if batch and length + len(path) > 24000:
                        self.run(['convert', 'serialize', *batch], f'resume-{archive_id}-{number}', len(entries))
                        batch, length, number = [], 0, number + 1
                    batch.append(path)
                    length += len(path) + 3
                if batch:
                    self.run(['convert', 'serialize', *batch], f'resume-{archive_id}-{number}', len(entries))
            self.progress('archive-exported', archive=archive_id, assets=len(entries))


def pointer_child(pointer, key):
    return pointer + '/' + str(key).replace('~', '~0').replace('/', '~1')


def walk(value, pointer=''):
    if isinstance(value, dict):
        yield pointer, value
        for key, child in value.items():
            yield from walk(child, pointer_child(pointer, key))
    elif isinstance(value, list):
        for key, child in enumerate(value):
            yield from walk(child, pointer_child(pointer, key))


def scalar(value):
    if isinstance(value, dict):
        return value.get('$value', value.get('value'))
    return value


def index_exports(job, inventory):
    index_root = job.output / 'index'
    index_root.mkdir(parents=True, exist_ok=True)
    # A previous completed generation must never authorize publication of a new
    # interrupted generation's partially written streams.
    (index_root / 'publish-pending.json').unlink(missing_ok=True)
    names = ('facts', 'nodes', 'edges', 'journal', 'journal-paths', 'resources', 'conditions', 'errors')
    streams = {name: (index_root / (name + '.jsonl.tmp')).open('w', encoding='utf-8') for name in names}
    counts, facts, collisions = Counter(), {}, defaultdict(list)
    indexed_assets = 0
    emitted_bytes = 0
    raw_bytes = sum(p.stat().st_size for p in (job.output / 'raw').rglob('*') if p.is_file())

    def emit(kind, record):
        nonlocal emitted_bytes
        encoded = json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n'
        emitted_bytes += len(encoded.encode('utf-8'))
        if raw_bytes + emitted_bytes > job.byte_limit:
            raise RuntimeError('Index output would exceed the cache budget')
        streams[kind].write(encoded)
        counts[kind] += 1

    try:
        for asset in inventory['assets']:
            if not asset['winner']:
                continue
            path = job.output / asset['jsonPath']
            source = {key: asset[key] for key in ('archive', 'depotPath', 'jsonPath', 'pathHash64')}
            source['assetSha256'] = asset.get('assetSha256')
            try:
                document = json.loads(path.read_text(encoding='utf-8-sig'))
                if Path(document['Header']['ArchiveFileName']).resolve() != (job.output / asset['rawPath']).resolve():
                    raise ValueError('Serialized input provenance does not match the manifest asset')
                objects = list(walk(document['Data']['RootChunk'], '/Data/RootChunk'))
                handles, sockets, node_paths = {}, {}, {}
                graph_paths = {p for p, o in objects if o.get('$type') == 'questGraphDefinition'}

                def graph_scope(pointer):
                    current = pointer.rsplit('/', 1)[0]
                    while current:
                        if current in graph_paths:
                            return current
                        current = current.rsplit('/', 1)[0]
                    return None

                for pointer, obj in objects:
                    if 'HandleId' in obj and isinstance(obj.get('Data'), dict):
                        if str(obj['HandleId']) in handles:
                            raise ValueError('Duplicate CR2W HandleId')
                        handles[str(obj['HandleId'])] = (pointer + '/Data', obj['Data'])
                    typ = obj.get('$type', '')
                    # Shipped graph nodes include questMiscAICommandNode and
                    # legacy tempshitMapPinManagerNodeDefinition. Their id and
                    # sockets establish identity; neither a prefix nor a suffix
                    # safely classifies every node in the serialized graph.
                    if 'id' in obj and isinstance(obj.get('sockets'), list):
                        node_paths[pointer] = obj
                        socket_refs = obj.get('sockets', [])
                        node = {'id': obj['id'], 'type': typ, 'jsonPointer': pointer,
                                'graphPointer': graph_scope(pointer)}
                        emit('nodes', {'source': source, **node})
                        for socket in socket_refs:
                            handle = socket.get('HandleRefId', socket.get('HandleId')) if isinstance(socket, dict) else None
                            if handle is not None:
                                sockets[str(handle)] = node
                def owner(pointer):
                    current = pointer
                    while current:
                        node = node_paths.get(current)
                        if node is not None:
                            return {'id': node['id'], 'type': node['$type'], 'jsonPointer': current,
                                    'graphPointer': graph_scope(current)}
                        current = current.rsplit('/', 1)[0]
                    return None

                def endpoint(value):
                    handle = str(value.get('HandleRefId', value.get('HandleId', ''))) if isinstance(value, dict) else ''
                    item = handles.get(handle)
                    return {'handleId': handle, 'resolved': item is not None,
                            'socket': scalar(item[1].get('name')) if item else None,
                            'node': sockets.get(handle), 'jsonPointer': item[0] if item else None}

                for pointer, obj in objects:
                    typ = obj.get('$type', '')
                    for field in ('factName', 'factName1', 'factName2'):
                        fact = scalar(obj.get(field))
                        if not isinstance(fact, str) or not fact:
                            continue
                        role = 'assignment' if typ == 'questSetVar_NodeType' else ('comparison' if typ in (
                            'questVarComparison_ConditionType', 'questVarVsVarComparison_ConditionType') else 'reference')
                        event = {'source': source, 'jsonPointer': pointer, 'type': typ, 'field': field,
                                 'factName': fact, 'role': role, 'node': owner(pointer)}
                        for name in ('value', 'setExactValue', 'comparisonType', 'factName1', 'factName2'):
                            if name in obj:
                                event[name] = scalar(obj[name])
                        emit('facts', event)
                        if fact not in facts:
                            facts[fact] = {'name': fact, 'hash32': str(fnv(fact, 32)), 'occurrences': 0,
                                           'roles': {}, 'firstEvidence': {'source': source, 'jsonPointer': pointer}}
                        facts[fact]['occurrences'] += 1
                        facts[fact]['roles'][role] = facts[fact]['roles'].get(role, 0) + 1
                    if typ == 'graphGraphConnectionDefinition':
                        emit('edges', {'source': source, 'jsonPointer': pointer,
                                       'from': endpoint(obj.get('source')), 'to': endpoint(obj.get('destination'))})
                    if typ.startswith(('quest', 'scn')) and typ.endswith(('Condition', '_ConditionType')):
                        # Store predicates as data alongside exact original pointers;
                        # graph condition presence is not evidence the branch executed.
                        emit('conditions', {'source': source, 'jsonPointer': pointer, 'node': owner(pointer), 'condition': obj})
                    if 'realPath' in obj and ('Journal' in typ or typ == 'gameJournalPath'):
                        emit('journal-paths', {'source': source, 'jsonPointer': pointer,
                                              'node': owner(pointer), 'path': scalar(obj['realPath']),
                                              'className': scalar(obj.get('className')),
                                              'fileEntryIndex': obj.get('fileEntryIndex')})
                    if 'DepotPath' in obj:
                        depot = scalar(obj['DepotPath'])
                        if isinstance(depot, str) and depot:
                            emit('resources', {'source': source, 'jsonPointer': pointer,
                                               'node': owner(pointer), 'depotPath': depot,
                                               'isScene': depot.lower().endswith('.scene')})
                if document['Data']['RootChunk'].get('$type') == 'gameJournalResource':
                    ancestors = set()

                    def journal_tree(holder, pointer, prefix):
                        handle = str(holder.get('HandleId', holder.get('HandleRefId', '')))
                        if handle in ancestors:
                            raise ValueError('Journal entry cycle')
                        ancestors.add(handle)
                        resolved = handles.get(handle)
                        if resolved is None:
                            raise ValueError('Unresolved journal entry handle')
                        pointer, entry = resolved
                        entry_id = scalar(entry.get('id', ''))
                        if not isinstance(entry_id, str):
                            raise ValueError('Journal entry id is not a string')
                        path_parts = [*prefix, entry_id] if entry_id else prefix
                        fields = {k: v for k, v in entry.items()
                                  if k not in ('$type', 'entries', 'journalEntryOverrideDataList')}
                        emit('journal', {'source': source, 'jsonPointer': pointer,
                                         'type': entry.get('$type'), 'path': '/'.join(path_parts),
                                         'id': entry_id, 'fields': fields,
                                         'overrideCount': len(entry.get('journalEntryOverrideDataList', []))})
                        for ordinal, child in enumerate(entry.get('entries', [])):
                            journal_tree(child, pointer + '/entries/' + str(ordinal), path_parts)
                        ancestors.remove(handle)

                    journal_tree(document['Data']['RootChunk']['entry'], '/Data/RootChunk/entry', [])
                indexed_assets += 1
                if indexed_assets % 100 == 0:
                    job.progress('indexing', assets=indexed_assets, expected=inventory['winnerCount'], counts=dict(counts))
            except Exception as error:
                emit('errors', {'source': source, 'error': f'{type(error).__name__}: {error}'})
        for item in facts.values():
            collisions[item['hash32']].append(item['name'])
        hash_collisions = {key: names for key, names in collisions.items() if len(names) > 1}
        write_json(index_root / 'facts-dictionary.json', {
            'version': INDEX_VERSION, 'createdAt': utc(), 'meaning': 'Extracted names, not interpreted decisions',
            'count': len(facts), 'hashCollisions': hash_collisions,
            'facts': sorted(facts.values(), key=lambda value: value['name'])})
    finally:
        for stream in streams.values():
            stream.close()
    summary = {'version': INDEX_VERSION, 'createdAt': utc(), 'indexedAssets': indexed_assets,
               'expectedAssets': inventory['winnerCount'], 'factNames': len(facts),
               'counts': dict(counts), 'hashCollisions': hash_collisions,
               'complete': indexed_assets == inventory['winnerCount'] and not counts['errors']}
    publish_index(index_root, summary)
    job.progress('complete' if summary['complete'] else 'incomplete', **summary)
    print(json.dumps(summary), flush=True)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True)
    parser.add_argument('--game', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--extract', action='store_true')
    parser.add_argument('--index-only', action='store_true')
    parser.add_argument('--publish-only', action='store_true')
    parser.add_argument('--max-decoded-gib', type=float, default=2)
    parser.add_argument('--max-cache-gib', type=float, default=8)
    args = parser.parse_args()
    job = Job(args)
    try:
        if args.publish_only:
            summary = json.loads((job.output / 'index/publish-pending.json').read_text(encoding='utf-8'))
            publish_index(job.output / 'index', summary)
            job.progress('complete' if summary['complete'] else 'incomplete', **summary)
            print(json.dumps(summary), flush=True)
            return 0 if summary['complete'] else 2
        inventory = (json.loads((job.output / 'inventory.json').read_text(encoding='utf-8'))
                     if args.index_only else job.inventory())
        if args.extract:
            job.extract(inventory)
        if args.extract or args.index_only:
            if not index_exports(job, inventory)['complete']:
                return 2
        return 0
    except BaseException as error:
        job.progress('failed', error=f'{type(error).__name__}: {error}', resumable=True)
        raise


if __name__ == '__main__':
    sys.exit(main())
