import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PCM_MODULES, RealtimeHost} from './realtime-host.mjs';
import {launchSystemBrowser, systemBrowserAvailable} from './system-browser.mjs';

// The hidden Chromium runs with its renderer sandbox on (security review 2026-10-22, finding 8: Playwright adds --no-sandbox unless
// chromiumSandbox is true). If the browser will not start that way it is started once without it, with the reason logged.
const EXE = 'C:\\Fake\\Browser\\msedge.exe';
const fakeBrowser = () => ({isConnected: () => true, close: async () => {}, newPage: async () => { throw Error('not used'); }});

// The page files the host serves, as empty files: nothing here opens a page.
async function assetsFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'host-sandbox-'));
  for (const name of ['realtime-client.js', ...PCM_MODULES]) await writeFile(join(folder, name), '');
  return folder;
}

async function hostWith(launch) {
  const logs = [], folder = await assetsFolder();
  const host = new RealtimeHost({browserExecutable: EXE, clientAssetsDirectory: folder, launchBrowser: launch, log: line => logs.push(line)});
  const done = async () => { await host.close?.().catch(() => {}); await rm(folder, {recursive: true, force: true}); };
  return {host, logs, done};
}

test('the hidden browser is launched with its sandbox on, and stays that way when it starts', async () => {
  const seen = [];
  const {host, logs, done} = await hostWith(async options => { seen.push(options); return fakeBrowser(); });
  await host.start();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].chromiumSandbox, true);
  assert.equal(seen[0].executablePath, EXE);
  assert.equal(seen[0].headless, true);
  assert.ok(!seen[0].args.includes('--no-sandbox'), 'the sandbox is never switched off by an argument');
  assert.equal(host.sandboxRefused, undefined);
  assert.deepEqual(logs, []);
  await done();
});

test('a browser that will not start with its sandbox is started once without it, the reason is logged, and later starts go straight to that', async () => {
  const seen = [];
  const {host, logs, done} = await hostWith(async options => {
    seen.push(options.chromiumSandbox);
    if (options.chromiumSandbox) throw Error('browserType.launch: Browser closed unexpectedly: sandbox initialization failed\nCall log:\n  - something with a path');
    return fakeBrowser();
  });
  await host.start();
  assert.deepEqual(seen, [true, false]);
  assert.equal(host.sandboxRefused, true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /would not start with its sandbox \(browserType\.launch: Browser closed unexpectedly: sandbox initialization failed\); it runs without it/);
  assert.ok(!logs[0].includes('Call log') && !logs[0].includes('\n'), 'only the first line of the reason');
  // The browser dies and is started again: the sandbox is not tried a second time.
  await host.browser.close();
  host.browser = null;
  await host.start();
  assert.deepEqual(seen, [true, false, false]);
  assert.equal(logs.length, 1, 'said once');
  await done();
});

test('a browser that is not there is not retried without the sandbox, and a failure without it is the error that is reported', async () => {
  const seen = [];
  const missing = await hostWith(async options => { seen.push(options.chromiumSandbox); throw Error('browserType.launch: Executable doesn\'t exist at C:\\Fake'); });
  await assert.rejects(missing.host.start(), /program is not there/);
  assert.deepEqual(seen, [true]);
  assert.equal(missing.host.sandboxRefused, undefined);
  await missing.done();

  const broken = [];
  const both = await hostWith(async options => { broken.push(options.chromiumSandbox); throw Error(options.chromiumSandbox ? 'sandbox failure' : 'still broken'); });
  await assert.rejects(both.host.start(), /still broken/);
  assert.deepEqual(broken, [true, false]);
  assert.equal(both.host.sandboxRefused, undefined, 'only a start that worked without it is remembered');
  await both.done();
});

test('a real Edge or Chrome starts headless with the sandbox on and runs a page (skipped where no browser is installed)', {skip: !systemBrowserAvailable() && 'no system browser'}, async () => {
  const {chromium} = await import('playwright');
  let started = null;
  const browser = await launchSystemBrowser(choice => chromium.launch({...choice, headless: true, chromiumSandbox: true, args: ['--mute-audio']}),
    {log: () => {}});
  try {
    started = await (await browser.newPage()).evaluate(() => 40 + 2);
  } finally { await browser.close(); }
  assert.equal(started, 42);
});
