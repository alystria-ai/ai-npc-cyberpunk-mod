"""Validate local voice profiles and plan a shared OmniVoice configuration.

Dry-run is the default. --write atomically writes the validated configuration;
source-qualified inventory mode always writes a separate activation artifact.
No extraction, model download, inference, training, game installation or cloud
call is performed.
"""
from pathlib import Path
from contextlib import closing
import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
import sqlite3
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TOOL_ROOT = ROOT
spec = importlib.util.spec_from_file_location('resident_voice_validation', ROOT / 'bridge/resident-voice-worker.py')
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)
casting_spec = importlib.util.spec_from_file_location('voice_cast_source_validation', TOOL_ROOT / 'scripts/Cast-VoiceReferenceCandidates.py')
casting = importlib.util.module_from_spec(casting_spec)
casting_spec.loader.exec_module(casting)
KEYS = validation.LEGACY_KEYS
REVISION = validation.MODEL_REVISION
MAX_MANIFEST_BYTES = 4 * 1024 * 1024


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key: ' + key)
        result[key] = value
    return result


def read_json(path):
    with path.open('rb') as handle:
        data = handle.read(MAX_MANIFEST_BYTES + 1)
    if len(data) > MAX_MANIFEST_BYTES:
        raise ValueError('Voice manifest exceeded its byte limit')
    return json.loads(data.decode('utf-8-sig'), object_pairs_hook=no_duplicate_keys)


