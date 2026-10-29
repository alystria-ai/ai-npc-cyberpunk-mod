import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PCM_MODULES, RealtimeHost, SANDBOX_STATE_FILE, resetSandboxMemory} from './realtime-host.mjs';
import {launchSystemBrowser, systemBrowserAvailable} from './system-browser.mjs';

// The hidden Chromium runs with its renderer sandbox on (security review 2026-10-22, finding 8: Playwright adds --no-sandbox unless chromiumSandbox
// is true). It is trusted only after one blank page has opened and run a line; a browser that will not start, hangs, or whose pages die is started
// once more without the sandbox, and the result is remembered by every host of the process and on disk.
const EXE = 'C:\\Fake\\Browser\\msedge.exe';

/** A browser whose pages behave as `page` says: 'works', 'crashes' (every call rejects), 'hangs' (goto never answers). */
function fakeBrowser(page = 'works') {
  const browser = {closed: 0, pages: 0, isConnected: () => true, close: async () => { browser.closed += 1; },
    newPage: async () => {
      browser.pages += 1;
      return {goto: async () => { if (page === 'crashes') throw Error('page.goto: Page crashed'); if (page === 'hangs') await new Promise(() => {}); },
        evaluate: async () => { if (page === 'crashes') throw Error('page.evaluate: Page crashed'); return 2; }, close: async () => {}};
    }};
  return browser;
}

// The page files the host serves, as empty files: nothing here opens a page.
async function assetsFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'host-sandbox-'));
  for (const name of ['realtime-client.js', ...PCM_MODULES]) await writeFile(join(folder, name), '');
  return folder;
}

const hosts = [];
async function hostWith(launch, extra = {}) {
  const logs = [], folder = await assetsFolder();
  const host = new RealtimeHost({browserExecutable: EXE, clientAssetsDirectory: folder, launchBrowser: launch, log: line => logs.push(line), sandboxStatePath: null, ...extra});
  const done = async () => { await host.close?.().catch(() => {}); await rm(folder, {recursive: true, force: true}); };
  hosts.push(done);
  return {host, logs, done};
}
const cleanUp = async () => { while (hosts.length) await hosts.pop()(); resetSandboxMemory(); };

test('the hidden browser is launched with its sandbox on, and stays that way when it starts', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const seen = [];
  const {host, logs} = await hostWith(async options => { seen.push(options); return fakeBrowser(); });
  await host.start();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].chromiumSandbox, true);
  assert.equal(seen[0].executablePath, EXE);
  assert.equal(seen[0].headless, true);
  assert.ok(!seen[0].args.includes('--no-sandbox'), 'the sandbox is never switched off by an argument');
  assert.equal(seen[0].timeout, undefined, 'a launcher a test hands in is not probed and gets no launch timeout');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /runs with its sandbox/);
});

test('a browser that will not start with its sandbox is started once without it and the reason is logged', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const seen = [];
  const {host, logs} = await hostWith(async options => {
    seen.push(options.chromiumSandbox);
    if (options.chromiumSandbox) throw Error('browserType.launch: Browser closed unexpectedly: sandbox initialization failed\nCall log:\n  - something with a path');
    return fakeBrowser();
  });
  await host.start();
  assert.deepEqual(seen, [true, false]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /would not work with its sandbox \(browserType\.launch: Browser closed unexpectedly: sandbox initialization failed\); it runs without it/);
  assert.ok(!logs[0].includes('Call log') && !logs[0].includes('\n'), 'only the first line of the reason');
  // The browser dies and is started again: the sandbox is not tried a second time.
  await host.browser.close();
  host.browser = null;
  await host.start();
  assert.deepEqual(seen, [true, false, false]);
  assert.equal(logs.length, 1, 'said once per process');
});

test('a browser that starts but whose first page crashes (Wine, Proton, exFAT, security software) is closed and started again without the sandbox', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const launched = [];
  const {host, logs} = await hostWith(async options => { const browser = fakeBrowser(options.chromiumSandbox ? 'crashes' : 'works'); launched.push({options, browser}); return browser; }, {probeSandbox: true});
  await host.start();
  assert.deepEqual(launched.map(({options}) => options.chromiumSandbox), [true, false]);
  assert.equal(launched[0].options.timeout, 20_000, 'the sandboxed try has a launch time limit, not Playwright\'s 180 s');
  assert.equal(launched[0].browser.pages, 1, 'one blank page was opened to find out');
  assert.equal(launched[0].browser.closed, 1, 'the browser with the dead pages was closed');
  assert.equal(launched[1].options.timeout, undefined);
  assert.equal(host.browser, launched[1].browser);
  assert.match(logs.at(-1), /would not work with its sandbox \(page\.goto: Page crashed\)/);
});

