import {existsSync, readFileSync, statSync} from 'node:fs';
import {isAbsolute, join, win32} from 'node:path';
import {spawnSync} from 'node:child_process';

// The hidden browser is not shipped with the mod: it is the Microsoft Edge that comes with Windows 10 and 11, or, where Edge was
// removed, an installed Google Chrome. Both are Chromium, which Playwright drives by "channel". Edge is tried first.
export const SYSTEM_BROWSERS = Object.freeze([
  Object.freeze({channel: 'msedge', name: 'Microsoft Edge', file: 'Microsoft\\Edge\\Application\\msedge.exe', appPath: 'msedge.exe'}),
  Object.freeze({channel: 'chrome', name: 'Google Chrome', file: 'Google\\Chrome\\Application\\chrome.exe', appPath: 'chrome.exe'}),
]);

// Other installed Chromium browsers, tried after Edge and Chrome. Playwright drives any Chromium through `executablePath`, so these
// have no channel: their folders (and, for those that register one, their App Paths entry) say where the program is. `file` is one
// path under an install root, or several (a per-user and an all-users install). The more niche ones may refuse to start without a
// window; a launch that fails just moves on to the next. Firefox is left out on purpose: Playwright drives only its own patched
// Firefox build, never an installed one, so the player's Firefox cannot run the conversation page.
export const OTHER_CHROMIUM_BROWSERS = Object.freeze([
  Object.freeze({name: 'Microsoft Edge Beta', file: 'Microsoft\\Edge Beta\\Application\\msedge.exe'}),
  Object.freeze({name: 'Microsoft Edge Dev', file: 'Microsoft\\Edge Dev\\Application\\msedge.exe'}),
  Object.freeze({name: 'Microsoft Edge Canary', file: 'Microsoft\\Edge SxS\\Application\\msedge.exe'}),
  Object.freeze({name: 'Google Chrome Beta', file: 'Google\\Chrome Beta\\Application\\chrome.exe'}),
  Object.freeze({name: 'Google Chrome Dev', file: 'Google\\Chrome Dev\\Application\\chrome.exe'}),
  Object.freeze({name: 'Google Chrome Canary', file: 'Google\\Chrome SxS\\Application\\chrome.exe'}),
  Object.freeze({name: 'Brave', file: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', appPath: 'brave.exe'}),
  Object.freeze({name: 'Vivaldi', file: 'Vivaldi\\Application\\vivaldi.exe', appPath: 'vivaldi.exe'}),
  // Opera installs per user under %LOCALAPPDATA%\Programs (its default), or for all users under Program Files; Opera GX the same.
  Object.freeze({name: 'Opera', file: ['Programs\\Opera\\opera.exe', 'Opera\\opera.exe'], appPath: 'opera.exe'}),
  Object.freeze({name: 'Opera GX', file: ['Programs\\Opera GX\\opera.exe', 'Opera GX\\opera.exe']}),
  Object.freeze({name: 'Chromium', file: 'Chromium\\Application\\chrome.exe'}),
  Object.freeze({name: 'Thorium', file: 'Thorium\\Application\\thorium.exe'}),
  Object.freeze({name: 'Yandex Browser', file: 'Yandex\\YandexBrowser\\Application\\browser.exe'}),
  Object.freeze({name: 'Coc Coc', file: 'CocCoc\\Browser\\Application\\browser.exe'}),
  Object.freeze({name: 'Epic Privacy Browser', file: 'Epic Privacy Browser\\Application\\epic.exe'}),
  Object.freeze({name: 'Avast Secure Browser', file: 'AVAST Software\\Browser\\Application\\AvastBrowser.exe'}),
  Object.freeze({name: 'AVG Secure Browser', file: 'AVG\\Browser\\Application\\AVGBrowser.exe'}),
]);

// The player's own way out when a browser is installed where nothing looks: a plain text file with the path of its program, in the
// plugin folder beside launcher.ini (the Runtime's start script reads it, see readBrowserOverride). Never shipped, never removed by an update.
export const BROWSER_OVERRIDE_FILE = 'browser.txt';

export const NO_BROWSER_MESSAGE = `No browser to run the conversation page: install a Chromium browser such as Microsoft Edge (free from microsoft.com/edge), Google Chrome, Brave or Opera, or write the path of the one you have in ${BROWSER_OVERRIDE_FILE} next to launcher.ini.`;

// The program names of the Chromium browsers the lookups below accept when they read the Windows registry (the default browser, the
// browsers registered as Start menu clients): a name here is a browser Playwright can drive. Firefox is never one of them.
const CHROMIUM_PROGRAMS = Object.freeze({
  'msedge.exe': 'Microsoft Edge', 'chrome.exe': 'Google Chrome', 'brave.exe': 'Brave', 'vivaldi.exe': 'Vivaldi', 'opera.exe': 'Opera',
  'thorium.exe': 'Thorium', 'chromium.exe': 'Chromium', 'epic.exe': 'Epic Privacy Browser', 'avastbrowser.exe': 'Avast Secure Browser',
  'avgbrowser.exe': 'AVG Secure Browser', 'browser.exe': null,
});
const programOf = path => win32.basename(String(path ?? '')).toLowerCase();
/** True for the program of a Chromium browser the mod knows (never Firefox). */
export const isChromiumProgram = path => Object.hasOwn(CHROMIUM_PROGRAMS, programOf(path));
/** A readable name for the browser at `path` ("Brave"), or null when its program does not say (browser.exe is Yandex's and Coc Coc's). */
export function browserNameFor(path) {
  const program = programOf(path);
  if (program === 'browser.exe') return /yandex/i.test(path) ? 'Yandex Browser' : /coccoc/i.test(path) ? 'Coc Coc' : null;
  return Object.hasOwn(CHROMIUM_PROGRAMS, program) ? CHROMIUM_PROGRAMS[program] : null;
}

const APP_PATHS = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths';
const REGISTRY_KEYS = [`HKCU\\${APP_PATHS}`, `HKLM\\${APP_PATHS}`, 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths'];
const REGISTRY_TIMEOUT_MS = 3000;

const installRoots = env => [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(root => typeof root === 'string' && root);
const found = (exists, path) => { try { return !!exists(path); } catch { return false; } };

// The default value printed by one `reg query <key> /ve`: a path, quoted or not, with %VARIABLES% expanded. Localized Windows names
// the value differently, so the line is recognised by its REG_SZ / REG_EXPAND_SZ type. null when the output holds no usable path.
export function parseAppPath(output, env = process.env) {
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /\sREG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    let path = match[1].trim().replace(/^"([^"]*)".*$/, '$1');
    path = path.replace(/%([^%]+)%/g, (whole, name) => env[name] ?? env[name.toUpperCase()] ?? whole);
    if (/\.exe$/i.test(path) && isAbsolute(path) && !path.includes('%')) return path;
  }
  return null;
}

// The paths Windows has registered for an executable (HKCU, HKLM, then the 32-bit view of HKLM), read with reg.exe. Bounded by a
// timeout and never throws: a machine without reg.exe simply has no registered paths. `run` is for tests.
export function registeredPaths(exeName, {env = process.env, run = spawnSync} = {}) {
  const reg = join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'reg.exe'), paths = [];
  for (const key of REGISTRY_KEYS) {
    try {
      const result = run(reg, ['query', `${key}\\${exeName}`, '/ve'], {encoding: 'utf8', timeout: REGISTRY_TIMEOUT_MS, windowsHide: true});
      const path = result && result.status === 0 ? parseAppPath(result.stdout, env) : null;
      if (path && !paths.includes(path)) paths.push(path);
    } catch {}
  }
  return paths;
}

// One reg.exe call: its output, or '' when it failed or timed out. Never throws.
function regQuery(args, {env, run}) {
  try {
    const reg = join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'reg.exe');
    const result = run(reg, ['query', ...args], {encoding: 'utf8', timeout: REGISTRY_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024});
    return result && result.status === 0 ? String(result.stdout ?? '') : '';
  } catch { return ''; }
}

