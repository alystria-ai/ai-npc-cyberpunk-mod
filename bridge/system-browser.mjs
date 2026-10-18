import {existsSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
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

export const NO_BROWSER_MESSAGE = 'No browser to run the conversation page: install a Chromium browser such as Microsoft Edge (free from microsoft.com/edge), Google Chrome, Brave or Opera.';

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

// The browsers that can be launched, best first, as launch options: {name, channel} for Edge and Chrome where Playwright finds them
// itself (per-user, Program Files, Program Files (x86)), else {name, executablePath} from the registry's App Paths or from the other
// Chromium browsers' folders. Lazy, so the registry is read only when the earlier choices were not found. Off Windows nothing is known
// about the layout, so the two channels are offered and the launch decides. `readRegistry(exeName)` returns registered paths.
export function* systemBrowserCandidates({env = process.env, platform = process.platform, exists = existsSync, readRegistry} = {}) {
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

// What to try, in order and lazily: the installed browsers, then the Edge and Chrome channels not already offered (Playwright may
// know a place the lookup does not).
function* launchChoices(lookup) {
  const offered = new Set();
  try {
    for (const {name, ...choice} of systemBrowserCandidates(lookup)) { if (choice.channel) offered.add(choice.channel); yield choice; }
  } catch {}
  for (const {channel} of SYSTEM_BROWSERS) if (!offered.has(channel)) yield {channel};
}

// Opens the hidden browser through `launch(extraOptions)`: the named executable when there is one (a developer override), otherwise
// Edge, Chrome, then the other installed Chromium browsers. A launch that fails for any reason moves on to the next browser. When
// none starts, the error is the clear "install Edge or Chrome" one if every attempt found no browser, else the first real launch
// error. `log` gets one line.
export async function launchSystemBrowser(launch, {executablePath, log = () => {}, ...lookup} = {}) {
  if (executablePath) return launch({executablePath});
  const errors = [];
  for (const choice of launchChoices(lookup)) {
    try { return await launch(choice); } catch (error) { errors.push(error); }
  }
  const real = errors.find(error => !missing(error));
  if (real) { log(`The hidden browser did not start (${String(real.message ?? real).split('\n')[0]}).`); throw real; }
  log(NO_BROWSER_MESSAGE);
  throw Object.assign(Error(NO_BROWSER_MESSAGE), {code: 'NO_BROWSER', cause: errors[0]});
}
