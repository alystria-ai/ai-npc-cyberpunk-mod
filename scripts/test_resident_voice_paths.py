"""Portable path checks use tiny WAV/weight fixtures and never import CUDA."""
from pathlib import Path
import copy
import hashlib
import importlib.util
import json
import math
import os
import shutil
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

SOURCE = Path(__file__).resolve().parents[1] / 'bridge/resident-voice-worker.py'
spec = importlib.util.spec_from_file_location('resident_voice_paths', SOURCE)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class PortableVoicePaths(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='convai-portable-voice-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.app = self.root / 'relocated 模组 application'
        self.data = self.root / 'persistent user data'
        self.app.mkdir()
        self.paths = {
            'modelDirectory': self.app / 'models/omnivoice',
            'adapterDirectory': self.app / 'voice/voicestudio/backend',
            'referenceDirectory': self.data / 'voice-references',
            'cacheDirectory': self.data / 'voice-studio-data',
        }
        for path in self.paths.values():
            path.mkdir(parents=True, exist_ok=True)
        (self.paths['modelDirectory'] / 'model.safetensors').write_bytes(b'fixture-weights-not-loadable')
        adapter = self.paths['adapterDirectory'] / 'services/tts_backend.py'
        adapter.parent.mkdir()
        adapter.write_text('# fixture adapter, never imported\n', encoding='utf-8')
        reference = self.paths['referenceDirectory'] / 'johnny.wav'
        with wave.open(str(reference), 'wb') as output:
            output.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
            output.writeframes(b'\x00\x01' * 8000)
        self.config = {'version': 2, 'provider': 'hybrid', 'engine': 'omnivoice', 'steps': 32,
                       'revision': worker.MODEL_REVISION,
                       'model': 'vendor/voice-models/hub/models--k2-fsa--OmniVoice/snapshots/' + worker.MODEL_REVISION,
                       'voices': {'johnny-silverhand': {'reference': 'runtime/voice-references/johnny.wav',
                                  'sha256': hashlib.sha256(reference.read_bytes()).hexdigest(),
                                  'transcript': 'A verified line, café and V.'}}}

    def environment(self):
        return {worker.PATH_OVERRIDES[field]: str(path) for field, path in self.paths.items()}

    def registry(self):
        paths = worker.resolve_worker_paths(self.app, self.environment())
        return worker.validate_config(self.config, self.app, paths=paths)

    def test_development_defaults_keep_existing_model_and_shared_cache_paths(self):
        paths = worker.resolve_worker_paths(self.app, {})
        self.assertFalse(paths['portable'])
        self.assertIsNone(paths['modelDirectory'])
        self.assertIsNone(paths['referenceDirectory'])
        self.assertEqual(paths['adapterDirectory'], self.app / 'vendor/reference-voicestudio/backend')
        self.assertEqual(paths['cacheDirectory'], self.app / 'runtime/voice-studio-data')
        self.assertEqual(paths['hfDirectory'], self.app / 'vendor/voice-models')

    def test_packaged_paths_use_data_references_and_immutable_snapshot_without_config_rewrites(self):
        # This decoy has the old path but does not match the configured recording.
        decoy = self.app / self.config['voices']['johnny-silverhand']['reference']
        decoy.parent.mkdir(parents=True)
        decoy.write_bytes(b'wrong app recording')
        original = copy.deepcopy(self.config)
        registry = self.registry()
        self.assertEqual(self.config, original)
        self.assertEqual(registry['model'], self.paths['modelDirectory'])
        self.assertEqual(registry['refs']['johnny-silverhand'][0], str(self.paths['referenceDirectory'] / 'johnny.wav'))
        self.assertEqual(registry['paths']['hfDirectory'], self.paths['cacheDirectory'] / 'huggingface')
        self.assertEqual(registry['referenceHashes']['johnny-silverhand'], self.config['voices']['johnny-silverhand']['sha256'])
        self.assertEqual(registry['transcriptHashes']['johnny-silverhand'],
                         hashlib.sha256(original['voices']['johnny-silverhand']['transcript'].encode()).hexdigest())
        environment = worker.voice_environment(registry)
        self.assertEqual(environment['OMNIVOICE_MODEL'], str(self.paths['modelDirectory']))
        self.assertEqual(environment['OMNIVOICE_DATA_DIR'],
                         str(self.paths['cacheDirectory'] / f'{worker.MODEL_REVISION[:12]}-{worker.ADAPTER_REVISION[:12]}'))
        for name in ('HF_HOME', 'HF_HUB_CACHE', 'HUGGINGFACE_HUB_CACHE', 'TRANSFORMERS_CACHE', 'HF_ASSETS_CACHE', 'TORCH_HOME'):
            self.assertTrue(Path(environment[name]).is_relative_to(self.paths['cacheDirectory']))
        self.assertEqual(environment['PYTHONDONTWRITEBYTECODE'], '1')
        self.assertEqual(environment['OMNIVOICE_GPU_WORKERS'], '1')
        self.assertEqual(environment['HF_HUB_OFFLINE'], '1')

    def test_partial_relative_linked_and_overlapping_layouts_fail_before_imports(self):
        environment = self.environment()
        del environment['CYBERPUNK_CONVAI_OMNI_ADAPTER']
        with self.assertRaisesRegex(ValueError, 'paths together'):
            worker.resolve_worker_paths(self.app, environment)
        for invalid in ('../cache', '', 'C:cache', 'cache\n', '"C:/cache"'):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, 'absolute'):
                worker.resolve_worker_paths(self.app, {**self.environment(), 'CYBERPUNK_CONVAI_OMNI_CACHE': invalid})
        for field, path in [('cacheDirectory', self.app / 'cache'),
                            ('referenceDirectory', self.root),
                            ('modelDirectory', self.data / 'model'),
                            ('cacheDirectory', self.paths['referenceDirectory'] / 'cache')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                worker.resolve_worker_paths(self.app, {**self.environment(), worker.PATH_OVERRIDES[field]: str(path)})
        linked = self.paths['referenceDirectory']
        original = Path.is_symlink
        with patch.object(Path, 'is_symlink', lambda path: path == linked or original(path)):
            with self.assertRaisesRegex(ValueError, 'Linked'):
                worker.resolve_worker_paths(self.app, self.environment())

    def test_a_configuration_may_hold_1024_voices_and_variants_wait_for_first_use(self):
        paths = worker.resolve_worker_paths(self.app, self.environment())
        voices = {f'npc-kind-{index}': {'status': 'unprepared'} for index in range(1022)}
        voices['johnny-silverhand'] = self.config['voices']['johnny-silverhand']
        voices['johnny-silverhand-v2'] = self.config['voices']['johnny-silverhand']
        self.assertEqual(len(voices), 1024)
        registry = worker.validate_config({**self.config, 'voices': voices}, self.app, paths=paths)
        self.assertIn('johnny-silverhand-v2', registry['refs'])
        self.assertEqual(registry['startupProfiles'], ['johnny-silverhand'], 'only the legacy cast is prepared at startup')
        voices['npc-one-too-many'] = {'status': 'unprepared'}
        with self.assertRaisesRegex(ValueError, 'Invalid local voice registry'):
            worker.validate_config({**self.config, 'voices': voices}, self.app, paths=paths)

    def test_model_and_reference_identity_remain_strict_in_a_package(self):
        paths = worker.resolve_worker_paths(self.app, self.environment())
        with self.assertRaisesRegex(ValueError, 'pinned'):
            worker.validate_config({**self.config, 'revision': 'wrong'}, self.app, paths=paths)
        with self.assertRaisesRegex(ValueError, 'pinned'):
            worker.validate_config({**self.config, 'model': 'vendor/voice-models/another-revision'}, self.app, paths=paths)
        invalid = copy.deepcopy(self.config)
        invalid['voices']['johnny-silverhand']['reference'] = 'runtime/voice-references/../other.wav'
        with self.assertRaisesRegex(ValueError, 'asset path'):
            worker.validate_config(invalid, self.app, paths=paths)
        (self.paths['referenceDirectory'] / 'johnny.wav').unlink()
        registry = worker.validate_config(self.config, self.app, paths=paths)
        self.assertEqual(registry['refs'], {})
        self.assertEqual(registry['unavailableProfiles']['johnny-silverhand'], 'unavailable')

    def test_regular_packaged_source_is_required_instead_of_an_editable_checkout(self):
        paths = worker.resolve_worker_paths(self.app, self.environment())
        package = self.app / 'python/Lib/site-packages/omnivoice'
        (package / 'models').mkdir(parents=True)
        origin = package / '__init__.py'
        origin.write_text('# source fixture\n', encoding='utf-8')
        (package / 'models/omnivoice.py').write_text('# model source fixture\n', encoding='utf-8')
        with patch.object(worker.importlib.util, 'find_spec', return_value=SimpleNamespace(origin=str(origin))):
            worker.validate_portable_source(paths)
        for invalid in (None, SimpleNamespace(origin=None), SimpleNamespace(origin=str(self.root / 'developer/omnivoice/__init__.py'))):
            with self.subTest(spec=invalid), patch.object(worker.importlib.util, 'find_spec', return_value=invalid):
                with self.assertRaises(RuntimeError):
                    worker.validate_portable_source(paths)
        (package / 'models/omnivoice.py').unlink()
        with patch.object(worker.importlib.util, 'find_spec', return_value=SimpleNamespace(origin=str(origin))):
            with self.assertRaises(worker.ReferenceUnavailable):
                worker.validate_portable_source(paths)

    def packaged_source(self, base):
        package = base / 'python/Lib/site-packages/omnivoice'
        (package / 'models').mkdir(parents=True)
        (package / '__init__.py').write_text('# source fixture\n', encoding='utf-8')
        (package / 'models/__init__.py').write_text('', encoding='utf-8')
        (package / 'models/omnivoice.py').write_text('# model source fixture\n', encoding='utf-8')
        return package

    def own_python(self, source):
        return {worker.OWN_PYTHON_VARIABLE: '1', worker.OMNI_SOURCE_VARIABLE: str(source)}

    def test_the_own_python_loads_omnivoice_from_the_pack_and_the_source_check_still_holds(self):
        paths = worker.resolve_worker_paths(self.app, self.environment())
        package = self.packaged_source(self.app)
        before = list(worker.sys.meta_path)
        try:
            self.assertEqual(worker.use_packaged_omnivoice(paths, self.own_python(package)), package.resolve())
            # The real lookup now finds the pack's copy, whatever this Python has installed, and the packaged-source check accepts it.
            self.assertEqual(Path(worker.importlib.util.find_spec('omnivoice').origin).resolve(), (package / '__init__.py').resolve())
            self.assertEqual(Path(worker.importlib.util.find_spec('omnivoice.models.omnivoice').origin).resolve(), (package / 'models/omnivoice.py').resolve())
            worker.validate_portable_source(paths)
        finally:
            worker.sys.meta_path[:] = before
            for name in [name for name in worker.sys.modules if name == 'omnivoice' or name.startswith('omnivoice.')]:
                del worker.sys.modules[name]

    def test_without_the_flag_nothing_changes_and_a_source_outside_the_app_or_incomplete_is_refused(self):
        paths = worker.resolve_worker_paths(self.app, self.environment())
        before = list(worker.sys.meta_path)
        self.assertIsNone(worker.use_packaged_omnivoice(paths, {worker.OMNI_SOURCE_VARIABLE: str(self.app)}))
        self.assertEqual(worker.sys.meta_path, before)
        # An OmniVoice copy outside the application directory (the player's own install) is refused like an editable checkout.
        elsewhere = self.packaged_source(self.root / 'player venv')
        with self.assertRaisesRegex(RuntimeError, 'outside the application directory'):
            worker.use_packaged_omnivoice(paths, self.own_python(elsewhere))
        for invalid in ('', 'relative/omnivoice', None):
            with self.subTest(source=invalid), self.assertRaises(ValueError):
                worker.use_packaged_omnivoice(paths, {worker.OWN_PYTHON_VARIABLE: '1', **({worker.OMNI_SOURCE_VARIABLE: invalid} if invalid is not None else {})})
        package = self.packaged_source(self.app)
        (package / 'models/omnivoice.py').unlink()
        with self.assertRaises(worker.ReferenceUnavailable):
            worker.use_packaged_omnivoice(paths, self.own_python(package))
        self.assertEqual(worker.sys.meta_path, before, 'a refused source installs no finder')

    def test_the_cuda_graph_is_off_by_default_on_rocm_and_on_by_default_on_cuda(self):
        rocm = SimpleNamespace(version=SimpleNamespace(hip='10.1.0', cuda=None))
        cuda = SimpleNamespace(version=SimpleNamespace(hip=None, cuda='12.8'))
        self.assertFalse(worker.cuda_graph_wanted(rocm, {}))
        self.assertTrue(worker.cuda_graph_wanted(rocm, {'CYBERPUNK_CONVAI_CUDA_GRAPH': '1'}))
        self.assertTrue(worker.cuda_graph_wanted(cuda, {}))
        self.assertFalse(worker.cuda_graph_wanted(cuda, {'CYBERPUNK_CONVAI_CUDA_GRAPH': '0'}))

    def test_the_backend_line_names_rocm_or_cuda_and_the_card_from_pytorch(self):
        def fake(hip, cuda, available=True):
            properties = SimpleNamespace(name='AMD Radeon RX 9070 XT' if hip else 'NVIDIA GeForce RTX 4070', total_memory=16304 * 1048576)
            return SimpleNamespace(__version__='2.x', version=SimpleNamespace(hip=hip, cuda=cuda),
                                   cuda=SimpleNamespace(is_available=lambda: available, get_device_properties=lambda index: properties))
        with patch.dict(os.environ, {worker.OWN_PYTHON_VARIABLE: '1'}):
            self.assertEqual(worker.gpu_backend_line(fake('10.1.0', None)), '[gpu] PyTorch 2.x, ROCm/HIP 10.1.0, AMD Radeon RX 9070 XT, 16304 MiB (own Python, experimental)')
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(worker.gpu_backend_line(fake(None, '12.8')), '[gpu] PyTorch 2.x, CUDA 12.8, NVIDIA GeForce RTX 4070, 16304 MiB')
            self.assertEqual(worker.gpu_backend_line(fake(None, None, available=False)), '[gpu] PyTorch 2.x, no GPU build')
            self.assertTrue(worker.gpu_backend_line(SimpleNamespace()).startswith('[gpu] backend unknown'))

    def test_changed_data_reference_cannot_render_from_an_old_prompt(self):
        registry = self.registry()
        renders, frames = [], []
        session = worker.ProfileSession(registry, lambda *values: (renders.append(values) or b'fixture', 1),
                                        lambda _: 'fixture', frames.append, {}, lambda: {})
        session.startup()
        self.assertEqual(frames[-1]['workerPaths'], {'applicationDirectory': str(self.app),
                         **{field: str(path) for field, path in self.paths.items()}})
        path = self.paths['referenceDirectory'] / 'johnny.wav'
        modified = path.read_bytes()[:-2] + b'\x11\x22'
        path.write_bytes(modified)
        count = len(renders)
        session.handle({'op': 'synthesize', 'id': 1, 'profile': 'johnny-silverhand', 'text': 'Hi.', 'steps': 16})
        self.assertEqual(frames[-1]['op'], 'error')
        self.assertEqual(len(renders), count)

    # ---- the player's own reference clips (runtime/player-voices/<key>.wav, resolved only inside the configured player folder) ----

    def player_config(self, key='johnny-silverhand', seconds=.3):
        """The voice `key` is the player's own clip: a few hundred milliseconds of a 24 kHz 16-bit sine in <data>/player-voices."""
        self.player = self.data / 'player-voices'
        self.player.mkdir(parents=True, exist_ok=True)
        path = self.player / f'{key}.wav'
        with wave.open(str(path), 'wb') as output:
            output.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
            output.writeframes(b''.join(struct.pack('<h', round(math.sin(2 * math.pi * 220 * at / 24000) * 8000)) for at in range(round(seconds * 24000))))
        config = copy.deepcopy(self.config)
        config['playerVoiceDirectory'] = str(self.player)
        config['voices'][key] = {'reference': f'runtime/player-voices/{key}.wav', 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                                 'transcript': 'The player typed this.'}
        return config, path

    def player_registry(self, config):
        return worker.validate_config(config, self.app, paths=worker.resolve_worker_paths(self.app, self.environment()))

    def test_player_clip_resolves_only_inside_its_own_folder_and_is_not_prepared_unless_it_is_a_startup_profile(self):
        config, clip = self.player_config()
        config['voices']['judy-alvarez'] = copy.deepcopy(config['voices']['johnny-silverhand'])
        config['voices']['judy-alvarez']['reference'] = 'runtime/voice-references/johnny.wav'
        config['voices']['judy-alvarez']['sha256'] = hashlib.sha256((self.paths['referenceDirectory'] / 'johnny.wav').read_bytes()).hexdigest()
        config['preparation'] = {'mode': 'lazy', 'startupProfiles': ['judy-alvarez']}
        registry = self.player_registry(config)
        self.assertEqual(registry['refs']['johnny-silverhand'][0], str(clip.resolve()))
        self.assertEqual(registry['refs']['judy-alvarez'][0], str(self.paths['referenceDirectory'] / 'johnny.wav'), 'a shipped voice resolves in the shipped folder')
        self.assertEqual(registry['playerRoot'], self.player.resolve())
        self.assertEqual(registry['unavailableProfiles'], {})
        self.assertEqual(registry['startupProfiles'], ['judy-alvarez'])
        renders, frames = [], []
        session = worker.ProfileSession(registry, lambda *values: (renders.append(values) or b'fixture', 1), lambda _: 'fixture', frames.append, {}, lambda: {})
        session.startup()
        self.assertEqual([render[0] for render in renders], ['judy-alvarez'], 'the player voice waits until its character speaks')
        # The attested paths are the same five as without a player folder (the bridge compares them exactly).
        self.assertEqual(set(frames[-1]['workerPaths']), {'applicationDirectory', *self.paths})
        session.handle({'op': 'synthesize', 'id': 1, 'profile': 'johnny-silverhand', 'text': 'Hi.', 'steps': 16})
        self.assertEqual(frames[-1]['op'], 'audio')
        self.assertEqual(renders[-1][0], 'johnny-silverhand')

    def test_changed_player_clip_cannot_render_from_an_old_prompt(self):
        config, clip = self.player_config()
        registry = self.player_registry(config)
        renders, frames = [], []
        session = worker.ProfileSession(registry, lambda *values: (renders.append(values) or b'fixture', 1), lambda _: 'fixture', frames.append, {}, lambda: {})
        session.handle({'op': 'prepare', 'id': 1, 'profile': 'johnny-silverhand'})
        self.assertEqual(frames[-1]['op'], 'prepared')
        count = len(renders)
        clip.write_bytes(clip.read_bytes()[:-2] + b'\x11\x22')
        session.handle({'op': 'synthesize', 'id': 2, 'profile': 'johnny-silverhand', 'text': 'Hi.', 'steps': 16})
        self.assertEqual(frames[-1]['op'], 'error')
        self.assertEqual(len(renders), count)

    def test_player_reference_without_a_folder_or_file_or_with_a_wrong_hash_or_a_link_is_unavailable_not_a_config_error(self):
        config, clip = self.player_config()
        without = copy.deepcopy(config)
        del without['playerVoiceDirectory']
        for variant in (without, {**config, 'playerVoiceDirectory': None}, {**config, 'playerVoiceDirectory': str(self.data / 'never-made')}):
            registry = self.player_registry(variant)
            self.assertEqual(registry['unavailableProfiles'], {'johnny-silverhand': 'unavailable'})
            self.assertNotIn('johnny-silverhand', registry['refs'])
            self.assertEqual(registry['configuredProfiles'], ['johnny-silverhand'])
        self.assertFalse((self.data / 'never-made').exists(), 'a missing folder is not created')
        wrong = copy.deepcopy(config)
        wrong['voices']['johnny-silverhand']['sha256'] = 'b' * 64
        self.assertEqual(self.player_registry(wrong)['unavailableProfiles'], {'johnny-silverhand': 'unavailable'})
        real = Path.is_symlink
        with patch.object(Path, 'is_symlink', lambda path: path.name == 'johnny-silverhand.wav' or real(path)):
            self.assertEqual(self.player_registry(config)['unavailableProfiles'], {'johnny-silverhand': 'unavailable'})
        clip.unlink()
        # The shipped folder holds a file of the same name: the player reference does not fall back to it.
        (self.paths['referenceDirectory'] / 'johnny-silverhand.wav').write_bytes((self.paths['referenceDirectory'] / 'johnny.wav').read_bytes())
        self.assertEqual(self.player_registry(config)['unavailableProfiles'], {'johnny-silverhand': 'unavailable'})
        # And an oversized or too long clip is unavailable, never an error.
        with wave.open(str(clip), 'wb') as output:
            output.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
            output.writeframes(b'\x00\x01' * 8000 * 21)
        long = copy.deepcopy(config)
        long['voices']['johnny-silverhand']['sha256'] = hashlib.sha256(clip.read_bytes()).hexdigest()
        self.assertEqual(self.player_registry(long)['unavailableProfiles'], {'johnny-silverhand': 'unavailable'})

    def test_player_reference_shapes_that_escape_are_refused_and_a_shipped_reference_is_not_read_from_the_player_folder(self):
        config, clip = self.player_config()
        for reference in ('runtime/player-voices/../escape.wav', 'runtime/player-voices/sub/johnny-silverhand.wav', 'runtime/player-voices\\johnny-silverhand.wav',
                          'runtime/player-voices/JOHNNY.wav', 'runtime/player-voices/johnny-silverhand.wav:stream', 'runtime/player-voices/.wav',
                          f'runtime/player-voices/{"a" * 81}.wav'):
            with self.subTest(reference=reference):
                altered = copy.deepcopy(config)
                altered['voices']['johnny-silverhand']['reference'] = reference
                with self.assertRaisesRegex(ValueError, 'asset path'):
                    self.player_registry(altered)
        shutil.copyfile(clip, self.player / 'only-here.wav')
        shipped = copy.deepcopy(config)
        shipped['voices']['johnny-silverhand'] = {'reference': 'runtime/voice-references/only-here.wav',
                                                  'sha256': hashlib.sha256(clip.read_bytes()).hexdigest(), 'transcript': 'Shipped.'}
        self.assertEqual(self.player_registry(shipped)['unavailableProfiles'], {'johnny-silverhand': 'unavailable'})

    def test_player_folder_stays_out_of_application_files_references_and_cache_and_must_be_plain(self):
        config, _ = self.player_config()
        for place in (self.app / 'player', self.app, self.root, self.paths['cacheDirectory'], self.paths['cacheDirectory'] / 'player',
                      self.paths['referenceDirectory'], self.paths['referenceDirectory'] / 'player'):
            with self.subTest(place=str(place)):
                with self.assertRaisesRegex(ValueError, 'separate'):
                    self.player_registry({**config, 'playerVoiceDirectory': str(place)})
        for value in ('player-voices', '', 5, '../player-voices', ' ' + str(self.player), str(self.player) + '\n'):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    self.player_registry({**config, 'playerVoiceDirectory': value})
        real = Path.is_symlink
        with patch.object(Path, 'is_symlink', lambda path: path == self.player or real(path)):
            with self.assertRaisesRegex(ValueError, 'Linked'):
                self.player_registry(config)
        self.assertEqual(self.player_registry(config)['playerRoot'], self.player.resolve())

    def test_development_layout_takes_a_player_folder_anywhere_except_over_its_cache_or_references(self):
        config, clip = self.player_config()
        # A checkout keeps its data beside the application: the application-directory rule belongs to packages only.
        inside = self.app / 'runtime/player-voices'
        inside.mkdir(parents=True)
        model = self.app / self.config['model'] / 'model.safetensors'
        model.parent.mkdir(parents=True)
        model.write_bytes(b'fixture-weights-not-loadable')
        shutil.copyfile(clip, inside / 'johnny-silverhand.wav')
        paths = worker.resolve_worker_paths(self.app, {})
        registry = worker.validate_config({**config, 'playerVoiceDirectory': str(inside)}, self.app, paths=paths)
        self.assertEqual(registry['refs']['johnny-silverhand'][0], str((inside / 'johnny-silverhand.wav').resolve()))
        with self.assertRaisesRegex(ValueError, 'separate'):
            worker.validate_config({**config, 'playerVoiceDirectory': str(paths['cacheDirectory'] / 'x')}, self.app, paths=paths)

    # ---- voices changed while the worker runs (a clip given to a character or taken away: no restart, no reload of the model) ----

    def running_session(self):
        """Two shipped voices (johnny, judy) in a running session whose renders record which file each reply was made from."""
        shipped = copy.deepcopy(self.config)
        shipped['voices']['judy-alvarez'] = copy.deepcopy(shipped['voices']['johnny-silverhand'])
        shipped['preparation'] = {'mode': 'lazy', 'startupProfiles': []}
        registry = worker.validate_config(shipped, self.app, paths=worker.resolve_worker_paths(self.app, self.environment()))
        worker.refresh_identity(registry)
        renders, frames, evicted = [], [], []
        session = worker.ProfileSession(registry, lambda key, *values: (renders.append((key, registry['refs'][key][0])) or b'fixture', 1),
                                        lambda _: 'fixture', frames.append, {}, lambda: {}, evict=lambda *entry: evicted.append(entry))
        return shipped, registry, session, renders, frames, evicted

    def test_a_voice_changes_while_running_and_only_that_character_loses_its_prompt(self):
        shipped, registry, session, renders, frames, evicted = self.running_session()
        player, clip = self.player_config()
        descriptor = player['voices']['johnny-silverhand']
        for number, key in enumerate(('johnny-silverhand', 'judy-alvarez'), 1):
            session.handle({'op': 'prepare', 'id': number, 'profile': key})
        self.assertEqual(list(session.prepared), ['johnny-silverhand', 'judy-alvarez'])
        old = registry['refs']['johnny-silverhand']
        session.handle({'op': 'voices', 'id': 3, 'set': {'johnny-silverhand': descriptor}, 'playerVoiceDirectory': str(self.player)})
        self.assertEqual(frames[-1]['op'], 'voices')
        self.assertEqual(frames[-1]['changed'], ['johnny-silverhand'])
        self.assertEqual(list(session.prepared), ['judy-alvarez'], 'only the changed character was dropped from the prepared list')
        self.assertEqual(frames[-1]['preparedProfiles'], ['judy-alvarez'])
        self.assertEqual(registry['refs']['johnny-silverhand'][0], str(clip.resolve()))
        self.assertEqual(frames[-1]['referenceHashes']['johnny-silverhand'], descriptor['sha256'])
        self.assertEqual(frames[-1]['transcriptHashes']['johnny-silverhand'], hashlib.sha256(descriptor['transcript'].encode()).hexdigest())
        self.assertEqual(frames[-1]['referenceHashes']['judy-alvarez'], shipped['voices']['judy-alvarez']['sha256'])
        self.assertEqual(registry['playerRoot'], self.player.resolve())
        # The prompt of the replaced reference leaves the model's cache, and the cache key now knows the new file.
        self.assertEqual(evicted, [(os.path.abspath(old[0]), old[1], shipped['voices']['johnny-silverhand']['sha256'],
                                    hashlib.sha256(old[1].encode()).hexdigest())])
        self.assertIn((os.path.abspath(str(clip.resolve())), descriptor['transcript']), registry['identity'])
        session.handle({'op': 'synthesize', 'id': 4, 'profile': 'johnny-silverhand', 'text': 'Hi.', 'steps': 16})
        self.assertEqual(frames[-1]['op'], 'audio')
        self.assertEqual(renders[-1], ('johnny-silverhand', str(clip.resolve())), 'the next reply is made from the new clip')
        # Taking the clip away puts the shipped descriptor back: the next reply is made from the shipped file again.
        session.handle({'op': 'voices', 'id': 5, 'set': {'johnny-silverhand': shipped['voices']['johnny-silverhand']}})
        self.assertEqual(frames[-1]['op'], 'voices')
        session.handle({'op': 'synthesize', 'id': 6, 'profile': 'johnny-silverhand', 'text': 'Hi.', 'steps': 16})
        self.assertEqual(renders[-1], ('johnny-silverhand', old[0]))
        self.assertEqual(evicted[-1][2], descriptor['sha256'])
        self.assertEqual(registry['referenceHashes']['judy-alvarez'], shipped['voices']['judy-alvarez']['sha256'], 'another voice is untouched')

    def test_a_voice_the_worker_never_had_is_added_and_a_removed_one_leaves(self):
        shipped, registry, session, renders, frames, evicted = self.running_session()
        player, clip = self.player_config(key='custom-rebecca-abcd')
        descriptor = player['voices']['custom-rebecca-abcd']
        session.handle({'op': 'voices', 'id': 1, 'set': {'custom-rebecca-abcd': descriptor}, 'playerVoiceDirectory': str(self.player)})
        self.assertIn('custom-rebecca-abcd', frames[-1]['profiles'])
        self.assertIn('custom-rebecca-abcd', frames[-1]['configuredProfiles'])
        session.handle({'op': 'synthesize', 'id': 2, 'profile': 'custom-rebecca-abcd', 'text': 'Hi.', 'steps': 16})
        self.assertEqual(renders[-1], ('custom-rebecca-abcd', str(clip.resolve())))
        session.handle({'op': 'voices', 'id': 3, 'remove': ['custom-rebecca-abcd']})
        self.assertEqual(frames[-1]['op'], 'voices')
        self.assertNotIn('custom-rebecca-abcd', frames[-1]['profiles'])
        self.assertNotIn('custom-rebecca-abcd', registry['refs'])
        self.assertNotIn('custom-rebecca-abcd', registry['descriptors'])
        self.assertEqual(len(evicted), 1)
        session.handle({'op': 'synthesize', 'id': 4, 'profile': 'custom-rebecca-abcd', 'text': 'Hi.', 'steps': 16})
        self.assertEqual(frames[-1]['op'], 'error', 'a voice that is gone is not spoken')
        self.assertIn('judy-alvarez', registry['refs'])

    def test_a_refused_voice_change_leaves_every_voice_as_it_was(self):
        shipped, registry, session, renders, frames, evicted = self.running_session()
        player, clip = self.player_config()
        good = player['voices']['johnny-silverhand']
        before = copy.deepcopy({field: registry[field] for field in ('refs', 'descriptors', 'referenceHashes', 'unavailableProfiles', 'configuredProfiles')})
        for number, request in enumerate((
                {'set': {'johnny-silverhand': good, 'judy-alvarez': {'reference': 'runtime/player-voices/../x.wav', 'sha256': 'a' * 64, 'transcript': 'x'}}},
                {'set': {'Not A Key': good}},
                {'set': {'johnny-silverhand': good}, 'remove': ['johnny-silverhand']},
                {'set': {f'k-{at}': {'status': 'unprepared'} for at in range(worker.MAX_VOICE_CHANGES + 1)}},
                {'set': {'johnny-silverhand': good}, 'playerVoiceDirectory': str(self.paths['referenceDirectory'] / 'inside')},
                {'set': 'nothing'}), 1):
            with self.subTest(request=number):
                session.handle({'op': 'voices', 'id': number, **request})
                self.assertEqual(frames[-1]['op'], 'error')
                self.assertEqual(frames[-1]['profiles'], sorted(before['refs']))
                self.assertEqual({field: registry[field] for field in before}, before)
                self.assertIsNone(registry.get('playerRoot'))
        # A clip file that is gone (or not the recorded bytes) only withdraws that voice: the change itself is accepted.
        clip.write_bytes(clip.read_bytes()[:-2] + b'\x11\x22')
        session.handle({'op': 'voices', 'id': 10, 'set': {'johnny-silverhand': good}, 'playerVoiceDirectory': str(self.player)})
        self.assertEqual(frames[-1]['op'], 'voices')
        self.assertEqual(registry['unavailableProfiles'], {'johnny-silverhand': 'unavailable'})
        self.assertNotIn('johnny-silverhand', frames[-1]['profiles'])
        self.assertIn('judy-alvarez', frames[-1]['profiles'])
        # The player folder cannot be moved while the worker runs.
        other = self.data / 'other-player-voices'
        session.handle({'op': 'voices', 'id': 11, 'set': {}, 'playerVoiceDirectory': str(other)})
        self.assertEqual(frames[-1]['op'], 'error')
        self.assertEqual(registry['playerRoot'], self.player.resolve())

    # ---- multilingual packs (docs/VOICE_LANGUAGE_PACKS.md): a request may name a pack clip beside its profile's English reference ----

    def pack_clip(self, name='johnny-silverhand', language='zh-cn', kind='picked', seconds=1, rate=24000):
        folder = self.paths['referenceDirectory'] / 'multilingual' / language / kind
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f'{name}.wav'
        with wave.open(str(path), 'wb') as output:
            output.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
            output.writeframes(b'\x00\x01' * int(rate * seconds))
        return path, {'reference': f'runtime/voice-references/multilingual/{language}/{kind}/{name}.wav',
                      'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'transcript': '我有一个计划。'}

    def language_session(self):
        registry = self.registry()
        renders, frames = [], []
        session = worker.ProfileSession(registry, lambda key, text, steps, language=None, reference=None:
                                        (renders.append((key, text, steps, language, reference)) or b'fixture', 1),
                                        lambda _: 'fixture', frames.append, {}, lambda: {})
        return registry, session, renders, frames

    def test_a_pack_clip_resolves_inside_the_references_folder_like_any_shipped_reference(self):
        path, descriptor = self.pack_clip()
        registry = self.registry()
        # The packaged layout keeps references outside the application directory; the pack's folder is a plain subfolder of it.
        self.assertFalse(self.paths['referenceDirectory'].resolve().is_relative_to(self.app.resolve()))
        file, words = worker.validate_reference(self.app, descriptor, reference_root=registry['referenceRoot'])
        self.assertEqual(file, str(path.resolve()))
        self.assertEqual(words, descriptor['transcript'])
        # A clip of a pack that goes past the 20 s limit is refused like any other reference.
        _, long_descriptor = self.pack_clip('long-one', seconds=21)
        with self.assertRaises(worker.ReferenceUnavailable):
            worker.validate_reference(self.app, long_descriptor, reference_root=registry['referenceRoot'])

    def test_a_request_with_a_pack_clip_renders_from_it_and_leaves_the_profile_as_it_was(self):
        path, descriptor = self.pack_clip()
        registry, session, renders, frames = self.language_session()
        session.handle({'op': 'synthesize', 'id': 1, 'profile': 'johnny-silverhand', 'text': 'Hi.', 'steps': 16, 'language': 'zh', 'languageReference': descriptor})
        self.assertEqual(frames[-1]['op'], 'audio')
        self.assertEqual(frames[-1]['languageReference'], 'used')
        self.assertEqual(renders[-1][0], 'johnny-silverhand')
        self.assertEqual(renders[-1][3], 'zh')
        self.assertEqual(renders[-1][4], (str(path.resolve()), descriptor['transcript']))
        self.assertEqual(list(session.prepared), [], 'the profile was not prepared by a reply in another language')
        # The prompt cache knows the clip by its own file and words (never the English profile's), so the two never share a prepared state.
        key = (str(Path(os.path.abspath(path.resolve()))), descriptor['transcript'])
        self.assertIn(key, registry['languageIdentity'])
        self.assertNotEqual(key, (os.path.abspath(registry['refs']['johnny-silverhand'][0]), registry['refs']['johnny-silverhand'][1]))
        # A voice change rebuilds the identities of the profiles and keeps the pack clip's.
        worker.refresh_identity(registry)
        self.assertIn(key, registry['identity'])
        # The request without a clip is the English reference, exactly as before.
        session.handle({'op': 'synthesize', 'id': 2, 'profile': 'johnny-silverhand', 'text': 'Hi.', 'steps': 16})
        self.assertNotIn('languageReference', frames[-1])
        self.assertEqual(renders[-1][4], None)
        self.assertEqual(list(session.prepared), ['johnny-silverhand'])

    def test_a_refused_pack_clip_is_spoken_from_the_english_reference_and_the_answer_says_so(self):
        path, descriptor = self.pack_clip()
        for name, bad in (('a wrong hash', {**descriptor, 'sha256': '0' * 64}),
                          ('another namespace', {**descriptor, 'reference': 'runtime/voice-references/johnny.wav'}),
                          ('a climb out of the pack folder', {**descriptor, 'reference': 'runtime/voice-references/multilingual/zh-cn/picked/../../../johnny.wav'}),
                          ('a player clip path', {**descriptor, 'reference': 'runtime/player-voices/johnny-silverhand.wav'}),
                          ('an extra field', {**descriptor, 'extra': 1}),
                          ('a missing file', {**descriptor, 'reference': 'runtime/voice-references/multilingual/zh-cn/picked/nobody.wav'}),
                          ('not a descriptor', 'multilingual')):
            registry, session, renders, frames = self.language_session()
            session.handle({'op': 'synthesize', 'id': 1, 'profile': 'johnny-silverhand', 'text': 'Hi.', 'steps': 16, 'language': 'zh', 'languageReference': bad})
            self.assertEqual(frames[-1]['op'], 'audio', name)
            self.assertEqual(frames[-1]['languageReference'], 'fallback', name)
            self.assertEqual(renders[-1][4], None, name)
            self.assertEqual(renders[-1][0], 'johnny-silverhand', name)

    def test_a_changed_pack_clip_is_checked_again_and_a_linked_one_is_refused(self):
        path, descriptor = self.pack_clip()
        registry, session, renders, frames = self.language_session()
        session.handle({'op': 'synthesize', 'id': 1, 'profile': 'johnny-silverhand', 'text': 'Hi.', 'steps': 16, 'language': 'zh', 'languageReference': descriptor})
        self.assertEqual(frames[-1]['languageReference'], 'used')
        path.write_bytes(path.read_bytes()[:-2] + b'\x11\x22')
        session.handle({'op': 'synthesize', 'id': 2, 'profile': 'johnny-silverhand', 'text': 'Hi.', 'steps': 16, 'language': 'zh', 'languageReference': descriptor})
        self.assertEqual(frames[-1]['languageReference'], 'fallback', 'the file no longer matches its hash')
        outside = self.root / 'elsewhere.wav'
        shutil.copy(self.paths['referenceDirectory'] / 'johnny.wav', outside)
        _, linked = self.pack_clip('linked-one')
        linked_path = self.paths['referenceDirectory'] / 'multilingual/zh-cn/picked/linked-one.wav'
        linked_path.unlink()
        try:
            os.symlink(outside, linked_path)
        except OSError:
            self.skipTest('symbolic links are not available here')
        session.handle({'op': 'synthesize', 'id': 3, 'profile': 'johnny-silverhand', 'text': 'Hi.', 'steps': 16, 'language': 'zh', 'languageReference': linked})
        self.assertEqual(frames[-1]['languageReference'], 'fallback')

    def test_at_most_32_pack_clips_are_remembered_by_the_session(self):
        registry, session, renders, frames = self.language_session()
        for number in range(worker.MAX_LANGUAGE_REFERENCES + 3):
            _, descriptor = self.pack_clip(f'voice-{number}', seconds=0.1)
            session.handle({'op': 'synthesize', 'id': number + 1, 'profile': 'johnny-silverhand', 'text': 'Hi.', 'steps': 16, 'language': 'zh', 'languageReference': descriptor})
            self.assertEqual(frames[-1]['languageReference'], 'used')
        self.assertEqual(len(session.language_references), worker.MAX_LANGUAGE_REFERENCES)
        self.assertEqual(len(registry['languageIdentity']), worker.MAX_LANGUAGE_REFERENCES)

    def test_shared_admission_is_in_data_and_excludes_other_app_versions(self):
        cache = self.paths['cacheDirectory']
        other_app = self.root / 'other application version'
        other_app.mkdir()
        with worker.model_admission(self.app, cache_root=cache):
            with self.assertRaisesRegex(RuntimeError, 'shared model slot'):
                with worker.model_admission(other_app, cache_root=cache):
                    self.fail('A second application cannot allocate the model')
        self.assertTrue((cache / 'resident-model.lock').is_file())
        self.assertFalse((self.app / 'runtime').exists())
        with worker.model_admission(other_app, cache_root=cache):
            pass

    def test_admission_works_when_a_sandbox_redirects_the_lock_file(self):
        # A game started from a packaged app sees changed files of its data folder at another real path (file virtualization).
        cache = self.paths['cacheDirectory']
        elsewhere = self.root / 'virtualized copy' / 'resident-model.lock'
        real_resolve = Path.resolve
        def redirected(path, *args, **kwargs):
            return elsewhere if path.name == 'resident-model.lock' else real_resolve(path, *args, **kwargs)
        with patch.object(Path, 'resolve', redirected):
            with worker.model_admission(self.app, cache_root=cache):
                pass
        self.assertTrue((cache / 'resident-model.lock').is_file())

    def hold_slot_then_release(self, cache, hold_s):
        """Another worker that owns the slot and exits `hold_s` later (a worker of the old bridge, still going down)."""
        import threading
        owned, release = threading.Event(), threading.Event()
        def owner():
            with worker.model_admission(self.app, cache_root=cache):
                owned.set()
                release.wait(timeout=30)
        thread = threading.Thread(target=owner, daemon=True)
        thread.start()
        self.assertTrue(owned.wait(timeout=10))
        timer = threading.Timer(hold_s, release.set)
        timer.start()
        self.addCleanup(release.set)
        self.addCleanup(timer.cancel)
        self.addCleanup(thread.join, 10)

    def test_a_slot_owned_by_a_worker_that_is_exiting_is_waited_for_and_then_taken(self):
        cache = self.paths['cacheDirectory']
        other_app = self.root / 'restarted application'
        other_app.mkdir()
        self.hold_slot_then_release(cache, 0.4)
        naps = []
        real_sleep = worker.time.sleep
        def nap(seconds):
            naps.append(seconds)
            real_sleep(seconds)
        with worker.model_admission(other_app, cache_root=cache, wait_s=8, poll_s=0.1, sleep=nap):
            pass
        self.assertTrue(naps, 'the slot was owned at the start, so it polled')
        self.assertLessEqual(max(naps), 0.1)

    def test_a_slot_owned_by_a_worker_that_stays_alive_is_reported_after_the_wait(self):
        cache = self.paths['cacheDirectory']
        other_app = self.root / 'second application'
        other_app.mkdir()
        self.hold_slot_then_release(cache, 20)
        clock = {'now': 0.0}
        naps = []
        def nap(seconds):
            naps.append(seconds)
            clock['now'] += seconds
        with self.assertRaisesRegex(RuntimeError, 'shared model slot'):
            with worker.model_admission(other_app, cache_root=cache, wait_s=worker.MODEL_SLOT_WAIT_S, sleep=nap, clock=lambda: clock['now']):
                self.fail('A live second worker must not be admitted')
        self.assertEqual(sum(naps), worker.MODEL_SLOT_WAIT_S)
        self.assertEqual(len(naps), 9)
        self.assertTrue(8 <= worker.MODEL_SLOT_WAIT_S <= 10 and worker.MODEL_SLOT_POLL_S == 1.0)

    def test_a_free_slot_never_waits_and_the_default_reports_an_owned_one_at_once(self):
        cache = self.paths['cacheDirectory']
        other_app = self.root / 'third application'
        other_app.mkdir()
        def forbidden(seconds):
            self.fail('a free slot must not sleep')
        with worker.model_admission(self.app, cache_root=cache, wait_s=8, sleep=forbidden):
            with self.assertRaisesRegex(RuntimeError, 'shared model slot'):
                with worker.model_admission(other_app, cache_root=cache, sleep=forbidden):
                    self.fail('The default does not wait')

    def test_the_worker_start_waits_for_the_slot(self):
        main_source = SOURCE.read_text(encoding='utf-8').split('def main():', 1)[1].split('def voice_environment', 1)[0]
        self.assertIn('wait_s=MODEL_SLOT_WAIT_S', main_source)

    def test_copied_worker_main_derives_the_relocated_app_and_never_uses_the_checkout(self):
        copied = self.app / 'bridge/resident-voice-worker.py'
        copied.parent.mkdir()
        shutil.copyfile(SOURCE, copied)
        config_path = self.data / 'local-voices.json'
        config_path.write_text(json.dumps(self.config), encoding='utf-8')
        relocated_spec = importlib.util.spec_from_file_location('copied_resident_voice', copied)
        relocated = importlib.util.module_from_spec(relocated_spec)
        relocated_spec.loader.exec_module(relocated)
        observed = []
        with patch.dict(os.environ, self.environment(), clear=True), \
             patch('sys.argv', [str(copied), '--config', str(config_path)]), \
             patch.object(relocated, 'run_worker', side_effect=lambda registry: observed.append(registry)):
            relocated.main()
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0]['root'], self.app)
        self.assertEqual(observed[0]['paths']['applicationDirectory'], self.app)
        self.assertEqual(observed[0]['model'], self.paths['modelDirectory'])
        self.assertFalse((self.app / 'runtime').exists())


