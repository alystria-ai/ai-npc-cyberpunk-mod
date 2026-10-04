"""Collect explicit source candidates with current production authentication.

No inference, filtering, trimming, caption correction, admission or cloud writes.
Each batch is at most48 explicit variants and resumes immutable per-line output.
"""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import os
import sqlite3
import sys
import time
import wave

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
PINS = {
    'scripts/Cast-VoiceReferenceCandidates.py': '91c8c1ea1d7d5bfe1d2d3f54f6716040f9e43a108c3ec61ecc44e04f5c0a078a',
    'scripts/Extract-VoiceReferences.py': '565077b46ff96bfaf2a44dfd3addf792c1d2bf6b7eb9e14a68acf74a06f3144f',
    'scripts/native_source_contracts.py': '46aef2aaecd6ecd23cad9c7d214da440c3e4fd37754405cec3153aefb6e93ddb',
    'scripts/source_recovery_bridge.py': '1b0f8efb3f9b9300ae921a280682ac899a388862be796e24aac0f84692715c5a',
    'runtime/voice-data-expansion-20261004/scene-inventory/batch_authenticate.py': '041e3b01728786accfadc05dfa79553601d31441ef9b60832c0fc43caab35508',
}

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def inside(value, base=ROOT):
    p = Path(value)
    p = (p if p.is_absolute() else ROOT / p).resolve()
    if not p.is_relative_to(base.resolve()):
        raise ValueError('Path outside its authorized output/source root')
    return p

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--manifest', type=Path, required=True)
    ap.add_argument('--decode', action='store_true')
    args = ap.parse_args()
    manifest_path = inside(args.manifest, OUT.parent)
    manifest = read(manifest_path)
    for name, expected in PINS.items():
        if sha(ROOT / name) != expected:
            raise ValueError('Reviewed production tool changed: ' + name)
    spec = importlib.util.spec_from_file_location('oct4_cast', ROOT / 'scripts/Cast-VoiceReferenceCandidates.py')
    cast = importlib.util.module_from_spec(spec)
    sys.dont_write_bytecode = True
    spec.loader.exec_module(cast)
    rows = manifest['candidates']
    if not 1 <= len(rows) <= 48:
        raise ValueError('Explicit batch must contain1..48 candidates')
    if len({(c['key'], c['stringId'], c['genderVariant']) for c in rows}) != len(rows):
        raise ValueError('Duplicate canonical variant in batch')
    # A separate coordinator-produced selection receipt records the source role
    # resolution; this collector does not promote any row to a training role.
    selection = manifest['selectionReceipt']
    selection_path = inside(selection['path'], OUT.parent)
    if sha(selection_path) != selection['sha256']:
        raise ValueError('Selection/fence receipt changed')
    allowed = read(selection_path)
    tokens = {(x['key'], x['stringId'], x['genderVariant']) for x in allowed['selected']}
    if tokens != {(c['key'], c['stringId'], c['genderVariant']) for c in rows}:
        raise ValueError('Source selection differs from exact batch')
    for dependency in allowed['dependencies']:
        if sha(inside(dependency['path'])) != dependency['sha256']:
            raise ValueError('Selection dependency changed: ' + dependency['path'])
    if any(x.get('reserved') is not False for x in allowed['selected']):
        raise ValueError('Selection lacks explicit unreserved resolution')
    role_path = OUT.parent / 'roster-reservations/role-reservations.json'
    role_code = OUT.parent / 'roster-reservations/check_reservations.py'
    dependencies = {inside(d['path']): d['sha256'] for d in allowed['dependencies']}
    for p in (role_path, role_code):
        if dependencies.get(p.resolve()) != sha(p):
            raise ValueError('Selection must pin finalized role rules and lookup code')
    role_spec = importlib.util.spec_from_file_location('oct4_roles', role_code)
    role_module = importlib.util.module_from_spec(role_spec)
    role_spec.loader.exec_module(role_module)
    reservations = role_module.Reservations(role_path)
    roster, roster_validation = cast.validate_roster_identity(manifest, ROOT)
    tools = cast.tool_info({'tools': [
        {'name': name, 'path': path, 'sha256': expected, 'version': 'Pinned original decoder'}
        for name, (path, expected) in cast.PINNED_TOOLS.items()]})
    db_path = inside(manifest['subtitleIndex'])
    if sha(db_path) != manifest['subtitleIndexSha256']:
        raise ValueError('Subtitle index changed')
    with sqlite3.connect(db_path.as_uri() + '?mode=ro&immutable=1', uri=True) as db:
        for candidate in rows:
            candidate['nativeReceipt'] = cast.validate_native(candidate, roster[candidate['key']], ROOT)
            candidate['subtitleRows'] = cast.indexed_subtitles(db, candidate['stringId'])
            if not candidate['subtitleRows'] or any(r.get(candidate['english']['variant']) != candidate['english']['transcript'] for r in candidate['subtitleRows']):
                raise ValueError('Exact English subtitle variant disagrees')
    emit({'phase': 'source-validated', 'count': len(rows), 'manifest': str(manifest_path.relative_to(ROOT)), 'decode': args.decode})
    if not args.decode:
        return
    batch = manifest['batch']
    if not cast.KEY.fullmatch(batch):
        raise ValueError('Unsafe batch name')
    output = OUT / 'raw-audio'
    output.mkdir(parents=True, exist_ok=True)
    game = Path(manifest['gameRoot']).resolve()
    if output.is_relative_to(game) or game.is_relative_to(output):
        raise ValueError('Output overlaps game')
    receipt = {'rosterSha256': manifest['rosterSha256'], 'rosterValidation': roster_validation,
        'inputSha256': sha(manifest_path), 'audioProcessing': 'Original vgmstream PCM decode only; no gain/EQ/denoise/resample/trim/concat'}
    completed, errors, verified = [], [], {}
    started = time.monotonic()
    with cast.LaneLock(ROOT, 'oct4-collection-' + batch, timeout=300):
        auth_path = OUT.parent / 'scene-inventory/batch_authenticate.py'
        auth_spec = importlib.util.spec_from_file_location('oct4_bulk_auth', auth_path)
        auth = importlib.util.module_from_spec(auth_spec)
        auth_spec.loader.exec_module(auth)
        scenes = list({(c['scene']['rawSha256'], c['scene']['jsonSha256']): c['scene'] for c in rows}.values())
        for offset in range(0, len(scenes), 32):
            emit({'phase': 'authenticating-native-serialization', 'offset': offset, 'resources': len(scenes[offset:offset + 32])})
            verified.update(auth.batchauthenticate(ROOT, OUT / 'native-authentication' / batch, scenes[offset:offset + 32]))
        emit({'phase': 'native-serialization-authenticated', 'resources': len(verified)})
        with cast.CpuSlots(ROOT, timeout=300):
            archives = tuple([cast.extract.Archive(game, p) for p in group if (game / p).is_file()]
                             for group in (cast.VOICE_ARCHIVES, cast.TEXT_ARCHIVES, cast.SCENE_ARCHIVES))
        oodle = cast.extract.Oodle(game / 'tools/redmod/bin/oo2ext_7_win64.dll')
        for i, candidate in enumerate(rows):
            if (OUT / 'STOP').exists():
                emit({'phase': 'stopped', 'remaining': len(rows) - i})
                raise InterruptedError('Owned stop requested; atomic originals preserved, no completed batch receipt published')
            token = {'key': candidate['key'], 'stringId': candidate['stringId'], 'genderVariant': candidate['genderVariant']}
            try:
                with cast.CpuSlots(ROOT, timeout=300):
                    item = cast.decode_candidate(candidate, roster, ROOT, output, archives, oodle, tools, receipt, verified, db_path)
                wav_path = ROOT / item['reference']
                with wave.open(str(wav_path), 'rb') as wav:
                    pcm_sha = hashlib.sha256(wav.readframes(wav.getnframes())).hexdigest()
                role = reservations.check(speaker_id=candidate['key'], localization_id=candidate['stringId'],
                    gender_variant=candidate['genderVariant'], delivery_scenes=candidate.get('scenePaths', [candidate['scene']['depotPath']]),
                    wem_depot=candidate['wemPath'], wem_sha256=item['provenance']['audio']['sha256'],
                    wav_sha256=item['sha256'], pcm_sha256=pcm_sha, text=candidate['english']['transcript'])
                row = {**token, 'receiptPath': str((wav_path.parent / 'receipt.json').relative_to(ROOT)),
                    'receiptSha256': sha(wav_path.parent / 'receipt.json'), 'wavSha256': item['sha256'],
                    'wemSha256': item['provenance']['audio']['sha256'], 'pcmSha256': pcm_sha,
                    'durationSeconds': item['provenance']['quality']['durationSeconds'], 'roleReservation': role,
                    'trainingAdmitted': False}
                completed.append(row)
                emit({'phase': 'collected', 'index': i + 1, 'total': len(rows), **row})
            except Exception as exc:
                row = {**token, 'errorType': type(exc).__name__, 'error': str(exc)}
                errors.append(row)
                emit({'phase': 'candidate-failed', **row})
    result = {'schema': 'authentic_cast_collection_batch_v1', 'batch': batch,
        'requestedCandidates': len(rows), 'allCandidatesAttempted': len(completed) + len(errors) == len(rows),
        'manifestSha256': sha(manifest_path), 'workerSha256': sha(Path(__file__)), 'tools': PINS, 'completed': completed,
        'errors': errors, 'elapsedSeconds': time.monotonic() - started, 'trainingAdmitted': False}
    path = OUT / 'receipts' / (batch + '.json')
    path.parent.mkdir(exist_ok=True)
    # Resume uses fresh batch labels with the same immutable per-line originals.
    with path.open('x', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
        f.write('\n')
    emit({'phase': 'complete', 'collected': len(completed), 'failed': len(errors), 'elapsedSeconds': result['elapsedSeconds']})

if __name__ == '__main__':
    main()
