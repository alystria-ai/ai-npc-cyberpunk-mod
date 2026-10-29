import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {BROWSER_OVERRIDE_FILE, NO_BROWSER_MESSAGE, OTHER_CHROMIUM_BROWSERS, SYSTEM_BROWSERS, browserNameFor, defaultBrowserPath, installedSystemBrowsers,
  browserLookupSummary, isChromiumProgram, launchSystemBrowser, parseAppPath, parseBrowserOverride, parseCommandProgram, readBrowserOverride, registeredPaths,
  browserFailureTail, browserOutputLines, browserStartFailed, lastBrowserStartFailure, launchDiagnostics, resetBrowserFailureLog, resolveBrowserOverride, startMenuBrowserPaths, systemBrowserAvailable, systemBrowserCandidates} from './system-browser.mjs';

const env = {LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)'};
const at = (...paths) => path => paths.includes(path);
const edgeIn = root => join(root, 'Microsoft\\Edge\\Application\\msedge.exe');
const chromeIn = root => join(root, 'Google\\Chrome\\Application\\chrome.exe');
const channels = options => installedSystemBrowsers({env, platform: 'win32', ...options}).map(item => item.channel);
// A machine whose installed files are `paths` and whose registry App Paths answer `registry` ({'brave.exe': [paths]}).
const machine = (paths = [], registry = {}) => ({env, platform: 'win32', exists: at(...paths), readRegistry: exe => registry[exe] ?? []});
const choices = options => [...systemBrowserCandidates(options)];

test('Edge is tried first, then Chrome, and both are found where Playwright looks', () => {
  assert.deepEqual(SYSTEM_BROWSERS.map(item => item.channel), ['msedge', 'chrome']);
  const edge = edgeIn(env['PROGRAMFILES(X86)']), chrome = chromeIn(env.LOCALAPPDATA);
  assert.deepEqual(channels({exists: at(edge)}), ['msedge']);
  assert.deepEqual(channels({exists: at(edge, chrome)}), ['msedge', 'chrome']);
  assert.deepEqual(channels({exists: at(chrome)}), ['chrome']);
  assert.deepEqual(channels({exists: () => false}), []);
  assert.deepEqual(installedSystemBrowsers({env: {}, platform: 'win32', exists: () => true}), [], 'no install folders known: nothing found');
  assert.deepEqual(channels({exists: () => { throw Error('denied'); }}), []);
});

test('a browser is available when one is installed or a developer names an executable', () => {
  const edge = edgeIn(env.PROGRAMFILES);
  assert.equal(systemBrowserAvailable(machine([edge])), true);
  assert.equal(systemBrowserAvailable(machine()), false);
  assert.equal(systemBrowserAvailable({...machine(), env: {...env, CYBERPUNK_CONVAI_BROWSER: 'C:\\dev\\browser.exe'}}), true);
});

test('the launch uses the Edge channel, and a developer executable replaces the lookup', async () => {
  const calls = [], browser = {};
  assert.equal(await launchSystemBrowser(async options => { calls.push(options); return browser; }, machine([edgeIn(env.PROGRAMFILES)])), browser);
  assert.deepEqual(calls, [{channel: 'msedge'}]);
  calls.length = 0;
  await launchSystemBrowser(async options => { calls.push(options); return browser; }, {executablePath: 'C:\\dev\\browser.exe'});
  assert.deepEqual(calls, [{executablePath: 'C:\\dev\\browser.exe'}]);
});

test('Chrome is used when Edge is not installed', async () => {
  const calls = [], logs = [], browser = {};
  const launch = async options => {
    calls.push(options.channel);
    if (options.channel === 'msedge') throw Error("Chromium distribution 'msedge' is not found at C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");
    return browser;
  };
  assert.equal(await launchSystemBrowser(launch, {...machine([chromeIn(env.LOCALAPPDATA)]), log: line => logs.push(line)}), browser);
  assert.deepEqual(calls, ['chrome']); assert.deepEqual(logs, []);
  // A lookup that saw nothing still lets Playwright try its own Edge and Chrome channels.
  calls.length = 0;
  await assert.rejects(launchSystemBrowser(async options => { calls.push(options.channel); throw Error('boom'); }, {...machine(), log() {}}), /boom/);
  assert.deepEqual(calls, ['msedge', 'chrome']);
});

test('with neither browser the error says what to install and exactly one line is logged', async () => {
  const logs = [];
  const launch = async ({channel}) => { throw Error(`Chromium distribution '${channel}' is not found at C:\\missing`); };
  await assert.rejects(launchSystemBrowser(launch, {...machine(), log: line => logs.push(line)}), error => {
    assert.equal(error.message, NO_BROWSER_MESSAGE); assert.equal(error.code, 'NO_BROWSER'); return true;
  });
  assert.deepEqual(logs, [NO_BROWSER_MESSAGE]);
  assert.match(NO_BROWSER_MESSAGE, /Microsoft Edge[^]*Google Chrome/);
});