test('a first page that never answers does not hang the start: it times out, and the browser runs without the sandbox', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const launched = [];
  const {host} = await hostWith(async options => { const browser = fakeBrowser(options.chromiumSandbox ? 'hangs' : 'works'); launched.push({options, browser}); return browser; },
    {probeSandbox: true, sandboxTimeouts: {probeMs: 50, closeMs: 50}});
  const began = Date.now();
  await host.start();
  assert.ok(Date.now() - began < 5000, 'seconds, not minutes');
  assert.deepEqual(launched.map(({options}) => options.chromiumSandbox), [true, false]);
  assert.equal(launched[0].browser.closed, 1);
});

test('a browser that works with the sandbox is probed once, per start, and not again', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const launched = [];
  const {host} = await hostWith(async options => { const browser = fakeBrowser(); launched.push({options, browser}); return browser; }, {probeSandbox: true});
  await host.start();
  assert.deepEqual(launched.map(({options}) => options.chromiumSandbox), [true]);
  assert.equal(launched[0].browser.pages, 1, 'the probe page only; the host opens its pages later, on the first turn');
  assert.equal(launched[0].browser.closed, 0);
});

test('what one host learns is shared by the others and kept on disk, per browser, for 30 days', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const folder = await mkdtemp(join(tmpdir(), 'host-sandbox-state-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const statePath = join(folder, SANDBOX_STATE_FILE);
  const tried = [];
  const launch = async options => { tried.push(`${options.executablePath ?? options.channel}:${options.chromiumSandbox}`); return fakeBrowser(options.chromiumSandbox ? 'crashes' : 'works'); };
  const first = await hostWith(launch, {probeSandbox: true, sandboxStatePath: statePath});
  await first.host.start();
  assert.deepEqual(tried, [`${EXE}:true`, `${EXE}:false`]);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.version, 1);
  assert.ok(Number.isFinite(saved.refused[EXE]));
  assert.match(saved.reason, /Page crashed/);
  // The second and third host of the same process (the bridge has three) go straight to a browser without the sandbox.
  const second = await hostWith(launch, {probeSandbox: true, sandboxStatePath: statePath});
  await second.host.start();
  assert.deepEqual(tried.slice(2), [`${EXE}:false`]);
  // A new process: nothing in memory, the file says it.
  resetSandboxMemory();
  const later = await hostWith(launch, {probeSandbox: true, sandboxStatePath: statePath});
  await later.host.start();
  assert.deepEqual(tried.slice(3), [`${EXE}:false`], 'the sandbox is not tried at every start');
  assert.match(later.logs[0], /earlier start found it does not work on this PC/);
  // Another browser is tried on its own.
  resetSandboxMemory();
  const other = await hostWith(launch, {probeSandbox: true, sandboxStatePath: statePath, browserExecutable: 'C:\\Fake\\Other\\chrome.exe'});
  await other.host.start();
  assert.deepEqual(tried.slice(4), ['C:\\Fake\\Other\\chrome.exe:true', 'C:\\Fake\\Other\\chrome.exe:false']);
  // An entry older than 30 days is forgotten: the sandbox is tried again.
  resetSandboxMemory();
  await writeFile(statePath, JSON.stringify({version: 1, refused: {[EXE]: Date.now() - 31 * 86_400_000}}));
  const tried2 = tried.length;
  const old = await hostWith(launch, {probeSandbox: true, sandboxStatePath: statePath});
  await old.host.start();
  assert.deepEqual(tried.slice(tried2), [`${EXE}:true`, `${EXE}:false`]);
  // A damaged file is just a file that says nothing.
  resetSandboxMemory();
  await writeFile(statePath, '{not json');
  const damaged = await hostWith(launch, {probeSandbox: true, sandboxStatePath: statePath});
  await damaged.host.start();
  assert.equal(tried.at(-2), `${EXE}:true`);
});

test('a browser that is not there is not retried without the sandbox, and a failure without it is the error that is reported', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const seen = [];
  const missing = await hostWith(async options => { seen.push(options.chromiumSandbox); throw Error('browserType.launch: Executable doesn\'t exist at C:\\Fake'); });
  await assert.rejects(missing.host.start(), /program is not there/);
  assert.deepEqual(seen, [true]);

  const broken = [];
  const both = await hostWith(async options => { broken.push(options.chromiumSandbox); throw Error(options.chromiumSandbox ? 'sandbox failure' : 'still broken'); });
  await assert.rejects(both.host.start(), /still broken/);
  assert.deepEqual(broken, [true, false]);
  // Nothing was learned from a start that failed both ways: the next start tries the sandbox again.
  const again = [];
  const next = await hostWith(async options => { again.push(options.chromiumSandbox); return fakeBrowser(); });
  await next.host.start();
  assert.deepEqual(again, [true], 'a failed start remembers nothing');
});

