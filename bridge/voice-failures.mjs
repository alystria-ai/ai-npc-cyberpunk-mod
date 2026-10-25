// What a failed local voice worker says, and which failures will repeat. Asking again cannot change a failure of this PC's setup (a file that is
// not the pinned one, a file that is not there, a Windows policy), and every try is a rehash of hundreds of megabytes or a model load of several
// gigabytes beside the game and Local AI: bridge/voice-selection.mjs does not retry those, says so once, and leaves the fix to the player
// (the Runtime update, the Windows policy). 2026-10-22 review of 367 player reports: one install logged 18 retries of a source-integrity
// failure, and 11 OmniVoice retries followed an exit whose reason nobody could read.

// An exit code of a Windows process that stopped on a fault: the NTSTATUS value, read as unsigned (Node reports it so).
const EXIT_CODES = new Map([
  [0xC0000005, 'access violation'], [0xC00000FD, 'stack overflow'], [0xC0000409, 'fast-fail (stack buffer overrun)'],
  [0xC0000374, 'heap corruption'], [0xC0000135, 'a DLL was not found'], [0xC0000139, 'a DLL entry point was not found'],
  [0xC0000142, 'a DLL could not start'], [0xC000001D, 'illegal instruction'], [0xC0000096, 'privileged instruction'],
  [0xC000013A, 'stopped with Ctrl+C'], [0xE06D7363, 'unhandled C++ exception'], [0xC06D007E, 'a module was not found'],
]);

/** The exit code in words for the log and the report: "3221225477 = access violation (0xC0000005)", or just the number. */
export function describeExitCode(code) {
  if (!Number.isInteger(code)) return String(code ?? 'unknown');
  const unsigned = code < 0 ? code + 2 ** 32 : code;
  const meaning = EXIT_CODES.get(unsigned);
  return meaning ? `${code} = ${meaning} (0x${unsigned.toString(16).toUpperCase()})` : String(code);
}

// Windows ran out of memory it can promise ("commit": RAM plus the paging file), error 1455 (ERROR_COMMITMENT_LIMIT): "The paging file is too small for this operation
// to complete" in a safetensors load, an ImportError of a DLL, or `import torch`. A page file that is small, fixed or switched off, beside the game and Local AI. Asking again
// cannot change it. 2026-10-22 reports (one RTX 5090 test box): the OmniVoice worker and both Pocket workers failed this way, with an access violation (3221225477) in the
// workers that died in the middle of a load, and the retries (45 s, 180 s) loaded the models again each time.
const PAGING_FILE_WORDS = /paging file (?:is )?too small|\b(?:win)?(?:error|errno)\W{0,3}1455\b|ERROR_COMMITMENT_LIMIT/i;
const ACCESS_VIOLATION = /\b3221225477\b|0xC0000005|access violation/i;
const COMMIT_CODE = /\b1455\b/;

/**
 * Windows is out of commit (the paging file is too small): the words, the code 1455, or an access violation (exit 3221225477) that comes together with a 1455 line. Takes
 * a worker's stderr (or its tail) or the failure line built from it.
 */
export const pagingFileFailed = text => {
  const value = String(text ?? '');
  return PAGING_FILE_WORDS.test(value) || (ACCESS_VIOLATION.test(value) && COMMIT_CODE.test(value));
};

// A faulthandler dump lists the crashing thread's frames innermost first ("Current thread 0x... (most recent call first):", then `  File "x.py", line 117 in forward`
// per frame), so the last line of the dump is the outermost frame, the worker's own `<module>` call. Reports of 2026-10-24 and 25 (three installs) named only that line
// and nothing of where the native code failed. This gives the innermost frames, as "x.py:117 forward < y.py:1750 _call_impl", with no folder.
function faultFrames(lines) {
  const at = lines.findLastIndex(line => /^Current thread\b.*most recent call first/i.test(line));
  if (at < 0) return '';
  const frames = [];
  for (const line of lines.slice(at + 1)) {
    const frame = /^File "([^"]*)", line (\d+) in (\S+)/.exec(line);
    if (!frame) break;
    if (frames.length < 4) frames.push(`${frame[1].split(/[\\/]/).pop()}:${frame[2]} ${frame[3]}`);
  }
  return frames.length ? `fault in ${frames.join(' < ')}` : '';
}

/**
 * The line of a worker's stderr that says why it died: the last one that names an error (a Python exception, an out-of-memory error, a Windows
 * fatal exception), else the last line. Short, no control characters; a report removes any folder from it. A paging-file line (pagingFileFailed) wins over
 * later lines: the access violation or the traceback end that follows it is only the aftermath, and the line is what the retry logic recognises.
 */
export function stderrReason(tail, limit = 160) {
  const lines = String(tail ?? '').split(/\r?\n/).map(line => line.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return '';
  const paging = [...lines].reverse().find(line => PAGING_FILE_WORDS.test(line))
    ?? (lines.some(line => ACCESS_VIOLATION.test(line)) ? [...lines].reverse().find(line => COMMIT_CODE.test(line)) : undefined);
  if (paging) return paging.slice(0, limit);
  const fault = faultFrames(lines);
  if (fault) return fault.slice(0, limit);
  const named = [...lines].reverse().find(line => /(?:error|exception|exit|out of memory|fatal|violation|cuda|failed|cannot|could not)/i.test(line));
  return (named ?? lines.at(-1)).slice(0, limit);
}

/** A worker that stopped on a memory fault (exit 3221225477, 0xC0000005): the CUDA graph is the first suspect, tried off once. */
export const accessViolationFailed = reason => /\b3221225477\b|0xC0000005|access violation/i.test(String(reason ?? ''));

/**
 * Pocket files that are not the ones the runtime pins, or are not there: a source that differs from the pinned revision, an export asset or its
 * receipt that does not match, assets missing, a worker whose attested version or identity is not the expected one. The same on every try, until the
 * Runtime is updated or repaired.
 */
export const pocketIntegrityFailed = reason => /differs from the pinned|does not match its pinned digest|did not resolve to the pinned|runtime assets are missing|configuration\/receipt is missing|export asset (?:is missing|differs)|needs hashes for every export asset|receipt does not identify|did not attest the selected|did not confirm the configured reference|accepts only the CPU six-layer|inference config is (?:incomplete|oversized)/i.test(String(reason ?? ''));

/** A file or a Python module the worker needs is not there (an incomplete install): the same on every try. */
export const missingFilesFailed = reason => /FileNotFoundError|No such file or directory|ModuleNotFoundError|No module named|cannot find the (?:file|path) specified|assets? (?:is|are) missing/i.test(String(reason ?? ''));
