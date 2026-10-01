"""Offline audition planning/lifecycle tests; all GPU workers are simulated."""
from pathlib import Path
import base64
import copy
import hashlib
import importlib.util
import io
import json
import unittest
from unittest.mock import patch
import wave
import subprocess
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[1]
fixtures_spec = importlib.util.spec_from_file_location('audition_fixtures', ROOT / 'scripts/test_prepare_local_voices.py')
fixtures = importlib.util.module_from_spec(fixtures_spec)
fixtures_spec.loader.exec_module(fixtures)
spec = importlib.util.spec_from_file_location('generate_voice_cast_auditions', ROOT / 'scripts/Generate-VoiceCastAuditions.py')
audition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audition)


class AuditionTests(fixtures.PreparationConfig):
    # Do not inherit the older test methods; this test class only uses their
    # fixture builder, while the source/preparation suite runs separately.
    def aggregate(self):
        legacy = self.config()
        self.write_json('runtime/local-voices.json', legacy)
        original = self.promoted()
        descriptor = self.reference('alex', duration=6)
        descriptor['transcriptSha256'] = audition.prepare.sha256_text(descriptor['transcript'])
        original['reference'] = descriptor
        proof = original['provenance']
        original_wav = self.root / proof['audio']['wavPath']
        original_wav.write_bytes((self.root / descriptor['reference']).read_bytes())
        proof['quality'].update({'sha256': descriptor['sha256'], 'channels': 1, 'sampleRate': 8000, 'bitsPerSample': 16,
                                'frames': 48000, 'durationSeconds': 6, 'originalPcm': True, 'listeningVerified': False})
        source_reference = original_wav.relative_to(self.root).as_posix()
        receipt = {'key': 'alex', 'status': 'decoded_verified', 'attributionVerified': True, 'transcriptAgreement': True,
                   'listeningVerified': False, 'voiceCloneApproved': False, 'reference': source_reference,
                   'sha256': descriptor['sha256'], 'transcript': descriptor['transcript'],
                   'transcriptSha256': descriptor['transcriptSha256'], 'provenance': proof}
        receipt_path = original_wav.with_name('receipt.json')
        receipt_path.write_text(json.dumps(receipt), encoding='utf-8')
        candidate = {'key': 'alex', 'reference': source_reference, 'sourceVerified': True, 'errors': [],
                     'sha256': descriptor['sha256'], 'transcript': descriptor['transcript'],
                     'transcriptSha256': descriptor['transcriptSha256'], 'receiptSha256': audition.digest(receipt_path),
                     'pcm': {'durationSeconds': 6}, 'approved': False, 'listeningVerified': False}
        profiles = [{'key': key, 'status': 'accepted', 'provisional': {}, 'candidates': [{**legacy['voices'][key], 'acceptedReference': True}]}
                    for key in fixtures.worker.LEGACY_KEYS]
        profiles += [{'key': 'alex', 'status': 'listening_pending', 'provisional': {'primary': source_reference}, 'candidates': [candidate]},
                     {'key': '8ug8ear', 'status': 'unprepared', 'provisional': {}, 'candidates': []}]
        inventory = {'schemaVersion': 1, 'rosterSha256': proof['rosterSha256'], 'profiles': profiles}
        path = self.write_json('runtime/voice-cast/review/inventory.json', inventory)
        return legacy, inventory, path, receipt_path

    def test_plan_preserves_accepted_and_reads_sources_without_writes(self):
        legacy, inventory, path, receipt = self.aggregate()
        before_config, before_receipt = (self.root / 'runtime/local-voices.json').read_bytes(), receipt.read_bytes()
        plan = audition.plan_auditions(self.root, path)
        self.assertEqual(len(plan['selected']), 4)
        self.assertEqual(plan['unprepared'][0]['key'], '8ug8ear')
        for key in fixtures.worker.LEGACY_KEYS:
            self.assertEqual(next(row for row in plan['selected'] if row['key'] == key)['descriptor'], legacy['voices'][key])
        self.assertFalse((self.root / 'runtime/voice-references/full-cast-draft').exists())
        self.assertFalse((self.root / 'runtime/voice-cast/auditions').exists())
        self.assertEqual((self.root / 'runtime/local-voices.json').read_bytes(), before_config)
        self.assertEqual(receipt.read_bytes(), before_receipt)

    def test_draft_copies_original_exactly_and_uses_no_production_approvals(self):
        legacy, _, path, receipt = self.aggregate()
        plan = audition.plan_auditions(self.root, path)
        config_path, config = audition.make_draft(self.root, plan, Path('runtime/voice-cast/auditions/test'))
        self.assertEqual(config['version'], 2)
        self.assertEqual(config['preparation'], {'mode': 'lazy', 'startupProfiles': [], 'maxCachedProfiles': 8})
        self.assertEqual(config['voices']['8ug8ear'], {'status': 'unprepared'})
        for key in fixtures.worker.LEGACY_KEYS:
            self.assertEqual(config['voices'][key], legacy['voices'][key])
        row = next(row for row in plan['selected'] if row['key'] == 'alex')
        self.assertEqual((self.root / config['voices']['alex']['reference']).read_bytes(), (self.root / row['source']).read_bytes())
        self.assertNotEqual(config_path, self.root / 'runtime/local-voices.json')
        self.assertEqual(json.loads(receipt.read_text(encoding='utf-8'))['listeningVerified'], False)

    def test_changed_wav_or_receipt_quarantines_only_its_profile(self):
        _, inventory, path, receipt_path = self.aggregate()
        receipt_path.write_text('{}', encoding='utf-8')
        plan = audition.plan_auditions(self.root, path)
        self.assertEqual(len(plan['selected']), 3)
        self.assertIn('alex', [row['key'] for row in plan['unprepared']])

    def test_limits_duplicates_unsafe_paths_and_incorrect_accepted_descriptor(self):
        _, inventory, path, _ = self.aggregate()
        for keys in (['alex', 'alex'], ['not-a-character']):
            with self.assertRaises(ValueError):
                audition.plan_auditions(self.root, path, keys=keys)
        with self.assertRaises(ValueError):
            audition.plan_auditions(self.root, path, max_profiles=3)
        for target in (Path('../auditions/test'), Path('runtime/voice-cast/auditions/../outside')):
            with self.assertRaises(ValueError):
                audition.runtime_path(self.root, target, 'runtime/voice-cast/auditions')
        inventory['profiles'][0]['candidates'][0]['transcript'] = 'Edited accepted transcript'
        path.write_text(json.dumps(inventory), encoding='utf-8')
        plan = audition.plan_auditions(self.root, path)
        self.assertIn(fixtures.worker.LEGACY_KEYS[0], [row['key'] for row in plan['unprepared']])

    def test_changed_inputs_and_existing_copy_collision_fail_before_model(self):
        _, _, path, _ = self.aggregate()
        plan = audition.plan_auditions(self.root, path)
        collision = self.root / 'runtime/voice-references/full-cast-draft/alex/reference.wav'
        collision.parent.mkdir(parents=True)
        collision.write_bytes(b'owned by another draft')
        with self.assertRaisesRegex(ValueError, 'Another draft'):
            audition.make_draft(self.root, plan, Path('runtime/voice-cast/auditions/test'))
        self.assertEqual(collision.read_bytes(), b'owned by another draft')
        path.write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'inputs changed'):
            audition.make_draft(self.root, plan, Path('runtime/voice-cast/auditions/test'))

    def fake_worker(self, *, fail=None, cancel=None):
        trace, owned = [], []
        output = io.BytesIO()
        with wave.open(output, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(24000)
            wav.writeframes(b'\x00\x01' * 24000)
        data = output.getvalue()
        class Worker:
            def __init__(self, *args):
                owned.append(self)
                self.closed = False
            def start(self, config):
                return {'startupMs': 10, 'worker': {'device': 'cuda:0', 'dtype': 'torch.float16'}}
            def request(self, op, profile, **values):
                trace.append((op, profile, values))
                if cancel:
                    cancel.set()
                    raise audition.Cancelled('test cancellation')
                if profile == fail:
                    raise ValueError('test reference generation failure')
                return {'op': 'prepared' if op == 'prepare' else 'audio', 'audio': base64.b64encode(data).decode(),
                        'preparedProfiles': [profile], 'generationMs': 12}, 15
            def close(self):
                self.closed = True
        return Worker, trace, owned

    def test_serial_one_worker_generation_writes_samples_no_approval_mutation(self):
        _, _, path, receipt = self.aggregate()
        plan = audition.plan_auditions(self.root, path)
        before = receipt.read_bytes()
        factory, trace, owned = self.fake_worker()
        guards = []
        with patch('sys.stdout', new_callable=io.StringIO):
            report = audition.generate_auditions(self.root, plan, Path('runtime/voice-cast/auditions/test'),
                       worker_factory=factory, guard=lambda: guards.append(True))
        self.assertEqual(len(owned), 1)
        self.assertTrue(owned[0].closed)
        self.assertEqual(len(guards), 2)
        self.assertEqual(report['state'], 'complete')
        self.assertEqual(len(report['renders']), 4)
        self.assertTrue(all(row['approved'] is False and row['listeningVerified'] is False for row in report['renders']))
        self.assertEqual([op for op, _, _ in trace], ['prepare', 'synthesize'] * 4)
        self.assertTrue(all(values.get('text') == audition.AUDITION_TEXT and values.get('steps') == 32
                            for op, _, values in trace if op == 'synthesize'))
        self.assertEqual(receipt.read_bytes(), before)
        self.assertIn('not benchmark', report['warning'])

    def test_cancel_and_profile_failure_close_the_owned_worker(self):
        import threading
        _, _, path, _ = self.aggregate()
        plan = audition.plan_auditions(self.root, path)
        cancelled = threading.Event()
        factory, _, owned = self.fake_worker(cancel=cancelled)
        with patch('sys.stdout', new_callable=io.StringIO):
            report = audition.generate_auditions(self.root, plan, Path('runtime/voice-cast/auditions/cancel'),
                       worker_factory=factory, cancel=cancelled.is_set, guard=lambda: None)
        self.assertEqual(report['state'], 'cancelled')
        self.assertTrue(owned[0].closed)
        factory, trace, owned = self.fake_worker(fail='alex')
        with patch('sys.stdout', new_callable=io.StringIO):
            report = audition.generate_auditions(self.root, plan, Path('runtime/voice-cast/auditions/failed-profile'),
                       worker_factory=factory, guard=lambda: None)
        self.assertEqual(report['state'], 'partial')
        self.assertEqual(next(row for row in report['renders'] if row['key'] == 'alex')['status'], 'generation_failed')
        self.assertTrue(owned[0].closed)

    def test_process_guard_blocks_before_copy_or_gpu(self):
        _, _, path, _ = self.aggregate()
        plan = audition.plan_auditions(self.root, path)
        factory, _, owned = self.fake_worker()
        def blocked():
            raise RuntimeError('another worker exists')
        with self.assertRaisesRegex(RuntimeError, 'another worker'):
            audition.generate_auditions(self.root, plan, Path('runtime/voice-cast/auditions/blocked'), worker_factory=factory, guard=blocked)
        self.assertEqual(owned, [])
        self.assertFalse((self.root / 'runtime/voice-cast/auditions/blocked').exists())

    def test_constructor_failure_closes_an_already_spawned_owned_child(self):
        destination = self.root / 'runtime/voice-cast/auditions/startup-failure'
        destination.mkdir(parents=True)
        child = SimpleNamespace(stdin=io.BytesIO(), stdout=io.BytesIO(), wait=MagicMock(return_value=0),
                                poll=lambda: 0, terminate=MagicMock())
        with patch.object(audition.subprocess, 'Popen', return_value=child), patch.object(audition.threading, 'Thread', side_effect=RuntimeError('thread failure')):
            with self.assertRaisesRegex(RuntimeError, 'thread failure'):
                audition.PipeWorker(self.root, destination / 'config.json', destination, lambda: False)
        self.assertTrue(child.stdin.closed)
        self.assertEqual(child.wait.call_count, 1)
        self.assertTrue(child.stdout.closed)

    def test_unconfirmed_exit_keeps_stdout_close_outside_a_blocked_reader(self):
        worker = audition.PipeWorker.__new__(audition.PipeWorker)
        stdout = SimpleNamespace(close=MagicMock(side_effect=AssertionError('must not block closing stdout')))
        worker.child = SimpleNamespace(stdin=io.BytesIO(), stdout=stdout,
            wait=MagicMock(side_effect=subprocess.TimeoutExpired('owned-worker', 10)), poll=lambda: None, terminate=MagicMock())
        worker.stop_reader, worker.log = threading.Event(), io.BytesIO()
        worker.reader = SimpleNamespace(ident=1, join=MagicMock(), is_alive=lambda: True)
        with self.assertRaisesRegex(RuntimeError, 'exit could not be confirmed'):
            worker.close()
        stdout.close.assert_not_called()
        worker.child.terminate.assert_called_once()

    def test_source_qualified_activation_writes_staged_config_with_honest_flags(self):
        legacy, inventory, path, source_receipt = self.aggregate()
        evidence = json.loads(source_receipt.read_text(encoding='utf-8'))
        evidence['provenance']['quality'].pop('cleanIntelligible')
        source_receipt.write_text(json.dumps(evidence), encoding='utf-8')
        candidate = next(profile for profile in inventory['profiles'] if profile['key'] == 'alex')['candidates'][0]
        candidate['receiptSha256'] = audition.digest(source_receipt)
        path.write_text(json.dumps(inventory), encoding='utf-8')
        baseline = (self.root / 'runtime/local-voices.json').read_bytes()
        original_receipt = source_receipt.read_bytes()
        config, receipt = audition.prepare.write_source_qualified_activation(self.root, path)
        target = self.root / 'runtime/voice-cast/activation/local-voices.source-qualified.json'
        self.assertTrue(target.is_file())
        self.assertEqual(receipt['localProfiles'], 4)
        self.assertEqual(receipt['remoteProfiles'], 1)
        self.assertEqual(receipt['newListeningApprovals'], 0)
        self.assertEqual(receipt['configSha256'], audition.digest(target))
        self.assertEqual(receipt['productionConfigSha256BeforePreparation'], hashlib.sha256(baseline).hexdigest())
        self.assertEqual(receipt['configPath'], target.relative_to(self.root).as_posix())
        self.assertEqual(config['voices']['alex']['qualificationStatus'], 'source-qualified')
        self.assertIs(config['voices']['alex']['listeningVerified'], False)
        self.assertNotIn('approved', config['voices']['alex'])
        self.assertNotIn('cleanIntelligible', config['voices']['alex'])
        self.assertEqual(config['voices']['8ug8ear'], {'status': 'unprepared'})
        for key in fixtures.worker.LEGACY_KEYS:
            self.assertEqual(config['voices'][key], legacy['voices'][key])
        self.assertEqual((self.root / 'runtime/local-voices.json').read_bytes(), baseline)
        self.assertEqual(source_receipt.read_bytes(), original_receipt)

    def test_source_qualified_missing_or_changed_evidence_stays_remote(self):
        legacy, inventory, path, source_receipt = self.aggregate()
        evidence = json.loads(source_receipt.read_text(encoding='utf-8'))
        reference = self.root / evidence['reference']
        wem = self.root / evidence['provenance']['audio']['wemPath']
        subtitle_index = self.root / evidence['provenance']['subtitle']['indexPath']
        scene = self.root / evidence['provenance']['nativeActor']['scene']['jsonPath']
        cases = [(reference, None, 'missing'), (reference, b'changed original PCM' * 4, 'hash changed'),
                 (source_receipt, b'{}', 'receipt hash changed'), (wem, b'changed original WEM', 'WEM'),
                 (subtitle_index, b'changed subtitle index', 'index fingerprint'),
                 (scene, b'{}', 'hash|SHA256')]
        for source, changed, reason in cases:
            original = source.read_bytes()
            with self.subTest(source=source.name, missing=changed is None):
                try:
                    source.unlink() if changed is None else source.write_bytes(changed)
                    config, receipt = audition.prepare.write_source_qualified_activation(self.root, path)
                    self.assertEqual(receipt['localProfiles'], 3)
                    self.assertEqual(receipt['remoteProfiles'], 2)
                    self.assertEqual(config['voices']['alex'], {'status': 'unprepared'})
                    rejection = next(row for row in receipt['unprepared'] if row['key'] == 'alex')
                    self.assertRegex(rejection['reason'], reason)
                    for key in fixtures.worker.LEGACY_KEYS:
                        self.assertEqual(config['voices'][key], legacy['voices'][key])
                finally:
                    source.write_bytes(original)

    def test_source_qualified_rechecks_native_identity_and_installed_transcript(self):
        _, inventory, path, source_receipt = self.aggregate()
        original = json.loads(source_receipt.read_text(encoding='utf-8'))
        for change in ('identity', 'transcript'):
            with self.subTest(change=change):
                evidence, aggregate = copy.deepcopy(original), copy.deepcopy(inventory)
                candidate = next(profile for profile in aggregate['profiles'] if profile['key'] == 'alex')['candidates'][0]
                if change == 'identity':
                    evidence['provenance']['nativeActor']['identityProof']['canonicalKey'] = 'songbird'
                else:
                    text = 'This invented transcript never appeared in the installed subtitle.'
                    digest = audition.prepare.sha256_text(text)
                    evidence.update(transcript=text, transcriptSha256=digest)
                    candidate.update(transcript=text, transcriptSha256=digest)
                    subtitle = evidence['provenance']['subtitle']
                    subtitle.update(transcript=text, transcriptSha256=digest)
                    for source in subtitle['sources']:
                        source['variants'][subtitle['variant']] = text
                source_receipt.write_text(json.dumps(evidence), encoding='utf-8')
                candidate['receiptSha256'] = audition.digest(source_receipt)
                path.write_text(json.dumps(aggregate), encoding='utf-8')
                config, receipt = audition.prepare.write_source_qualified_activation(self.root, path)
                self.assertEqual(config['voices']['alex'], {'status': 'unprepared'})
                reason = next(row for row in receipt['unprepared'] if row['key'] == 'alex')['reason']
                self.assertRegex(reason, 'identity proof' if change == 'identity' else 'transcript|variant join')

    def test_source_qualified_rejects_evidence_changed_after_admission(self):
        _, _, path, source_receipt = self.aggregate()
        sources, plan = audition.prepare.source_qualified_plan(self.root, path)
        selected = next(row for row in plan['selected'] if row['key'] == 'alex')
        cases = [(path, b'{}', 'inputs changed'), (self.root / 'runtime/local-voices.json', b'{}', 'inputs changed'),
                 (source_receipt, b'{}', 'receipt changed'),
                 (self.root / selected['source'], b'changed original PCM', 'reference changed')]
        for source, changed, reason in cases:
            original = source.read_bytes()
            with self.subTest(source=source.name):
                try:
                    source.write_bytes(changed)
                    with self.assertRaisesRegex(ValueError, reason):
                        audition.prepare.build_source_qualified_config(self.root, sources, plan)
                finally:
                    source.write_bytes(original)

    def test_source_qualified_cli_defaults_dryrun_and_cannot_target_live_config(self):
        _, _, path, _ = self.aggregate()
        with patch.object(audition.prepare, 'ROOT', self.root), patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(audition.prepare.main(['--source-qualified-inventory', str(path)]), 0)
            self.assertEqual(json.loads(output.getvalue())['mode'], 'dry-run')
        self.assertFalse((self.root / 'runtime/voice-cast/activation').exists())
        self.assertFalse((self.root / 'runtime/voice-references/full-cast-draft').exists())
        with self.assertRaisesRegex(ValueError, 'owned directory'):
            audition.prepare.write_source_qualified_activation(self.root, path, Path('runtime/local-voices.json'))

    def test_source_qualified_dryrun_cannot_claim_missing_accepted_voice_unchanged(self):
        _, inventory, path, _ = self.aggregate()
        inventory['profiles'][0]['candidates'][0]['transcript'] = 'Changed accepted transcript'
        path.write_text(json.dumps(inventory), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'preserve all three'):
            audition.prepare.source_qualified_plan(self.root, path)


# unittest discovers inherited test methods. Keep the fixture class explicit
# without repeating another suite's checks or implying extra native validation.
for name in dir(fixtures.PreparationConfig):
    if name.startswith('test_') and name not in AuditionTests.__dict__:
        setattr(AuditionTests, name, None)

if __name__ == '__main__':
    unittest.main()
