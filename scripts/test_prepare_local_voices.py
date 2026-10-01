"""Offline reference/preparation protocol checks. No CUDA imports or inference."""
from pathlib import Path
from contextlib import closing
import copy
import hashlib
import importlib.util
import io
import json
import os
import sqlite3
import tempfile
from collections import OrderedDict
from threading import Lock
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('resident_voice_worker', ROOT / 'bridge/resident-voice-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
prepare_spec = importlib.util.spec_from_file_location('prepare_local_voices', ROOT / 'scripts/Prepare-LocalVoices.py')
prepare = importlib.util.module_from_spec(prepare_spec)
prepare_spec.loader.exec_module(prepare)


class Fixtures(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='convai-voice-profile-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.model = ('vendor/voice-models/hub/models--k2-fsa--OmniVoice/snapshots/' + worker.MODEL_REVISION)
        model = self.root / self.model / 'model.safetensors'
        model.parent.mkdir(parents=True)
        model.write_bytes(b'test-model-identity-only')

    def reference(self, key, duration=1, channels=1):
        relative = f'runtime/voice-references/{key}.wav'
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), 'wb') as wav:
            wav.setnchannels(channels)
            wav.setsampwidth(2)
            wav.setframerate(8000)
            wav.writeframes(b'\x00\x01' * int(8000 * duration) * channels)
        return {'reference': relative, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'transcript': 'A real verified line, with % literal punctuation and Unicode café.'}

    def config(self, keys=None):
        keys = keys or worker.LEGACY_KEYS
        return {**({'version': 2} if set(keys) != set(worker.LEGACY_KEYS) else {}),
                'provider': 'hybrid', 'engine': 'omnivoice', 'steps': 32,
                'revision': worker.MODEL_REVISION, 'model': self.model,
                'voices': {key: self.reference(key) for key in keys}}

    def session(self, config, failing=None):
        frames, renders = [], []
        registry = worker.validate_config(config, self.root)
        def render(key, text, steps):
            renders.append((key, text, steps))
            if key == failing:
                raise RuntimeError('injected model failure')
            return b'only-test-audio', 12
        info = {'device': 'cuda:0', 'dtype': 'torch.float16', 'runtime': 'pytorch', 'tensorrt': False}
        session = worker.ProfileSession(registry, render, lambda _: 'TEST-ENCODED-WAV',
                                        frames.append, info, lambda: {'cudaReservedMiB': 2000})
        return session, frames, renders


