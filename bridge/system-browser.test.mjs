import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {NO_BROWSER_MESSAGE, OTHER_CHROMIUM_BROWSERS, SYSTEM_BROWSERS, installedSystemBrowsers, launchSystemBrowser, parseAppPath, registeredPaths,
  systemBrowserAvailable, systemBrowserCandidates} from './system-browser.mjs';

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
  const logs = [];
  const launch = async ({channel}) => { throw Error(channel === 'msedge' ? 'browserType.launch: Target closed' : "Chromium distribution 'chrome' is not found"); };
  await assert.rejects(launchSystemBrowser(launch, {...machine([edgeIn(env.PROGRAMFILES)]), log: line => logs.push(line)}), {message: 'browserType.launch: Target closed'});
  assert.equal(logs.length, 1); assert.match(logs[0], /did not start/);
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