def make_junction(link, target):
    """A real directory link (a junction on Windows, a symlink elsewhere); the test is skipped where none can be made."""
    try:
        if os.name == 'nt':
            import subprocess
            made = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(target)], capture_output=True)
            if made.returncode != 0:
                raise OSError(made.stderr)
        else:
            os.symlink(target, link, target_is_directory=True)
    except (OSError, NotImplementedError) as error:
        raise unittest.SkipTest(f'directory links are not available here: {error}')


class AppLinks(PortableVoicePaths):
    """A link ABOVE the Runtime's app folder (a junctioned Steam library, a moved Documents, OneDrive) is accepted; a link inside it is refused, as is
    one that leaves it. Real junctions."""

    def setUp(self):
        super().setUp()
        self.links = []
        self.addCleanup(self.unlink)

    def unlink(self):
        for link in reversed(self.links):   # a junction: remove the link, never what it points at
            try:
                os.rmdir(link)
            except OSError:
                pass

    def link(self, link, target):
        make_junction(link, target)
        self.links.append(link)

    def test_a_link_above_the_app_folder_is_accepted(self):
        library = self.root / 'library'
        self.link(library, self.root)
        app = library / self.app.name   # the whole layout spelled through the junction
        environment = {worker.PATH_OVERRIDES[field]: str(library / path.relative_to(self.root)) for field, path in self.paths.items()}
        paths = worker.resolve_worker_paths(app, environment)
        self.assertEqual(paths['modelDirectory'], self.paths['modelDirectory'].resolve())
        self.assertEqual(worker.validate_config(self.config, app, paths=paths)['model'], self.paths['modelDirectory'].resolve())
        # The app folder itself being the link counts as above it.
        self.link(self.root / 'app-link', self.app)
        app = self.root / 'app-link'
        environment.update({worker.PATH_OVERRIDES['modelDirectory']: str(app / 'models/omnivoice'),
                            worker.PATH_OVERRIDES['adapterDirectory']: str(app / 'voice/voicestudio/backend')})
        self.assertTrue(worker.resolve_worker_paths(app, environment)['portable'])

    def test_a_link_inside_the_app_folder_is_refused(self):
        self.link(self.app / 'models/linked', self.paths['modelDirectory'])
        with self.assertRaisesRegex(ValueError, 'Linked directories inside the application directory'):
            worker.resolve_worker_paths(self.app, {**self.environment(), 'CYBERPUNK_CONVAI_OMNI_MODEL': str(self.app / 'models/linked')})

    def test_a_link_that_leaves_the_app_folder_is_refused(self):
        outside = self.root / 'elsewhere'
        (outside / 'omnivoice').mkdir(parents=True)
        self.link(self.app / 'models/escape', outside)
        with self.assertRaisesRegex(ValueError, 'Linked directories inside the application directory'):
            worker.resolve_worker_paths(self.app, {**self.environment(), 'CYBERPUNK_CONVAI_OMNI_MODEL': str(self.app / 'models/escape/omnivoice')})

    def test_a_package_outside_the_pack_is_still_refused_when_the_app_is_behind_a_link(self):
        library = self.root / 'library'
        self.link(library, self.root)
        stray = self.data / 'stray-model'
        stray.mkdir()
        environment = {worker.PATH_OVERRIDES[field]: str(library / path.relative_to(self.root)) for field, path in self.paths.items()}
        environment[worker.PATH_OVERRIDES['modelDirectory']] = str(stray)
        with self.assertRaisesRegex(ValueError, 'must remain in the application directory'):
            worker.resolve_worker_paths(library / self.app.name, environment)