// 27 Oct 2026, install 0d0750: Edge on an AMD RX 9070 XT quit at once with and without the sandbox ("Target page, context or browser has been closed"), so no voice played at all.
test('a browser that goes away at once even without the sandbox is started once more without its graphics process, and that is remembered', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const folder = await mkdtemp(join(tmpdir(), 'host-sandbox-state-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const statePath = join(folder, SANDBOX_STATE_FILE);
  const closed = () => Error('browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n<launched> pid=1\n<process did exit: exitCode=21, signal=null>');
  const tried = [];
  const launch = async options => {
    const noGraphics = (options.args ?? []).includes('--disable-gpu');
    tried.push(`${options.chromiumSandbox}:${noGraphics}`);
    if (!noGraphics) throw closed();
    return fakeBrowser();
  };
  const first = await hostWith(launch, {sandboxStatePath: statePath});
  await first.host.start();
  assert.deepEqual(tried, ['true:false', 'false:false', 'false:true']);
  assert.match(first.logs.join('\n'), /went away at once .*; it runs without its graphics process/);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.ok(Number.isFinite(saved.graphicsOff[EXE]) && Number.isFinite(saved.refused[EXE]));
  // The next start, in this process or a new one, goes straight to the way that works.
  tried.length = 0;
  const second = await hostWith(launch, {sandboxStatePath: statePath});
  await second.host.start();
  assert.deepEqual(tried, ['false:true']);
  resetSandboxMemory(); tried.length = 0;
  const later = await hostWith(launch, {sandboxStatePath: statePath});
  await later.host.start();
  assert.deepEqual(tried, ['false:true'], 'read from the file');
});

test('a browser that goes away at once every way carries every earlier reason, and a browser that is not there or fails otherwise gets no graphics retry', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const tried = [];
  const both = await hostWith(async options => {
    tried.push(`${options.chromiumSandbox}:${(options.args ?? []).includes('--disable-gpu')}`);
    throw Error(options.chromiumSandbox ? 'browserType.launch: Browser closed unexpectedly' : 'browserType.launch: Target page, context or browser has been closed');
  });
  await assert.rejects(both.host.start(), error => {
    assert.match(error.message, /would not start: Target page, context or browser has been closed/);
    const lines = error.diagnostic.join('\n');
    assert.match(lines, /first try, with the sandbox: browserType\.launch: Browser closed unexpectedly/);
    assert.match(lines, /last try, without the graphics process: browserType\.launch: Target page, context or browser has been closed/);
    return true;
  });
  assert.deepEqual(tried, ['true:false', 'false:false', 'false:true']);
  // Nothing was learned from a start that failed every way.
  const again = [];
  const next = await hostWith(async options => { again.push(`${options.chromiumSandbox}:${(options.args ?? []).includes('--disable-gpu')}`); return fakeBrowser(); });
  await next.host.start();
  assert.deepEqual(again, ['true:false']);

  resetSandboxMemory();
  const other = [];
  const odd = await hostWith(async options => { other.push(options.chromiumSandbox); throw Error(options.chromiumSandbox ? 'sandbox failure' : 'still broken'); });
  await assert.rejects(odd.host.start(), /still broken/);
  assert.deepEqual(other, [true, false], 'a failure that is not a vanished browser is not retried');
});

test('CYBERPUNK_CONVAI_NO_BROWSER_SANDBOX=1 starts the browser without the sandbox, without a probe', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const before = process.env.CYBERPUNK_CONVAI_NO_BROWSER_SANDBOX;
  process.env.CYBERPUNK_CONVAI_NO_BROWSER_SANDBOX = '1';
  t.after(() => { if (before === undefined) delete process.env.CYBERPUNK_CONVAI_NO_BROWSER_SANDBOX; else process.env.CYBERPUNK_CONVAI_NO_BROWSER_SANDBOX = before; });
  const seen = [];
  const {host} = await hostWith(async options => { seen.push(options.chromiumSandbox); return fakeBrowser(); }, {probeSandbox: true});
  await host.start();
  assert.deepEqual(seen, [false]);
});

test('a real Edge or Chrome passes the probe with the sandbox on (skipped where no browser is installed)', {skip: !systemBrowserAvailable() && 'no system browser'}, async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const logs = [];
  const host = new RealtimeHost({log: line => logs.push(line), sandboxStatePath: null});
  assert.equal(host.probeSandbox, true, 'the real launcher is probed');
  const browser = await launchSystemBrowser(choice => host.launchWithSandbox({...choice, headless: true, args: ['--mute-audio']}), {log: () => {}});
  try {
    const page = await browser.newPage();
    assert.equal(await page.evaluate(() => 40 + 2), 42);
  } finally { await browser.close(); }
  assert.ok(logs.some(line => /runs with its sandbox/.test(line)), `the sandbox stayed on: ${logs.join(' | ')}`);
});

