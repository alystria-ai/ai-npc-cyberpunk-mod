// The custom (OpenAI-compatible) provider in a real bridge process, the setup check and the support report (docs/CUSTOM_PROVIDER.md).
// The bridge runs in the disposable world of bridge/bridge-run-fixture.mjs, whose guard refuses every outward effect and logs it, so what
// the bridge tried to contact is read from that log: no real network and no real provider here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launchBridge} from './bridge-run-fixture.mjs';
import {collectSetupCheck, neededServices} from './setup-check.mjs';
import {collectReport, conversationSection} from './support-report.mjs';
import {fakeInstall} from './support-report-fixture.mjs';

const KEY = 'test' + 'x'.repeat(28);
const FILE = 'player-custom-endpoint.txt';
const fileText = ({endpoint, model = 'llama3.2', key}) => `endpoint=${endpoint}\nmodel=${model}\n${key ? `api-key=${key}\n` : ''}`;

// No key is in any file the bridge wrote for the game (the player's own private file in the state folder is the one place), in a log or in its output.
async function assertNoKey(bridge) {
  const files = (await readdir(bridge.runtime)).map(name => join(bridge.runtime, name));
  const texts = [bridge.output(), bridge.errors(), ...await Promise.all(files.map(path => readFile(path, 'utf8').catch(() => '')))];
  assert.ok(!texts.some(text => text.includes(KEY)), 'the key was written out');
}

test('saved settings that are not chosen: published for the settings page, nothing contacted, the key nowhere', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'convai', voice: false}, stateFiles: {[FILE]: fileText({endpoint: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.1-8b-instruct:free', key: KEY})}});
  try {
    await bridge.ready();
    const state = await bridge.until(() => bridge.read('custom-provider-state.json'), value => value?.version === 1, 'the custom provider state was not published');
    assert.deepEqual({host: state.host, secure: state.secure, local: state.local, model: state.model, ready: state.ready, keySaved: state.keySaved, tail: state.tail, limit: state.limit},
      {host: 'openrouter.ai', secure: true, local: false, model: 'meta-llama/llama-3.1-8b-instruct:free', ready: true, keySaved: true, tail: KEY.slice(-4), limit: null});
    assert.equal(state.result, undefined);
    const provider = await bridge.read('mistral-state.json');
    assert.deepEqual([provider.provider, provider.effective, provider.pending], ['convai', 'convai', false]);
    await bridge.idle(1500);
    assert.deepEqual(await bridge.forbidden(), [], 'no request to the saved endpoint, or anywhere, unless the provider is chosen');
    assert.doesNotMatch(bridge.errors(), /openrouter/i, 'the log does not even name the endpoint');
    await assertNoKey(bridge);
  } finally { await bridge.cleanup(); }
});

test('chosen with a server on this computer: applied before the bridge is ready, no warm-up, no request, host and model in the log, never the key', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'custom', voice: false},
    stateFiles: {[FILE]: fileText({endpoint: 'http://localhost:11434/v1', model: 'llama3.2', key: KEY})}});
  try {
    await bridge.ready();
    const provider = await bridge.read('mistral-state.json');
    assert.deepEqual([provider.provider, provider.effective, provider.pending], ['custom', 'custom', false]);
    assert.match(bridge.errors(), /Conversation provider: custom/);
    assert.match(bridge.errors(), /\[Custom\] host localhost:11434, model llama3\.2, key saved/);
    await bridge.idle(1500);
    assert.deepEqual(await bridge.forbidden(), [], 'a local server has no TLS to warm, and no turn was asked for');
    await assertNoKey(bridge);
  } finally { await bridge.cleanup(); }
});

test('chosen with a cloud endpoint: the one connection warm-up goes to that origin alone', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'custom', voice: false},
    stateFiles: {[FILE]: fileText({endpoint: 'https://openrouter.ai/api/v1/', model: 'a/b:free', key: KEY})}});
  try {
    await bridge.ready();
    const attempts = await bridge.until(() => bridge.forbidden(), lines => lines.some(line => line.includes('openrouter.ai')), 'no warm-up request was attempted');
    for (const line of attempts.filter(line => !/^(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\b/.test(line))) {
      assert.match(line, /^fetch (?:data:,|https:\/\/openrouter\.ai\/)$/, 'a request to another address');
    }
    assert.doesNotMatch(attempts.join('\n'), /api\.mistral\.ai|api\.convai\.com/);
    await assertNoKey(bridge);
  } finally { await bridge.cleanup(); }
});

test('chosen but not set up: Convai answers, nothing is contacted for it, and the settings page can say why', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'custom', voice: false}, stateFiles: {[FILE]: 'api-key=' + KEY + '\n'}});
  try {
    await bridge.ready();
    const provider = await bridge.read('mistral-state.json');
    assert.deepEqual([provider.provider, provider.effective, provider.pending], ['custom', 'convai', false]);
    const state = await bridge.read('custom-provider-state.json');
    assert.deepEqual([state.ready, state.host, state.model, state.keySaved], [false, null, null, true]);
    assert.doesNotMatch(bridge.errors(), /Conversation provider: custom/);
  } finally { await bridge.cleanup(); }
});

