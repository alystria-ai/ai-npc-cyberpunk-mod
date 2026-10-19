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

    def test_the_classes_are_the_windows_values(self):
        self.assertEqual((worker.NORMAL_PRIORITY_CLASS, worker.BELOW_NORMAL_PRIORITY_CLASS), (0x20, 0x4000))


if __name__=='__main__':
    unittest.main()
