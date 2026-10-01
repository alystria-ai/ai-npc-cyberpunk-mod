import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Python reference boundary and serial profile protocol pass offline without CUDA', () => {
  const result = spawnSync(process.env.CYBERPUNK_TEST_PYTHON || 'python',
    ['-B', fileURLToPath(new URL('../scripts/test_prepare_local_voices.py', import.meta.url))],
    {encoding: 'utf8', windowsHide: true, timeout: 30_000});
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /OK/);
});

test('isolated cast auditions preserve references and own one worker without loading CUDA in tests', () => {
  const result = spawnSync(process.env.CYBERPUNK_TEST_PYTHON || 'python',
    ['-B', fileURLToPath(new URL('../scripts/test_generate_voice_cast_auditions.py', import.meta.url))],
    {encoding: 'utf8', windowsHide: true, timeout: 30_000});
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /OK/);
});
