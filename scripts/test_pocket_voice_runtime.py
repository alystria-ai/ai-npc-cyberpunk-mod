"""Identity, actual producer path and shutdown tests; no neural model imports."""
from __future__ import annotations

import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import struct
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import math
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))
import pocket_voice_runtime as runtime

spec = importlib.util.spec_from_file_location('pocket_worker_under_test', ROOT / 'bridge/pocket-voice-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def wav(path, frames=2400):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24000)
        output.writeframes(b'\0\0' * frames)


def tone(path, seconds=.3, hertz=220):
    """A few hundred milliseconds of a 24 kHz 16-bit sine: a tiny, real, valid reference."""
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = b''.join(struct.pack('<h', round(math.sin(2 * math.pi * hertz * at / 24000) * 8000)) for at in range(round(seconds * 24000)))
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24000)
        output.writeframes(frames)


class SourceCheck(unittest.TestCase):
    """The source check covers exactly the files the pinned revision ships (a manifest of path to hash): anything else beside them is ignored,
    a changed or missing pinned file is named, and only code that runs (pocket_tts/ or any .py) can stop the voice."""
    FILES = {'pocket_tts/__init__.py': '# package\n', 'pocket_tts/models/flow.py': 'x = 1\n', 'pocket_tts/config/english.yaml': 'a: 1\n',
             'training/train.py': 'y = 2\n', 'README.md': '# readme\nline two\n', 'docs/guide.md': 'guide\n', '.gitignore': '*.pyc\n',
             'uv.lock': 'lock\n'}

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pocket-source-test-')
        self.root = Path(self.temp.name) / 'pocket-tts'
        for rel, text in self.FILES.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(text.encode())
        self.manifest = {rel: runtime.digest_file(self.root / rel) for rel in self.FILES}

    def tearDown(self):
        self.temp.cleanup()

    def check(self):
        return runtime.verify_source(self.root, self.manifest)

    def fails(self):
        with self.assertRaises(ValueError) as caught:
            self.check()
        message = str(caught.exception)
        self.assertTrue(message.startswith('Pocket source differs from the pinned official revision ('), message)
        self.assertNotIn('\n', message)
        self.assertNotIn(str(self.root), message, 'only relative paths are named')
        self.assertNotIn(self.temp.name, message)
        return message

    def test_the_shipped_list_is_the_pinned_revision_and_needs_no_file_beside_it(self):
        self.assertEqual(runtime.digest_manifest(), runtime.SOURCE_SHA256)
        self.assertEqual(len(runtime.SOURCE_FILES), 140)
        self.assertTrue(all(len(value) == 64 for value in runtime.SOURCE_FILES.values()))
        self.assertIn('pocket_tts/__init__.py', runtime.SOURCE_FILES)
        self.assertTrue(all(runtime.source_runs(rel) for rel in runtime.SOURCE_FILES if rel.startswith('pocket_tts/') or rel.endswith('.py')))
        self.assertIsNone(self.check())

    def test_files_that_are_not_pinned_are_ignored_by_design(self):
        # Vortex (marker, deployment record, backup of a file it replaced), Python (__pycache__), Explorer, an antivirus note, and a file
        # an older Runtime shipped that Vortex keeps because the new archive does not list it.
        for rel in ('__folder_managed_by_vortex', 'pocket_tts/__folder_managed_by_vortex', 'vortex.deployment.json', 'vortex.deployment.msgpack',
                    'pocket_tts/__init__.py.vortex_backup', 'README.md.vortex_backup', 'desktop.ini', 'pocket_tts/Thumbs.db', '.DS_Store',
                    'pocket_tts/__pycache__/__init__.cpython-312.pyc', 'pocket_tts/models/__pycache__/flow.cpython-312.pyc',
                    'pocket_tts/old_module_from_0.2.1.py', 'old-pocket-notes.txt', 'QUARANTINED_BY_ANTIVIRUS.txt', 'docs/extra/page.md'):
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'something else')
        self.assertIsNone(self.check())

    def test_a_changed_or_missing_python_or_package_file_fails_and_is_named(self):
        (self.root / 'pocket_tts/models/flow.py').write_text('x = 2\n')
        message = self.fails()
        self.assertIn('pocket_tts/models/flow.py changed', message)
        (self.root / 'pocket_tts/models/flow.py').write_text('x = 1\n')
        self.assertIsNone(self.check())
        (self.root / 'pocket_tts/config/english.yaml').unlink()
        self.assertIn('pocket_tts/config/english.yaml missing', self.fails())
        (self.root / 'pocket_tts/config/english.yaml').write_text('a: 1\n')
        # A Python file outside the package is still code: a change there fails too.
        (self.root / 'training/train.py').write_text('y = 3\n')
        self.assertIn('training/train.py changed', self.fails())
        (self.root / 'training/train.py').unlink()
        self.assertIn('training/train.py missing', self.fails())

    def test_the_message_names_the_first_few_and_counts_the_rest(self):
        for rel in ('pocket_tts/__init__.py', 'pocket_tts/models/flow.py', 'pocket_tts/config/english.yaml', 'training/train.py'):
            (self.root / rel).unlink()
        (self.root / 'pocket_tts/models/flow.py').write_text('x = 9\n')
        message = self.fails()
        self.assertIn('pocket_tts/__init__.py missing', message)
        self.assertIn('pocket_tts/config/english.yaml missing', message)
        self.assertIn('pocket_tts/models/flow.py changed', message)
        self.assertIn('+1 more', message)
        self.assertNotIn('training/train.py', message)
        self.assertLessEqual(len(message), 300, 'fits in the reason the worker sends')

    def test_only_documentation_style_files_differing_does_not_stop_the_voice_but_is_logged(self):
        (self.root / 'README.md').write_text('# a different readme\n')
        (self.root / 'docs/guide.md').unlink()
        (self.root / '.gitignore').unlink()
        (self.root / 'uv.lock').write_text('another lock\n')
        note = self.check()
        for expected in ('README.md changed', 'docs/guide.md missing', '.gitignore missing'):
            self.assertIn(expected, note)
        self.assertNotIn(str(self.root), note)

    def test_line_endings_converted_to_crlf_do_not_count_as_a_change(self):
        for rel in ('pocket_tts/models/flow.py', 'pocket_tts/config/english.yaml', 'README.md'):
            path = self.root / rel
            path.write_bytes(path.read_bytes().replace(b'\n', b'\r\n'))
        self.assertIsNone(self.check())
        (self.root / 'pocket_tts/models/flow.py').write_bytes(b'x = 2\r\n')
        self.assertIn('pocket_tts/models/flow.py changed', self.fails())

    def test_a_linked_pinned_file_is_refused_and_named(self):
        target = Path(self.temp.name) / 'elsewhere.py'
        target.write_bytes((self.root / 'pocket_tts/models/flow.py').read_bytes())
        (self.root / 'pocket_tts/models/flow.py').unlink()
        try:
            os.symlink(target, self.root / 'pocket_tts/models/flow.py')
        except (OSError, NotImplementedError):
            self.skipTest('symbolic links are not available here')
        self.assertIn('pocket_tts/models/flow.py linked', self.fails())

    def test_a_manifest_that_is_not_the_pinned_one_is_refused(self):
        with patch.dict(runtime.SOURCE_FILES, {'pocket_tts/extra.py': 'a' * 64}):
            with self.assertRaisesRegex(ValueError, 'does not match its pinned digest'):
                runtime.verify_source(self.root)


