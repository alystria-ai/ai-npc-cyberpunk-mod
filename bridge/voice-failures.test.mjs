import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeExitCode, stderrReason, accessViolationFailed, pagingFileFailed, pocketIntegrityFailed, missingFilesFailed} from './voice-failures.mjs';

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

test('a Windows paging-file failure (error 1455) is recognised by its words, its code, or an access violation that comes with a 1455 line (reports 7a95278d, 24332da7, d00cebaf)', () => {
  for (const text of ['OSError: The paging file is too small for this operation to complete. (os error 1455)',
    'ImportError: DLL load failed while importing _lbfgsb: The paging file is too small for this operation to complete.',
    'OSError: [WinError 1455] Error loading "C:\\x\\torch\\lib\\shm.dll" or one of its dependencies.', 'RuntimeError: error 1455', 'ERROR_COMMITMENT_LIMIT',
    'Local voice worker exited (3221225477 = access violation (0xC0000005)): OSError: 1455',
    'Windows fatal exception: access violation\nOSError: (1455) not enough memory']) assert.equal(pagingFileFailed(text), true, text);
  for (const text of ['Local voice worker exited (3221225477 = access violation (0xC0000005))', 'Windows fatal exception: access violation', 'Local voice worker exited (1)',
    'torch.OutOfMemoryError: CUDA out of memory', 'step 1455 of 3000', 'line 1455, in load', undefined, null, '']) assert.equal(pagingFileFailed(text), false, String(text));
});

test('the reason line of a worker that died of a full commit limit is the paging-file line, not the crash that follows it', () => {
  const tail = 'loading shards\nOSError: The paging file is too small for this operation to complete. (os error 1455)\nWindows fatal exception: access violation\n';
  assert.equal(stderrReason(tail), 'OSError: The paging file is too small for this operation to complete. (os error 1455)');
  assert.equal(pagingFileFailed(`Local voice worker exited (3221225477 = access violation (0xC0000005)): ${stderrReason(tail)}`), true);
  // A 1455 line with no words, beside an access violation of the same tail.
  const bare = 'Traceback (most recent call last):\n  File "x.py", line 3\nOSError: 1455\nWindows fatal exception: access violation\n';
  assert.equal(stderrReason(bare), 'OSError: 1455');
  assert.equal(stderrReason('step 1455\nValueError: bad thing\n'), 'ValueError: bad thing', 'a bare 1455 with no access violation is only a number');
});

test('the failure classes that repeat are recognised by their words', () => {
  assert.equal(accessViolationFailed('Local voice worker exited (3221225477 = access violation (0xC0000005))'), true);
  assert.equal(accessViolationFailed('Local voice worker exited (1)'), false);
  for (const reason of ['Pocket student runtime is unavailable (Pocket source differs from the pinned official revision (3 files))', 'Pocket export asset differs from its selected identity',
    'Pocket worker did not attest the selected CPU student', 'Pocket receipt does not identify the selected student export']) assert.equal(pocketIntegrityFailed(reason), true, reason);
  for (const reason of ['Pocket student startup timed out', 'Pocket worker exited (1)', 'Pocket generation stopped; restart the local voice service']) assert.equal(pocketIntegrityFailed(reason), false, reason);
  assert.equal(missingFilesFailed('Local voice worker exited (1): FileNotFoundError: [Errno 2] No such file or directory'), true);
  assert.equal(missingFilesFailed('ModuleNotFoundError: No module named torch'), true);
  assert.equal(missingFilesFailed('Local voice startup timed out'), false);
  // A Pocket folder that is not there (the worker names which) is an incomplete install, not files that differ from the pinned ones.
  assert.equal(pocketIntegrityFailed('Pocket runtime assets are missing (export)'), false);
  assert.equal(missingFilesFailed('Pocket student runtime is unavailable (ValueError: Pocket runtime assets are missing (export, reference))'), true);
});

test('the reason of a worker that died on a native fault names the innermost frames of the crashing thread, not its outermost <module> line', () => {
  const dump = ['loading', 'Windows fatal exception: access violation', '', 'Thread 0x00001a2c (most recent call first):', '  File "C:\\r\\threading.py", line 324 in wait', '',
    'Current thread 0x00000c10 (most recent call first):', '  File "C:\\Games\\app\\python\\Lib\\site-packages\\torch\\nn\\modules\\linear.py", line 117 in forward',
    '  File "C:\\Games\\app\\python\\Lib\\site-packages\\torch\\nn\\modules\\module.py", line 1750 in _call_impl', '  File "C:\\Games\\app\\bridge\\pocket-voice-worker.py", line 520 in generate',
    '  File "C:\\Games\\app\\bridge\\pocket-voice-worker.py", line 640 in serve', '  File "C:\\Games\\app\\bridge\\pocket-voice-worker.py", line 881 in <module>', ''].join('\r\n');
  assert.equal(stderrReason(dump), 'fault in linear.py:117 forward < module.py:1750 _call_impl < pocket-voice-worker.py:520 generate < pocket-voice-worker.py:640 serve');
  assert.equal(stderrReason(dump).includes('Games'), false, 'no folder');
  assert.equal(stderrReason(dump.split('Current thread')[0]), 'Windows fatal exception: access violation', 'no crashing-thread block: the old rule');
  assert.match(stderrReason('OSError: The paging file is too small for this operation to complete. (os error 1455)\r\n' + dump), /paging file/, 'a paging-file line still wins');
});