test('the settings page\'s commands in a real bridge: a paste with no readable clipboard is "unreadable", Test connection makes exactly one request to the saved endpoint, and a file written by hand is picked up', {timeout: 60000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'convai', voice: false}, runtimeFiles: {'custom-provider-command.json': ''},
    stateFiles: {[FILE]: fileText({endpoint: 'http://127.0.0.1:9/v1', model: 'llama3.2', key: KEY})}});
  try {
    await bridge.ready();
    let sequence = 0;
    const send = async action => {
      const id = `fixture:cust:${++sequence}`;
      await bridge.write('custom-provider-command.json', JSON.stringify({version: 1, id, action, issuedAt: Date.now()}));
      return id;
    };
    // The clipboard needs a program to be started, which this world refuses: the page is told it could not be read, and nothing is changed.
    let id = await send('paste-key');
    let state = await bridge.until(() => bridge.read('custom-provider-state.json'), value => value?.result?.id === id && value.result.state !== 'checking', 'the paste was not answered');
    assert.deepEqual([state.result.field, state.result.state, state.keySaved, state.host], ['key', 'unreadable', true, '127.0.0.1:9']);
    // Test connection: one request, to the saved endpoint only; its failure comes back in words the page has a sentence for.
    id = await send('test');
    state = await bridge.until(() => bridge.read('custom-provider-state.json'), value => value?.test?.id === id && value.test.state !== 'testing', 'the test was not answered', 20000);
    assert.equal(state.test.state, 'failed');
    assert.equal(state.test.code, 'unreachable');
    const attempts = (await bridge.forbidden()).filter(line => /^fetch /.test(line));
    assert.deepEqual(attempts, ['fetch http://127.0.0.1:9/v1/chat/completions'], 'the one tiny request');
    // A file edited by hand while the game runs is read again at the next test.
    await writeFile(join(bridge.state, FILE), fileText({endpoint: 'http://127.0.0.1:10/v1', model: 'other-model'}));
    id = await send('test');
    state = await bridge.until(() => bridge.read('custom-provider-state.json'), value => value?.test?.id === id && value.test.state !== 'testing', 'the second test was not answered', 20000);
    assert.deepEqual([state.host, state.model, state.keySaved], ['127.0.0.1:10', 'other-model', false]);
    assert.ok((await bridge.forbidden()).includes('fetch http://127.0.0.1:10/v1/chat/completions'));
    await assertNoKey(bridge);
    assert.doesNotMatch(bridge.errors(), /Settings poll|TypeError|ReferenceError|Unhandled/);
  } finally { await bridge.cleanup(); }
});

// ---- The setup check ---------------------------------------------------------------------------------------------------------------

async function withInstall(run) {
  const root = await mkdtemp(join(tmpdir(), 'custom-setup-'));
  try {
    const paths = {game: join(root, 'game'), modRoot: join(root, 'game', 'mods'), project: join(root, 'app'), stateDirectory: join(root, 'state')};
    for (const folder of Object.values(paths)) await mkdir(folder, {recursive: true});
    return await run(paths);
  } finally { await rm(root, {recursive: true, force: true}); }
}
const setupOptions = (paths, over) => ({...paths, now: () => 1_800_000_000_000, localAi: () => ({status: 'ready', packInstalled: false, tiers: {}, models: []}),
  omniPack: () => ({installed: false, missing: []}), browser: () => 'Edge', graphics: async () => [], modManagers: () => ({managers: []}),
  nestedPacks: async () => [], placement: async () => null, ...over});

