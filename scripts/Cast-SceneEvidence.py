"""Export at most 32 exact native resources into one isolated voice-casting lane.

This is the bounded extract_scene_evidence.py workflow, without the quest
indexer's output or inventory mutation. RDAR v12 winners are resolved base then
EP1; only winning payloads are extracted. Every payload's decoded size and SHA-1,
and every serialization's source path and SHA-256, are checked before publication.
No game writes, cloud calls, audio generation or archive-wide extraction occur.

CLI: --project ROOT --game GAME --lane LANE --batch NAME
     --lane-inventory runtime/.../casting-lanes.json --depot exact\\path.scene
Repeat --depot at most 32 times. The lane must match the current inventory.
Allowed types: .scene/.community/.questphase/.quest/.gamedef; no patterns.
Output: runtime/voice-cast/LANE/scenes/NAME/{inventory.json,provenance.json,raw,logs}.
provenance.json.scenes uses Cast-VoiceReferenceCandidates.py's scene object format;
inventory.json assets retain the native-export compatibility fields.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import time


SCRIPT_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_ROOT.parent
ARCHIVES = (('base', 'archive/pc/content/basegame_4_gamedata.archive'),
            ('ep1', 'archive/pc/ep1/ep1_2_gamedata.archive'))
MAX_PATHS = 32
MAX_INDEX_BYTES = 256 * 1024 ** 2
MAX_DOCUMENT_BYTES = 64 * 1024 ** 2
NAME = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*\Z')
SHA1 = re.compile(r'[a-f0-9]{40}\Z')
EXTENSIONS = {'.scene', '.community', '.questphase', '.quest', '.gamedef'}
WINDOWS_DEVICES = re.compile(r'(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?\Z', re.I)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError('Required source module cannot be loaded')
    module = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


# Reuse the source-verified hash/path/atomic JSON utilities, not Job/index_exports:
# those classes own the shared quest-cache output and must never be invoked here.
knowledge = load_module('cast_scene_knowledge', PROJECT_ROOT / 'research/cyberpunk/scripts/index_game_knowledge.py')
voice_gate = load_module('cast_scene_voice_gate', SCRIPT_ROOT / 'Cast-VoiceReferenceCandidates.py')
CpuSlots, LaneLock = voice_gate.CpuSlots, voice_gate.LaneLock
WOLVENKIT_SHA256 = voice_gate.WOLVENKIT_SHA256


def digest(path, algorithm='sha256'):
    return knowledge.digest(path, algorithm)


def read_json(path):
    if not 0 < path.stat().st_size <= MAX_DOCUMENT_BYTES:
        raise ValueError('JSON evidence exceeds its bounded size')
    return json.loads(path.read_text(encoding='utf-8-sig'))


def bounded_number(value, low, high, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(label + ' is outside its finite bound')
    return value


def depot_path(value):
    if not isinstance(value, str):
        raise ValueError('An exact relative native depot path is required')
    path = value.replace('/', '\\').lower()
    parts = path.split('\\')
    if (Path(path.rsplit('\\', 1)[-1]).suffix not in EXTENSIONS or len(path) > 400 or not path.isascii()
            or any(ord(c) < 32 or c in ':<>"|?*' for c in path)
            or any(p in {'', '.', '..'} or p.endswith((' ', '.')) or WINDOWS_DEVICES.fullmatch(p) for p in parts)):
        raise ValueError('Unsafe or mismatched exact native depot path')
    return path


def allowlist(values):
    if not isinstance(values, (list, tuple)) or not 1 <= len(values) <= MAX_PATHS:
        raise ValueError('Request 1..32 exact scene paths; empty or broad requests are forbidden')
    result = sorted({depot_path(v) for v in values})
    if not result:
        raise ValueError('The scene allowlist cannot be empty')
    return result


def safe_file(value, project):
    path = Path(value)
    path = (path if path.is_absolute() else project / path).resolve()
    if not knowledge.contained(path, project) or not path.is_file():
        raise ValueError('Evidence must be an existing file within the project')
    return path


def output_path(project, game, lane, batch):
    if not isinstance(lane, str) or not NAME.fullmatch(lane) or len(lane) > 64:
        raise ValueError('A short lowercase casting lane is required')
    if not isinstance(batch, str) or not NAME.fullmatch(batch) or len(batch) > 64:
        raise ValueError('A short lowercase batch name is required')
    if lane == 'accepted-existing':
        raise ValueError('Accepted voice profiles are preserved; this lane cannot be exported')
    root = project / 'runtime' / 'voice-cast'
    out = root / lane / 'scenes' / batch
    if (not knowledge.contained(out, root) or out.resolve() != out.absolute()
            or knowledge.contained(out, game) or knowledge.contained(game, out)):
        raise ValueError('Casting output escapes its exact isolated lane or overlaps the game')
    return out


def lane_receipt(project, lane, supplied):
    path = safe_file(supplied, project)
    document = read_json(path)
    rows = [x for x in document.get('lanes', []) if x.get('name') == lane]
    if len(rows) != 1 or rows[0].get('mode') != 'metadata_then_bounded_decode':
        raise ValueError('Casting lane is not authorized by the supplied inventory')
    return {'path': path.relative_to(project).as_posix(), 'sha256': digest(path), 'lane': lane}


def tools(project):
    vendor = project / 'vendor'
    cli = vendor / 'wolvenkit-console-9.0.1/WolvenKit.CLI.exe'
    runtime = vendor / 'dotnet-runtime-10.0.12'
    dotnet = runtime / 'dotnet.exe'
    for path in (cli, dotnet):
        if not knowledge.contained(path, vendor) or path.resolve() != path.absolute() or not path.is_file():
            raise FileNotFoundError('The fixed contained WolvenKit/.NET tool installation is missing or redirected')
    if digest(cli) != WOLVENKIT_SHA256:
        raise ValueError('The pinned native serializer SHA-256 does not match the reviewed installation')
    return cli, runtime, {'name': 'WolvenKit.CLI', 'distribution': '9.0.1',
                          'path': str(cli.resolve()), 'sha256': digest(cli),
                          'dotnetPath': str(dotnet.resolve()), 'dotnetSha256': digest(dotnet)}


def read_archive_index(path):
    """The verified RDAR v12 layout, with strict segment/file/dependency bounds."""
    size = path.stat().st_size
    with path.open('rb') as stream:
        header = stream.read(20)
        if len(header) != 20:
            raise ValueError('Truncated RDAR header')
        magic, version, offset, index_size = struct.unpack('<4sIQI', header)
        if magic != b'RDAR' or version != 12 or offset < 20 or not 28 <= index_size <= MAX_INDEX_BYTES or offset + index_size > size:
            raise ValueError('Unsupported or out-of-bounds RDAR directory')
        stream.seek(offset)
        index_header = stream.read(28)
        if len(index_header) != 28:
            raise ValueError('Truncated RDAR directory')
        _, _, _, count, segment_count, dependency_count = struct.unpack('<IIQIII', index_header)
        if 28 + count * 56 + segment_count * 16 + dependency_count * 8 > index_size:
            raise ValueError('Archive directory exceeds bounds')
        rows = [struct.unpack('<QqIIIII20s', stream.read(56)) for _ in range(count)]
        segments = [struct.unpack('<QII', stream.read(16)) for _ in range(segment_count)]
    result = {}
    for row_index, (hashed, _, _, first, end, dep_start, dep_end, sha1) in enumerate(rows):
        if first >= end or end > len(segments) or dep_start > dep_end or dep_end > dependency_count:
            raise ValueError('Invalid archive segment or dependency range')
        selected = segments[first:end]
        if any(not stored or not decoded or location < 20 or location + stored > size for location, stored, decoded in selected):
            raise ValueError('Resource segment exceeds archive bounds')
        key = str(hashed)
        if key in result:
            # WolvenKit ArchiveReader.ReadIndex keeps the FIRST matching hash:
            # https://github.com/WolvenKit/WolvenKit/blob/main/WolvenKit.RED4/Archive/IO/ArchiveReader.cs#L164-L175
            # The installed EP1 archive has one duplicate hash with equal SHA-1
            # and different segments. Retain the actual CLI-winning first row.
            result[key].setdefault('shadowedArchiveRows', []).append({'archiveEntryIndex': row_index,
                                                                     'archiveEntrySha1': sha1.hex(),
                                                                     'segmentsStart': first, 'segmentsEnd': end})
            continue
        result[key] = {'archiveEntryIndex': row_index, 'archiveEntrySha1': sha1.hex(), 'segments': end - first,
                       'segmentBounds': [{'index': first + i, 'offset': str(location), 'storedBytes': stored,
                                          'decodedBytes': decoded} for i, (location, stored, decoded) in enumerate(selected)],
                       'storedBytes': sum(s[1] for s in selected), 'decodedBytes': sum(s[2] for s in selected)}
    return result


def resolve_winners(game, out, depots, max_decoded_bytes):
    winners, sources = {}, []
    for priority, (archive, relative) in enumerate(ARCHIVES):
        path = game / relative
        if not knowledge.contained(path, game) or path.resolve() != path.absolute():
            raise ValueError('Installed archive path is redirected outside the fixed game root')
        if not path.is_file():
            if archive == 'base':
                raise FileNotFoundError('Installed base scene archive is missing')
            continue
        index = read_archive_index(path)
        stat = path.stat()
        for depot in depots:
            hashed = str(knowledge.fnv(depot, 64))
            if hashed not in index:
                continue
            raw = out / 'raw' / archive / Path(*depot.split('\\'))
            if not knowledge.contained(raw, out) or raw.resolve() != raw.absolute():
                raise ValueError('Raw scene output is redirected')
            entry = {'archive': archive, 'archivePath': relative, 'priority': priority,
                     'archiveBytes': stat.st_size, 'archiveMtimeNs': str(stat.st_mtime_ns),
                     'depotPath': depot, 'resourceKind': depot.rsplit('.', 1)[-1], 'pathHash64': hashed, **index[hashed],
                     'rawPath': raw.relative_to(out).as_posix(), 'jsonPath': raw.relative_to(out).as_posix() + '.json'}
            sources.append(entry)
            winners[depot] = entry
    assets = [winners[d] for d in depots if d in winners]
    for entry in assets:
        entry['winner'] = True
        entry['shadowedSources'] = [{k: v for k, v in source.items() if k not in {'rawPath', 'jsonPath'}}
                                    for source in sources if source['depotPath'] == entry['depotPath'] and source is not entry]
    decoded = sum(e['decodedBytes'] for e in assets)
    if decoded > max_decoded_bytes:
        raise RuntimeError('The winning scene decode byte budget is exceeded')
    return assets, sorted(set(depots) - set(winners)), decoded


def fingerprint(manifest):
    return (manifest.get('requestedPaths'), [(e['depotPath'], e['archivePath'], e['archiveEntrySha1'], e['decodedBytes'])
                                           for e in manifest.get('assets', [])])


def verify_raw(out, asset):
    path = out / asset['rawPath']
    if not knowledge.contained(path, out) or path.resolve() != path.absolute() or not path.is_file():
        raise ValueError('Winning extracted scene is missing or redirected')
    if not SHA1.fullmatch(asset['archiveEntrySha1']) or path.stat().st_size != asset['decodedBytes'] or digest(path, 'sha1') != asset['archiveEntrySha1']:
        raise ValueError('Winning scene decoded size or archive SHA-1 mismatch')
    asset['assetSha256'] = digest(path)
    asset['sha1Verified'] = True


def verify_serialized(out, asset, expected_sha256=None):
    path, raw = out / asset['jsonPath'], out / asset['rawPath']
    if not knowledge.contained(path, out) or path.resolve() != path.absolute():
        raise ValueError('Scene serialization output is redirected')
    document = read_json(path)
    if (not isinstance(document.get('Data', {}).get('RootChunk'), dict)
            or Path(document['Header']['ArchiveFileName']).resolve() != raw.resolve()):
        raise ValueError('Scene serialization source does not match the winning raw resource')
    hashed = digest(path)
    if expected_sha256 is not None and hashed != expected_sha256:
        raise ValueError('Existing scene serialization SHA-256 changed; preserve evidence and use a new batch')
    asset['jsonSha256'] = hashed
    asset['serializationVerified'] = True


class SceneJob:
    def __init__(self, project, out, cli, runtime, byte_limit, timeout):
        self.project, self.out, self.cli = project, out, cli
        self.byte_limit, self.timeout = byte_limit, timeout
        self.env = {**os.environ, 'DOTNET_ROOT': str(runtime), 'DOTNET_PROCESSOR_COUNT': '1',
                    'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1'}

    def size(self):
        total = 0
        for path in self.out.rglob('*'):
            if path.is_symlink() or not knowledge.contained(path, self.out):
                raise ValueError('Scene batch contains a redirected output')
            if path.is_file():
                total += path.stat().st_size
        if total > self.byte_limit:
            raise RuntimeError('Scene output byte budget exceeded')
        return total

    def run(self, arguments, label):
        log_path = self.out / 'logs' / (label + '.log')
        log_path.parent.mkdir(parents=True, exist_ok=True)
        if log_path.resolve() != log_path.absolute():
            raise ValueError('Subprocess log path is redirected')
        options = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        with log_path.open('w', encoding='utf-8') as log:
            child = subprocess.Popen([str(self.cli), *map(str, arguments)], cwd=self.project, env=self.env,
                                     stdout=log, stderr=subprocess.STDOUT, shell=False, **options)
            started = time.monotonic()
            try:
                while child.poll() is None:
                    self.size()
                    if time.monotonic() - started > self.timeout:
                        raise TimeoutError('Bounded scene subprocess timed out; partial evidence is preserved')
                    time.sleep(0.25)
                self.size()
                if child.returncode:
                    raise RuntimeError('Scene subprocess failed; inspect its lane-local log: ' + label)
            except BaseException:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=10)
                raise


def scene_receipts(project, out, manifest):
    return [{'manifestPath': (out / 'inventory.json').relative_to(project).as_posix(),
             'depotPath': a['depotPath'], 'archive': a['archivePath'], 'entrySha1': a['archiveEntrySha1'],
             'rawPath': (out / a['rawPath']).relative_to(project).as_posix(), 'rawSha256': a['assetSha256'],
             'jsonPath': (out / a['jsonPath']).relative_to(project).as_posix(), 'jsonSha256': a['jsonSha256']}
            for a in manifest['assets']]


def publish_completed(project, out, manifest, job):
    """Budget exact final metadata before publishing the inventory commit marker."""
    inventory = out / 'inventory.json'
    provenance = out / 'provenance.json'
    pending = out / 'inventory-pending.json'
    staged_inventory = out / '.inventory-ready.json'
    staged_provenance = out / '.provenance-ready.json'
    replaced = (inventory, provenance, pending, staged_inventory, staged_provenance)
    for path in replaced:
        if path.resolve() != path.absolute() or not knowledge.contained(path, out):
            raise ValueError('Scene publication metadata is redirected')
    baseline = job.size() - sum(p.stat().st_size for p in replaced if p.is_file())
    resources = scene_receipts(project, out, manifest)
    encoded = lambda value: (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    manifest['totals']['outputBytes'] = baseline
    # outputBytes includes its own digits, and the provenance includes the final
    # manifest hash. Converge the small integer-size difference before any write.
    for _ in range(8):
        inventory_bytes = encoded(manifest)
        receipt = {'schemaVersion': 1, 'lane': manifest['lane'], 'batch': manifest['batch'],
                   'complete': manifest['complete'], 'inventorySha256': hashlib.sha256(inventory_bytes).hexdigest(),
                   'missingPaths': manifest['missingPaths'], 'resources': resources,
                   'scenes': [r for r in resources if r['depotPath'].endswith('.scene')]}
        provenance_bytes = encoded(receipt)
        planned = baseline + len(inventory_bytes) + len(provenance_bytes)
        if planned == manifest['totals']['outputBytes']:
            break
        manifest['totals']['outputBytes'] = planned
    else:
        raise RuntimeError('Final scene metadata byte calculation did not converge')
    if planned > job.byte_limit:
        raise RuntimeError('Final scene metadata would exceed the output byte budget')
    # Staged copies count toward the actual transient budget too. A failure here
    # preserves the last published inventory rather than leaving a new complete
    # receipt from a run which reported failure.
    staged_inventory.write_bytes(inventory_bytes)
    staged_provenance.write_bytes(provenance_bytes)
    job.size()
    pending.unlink(missing_ok=True)
    knowledge.replace_with_retry(staged_provenance, provenance)
    # Inventory is the last commit marker consumed by casting workers.
    knowledge.replace_with_retry(staged_inventory, inventory)


def run(project, game, lane, batch, depots, lane_inventory, *, max_decoded_mib=256, max_output_mib=1024,
        process_timeout=600, lock_timeout=120, dry_run=False):
    project, game = Path(project).resolve(), Path(game).resolve()
    depots = allowlist(depots)
    out = output_path(project, game, lane, batch)
    lane_source = lane_receipt(project, lane, lane_inventory)
    byte_limit = int(bounded_number(max_output_mib, 1, 4096, 'Output MiB budget') * 1024 ** 2)
    decoded_limit = int(bounded_number(max_decoded_mib, 0.01, 512, 'Decoded MiB budget') * 1024 ** 2)
    bounded_number(process_timeout, 1, 1200, 'Subprocess timeout')
    bounded_number(lock_timeout, 0, 300, 'CPU lock timeout')
    cli, runtime, tool = tools(project)
    # All installed archive reads and tool subprocesses are inside the same
    # two-slot OS gate as candidate audio decoding, with one CPU per worker.
    with LaneLock(project, lane, timeout=lock_timeout), CpuSlots(project, timeout=lock_timeout):
        assets, missing, decoded = resolve_winners(game, out, depots, decoded_limit)
        manifest = {'version': 1, 'schemaVersion': 1, 'createdAt': datetime.now(timezone.utc).isoformat(),
                    'scope': 'Exact allowlisted installed native scene winners for isolated voice-cast attribution',
                    'lane': lane, 'batch': batch, 'laneInventory': lane_source, 'tool': tool,
                    'precedence': [a[0] for a in ARCHIVES], 'requestedPaths': depots, 'missingPaths': missing,
                    'winnerCount': len(assets), 'assetCount': len(assets), 'totals': {'decodedBytes': decoded},
                    'assets': assets, 'complete': False, 'status': 'metadata_verified'}
        if dry_run:
            return {**manifest, 'dryRun': True, 'output': str(out)}
        old_path = out / 'inventory.json'
        pending_path = out / 'inventory-pending.json'
        for path in (old_path, pending_path):
            if path.resolve() != path.absolute() or not knowledge.contained(path, out):
                raise ValueError('Prior scene inventory metadata is redirected')
        previous_path = old_path if old_path.is_file() else pending_path
        old = read_json(previous_path) if previous_path.is_file() else None
        if old is not None and fingerprint(old) != fingerprint(manifest):
            raise ValueError('Batch has different requested scenes or native winners; use a new batch')
        out.mkdir(parents=True, exist_ok=True)
        job = SceneJob(project, out, cli, runtime, byte_limit, process_timeout)
        job.size()
        knowledge.write_json(pending_path, manifest)
        try:
            for archive, relative in ARCHIVES:
                selected = [a for a in assets if a['archive'] == archive]
                absent = [a for a in selected if not (out / a['rawPath']).is_file()]
                if absent:
                    root = out / 'raw' / archive
                    root.mkdir(parents=True, exist_ok=True)
                    pattern = '^(' + '|'.join(re.escape(a['depotPath']) for a in absent) + ')$'
                    job.run(['extract', game / relative, '--outpath', root, '--regex', pattern], 'extract-' + archive)
                for asset in selected:
                    verify_raw(out, asset)
                    json_path = out / asset['jsonPath']
                    old_asset = next((a for a in old.get('assets', []) if a.get('depotPath') == asset['depotPath']), None) if old else None
                    if json_path.is_file() and (old_asset is None or not old_asset.get('jsonSha256')):
                        raise ValueError('Orphan scene JSON has no verified serialization baseline; preserve it and use a new batch')
                    if not json_path.is_file():
                        # Exact file paths avoid WolvenKit's basename-flattening
                        # --outpath behavior and cannot expand to a whole archive.
                        job.run(['convert', 'serialize', out / asset['rawPath']], 'serialize-' + archive + '-' + str(selected.index(asset)))
                    verify_serialized(out, asset, old_asset.get('jsonSha256') if old_asset else None)
                    knowledge.write_json(pending_path, manifest)
            manifest['complete'] = not missing
            manifest['status'] = 'serialized_verified' if not missing else 'missing_requested_resources'
            publish_completed(project, out, manifest, job)
        except BaseException:
            manifest['status'] = 'failed_or_interrupted'
            manifest['complete'] = False
            # Preserve the last published integrity baseline even on repeated
            # failures. The pending receipt never replaces trusted old hashes.
            if old is not None:
                for asset in manifest['assets']:
                    old_asset = next((a for a in old.get('assets', []) if a.get('depotPath') == asset['depotPath']), None)
                    if old_asset is not None:
                        for key in ('assetSha256', 'jsonSha256', 'sha1Verified', 'serializationVerified'):
                            if key in old_asset and key not in asset:
                                asset[key] = old_asset[key]
            knowledge.write_json(pending_path, manifest)
            raise
        return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=PROJECT_ROOT)
    parser.add_argument('--game', type=Path, required=True)
    parser.add_argument('--lane', required=True)
    parser.add_argument('--batch', required=True)
    parser.add_argument('--lane-inventory', type=Path, required=True)
    parser.add_argument('--depot', action='append', required=True)
    parser.add_argument('--max-decoded-mib', type=float, default=256)
    parser.add_argument('--max-output-mib', type=float, default=1024)
    parser.add_argument('--process-timeout', type=float, default=600)
    parser.add_argument('--lock-timeout', type=float, default=120)
    parser.add_argument('--dry-run', action='store_true', help='Validate tools and winning archive metadata; export no scene files')
    args = parser.parse_args()
    try:
        result = run(args.project, args.game, args.lane, args.batch, args.depot, args.lane_inventory,
                     max_decoded_mib=args.max_decoded_mib, max_output_mib=args.max_output_mib,
                     process_timeout=args.process_timeout, lock_timeout=args.lock_timeout, dry_run=args.dry_run)
    except (OSError, ValueError, RuntimeError, KeyError, struct.error) as error:
        parser.exit(1, type(error).__name__ + ': ' + str(error) + '\n')
    print(json.dumps({'lane': args.lane, 'batch': args.batch, 'dryRun': args.dry_run,
                      'complete': result['complete'], 'winnerCount': result['winnerCount'],
                      'missingPaths': result['missingPaths'], 'decodedBytes': result['totals']['decodedBytes']}, ensure_ascii=False))
    return 0 if args.dry_run or result['complete'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
