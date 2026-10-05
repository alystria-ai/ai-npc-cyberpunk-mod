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


if __name__=='__main__':
    unittest.main()