def sha256_text(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def require_hash(value, bits=256, label='hash'):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{' + str(bits // 4) + '}', value):
        raise ValueError('Invalid ' + label)
    return value


def require_text(value, label):
    if not isinstance(value, str) or not value.strip() or len(value) > 12000 or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', value):
        raise ValueError('Missing/invalid ' + label)
    return value


def require_pointer(value, label):
    require_text(value, label)
    if not value.startswith('/Data/RootChunk/'):
        raise ValueError('Expected a native JSON pointer for ' + label)
    return value


def _validate_normalized_provenance(key, entry, *, require_review=True):
    """Verify the promotion receipt structure and transcript identity.

    Root approves only after checking the referenced native receipts. These
    booleans never infer canonical identity from a voice prefix or demographic.
    Candidate statuses remain remote until that explicit promotion is present.
    """
    if require_review and entry.get('approved') is not True:
        raise ValueError(key + ': ready profile requires explicit promotion approval')
    descriptor = entry.get('reference')
    if not isinstance(descriptor, dict) or not validation.valid_transcript(descriptor.get('transcript')):
        raise ValueError(key + ': missing reference/transcript')
    digest = require_hash(descriptor.get('transcriptSha256'), label='transcript SHA256')
    if sha256_text(descriptor['transcript']) != digest:
        raise ValueError(key + ': transcript did not match its provenance hash')
    provenance = entry.get('provenance')
    if not isinstance(provenance, dict):
        raise ValueError(key + ': missing source provenance')
    require_hash(provenance.get('rosterSha256'), label='roster SHA256')
    if provenance.get('gameVersion') != '2.31' or provenance.get('locale') != 'en_us':
        raise ValueError(key + ': unsupported game/source language provenance')
    groups = {}
    for name in ('nativeActor', 'nativeLine', 'subtitle', 'audio', 'quality'):
        group = provenance.get(name)
        if not isinstance(group, dict):
            raise ValueError(key + ': missing ' + name + ' provenance')
        groups[name] = group
    actor, line, subtitle, audio, quality = (groups[name] for name in ('nativeActor', 'nativeLine', 'subtitle', 'audio', 'quality'))
    if actor.get('canonicalKey') != key or actor.get('attributionVerified') is not True:
        raise ValueError(key + ': canonical native actor attribution was not verified')
    require_text(actor.get('canonicalIdentityProof'), 'canonical identity proof')
    require_text(actor.get('sceneDepotPath'), 'actor scene depot path')
    require_text(actor.get('sceneArchive'), 'actor scene archive')
    require_hash(actor.get('entrySha1'), bits=160, label='actor scene entry SHA1')
    require_hash(actor.get('binarySha256'), label='actor scene binary SHA256')
    require_hash(actor.get('jsonSha256'), label='actor scene JSON SHA256')
    require_pointer(actor.get('actorPointer'), 'actor pointer')
    actor_id = require_text(str(actor.get('actorId', '')), 'actor ID')
    require_text(actor.get('actorName'), 'actor name')
    require_text(str(actor.get('voicetagId', '')), 'actor voicetag ID')
    if str(line.get('speakerId', '')) != actor_id:
        raise ValueError(key + ': screenplay speaker did not match the native actor')
    line_id = require_text(line.get('locstringId'), 'line localization ID')
    if not line_id.isdecimal():
        raise ValueError(key + ': localization ID must preserve its decimal string identity')
    require_pointer(line.get('linePointer'), 'screenplay line pointer')
    require_pointer(line.get('eventPointer'), 'dialogue event pointer')
    require_text(line.get('expression'), 'dialogue expression')
    delivery = casting.source_delivery({'voParams': {
        'isHolocallSpeaker': line.get('isHolocallSpeaker'),
        'voExpression': line.get('expression'), 'customVoEvent': line.get('customVoEvent')}},
        provenance.get('sourceDelivery'))
    if subtitle.get('locstringId') != line_id or subtitle.get('locale') != 'en_us':
        raise ValueError(key + ': subtitle join did not match the native English line')
    if (subtitle.get('transcriptSource') != 'installed-en-us-subtitle'
            or subtitle.get('transcriptSha256') != digest or subtitle.get('transcriptAgreement') is not True):
        raise ValueError(key + ': exact installed transcript provenance was not verified')
    require_text(subtitle.get('depotPath'), 'subtitle depot path')
    require_text(subtitle.get('archive'), 'subtitle archive')
    require_hash(subtitle.get('entrySha1'), bits=160, label='subtitle entry SHA1')
    require_hash(subtitle.get('binarySha256'), label='subtitle binary SHA256')
    require_hash(subtitle.get('jsonSha256'), label='subtitle JSON SHA256')
    require_pointer(subtitle.get('entryPointer'), 'subtitle entry pointer')
    require_pointer(subtitle.get('variantPointer'), 'subtitle variant pointer')
    if subtitle.get('variant') not in ('femaleVariant', 'maleVariant'):
        raise ValueError(key + ': subtitle gender variant must be explicit')
    require_text(audio.get('archive'), 'audio archive')
    depot = require_text(audio.get('depotPath'), 'audio depot path')
    if not depot.endswith('.wem') or audio.get('sha1Verified') is not True:
        raise ValueError(key + ': original WEM provenance was not verified')
    require_hash(audio.get('archiveEntrySha1'), bits=160, label='WEM entry SHA1')
    require_hash(audio.get('payloadSha256'), label='WEM payload SHA256')
    if not isinstance(audio.get('pathHash'), str) or not audio['pathHash'].isdecimal():
        raise ValueError(key + ': WEM path hash must be an exact decimal string')
    if audio.get('genderVariant') not in ('f', 'm'):
        raise ValueError(key + ': source audio gender variant must be explicit')
    for flag in ('attributionVerified', 'transcriptAgreement', 'originalDecodedPcm',
                 *(('cleanIntelligible', 'listeningVerified') if require_review else ())):
        if quality.get(flag) is not True:
            raise ValueError(key + ': quality gate did not pass: ' + flag)
    if require_review and (quality.get('overlap') is not False or quality.get('clippedSamples') != 0):
        raise ValueError(key + ': overlapping/clipped source cannot be silently promoted')
    processing = quality.get('processingPolicy')
    if processing not in ('ordinary-spoken', 'canonical-processed', 'canonical-source-performance'):
        raise ValueError(key + ': source processing policy must be reviewed explicitly')
    if processing == 'ordinary-spoken' and delivery['kind'] != 'ordinary-spoken':
        raise ValueError(key + ': ordinary source is not a spoken dialogue event')
    if processing in ('canonical-processed', 'canonical-source-performance'):
        require_text(quality.get('processingReason'), 'canonical processed-voice decision')
    return {'reference': descriptor.get('reference'), 'sha256': descriptor.get('sha256'),
            'transcript': descriptor['transcript'], 'status': 'ready',
            'transcriptSha256': digest,
            'provenanceSha256': sha256_text(json.dumps(provenance, ensure_ascii=False, sort_keys=True, separators=(',', ':')))}


def validate_provenance(key, entry, *, require_review=True):
    """Validate the actual casting-wrapper receipt without modifying it."""
    provenance = entry.get('provenance')
    if not isinstance(provenance, dict):
        raise ValueError(key + ': missing source provenance')
    try:
        actor, line, subtitle, audio, quality = (provenance[name] for name in ('nativeActor', 'nativeLine', 'subtitle', 'audio', 'quality'))
        scene, proof, event = actor['scene'], actor['identityProof'], line['event']
        serialization = actor.get('serializationVerification')
        if (not isinstance(serialization, dict) or serialization.get('verified') is not True
                or serialization.get('rawSha256') != scene.get('rawSha256')
                or serialization.get('cachedJsonSha256') != scene.get('jsonSha256')):
            raise ValueError(key + ': raw scene to JSON serialization was not authenticated')
        require_hash(serialization.get('toolSha256'), label='native serializer SHA256')
        require_hash(serialization.get('dataSha256'), label='authenticated native Data SHA256')
        params = event['voParams']
        if (not isinstance(proof, dict) or proof.get('canonicalKey') != key
                or proof.get('kind') not in ('exact_actor', 'reviewed_actor_alias', 'quest_acquisition', 'direct_actor_record')):
            raise ValueError(key + ': canonical identity proof is missing')
        sources = subtitle['sources']
        if not isinstance(sources, list) or not sources:
            raise ValueError(key + ': exact installed subtitle sources are required')
        descriptor = entry['reference']
        if subtitle['transcript'] != descriptor['transcript'] or subtitle['transcriptSha256'] != descriptor['transcriptSha256']:
            raise ValueError(key + ': reference transcript differs from its native English payload')
        for source in sources:
            if source.get('sha1Verified') is not True:
                raise ValueError(key + ': unverified installed subtitle source')
            require_hash(source.get('archiveEntrySha1'), bits=160, label='subtitle source entry SHA1')
            require_hash(source.get('sha256'), label='subtitle source SHA256')
            require_pointer(source.get('indexPointer'), 'subtitle index entry pointer')
            require_pointer(source.get('variantPointer'), 'subtitle index variant pointer')
            require_text(source.get('depotPath'), 'subtitle source depot path')
            require_text(source.get('archive'), 'subtitle source archive')
            if source.get('variant') != subtitle['variant'] or source.get('variants', {}).get(subtitle['variant']) != descriptor['transcript']:
                raise ValueError(key + ': installed subtitle variant disagrees with the exact transcript')
        if quality.get('sha256') != descriptor['sha256'] or quality.get('nonSilent') is not True:
            raise ValueError(key + ': original decoded PCM quality receipt disagrees with the reference')
        delivery = casting.source_delivery(event, provenance.get('sourceDelivery'))
        if quality.get('processingPolicy') == 'ordinary-spoken':
            if delivery['kind'] != 'ordinary-spoken':
                raise ValueError(key + ': ordinary source has unresolved custom voice processing')
        if audio.get('processing') != 'Original vgmstream PCM decode only; no gain/EQ/denoise/resample/trim/concat':
            raise ValueError(key + ': original unprocessed PCM receipt is required')
        source = sources[0]
        normalized = {'rosterSha256': provenance['rosterSha256'], 'gameVersion': provenance['gameVersion'], 'locale': provenance['locale'],
          'nativeActor': {'canonicalKey': proof['canonicalKey'], 'attributionVerified': True,
             'canonicalIdentityProof': require_text(proof.get('reason'), 'reviewed identity reason'),
             'sceneDepotPath': scene['depotPath'], 'sceneArchive': scene['archive'], 'entrySha1': scene['entrySha1'],
             'binarySha256': scene['rawSha256'], 'jsonSha256': scene['jsonSha256'], 'actorPointer': actor['pointer'],
             'actorId': actor['id'], 'actorName': actor['name'], 'voicetagId': actor['voicetagId']},
          'nativeLine': {'speakerId': line['speakerId'], 'locstringId': line['locstringId'], 'linePointer': line['pointer'],
             'eventPointer': event['pointer'], 'expression': params['voExpression'],
             'isHolocallSpeaker': delivery['isHolocallSpeaker'], 'customVoEvent': delivery['customVoEvent']},
          'sourceDelivery': delivery,
          'subtitle': {'locstringId': line['locstringId'], 'locale': subtitle['locale'], 'transcriptSource': 'installed-en-us-subtitle',
             'transcriptSha256': subtitle['transcriptSha256'], 'transcriptAgreement': True, 'depotPath': source['depotPath'],
             'archive': source['archive'], 'entrySha1': source['archiveEntrySha1'], 'binarySha256': source['sha256'],
             'jsonSha256': require_hash(subtitle['indexSha256'], label='installed subtitle index SHA256'),
             'entryPointer': source['indexPointer'], 'variantPointer': source['variantPointer'], 'variant': subtitle['variant']},
          'audio': {'archive': audio['archive'], 'depotPath': audio['depotPath'], 'archiveEntrySha1': audio['archiveEntrySha1'],
             'payloadSha256': audio['sha256'], 'sha1Verified': audio['sha1Verified'], 'pathHash': audio['pathHash'],
             'genderVariant': {'female': 'f', 'male': 'm'}.get(audio['genderVariant'])},
          'quality': {**quality, 'attributionVerified': True, 'transcriptAgreement': True, 'originalDecodedPcm': True}}
        result = _validate_normalized_provenance(key, {**entry, 'provenance': normalized}, require_review=require_review)
        result['provenanceSha256'] = sha256_text(json.dumps(provenance, ensure_ascii=False, sort_keys=True, separators=(',', ':')))
        return result
    except (KeyError, TypeError) as error:
        raise ValueError(key + ': incomplete casting source receipt') from error


def verify_provenance_sources(root, key, entry, roster_inventory, *, index_hashes=None):
    """Recheck the source joins using the casting wrapper's offline verifier.

    This reads bounded local evidence only. It does not decode archives, invoke
    tools, infer canonical ownership from filenames, or access a live save.
    """
    roster = read_json(roster_inventory)
    provenance = entry['provenance']
    if roster.get('summary', {}).get('rosterSha256') != provenance['rosterSha256']:
        raise ValueError(key + ': canonical roster fingerprint changed')
    character = next((item for item in roster.get('characters', []) if item.get('key') == key), None)
    if character is None:
        raise ValueError(key + ': character is not in the canonical roster')
    current_path = root / 'characters/roster.json'
    if current_path.is_file():
        current = read_json(current_path)
        current = next((item for item in current if item.get('key') == key), None) if isinstance(current, list) else None
        if current is None or any(current.get(field, []) != character.get(field, []) for field in ('key', 'name', 'aliases', 'records')):
            raise ValueError(key + ': current canonical character identity changed')
    actor, line, subtitle, audio = (provenance[name] for name in ('nativeActor', 'nativeLine', 'subtitle', 'audio'))
    candidate = {'key': key, 'stringId': line['locstringId'], 'wemPath': audio['depotPath'], 'genderVariant': audio['genderVariant'],
                 'scene': actor['scene'], 'actor': {name: actor[name] for name in ('pointer', 'id', 'name', 'voicetagId', 'identityProof')},
                 'line': {name: line[name] for name in ('pointer', 'itemId', 'speakerId', 'locstringId')},
                 'event': {'pointer': line['event']['pointer']}, 'english': subtitle,
                 'sourceDelivery': provenance.get('sourceDelivery')}
    for value in [actor['scene'][name] for name in ('rawPath', 'jsonPath', 'manifestPath')]:
        evidence_file(root, value)
    if actor['identityProof'].get('kind') == 'quest_acquisition':
        evidence_file(root, actor['identityProof'].get('resourcePath'))
    checked = casting.validate_native(candidate, character, root)
    serialization = actor['serializationVerification']
    if serialization['toolSha256'] != casting.WOLVENKIT_SHA256:
        raise ValueError(key + ': native serialization did not use the pinned parser')
    scene_document = casting.read_json(casting.project_file(actor['scene']['jsonPath'], root))
    if sha256_text(json.dumps(scene_document['Data'], ensure_ascii=False, sort_keys=True, separators=(',', ':'))) != serialization['dataSha256']:
        raise ValueError(key + ': authenticated native Data fingerprint changed')
    if checked['event'].get('voParams') != line['event'].get('voParams'):
        raise ValueError(key + ': recorded dialogue processing differs from the actual native event')
    index = evidence_file(root, subtitle.get('indexPath', 'research/cyberpunk/cache/game/localization/index/lookup.sqlite3'),
                          max_bytes=512 * 1024 * 1024)
    if index_hashes is None:
        index_hashes = {}
    # One build shares this read-only index. Hash it once per build, never retain
    # that admission across another CLI invocation or registry activation.
    digest = index_hashes.get(str(index))
    if digest is None:
        digest = index_hashes[str(index)] = casting.digest(index)
    if digest != subtitle['indexSha256']:
        raise ValueError(key + ': installed subtitle index fingerprint changed')
    with closing(sqlite3.connect(index.as_uri() + '?mode=ro&immutable=1', uri=True)) as database:
        rows = casting.indexed_subtitles(database, line['locstringId'])
    expected_sources = {(source['archive'], casting.depot(source['depotPath'], '.json'), source['archiveEntrySha1'],
                         source['sha256'], source['indexPointer']) for source in subtitle['sources']}
    observed_sources = set()
    for row in rows:
        if row.get(subtitle['variant']) != entry['reference']['transcript']:
            raise ValueError(key + ': indexed installed subtitle transcript no longer agrees')
        source = row['source']
        observed_sources.add((source['archivePath'], casting.depot(source['depotPath'], '.json'),
                              source['archiveEntrySha1'], source['assetSha256'], row['jsonPointer']))
    if expected_sources != observed_sources:
        raise ValueError(key + ': exact installed subtitle source set changed')
    # Check the hashed original WEM, not just the descriptor of the promoted WAV.
    wem = evidence_file(root, audio.get('wemPath'))
    casting.checked_hash(wem, audio['sha256'], 'Source WEM SHA256')
    casting.checked_hash(wem, audio['archiveEntrySha1'], 'Source WEM entry SHA1', 'sha1')
    source_wav = evidence_file(root, audio.get('wavPath'))
    casting.checked_hash(source_wav, entry['reference']['sha256'], 'Original decoded WAV SHA256')


def evidence_file(root, value, *, max_bytes=64 * 1024 * 1024):
    if not isinstance(value, str):
        raise ValueError('A contained local source receipt is required')
    root = root.resolve()
    source = Path(value)
    source = source if source.is_absolute() else root / source
    try:
        relative = source.relative_to(root).as_posix()
    except ValueError as error:
        raise ValueError('Source evidence escaped the project') from error
    prefixes = ('research/cyberpunk/cache/game', 'runtime/voice-cast')
    prefix = next((allowed for allowed in prefixes if relative.startswith(allowed + '/')), None)
    if prefix is None:
        raise ValueError('Source evidence is outside the approved research/casting directories')
    source = validation.contained_file(root, relative, prefix)
    if not 0 < source.stat().st_size <= max_bytes:
        raise ValueError('Source evidence exceeded its byte limit')
    return source


def accepted_legacy(root, config):
    if not isinstance(config, dict) or not isinstance(config.get('voices'), dict):
        raise ValueError('Expected existing accepted local references')
    voices = {}
    for key in KEYS:
        descriptor = config['voices'].get(key)
        if not isinstance(descriptor, dict) or descriptor.get('status', 'ready') != 'ready':
            raise ValueError('Missing accepted legacy profile: ' + key)
        validation.validate_reference(root, descriptor)
        # Preserve every accepted descriptor field and the exact string bytes.
        # In particular no generic CP1252 repair is applied to new references.
        voices[key] = copy.deepcopy(descriptor)
    return voices


def build_config(root, legacy, manifest=None, *, verify_sources=True):
    voices = accepted_legacy(root, legacy)
    index_hashes = {}
    if manifest is not None:
        if not isinstance(manifest, dict) or manifest.get('version') != 2 or not isinstance(manifest.get('profiles'), list):
            raise ValueError('Expected casting manifest version2 with profiles[]')
        if len(manifest['profiles']) > validation.MAX_PROFILES:
            raise ValueError('Casting manifest exceeded profile limit')
        seen = set()
        for entry in manifest['profiles']:
            if not isinstance(entry, dict) or not validation.valid_key(entry.get('key')) or entry['key'] in seen:
                raise ValueError('Invalid/duplicate casting profile')
            key = entry['key']
            seen.add(key)
            status = entry.get('status')
            if status not in ('ready', 'unprepared', 'unavailable'):
                raise ValueError(key + ': invalid promotion status')
            if key in KEYS:
                if status != 'ready':
                    raise ValueError(key + ': casting cannot downgrade an accepted legacy voice')
                candidate = entry.get('reference')
                if candidate is not None and any(candidate.get(field) != voices[key].get(field) for field in ('reference', 'sha256', 'transcript')):
                    raise ValueError(key + ': casting cannot replace an accepted legacy recording')
                continue
            if status == 'ready':
                descriptor = validate_provenance(key, entry)
                if verify_sources:
                    inventory = manifest.get('rosterInventory', 'runtime/voice-cast-inventory-20261001/cast-roster-inventory.json')
                    verify_provenance_sources(root, key, entry, safe_runtime_path(root, Path(inventory)), index_hashes=index_hashes)
                validation.validate_reference(root, descriptor)
                voices[key] = descriptor
            else:
                voices[key] = {'status': status}
    if len(voices) > validation.MAX_PROFILES:
        raise ValueError('Merged registry exceeded profile limit')
    config = {'version': 2 if manifest is not None else legacy.get('version', 1),
              'provider': 'hybrid', 'engine': 'omnivoice', 'steps': 32,
              'model': legacy.get('model'), 'revision': REVISION, 'voices': voices}
    if manifest is not None:
        config['preparation'] = {'mode': 'lazy' if len(voices) > 3 else 'eager',
                                 'startupProfiles': list(KEYS), 'maxCachedProfiles': 8}
        config['castingManifestSha256'] = sha256_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')))
    ensure_available(config, root)
    return config


def source_qualified_plan(root, inventory):
    """Source attribution admission, independent of generated-voice listening."""
    spec = importlib.util.spec_from_file_location('voice_source_activation', TOOL_ROOT / 'scripts/Generate-VoiceCastAuditions.py')
    sources = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sources)
    plan = sources.plan_auditions(root, inventory, source_only=True)
    require_accepted_source_profiles(plan)
    return sources, plan