class Assets(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pocket-runtime-test-')
        self.root = Path(self.temp.name)
        self.source, self.export, self.refs, self.work = [self.root / key for key in ('source','export','refs','work')]
        for path in (self.source,self.export,self.refs):
            path.mkdir()
        (self.source / 'pocket_tts').mkdir()
        (self.source / 'pocket_tts/__init__.py').write_text('# source fixture\n')
        (self.export / 'model.safetensors').write_bytes(b'not a neural model; fixture identity only')
        (self.export / 'tokenizer.json').write_text('{}')
        self.inference = {'weights_path':'model.safetensors','weights_path_without_voice_cloning':None,
                          'flow_lm':{'dtype':'float32','transformer':{'num_layers':6},'lookup_table':{'tokenizer_path':'tokenizer.json'}},
                          'mimi':{'dtype':'float32','sample_rate':24000,'channels':1}}
        (self.export / 'inference.yaml').write_text(json.dumps(self.inference))
        self.receipt = {'selected_step':1500,'weights':'ema','sample_cfg':1.,'source_revision':runtime.SOURCE_REVISION,
                        'input_identity':'e'*64,'model_sha256':runtime.digest_file(self.export/'model.safetensors')}
        (self.export / 'receipt.json').write_text(json.dumps(self.receipt))
        self.model = {field:runtime.digest_file(self.export/name) for name,field in runtime.ASSETS.items()}
        self.model.update(inputIdentity='e'*64,selectedStep=1500)
        self.voices = {}
        for key in ('johnny-silverhand','judy-alvarez','panam-palmer'):
            path=self.refs/f'{key}.wav';wav(path)
            self.voices[key]={'reference':f'runtime/voice-references/{key}.wav','sha256':runtime.digest_file(path),
                              'transcript':'Original native dialogue.'}
        self.config={'version':1,'provider':'pocket','engine':'pocket-tts',
                     'runtime':{'sourceDirectory':str(self.source),'exportDirectory':str(self.export),
                                'referenceDirectory':str(self.refs),'workDirectory':str(self.work)},
                     'model':self.model,'voices':self.voices,'cpu':{'threads':2},
                     'preparation':{'startupProfiles':[],'maxCachedProfiles':2}}

    def tearDown(self):
        self.temp.cleanup()

    def validate(self, config=None):
        return runtime.validate_config(config or self.config, yaml_load=json.loads,
                                       source_hasher=lambda _:runtime.SOURCE_SHA256)

    def test_the_shipped_source_check_names_what_differs_in_the_error(self):
        # No test seam: the real pinned list against a fixture tree that is not the pinned revision.
        with self.assertRaises(ValueError) as caught:
            runtime.validate_config(self.config, yaml_load=json.loads)
        message = str(caught.exception)
        self.assertTrue(message.startswith('Pocket source differs from the pinned official revision ('), message)
        self.assertIn('pocket_tts/__init__.py changed', message)
        self.assertNotIn(str(self.source), message)

    def test_selected_student_uses_copied_local_paths_without_mutating_original_assets(self):
        before={name:(self.export/name).read_bytes() for name in runtime.ASSETS}
        registry=self.validate()
        self.assertEqual(registry['inference']['weights_path'],str(self.export/'model.safetensors'))
        self.assertEqual(registry['inference']['flow_lm']['lookup_table']['tokenizer_path'],str(self.export/'tokenizer.json'))
        self.assertEqual(registry['threads'],2)
        self.assertEqual({name:(self.export/name).read_bytes() for name in runtime.ASSETS},before)
        self.assertFalse(self.work.exists(),'verification does not create a work directory or load a model')

    def test_the_vortex_marker_file_is_not_part_of_the_source_but_any_other_added_or_changed_file_is(self):
        # Vortex puts a marker file into every folder it creates in the game folder; the source digest must not count it
        # (a 0.2.2 report: "Pocket source differs from the pinned official revision" on a Vortex install).
        clean = runtime.digest_source(self.source)
        (self.source / '__folder_managed_by_vortex').write_text('')
        (self.source / 'pocket_tts' / '__folder_managed_by_vortex').write_text('')
        # What Windows Explorer or a zip made on a Mac leaves behind is not source either.
        for name in ('desktop.ini', 'Thumbs.db', '.DS_Store'):
            (self.source / name).write_text('')
            (self.source / 'pocket_tts' / name).write_text('')
        self.assertEqual(runtime.digest_source(self.source), clean)
        (self.source / 'pocket_tts' / 'extra.py').write_text('# not in the pinned revision\n')
        self.assertNotEqual(runtime.digest_source(self.source), clean)
        (self.source / 'pocket_tts' / 'extra.py').unlink()
        self.assertEqual(runtime.digest_source(self.source), clean)
        (self.source / 'pocket_tts/__init__.py').write_text('# changed\n')
        self.assertNotEqual(runtime.digest_source(self.source), clean)

    def test_a_registry_may_hold_1024_voices_with_variant_keys_prepared_only_on_first_use(self):
        many=copy.deepcopy(self.config)
        many['voices'].update({f'npc-kind-{index}':{'status':'unprepared'} for index in range(1021)})
        many['voices'].update({'judy-alvarez-v2':self.voices['judy-alvarez']})
        self.assertEqual(len(many['voices']),1025)
        with self.assertRaisesRegex(ValueError,'Invalid Pocket voice registry'):
            self.validate(many)
        del many['voices']['npc-kind-0']
        registry=self.validate(many)
        self.assertEqual(len(many['voices']),1024)
        self.assertIn('judy-alvarez-v2',registry['refs'])
        self.assertEqual(registry['startup'],[],'variants and the rest of the cast are prepared on first use, never at startup')

    def test_modified_weight_config_tokenizer_or_receipt_is_rejected(self):
        for name in runtime.ASSETS:
            with self.subTest(name=name):
                path=self.export/name;before=path.read_bytes();path.write_bytes(before+b'changed')
                with self.assertRaisesRegex(ValueError,'selected identity'):
                    self.validate()
                path.write_bytes(before)

    def test_an_explicitly_selected_raw_student_export_is_accepted(self):
        receipt={**self.receipt,'weights':'raw'};(self.export/'receipt.json').write_text(json.dumps(receipt))
        accepted=copy.deepcopy(self.config);accepted['model']['receiptSha256']=runtime.digest_file(self.export/'receipt.json')
        self.validate(accepted)
        (self.export/'receipt.json').write_text(json.dumps(self.receipt))

    def test_teacher_or_wrong_training_identity_is_rejected_even_with_matching_file_hash(self):
        for field,value in [('selected_step',250),('weights','teacher'),('sample_cfg',2.),('input_identity','f'*64)]:
            receipt={**self.receipt,field:value};(self.export/'receipt.json').write_text(json.dumps(receipt))
            altered=copy.deepcopy(self.config);altered['model']['receiptSha256']=runtime.digest_file(self.export/'receipt.json')
            with self.assertRaisesRegex(ValueError,'selected student export'):
                self.validate(altered)
        (self.export/'receipt.json').write_text(json.dumps(self.receipt))
        altered=copy.deepcopy(self.inference);altered['flow_lm']['transformer']['num_layers']=24
        (self.export/'inference.yaml').write_text(json.dumps(altered));self.config['model']['configSha256']=runtime.digest_file(self.export/'inference.yaml')
        with self.assertRaisesRegex(ValueError,'six-layer student'):
            self.validate()

    def test_reference_cache_reuses_exact_prompt_and_evicts_before_another_model_is_needed(self):
        registry=self.validate();encoded=[]
        cache=runtime.ReferenceCache(registry,lambda path:encoded.append(path) or {'prompt':path.name})
        johnny,_=cache.prepare('johnny-silverhand');again,ms=cache.prepare('johnny-silverhand')
        self.assertIs(johnny,again);self.assertEqual(ms,0);self.assertEqual(len(encoded),1)
        cache.prepare('judy-alvarez');cache.prepare('panam-palmer')
        self.assertEqual(cache.prepared(),['judy-alvarez','panam-palmer'])
        self.assertEqual(len(encoded),3)

    def prepared_store(self, directory=None, model='m'*64, saved=None, loaded=None):
        """A store whose file format is JSON, so the tests need no tensor library."""
        def save_state(path, state, identity):
            if saved is not None:
                saved.append(path.name)
            Path(path).write_text(json.dumps({'identity': identity, 'state': state}))
        def load_state(path, identity):
            if loaded is not None:
                loaded.append(path.name)
            value = json.loads(Path(path).read_text())
            return value['state'] if value['identity'] == identity else None
        return runtime.PreparedVoiceStore(directory or self.work/'prepared-voices', model, runtime.SOURCE_SHA256,
                                          save_state, load_state)

    def test_saved_voice_setup_is_written_once_and_replaces_encoding_on_the_next_start(self):
        registry=self.validate();encoded=[];saved=[];loaded=[]
        store=self.prepared_store(saved=saved,loaded=loaded)
        first=runtime.ReferenceCache(registry,lambda path:encoded.append(path) or {'prompt':path.name},store=store)
        state,_=first.prepare('judy-alvarez',keep=True)
        self.assertEqual(first.last_source,'computed');self.assertEqual(len(saved),1);self.assertEqual(len(encoded),1)
        self.assertTrue(saved[0].startswith('judy-alvarez-') and saved[0].endswith('.safetensors.tmp'))
        _,ms=first.prepare('judy-alvarez',keep=True)
        self.assertEqual((first.last_source,ms),('memory',0.0))
        # A new worker (a restart, or re-summoning after the memory cache evicted the voice) loads it from disk.
        second=runtime.ReferenceCache(registry,lambda path:self.fail('must not encode again'),store=store)
        again,_=second.prepare('judy-alvarez',keep=True)
        self.assertEqual(second.last_source,'disk');self.assertEqual(again,state);self.assertEqual(len(saved),1)

    def test_with_the_setting_off_nothing_is_read_or_written(self):
        registry=self.validate();saved=[];loaded=[]
        store=self.prepared_store(saved=saved,loaded=loaded)
        cache=runtime.ReferenceCache(registry,lambda path:{'prompt':path.name},store=store)
        cache.prepare('judy-alvarez');self.assertEqual(cache.last_source,'computed')
        self.assertEqual((saved,loaded),([],[]));self.assertFalse((self.work/'prepared-voices').exists())
        # An existing saved setup is ignored too.
        runtime.ReferenceCache(registry,lambda path:{'prompt':'x'},store=store).prepare('judy-alvarez',keep=True)
        fresh=runtime.ReferenceCache(registry,lambda path:{'prompt':path.name},store=store)
        fresh.prepare('judy-alvarez',keep=False);self.assertEqual(fresh.last_source,'computed');self.assertEqual(loaded,[])

    def test_saved_setup_is_keyed_by_reference_model_and_voice(self):
        registry=self.validate();store=self.prepared_store()
        key=lambda voice,ref='r'*64,model='m'*64:self.prepared_store(model=model).path(voice,ref).name
        names={key('judy-alvarez'),key('judy-alvarez','s'*64),key('judy-alvarez',model='n'*64),key('panam-palmer')}
        self.assertEqual(len(names),4)
        # A changed reference file (new hash) is a miss, and saving it removes the old file of that voice only.
        cache=runtime.ReferenceCache(registry,lambda path:{'prompt':path.name},store=store)
        cache.prepare('judy-alvarez',keep=True);cache.prepare('panam-palmer',keep=True)
        old=store.path('judy-alvarez',registry['descriptors']['judy-alvarez']['sha256'])
        self.assertTrue(old.is_file())
        self.assertTrue(store.save('judy-alvarez','z'*64,{'prompt':'new'}))
        self.assertFalse(old.is_file());self.assertTrue(store.path('judy-alvarez','z'*64).is_file())
        self.assertTrue(store.path('panam-palmer',registry['descriptors']['panam-palmer']['sha256']).is_file())

    def test_damaged_or_foreign_saved_setup_is_a_miss_that_is_replaced(self):
        registry=self.validate();store=self.prepared_store()
        sha=registry['descriptors']['judy-alvarez']['sha256']
        runtime.ReferenceCache(registry,lambda path:{'prompt':'old'},store=store).prepare('judy-alvarez',keep=True)
        file=store.path('judy-alvarez',sha);file.write_bytes(b'garbage, not a saved state')
        encoded=[]
        cache=runtime.ReferenceCache(registry,lambda path:encoded.append(1) or {'prompt':'new'},store=store)
        state,_=cache.prepare('judy-alvarez',keep=True)
        self.assertEqual((cache.last_source,state,len(encoded)),('computed',{'prompt':'new'},1))
        self.assertEqual(store.load('judy-alvarez',sha),{'prompt':'new'})
        # A file whose header names another identity is not used either.
        other=self.prepared_store(model='n'*64)
        self.assertIsNone(other.load('judy-alvarez',sha))

    def test_a_failing_disk_never_breaks_preparation_and_clear_removes_every_file(self):
        registry=self.validate()
        def refuse(*_):raise OSError('disk full')
        broken=runtime.PreparedVoiceStore(self.work/'prepared-voices','m'*64,runtime.SOURCE_SHA256,refuse,refuse)
        cache=runtime.ReferenceCache(registry,lambda path:{'prompt':'x'},store=broken)
        state,_=cache.prepare('judy-alvarez',keep=True);self.assertEqual(state,{'prompt':'x'})
        self.assertEqual(list((self.work/'prepared-voices').glob('*')),[])
        store=self.prepared_store();ok=runtime.ReferenceCache(registry,lambda path:{'prompt':'x'},store=store)
        ok.prepare('judy-alvarez',keep=True);ok.prepare('panam-palmer',keep=True)
        self.assertEqual(store.clear(),2);self.assertEqual(list((self.work/'prepared-voices').glob('*')),[])

    def test_saved_setups_are_limited_to_the_newest_files(self):
        store=self.prepared_store();store.max_files=3
        for index in range(5):
            store.save(f'voice-{index}','r'*64,{'n':index});os.utime(store.path(f'voice-{index}','r'*64),(index,index))
            store.prune(keep=store.path(f'voice-{index}','r'*64))
        self.assertEqual(len(list((self.work/'prepared-voices').glob('*.safetensors'))),3)

    def test_changed_reference_invalidates_a_cached_state_and_withdraws_only_that_character(self):
        registry=self.validate();cache=runtime.ReferenceCache(registry,lambda path:object())
        cache.prepare('johnny-silverhand');cache.prepare('judy-alvarez')
        wav(self.refs/'johnny-silverhand.wav',2401)
        with self.assertRaisesRegex(ValueError,'identity changed'):
            cache.prepare('johnny-silverhand')
        self.assertNotIn('johnny-silverhand',cache.prepared());self.assertNotIn('johnny-silverhand',registry['refs'])
        self.assertIn('judy-alvarez',registry['refs'])

    def test_bad_descriptor_never_chooses_an_external_reference(self):
        for reference in ('runtime/voice-references/../../private.wav','runtime/voice-references/a\\b.wav','http://private.wav'):
            altered=copy.deepcopy(self.config);altered['voices']['johnny-silverhand']['reference']=reference
            with self.assertRaisesRegex(ValueError,'reference descriptor'):
                self.validate(altered)

    # ---- the player's own reference clips (runtime/player-voices/<key>.wav, resolved only inside runtime.playerVoiceDirectory) ----

    def player_config(self, key='johnny-silverhand', seconds=.3):
        """A configuration whose voice `key` is the player's own clip, kept in a folder of the player's data beside the shipped assets."""
        self.player = self.root / 'player-data' / 'player-voices'
        path = self.player / f'{key}.wav'
        tone(path, seconds)
        config = copy.deepcopy(self.config)
        config['runtime']['playerVoiceDirectory'] = str(self.player)
        config['voices'][key] = {'reference': f'runtime/player-voices/{key}.wav', 'sha256': runtime.digest_file(path),
                                 'transcript': 'The player typed this.'}
        return config, path

    def test_descriptor_accepts_the_player_prefix_only_in_its_one_fixed_shape(self):
        sha = 'a' * 64
        for reference in ('runtime/player-voices/sam-hill.wav', 'runtime/player-voices/a.wav', f'runtime/player-voices/{"a" * 80}.wav',
                          'runtime/voice-references/picked/x.wav'):
            with self.subTest(reference=reference):
                self.assertTrue(runtime.descriptor_valid({'reference': reference, 'sha256': sha, 'transcript': 'A line.'}))
        for reference in ('runtime/player-voices/../sam.wav', 'runtime/player-voices/a/b.wav', 'runtime/player-voices\\sam.wav',
                          'runtime/player-voices/Sam.wav', 'runtime/player-voices/.wav', 'runtime/player-voices/-sam.wav',
                          'runtime/player-voices//sam.wav', 'runtime/player-voices/sam.wav:stream', 'runtime/player-voices/sam.mp3',
                          f'runtime/player-voices/{"a" * 81}.wav', 'runtime/other-voices/sam.wav', '/runtime/player-voices/sam.wav',
                          'player-voices/sam.wav', 'runtime/player-voices', 'runtime/player-voices/', 'runtime/player-voices/sam.wav\n'):
            with self.subTest(reference=reference):
                self.assertFalse(runtime.descriptor_valid({'reference': reference, 'sha256': sha, 'transcript': 'A line.'}))

    def test_player_reference_resolves_inside_the_player_folder_through_both_lookups(self):
        config, clip = self.player_config()
        registry = self.validate(config)
        self.assertEqual(registry['refs']['johnny-silverhand'], clip.resolve())
        self.assertEqual(registry['refs']['judy-alvarez'], (self.refs / 'judy-alvarez.wav').resolve(), 'a shipped voice still resolves in the shipped folder')
        self.assertEqual(registry['paths']['playerVoiceDirectory'], self.player.resolve())
        self.assertEqual(registry['unavailable'], {})
        self.assertFalse(self.work.exists(), 'checking the clip creates and writes nothing')
        # The later lookup (a voice is prepared when its character speaks) uses the same resolver and the same folder.
        encoded = []
        cache = runtime.ReferenceCache(registry, lambda path: encoded.append(path) or {'prompt': path.name})
        cache.prepare('johnny-silverhand')
        self.assertEqual(encoded, [clip.resolve()])
        # A clip edited after the check is a changed identity: only that voice is withdrawn.
        cache.prepare('judy-alvarez')
        tone(clip, .4)
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            cache.prepare('johnny-silverhand')
        self.assertNotIn('johnny-silverhand', registry['refs'])
        self.assertEqual(registry['unavailable']['johnny-silverhand'], 'unavailable')
        self.assertIn('judy-alvarez', registry['refs'])

    def test_player_voice_is_no_startup_profile_unless_named_and_a_named_unavailable_one_is_no_config_error(self):
        config, _ = self.player_config()
        config['preparation']['startupProfiles'] = ['judy-alvarez']
        self.assertEqual(self.validate(config)['startup'], ['judy-alvarez'])
        config['runtime']['playerVoiceDirectory'] = str(self.root / 'never-made')
        config['preparation']['startupProfiles'] = ['johnny-silverhand', 'judy-alvarez']
        registry = self.validate(config)
        self.assertEqual(registry['startup'], ['judy-alvarez'])
        self.assertFalse((self.root / 'never-made').exists())

    def test_player_reference_without_a_folder_or_with_a_missing_folder_or_file_is_unavailable_not_a_config_error(self):
        config, clip = self.player_config()
        del config['runtime']['playerVoiceDirectory']
        registry = self.validate(config)
        self.assertEqual(registry['unavailable'], {'johnny-silverhand': 'unavailable'})
        self.assertNotIn('johnny-silverhand', registry['refs'])
        self.assertEqual(set(registry['refs']), {'judy-alvarez', 'panam-palmer'})
        self.assertNotIn('playerVoiceDirectory', registry['paths'])
        config['runtime']['playerVoiceDirectory'] = None
        self.assertEqual(self.validate(config)['unavailable'], {'johnny-silverhand': 'unavailable'}, 'a null folder is no folder')
        config['runtime']['playerVoiceDirectory'] = str(self.root / 'never-made')
        self.assertEqual(self.validate(config)['unavailable'], {'johnny-silverhand': 'unavailable'})
        self.assertFalse((self.root / 'never-made').exists(), 'a missing folder is not created')
        config['runtime']['playerVoiceDirectory'] = str(self.player)
        clip.unlink()
        self.assertEqual(self.validate(config)['unavailable'], {'johnny-silverhand': 'unavailable'})

    def test_player_reference_never_resolves_through_the_shipped_folder_and_the_reverse(self):
        config, clip = self.player_config()
        clip.unlink()   # the same name exists in the shipped folder, with other bytes: the player reference must not find it
        self.assertTrue((self.refs / 'johnny-silverhand.wav').is_file())
        self.assertEqual(self.validate(config)['unavailable'], {'johnny-silverhand': 'unavailable'})
        # And a shipped descriptor is not resolved inside the player folder.
        tone(self.player / 'only-here.wav')
        config['voices']['johnny-silverhand'] = {'reference': 'runtime/voice-references/only-here.wav',
                                                 'sha256': runtime.digest_file(self.player / 'only-here.wav'), 'transcript': 'Shipped.'}
        self.assertEqual(self.validate(config)['unavailable'], {'johnny-silverhand': 'unavailable'})

    def test_player_reference_that_escapes_is_a_config_error_and_a_link_or_a_bad_clip_withdraws_only_that_profile(self):
        config, clip = self.player_config()
        for reference in ('runtime/player-voices/../escape.wav', 'runtime/player-voices/sub/johnny-silverhand.wav',
                          'runtime/player-voices\\johnny-silverhand.wav', 'runtime/player-voices/JOHNNY.wav',
                          'runtime/player-voices/johnny-silverhand.wav:stream', 'runtime/other/johnny-silverhand.wav'):
            with self.subTest(reference=reference):
                altered = copy.deepcopy(config)
                altered['voices']['johnny-silverhand']['reference'] = reference
                with self.assertRaisesRegex(ValueError, 'reference descriptor'):
                    self.validate(altered)
        # Not the recorded bytes.
        altered = copy.deepcopy(config)
        altered['voices']['johnny-silverhand']['sha256'] = 'b' * 64
        self.assertEqual(self.validate(altered)['unavailable'], {'johnny-silverhand': 'unavailable'})
        # A link in the clip's place (a junction or symlink); no link is made, the check is told there is one.
        real = Path.is_symlink
        with patch.object(Path, 'is_symlink', lambda path: path.name == 'johnny-silverhand.wav' or real(path)):
            registry = self.validate(config)
        self.assertEqual(registry['unavailable'], {'johnny-silverhand': 'unavailable'})
        self.assertIn('judy-alvarez', registry['refs'])
        # A clip that is not a usable WAV is unavailable too.
        clip.write_bytes(b'not a wav at all' * 4)
        altered = copy.deepcopy(config)
        altered['voices']['johnny-silverhand']['sha256'] = runtime.digest_file(clip)
        self.assertEqual(self.validate(altered)['unavailable'], {'johnny-silverhand': 'unavailable'})

    def test_player_folder_must_be_plain_and_apart_from_the_work_folder_and_every_shipped_asset(self):
        config, _ = self.player_config()
        for place in (self.work, self.work / 'player-voices', self.root, self.source / 'x', self.export / 'x', self.export, self.refs, self.refs / 'x'):
            with self.subTest(place=str(place)):
                altered = copy.deepcopy(config)
                altered['runtime']['playerVoiceDirectory'] = str(place)
                with self.assertRaisesRegex(ValueError, 'separate'):
                    self.validate(altered)
        for value in ('player-voices', '', 5, ' ' + str(self.player), str(self.player) + '\n'):
            with self.subTest(value=value):
                altered = copy.deepcopy(config)
                altered['runtime']['playerVoiceDirectory'] = value
                with self.assertRaisesRegex(ValueError, 'absolute'):
                    self.validate(altered)
        real = Path.is_symlink
        with patch.object(Path, 'is_symlink', lambda path: path == self.player or real(path)):
            with self.assertRaisesRegex(ValueError, 'linked'):
                self.validate(config)
        self.validate(config)   # unchanged afterwards

    # ---- voices changed while the worker runs (a clip given to a character or taken away: no restart, no reload of the model) ----

    class Store:
        """A stand-in for PreparedVoiceStore that remembers which saved setups were forgotten."""
        def __init__(self):
            self.forgotten = []

        def forget(self, key, sha):
            self.forgotten.append((key, sha))

    def running(self):
        registry = self.validate()
        encoded, store = [], self.Store()
        cache = runtime.ReferenceCache(registry, lambda path: encoded.append(path) or {'prompt': path.name}, store=store)
        return registry, cache, encoded, store

    def player_clip(self, key='johnny-silverhand', seconds=.3):
        self.player = self.root / 'player-data' / 'player-voices'
        path = self.player / f'{key}.wav'
        tone(path, seconds)
        return path, {'reference': f'runtime/player-voices/{key}.wav', 'sha256': runtime.digest_file(path), 'transcript': 'The player typed this.'}

    def test_a_voice_changes_while_running_and_only_that_character_loses_its_prepared_state(self):
        registry, cache, encoded, store = self.running()
        clip, descriptor = self.player_clip()
        cache.prepare('johnny-silverhand'); cache.prepare('judy-alvarez')
        shipped_sha = registry['descriptors']['johnny-silverhand']['sha256']
        changed = runtime.apply_voices(registry, {'set': {'johnny-silverhand': descriptor}, 'playerVoiceDirectory': str(self.player)}, cache)
        self.assertEqual(changed, ['johnny-silverhand'])
        self.assertEqual(registry['refs']['johnny-silverhand'], clip.resolve())
        self.assertEqual(registry['descriptors']['johnny-silverhand']['sha256'], descriptor['sha256'])
        self.assertEqual(registry['paths']['playerVoiceDirectory'], self.player.resolve())
        self.assertEqual(cache.prepared(), ['judy-alvarez'], 'the other characters keep what was prepared for them')
        self.assertEqual(store.forgotten, [], 'a shipped reference\'s saved setup is not a player clip\'s to delete')
        cache.prepare('johnny-silverhand')
        self.assertEqual(encoded[-1], clip.resolve(), 'the next reply is prepared from the new clip')
        # Taking it away: the shipped descriptor comes back, the player clip's prepared state and saved setup go.
        changed = runtime.apply_voices(registry, {'set': {'johnny-silverhand': {'reference': 'runtime/voice-references/johnny-silverhand.wav',
                                                                                  'sha256': shipped_sha, 'transcript': 'Original native dialogue.'}}}, cache)
        self.assertEqual(changed, ['johnny-silverhand'])
        self.assertEqual(store.forgotten, [('johnny-silverhand', descriptor['sha256'])])
        self.assertEqual(cache.prepared(), ['judy-alvarez'])
        cache.prepare('johnny-silverhand')
        self.assertEqual(encoded[-1], (self.refs / 'johnny-silverhand.wav').resolve())

    def test_a_character_with_no_voice_gets_one_and_a_removed_voice_is_gone_everywhere(self):
        registry, cache, encoded, store = self.running()
        clip, descriptor = self.player_clip('custom-rebecca-abcd')
        runtime.apply_voices(registry, {'set': {'custom-rebecca-abcd': descriptor}, 'playerVoiceDirectory': str(self.player)}, cache)
        self.assertIn('custom-rebecca-abcd', registry['refs'])
        cache.prepare('custom-rebecca-abcd')
        self.assertEqual(encoded[-1], clip.resolve())
        changed = runtime.apply_voices(registry, {'remove': ['custom-rebecca-abcd', 'never-had-it']}, cache)
        self.assertEqual(changed, ['custom-rebecca-abcd'], 'a key that was never there is not reported')
        for table in ('refs', 'descriptors', 'unavailable'):
            self.assertNotIn('custom-rebecca-abcd', registry[table])
        self.assertEqual(cache.prepared(), [])
        self.assertEqual(store.forgotten, [('custom-rebecca-abcd', descriptor['sha256'])])
        with self.assertRaisesRegex(ValueError, 'no available Pocket voice'):
            cache.prepare('custom-rebecca-abcd')
        self.assertIn('judy-alvarez', registry['refs'])

    def test_a_refused_voice_change_changes_nothing_and_a_missing_clip_withdraws_only_that_voice(self):
        registry, cache, encoded, store = self.running()
        clip, descriptor = self.player_clip()
        before = copy.deepcopy({field: registry[field] for field in ('refs', 'descriptors', 'unavailable', 'startup')})
        cache.prepare('judy-alvarez')
        for number, change in enumerate((
                {'set': {'johnny-silverhand': descriptor, 'judy-alvarez': {'reference': 'runtime/player-voices/../x.wav', 'sha256': 'a' * 64, 'transcript': 'x'}},
                 'playerVoiceDirectory': str(self.player)},
                {'set': {'Not A Key': descriptor}},
                {'set': {'johnny-silverhand': descriptor}, 'remove': ['johnny-silverhand']},
                {'set': {f'k-{at}': {'status': 'unprepared'} for at in range(runtime.MAX_VOICE_CHANGES + 1)}},
                {'set': {'johnny-silverhand': descriptor}, 'playerVoiceDirectory': str(self.work / 'inside')},
                {'set': {'johnny-silverhand': descriptor}, 'playerVoiceDirectory': 'relative'},
                {'set': []}, 'nothing'), 1):
            with self.subTest(change=number), self.assertRaises(ValueError):
                runtime.apply_voices(registry, change, cache)
            self.assertEqual({field: registry[field] for field in before}, before)
        self.assertEqual(cache.prepared(), ['judy-alvarez'], 'a refused change drops nothing')
        self.assertNotIn('playerVoiceDirectory', registry['paths'])
        # The clip is not the recorded bytes: the change is accepted, that one voice is withdrawn, the rest are as they were.
        clip.write_bytes(clip.read_bytes()[:-2] + b'\x11\x22')
        changed = runtime.apply_voices(registry, {'set': {'johnny-silverhand': descriptor}, 'playerVoiceDirectory': str(self.player)}, cache)
        self.assertEqual(changed, ['johnny-silverhand'])
        self.assertEqual(registry['unavailable'], {'johnny-silverhand': 'unavailable'})
        self.assertNotIn('johnny-silverhand', registry['refs'])
        self.assertIn('judy-alvarez', registry['refs'])
        # The folder cannot be moved while the worker runs, and a status-only voice needs no file.
        with self.assertRaisesRegex(ValueError, 'cannot change'):
            runtime.apply_voices(registry, {'playerVoiceDirectory': str(self.root / 'other-player-data')}, cache)
        runtime.apply_voices(registry, {'set': {'npc-kind-1': {'status': 'unprepared'}}}, cache)
        self.assertEqual(registry['unavailable']['npc-kind-1'], 'unprepared')

    def test_the_command_reader_queues_a_voice_change_like_any_serial_command_and_still_refuses_unknown_ones(self):
        pipe = Pipe()
        commands = worker.Commands(pipe, 'a' * 32)
        commands.thread.start()
        pipe.send({'owner': 'a' * 32, 'op': 'voices', 'id': 1, 'set': {}, 'remove': []})
        self.assertEqual(commands.queue.get(timeout=2)['op'], 'voices')
        commands.begin(1)
        commands.finish(1)
        pipe.send({'owner': 'a' * 32, 'op': 'reload', 'id': 2})
        commands.thread.join(timeout=2)
        self.assertIsInstance(commands.error, ValueError)
        self.assertIn('Unknown Pocket command', str(commands.error))

    def test_model_source_work_and_reference_paths_are_explicit_and_separate(self):
        with self.assertRaisesRegex(ValueError,'pinned official'):
            runtime.validate_config(self.config,yaml_load=json.loads,source_hasher=lambda _:'f'*64)
        for key,value in [('sourceDirectory','source'),('workDirectory',str(self.export/'scratch'))]:
            altered=copy.deepcopy(self.config);altered['runtime'][key]=value
            with self.assertRaises(ValueError):
                self.validate(altered)

    def test_no_torch_or_pocket_imported_for_asset_and_protocol_validation(self):
        self.validate()
        self.assertNotIn('torch',sys.modules)
        self.assertNotIn('pocket_tts',sys.modules)


class UsvfsPaths(unittest.TestCase):
    """Inside Mod Organizer 2's virtual file system (USVFS) Path.resolve() of a file answers with the mod folder that holds it, which is not where
    resolve() of its folder points when the folder is the merge of several mods. USVFS does not exist here, so it is simulated: the files are plain
    files at their virtual place, and Path.resolve() is patched to answer as USVFS does (a folder of the app in mods/A, each file below it in mods/B).
    The decision logic is what is tested: the flag plus a path that is spelled inside its folder is accepted, a link never is, and nothing changes
    without the flag."""
    setUp = Assets.setUp
    tearDown = Assets.tearDown
    validate = Assets.validate

    def usvfs_resolve(self):
        real = Path.resolve
        merged = [real(self.export), real(self.refs)]
        mods = real(self.root) / 'mods'

        def resolve(path, strict=False):
            found = real(path, strict=strict)
            for folder in merged:
                if found == folder:
                    return mods / 'A' / folder.name
                if found.is_relative_to(folder):
                    return mods / 'B' / folder.name / found.relative_to(folder)
            return found
        return patch.object(Path, 'resolve', resolve)

    def inside_usvfs(self, value='1'):
        return patch.dict(os.environ, {runtime.USVFS_VARIABLE: value})

    def test_the_simulation_shows_the_bug_without_the_flag(self):
        with self.usvfs_resolve():
            for value in (None, '0', 'yes', ''):
                with self.subTest(flag=value):
                    environment = {} if value is None else {runtime.USVFS_VARIABLE: value}
                    with patch.dict(os.environ, environment), self.assertRaisesRegex(ValueError, 'missing or linked'):
                        runtime.local_asset(self.export, 'model.safetensors')

    def test_the_export_and_the_references_validate_inside_usvfs_and_nothing_is_resolved(self):
        with self.usvfs_resolve(), self.inside_usvfs():
            registry = self.validate()
        self.assertEqual(registry['paths']['exportDirectory'], self.export)
        self.assertEqual(registry['paths']['referenceDirectory'], self.refs)
        self.assertEqual(registry['inference']['weights_path'], str(self.export / 'model.safetensors'))
        self.assertEqual(sorted(registry['refs']), sorted(self.voices), 'every reference is found at its virtual place')
        self.assertEqual(registry['unavailable'], {})

    def test_inside_usvfs_the_bytes_are_still_checked_against_their_identity(self):
        with self.usvfs_resolve(), self.inside_usvfs():
            (self.export / 'model.safetensors').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'selected identity'):
                self.validate()
            (self.export / 'model.safetensors').write_bytes(b'not a neural model; fixture identity only')
            (self.refs / 'johnny-silverhand.wav').write_bytes(b'changed')
            registry = self.validate()
        self.assertEqual(registry['unavailable'], {'johnny-silverhand': 'unavailable'}, 'a changed reference withdraws that voice')
        self.assertNotIn('johnny-silverhand', registry['refs'])

    def test_inside_usvfs_the_pinned_source_check_still_reads_the_files(self):
        with self.usvfs_resolve(), self.inside_usvfs():
            with self.assertRaisesRegex(ValueError, 'pinned official revision'):
                runtime.validate_config(self.config, yaml_load=json.loads)

    def test_a_link_is_refused_inside_usvfs_as_it_is_outside(self):
        real = Path.is_symlink
        with self.usvfs_resolve(), self.inside_usvfs():
            with patch.object(Path, 'is_symlink', lambda path: path.name == 'model.safetensors' or real(path)):
                with self.assertRaisesRegex(ValueError, 'missing or linked'):
                    runtime.local_asset(self.export, 'model.safetensors')
            with patch.object(Path, 'is_symlink', lambda path: path == self.export or real(path)):
                with self.assertRaisesRegex(ValueError, 'linked'):
                    self.validate()
            with patch.object(Path, 'is_symlink', lambda path: path == self.refs.parent or real(path)):
                with self.assertRaisesRegex(ValueError, 'linked'):
                    self.validate()

    def test_a_real_symlink_planted_in_the_export_is_refused_inside_usvfs(self):
        outside = self.root / 'elsewhere.bin'
        outside.write_bytes(b'not the export')
        (self.export / 'receipt.json').unlink()
        try:
            os.symlink(outside, self.export / 'receipt.json')
        except (OSError, NotImplementedError):
            self.skipTest('symbolic links are not available here')
        with self.inside_usvfs(), self.assertRaisesRegex(ValueError, 'missing or linked'):
            self.validate()

    def test_without_usvfs_the_decisions_are_exactly_as_before(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(runtime.USVFS_VARIABLE, None)
            registry = self.validate()
        self.assertEqual(registry['paths']['exportDirectory'], self.export.resolve())
        self.assertEqual(registry['paths']['referenceDirectory'], self.refs.resolve())

    def test_spelled_containment_is_by_name_and_never_follows_dots(self):
        base = self.root / 'app'
        self.assertTrue(runtime.spelled_inside(base, base))
        self.assertTrue(runtime.spelled_inside(base / 'models' / 'pocket' / 'a.bin', base))
        self.assertFalse(runtime.spelled_inside(base / '..' / 'other' / 'a.bin', base))
        self.assertFalse(runtime.spelled_inside(base / 'models' / '..' / '..' / 'a.bin', base))
        self.assertFalse(runtime.spelled_inside(self.root / 'app-other' / 'a.bin', base), 'a sibling that starts with the same letters is not inside')
        self.assertTrue(runtime.spelled_inside(str(base).upper() + os.sep + 'X', str(base).lower()) or os.name != 'nt')


class Pipe:
    def __init__(self):
        self.lines=queue.Queue()

    def readline(self, _):
        return self.lines.get(timeout=2)

    def send(self, frame):
        self.lines.put(json.dumps(frame)+'\n')


class Producer(unittest.TestCase):
    def commands(self):
        pipe=Pipe();commands=worker.Commands(pipe,'a'*32);commands.thread.start()
        return pipe,commands

    def close(self, pipe, commands):
        pipe.lines.put('');commands.thread.join(2);self.assertFalse(commands.thread.is_alive())

    def test_reader_handles_ack_and_cancel_during_generation_and_eof_stops_owner(self):
        pipe,commands=self.commands()
        pipe.send({'owner':'a'*32,'op':'stream','id':1,'profile':'johnny-silverhand','text':'One full reply.'})
        request=commands.queue.get(timeout=1);commands.begin(request['id']);commands.expect_ack(1)
        pipe.send({'owner':'a'*32,'op':'ack','id':1,'index':1});commands.await_ack(1)
        pipe.send({'owner':'a'*32,'op':'cancel','id':1});self.assertTrue(commands.stop.wait(1))
        with self.assertRaises(worker.Cancelled):
            commands.check()
        self.close(pipe,commands);self.assertTrue(commands.shutdown.is_set())

    def test_actual_stream_path_emits_before_exhaustion_and_preserves_raw_pcm_and_offsets(self):
        class Model:
            def __init__(self):
                self.produced=0;self.finished=False;self.options=None
            def generate_audio_stream(self,state,text,**options):
                self.options=(state,text,options)
                try:
                    for values in ([.2,-.4,1.2],[.1,.3]):
                        self.produced+=1
                        yield values
                finally:
                    self.finished=True
        model=Model();commands=worker.Commands(io.StringIO(''),'a'*32);commands.begin(1);sent=[]
        def send(frame):
            self.assertFalse(model.finished,'a whole reply is not collected before publication')
            self.assertEqual(model.produced,len(sent)+1)
            sent.append(frame);commands.ack.set()
        def encode(values):
            return struct.pack('<'+'f'*len(values),*values),len(values)
        result=worker.stream_request(model,{'cached':'prompt'},'One full reply. Another sentence.',commands,send,1,'johnny-silverhand',encode)
        self.assertEqual(model.options[1],'One full reply. Another sentence.')
        self.assertTrue(model.options[2]['copy_state']);self.assertIs(model.options[2]['stop'],commands.stop)
        self.assertEqual([frame['offsetFrames'] for frame in sent],[0,3]);self.assertEqual(result['frames'],5)
        values=struct.unpack('<3f',base64.b64decode(sent[0]['pcm']));self.assertGreater(values[2],1)
        self.assertTrue(model.finished);self.assertGreaterEqual(result['firstPcmCopiedReadyMs'],result['firstPcmYieldMs'])

    def test_a_long_decoder_chunk_goes_out_as_ordered_packets_instead_of_ending_the_voice(self):
        # 0.2.4 reports: on a busy computer the decoder batches every queued latent frame into one chunk; five seconds of audio used to
        # raise "outside its frame limit", which retired the worker and left V silent for the session.
        frames_long=24000*5+300
        class Model:
            def generate_audio_stream(self,state,text,**options):
                yield [.1]*3
                yield 'long'
                yield [.2]*2
        commands=worker.Commands(io.StringIO(''),'a'*32);commands.begin(1);sent=[]
        def send(frame):
            sent.append(frame);commands.ack.set()
        def encode(values):
            count=frames_long if values=='long' else len(values)
            return struct.pack('<f',.5)*count,count
        result=worker.stream_request(Model(),{},'Reply.',commands,send,1,'johnny-silverhand',encode)
        self.assertEqual([frame['frames'] for frame in sent],[3,24000,24000,24000,24000,24000,300,2])
        self.assertEqual([frame['index'] for frame in sent],list(range(1,9)))
        offsets=[0];[offsets.append(offsets[-1]+frame['frames']) for frame in sent[:-1]]
        self.assertEqual([frame['offsetFrames'] for frame in sent],offsets)
        self.assertTrue(all(len(base64.b64decode(frame['pcm']))==frame['frames']*4 for frame in sent))
        self.assertTrue(all(frame['frames']<=worker.PACKET_FRAMES for frame in sent))
        self.assertEqual(result['frames'],3+frames_long+2);self.assertEqual(result['chunks'],8)
        # The same copied-ready clock on every packet of one chunk (the bridge refuses a clock that goes backwards, not an equal one).
        self.assertEqual({frame['copiedReadyMs'] for frame in sent[1:7]}.__len__(),1)

    def test_an_empty_or_over_the_reply_limit_chunk_is_still_refused(self):
        for count in (0,24000*worker.MAX_AUDIO_SECONDS+1):
            class Model:
                def generate_audio_stream(self,state,text,**options):
                    yield 'x'
            commands=worker.Commands(io.StringIO(''),'a'*32);commands.begin(1)
            with self.assertRaisesRegex(ValueError,'frame limit'):
                worker.stream_request(Model(),{},'Reply.',commands,lambda frame:commands.ack.set(),1,'johnny-silverhand',
                                      lambda values,count=count:(b'\0'*(count*4),count))

    def test_cancel_drains_native_decoder_to_eof_before_another_turn_can_reuse_model(self):
        events=[]
        class Model:
            def generate_audio_stream(self,state,text,**options):
                try:
                    yield [1.]
                    events.append('decoder drained')
                finally:
                    events.append('decoder joined')
        commands=worker.Commands(io.StringIO(''),'a'*32);commands.begin(1)
        def send(frame):
            commands.stop.set();commands.ack.set()
        with self.assertRaises(worker.Cancelled):
            worker.stream_request(Model(),{},'Reply.',commands,send,1,'johnny-silverhand',lambda values:(struct.pack('<f',1.),1))
        self.assertEqual(events,['decoder drained','decoder joined'])

    def test_cpu_environment_is_offline_thread_bounded_and_removes_secrets(self):
        environment=runtime.cpu_environment(2)
        self.assertEqual(environment['CUDA_VISIBLE_DEVICES'],'-1');self.assertEqual(environment['OMP_NUM_THREADS'],'2')
        self.assertEqual(environment['HF_HUB_OFFLINE'],'1')
        self.assertNotIn('HF_TOKEN',environment);self.assertNotIn('KAGGLE_API_TOKEN',environment)

    def test_raw_command_pipe_preserves_utf8_across_reads_and_bounds_incomplete_input(self):
        data='{"text":"Hey Judy — café 🙂"}\n'.encode('utf-8')
        pieces=iter([data[:17],data[17:21],data[21:24],data[24:],b''])
        pipe=worker.CommandPipe(lambda:next(pieces))
        self.assertEqual(pipe.readline(65537),data.decode('utf-8'))
        self.assertEqual(pipe.readline(65537),'')
        pieces=iter([b'x'*11,b''])
        with self.assertRaisesRegex(ValueError,'byte limit'):
            worker.CommandPipe(lambda:next(pieces)).readline(10)
        pieces=iter([b'\xff\n',b''])
        with self.assertRaises(UnicodeDecodeError):
            worker.CommandPipe(lambda:next(pieces)).readline(65537)

    def test_actual_os_pipe_receives_commands_and_early_eof_without_textio_reader(self):
        read_fd,write_fd=os.pipe()
        with os.fdopen(read_fd,'rb',buffering=0) as stream:
            commands=worker.Commands(worker.command_pipe(stream),'a'*32)
            commands.thread.start()
            try:
                raw=json.dumps({'owner':'a'*32,'op':'prepare','id':1,'profile':'judy-alvarez'}).encode()+b'\n'
                os.write(write_fd,raw)
                self.assertEqual(commands.queue.get(timeout=1)['profile'],'judy-alvarez')
                os.close(write_fd);write_fd=None
                self.assertTrue(commands.shutdown.wait(1))
                commands.thread.join(1);self.assertFalse(commands.thread.is_alive())
                self.assertIsNone(commands.error)
            finally:
                if write_fd is not None:
                    os.close(write_fd)


class Priority(unittest.TestCase):
    """A reply being voiced runs at normal priority; the worker is below normal while it waits."""

    def gate(self, hold=3.0, raises=True):
        self.now = 100.0
        self.calls = []
        def up():
            self.calls.append('normal')
            return raises
        def down():
            self.calls.append('below')
            return True
        return worker.PriorityGate(raise_to=up, lower_to=down, hold=hold, clock=lambda: self.now)

    def test_a_request_raises_once_and_the_hold_lowers_it_after_the_last_one(self):
        gate = self.gate()
        gate.request(); self.now += 1.2; gate.request(); gate.request()
        self.assertEqual(self.calls, ['normal'])
        self.now += 2.9; gate.settle()
        self.assertEqual(self.calls, ['normal'], 'still held between the sentences of one reply')
        self.now += .2; gate.settle()
        self.assertEqual(self.calls, ['normal', 'below'])
        gate.settle(); self.assertEqual(self.calls, ['normal', 'below'], 'lowered once')
        gate.request(); self.assertEqual(self.calls, ['normal', 'below', 'normal'], 'the next reply raises again')

    def test_waiting_with_nothing_raised_changes_nothing(self):
        gate = self.gate()
        self.now += 60; gate.settle()
        self.assertEqual(self.calls, [])

    def test_a_refused_raise_is_retried_and_never_lowers(self):
        gate = self.gate(raises=False)
        gate.request(); gate.request(); self.now += 10; gate.settle()
        self.assertEqual(self.calls, ['normal', 'normal'])

    def test_a_stream_or_an_urgent_prepare_raises_the_worker_and_a_plain_prepare_does_not(self):
        source = (ROOT / 'bridge/pocket-voice-worker.py').read_text(encoding='utf-8')
        self.assertIn('urgent = request["op"] == "stream" or request.get("urgent") is True', source)
        self.assertIn('if urgent:' + chr(10) + ' ' * 16 + 'gate.request()', source)
        self.assertEqual(source.count('gate.request()'), 2, 'when a reply starts and when it ends')
        self.assertIn('gate.settle()', source)

    def test_the_start_runs_at_normal_priority_and_the_worker_is_lowered_only_when_ready(self):
        # 0.2.7 reports: a start lowered from its first instruction got about 1% of a core under a loading game and timed out at 240 s.
        source = (ROOT / 'bridge/pocket-voice-worker.py').read_text(encoding='utf-8')
        main = source[source.index('def main():'):]
        self.assertEqual(main.count('lower_priority()'), 1, 'lowered once, when ready')
        self.assertEqual(main.count('raise_priority()'), 1, 'raised once, at the start')
        self.assertLess(main.index('raise_priority()'), main.index('importing-dependencies'))
        self.assertGreater(main.index('lower_priority()'), main.index('started.set()'))
        self.assertLess(main.index('lower_priority()'), main.index('"op": "ready"'))
        self.assertGreater(main.index('lower_priority()'), main.index('cache.prepare(key)'), 'the warm-up is part of the start')

    def test_the_classes_are_the_windows_values(self):
        self.assertEqual((worker.NORMAL_PRIORITY_CLASS, worker.BELOW_NORMAL_PRIORITY_CLASS), (0x20, 0x4000))


if __name__=='__main__':
    unittest.main()