test('a renderer that never opens its first page does not hang the start, and a timeout is not written to disk as a 30-day verdict', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const folder = await mkdtemp(join(tmpdir(), 'host-sandbox-state-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const statePath = join(folder, SANDBOX_STATE_FILE);
  const launched = [];
  const {host, logs} = await hostWith(async options => {
    const browser = fakeBrowser();
    if (options.chromiumSandbox) browser.newPage = async () => new Promise(() => {}); // the renderer never comes up
    launched.push(options.chromiumSandbox);
    return browser;
  }, {probeSandbox: true, sandboxStatePath: statePath, sandboxTimeouts: {probeMs: 50, closeMs: 50}});
  const began = Date.now();
  await host.start();
  assert.ok(Date.now() - began < 5000, 'seconds, not minutes');
  assert.deepEqual(launched, [true, false]);
  assert.match(logs.at(-1), /took longer than/);
  await assert.rejects(readFile(statePath, 'utf8'), /ENOENT/, 'a slow start is remembered for this process only');
  // This process still goes straight to the browser without the sandbox.
  host.browser = null;
  await host.start();
  assert.deepEqual(launched, [true, false, false]);
});

test('a sandbox that passed the probe is not probed again by a later launch of the same browser in this process', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const browsers = [];
  const launch = async () => { const browser = fakeBrowser(); browsers.push(browser); return browser; };
  const {host} = await hostWith(launch, {probeSandbox: true});
  await host.start();
  host.browser = null;
  await host.start();
  assert.deepEqual(browsers.map(browser => browser.pages), [1, 0], 'the second launch costs no probe page');
});

test('the hidden browser tree is raised to high after the start and again after a page opens, joined by the keeper; never without the level, and it is stopped with the browser', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const calls = [];
  const {host, logs} = await hostWith(async () => fakeBrowser(), {browserPriority: 'high', setBrowserTree: async (level, {rootPid}) => { calls.push([level, rootPid]); return 5; }});
  await host.start();
  await new Promise(done => setTimeout(done, 700));
  assert.deepEqual(calls, [['high', process.pid]], 'one call for the start and the pages opened with it');
  assert.ok(logs.some(line => /hidden browser priority: high for 5 processes/.test(line)));
  const before = host.browser.pages;
  await host.browser.newPage();
  assert.equal(host.browser.pages, before + 1, 'the wrapped newPage still opens the page');
  assert.equal(host.priorityKeeper.timer !== null || host.priorityKeeper.running, true, 'a page asks for the tree again');
  await host.close();
  assert.equal(host.priorityKeeper.timer, null, 'nothing is scheduled for a closed browser');
  const plain = await hostWith(async () => fakeBrowser(), {setBrowserTree: async () => { throw Error('must not run'); }});
  await plain.host.start();
  assert.equal(plain.host.priorityKeeper, null, 'no level, no keeper');
  const normal = await hostWith(async () => fakeBrowser(), {browserPriority: 'normal', setBrowserTree: async () => { throw Error('must not run'); }});
  assert.equal(normal.host.priorityKeeper, null, 'priority = normal leaves the browser as it starts');
});

// Report 144971a28fc434ac (29 Oct 2026): Edge on an AMD RX 9070 XT crashed (0xC0000005) with the sandbox, without it and without the graphics process. The report held the first line of the last try only.
test('a browser that crashes every way, the last try too, carries the last try\'s own exit code in the diagnostic', async t => {
  resetSandboxMemory(); t.after(cleanUp);
  const crash = code => Error(`browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n<launched> pid=1\n[pid=1] <process did exit: exitCode=${code}, signal=null>`);
  const tried = [];
  const {host} = await hostWith(async options => {
    const noGraphics = (options.args ?? []).includes('--disable-gpu');
    tried.push(`${options.chromiumSandbox}:${noGraphics}`);
    throw crash(noGraphics ? 3221226505 : 3221225477);
  });
  await assert.rejects(host.start(), error => {
    assert.deepEqual(tried, ['true:false', 'false:false', 'false:true']);
    assert.ok(error.diagnostic.includes('last try: <process did exit: exitCode=3221226505, signal=null>'), error.diagnostic.join(' / '));
    assert.ok(error.diagnostic.includes('<process did exit: exitCode=3221225477, signal=null>'), 'the first no-sandbox try keeps its own exit line');
    assert.match(error.message, /(exit code 3221225477)/);
    return true;
  });
});