def require_accepted_source_profiles(plan):
    if any(not any(row['key'] == key and row.get('acceptedExisting') for row in plan['selected']) for key in KEYS):
        raise ValueError('Source-qualified activation must preserve all three accepted legacy descriptors')


def build_source_qualified_config(root, sources, plan):
    if (sources.digest(root / plan['inventory']) != plan['inventorySha256']
            or sources.digest(root / 'runtime/local-voices.json') != plan['productionConfigSha256']):
        raise ValueError('Source-qualified activation inputs changed after admission')
    require_accepted_source_profiles(plan)
    voices, selections = {}, []
    for row in plan['selected']:
        descriptor, copied = sources.copy_source_reference(root, row)
        if not row.get('acceptedExisting'):
            # Readiness means the source chain is qualified. It does not assert
            # anyone listened to the cloned output or accepted its similarity.
            descriptor.update(qualificationStatus='source-qualified', listeningVerified=False,
                              sourceReceipt=row['receipt'], sourceReceiptSha256=row['receiptSha256'])
            if row.get('sourceDelivery'):
                descriptor['sourceDelivery'] = copy.deepcopy(row['sourceDelivery'])
        voices[row['key']] = descriptor
        source_evidence = {}
        if not row.get('acceptedExisting'):
            source_evidence = {'sourceReceipt': row['receipt'], 'sourceReceiptSha256': row['receiptSha256']}
            if row.get('sourceDelivery'):
                source_evidence['sourceDelivery'] = copy.deepcopy(row['sourceDelivery'])
        selections.append({'key': row['key'], 'reference': descriptor['reference'], 'sha256': descriptor['sha256'],
                           'transcriptSha256': sha256_text(descriptor['transcript']), 'copiedOriginal': copied,
                           'acceptedExisting': bool(row.get('acceptedExisting')), 'qualificationStatus': 'source-qualified',
                           **source_evidence})
    for row in plan['unprepared']:
        voices[row['key']] = {'status': 'unprepared'}
    config = {'version': 2, 'provider': 'hybrid', 'engine': 'omnivoice', 'steps': 32,
              **plan['legacyModel'], 'preparation': {'mode': 'lazy', 'startupProfiles': list(KEYS), 'maxCachedProfiles': 8},
              'qualificationMode': 'source-qualified', 'sourceInventorySha256': plan['inventorySha256'], 'voices': voices}
    ensure_available(config, root)
    receipt = {'version': 1, 'kind': 'source-qualified-activation', 'qualificationMode': 'source-qualified',
               'configuredProfiles': len(voices), 'localProfiles': len(plan['selected']), 'remoteProfiles': len(plan['unprepared']),
               'listeningVerified': False, 'newListeningApprovals': 0, 'legacyReferencesUnchanged': True,
               'sourceInventory': plan['inventory'], 'sourceInventorySha256': plan['inventorySha256'],
               'productionConfigSha256BeforePreparation': plan['productionConfigSha256'],
               'selections': selections, 'unprepared': plan['unprepared']}
    return config, receipt


