// The speech worker's handling of a pause before the first word (the live regression of 2026-10-14: a 66-character live decode and then
// an empty final, and the next presses hearing nothing). Runs bridge/local-stt-worker.check.py in a Python that has numpy; skipped when
// none is found (set CYBERPUNK_CONVAI_PYTHON to one). No model, no sound.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
function findPython() {
  if (process.env.CYBERPUNK_CONVAI_PYTHON && existsSync(process.env.CYBERPUNK_CONVAI_PYTHON)) return process.env.CYBERPUNK_CONVAI_PYTHON;
  for (let dir = resolve(here, '..'), i = 0; i < 6; i += 1, dir = dirname(dir)) {
    const candidate = join(dir, 'vendor', 'pocket-tts-env', 'Scripts', 'python.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
const python = findPython();

test('worker: a pause before the first word, empty answers, same id back to back, an empty full decode', {skip: !python && 'no Python with numpy found'}, () => {
  const output = execFileSync(python, ['-I', join(here, 'local-stt-worker.check.py'), join(here, 'local-stt-worker.py')],
    {encoding: 'utf8', timeout: 120000});
  assert.match(output, /ok\s*$/);
});
