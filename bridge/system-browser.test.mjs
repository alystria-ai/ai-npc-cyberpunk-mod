import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {NO_BROWSER_MESSAGE, SYSTEM_BROWSERS, installedSystemBrowsers, launchSystemBrowser, systemBrowserAvailable} from './system-browser.mjs';

const env = {LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)'};
const at = (...paths) => path => paths.includes(path);
const edgeIn = root => join(root, 'Microsoft\\Edge\\Application\\msedge.exe');
const chromeIn = root => join(root, 'Google\\Chrome\\Application\\chrome.exe');
const channels = options => installedSystemBrowsers({env, platform: 'win32', ...options}).map(item => item.channel);

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
  assert.equal(systemBrowserAvailable({env, platform: 'win32', exists: at(edge)}), true);
  assert.equal(systemBrowserAvailable({env, platform: 'win32', exists: () => false}), false);
  assert.equal(systemBrowserAvailable({env: {...env, CYBERPUNK_CONVAI_BROWSER: 'C:\\dev\\browser.exe'}, platform: 'win32', exists: () => false}), true);
});

test('the launch uses the Edge channel, and a developer executable replaces the lookup', async () => {
  const calls = [], browser = {};
  assert.equal(await launchSystemBrowser(async options => { calls.push(options); return browser; }), browser);
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
  assert.equal(await launchSystemBrowser(launch, {log: line => logs.push(line)}), browser);
  assert.deepEqual(calls, ['msedge', 'chrome']); assert.deepEqual(logs, []);
});

test('with neither browser the error says what to install and exactly one line is logged', async () => {
  const logs = [];
  const launch = async ({channel}) => { throw Error(`Chromium distribution '${channel}' is not found at C:\\missing`); };
  await assert.rejects(launchSystemBrowser(launch, {log: line => logs.push(line)}), error => {
    assert.equal(error.message, NO_BROWSER_MESSAGE); assert.equal(error.code, 'NO_BROWSER'); return true;
  });
  assert.deepEqual(logs, [NO_BROWSER_MESSAGE]);
  assert.match(NO_BROWSER_MESSAGE, /Microsoft Edge[^]*Google Chrome/);
});

test('an installed browser that fails to start is reported as itself, not as missing', async () => {
  const logs = [];
  const launch = async ({channel}) => { throw Error(channel === 'msedge' ? 'browserType.launch: Target closed' : "Chromium distribution 'chrome' is not found"); };
  await assert.rejects(launchSystemBrowser(launch, {log: line => logs.push(line)}), {message: 'browserType.launch: Target closed'});
  assert.equal(logs.length, 1); assert.match(logs[0], /did not start/);
});