// The program in a command line as the registry stores it ("C:\Program Files\Brave\brave.exe" --single-argument %1, or the same
// unquoted), with %VARIABLES% expanded; null unless it is an absolute .exe path.
export function parseCommandProgram(value, env = process.env) {
  let text = String(value ?? '').trim();
  text = text.startsWith('"') ? (/^"([^"]*)"/.exec(text)?.[1] ?? '') : (/^(.+?\.exe)(?:\s|$)/i.exec(text)?.[1] ?? '');
  text = text.trim().replace(/%([^%]+)%/g, (whole, name) => env[name] ?? env[name.toUpperCase()] ?? whole);
  return /\.exe$/i.test(text) && isAbsolute(text) && !text.includes('%') ? text : null;
}

// Every default value in `reg query <key> /s /ve` output as {key, value}, for the REG_SZ and REG_EXPAND_SZ ones (localized Windows names
// the value differently, so the line is recognised by its type).
function defaultValues(output) {
  const found = []; let key = null;
  for (const line of String(output ?? '').split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) { key = line.trim(); continue; }
    const match = key && /\sREG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (match) found.push({key, value: match[1]});
  }
  return found;
}

// The Chromium program of the browser Windows opens links with: the https UserChoice ProgId, then that ProgId's open command. Two reg.exe
// calls at most; null when the player never chose a default, the default is Firefox or anything not on the Chromium list, or reg.exe is
// not usable. `run` is for tests.
export function defaultBrowserPath({env = process.env, run = spawnSync} = {}) {
  const choice = regQuery(['HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], {env, run});
  const progId = /^\s*ProgId\s+REG_SZ\s+(\S+)\s*$/im.exec(choice)?.[1];
  if (!progId || !/^[A-Za-z0-9._-]{1,120}$/.test(progId)) return null;
  for (const {value} of defaultValues(regQuery([`HKCR\\${progId}\\shell\\open\\command`, '/ve'], {env, run}))) {
    const path = parseCommandProgram(value, env);
    if (path && isChromiumProgram(path)) return path;
  }
  return null;
}

// The Chromium programs of the browsers registered as Start menu clients (HKCU, HKLM and the 32-bit view of HKLM:
// SOFTWARE\Clients\StartMenuInternet\<browser>\shell\open\command). A browser installed in a folder of the player's own choosing
// registers itself here even when it has no App Paths entry. Three reg.exe calls; never throws. `run` is for tests.
export function startMenuBrowserPaths({env = process.env, run = spawnSync} = {}) {
  const paths = [];
  for (const root of ['HKCU\\SOFTWARE\\Clients\\StartMenuInternet', 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet',
    'HKLM\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet']) {
    for (const {key, value} of defaultValues(regQuery([root, '/s', '/ve'], {env, run}))) {
      if (!/\\shell\\open\\command$/i.test(key)) continue;
      const path = parseCommandProgram(value, env);
      if (path && isChromiumProgram(path) && !paths.some(known => known.toLowerCase() === path.toLowerCase())) paths.push(path);
    }
  }
  return paths;
}

// The browsers that can be launched, best first, as launch options: {name, channel} for Edge and Chrome where Playwright finds them
// itself (per-user, Program Files, Program Files (x86)), else {name, executablePath} from the registry's App Paths or from the other
// Chromium browsers' folders. Lazy, so the registry is read only when the earlier choices were not found. Off Windows nothing is known
// about the layout, so the two channels are offered and the launch decides. `readRegistry(exeName)` returns registered paths.
// After the known browsers come two more registry lookups for a Chromium browser installed in a folder of the player's own choosing: the
// browser Windows opens links with (`readDefaultBrowser()` returns a path or null) and the Start menu browser clients (`readStartMenu()`
// returns paths). With `readRegistry` given (a test's fake registry) they default to finding nothing.
export function* systemBrowserCandidates({env = process.env, platform = process.platform, exists = existsSync, readRegistry,
  readDefaultBrowser = readRegistry ? () => null : () => defaultBrowserPath({env}),
  readStartMenu = readRegistry ? () => [] : () => startMenuBrowserPaths({env})} = {}) {
  if (platform !== 'win32') { for (const {channel, name} of SYSTEM_BROWSERS) yield {name, channel}; return; }
  const roots = installRoots(env), seen = new Set();
  const lookup = readRegistry ?? (exeName => registeredPaths(exeName, {env}));
  const standardPath = browser => [browser.file].flat().flatMap(file => roots.map(root => join(root, file))).find(path => found(exists, path));
  const registered = browser => {
    let paths = [];
    try { paths = browser.appPath ? lookup(browser.appPath) ?? [] : []; } catch {}
    return paths.filter(path => typeof path === 'string' && path && found(exists, path));
  };
  const fresh = path => { const key = path.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; };
  for (const browser of SYSTEM_BROWSERS) {
    const standard = standardPath(browser);
    if (standard) { fresh(standard); yield {name: browser.name, channel: browser.channel}; continue; }
    for (const path of registered(browser)) if (fresh(path)) yield {name: browser.name, executablePath: path};
  }
  for (const browser of OTHER_CHROMIUM_BROWSERS) {
    const standard = standardPath(browser);
    if (standard) { if (fresh(standard)) yield {name: browser.name, executablePath: standard}; continue; }
    for (const path of registered(browser)) if (fresh(path)) yield {name: browser.name, executablePath: path};
  }
  // Not in a usual folder and not under App Paths: the browser the player set as Windows' default, then the registered Start menu clients.
  const registryChoice = path => typeof path === 'string' && path && isChromiumProgram(path) && found(exists, path) && fresh(path);
  const named = path => ({name: browserNameFor(path) ?? 'Chromium browser', executablePath: path});
  let chosen = null;
  try { chosen = readDefaultBrowser(); } catch {}
  if (registryChoice(chosen)) yield named(chosen);
  let clients = [];
  try { clients = readStartMenu() ?? []; } catch {}
  for (const path of clients) if (registryChoice(path)) yield named(path);
}

// The Edge and Chrome channels installed under the places Playwright itself looks.
export function installedSystemBrowsers({env = process.env, platform = process.platform, exists = existsSync} = {}) {
  if (platform !== 'win32') return [...SYSTEM_BROWSERS];
  const roots = installRoots(env);
  return SYSTEM_BROWSERS.filter(browser => roots.some(root => found(exists, join(root, browser.file))));
}

// True when a launch of the hidden browser can be expected to work: a developer's CYBERPUNK_CONVAI_BROWSER names the executable
// (checked when the bridge opens it), or any supported Chromium browser is installed (Edge, Chrome, Brave, Vivaldi, Opera and the
// others listed above), in the usual folders or wherever the registry says.
export function systemBrowserAvailable(options = {}) {
  const env = options.env ?? process.env;
  if (env.CYBERPUNK_CONVAI_BROWSER) return true;
  return !systemBrowserCandidates({...options, env}).next().done;
}

const missing = error => /is not found|doesn't exist|does not exist|ENOENT/i.test(String(error?.message ?? error));

// ------------------------------------------------------------------------------------------ the player's browser.txt

// The path in the text of browser.txt: the first line that is not blank or a comment (; or #), with an optional `BrowserPath=` before
// it and quotes around it. The file may be UTF-8, with or without a byte order mark, or UTF-16 (what Notepad can save). null when there
// is no such line.
export function parseBrowserOverride(input) {
  let text = Buffer.isBuffer(input) ? (input[0] === 0xff && input[1] === 0xfe ? input.subarray(2).toString('utf16le') : input.toString('utf8')) : String(input ?? '');
  text = text.replace(/^\uFEFF/, '');
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^[;#]/.test(line)) continue;
    line = line.replace(/^BrowserPath\s*=\s*/i, '').trim().replace(/^"(.*)"$/, '$1').trim();
    return line || null;
  }
  return null;
}

// The browser program the player named: the file itself, or, when they named the browser's folder, the known Chromium program in it
// (or in its Application folder). {path} or {problem: a short sentence for the log}. `stat(path)` returns a Node Stats or throws.
export function resolveBrowserOverride(value, {stat = statSync, env = process.env} = {}) {
  const wanted = typeof value === 'string' ? value.replace(/%([^%]+)%/g, (whole, name) => env[name] ?? env[name.toUpperCase()] ?? whole) : '';
  if (!wanted) return {problem: `${BROWSER_OVERRIDE_FILE} has no path in it`};
  if (!isAbsolute(wanted) || wanted.includes('%') || /[\x00-\x1f]/.test(wanted)) return {problem: `${BROWSER_OVERRIDE_FILE} needs the full path, such as C:\\Program Files\\Brave\\brave.exe`};
  const kind = path => { try { const info = stat(path); return info.isDirectory() ? 'folder' : info.isFile() ? 'file' : null; } catch { return null; } };
  const type = kind(wanted);
  if (type === 'file') {
    if (programOf(wanted) === 'firefox.exe') return {problem: `${BROWSER_OVERRIDE_FILE} names Firefox, which cannot run the conversation page; a Chromium browser is needed`};
    return {path: wanted};
  }
  if (type === 'folder') {
    for (const folder of [wanted, join(wanted, 'Application')]) {
      for (const program of Object.keys(CHROMIUM_PROGRAMS)) { const path = join(folder, program); if (kind(path) === 'file') return {path}; }
    }
    return {problem: `${BROWSER_OVERRIDE_FILE} names a folder with no Chromium browser program in it`};
  }
  return {problem: `${BROWSER_OVERRIDE_FILE} names ${win32.basename(wanted) || 'a path'}, which is not there`};
}

// browser.txt in the first of `folders` that has one: {file, path} for a usable path, {file, problem} for a file that names none,
// null when no folder holds the file. One short read; never throws. `read` and `stat` are for tests.
export function readBrowserOverride(folders, {read = readFileSync, stat = statSync, env = process.env} = {}) {
  for (const folder of [...new Set(folders.filter(folder => typeof folder === 'string' && folder))]) {
    const file = join(folder, BROWSER_OVERRIDE_FILE);
    let content;
    try { content = read(file); } catch { continue; }
    if (Buffer.byteLength(content) > 4096) return {file, problem: `${BROWSER_OVERRIDE_FILE} is too long to be a path`};
    return {file, ...resolveBrowserOverride(parseBrowserOverride(content), {stat, env})};
  }
  return null;
}

// ----------------------------------------------------------------------------------------------------------- launching

// A short plain reason for a failed launch: the first line of the error, a path cut to its file name, no Playwright prefix.
const startReason = error => String(error?.message ?? error ?? '').split('\n')[0].replace(/^browserType\.launch:\s*/i, '')
  .replace(/(?:[A-Za-z]:[\\/]|\\\\)(?:[^'"\r\n]*?\.[A-Za-z0-9]{2,4}(?=[\s'",;:)]|$)|[^\s'"]*)/g, path => win32.basename(path.replace(/\//g, '\\'))).replace(/\s+/g, ' ').trim().slice(0, 120) || 'unknown error';

// Said once per process for each distinct message: every turn asks for the browser again, and a browser that cannot start would
// otherwise fill the log.
const saidAlready = new Set();
/** For tests: forget which launch failures were logged. */
export function resetBrowserFailureLog() { saidAlready.clear(); }

// The error for a browser that was found (or named) and would not start: it names the browser, so the log and the game say that and not "no
// browser". Its code, BROWSER_START_FAILED, is read by the bridge, which tells the game.
function startFailure(error, name, log) {
  const message = missing(error) ? `${name} is set as the browser but its program is not there` : `${name} was found but would not start: ${startReason(error)}`;
  if (!saidAlready.has(message)) { saidAlready.add(message); log(message + '.'); }
  return Object.assign(Error(message), {code: 'BROWSER_START_FAILED', browser: name, cause: error});
}

// What to try, in order and lazily: the installed browsers, then the Edge and Chrome channels not already offered (Playwright may
// know a place the lookup does not). Each choice is {name, choice}.
function* launchChoices(lookup) {
  const offered = new Set();
  try {
    for (const {name, ...choice} of systemBrowserCandidates(lookup)) { if (choice.channel) offered.add(choice.channel); yield {name, choice}; }
  } catch {}
  for (const {channel, name} of SYSTEM_BROWSERS) if (!offered.has(channel)) yield {name, choice: {channel}};
}

// Opens the hidden browser through `launch(extraOptions)`: the named executable when there is one (the player's browser.txt or a
// developer's override), otherwise Edge, Chrome, then the other installed Chromium browsers. A launch that fails for any reason moves on to
// the next browser. When none starts, the error is the clear "install Edge or Chrome" one if every attempt found no browser, else the
// first browser that was there and would not start, named ("Brave was found but would not start: ..."). `log` gets one line per message.
export async function launchSystemBrowser(launch, {executablePath, log = () => {}, ...lookup} = {}) {
  if (executablePath) {
    try { return await launch({executablePath}); }
    catch (error) { throw startFailure(error, browserNameFor(executablePath) ?? win32.basename(executablePath), log); }
  }
  const errors = [];
  for (const {name, choice} of launchChoices(lookup)) {
    try { return await launch(choice); } catch (error) { errors.push({error, name}); }
  }
  const real = errors.find(({error}) => !missing(error));
  if (real) throw startFailure(real.error, real.name, log);
  if (!saidAlready.has(NO_BROWSER_MESSAGE)) { saidAlready.add(NO_BROWSER_MESSAGE); log(NO_BROWSER_MESSAGE); }
  throw Object.assign(Error(NO_BROWSER_MESSAGE), {code: 'NO_BROWSER', cause: errors[0]?.error});
}
