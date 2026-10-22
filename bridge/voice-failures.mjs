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

/**
 * The line of a worker's stderr that says why it died: the last one that names an error (a Python exception, an out-of-memory error, a Windows
 * fatal exception), else the last line. Short, no control characters; a report removes any folder from it.
 */
export function stderrReason(tail, limit = 160) {
  const lines = String(tail ?? '').split(/\r?\n/).map(line => line.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return '';
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