test('an installed browser that fails to start is reported as itself, not as missing', async () => {
  resetBrowserFailureLog();
  const logs = [];
  const launch = async ({channel}) => { throw Error(channel === 'msedge' ? 'browserType.launch: Target closed' : "Chromium distribution 'chrome' is not found"); };
  await assert.rejects(launchSystemBrowser(launch, {...machine([edgeIn(env.PROGRAMFILES)]), log: line => logs.push(line)}), error => {
    assert.equal(error.message, 'Microsoft Edge was found but would not start: Target closed'); assert.equal(error.code, 'BROWSER_START_FAILED'); return true;
  });
  assert.deepEqual(logs, ['Microsoft Edge was found but would not start: Target closed.']);
  // Asked again (every turn asks for the browser), the same failure is not logged a second time.
  await assert.rejects(launchSystemBrowser(launch, {...machine([edgeIn(env.PROGRAMFILES)]), log: line => logs.push(line)}), /would not start/);
  assert.equal(logs.length, 1);
});

test('Brave that is found but would not start says Brave, with the path cut to its file name; a missing named program says so', async () => {
  resetBrowserFailureLog();
  const logs = [], brave = 'F:\\My Programs\\Brave\\brave.exe';
  const launch = async () => { throw Error(`browserType.launch: Failed to launch: spawn ${brave} EPERM\nCall log:\n  - something`); };
  await assert.rejects(launchSystemBrowser(launch, {executablePath: brave, log: line => logs.push(line)}), error => {
    assert.equal(error.message, 'Brave was found but would not start: Failed to launch: spawn brave.exe EPERM'); return true;
  });
  assert.deepEqual(logs, ['Brave was found but would not start: Failed to launch: spawn brave.exe EPERM.']);
  assert.ok(!logs[0].includes('My Programs'));
  await assert.rejects(launchSystemBrowser(async () => { throw Error("browserType.launch: Executable doesn't exist at X:\\gone\\thorium.exe"); },
    {executablePath: 'X:\\gone\\thorium.exe', log: line => logs.push(line)}), error => {
    assert.equal(error.message, 'Thorium is set as the browser but its program is not there'); assert.equal(error.code, 'BROWSER_START_FAILED'); return true;
  });
});