class UsvfsVoicePaths(unittest.TestCase):
    """Mod Organizer 2 (USVFS): the OmniVoice pack is its own mod, so its model and adapter really live outside the Runtime's app folder, and Path.resolve()
    of a file answers with the mod that holds it. USVFS does not exist here: the pack is a real folder beside the app, and where a merged folder is needed
    Path.resolve() is patched to answer as USVFS does. The decision logic is tested: the flag (CYBERPUNK_CONVAI_USVFS) and the pack folder the service names
    (CYBERPUNK_CONVAI_OMNI_PACK) make the pack acceptable, links never are, and without the flag nothing changes."""

    def setUp(self):
        PortableVoicePaths.setUp(self)
        self.pack = self.root / 'mods' / 'Omni pack' / 'omni'
        self.pack_paths = {'modelDirectory': self.pack / 'model', 'adapterDirectory': self.pack / 'voicestudio/backend'}
        self.pack_paths['modelDirectory'].mkdir(parents=True)
        (self.pack_paths['modelDirectory'] / 'model.safetensors').write_bytes(b'fixture-weights-not-loadable')
        adapter = self.pack_paths['adapterDirectory'] / 'services/tts_backend.py'
        adapter.parent.mkdir(parents=True)
        adapter.write_text('# fixture adapter, never imported\n', encoding='utf-8')

    def environment(self, pack=True, flag='1'):
        environment = {worker.PATH_OVERRIDES[field]: str(path) for field, path in {**self.paths, **self.pack_paths}.items()}
        if flag is not None:
            environment[worker.USVFS_VARIABLE] = flag
        if pack:
            environment[worker.PACK_VARIABLE] = str(self.pack)
        return environment

    def resolved(self, environment=None, config=None):
        environment = self.environment() if environment is None else environment
        with patch.dict(os.environ, environment, clear=True):
            paths = worker.resolve_worker_paths(self.app, environment)
            return paths, worker.validate_config(config or self.config, self.app, paths=paths)

    def test_the_pack_outside_the_app_folder_is_accepted_inside_usvfs(self):
        paths, registry = self.resolved()
        self.assertTrue(paths['portable'])
        self.assertEqual(paths['packDirectory'], self.pack)
        self.assertEqual(paths['modelDirectory'], self.pack_paths['modelDirectory'])
        self.assertEqual(paths['adapterDirectory'], self.pack_paths['adapterDirectory'])
        self.assertEqual(registry['model'], self.pack_paths['modelDirectory'])
        self.assertEqual(registry['refs']['johnny-silverhand'][0], str(self.paths['referenceDirectory'] / 'johnny.wav'))
        self.assertEqual(paths['applicationDirectory'], self.app)

    def test_the_same_layout_is_refused_without_the_flag_or_without_the_pack_folder(self):
        for label, environment in (('no flag', self.environment(flag=None)), ('flag off', self.environment(flag='0')),
                                   ('no pack folder', self.environment(pack=False))):
            with self.subTest(label), self.assertRaisesRegex(ValueError, 'must remain in the application directory'):
                self.resolved(environment)

    def test_the_model_and_adapter_must_still_be_inside_the_app_or_the_named_pack(self):
        for field, place in (('modelDirectory', self.data / 'model'), ('adapterDirectory', self.root / 'mods' / 'Other mod' / 'backend'),
                             ('modelDirectory', self.pack), ('adapterDirectory', self.pack.parent)):
            with self.subTest(field=field, place=str(place)), self.assertRaisesRegex(ValueError, 'must remain in the application directory'):
                self.resolved({**self.environment(), worker.PATH_OVERRIDES[field]: str(place)})

    def test_persistent_data_stays_apart_from_the_app_and_the_pack(self):
        for field, place in (('referenceDirectory', self.pack / 'voices'), ('cacheDirectory', self.pack / 'cache'),
                             ('referenceDirectory', self.pack.parent), ('cacheDirectory', self.pack_paths['modelDirectory'] / 'cache')):
            with self.subTest(field=field, place=str(place)), self.assertRaisesRegex(ValueError, 'separate from application files'):
                self.resolved({**self.environment(), worker.PATH_OVERRIDES[field]: str(place)})
        _, registry = self.resolved()
        self.assertFalse(registry['paths']['cacheDirectory'].is_relative_to(self.pack))

    def test_a_link_in_the_pack_is_refused_as_it_is_outside_usvfs(self):
        real = Path.is_symlink
        for linked in (self.pack_paths['modelDirectory'], self.pack):
            with self.subTest(linked=str(linked)), patch.object(Path, 'is_symlink', lambda path, linked=linked: path == linked or real(path)):
                with self.assertRaisesRegex(ValueError, 'Linked'):
                    self.resolved()
        with patch.object(Path, 'is_symlink', lambda path: path == self.pack.parent or real(path)):
            self.resolved()   # a link above the pack is the player's layout
        with patch.object(Path, 'is_symlink', lambda path: path.name == 'model.safetensors' or real(path)):
            with self.assertRaisesRegex(ValueError, 'Linked'):
                self.resolved()

    def test_a_pack_folder_that_is_not_an_absolute_plain_path_is_refused(self):
        for value in ('omni', '..\\omni', ' ' + str(self.pack), str(self.pack) + '\n'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'absolute'):
                self.resolved({**self.environment(), worker.PACK_VARIABLE: value})

    def test_files_that_resolve_to_other_mods_are_found_where_the_virtual_folder_shows_them(self):
        # USVFS answers Path.resolve() of a folder with the winning mod's folder and of a file with the mod that holds that file.
        real = Path.resolve
        mods = real(self.root) / 'mods'
        folders = [real(self.paths['referenceDirectory']), real(self.pack_paths['modelDirectory'])]
        for folder in folders:
            for source in folder.iterdir():
                target = mods / 'B' / folder.name / source.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)

        def resolve(path, strict=False):
            found = real(path, strict=strict)
            for folder in folders:
                if found == folder:
                    return mods / 'A' / folder.name
                if found.is_relative_to(folder):
                    return mods / 'B' / folder.name / found.relative_to(folder)
            return found
        with patch.object(Path, 'resolve', resolve):
            _, registry = self.resolved()
            self.assertIn('johnny-silverhand', registry['refs'], 'the reference is read from the file the virtual folder shows')
            self.assertEqual(registry['unavailableProfiles'], {})
            self.assertTrue(registry['model'].is_dir())
            # Without the flag the same simulated view is refused: outside USVFS the resolved paths decide, as before.
            with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(ValueError, 'Local asset'):
                worker.asset_file(self.pack_paths['modelDirectory'], 'model.safetensors')

    def test_the_packaged_source_may_live_in_the_pack_inside_usvfs_only(self):
        package = self.pack / 'python/Lib/site-packages/omnivoice'
        (package / 'models').mkdir(parents=True)
        origin = package / '__init__.py'
        origin.write_text('# source fixture\n', encoding='utf-8')
        (package / 'models/omnivoice.py').write_text('# model source fixture\n', encoding='utf-8')
        paths, _ = self.resolved()
        with patch.dict(os.environ, self.environment(), clear=True):
            with patch.object(worker.importlib.util, 'find_spec', return_value=SimpleNamespace(origin=str(origin))):
                worker.validate_portable_source(paths)
            elsewhere = self.root / 'developer/omnivoice/__init__.py'
            with patch.object(worker.importlib.util, 'find_spec', return_value=SimpleNamespace(origin=str(elsewhere))):
                with self.assertRaises(RuntimeError):
                    worker.validate_portable_source(paths)
        # A layout that has no pack folder has no such place: the same package is outside the application directory.
        without_pack = {**paths, 'packDirectory': None}
        with patch.dict(os.environ, self.environment(), clear=True):
            with patch.object(worker.importlib.util, 'find_spec', return_value=SimpleNamespace(origin=str(origin))):
                with self.assertRaisesRegex(RuntimeError, 'outside the application directory'):
                    worker.validate_portable_source(without_pack)

    def test_the_player_folder_stays_out_of_the_pack_too(self):
        player = self.data / 'player voices'
        _, registry = self.resolved(config={**self.config, 'playerVoiceDirectory': str(player)})
        self.assertEqual(registry['playerRoot'], player)
        for place in (self.pack, self.pack / 'player', self.pack.parent):
            with self.subTest(place=str(place)), self.assertRaisesRegex(ValueError, 'separate'):
                self.resolved(config={**self.config, 'playerVoiceDirectory': str(place)})

    def test_an_asset_path_cannot_step_out_of_its_folder_inside_usvfs(self):
        with patch.dict(os.environ, self.environment(), clear=True):
            for relative in ('../model.safetensors', 'a/../../x', 'a\\b', 'C:x'):
                with self.subTest(relative=relative), self.assertRaises(ValueError):
                    worker.asset_file(self.pack_paths['modelDirectory'], relative)
            self.assertTrue(worker.asset_file(self.pack_paths['modelDirectory'], 'model.safetensors').is_file())

    def load_copy(self, flag):
        """The worker script as the bridge starts it: a copy inside the app folder, imported with or without the USVFS flag."""
        copied = self.app / 'bridge/resident-voice-worker.py'
        copied.parent.mkdir(exist_ok=True)
        shutil.copyfile(SOURCE, copied)
        loader = importlib.util.spec_from_file_location('copied_resident_voice_usvfs', copied)
        module = importlib.util.module_from_spec(loader)
        # USVFS answers Path.resolve() of a file with the mod that holds it, not with the folder the bridge launched the worker from.
        holder = self.root / 'mods' / 'Runtime update' / 'app' / 'bridge' / copied.name
        real = Path.resolve
        resolve = lambda path, strict=False: holder if path == copied else real(path, strict=strict)
        with patch.object(Path, 'resolve', resolve), patch.dict(os.environ, {worker.USVFS_VARIABLE: flag} if flag else {}, clear=True):
            loader.loader.exec_module(module)
        return module, holder

    def test_the_application_directory_the_worker_reports_is_the_folder_it_was_launched_from_inside_usvfs(self):
        # The bridge compares this with the folder it launched the worker from. A merged app folder resolves to the winning mod's folder, a file below
        # it to the mod that holds the file: reporting the resolved place of the script failed the comparison for a Runtime in the game folder
        # beside Local AI and OmniVoice packs that are mods of their own (2026-10-21 report).
        module, holder = self.load_copy('1')
        self.assertEqual(module.ROOT, self.app)
        self.assertNotEqual(module.ROOT, holder.parents[1])
        with patch.dict(os.environ, self.environment(), clear=True):
            paths = module.resolve_worker_paths(module.ROOT, self.environment())
        self.assertEqual(paths['applicationDirectory'], self.app)
        self.assertEqual({key: str(paths[key]) for key in ('applicationDirectory', *worker.PATH_OVERRIDES)},
                         {'applicationDirectory': str(self.app), **{field: str(path) for field, path in {**self.paths, **self.pack_paths}.items()}})

    def test_without_the_flag_the_application_directory_is_still_where_the_script_resolves_to(self):
        module, holder = self.load_copy(None)
        self.assertEqual(module.ROOT, holder.parents[1])
        module, holder = self.load_copy('0')
        self.assertEqual(module.ROOT, holder.parents[1])

    def test_without_the_flag_nothing_changed_for_a_physical_install(self):
        plain = {worker.PATH_OVERRIDES[field]: str(path) for field, path in self.paths.items()}
        with patch.dict(os.environ, {}, clear=True):
            paths = worker.resolve_worker_paths(self.app, plain)
            registry = worker.validate_config(self.config, self.app, paths=paths)
        self.assertIsNone(paths['packDirectory'])
        self.assertEqual(paths['applicationDirectory'], self.app.resolve())
        self.assertEqual(registry['model'], self.paths['modelDirectory'].resolve())


if __name__ == '__main__':
    unittest.main()
