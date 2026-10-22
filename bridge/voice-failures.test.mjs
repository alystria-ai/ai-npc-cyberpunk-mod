import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeExitCode, stderrReason, accessViolationFailed, pocketIntegrityFailed, missingFilesFailed} from './voice-failures.mjs';

test('Windows fault exit codes are named, other codes stay plain numbers', () => {
  assert.equal(describeExitCode(3221225477), '3221225477 = access violation (0xC0000005)');
  assert.equal(describeExitCode(-1073741819), '-1073741819 = access violation (0xC0000005)', 'a signed reading is the same fault');
  assert.equal(describeExitCode(3221226505), '3221226505 = fast-fail (stack buffer overrun) (0xC0000409)');
  assert.equal(describeExitCode(1), '1'); assert.equal(describeExitCode(null), 'unknown'); assert.equal(describeExitCode(70), '70');
});

test('the reason is the last stderr line that names an error, short and without control characters', () => {
  assert.equal(stderrReason('a\nTraceback (most recent call last):\n  File "x.py", line 3\nValueError: bad thing\n\n'), 'ValueError: bad thing');
  assert.equal(stderrReason('loading\nshards 3/3\n'), 'shards 3/3', 'no error line: the last one');
  assert.equal(stderrReason('RuntimeError: ' + 'x'.repeat(400)).length, 160);
  assert.equal(stderrReason('Error: a\u0007b\r\n'), 'Error: a b'); assert.equal(stderrReason(''), ''); assert.equal(stderrReason(undefined), '');
});

test('the failure classes that repeat are recognised by their words', () => {
  assert.equal(accessViolationFailed('Local voice worker exited (3221225477 = access violation (0xC0000005))'), true);
  assert.equal(accessViolationFailed('Local voice worker exited (1)'), false);
  for (const reason of ['Pocket student runtime is unavailable (Pocket source differs from the pinned official revision (3 files))', 'Pocket export asset differs from its selected identity',
    'Pocket runtime assets are missing', 'Pocket worker did not attest the selected CPU student', 'Pocket receipt does not identify the selected student export']) assert.equal(pocketIntegrityFailed(reason), true, reason);
  for (const reason of ['Pocket student startup timed out', 'Pocket worker exited (1)', 'Pocket generation stopped; restart the local voice service']) assert.equal(pocketIntegrityFailed(reason), false, reason);
  assert.equal(missingFilesFailed('Local voice worker exited (1): FileNotFoundError: [Errno 2] No such file or directory'), true);
  assert.equal(missingFilesFailed('ModuleNotFoundError: No module named torch'), true);
  assert.equal(missingFilesFailed('Local voice startup timed out'), false);
});