class WorkerProfiles(Fixtures):
    def test_legacy_exact_descriptor_preserved_and_eager(self):
        config = self.config()
        registry = worker.validate_config(config, self.root)
        self.assertEqual(registry['mode'], 'eager')
        self.assertEqual(registry['startupProfiles'], sorted(worker.LEGACY_KEYS))
        for key in worker.LEGACY_KEYS:
            self.assertEqual(registry['descriptors'][key], config['voices'][key])
        session, frames, renders = self.session(config)
        session.startup()
        self.assertEqual([key for key, _, _ in renders], sorted(worker.LEGACY_KEYS))
        self.assertTrue(all(text == worker.WARM_PHRASE and steps == 32 for _, text, steps in renders))
        self.assertEqual(frames[-1]['protocolVersion'], 2)
        self.assertEqual(frames[-1]['referenceHashes'], {key: ref['sha256'] for key, ref in config['voices'].items()})

    def test_wider_registry_lazy_only_three_startup_and_remote_statuses(self):
        keys = [*worker.LEGACY_KEYS, '8ug8ear', *[f'cast-{i}' for i in range(72)]]
        config = self.config(keys)
        config.update(version=2)
        config['voices']['resident-male'] = {'status': 'unavailable'}
        config['voices']['alex'] = {'status': 'unprepared'}
        session, frames, renders = self.session(config)
        session.startup()
        self.assertEqual(session.registry['mode'], 'lazy')
        self.assertEqual(len(renders), 3)
        self.assertIn('8ug8ear', frames[-1]['profiles'])
        self.assertNotIn('alex', frames[-1]['profiles'])
        self.assertEqual(frames[-1]['unavailableProfiles']['alex'], 'unprepared')
        session.handle({'op': 'prepare', 'id': 1, 'profile': '8ug8ear'})
        self.assertEqual(renders[-1], ('8ug8ear', worker.WARM_PHRASE, 32))
        self.assertEqual(frames[-1]['op'], 'prepared')
        self.assertIn('8ug8ear', frames[-1]['preparedProfiles'])
        count = len(renders)
        session.handle({'op': 'prepare', 'id': 2, 'profile': '8ug8ear'})
        self.assertEqual(len(renders), count)
        session.handle({'op': 'synthesize', 'id': 3, 'profile': 'alex', 'steps': 32, 'text': 'Hello'})
        self.assertEqual(frames[-1]['op'], 'error')
        self.assertEqual(len(renders), count)

    def test_bounded_preparation_eviction_and_selected_render_never_borrow(self):
        config = self.config([f'cast-{i}' for i in range(12)])
        config['preparation'] = {'mode': 'lazy', 'startupProfiles': [], 'maxCachedProfiles': 3}
        session, frames, renders = self.session(config)
        session.startup()
        self.assertEqual(len(renders), 0)
        for index in range(12):
            session.handle({'op': 'prepare', 'id': index + 1, 'profile': f'cast-{index}'})
            self.assertLessEqual(len(frames[-1]['preparedProfiles']), 3)
            self.assertEqual(frames[-1]['preparedProfiles'][-1], f'cast-{index}')
        self.assertEqual(frames[-1]['preparedProfiles'], ['cast-9', 'cast-10', 'cast-11'])
        session.handle({'op': 'prepare', 'id': 20, 'profile': 'cast-0'})
        self.assertEqual(renders[-1][0], 'cast-0')
        session.handle({'op': 'synthesize', 'id': 21, 'profile': 'cast-11', 'steps': 16, 'text': 'Own voice.'})
        self.assertEqual(renders[-1], ('cast-11', 'Own voice.', 16))
        self.assertEqual(frames[-1]['op'], 'audio')
        self.assertEqual(frames[-1]['profile'], 'cast-11')
        self.assertEqual(frames[-1]['preparedProfiles'][-1], 'cast-11')

    def test_failed_lazy_preparation_not_ready_and_other_profiles_survive(self):
        config = self.config([*worker.LEGACY_KEYS, 'alex'])
        session, frames, renders = self.session(config, failing='alex')
        session.startup()
        session.handle({'op': 'prepare', 'id': 1, 'profile': 'alex'})
        self.assertEqual(frames[-1]['op'], 'error')
        self.assertNotIn('alex', frames[-1]['preparedProfiles'])
        self.assertEqual(renders[-1][0], 'alex')
        session.handle({'op': 'synthesize', 'id': 2, 'profile': 'judy-alvarez', 'text': 'Still Judy.', 'steps': 32})
        self.assertEqual(frames[-1]['op'], 'audio')
        self.assertEqual(frames[-1]['profile'], 'judy-alvarez')
        count = len(renders)
        self.assertFalse(session.handle({'op': 'shutdown'}))
        self.assertEqual(len(renders), count)

    def test_changed_reference_fails_even_when_preparation_was_cached(self):
        config = self.config()
        session, frames, renders = self.session(config)
        session.startup()
        path = self.root / config['voices']['judy-alvarez']['reference']
        original_time = path.stat().st_mtime_ns
        path.write_bytes(path.read_bytes()[:-2] + b'\x11\x22')
        os.utime(path, ns=(original_time, original_time))
        count = len(renders)
        for op in ('prepare', 'synthesize'):
            session.handle({'op': op, 'id': 1, 'profile': 'judy-alvarez', 'text': 'Changed?', 'steps': 32})
            self.assertEqual(frames[-1]['op'], 'error')
            self.assertNotIn('judy-alvarez', frames[-1]['preparedProfiles'])
            self.assertEqual(len(renders), count)

    def test_reference_duration_mono_stereo_and_transcript_boundaries(self):
        for channels in (1, 2):
            ref = self.reference('voice', duration=20, channels=channels)
            self.assertEqual(worker.validate_reference(self.root, ref)[1], ref['transcript'])
        for duration in (0, 20.1):
            with self.assertRaises(ValueError):
                worker.validate_reference(self.root, self.reference('voice', duration=duration))
        ref = self.reference('voice')
        for transcript in ('', '  ', 'hello\0V', 'x' * 12_001, None):
            with self.subTest(transcript=repr(transcript)[:20]), self.assertRaises(ValueError):
                worker.validate_reference(self.root, {**ref, 'transcript': transcript})

    def test_unsafe_paths_wrong_hashes_and_invalid_policies_are_rejected(self):
        config = self.config()
        key = 'judy-alvarez'
        for relative in ('../outside.wav', 'runtime/voice-references/../outside.wav',
                         'runtime/voice-references/x:y.wav', 'runtime\\voice-references\\x.wav',
                         'runtime/voice-references//x.wav', 'runtime/voice-references/./x.wav'):
            changed = copy.deepcopy(config)
            changed['voices'][key]['reference'] = relative
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                worker.validate_config(changed, self.root)
        for sha in ('A' * 64, None):
            changed = copy.deepcopy(config)
            changed['voices'][key]['sha256'] = sha
            with self.assertRaises(ValueError):
                worker.validate_config(changed, self.root)
        changed = copy.deepcopy(config)
        changed['voices'][key]['sha256'] = 'a' * 64
        registry = worker.validate_config(changed, self.root)
        self.assertNotIn(key, registry['refs'])
        self.assertEqual(registry['unavailableProfiles'][key], 'unavailable')
        self.assertNotIn(key, registry['startupProfiles'])
        for policy in ({'mode': 'eager', 'startupProfiles': [key]}, {'mode': 'lazy', 'maxCachedProfiles': 9},
                       {'mode': 'lazy', 'startupProfiles': [key, key]}, {'mode': 'lazy', 'startupProfiles': ['missing']}):
            with self.assertRaises(ValueError):
                worker.validate_config({**config, 'preparation': policy}, self.root)
        with self.assertRaises(ValueError):
            worker.validate_config({**config, 'revision': 'wrong'}, self.root)
        with self.assertRaises(ValueError):
            worker.validate_config({**config, 'voices': {f'voice-{i}': {'status': 'unprepared'} for i in range(129)}}, self.root)

    def test_worker_config_json_bound_and_duplicate_keys(self):
        config_path = self.root / 'runtime/config.json'
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text('{"version":2,"version":1}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            worker.read_config(config_path)
        with config_path.open('wb') as handle:
            handle.truncate(worker.MAX_CONFIG_BYTES + 1)
        with self.assertRaisesRegex(ValueError, 'byte limit'):
            worker.read_config(config_path)

    def test_linked_reference_components_are_rejected(self):
        config = self.config()
        key = 'judy-alvarez'
        linked_path = self.root / config['voices'][key]['reference']
        original = Path.is_symlink
        with patch.object(Path, 'is_symlink', lambda path: path == linked_path or original(path)):
            with self.assertRaisesRegex(ValueError, 'Linked'):
                worker.validate_config(config, self.root)

    def test_truncated_pcm_and_oversized_files_do_not_become_available(self):
        config = self.config()
        key = 'judy-alvarez'
        path = self.root / config['voices'][key]['reference']
        path.write_bytes(path.read_bytes()[:44])
        config['voices'][key]['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        registry = worker.validate_config(config, self.root)
        self.assertNotIn(key, registry['refs'])
        with path.open('ab') as handle:
            handle.truncate(worker.MAX_REFERENCE_BYTES + 1)
        with self.assertRaisesRegex(worker.ReferenceUnavailable, 'byte limits'):
            worker.validate_reference(self.root, config['voices'][key])

    def test_v2_cache_identity_keeps_source_processing_and_distinguishes_hash_transcript(self):
        config = self.config([*worker.LEGACY_KEYS, 'alex'])
        registry = worker.validate_config(config, self.root)
        original = lambda path, text, preprocess=True, *, passage=None: (path, 1234, text, preprocess, passage)
        adapter = SimpleNamespace(_clone_prompt_key=original)
        worker.install_cache_identity(adapter, registry)
        path, text = registry['refs']['alex']
        actual = adapter._clone_prompt_key(path, text, False)
        self.assertEqual(actual[:5], original(path, text, False))
        self.assertIn(config['voices']['alex']['sha256'], actual)
        self.assertIn(hashlib.sha256(text.encode()).hexdigest(), actual)
        self.assertIn(worker.MODEL_REVISION, actual)
        self.assertIn(worker.ADAPTER_REVISION, actual)
        with self.assertRaisesRegex(ValueError, 'Unregistered'):
            adapter._clone_prompt_key(path, 'Changed transcript')
        legacy = worker.validate_config(self.config(), self.root)
        adapter = SimpleNamespace(_clone_prompt_key=original)
        worker.install_cache_identity(adapter, legacy)
        self.assertIs(adapter._clone_prompt_key, original)

    def test_bad_commands_cannot_render_and_failed_encode_cannot_be_ready(self):
        session, frames, renders = self.session(self.config())
        session.startup()
        count = len(renders)
        for request in ({'op': 'prepare', 'id': True, 'profile': 'judy-alvarez'},
                        {'op': 'prepare', 'id': 1, 'profile': []},
                        {'op': 'synthesize', 'id': 2, 'profile': 'judy-alvarez', 'text': 'Hi', 'steps': 32.0},
                        {'op': 'synthesize', 'id': 3, 'profile': 'judy-alvarez', 'text': ' ', 'steps': 32}):
            session.handle(request)
            self.assertEqual(frames[-1]['op'], 'error')
            self.assertEqual(len(renders), count)
        session.encode = lambda _: (_ for _ in ()).throw(ValueError('bad encoded output'))
        session.handle({'op': 'synthesize', 'id': 4, 'profile': 'judy-alvarez', 'text': 'Hi', 'steps': 32})
        self.assertEqual(frames[-1]['op'], 'error')
        self.assertNotIn('judy-alvarez', frames[-1]['preparedProfiles'])

    def test_actual_adapter_cache_clear_and_inline_fallback_cannot_claim_prepared(self):
        config = self.config([*worker.LEGACY_KEYS, 'alex'])
        config['preparation'] = {'mode': 'lazy', 'startupProfiles': [], 'maxCachedProfiles': 2}
        registry = worker.validate_config(config, self.root)
        adapter = SimpleNamespace(_prompt_cache=OrderedDict(), _prompt_cache_lock=Lock())
        frames = []
        def render(key, text, steps):
            path, transcript = registry['refs'][key]
            if key == 'alex':
                # The pinned adapter can clear side caches after OOM or render
                # inline when conditioning-cache creation fails.
                adapter._prompt_cache.clear()
                return b'audio without cached conditioning', 12
            adapter._prompt_cache[(path, 1234, transcript, True, 'cyberpunk-voice-profile-v2', worker.MODEL_REVISION,
                                 worker.ADAPTER_REVISION, registry['referenceHashes'][key], registry['transcriptHashes'][key])] = object()
            while len(adapter._prompt_cache) > 2:
                adapter._prompt_cache.popitem(last=False)
            return b'valid test audio', 12
        session = worker.ProfileSession(registry, render, lambda _: 'AUDIO', frames.append, {}, lambda: {},
                         prepared_snapshot=lambda: worker.cached_profiles(adapter, registry))
        session.startup()
        for index, key in enumerate(worker.LEGACY_KEYS):
            session.handle({'op': 'prepare', 'id': index + 1, 'profile': key})
        self.assertEqual(frames[-1]['preparedProfiles'], ['judy-alvarez', 'panam-palmer'])
        session.handle({'op': 'prepare', 'id': 5, 'profile': 'alex'})
        self.assertEqual(frames[-1]['op'], 'error')
        self.assertEqual(frames[-1]['preparedProfiles'], [])


class PreparationConfig(Fixtures):
    def write_json(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')
        return path

    def promoted(self, key='alex'):
        """A real, minimal native actor/line/English-receipt chain on disk."""
        ref = self.reference(key)
        ref['transcriptSha256'] = prepare.sha256_text(ref['transcript'])
        scene_dir = 'research/cyberpunk/cache/game/profile-test'
        raw = self.root / scene_dir / 'fixture.scene'
        raw.parent.mkdir(parents=True, exist_ok=True)
        raw.write_bytes(b'fake native binary with independently checked hashes')
        rawsha, entrysha = hashlib.sha256(raw.read_bytes()).hexdigest(), hashlib.sha1(raw.read_bytes()).hexdigest()
        scene_archive = 'archive/pc/content/basegame_4_gamedata.archive'
        params = {'voExpression': 'Vo_Expression_Spoken', 'isHolocallSpeaker': 0, 'customVoEvent': {'$type': 'CName', '$value': 'None'}}
        document = {'Header': {'ArchiveFileName': str(raw)}, 'Data': {'RootChunk': {
          'actors': [{'$type': 'scnActorDef', 'actorId': {'id': '1'}, 'actorName': 'Alex', 'voicetagId': {'id': '3'}}],
          'screenplayStore': {'lines': [{'$type': 'scnscreenplayDialogLine', 'itemId': {'id': '2'}, 'speaker': {'id': '1'}, 'locstringId': {'ruid': '256'}}]},
          'events': [{'$type': 'scnDialogLineEvent', 'screenplayLineId': {'id': '2'}, 'voParams': params}],
          'locStore': {'vdEntries': [{'localeId': 'en_us', 'vpeIndex': 0, 'variantId': {'ruid': '7'}, 'locstringId': {'ruid': '256'}}],
                       'vpEntries': [{'variantId': {'ruid': '7'}, 'content': ref['transcript']}]}}}}
        json_path = self.write_json(scene_dir + '/fixture.scene.json', document)
        jsonsha = hashlib.sha256(json_path.read_bytes()).hexdigest()
        manifest_path = self.write_json(scene_dir + '/manifest.json', {'assets': [{'winner': True, 'depotPath': 'base/quest/test.scene',
                   'archivePath': scene_archive, 'archiveEntrySha1': entrysha, 'assetSha256': rawsha,
                   'rawPath': 'fixture.scene', 'jsonPath': 'fixture.scene.json'}]})
        scene = {'manifestPath': str(manifest_path.relative_to(self.root)), 'depotPath': 'base/quest/test.scene', 'archive': scene_archive,
                  'entrySha1': entrysha, 'rawPath': str(raw.relative_to(self.root)), 'rawSha256': rawsha,
                  'jsonPath': str(json_path.relative_to(self.root)), 'jsonSha256': jsonsha}
        source = self.root / f'runtime/voice-cast/test/{key}/source.wem'
        source.parent.mkdir(parents=True)
        source.write_bytes(b'bounded source WEM receipt fixture')
        source_wav = source.with_suffix('.wav')
        source_wav.write_bytes((self.root / ref['reference']).read_bytes())
        roster_hash = 'e' * 64
        self.write_json('runtime/voice-cast-inventory-20261001/cast-roster-inventory.json', {
          'summary': {'rosterSha256': roster_hash}, 'characters': [{'key': key, 'name': 'Alex', 'aliases': [], 'records': ['Character.Alex']}]})
        source_subtitle = {'archive': 'archive/pc/content/lang_en_text.archive', 'depotPath': 'base/localization/en-us/subtitles/test.json',
             'archiveEntrySha1': 'b' * 40, 'sha256': 'c' * 64, 'sha1Verified': True,
             'indexPointer': '/Data/RootChunk/root/Data/entries/0', 'variantPointer': '/Data/RootChunk/root/Data/entries/0/femaleVariant',
             'variant': 'femaleVariant', 'variants': {'femaleVariant': ref['transcript']}}
        provenance = {'rosterSha256': roster_hash, 'gameVersion': '2.31', 'locale': 'en_us',
          'nativeActor': {'scene': scene, 'pointer': '/Data/RootChunk/actors/0', 'id': '1', 'name': 'Alex', 'voicetagId': '3',
             'identityProof': {'kind': 'exact_actor', 'canonicalKey': key, 'reason': 'Exact canonical actor and native speaker join.'}},
          'nativeLine': {'pointer': '/Data/RootChunk/screenplayStore/lines/0', 'itemId': '2', 'speakerId': '1', 'locstringId': '256',
             'event': {'pointer': '/Data/RootChunk/events/0', 'voParams': params}},
          'subtitle': {'descriptorPointer': '/Data/RootChunk/locStore/vdEntries/0', 'payloadPointer': '/Data/RootChunk/locStore/vpEntries/0',
             'locale': 'en_us', 'variant': 'femaleVariant', 'transcript': ref['transcript'], 'transcriptSha256': ref['transcriptSha256'],
             'vpeIndex': 0, 'variantId': '7', 'indexSha256': 'd' * 64, 'sources': [source_subtitle]},
          'audio': {'archive': 'archive/pc/content/lang_en_voice.archive', 'depotPath': 'base/localization/en-us/vo/alex_f_0000000000000100.wem',
             'pathHash': '256', 'archiveEntrySha1': hashlib.sha1(source.read_bytes()).hexdigest(),
             'sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'sha1Verified': True, 'genderVariant': 'female',
             'wemPath': str(source.relative_to(self.root)), 'wavPath': str(source_wav.relative_to(self.root)),
             'processing': 'Original vgmstream PCM decode only; no gain/EQ/denoise/resample/trim/concat'},
          'quality': {'sha256': ref['sha256'], 'nonSilent': True, 'clippedSamples': 0, 'listeningVerified': True,
                      'cleanIntelligible': True, 'overlap': False, 'processingPolicy': 'ordinary-spoken'}}
        casting_spec = importlib.util.spec_from_file_location('casting_fixture_schema', ROOT / 'scripts/Cast-VoiceReferenceCandidates.py')
        casting = importlib.util.module_from_spec(casting_spec)
        casting_spec.loader.exec_module(casting)
        provenance['nativeActor']['serializationVerification'] = {'verified': True, 'tool': 'WolvenKit.CLI 9.0.1',
               'toolSha256': casting.WOLVENKIT_SHA256, 'rawSha256': rawsha, 'cachedJsonSha256': jsonsha,
               'dataSha256': prepare.sha256_text(json.dumps(document['Data'], ensure_ascii=False, sort_keys=True, separators=(',', ':')))}
        index = self.root / 'research/cyberpunk/cache/game/localization/index/lookup.sqlite3'
        index.parent.mkdir(parents=True, exist_ok=True)
        row = {'domain': 'subtitle.stringId', 'id': '256', 'femaleVariant': ref['transcript'],
          'jsonPointer': source_subtitle['indexPointer'], 'source': {'archivePath': source_subtitle['archive'],
          'depotPath': source_subtitle['depotPath'], 'archiveEntrySha1': source_subtitle['archiveEntrySha1'], 'assetSha256': source_subtitle['sha256']}}
        with closing(sqlite3.connect(index)) as db:
            with db:
                db.execute('CREATE TABLE entries(domain TEXT, entry_id TEXT, source_json TEXT)')
                db.execute('INSERT INTO entries VALUES(?,?,?)', ('subtitle.stringId', '256', json.dumps(row)))
        provenance['subtitle']['indexSha256'] = hashlib.sha256(index.read_bytes()).hexdigest()
        provenance['subtitle']['indexPath'] = str(index.relative_to(self.root))
        return {'key': key, 'status': 'ready', 'approved': True, 'reference': ref, 'provenance': provenance}

    def test_legacy_config_remains_exact_and32steps(self):
        legacy = self.config()
        result = prepare.build_config(self.root, legacy)
        self.assertEqual(result['voices'], legacy['voices'])
        self.assertEqual(result['steps'], 32)
        self.assertEqual(result['version'], 1)

    def test_manifest_merges_new_ready_and_remote_profiles_without_legacy_changes(self):
        legacy = self.config()
        promoted = self.promoted()
        result = prepare.build_config(self.root, legacy, {'version': 2, 'profiles': [promoted,
                                      {'key': '8ug8ear', 'status': 'unprepared', 'approved': False},
                                      {'key': 'resident-male', 'status': 'unavailable', 'approved': False}]})
        self.assertEqual(result['version'], 2)
        self.assertEqual(result['preparation']['mode'], 'lazy')
        self.assertEqual(result['voices']['alex']['transcript'], promoted['reference']['transcript'])
        self.assertEqual(result['voices']['8ug8ear'], {'status': 'unprepared'})
        self.assertEqual(result['voices']['resident-male'], {'status': 'unavailable'})
        for key in worker.LEGACY_KEYS:
            self.assertEqual(result['voices'][key], legacy['voices'][key])

    def test_native_speaker_and_english_payload_are_rechecked_not_trusted_flags(self):
        legacy = self.config()
        promoted = self.promoted()
        promoted['provenance']['nativeLine']['speakerId'] = '999'
        with self.assertRaisesRegex(ValueError, 'speaker'):
            prepare.build_config(self.root, legacy, {'version': 2, 'profiles': [promoted]})
        promoted['provenance']['nativeLine']['speakerId'] = '1'
        promoted['provenance']['subtitle']['payloadPointer'] = '/Data/RootChunk/locStore/vdEntries/0'
        with self.assertRaisesRegex(ValueError, 'variant join'):
            prepare.build_config(self.root, legacy, {'version': 2, 'profiles': [promoted]})

    def test_bad_transcript_and_quality_provenance_cannot_promote(self):
        original = self.promoted()
        changes = [('approved', False), ('reference.transcriptSha256', 'a' * 64),
                   ('provenance.nativeActor.identityProof.canonicalKey', 'wrong'),
                   ('provenance.subtitle.sources.0.variants.femaleVariant', 'Different installed line'),
                   ('provenance.quality.listeningVerified', False),
                   ('provenance.quality.cleanIntelligible', False), ('provenance.quality.overlap', True),
                   ('provenance.nativeLine.event.voParams.isHolocallSpeaker', 1)]
        for dotted, value in changes:
            changed = copy.deepcopy(original)
            target = changed
            parts = dotted.split('.')
            for part in parts[:-1]:
                target = target[int(part)] if isinstance(target, list) else target[part]
            target[parts[-1]] = value
            with self.subTest(field=dotted), self.assertRaises(ValueError):
                prepare.validate_provenance('alex', changed)

    def test_stale_source_hash_and_changed_processing_cannot_promote(self):
        legacy, promoted = self.config(), self.promoted()
        source = self.root / promoted['provenance']['audio']['wemPath']
        source.write_bytes(b'Changed original source audio')
        with self.assertRaisesRegex(ValueError, 'WEM'):
            prepare.build_config(self.root, legacy, {'version': 2, 'profiles': [promoted]})

    def test_duplicate_manifest_keys_and_legacy_replacement_rejected(self):
        legacy = self.config()
        for entries in ([{'key': '8ug8ear', 'status': 'unprepared'}] * 2,
                        [{'key': 'judy-alvarez', 'status': 'unavailable'}],
                        [{'key': 'judy-alvarez', 'status': 'ready', 'reference': {**legacy['voices']['judy-alvarez'], 'transcript': 'Changed'}}]):
            with self.assertRaises(ValueError):
                prepare.build_config(self.root, legacy, {'version': 2, 'profiles': entries})
        path = self.root / 'runtime/duplicate.json'
        path.write_text('{"version":2,"version":1}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            prepare.read_json(path)

    def test_cli_dryrun_no_writes_then_explicit_atomic_write(self):
        legacy = self.config()
        config_file = self.write_json('runtime/local-voices.json', legacy)
        manifest_file = self.write_json('runtime/voice-cast/prepared-voices.json', {'version': 2, 'profiles': [{'key': '8ug8ear', 'status': 'unprepared'}]})
        before = config_file.read_bytes()
        with patch.object(prepare, 'ROOT', self.root), patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(prepare.main(['--manifest', str(manifest_file)]), 0)
            self.assertEqual(json.loads(output.getvalue())['mode'], 'dry-run')
            self.assertEqual(config_file.read_bytes(), before)
        with patch.object(prepare, 'ROOT', self.root), patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(prepare.main(['--manifest', str(manifest_file), '--write']), 0)
        written = json.loads(config_file.read_text(encoding='utf-8'))
        self.assertEqual(written['version'], 2)
        self.assertEqual(written['voices']['8ug8ear']['status'], 'unprepared')
        for key in worker.LEGACY_KEYS:
            self.assertEqual(written['voices'][key], legacy['voices'][key])
        self.assertEqual(list(config_file.parent.glob('local-voices.json.*.tmp')), [])

    def test_failed_write_preserves_config_and_rejects_unavailable_or_unsafe_target(self):
        config = self.config()
        path = self.write_json('runtime/local-voices.json', config)
        before = path.read_bytes()
        reference = self.root / config['voices']['judy-alvarez']['reference']
        reference.unlink()
        with self.assertRaises(ValueError):
            prepare.write_config(self.root, Path('runtime/local-voices.json'), config)
        self.assertEqual(path.read_bytes(), before)
        for output in (Path('../local-voices.json'), Path('runtime/local-voices/../local-voices.json'), Path('runtime/player-memory.json')):
            with self.assertRaises(ValueError):
                prepare.safe_runtime_path(self.root, output, output=True)


if __name__ == '__main__':
    unittest.main()
