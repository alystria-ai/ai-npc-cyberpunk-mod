// The data files the conversation bridge cannot start without, and what happens when one is not there (docs/ERROR_REPORTS.md, 2026-10-19:
// the first player report of a bridge that died five times in a row on "ENOENT: no such file or directory, open ...").
//
// A Runtime that was extracted only partly (an antivirus that removed a file, a copy that stopped half way, a folder merged over an older
// version) has the bridge's code but not all of its data. The bridge reads these files before it answers anything, so with one missing
// it can do nothing, and Node's own answer, an uncaught exception, only started it again and again until the supervisor gave up with
// "bridge-crashed" (a message that says nothing about the cause). Now:
//   * the supervisor (bridge/bridge-supervisor.mjs) looks for the files before it starts the bridge: a Runtime that lacks one is the
//     service status `install-incomplete`, which the game already explains ("The Runtime is incomplete ... Download it again and extract it
//     into the Cyberpunk 2077 folder") and which is looked at again every few seconds, so it recovers once the file is back;
//   * the bridge reads them with `readRequiredJson`: a missing file ends the process at once with INCOMPLETE_EXIT_CODE and one plain line
//     in the log, never a stack trace, and the supervisor takes that exit as `install-incomplete` too (no restart loop).
// Only file names relative to the Runtime's app folder are ever logged: never a folder, which can hold the Windows user name.
import {access, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

/** Read at the bridge's start, with no fallback that would let it work: the roster, the world knowledge, the quest list and the phone contacts. */
export const RUNTIME_DATA_FILES = Object.freeze([
  'characters/roster.json',
  'characters/world-knowledge.json',
  'characters/phone-contacts.json',
  'research/cyberpunk/generated/quest-catalog.json',
]);

/** The bridge's exit code for "a data file of the Runtime is missing" (EX_CONFIG); the supervisor does not restart it. */
export const INCOMPLETE_EXIT_CODE = 78;

/** The names of `files` that are not under `project` (an unreadable one counts as missing). Never throws. */
export async function missingRuntimeFiles(project, files = RUNTIME_DATA_FILES, {exists = access} = {}) {
  const missing = [];
  for (const name of files) {
    try { await exists(resolve(project, name)); } catch { missing.push(name); }
  }
  return missing;
}

/** What a missing Runtime file is called in the log: the one line the player and the support report read. */
export const incompleteMessage = names => `The Runtime is incomplete: ${[].concat(names).join(', ')} ${[].concat(names).length === 1 ? 'is' : 'are'} missing. `
  + 'Download the Runtime again and extract it into the Cyberpunk 2077 folder, then restart the game.';

export class RuntimeIncomplete extends Error {
  constructor(file) {
    super(incompleteMessage(file));
    this.name = 'RuntimeIncomplete'; this.code = 'RUNTIME_INCOMPLETE'; this.file = file;
  }
}

/** The JSON of `name` under `project`. A file that is not there is a RuntimeIncomplete (named by `name`, never by its folder); any other fault is rethrown as it is. */
export async function readRequiredJson(project, name, {read = readFile} = {}) {
  let text;
  try { text = await read(resolve(project, name), 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new RuntimeIncomplete(name);
    throw error;
  }
  return JSON.parse(text);
}

/**
 * For the bridge's top level: the error of a required file ends the process cleanly (one log line, INCOMPLETE_EXIT_CODE); any other error is
 * thrown on, so a damaged file is still the crash it was.
 */
export function endIfIncomplete(error, {log = message => console.error('[CyberpunkConvai] ' + message), exit = code => process.exit(code)} = {}) {
  if (!(error instanceof RuntimeIncomplete)) throw error;
  log(error.message);
  exit(INCOMPLETE_EXIT_CODE);
  throw error;   // an exit that did not end the process (a test's): the caller does not go on with no data
}

// File errors that come from the player's folders changing under a read: a file another program holds for a moment, one that was moved or
// removed between listing and opening. A read nobody waits for that fails this way is not a reason to stop the whole service.
const TRANSIENT_FILE_ERRORS = new Set(['ENOENT', 'EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE', 'EEXIST', 'EIO', 'ETXTBSY', 'UNKNOWN']);

/** True for a rejected file operation of the kind above (an fs error carries `syscall` and a code). */
export const isTransientFileError = error => typeof error?.code === 'string' && TRANSIENT_FILE_ERRORS.has(error.code) && typeof error?.syscall === 'string';

/**
 * Keeps a promise that rejected with a transient file error and that nobody awaited (a poll's `await readFile(...)` on a path that went away)
 * from ending the bridge: it is logged and the bridge goes on. Every other unhandled rejection is thrown on, exactly the crash Node would have
 * made (and the crash capture of bridge/error-events.mjs records it). `record(error)` is told of the swallowed one, for the error reports.
 */
export function installFileErrorGuard({processRef = process, log = message => console.error('[CyberpunkConvai] ' + message), record = () => {}} = {}) {
  const listener = error => {
    if (!isTransientFileError(error)) throw error;
    try { record(error); } catch { /* a report never changes what the guard does */ }
    log(`A file operation failed and nothing was waiting for it (${error.code}, ${error.syscall}); the service goes on.`);
  };
  processRef.on('unhandledRejection', listener);
  return () => processRef.removeListener('unhandledRejection', listener);
}
