"""Portable path checks use tiny WAV/weight fixtures and never import CUDA."""
from pathlib import Path
import copy
import hashlib
import importlib.util
import json
import os
import shutil
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


if __name__ == '__main__':
    unittest.main()