test('the default browser is read from the https UserChoice ProgId and its open command, and only a Chromium program is accepted', () => {
  const calls = [];
  const reply = (progId, command) => (program, args) => {
    calls.push(args.slice(1).join(' '));
    if (/UserChoice/.test(args[1])) return {status: 0, stdout: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice\r\n    Hash    REG_SZ    abc\r\n    ProgId    REG_SZ    ${progId}\r\n\r\n`};
    return {status: 0, stdout: `\r\nHKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command\r\n    (Default)    REG_SZ    ${command}\r\n\r\n`};
  };
  const brave = 'D:\\Browsers\\Brave\\brave.exe';
  assert.equal(defaultBrowserPath({env, run: reply('BraveHTML', `\"${brave}\" --single-argument %1`)}), brave);
  assert.deepEqual(calls, ['HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice /v ProgId', 'HKCR\\BraveHTML\\shell\\open\\command /ve']);
  assert.equal(defaultBrowserPath({env, run: reply('MSEdgeHTM', '\"C:\\Edge\\msedge.exe\" --single-argument %1')}), 'C:\\Edge\\msedge.exe');
  assert.equal(defaultBrowserPath({env, run: reply('FirefoxURL-308046B0AF4A39CB', '\"C:\\Program Files\\Mozilla Firefox\\firefox.exe\" -osint -url \"%1\"')}), null, 'never Firefox');
  assert.equal(defaultBrowserPath({env, run: reply('SomeHTML', '\"C:\\Windows\\System32\\rundll32.exe\" x')}), null, 'not on the Chromium list');
  assert.equal(defaultBrowserPath({env, run: reply('Bad ProgId\"&calc', '\"C:\\a\\brave.exe\"')}), null, 'a ProgId that is not a plain name is never passed to reg.exe');
  assert.equal(defaultBrowserPath({env, run: () => ({status: 1, stdout: ''})}), null, 'a player who never chose a default');
  assert.equal(defaultBrowserPath({env, run: () => { throw Error('no reg.exe'); }}), null);
  assert.equal(defaultBrowserPath({env, run: () => ({status: null, error: Error('ETIMEDOUT')})}), null);
  const timeouts = [];
  defaultBrowserPath({env, run: (program, args, options) => { timeouts.push(options.timeout); return {status: 1, stdout: ''}; }});
  assert(timeouts.every(timeout => timeout > 0 && timeout <= 5000));
});

test('command lines are reduced to their program, quoted or not, and anything but an absolute .exe is refused', () => {
  assert.equal(parseCommandProgram('\"C:\\Program Files\\BraveSoftware\\brave.exe\" --single-argument %1'), 'C:\\Program Files\\BraveSoftware\\brave.exe');
  assert.equal(parseCommandProgram('C:\\Program Files\\Opera\\opera.exe -- \"%1\"'), 'C:\\Program Files\\Opera\\opera.exe');
  assert.equal(parseCommandProgram('C:\\Brave\\brave.exe'), 'C:\\Brave\\brave.exe');
  assert.equal(parseCommandProgram('%LocalAppData%\\Vivaldi\\vivaldi.exe --x', {LocalAppData: 'C:\\U\\AppData\\Local'}), 'C:\\U\\AppData\\Local\\Vivaldi\\vivaldi.exe');
  assert.equal(parseCommandProgram('brave.exe %1'), null, 'relative');
  assert.equal(parseCommandProgram('\"C:\\x\\run.bat\" a'), null);
  assert.equal(parseCommandProgram('%Missing%\\a.exe', {}), null);
  assert.equal(parseCommandProgram(undefined), null);
  assert.equal(isChromiumProgram('C:\\x\\Brave.EXE'), true); assert.equal(isChromiumProgram('C:\\x\\firefox.exe'), false);
  assert.equal(browserNameFor('C:\\Brave\\brave.exe'), 'Brave');
  assert.equal(browserNameFor('C:\\Yandex\\YandexBrowser\\Application\\browser.exe'), 'Yandex Browser');
  assert.equal(browserNameFor('D:\\unknown\\browser.exe'), null);
});

test('Start menu browser clients are read for HKCU, HKLM and the 32-bit view; only the open command of a Chromium browser counts', () => {
  const brave = 'E:\\Portable\\Brave\\brave.exe', vivaldi = 'D:\\V\\vivaldi.exe', seen = [];
  const out = {
    HKCU: '',
    HKLM: [`HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Brave`, '    (Default)    REG_SZ    Brave',
      `HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Brave\\DefaultIcon`, `    (Default)    REG_SZ    \"${brave}\",0`,
      `HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Brave\\shell\\open\\command`, `    (Default)    REG_SZ    \"${brave}\"`,
      `HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Firefox-308\\shell\\open\\command`, '    (Default)    REG_SZ    \"C:\\Program Files\\Mozilla Firefox\\firefox.exe\"',
      `HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\IEXPLORE.EXE\\shell\\open\\command`, '    (Default)    REG_SZ    \"C:\\Program Files\\Internet Explorer\\iexplore.exe\"', ''].join('\r\n'),
    WOW: [`HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet\\Vivaldi\\shell\\open\\command`, `    (Par d\u00e9faut)    REG_SZ    \"${vivaldi}\"`,
      `HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet\\Brave\\shell\\open\\command`, `    (Default)    REG_SZ    \"${brave.toUpperCase()}\"`, ''].join('\r\n'),
  };
  const run = (program, args) => {
    seen.push(args.slice(1)); assert.equal(args[0], 'query');
    const key = args[1];
    return {status: 0, stdout: key.startsWith('HKCU') ? out.HKCU : key.includes('WOW6432Node') ? out.WOW : out.HKLM};
  };
  assert.deepEqual(startMenuBrowserPaths({env, run}), [brave, vivaldi]);
  assert.deepEqual(seen.map(args => args.join(' ')), ['HKCU\\SOFTWARE\\Clients\\StartMenuInternet /s /ve', 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet /s /ve',
    'HKLM\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet /s /ve']);
  assert.deepEqual(startMenuBrowserPaths({env, run: () => { throw Error('x'); }}), []);
});

test('a Brave in a folder of its own is found through the default browser, then the Start menu clients, after everything else, and only when the file is there', async () => {
  const brave = 'F:\\Tools\\Brave\\brave.exe', vivaldi = 'G:\\V\\vivaldi.exe', asked = [];
  const base = machine([brave, vivaldi]);
  const readDefaultBrowser = () => { asked.push('default'); return brave; }, readStartMenu = () => { asked.push('menu'); return [brave, vivaldi]; };
  assert.deepEqual(choices({...base, readDefaultBrowser, readStartMenu}), [{name: 'Brave', executablePath: brave}, {name: 'Vivaldi', executablePath: vivaldi}], 'listed once');
  assert.deepEqual(choices({...machine([brave]), readDefaultBrowser: () => null, readStartMenu: () => [brave]}), [{name: 'Brave', executablePath: brave}]);
  assert.deepEqual(choices({...machine([]), readDefaultBrowser, readStartMenu}), [], 'a registry entry whose file is gone offers nothing');
  assert.deepEqual(choices({...base, readDefaultBrowser: () => 'C:\\Mozilla Firefox\\firefox.exe', readStartMenu: () => []}), [], 'never Firefox, even when the file exists');
  assert.deepEqual(choices({...base, readDefaultBrowser: () => { throw Error('x'); }, readStartMenu: () => { throw Error('y'); }}), [], 'a failing lookup is no entry');
  // Edge in its usual folder is first, and then neither lookup runs.
  asked.length = 0;
  assert.equal(systemBrowserAvailable({...machine([edgeIn(env.PROGRAMFILES), brave]), readDefaultBrowser, readStartMenu}), true);
  assert.deepEqual(asked, []);
  // The launch uses the executable.
  const calls = [];
  await launchSystemBrowser(async options => { calls.push(options); return {}; }, {...base, readDefaultBrowser, readStartMenu});
  assert.deepEqual(calls, [{executablePath: brave}]);
  assert.equal(systemBrowserAvailable({...machine([brave]), readDefaultBrowser, readStartMenu}), true);
  assert.equal(systemBrowserAvailable({...machine([]), readDefaultBrowser, readStartMenu}), false);
});

test('a fake registry given as readRegistry means no real reg.exe is run for the default browser or the Start menu either', () => {
  assert.deepEqual(choices(machine()), []);
  assert.equal(systemBrowserAvailable(machine()), false);
});

test('browser.txt: the path is the first line that is not blank or a comment, quotes and BrowserPath= are accepted, any text encoding', () => {
  const brave = 'D:\\Programs\\Brave\\brave.exe';
  assert.equal(parseBrowserOverride(brave), brave);
  assert.equal(parseBrowserOverride(`\r\n; my browser\r\n# another comment\r\n  \"${brave}\"  \r\nignored`), brave);
  assert.equal(parseBrowserOverride(`BrowserPath=${brave}`), brave);
  assert.equal(parseBrowserOverride(`browserpath = \"${brave}\"`), brave);
  assert.equal(parseBrowserOverride(Buffer.from(`\uFEFF${brave}\r\n`, 'utf8')), brave, 'UTF-8 with a byte order mark');
  assert.equal(parseBrowserOverride(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${brave}\r\n`, 'utf16le')])), brave, 'UTF-16 as Notepad can save it');
  assert.equal(parseBrowserOverride(''), null); assert.equal(parseBrowserOverride('; only a comment\r\n'), null); assert.equal(parseBrowserOverride(undefined), null);
});

test('browser.txt names a file or a browser folder; relative paths, Firefox, missing files and empty folders are refused with a plain reason', () => {
  const files = new Set(['D:\\Programs\\Brave\\brave.exe', 'E:\\B\\Application\\vivaldi.exe', 'C:\\Mozilla Firefox\\firefox.exe', 'D:\\Programs\\Brave\\readme.txt']);
  const folders = new Set(['D:\\Programs\\Brave', 'E:\\B', 'E:\\B\\Application', 'F:\\Empty']);
  const stat = path => {
    if (files.has(path)) return {isFile: () => true, isDirectory: () => false};
    if (folders.has(path)) return {isFile: () => false, isDirectory: () => true};
    throw Object.assign(Error('ENOENT'), {code: 'ENOENT'});
  };
  const resolved = value => resolveBrowserOverride(value, {stat, env: {PROGRAMS: 'D:\\Programs'}});
  assert.deepEqual(resolved('D:\\Programs\\Brave\\brave.exe'), {path: 'D:\\Programs\\Brave\\brave.exe'});
  assert.deepEqual(resolved('D:\\Programs\\Brave'), {path: 'D:\\Programs\\Brave\\brave.exe'}, 'the folder of the browser');
  assert.deepEqual(resolved('E:\\B'), {path: 'E:\\B\\Application\\vivaldi.exe'}, 'its Application folder');
  assert.deepEqual(resolved('%PROGRAMS%\\Brave\\brave.exe'), {path: 'D:\\Programs\\Brave\\brave.exe'});
  assert.match(resolved('brave.exe').problem, /full path/);
  assert.match(resolved(null).problem, /no path/);
  assert.match(resolved('C:\\Mozilla Firefox\\firefox.exe').problem, /Firefox[^]*Chromium/);
  assert.match(resolved('Z:\\gone\\brave.exe').problem, /brave\.exe, which is not there/);
  assert.match(resolved('F:\\Empty').problem, /no Chromium browser program/);
  assert.ok(Object.values(resolved('Z:\\Users\\Someone\\gone\\brave.exe')).every(text => !String(text).includes('Someone')), 'the log line holds the file name, not the folder');
});

test('readBrowserOverride reads browser.txt from the first plugin folder that has one and never throws', () => {
  const brave = 'D:\\Programs\\Brave\\brave.exe';
  const stat = path => { if (path === brave) return {isFile: () => true, isDirectory: () => false}; throw Error('ENOENT'); };
  const reads = [], disk = {'C:\\Game\\plugin\\browser.txt': Buffer.from(`${brave}\r\n`)};
  const read = file => { reads.push(file); if (file in disk) return disk[file]; throw Object.assign(Error('ENOENT'), {code: 'ENOENT'}); };
  assert.equal(BROWSER_OVERRIDE_FILE, 'browser.txt');
  assert.deepEqual(readBrowserOverride(['C:\\Real\\plugin', 'C:\\Game\\plugin', 'C:\\Game\\plugin'], {read, stat}), {file: 'C:\\Game\\plugin\\browser.txt', path: brave});
  assert.deepEqual(reads, ['C:\\Real\\plugin\\browser.txt', 'C:\\Game\\plugin\\browser.txt']);
  assert.equal(readBrowserOverride(['C:\\Nowhere'], {read, stat}), null, 'no file: nothing to say');
  disk['C:\\Game\\plugin\\browser.txt'] = Buffer.from('Z:\\gone\\brave.exe');
  assert.match(readBrowserOverride(['C:\\Game\\plugin'], {read, stat}).problem, /not there/);
  disk['C:\\Game\\plugin\\browser.txt'] = Buffer.alloc(9000, 65);
  assert.match(readBrowserOverride(['C:\\Game\\plugin'], {read, stat}).problem, /too long/);
  assert.equal(readBrowserOverride([null, '', undefined], {read, stat}), null);
  assert.match(NO_BROWSER_MESSAGE, /browser\.txt next to launcher\.ini/);
});

test('the registry App Paths entry finds Edge or Chrome installed outside the usual folders', async () => {
  const edge = 'D:\\Apps\\Edge\\Application\\msedge.exe', chrome = 'E:\\Chrome\\chrome.exe';
  assert.deepEqual(choices(machine([edge], {'msedge.exe': [edge]})), [{name: 'Microsoft Edge', executablePath: edge}]);
  assert.deepEqual(choices(machine([chrome], {'chrome.exe': [chrome]})), [{name: 'Google Chrome', executablePath: chrome}]);
  assert.deepEqual(choices(machine([], {'msedge.exe': [edge]})), [], 'a leftover entry whose file is gone (a debloat tool removed Edge) offers nothing');
  assert.equal(systemBrowserAvailable(machine([chrome], {'chrome.exe': [chrome]})), true);
  assert.equal(systemBrowserAvailable(machine([], {'chrome.exe': [chrome]})), false);
  const calls = [];
  await launchSystemBrowser(async options => { calls.push(options); return {}; }, machine([chrome], {'chrome.exe': [chrome]}));
  assert.deepEqual(calls, [{executablePath: chrome}]);
  const broken = {readRegistry: () => { throw Error('no reg'); }};
  assert.deepEqual(choices({...machine([edgeIn(env.PROGRAMFILES)]), ...broken}), [{name: 'Microsoft Edge', channel: 'msedge'}]);
  assert.deepEqual(choices({...machine(), ...broken}), [], 'a registry reader that fails is the same as no entry');
});

test('the registry is not read while a browser is found in a usual folder', () => {
  const asked = [], readRegistry = exe => { asked.push(exe); return []; };
  const edge = edgeIn(env.PROGRAMFILES);
  assert.equal(systemBrowserAvailable({...machine([edge]), readRegistry}), true);
  const first = systemBrowserCandidates({...machine([edge]), readRegistry}).next().value;
  assert.deepEqual(first, {name: 'Microsoft Edge', channel: 'msedge'});
  assert.deepEqual(asked, [], 'asking for the best browser stops at Edge');
});

test('other Chromium browsers come after Edge and Chrome, each with its own executable', async () => {
  const brave = join(env.PROGRAMFILES, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe');
  const vivaldi = join(env.LOCALAPPDATA, 'Vivaldi\\Application\\vivaldi.exe');
  const chromeBeta = join(env.PROGRAMFILES, 'Google\\Chrome Beta\\Application\\chrome.exe');
  const edgeCanary = join(env.LOCALAPPDATA, 'Microsoft\\Edge SxS\\Application\\msedge.exe');
  const chromium = join(env.LOCALAPPDATA, 'Chromium\\Application\\chrome.exe');
  assert.deepEqual(OTHER_CHROMIUM_BROWSERS.map(item => item.name).filter(name => /^(Brave|Vivaldi|Opera|Opera GX|Chromium)$/.test(name)),
    ['Brave', 'Vivaldi', 'Opera', 'Opera GX', 'Chromium']);
  assert.deepEqual(choices(machine([vivaldi, brave, chromeBeta, edgeCanary, chromium])).map(item => item.name),
    ['Microsoft Edge Canary', 'Google Chrome Beta', 'Brave', 'Vivaldi', 'Chromium']);
  assert.deepEqual(choices(machine([brave, chromeIn(env.LOCALAPPDATA), edgeIn(env.PROGRAMFILES)])).map(item => item.name),
    ['Microsoft Edge', 'Google Chrome', 'Brave']);
  assert.deepEqual(choices(machine([brave])), [{name: 'Brave', executablePath: brave}]);
  assert.equal(systemBrowserAvailable(machine([brave])), true);
  // Brave in an odd place is found through its App Paths entry; a browser that fails to start moves on to the next one.
  const odd = 'F:\\Programs\\Brave\\brave.exe', calls = [];
  const launch = async options => { calls.push(options); if (options.channel) throw Error('Target closed'); return {}; };
  await launchSystemBrowser(launch, machine([odd, edgeIn(env.PROGRAMFILES)], {'brave.exe': [odd]}));
  assert.deepEqual(calls, [{channel: 'msedge'}, {executablePath: odd}]);
  // The same file found twice (a usual folder and the registry) is offered once.
  assert.deepEqual(choices(machine([brave], {'brave.exe': [brave.toUpperCase()]})), [{name: 'Brave', executablePath: brave}]);
});

test('off Windows the two channels are offered and nothing is looked up', () => {
  const trap = () => { throw Error('not looked up'); };
  assert.deepEqual(choices({platform: 'linux', exists: trap, readRegistry: trap}),
    [{name: 'Microsoft Edge', channel: 'msedge'}, {name: 'Google Chrome', channel: 'chrome'}]);
});

test('App Paths output is parsed whatever the language, quoting or variables, and anything but an absolute .exe is refused', () => {
  const output = (value, type = 'REG_SZ') => `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe\r\n    (Default)    ${type}    ${value}\r\n\r\n`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(parseAppPath(output(edge)), edge);
  assert.equal(parseAppPath(output(`"${edge}"`)), edge);
  assert.equal(parseAppPath(output(`"${edge}" --flag`)), edge);
  assert.equal(parseAppPath(output('%ProgramFiles%\\Edge\\msedge.exe', 'REG_EXPAND_SZ'), {ProgramFiles: 'D:\\PF'}), 'D:\\PF\\Edge\\msedge.exe');
  assert.equal(parseAppPath(`    (Par d\u00e9faut)    REG_SZ    ${edge}\r\n`), edge);
  assert.equal(parseAppPath(output('msedge.exe')), null, 'relative');
  assert.equal(parseAppPath(output('C:\\Windows\\notepad.bat')), null, 'not an exe');
  assert.equal(parseAppPath(output('%Missing%\\a.exe'), {}), null, 'unexpanded variable');
  assert.equal(parseAppPath('ERROR: The system was unable to find the specified registry key or value.'), null);
  assert.equal(parseAppPath(undefined), null);
});

test('the registry is read with reg.exe for HKCU, HKLM and the 32-bit view, with a time limit, and a failure is just no path', () => {
  const edge = 'C:\\Edge\\msedge.exe', seen = [];
  const run = (program, args, options) => {
    seen.push({program, args, timeout: options.timeout});
    return args[1].startsWith('HKCU') ? {status: 1, stdout: ''} : {status: 0, stdout: `    (Default)    REG_SZ    ${edge}\r\n`};
  };
  assert.deepEqual(registeredPaths('msedge.exe', {env: {SystemRoot: 'C:\\Windows'}, run}), [edge], 'the same path from two views is listed once');
  const app = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe';
  assert.deepEqual(seen.map(item => item.args[1]), [`HKCU\\${app}`, `HKLM\\${app}`, 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe']);
  assert(seen.every(item => item.program === 'C:\\Windows\\System32\\reg.exe' && item.args[2] === '/ve' && item.timeout > 0 && item.timeout <= 5000));
  assert.deepEqual(registeredPaths('x.exe', {env: {}, run: () => { throw Error('spawn failed'); }}), []);
  assert.deepEqual(registeredPaths('x.exe', {env: {}, run: () => ({status: null, error: Error('ETIMEDOUT')})}), []);
});

test('Opera and Opera GX are found per user and for all users, and a Firefox install is never offered', () => {
  const opera = join(env.LOCALAPPDATA, 'Programs\\Opera\\opera.exe'), gx = join(env.LOCALAPPDATA, 'Programs\\Opera GX\\opera.exe');
  const shared = join(env.PROGRAMFILES, 'Opera\\opera.exe');
  assert.deepEqual(choices(machine([gx])), [{name: 'Opera GX', executablePath: gx}]);
  assert.deepEqual(choices(machine([gx, opera])).map(item => item.name), ['Opera', 'Opera GX']);
  assert.deepEqual(choices(machine([shared])), [{name: 'Opera', executablePath: shared}]);
  const odd = 'G:\\Games\\Opera\\opera.exe';
  assert.deepEqual(choices(machine([odd], {'opera.exe': [odd]})), [{name: 'Opera', executablePath: odd}]);
  const firefox = join(env.PROGRAMFILES, 'Mozilla Firefox\\firefox.exe');
  assert.deepEqual(choices(machine([firefox], {'firefox.exe': [firefox]})), [], 'Playwright cannot drive an installed Firefox');
  assert.match(NO_BROWSER_MESSAGE, /Chromium browser such as Microsoft Edge[^]*Google Chrome[^]*Brave[^]*Opera/);
});

test('the lookup summary for the log names what was set, found and chosen, in program names and never a folder, and a registry that fails is just none', () => {
  const answer = args => {
    const key = args[1];
    if (key.endsWith('\\https\\UserChoice')) return '    ProgId    REG_SZ    FirefoxURL-308046B0AF4A39CB\r\n';
    if (key === 'HKCR\\FirefoxURL-308046B0AF4A39CB\\shell\\open\\command') return 'HKEY_CLASSES_ROOT\\FirefoxURL-308046B0AF4A39CB\\shell\\open\\command\r\n    (Default)    REG_SZ    "C:\\Program Files\\Mozilla Firefox\\firefox.exe" -osint -url "%1"\r\n';
    if (key === 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet') {
      return 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\FIREFOX.EXE\\shell\\open\\command\r\n    (Default)    REG_SZ    "C:\\Program Files\\Mozilla Firefox\\firefox.exe"\r\n';
    }
    return null;
  };
  const run = (program, args) => { const stdout = answer(args); return stdout ? {status: 0, stdout} : {status: 1, stdout: ''}; };
  const line = browserLookupSummary({env, exists: () => false, run});
  assert.equal(line, 'Browser lookup: LOCALAPPDATA set, PROGRAMFILES set, PROGRAMFILES(X86) set. Browser folders found: none. Registered programs found: none. Default browser: firefox.exe. Start menu browsers: firefox.exe.');
  assert.doesNotMatch(line, /[A-Za-z]:\\/, 'no folder in the line');
  // Variables missing, a browser in a usual folder that the lookup did offer, the registry broken.
  const edge = edgeIn(env.PROGRAMFILES);
  const odd = browserLookupSummary({env: {PROGRAMFILES: env.PROGRAMFILES}, exists: at(edge), run: () => { throw Error('spawn failed'); }});
  assert.equal(odd, 'Browser lookup: LOCALAPPDATA not set, PROGRAMFILES set, PROGRAMFILES(X86) not set. Browser folders found: Microsoft Edge. Registered programs found: none. Default browser: none. Start menu browsers: none.');
});

// 27 Oct 2026, install 0d0750 (Edge on an AMD RX 9070 XT): "Edge was found but would not start: Target page, context or browser has been closed" was all the report held;
// Playwright prints what the browser said and how its process ended below that first line.
const CLOSED = [
  'browserType.launch: Target page, context or browser has been closed',
  'Browser logs:',
  '',
  '<launched> pid=4242',
  '[pid=4242][err] [1027/163508.123:ERROR:gpu_process_host.cc(990)] GPU process exited unexpectedly: exit_code=-1073740791',
  '[pid=4242][err] [1027/163508.456:FATAL:gpu_data_manager_impl_private.cc(415)] GPU process isn\'t usable. Goodbye. (C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe)',
  '<process did exit: exitCode=21, signal=null>',
  '<gracefully close start>',
  'Call log:',
  '  - <launching> C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe --disable-field-trial-config --headless',
].join('\n');

test('a browser that goes away at once says what it printed and its exit code, paths cut to file names', async () => {
  resetBrowserFailureLog();
  const logs = [];
  const launch = async ({channel}) => { throw Error(channel === 'msedge' ? CLOSED : "Chromium distribution 'chrome' is not found"); };
  await assert.rejects(launchSystemBrowser(launch, {...machine([edgeIn(env.PROGRAMFILES)]), log: line => logs.push(line)}), error => {
    assert.equal(error.message, 'Microsoft Edge was found but would not start: Target page, context or browser has been closed (exit code 21)');
    assert.equal(error.code, 'BROWSER_START_FAILED');
    assert.equal(error.diagnostic.length, 3, error.diagnostic.join(' / '));
    assert.match(error.diagnostic[0], /GPU process exited unexpectedly/);
    assert.match(error.diagnostic[1], /Goodbye\. \(msedge\.exe\)/);
    assert.equal(error.diagnostic[2], '<process did exit: exitCode=21, signal=null>');
    return true;
  });
  assert.equal(logs.length, 2);
  assert.match(logs[1], /^The browser said: \[1027\/163508\.123:ERROR:gpu_process_host\.cc\(990\)\] GPU process exited unexpectedly/);
  assert.ok(!logs.join('\n').includes('Program Files'), 'no folder in the log');
  const last = lastBrowserStartFailure();
  assert.match(last.message, /would not start/);
  assert.equal(browserFailureTail(last.message), last.diagnostic);
  assert.equal(browserFailureTail('some other failure'), undefined);
  // Asked again, nothing is logged a second time.
  await assert.rejects(launchSystemBrowser(launch, {...machine([edgeIn(env.PROGRAMFILES)]), log: line => logs.push(line)}), /would not start/);
  assert.equal(logs.length, 2);
});

test('the earlier tries of one start are in the diagnostic, and a failure with no browser output has none of its own', () => {
  const error = Object.assign(Error('browserType.launch: Target closed'), {earlier: 'browserType.launch: Browser closed unexpectedly', rescue: 'browserType.launch: Target closed'});
  assert.deepEqual(launchDiagnostics(error), ['first try, with the sandbox: browserType.launch: Browser closed unexpectedly', 'last try, without the graphics process: browserType.launch: Target closed']);
  assert.deepEqual(launchDiagnostics(Error('boom')), []);
  assert.deepEqual(launchDiagnostics(undefined), []);
  const long = Error('x\n' + Array.from({length: 30}, (_, i) => `[pid=1][err] line ${i} ${'y'.repeat(300)}`).join('\n'));
  const lines = launchDiagnostics(long);
  assert.equal(lines.length, 8); assert.ok(lines.every(line => line.length <= 200));
});

test('browserStartFailed recognises the words of a browser that would not start or is not there', () => {
  assert.equal(browserStartFailed('Microsoft Edge was found but would not start: Target closed'), true);
  assert.equal(browserStartFailed('Thorium is set as the browser but its program is not there'), true);
  assert.equal(browserStartFailed(NO_BROWSER_MESSAGE), true);
  assert.equal(browserStartFailed('Pocket student startup timed out'), false);
  assert.equal(browserStartFailed(undefined), false);
});

// 29 Oct 2026, report 144971a28fc434ac (install 0d0750, 0.3.4, Edge on an AMD RX 9070 XT): the message said "(exit code 3221225477)" but the tail did not hold the exit line,
// because Playwright 1.58 prints it as "[pid=N] <process did exit: ...>" and only a line that began with "<process did exit" was kept.
test('the process-exit line of Playwright 1.58 ("[pid=N] <process did exit: ...>") is in the diagnostic without its pid', () => {
  const crash = Error([
    'browserType.launch: Target page, context or browser has been closed',
    'Browser logs:',
    '',
    '<launching> C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe --headless',
    '<launched> pid=7788',
    '[pid=7788] <process did exit: exitCode=3221225477, signal=null>',
    '[pid=7788] starting temporary directories cleanup',
  ].join('\n'));
  assert.deepEqual(browserOutputLines(crash.message), ['<process did exit: exitCode=3221225477, signal=null>']);
  assert.deepEqual(launchDiagnostics(crash), ['<process did exit: exitCode=3221225477, signal=null>']);
  assert.deepEqual(browserOutputLines('only a summary'), []);
});

test('the last try\'s own process exit and output are in the diagnostic, after the two try lines and before the first try\'s output', () => {
  const error = Object.assign(Error('browserType.launch: Target page, context or browser has been closed\n[pid=1] <process did exit: exitCode=3221225477, signal=null>'), {
    earlier: 'browserType.launch: Target page, context or browser has been closed', rescue: 'browserType.launch: Target page, context or browser has been closed',
    rescueLines: ['<process did exit: exitCode=3221225477, signal=null>', '[0101/000000:ERROR:foo.cc(1)] something']});
  assert.deepEqual(launchDiagnostics(error), [
    'first try, with the sandbox: browserType.launch: Target page, context or browser has been closed',
    'last try, without the graphics process: browserType.launch: Target page, context or browser has been closed',
    'last try: <process did exit: exitCode=3221225477, signal=null>',
    'last try: [0101/000000:ERROR:foo.cc(1)] something',
    '<process did exit: exitCode=3221225477, signal=null>']);
});
