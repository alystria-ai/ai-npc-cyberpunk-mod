"""Bounded exporter provenance regressions without an installed game/CLI."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import extract_scene_evidence as exporter
from index_game_knowledge import digest, fnv


class ExportProvenanceTests(unittest.TestCase):
    depot = r'base\quest\example.questphase'
    raw_bytes = b'owned native payload fixture'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cyberpunk-native-export-test-')
        self.addCleanup(self.temp.cleanup)
        self.fixture_root = Path(self.temp.name).resolve()
        self.project = self.fixture_root / 'project'
        self.game = self.fixture_root / 'game'
        archive = self.game / 'archive/pc/content/basegame_4_gamedata.archive'
        archive.parent.mkdir(parents=True)
        archive.write_bytes(b'owned archive directory fixture')
        self.output = self.project / 'research/cyberpunk/cache/game/scene-evidence/test-native'
        self.raw = self.output / 'raw/base/base/quest/example.questphase'
        self.serialized = self.raw.with_name(self.raw.name + '.json')
        self.calls = []
        owner = self

        class FakeJob:
            def __init__(self, args):
                self.output = Path(args.output)
                self.output.mkdir(parents=True, exist_ok=True)

            def run(self, args, label, expect=None):
                owner.calls.append((list(args), label))
                if args[0] == 'extract':
                    owner.raw.parent.mkdir(parents=True, exist_ok=True)
                    owner.raw.write_bytes(owner.raw_bytes)
                elif args[:2] == ['convert', 'serialize']:
                    owner.serialized.write_text(json.dumps({
                        'Header': {'ArchiveFileName': str(owner.raw.resolve())},
                        'Data': {'RootChunk': {'marker': 'new serializer output'}}
                    }), encoding='utf-8')
                else:
                    raise AssertionError('Unexpected native operation')

        self.fake_job = FakeJob

    def export(self):
        entry = {str(fnv(self.depot, 64)): {
            'archiveEntrySha1': __import__('hashlib').sha1(self.raw_bytes).hexdigest(),
            'segments': 1, 'storedBytes': len(self.raw_bytes), 'decodedBytes': len(self.raw_bytes)}}
        args = ['extract_scene_evidence.py', '--project', str(self.project), '--game', str(self.game),
                '--batch', 'test-native', '--resource-kind', 'questphase', '--depot', self.depot]
        with patch.object(sys, 'argv', args), patch.object(exporter, 'Job', self.fake_job), \
             patch.object(exporter, 'read_archive_index', return_value=entry), \
             patch.object(exporter, 'index_exports', return_value={'complete': True}), \
             contextlib.redirect_stdout(io.StringIO()):
            exporter.main()

    def manifest(self):
        return json.loads((self.output / 'inventory.json').read_text(encoding='utf-8'))

    def test_fresh_questphase_binds_native_and_serialized_bytes(self):
        self.export()
        asset = self.manifest()['assets'][0]
        self.assertEqual(asset['assetSha256'], digest(self.raw))
        self.assertEqual(asset['jsonSha256'], digest(self.serialized))
        self.assertEqual(len(self.calls), 2)

    def test_unchanged_qualified_json_is_not_reserialized(self):
        self.export()
        old_hash = self.manifest()['assets'][0]['jsonSha256']
        self.calls.clear()
        self.export()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.manifest()['assets'][0]['jsonSha256'], old_hash)

    def test_unbound_json_is_reserialized_instead_of_retroactively_hashed(self):
        self.export()
        manifest = self.manifest()
        manifest['assets'][0].pop('jsonSha256')
        (self.output / 'inventory.json').write_text(json.dumps(manifest), encoding='utf-8')
        document = json.loads(self.serialized.read_text(encoding='utf-8'))
        document['Data']['RootChunk']['marker'] = 'unqualified altered JSON'
        self.serialized.write_text(json.dumps(document), encoding='utf-8')
        self.calls.clear()
        self.export()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][0][:2], ['convert', 'serialize'])
        self.assertEqual(json.loads(self.serialized.read_text())['Data']['RootChunk']['marker'],
                         'new serializer output')
        self.assertEqual(self.manifest()['assets'][0]['jsonSha256'], digest(self.serialized))

    def test_changed_qualified_json_is_rejected_and_original_hash_is_preserved(self):
        self.export()
        old_hash = self.manifest()['assets'][0]['jsonSha256']
        self.serialized.write_text(self.serialized.read_text() + ' ', encoding='utf-8')
        self.calls.clear()
        with self.assertRaisesRegex(RuntimeError, 'Previously qualified JSON changed'):
            self.export()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.manifest()['assets'][0]['jsonSha256'], old_hash)

    def test_raw_bytes_must_still_match_the_current_archive_entry(self):
        self.export()
        old = self.manifest()['assets'][0]
        self.raw.write_bytes(b'changed raw fixture')
        with self.assertRaisesRegex(RuntimeError, 'archive payload mismatch'):
            self.export()
        self.assertEqual(self.manifest()['assets'][0]['jsonSha256'], old['jsonSha256'])


if __name__ == '__main__':
    unittest.main()
