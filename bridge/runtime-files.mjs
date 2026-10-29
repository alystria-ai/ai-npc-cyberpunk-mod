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
import {posix, resolve} from 'node:path';

/** Read at the bridge's start, with no fallback that would let it work: the roster, the world knowledge, the quest list and the phone contacts. */
export const RUNTIME_DATA_FILES = Object.freeze([
  'characters/roster.json',
  'characters/world-knowledge.json',
  'characters/phone-contacts.json',
  'research/cyberpunk/generated/quest-catalog.json',
]);

/**
 * Files of the Node packages the bridge imports (packaging/release.config.json `nodePackages`): a Runtime extracted only partly, or one an
 * antivirus removed files from, can lack the whole package or one file deep inside it (2026-10-19, two reports: "Cannot find package
 * 'playwright'" and "Cannot find module './dispatchers/dispatcher'" inside playwright-core), and the bridge then dies at its first import,
 * before it can say anything. The last name is the file that was missing in the second report.
 */
export const RUNTIME_PACKAGE_FILES = Object.freeze([
  'node_modules/playwright/package.json',
  'node_modules/playwright-core/package.json',
  'node_modules/playwright-core/lib/server/dispatchers/dispatcher.js',
]);

/** Everything the supervisor looks for before it starts the bridge. */
export const RUNTIME_REQUIRED_FILES = Object.freeze([...RUNTIME_DATA_FILES, ...RUNTIME_PACKAGE_FILES]);

/** The bridge's exit code for "a data file of the Runtime is missing" (EX_CONFIG); the supervisor does not restart it. */
export const INCOMPLETE_EXIT_CODE = 78;

const slashes = text => String(text).replace(/\\/g, '/');

/** A file Node named, as the Runtime names it: relative to `project` when it is under it, else from its node_modules folder on, else its file name. */
function runtimeName(path, project) {
  const clean = posix.normalize(slashes(path).replace(/^file:\/\/\/?/i, ''));
  const root = project ? posix.normalize(slashes(project)).replace(/\/+$/, '') : '';
  if (root && clean.toLowerCase().startsWith(root.toLowerCase() + '/')) return clean.slice(root.length + 1);
  const modules = clean.toLowerCase().indexOf('/node_modules/');
  if (modules >= 0) return clean.slice(modules + 1);
  return posix.basename(clean);
}

// Node's ESM SyntaxError when a module imports a name the file it imports does not have: "The requested module './x.mjs' does not provide an export named 'y'". Files of two
// versions side by side (the Runtime of an earlier version under newer Scripts, an update zip applied over the wrong base, 0.2.5 report: Scripts 0.2.5 with Runtime 0.2.2, the bridge
// ended at once six times) end this way, and starting again ends the same way.
const NO_EXPORT = /The requested module '([^']+)' does not provide an export named/;

/** Does the bridge's stderr say that a file it imports does not match the file that imports it (see NO_EXPORT)? */
export const versionMismatchInLog = text => NO_EXPORT.test(slashes(text ?? ''));

/** The file named by such a message, relative to the Runtime ("bridge/x.mjs"; a package as `node_modules/<name>`), or null. */
function mismatchedModuleIn(log, project) {
  const found = NO_EXPORT.exec(log);
  if (!found) return null;
  const specifier = found[1];
  if (/^(?:[A-Za-z]:)?\//.test(specifier) || /^file:/i.test(specifier)) return runtimeName(specifier, project);
  if (!/^\.\.?\//.test(specifier)) return `node_modules/${specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')}`;
  // A relative specifier: relative to the file that imports it, the last "file:///...:line" heading before the message.
  const heading = [...log.slice(0, found.index).matchAll(/^(?:file:\/\/\/)?(.+?\.[cm]?js):\d+\s*$/gm)].pop();
  return heading ? runtimeName(posix.join(posix.dirname(slashes(heading[1]).trim()), specifier), project) : posix.basename(specifier);
}

/**
 * What the bridge's own stderr (the text since its last start) says when Node could not load one of its files or packages: a package, a file
 * of it or a module of the bridge that is not there. Returns that file as a name relative to the Runtime (`node_modules/playwright`,
 * `node_modules/playwright-core/lib/server/dispatchers/dispatcher`; never a folder of the player's) or null when the log says something else.
 * The three messages Node gives: ESM "Cannot find package 'x' imported from ...", ESM "Cannot find module '<path>' imported from ...", and
 * CommonJS "Cannot find module '<specifier>'" with the file that asked for it on the "Require stack:" line after it.
 */
export function missingModuleInLog(text, project = '') {
  const log = slashes(text ?? '');
  const mismatched = mismatchedModuleIn(log, project);
  if (mismatched) return mismatched;
  const bare = /Cannot find package '([^']+)' imported from/.exec(log);
  if (bare) return `node_modules/${bare[1].split('/').slice(0, bare[1].startsWith('@') ? 2 : 1).join('/')}`;
  const found = /Cannot find module '([^']+)'([\s\S]{0,40}imported from)?/.exec(log);
  if (!found) return null;
  const specifier = found[1];
  if (found[2] || /^(?:[A-Za-z]:)?\//.test(specifier) || /^file:/i.test(specifier)) return runtimeName(specifier, project);
  if (!/^\.\.?\//.test(specifier)) return `node_modules/${specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')}`;
  // A relative specifier: it is relative to the first file of the require stack.
  const requirer = /Require stack:\s*\n\s*-\s*([^\n]+)/.exec(log);
  if (!requirer) return posix.basename(specifier);
  return runtimeName(posix.join(posix.dirname(slashes(requirer[1]).trim()), specifier), project);
}

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
  + 'Extract the full install zip (AI-NPC-LLM-Companions, on Nexus Mods) into the Cyberpunk 2077 folder again, then restart the game.';

/** The line for files of two versions (versionMismatchInLog): the full install zip again (it holds the Runtime and the code of one version). */
export const mismatchMessage = name => `The Runtime does not match the mod's Scripts: ${name} comes from a different version. `
  + 'Extract the full install zip (AI-NPC-LLM-Companions, on Nexus Mods) into the Cyberpunk 2077 folder again, then restart the game.';

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
const TRANSIENT_FILE_ERRORS = new Set(['ENOENT', 'EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE', 'EEXIST', 'EIO', 'ETXTBSY', 'UNKNOWN',
  // A full disk or an exceeded quota: a write nobody waits for that fails this way is lost, never a reason to stop the service (error report 1cbe337a5144ebbd).
  'ENOSPC', 'EDQUOT']);

/** True for a write that failed because the disk or the player's quota is full (ENOSPC, EDQUOT). */
export const isDiskFull = error => error?.code === 'ENOSPC' || error?.code === 'EDQUOT';

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
