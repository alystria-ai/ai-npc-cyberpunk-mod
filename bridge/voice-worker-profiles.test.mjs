import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('portable worker resolves copied application assets and separate data without CUDA', () => {
  const result = spawnSync(process.env.CYBERPUNK_TEST_PYTHON || 'python',
    ['-B', fileURLToPath(new URL('../scripts/test_resident_voice_paths.py', import.meta.url)), '-v'],
    {encoding: 'utf8', windowsHide: true, timeout: 30_000});
  assert.equal(result.error, undefined, [result.error?.message, result.stderr, result.stdout].filter(Boolean).join('\n'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /OK/);
});

test('Python reference boundary and serial profile protocol pass offline without CUDA', () => {
  const result = spawnSync(process.env.CYBERPUNK_TEST_PYTHON || 'python',
    ['-B', fileURLToPath(new URL('../scripts/test_prepare_local_voices.py', import.meta.url)), '-v'],
    {encoding: 'utf8', windowsHide: true, timeout: 30_000});
  assert.equal(result.error, undefined, [result.error?.message, result.stderr, result.stdout].filter(Boolean).join('\n'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /OK/);
});

test('isolated cast auditions preserve references and own one worker without loading CUDA in tests', () => {
  // This complete Python suite includes many temporary reference/evidence
  // writes. Keep a hard process deadline with room for the parallel JS suite.
  const result = spawnSync(process.env.CYBERPUNK_TEST_PYTHON || 'python',
    ['-B', fileURLToPath(new URL('../scripts/test_generate_voice_cast_auditions.py', import.meta.url)), '-v'],
    {encoding: 'utf8', windowsHide: true, timeout: 60_000});
  assert.equal(result.error, undefined, [result.error?.message, result.stderr, result.stdout].filter(Boolean).join('\n'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /OK/);
});