test('setup check: only the chosen endpoint\'s host is looked up, with its port, and only when that provider is chosen', async () => withInstall(async paths => {
  const seen = [];
  const reach = async (host, extra) => { seen.push([host, extra?.port]); return 'reachable'; };
  const custom = () => ({hostname: 'openrouter.ai', host: 'openrouter.ai', port: 443, secure: true});
  const internet = async settings => { seen.length = 0; return (await collectSetupCheck(setupOptions(paths, {settings, reach, custom}))).checks.find(check => check.id === 'internet'); };
  assert.deepEqual(await internet({conversationProvider: 'custom', voiceProvider: 'pocket'}), {id: 'internet', state: 'ok', code: 'reachable', service: 'custom', host: 'openrouter.ai'});
  assert.deepEqual(seen, [['openrouter.ai', 443]]);
  // Another provider chosen: the endpoint is never looked at.
  assert.equal((await internet({conversationProvider: 'convai'})).service, 'convai');
  assert.deepEqual(seen.map(([host]) => host), ['api.convai.com']);
  assert.equal((await internet({conversationProvider: 'mistral'})).service, 'mistral');
  assert.equal((await internet({conversationProvider: 'local', voiceProvider: 'pocket'})).code, 'not-needed');
  assert.deepEqual(seen, []);
  // The Voxtral voice still needs Mistral beside the custom text provider.
  assert.deepEqual((await internet({conversationProvider: 'custom', voiceProvider: 'voxtral'})) && seen.map(([host]) => host), ['openrouter.ai', 'api.mistral.ai']);
  // A server on this computer: its own name and port, shown with the port and no path.
  const local = () => ({hostname: 'localhost', host: 'localhost:11434', port: 11434, secure: false});
  seen.length = 0;
  const result = (await collectSetupCheck(setupOptions(paths, {settings: {conversationProvider: 'custom'}, reach: async (host, extra) => { seen.push([host, extra?.port]); return 'blocked'; }, custom: local}))).checks.find(check => check.id === 'internet');
  assert.deepEqual(result, {id: 'internet', state: 'problem', code: 'blocked', service: 'custom', host: 'localhost:11434'});
  assert.deepEqual(seen, [['localhost', 11434]]);
  // Chosen but not set up (the bridge has no endpoint to give): Convai answers, so Convai is what is checked.
  const none = (await collectSetupCheck(setupOptions(paths, {settings: {conversationProvider: 'custom'}, reach, custom: () => null}))).checks.find(check => check.id === 'internet');
  assert.equal(none.service, 'convai');
  // The light first run makes no connection at all.
  seen.length = 0;
  const light = (await collectSetupCheck(setupOptions(paths, {settings: {conversationProvider: 'custom'}, reach, custom, light: true}))).checks.find(check => check.id === 'internet');
  assert.deepEqual([light.code, light.service, light.host, seen], ['unknown', 'custom', 'openrouter.ai', []]);
  // The pure part.
  assert.deepEqual(neededServices({conversationProvider: 'custom'}, {custom: {hostname: 'x'}}), ['custom']);
  assert.deepEqual(neededServices({conversationProvider: 'custom'}), ['convai']);
  assert.deepEqual(neededServices({conversationProvider: 'custom', voiceProvider: 'convai'}), ['convai']);
}));

// ---- The support report ------------------------------------------------------------------------------------------------------------

test('the support report: provider = custom, the endpoint host only and the model id; no path, no query, no key', async () => {
  const f = await fakeInstall();
  try {
    await f.put(join(f.runtime, 'settings.json'), JSON.stringify({version: 2, conversationProvider: 'custom', voiceProvider: 'pocket'}));
    await f.put(join(f.runtime, 'mistral-state.json'), JSON.stringify({version: 1, provider: 'custom', effective: 'custom', saved: false}));
    // A state that (wrongly) carried more than the host: the report still shows the host alone.
    await f.put(join(f.runtime, 'custom-provider-state.json'), JSON.stringify({version: 1, ready: true, host: 'openrouter.ai/api/v1?token=abc', secure: true, local: false,
      model: 'meta-llama/llama-3.1-8b-instruct:free', keySaved: true, tail: KEY.slice(-4), limit: null, test: {id: 'a', state: 'failed', code: 'key', status: 401, detail: `bad key ${KEY}`}}));
    await f.put(join(f.state, 'bridge.stderr.log'), `[Custom] host openrouter.ai, model a/b\nrequest failed with ${KEY} in it\n`);
    const {entries, summary} = await collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project, reportId: 'r-custom', secrets: [KEY]});
    assert.deepEqual(summary.conversation, {provider: 'custom', effective: 'custom', custom: {host: 'openrouter.ai', model: 'meta-llama/llama-3.1-8b-instruct:free', ready: true,
      keySaved: true, secure: true, local: false, limit: null, lastTest: {state: 'failed', code: 'key', status: 401}}});
    const text = entries.map(entry => `${entry.name}\n${entry.data}`).join('\n');
    assert.ok(!text.includes(KEY), 'the key reached the report');
    assert.ok(!text.includes(KEY.slice(-4) + '"'), 'not even its last four characters');
    assert.doesNotMatch(text, /api\/v1|token=abc/, 'only the host, no path and no query');
    assert.doesNotMatch(text, /bad key/, 'what a server said is not copied');
    // Not chosen and nothing saved: just the provider.
    await rm(join(f.runtime, 'custom-provider-state.json'));
    assert.deepEqual(await conversationSection({runtime: f.runtime, settings: {conversationProvider: 'mistral'}}), {provider: 'mistral', effective: 'custom'});
    assert.deepEqual((await conversationSection({runtime: f.runtime, settings: {conversationProvider: 'custom'}})).custom,
      {host: null, model: null, ready: false, keySaved: false, secure: false, local: false, limit: null});
    assert.deepEqual(await conversationSection({runtime: f.runtime, settings: {conversationProvider: 'groq'}}), {provider: 'convai', effective: 'custom'});
  } finally { await f.cleanup(); }
});
