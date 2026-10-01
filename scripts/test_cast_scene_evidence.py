"""Bounded scene exports: pure synthetic archive, provenance and failure tests."""
from __future__ import annotations

import hashlib
from contextlib import nullcontext
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('cast_scene', Path(__file__).with_name('Cast-SceneEvidence.py'))
scene = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scene)

DEPOT = r'base\quest\test\one.scene'
OTHER = r'base\quest\test\two.scene'


def archive(path, resources):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload, rows, segments = b'', [], []
    for depot, data in resources:
        offset = 20 + len(payload)
        first = len(segments)
        payload += data
        segments.append(struct.pack('<QII', offset, len(data), len(data)))
        rows.append(struct.pack('<QqIIIII20s', scene.knowledge.fnv(depot, 64), 0, 0,
                                first, first + 1, 0, 0, hashlib.sha1(data).digest()))
    directory = struct.pack('<IIQIII', 0, 0, 0, len(rows), len(segments), 0) + b''.join(rows) + b''.join(segments)
    path.write_bytes(struct.pack('<4sIQI', b'RDAR', 12, 20 + len(payload), len(directory)) + payload + directory)


class Gate:
    held = False
    entered = 0
    exited = 0

    def __init__(self, project, timeout=120):
        self.project, self.timeout = project, timeout

    def __enter__(self):
        self.__class__.held = True
        self.__class__.entered += 1
        return self

    def __exit__(self, *args):
        self.__class__.held = False
        self.__class__.exited += 1


class SceneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.project, self.game = root / 'project', root / 'game'
        self.project.mkdir()
        self.game.mkdir()
        self.lanes = self.project / 'lanes.json'
        self.lanes.write_text(json.dumps({'lanes': [{'name': 'main-core-a', 'mode': 'metadata_then_bounded_decode'},
                                                 {'name': 'main-core-b', 'mode': 'metadata_then_bounded_decode'}]}))
        self.base = self.game / scene.ARCHIVES[0][1]
        self.ep1 = self.game / scene.ARCHIVES[1][1]
        archive(self.base, [(DEPOT, b'CR2W base payload'), (OTHER, b'CR2W other payload')])
        archive(self.ep1, [(DEPOT, b'CR2W ep1 winner')])
        for relative in ('vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe', 'vendor/dotnet-runtime-10.0.12/dotnet.exe'):
            path = self.project / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'not-executable-test-fixture')
        self.pin = patch.object(scene, 'WOLVENKIT_SHA256', hashlib.sha256(b'not-executable-test-fixture').hexdigest())
        self.pin.start()
        self.lane_lock = patch.object(scene, 'LaneLock', lambda *args, **kwargs: nullcontext())
        self.lane_lock.start()
        Gate.held = False
        Gate.entered = Gate.exited = 0

    def tearDown(self):
        self.lane_lock.stop()
        self.pin.stop()
        self.tmp.cleanup()

    def call(self, **changes):
        kwargs = {'project': self.project, 'game': self.game, 'lane': 'main-core-a', 'batch': 'test-batch',
                  'depots': [DEPOT], 'lane_inventory': self.lanes}
        kwargs.update(changes)
        return scene.run(**kwargs)

    def fake_tool(self, job, arguments, label):
        self.assertTrue(Gate.held, 'Tool work must own the shared gate')
        self.assertEqual(arguments[:2], ['convert', 'serialize'])
        self.assertEqual(len(arguments), 3, 'Only exact resource files may be serialized')
        raw = Path(arguments[2])
        raw.with_name(raw.name + '.json').write_text(json.dumps({'Header': {'ArchiveFileName': str(raw.resolve())},
                                                               'Data': {'RootChunk': {'$type': 'scnSceneResource'}}}))

    def fake_run(self, job, arguments, label):
        # Actual fixed archive path, independent of host slash spelling.
        if arguments[0] == 'extract':
            archive_id = 'ep1' if Path(arguments[1]) == self.ep1 else 'base'
            pattern, root = arguments[5], Path(arguments[3])
            self.assertTrue(Gate.held)
            self.assertEqual(arguments[4], '--regex')
            self.assertTrue(pattern.startswith('^(') and pattern.endswith(')$'))
            payloads = {DEPOT: b'CR2W ep1 winner'} if archive_id == 'ep1' else {DEPOT: b'CR2W base payload', OTHER: b'CR2W other payload'}
            for depot, payload in payloads.items():
                if scene.re.fullmatch(pattern, depot):
                    raw = root / Path(*depot.split('\\'))
                    raw.parent.mkdir(parents=True, exist_ok=True)
                    raw.write_bytes(payload)
        else:
            self.fake_tool(job, arguments, label)

    def test_empty_broad_or_escaped_allowlists_rejected(self):
        for values in ([], [DEPOT] * 33, [r'..\escape.scene'], ['/absolute.scene'], [r'C:\game.scene'],
                       [r'base\\bad.scene'], [r'base\*.scene'], [r'base\nul.scene'], ['base\na\nme.scene'], ['base/é.scene']):
            with self.subTest(values=values), self.assertRaises(ValueError):
                scene.allowlist(values)
        self.assertEqual(scene.allowlist([DEPOT.upper().replace('\\', '/'), DEPOT]), [DEPOT])

    def test_output_lanes_batch_and_game_overlap_are_checked(self):
        for lane, batch in (('../escape', 'batch'), ('main-core-a', '..'), ('accepted-existing', 'batch'), ('UPPER', 'batch')):
            with self.subTest(lane=lane), self.assertRaises(ValueError):
                scene.output_path(self.project, self.game, lane, batch)
        with self.assertRaises(ValueError):
            scene.output_path(self.project, self.project, 'main-core-a', 'batch')
        with self.assertRaises(ValueError):
            scene.lane_receipt(self.project, 'not-assigned', self.lanes)
        with self.assertRaises(ValueError):
            scene.safe_file(self.base, self.project)

    def test_winner_has_actual_segment_bounds_and_shadowed_metadata(self):
        out = scene.output_path(self.project, self.game, 'main-core-a', 'batch')
        assets, missing, decoded = scene.resolve_winners(self.game, out, [DEPOT, OTHER], 1000)
        self.assertEqual(missing, [])
        selected = next(x for x in assets if x['depotPath'] == DEPOT)
        self.assertEqual(selected['archive'], 'ep1')
        self.assertTrue(selected['winner'])
        self.assertEqual(selected['shadowedSources'][0]['archive'], 'base')
        self.assertEqual(selected['segmentBounds'][0]['offset'], '20')
        self.assertEqual(decoded, len(b'CR2W ep1 winner') + len(b'CR2W other payload'))

    def test_invalid_segment_and_dependency_bounds_rejected(self):
        data = bytearray(self.base.read_bytes())
        index_offset = struct.unpack_from('<Q', data, 8)[0]
        segment_offset = index_offset + 28 + 56 * 2
        struct.pack_into('<Q', data, segment_offset, len(data) + 10)
        self.base.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'segment exceeds'):
            scene.read_archive_index(self.base)
        archive(self.base, [(DEPOT, b'CR2W base payload')])
        data = bytearray(self.base.read_bytes())
        index_offset = struct.unpack_from('<Q', data, 8)[0]
        struct.pack_into('<I', data, index_offset + 28 + 32, 1)
        self.base.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'dependency range'):
            scene.read_archive_index(self.base)

    def test_export_hashes_and_scene_receipts_are_bound_to_winner(self):
        with patch.object(scene, 'CpuSlots', Gate), patch.object(scene.SceneJob, 'run', lambda job, args, label: self.fake_run(job, args, label)):
            result = self.call(depots=[DEPOT, OTHER])
        self.assertTrue(result['complete'])
        self.assertEqual(Gate.entered, Gate.exited)
        self.assertFalse(Gate.held)
        out = scene.output_path(self.project, self.game, 'main-core-a', 'test-batch')
        receipt = scene.read_json(out / 'provenance.json')
        item = next(x for x in receipt['scenes'] if x['depotPath'] == DEPOT)
        self.assertEqual(item['archive'], scene.ARCHIVES[1][1])
        self.assertEqual(item['entrySha1'], hashlib.sha1(b'CR2W ep1 winner').hexdigest())
        self.assertEqual(item['rawSha256'], hashlib.sha256(b'CR2W ep1 winner').hexdigest())
        self.assertEqual(item['jsonSha256'], scene.digest(self.project / item['jsonPath']))
        self.assertEqual(receipt['inventorySha256'], scene.digest(out / 'inventory.json'))
        self.assertEqual(result['totals']['outputBytes'], sum(p.stat().st_size for p in out.rglob('*') if p.is_file()))
        with patch.object(scene, 'CpuSlots', Gate), patch.object(scene.SceneJob, 'run', side_effect=AssertionError('Should reuse verified exact evidence')):
            self.assertTrue(self.call(depots=[DEPOT, OTHER])['complete'])

    def test_existing_batch_with_different_winner_rejected_without_overwrite(self):
        with patch.object(scene, 'CpuSlots', Gate), patch.object(scene.SceneJob, 'run', lambda job, args, label: self.fake_run(job, args, label)):
            self.call()
        out = scene.output_path(self.project, self.game, 'main-core-a', 'test-batch')
        previous = (out / 'inventory.json').read_bytes()
        archive(self.ep1, [(DEPOT, b'changed native winner')])
        with patch.object(scene, 'CpuSlots', Gate), self.assertRaisesRegex(ValueError, 'different requested scenes or native winners'):
            self.call()
        self.assertEqual(previous, (out / 'inventory.json').read_bytes())
        self.assertEqual(Gate.entered, Gate.exited)

    def test_raw_hash_and_serialization_source_hash_failures(self):
        with patch.object(scene, 'CpuSlots', Gate), patch.object(scene.SceneJob, 'run', lambda job, args, label: self.fake_run(job, args, label)):
            result = self.call()
        out = scene.output_path(self.project, self.game, 'main-core-a', 'test-batch')
        asset = result['assets'][0]
        raw = out / asset['rawPath']
        raw.write_bytes(b'CR2W WRONGsame!')
        with self.assertRaisesRegex(ValueError, 'SHA-1 mismatch'):
            scene.verify_raw(out, asset)
        raw.write_bytes(b'CR2W ep1 winner')
        doc_path = out / asset['jsonPath']
        doc = scene.read_json(doc_path)
        doc['Header']['ArchiveFileName'] = str(self.base)
        doc_path.write_text(json.dumps(doc))
        with self.assertRaisesRegex(ValueError, 'source does not match'):
            scene.verify_serialized(out, asset)
        doc['Header']['ArchiveFileName'] = str(raw)
        doc_path.write_text(json.dumps(doc) + ' ')
        with self.assertRaisesRegex(ValueError, 'SHA-256 changed'):
            scene.verify_serialized(out, asset, asset['jsonSha256'])

    def test_missing_tools_fail_before_gate_or_output(self):
        (self.project / 'vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe').unlink()
        with patch.object(scene, 'CpuSlots', Gate), self.assertRaises(FileNotFoundError):
            self.call()
        self.assertEqual(Gate.entered, 0)
        self.assertFalse((self.project / 'runtime').exists())

    def test_archive_and_subprocess_errors_release_gate(self):
        self.base.write_bytes(b'bad archive')
        with patch.object(scene, 'CpuSlots', Gate), self.assertRaises(ValueError):
            self.call()
        self.assertEqual(Gate.entered, Gate.exited)
        archive(self.base, [(DEPOT, b'CR2W base payload')])
        with patch.object(scene, 'CpuSlots', Gate), patch.object(scene.SceneJob, 'run', side_effect=RuntimeError('tool failed')), self.assertRaises(RuntimeError):
            self.call()
        self.assertEqual(Gate.entered, Gate.exited)
        self.assertFalse(Gate.held)
        out = scene.output_path(self.project, self.game, 'main-core-a', 'test-batch')
        self.assertEqual(scene.read_json(out / 'inventory-pending.json')['status'], 'failed_or_interrupted')
        self.assertFalse((out / 'inventory.json').exists())
        self.assertFalse((out / 'provenance.json').exists())

    def test_all_archive_work_is_inside_gate_and_dry_run_does_not_export(self):
        original = scene.read_archive_index
        def guarded(path):
            self.assertTrue(Gate.held)
            return original(path)
        with patch.object(scene, 'CpuSlots', Gate), patch.object(scene, 'read_archive_index', guarded), patch.object(scene.SceneJob, 'run', side_effect=AssertionError('dry-run must not execute')):
            result = self.call(dry_run=True)
        self.assertTrue(result['dryRun'])
        self.assertEqual(result['status'], 'metadata_verified')
        self.assertFalse(result['complete'])
        self.assertFalse((self.project / 'runtime').exists())

    def test_missing_scene_never_falls_back_to_broad_extract(self):
        with patch.object(scene, 'CpuSlots', Gate), patch.object(scene.SceneJob, 'run', side_effect=AssertionError('no arbitrary fallback')):
            result = self.call(depots=[r'base\quest\absent.scene'])
        self.assertEqual(result['winnerCount'], 0)
        self.assertEqual(result['missingPaths'], [r'base\quest\absent.scene'])
        self.assertFalse(result['complete'])
        self.assertEqual(result['status'], 'missing_requested_resources')

    def test_budget_and_nan_limits_rejected(self):
        with self.assertRaises(RuntimeError):
            scene.resolve_winners(self.game, self.project, [DEPOT], 1)
        for key, value in (('max_output_mib', float('nan')), ('lock_timeout', 400), ('process_timeout', float('inf'))):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.call(**{key: value})

    def test_duplicate_archive_hash_uses_wolvenkit_first_row(self):
        archive(self.ep1, [(DEPOT, b'first native winner'), (DEPOT, b'second hidden payload')])
        selected = scene.read_archive_index(self.ep1)[str(scene.knowledge.fnv(DEPOT, 64))]
        self.assertEqual(selected['archiveEntrySha1'], hashlib.sha1(b'first native winner').hexdigest())
        self.assertEqual(selected['archiveEntryIndex'], 0)
        self.assertEqual(selected['shadowedArchiveRows'][0]['archiveEntryIndex'], 1)

    def test_retry_cannot_erase_prior_serialization_hash(self):
        with patch.object(scene, 'CpuSlots', Gate), patch.object(scene.SceneJob, 'run', lambda job, args, label: self.fake_run(job, args, label)):
            result = self.call()
        out = scene.output_path(self.project, self.game, 'main-core-a', 'test-batch')
        old_inventory = (out / 'inventory.json').read_bytes()
        raw_json = out / result['assets'][0]['jsonPath']
        doc = scene.read_json(raw_json)
        doc['Data']['RootChunk']['arbitraryAlteration'] = True
        raw_json.write_text(json.dumps(doc))
        for _ in range(2):
            with patch.object(scene, 'CpuSlots', Gate), self.assertRaisesRegex(ValueError, 'SHA-256 changed'):
                self.call()
            self.assertEqual(old_inventory, (out / 'inventory.json').read_bytes())
            self.assertEqual(result['assets'][0]['jsonSha256'], scene.read_json(out / 'inventory-pending.json')['assets'][0]['jsonSha256'])

    def test_orphan_json_is_not_blessed_as_native_serialization(self):
        out = scene.output_path(self.project, self.game, 'main-core-a', 'test-batch')
        assets, _, _ = scene.resolve_winners(self.game, out, [DEPOT], 1000)
        asset = assets[0]
        raw = out / asset['rawPath']
        raw.parent.mkdir(parents=True, exist_ok=True)
        raw.write_bytes(b'CR2W ep1 winner')
        (out / asset['jsonPath']).write_text(json.dumps({'Header': {'ArchiveFileName': str(raw)},
                                                       'Data': {'RootChunk': {'inventedActor': True}}}))
        with patch.object(scene, 'CpuSlots', Gate), self.assertRaisesRegex(ValueError, 'Orphan scene JSON'):
            self.call()
        self.assertFalse((out / 'inventory.json').exists())

    def test_exact_additional_native_acquisition_resource_extensions(self):
        for extension in scene.EXTENSIONS:
            self.assertEqual(scene.depot_path('base/quest/test/resource' + extension), 'base\\quest\\test\\resource' + extension)
        with self.assertRaises(ValueError):
            scene.depot_path('base/test/resource.mesh')

    def test_replaced_serializer_rejected_before_gate(self):
        (self.project / 'vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe').write_bytes(b'replaced')
        with patch.object(scene, 'CpuSlots', Gate), self.assertRaisesRegex(ValueError, 'pinned native serializer'):
            self.call()
        self.assertEqual(Gate.entered, 0)

    def test_final_metadata_budget_failure_does_not_publish_complete_receipts(self):
        def tiny_publish(project, out, manifest, job):
            # Reproduce the boundary where raw+JSON fit, but final receipts do not.
            job.byte_limit = job.size() + 1
            return original(project, out, manifest, job)
        original = scene.publish_completed
        with patch.object(scene, 'CpuSlots', Gate), patch.object(scene.SceneJob, 'run', lambda job, args, label: self.fake_run(job, args, label)), patch.object(scene, 'publish_completed', tiny_publish), self.assertRaisesRegex(RuntimeError, 'metadata would exceed'):
            self.call()
        out = scene.output_path(self.project, self.game, 'main-core-a', 'test-batch')
        self.assertFalse((out / 'inventory.json').exists())
        self.assertFalse((out / 'provenance.json').exists())
        self.assertFalse(scene.read_json(out / 'inventory-pending.json')['complete'])

    def test_transient_staging_budget_failure_preserves_published_snapshot(self):
        with patch.object(scene, 'CpuSlots', Gate), patch.object(scene.SceneJob, 'run', lambda job, args, label: self.fake_run(job, args, label)):
            self.call()
        out = scene.output_path(self.project, self.game, 'main-core-a', 'test-batch')
        before = (out / 'inventory.json').read_bytes(), (out / 'provenance.json').read_bytes()
        original = scene.publish_completed
        def small_publish(project, out, manifest, job):
            job.byte_limit = max(job.size(), sum(p.stat().st_size for p in out.rglob('*') if p.is_file())) + 50
            return original(project, out, manifest, job)
        with patch.object(scene, 'CpuSlots', Gate), patch.object(scene, 'publish_completed', small_publish), self.assertRaisesRegex(RuntimeError, 'byte budget exceeded'):
            self.call()
        self.assertEqual(before, ((out / 'inventory.json').read_bytes(), (out / 'provenance.json').read_bytes()))


if __name__ == '__main__':
    unittest.main()