def write_source_qualified_activation(root, inventory, output=Path('runtime/voice-cast/activation/local-voices.source-qualified.json')):
    sources, plan = source_qualified_plan(root, inventory)
    target = sources.runtime_path(root, output, 'runtime/voice-cast/activation')
    safe_runtime_path(root, target, output=True)
    config, receipt = build_source_qualified_config(root, sources, plan)
    if (sources.digest(root / plan['inventory']) != plan['inventorySha256']
            or sources.digest(root / 'runtime/local-voices.json') != plan['productionConfigSha256']):
        raise ValueError('Source-qualified activation inputs changed during preparation')
    write_config(root, target, config)
    receipt['configPath'] = target.relative_to(root).as_posix()
    receipt['configSha256'] = sources.digest(target)
    receipt_path = target.with_name('activation-receipt.json')
    receipt_path = sources.runtime_path(root, receipt_path, 'runtime/voice-cast/activation')
    # The configuration is the activation artifact; this independent receipt
    # records source admission honestly and is never read as a user approval.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=receipt_path.parent,
                                         prefix='activation-receipt.', suffix='.tmp', delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(receipt, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        sources.runtime_path(root, receipt_path, 'runtime/voice-cast/activation')
        os.replace(temporary, receipt_path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    if sources.digest(root / 'runtime/local-voices.json') != plan['productionConfigSha256']:
        raise ValueError('Production configuration changed externally during source-qualified preparation')
    return config, receipt


def ensure_available(config, root):
    registry = validation.validate_config(config, root)
    expected = {key for key, descriptor in config['voices'].items() if descriptor.get('status', 'ready') == 'ready'}
    if set(registry['refs']) != expected:
        raise validation.ReferenceUnavailable('A ready reference became unavailable during preparation')
    return registry


def safe_runtime_path(root, candidate, *, output=False):
    root = root.resolve()
    path = candidate if candidate.is_absolute() else root / candidate
    try:
        relative = path.relative_to(root).as_posix()
    except ValueError as error:
        raise ValueError('Voice configuration paths must stay inside project runtime') from error
    if not relative.startswith('runtime/') or any(part in ('', '.', '..') for part in relative.split('/')):
        raise ValueError('Voice configuration paths must stay inside project runtime')
    if output and not re.fullmatch(r'local-voices(?:[.-][a-zA-Z0-9_-]+)*\.json', path.name):
        raise ValueError('Expected an explicit local-voices JSON output filename')
    current = root
    for part in path.relative_to(root).parts:
        current /= part
        attributes = getattr(current.lstat(), 'st_file_attributes', 0) if current.exists() else 0
        if current.is_symlink() or attributes & 0x400:
            raise ValueError('Linked configuration paths are not supported')
    if not path.resolve().is_relative_to(root / 'runtime'):
        raise ValueError('Voice configuration path escaped project runtime')
    return path


def write_config(root, output, config):
    ensure_available(config, root)
    target = safe_runtime_path(root, output, output=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=target.parent,
                                         prefix=target.name + '.', suffix='.tmp', delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(config, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        # Recheck the destination after creating the temporary file. A failed
        # receipt or linked destination never replaces the previous config.
        safe_runtime_path(root, output, output=True)
        os.replace(temporary, target)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--legacy-config', type=Path, default=Path('runtime/local-voices.json'))
    inputs = parser.add_mutually_exclusive_group()
    inputs.add_argument('--manifest', type=Path)
    inputs.add_argument('--source-qualified-inventory', type=Path,
                        help='Enable attributed original references without asserting cloned-output listening acceptance')
    parser.add_argument('--output', type=Path)
    activation = parser.add_mutually_exclusive_group()
    activation.add_argument('--write', action='store_true')
    activation.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    if args.source_qualified_inventory:
        if args.write:
            output = args.output or Path('runtime/voice-cast/activation/local-voices.source-qualified.json')
            config, receipt = write_source_qualified_activation(ROOT, args.source_qualified_inventory, output)
            print(json.dumps({'mode': 'written', 'version': 2, 'configuredProfiles': receipt['configuredProfiles'],
                              'availableProfiles': receipt['localProfiles'], 'remoteProfiles': receipt['remoteProfiles'],
                              'qualificationMode': 'source-qualified', 'newListeningApprovals': 0, 'steps': 32,
                              'legacyReferencesUnchanged': True}, ensure_ascii=False))
        else:
            _, plan = source_qualified_plan(ROOT, args.source_qualified_inventory)
            print(json.dumps({'mode': 'dry-run', 'version': 2, 'configuredProfiles': len(plan['selected']) + len(plan['unprepared']),
                              'availableProfiles': len(plan['selected']), 'remoteProfiles': len(plan['unprepared']),
                              'qualificationMode': 'source-qualified', 'newListeningApprovals': 0, 'steps': 32,
                              'legacyReferencesUnchanged': True}, ensure_ascii=False))
        return 0
    legacy = read_json(safe_runtime_path(ROOT, args.legacy_config))
    manifest = read_json(safe_runtime_path(ROOT, args.manifest)) if args.manifest else None
    config = build_config(ROOT, legacy, manifest)
    available = [key for key, descriptor in config['voices'].items() if descriptor.get('status', 'ready') == 'ready']
    if args.write:
        write_config(ROOT, args.output or Path('runtime/local-voices.json'), config)
    print(json.dumps({'mode': 'written' if args.write else 'dry-run', 'version': config['version'],
                      'configuredProfiles': len(config['voices']), 'availableProfiles': len(available),
                      'remoteProfiles': len(config['voices']) - len(available), 'steps': 32,
                      'preparation': config.get('preparation', {'mode': 'eager', 'startupProfiles': list(KEYS)}),
                      'legacyReferencesUnchanged': True}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError) as error:
        print('Voice preparation failed: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
