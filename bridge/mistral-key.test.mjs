import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MistralProvider, MistralControl, parseMistralKey, parseKeyCommand, keyTail, MISTRAL_KEY_FILE} from './mistral-key.mjs';

const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const OTHER = 'Zy9xW8vU7tS6rQ5pO4nM3lK2jI1hG0fE';
const memoryProvider = (text = null) => {
  const files = new Map(text === null ? [] : [['k.txt', text]]);
  return {files, provider: new MistralProvider({keyPath: 'k.txt',
    readText: async path => { if (!files.has(path)) throw Error('ENOENT'); return files.get(path); },
    writeText: async (path, value) => { files.set(path, value); }, removeFile: async path => { files.delete(path); }})};
};

test('a key is accepted bare or labelled when it has the plain shape of a Mistral key; sentences and paths are refused', () => {
  assert.equal(parseMistralKey(KEY), KEY);
  assert.equal(parseMistralKey(`api-key=${KEY}\n`), KEY);
  assert.equal(parseMistralKey(`key: ${KEY}`), KEY);
  assert.equal(parseMistralKey(`﻿  ${KEY}  \r\n`), KEY);
  assert.equal(parseMistralKey('mistral_api_key = ' + KEY), KEY);
  for (const bad of ['', '   ', 'short', 'two words in a sentence here', '/usr/local/share/some-file-path-here', `${KEY} extra words`, `${KEY}\n${OTHER}`, 'x'.repeat(5000), null, 7])
    assert.equal(parseMistralKey(bad), null, String(bad).slice(0, 30));
  assert.equal(keyTail(KEY), KEY.slice(-4));
  assert.equal(keyTail('short'), null);
});

test('the provider follows the setting, but Mistral needs a key; it changes only when applied', async () => {
  const {provider} = memoryProvider(`api-key=${KEY}\n`);
  await provider.load();
  assert.equal(provider.requested, 'convai');
  assert.equal(provider.active, false);
  assert.equal(provider.setPreference('mistral'), true);
  assert.equal(provider.requested, 'mistral');
  assert.equal(provider.active, false, 'not active until applied at an idle boundary');
  assert.equal(provider.pending, true);
  assert.equal(provider.apply(), true);
  assert.equal(provider.active, true);
  assert.equal(provider.apply(), false);
  provider.setPreference('nonsense');
  assert.equal(provider.preference, 'convai');
  provider.apply();
  assert.equal(provider.active, false);
});

test('without a key the setting falls back to Convai and says so once', async () => {
  const {provider} = memoryProvider();
  await provider.load();
  provider.setPreference('mistral');
  assert.equal(provider.requested, 'convai');
  assert.equal(provider.pending, false);
  assert.equal(provider.takeNotice(), 'mistral-no-key');
  assert.equal(provider.takeNotice(), undefined, 'one time only');
  provider.setPreference('convai'); provider.setPreference('mistral');
  assert.equal(provider.takeNotice(), 'mistral-no-key', 'switching again asks again');
  // With a key there is nothing to announce.
  const keyed = memoryProvider(KEY); await keyed.provider.load();
  keyed.provider.setPreference('mistral');
  assert.equal(keyed.provider.takeNotice(), undefined);
});

test('a Convai cloud voice is replaced by a local voice, announced once after the switch', async () => {
  const {provider} = memoryProvider(KEY);
  await provider.load();
  provider.setPreference('mistral'); provider.apply();
  assert.equal(provider.takeNotice({cloudVoice: false}), undefined);
  assert.equal(provider.takeNotice({cloudVoice: true}), 'mistral-voice');
  assert.equal(provider.takeNotice({cloudVoice: true}), undefined);
  provider.setPreference('convai'); provider.apply();
  provider.setPreference('mistral'); provider.apply();
  assert.equal(provider.takeNotice({cloudVoice: true}), 'mistral-voice', 'a new switch announces again');
});

test('a missing, malformed or empty key file means no key', async () => {
  for (const text of [null, '', 'garbage', 'api-key=', `api-key=${KEY}extra stuff`]) {
    const {provider} = memoryProvider(text);
    assert.equal((await provider.load()).key, null, String(text));
  }
});

test('saving writes the key file privately; removing deletes it and returns to Convai at the next apply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orkey-'));
  try {
    const path = join(dir, MISTRAL_KEY_FILE);
    const provider = await new MistralProvider({keyPath: path}).load();
    await provider.save(KEY);
    assert.equal(await readFile(path, 'utf8'), `api-key=${KEY}\n`);
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o077, 0);
    assert.equal((await new MistralProvider({keyPath: path}).load()).key, KEY);
    provider.setPreference('mistral'); provider.apply();
    assert.equal(provider.active, true);
    await provider.remove();
    assert.equal(provider.key, null);
    assert.equal(provider.pending, true, 'the running conversation keeps its provider until the boundary');
    provider.apply();
    assert.equal(provider.active, false);
    await assert.rejects(readFile(path), /ENOENT/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('limit notes are recorded and cleared by the next success; observers hear about changes', async () => {
  const {provider} = memoryProvider(KEY);
  await provider.load();
  let heard = 0;
  const stop = provider.onChange(() => heard++);
  provider.noteLimit('rate');
  assert.equal(provider.limit.kind, 'rate');
  provider.noteSuccess();
  assert.equal(provider.limit, null);
  assert(heard >= 2);
  stop(); const before = heard; provider.noteLimit('rate'); assert.equal(heard, before);
  provider.onChange(() => { throw Error('observer fault'); });
  assert.doesNotThrow(() => provider.noteLimit('model'));
});

test('key commands are validated', () => {
  const now = 1_000_000;
  assert.deepEqual(parseKeyCommand(JSON.stringify({version: 1, id: 'abc:orkey:1', action: 'paste', issuedAt: now}), now), {id: 'abc:orkey:1', action: 'paste'});
  for (const bad of [{version: 2}, {id: 'bad id!'}, {action: 'steal'}, {issuedAt: now + 60_000}, {issuedAt: -1}, {issuedAt: 1.5}]) {
    assert.equal(parseKeyCommand(JSON.stringify({version: 1, id: 'a1', action: 'paste', issuedAt: now, ...bad}), now), null, JSON.stringify(bad));
  }
  assert.equal(parseKeyCommand('{', now), null);
  assert.equal(parseKeyCommand('x'.repeat(5000), now), null);
  assert.equal(parseKeyCommand(JSON.stringify([]), now), null);
});

function control({clipboard = KEY, validate = async () => 'valid', files = {}} = {}) {
  const {provider, files: store} = memoryProvider();
  const published = [];
  let command = files.command ?? '';
  const instance = new MistralControl({provider, commandPath: 'cmd.json', publish: async value => published.push(JSON.parse(JSON.stringify(value))),
    model: 'm/free', readClipboard: async () => { if (clipboard instanceof Error) throw clipboard; return clipboard; }, validate,
    read: async () => command, now: () => 10_000});
  return {provider, store, published, instance, send: value => { command = JSON.stringify({version: 1, issuedAt: 9_999, ...value}); }};
}

test('pasting reads the clipboard, checks the key with Mistral, saves it, and the status shows only the last four characters', async () => {
  const {provider, published, instance, send} = control();
  await provider.load();
  await instance.open();
  assert.equal(published.at(-1).saved, false);
  send({id: 'p1', action: 'paste'});
  await instance.poll();
  assert.deepEqual(published.map(status => status.result?.state), [undefined, 'checking', 'saved']);
  const status = published.at(-1);
  assert.equal(status.saved, true);
  assert.equal(status.tail, KEY.slice(-4));
  assert.equal(status.provider, 'convai');
  assert.equal(status.model, 'm/free');
  assert.equal(status.stt, false);
  assert.doesNotMatch(JSON.stringify(published), new RegExp(KEY));
  assert.equal(provider.key, KEY);
});

test('a bad clipboard, a rejected key and an unreadable clipboard are reported and nothing is saved', async () => {
  for (const [setup, state] of [[{clipboard: 'hello world'}, 'invalid'], [{clipboard: KEY, validate: async () => 'invalid'}, 'invalid'],
    [{clipboard: Error('no clipboard')}, 'unreadable'], [{clipboard: '  '}, 'unreadable']]) {
    const {provider, published, instance, send} = control(setup);
    await provider.load(); await instance.open();
    send({id: 'p2', action: 'paste'});
    await instance.poll();
    assert.equal(published.at(-1).result.state, state);
    assert.equal(provider.key, null);
    assert.doesNotMatch(JSON.stringify(published), new RegExp(KEY));
  }
  // An unreachable Mistral ("unknown") does not block saving a well-formed key.
  const offline = control({validate: async () => 'unknown'});
  await offline.provider.load(); await offline.instance.open();
  offline.send({id: 'p3', action: 'paste'}); await offline.instance.poll();
  assert.equal(offline.published.at(-1).result.state, 'saved');
});

test('removing deletes the key; a command left from an earlier session or repeated is ignored', async () => {
  const {provider, published, instance, send} = control({files: {command: JSON.stringify({version: 1, id: 'old', action: 'paste', issuedAt: 9_999})}});
  await provider.load();
  await instance.open();
  await instance.poll();
  assert.equal(provider.key, null, 'the old command from before this session is not run');
  send({id: 'p4', action: 'paste'}); await instance.poll();
  assert.equal(provider.key, KEY);
  const count = published.length;
  await instance.poll();
  assert.equal(published.length, count, 'the same command is not run twice');
  send({id: 'p5', action: 'clear'}); await instance.poll();
  assert.equal(provider.key, null);
  assert.equal(published.at(-1).result.state, 'cleared');
  assert.equal(published.at(-1).saved, false);
});

test('the status reports the provider choice, the pending switch, the limit and whether voice recognition is available', async () => {
  const {provider, published, instance} = control();
  await provider.save(KEY);
  provider.setPreference('mistral');
  provider.sttAvailable = true;
  provider.noteLimit('rate');
  await instance.publishStatus();
  const status = published.at(-1);
  assert.deepEqual([status.provider, status.effective, status.pending, status.limit, status.stt], ['mistral', 'convai', true, 'rate', true]);
  assert.deepEqual(provider.secrets(), [KEY]);
});

// ---- The local AI -------------------------------------------------------------------------------------------------

async function pair({mistral = KEY} = {}) {
  const text = mistral === null ? null : `api-key=${mistral}`;
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => { if (text === null) throw Error('ENOENT'); return text; },
    writeText: async () => {}, removeFile: async () => {}});
  await provider.load();
  return provider;
}

test('local: requested while it works; a failure sends turns to Mistral when a key exists, else Convai, with one notice', async () => {
  const withKey = await pair();
  withKey.setPreference('local'); withKey.apply();
  assert.equal(withKey.route, 'local'); assert.equal(withKey.active, true);
  withKey.noteLocalFailure('low-memory');
  assert.equal(withKey.requested, 'mistral');
  assert.equal(withKey.pending, true);
  withKey.apply();
  assert.equal(withKey.route, 'mistral');
  assert.equal(withKey.takeNotice(), 'local-fallback');
  assert.equal(withKey.takeNotice(), undefined);
  const noKey = await pair({mistral: null});
  noKey.setPreference('local'); noKey.apply();
  noKey.noteLocalFailure('not-installed'); noKey.apply();
  assert.equal(noKey.route, 'convai');
  assert.equal(noKey.takeNotice(), 'local-fallback');
  // Choosing Local again clears the failure.
  noKey.setPreference('convai'); noKey.setPreference('local');
  assert.equal(noKey.requested, 'local');
  // Another provider's setting never carries a local failure.
  const other = await pair();
  other.noteLocalFailure('crashed');
  assert.equal(other.localBroken, null);
});

test('local: a chosen model that could not be used says so once, naming the model used, only while Local AI answers, and the list of models is published without paths', async () => {
  const provider = await pair();
  provider.noteLocalModelFallback();
  assert.equal(provider.takeNotice(), undefined, 'another provider is chosen: nothing to say');
  provider.setPreference('local'); provider.apply();
  provider.noteLocalModelFallback();
  assert.equal(provider.takeNotice(), 'local-model-fallback');
  assert.equal(provider.noticeModel, '', 'no model named: the game words it generically');
  assert.equal(provider.takeNotice(), undefined, 'once');
  provider.noteLocalModelFallback('Gemma-4-E4B');
  assert.equal(provider.takeNotice(), 'local-model-fallback');
  assert.equal(provider.noticeModel, 'Gemma-4-E4B', 'the notice carries the name of the model that was used');
  provider.noteLocalModelFallback({bad: true});
  assert.equal(provider.takeNotice(), 'local-model-fallback');
  assert.equal(provider.noticeModel, '');
  provider.noteLocalModelFallback();
  provider.setPreference('mistral');
  assert.equal(provider.takeNotice(), undefined, 'changing the provider drops it');
  const published = [];
  provider.setPreference('local');
  const control = new MistralControl({provider, commandPath: 'm.json', publish: value => published.push(value),
    localModels: () => [{id: 'standard', name: 'Gemma-4-E4B', sizeMiB: 5280}]});
  control.status();
  assert.deepEqual(control.status().localModels, [{id: 'standard', name: 'Gemma-4-E4B', sizeMiB: 5280}]);
  assert.equal('localModels' in new MistralControl({provider, commandPath: 'm.json', publish() {}}).status(), false);
  // The model the page shows as selected, and the one turning Mature content on selects: ids, each only when there is such a model.
  const defaults = value => new MistralControl({provider, commandPath: 'm.json', publish() {}, localModelDefaults: () => value}).status();
  assert.deepEqual([defaults({default: 'standard', mature: 'mature:big'}).localModelDefault, defaults({default: 'standard', mature: 'mature:big'}).localModelMatureDefault], ['standard', 'mature:big']);
  assert.equal('localModelMatureDefault' in defaults({default: 'standard', mature: null}), false);
  assert.equal('localModelDefault' in defaults({default: null, mature: null}), false);
  assert.equal('localModelDefault' in new MistralControl({provider, commandPath: 'm.json', publish() {}}).status(), false);
  // Custom models that cannot be used are published as names and reason codes only, and only when there are some.
  const problems = [{name: 'Embedder', reason: 'embedding'}];
  assert.deepEqual(new MistralControl({provider, commandPath: 'm.json', publish() {}, localModelProblems: () => problems}).status().localModelProblems, problems);
  assert.equal('localModelProblems' in new MistralControl({provider, commandPath: 'm.json', publish() {}, localModelProblems: () => []}).status(), false);
  assert.equal('localModelProblems' in new MistralControl({provider, commandPath: 'm.json', publish() {}}).status(), false);
  // Why Local AI failed: only 'mature-off' is published (the page then says to turn Mature content on), and only when it is the reason.
  const reason = value => new MistralControl({provider, commandPath: 'm.json', publish() {}, localReason: () => value}).status();
  assert.equal(reason('mature-off').localReason, 'mature-off');
  for (const other of [null, undefined, 'low-memory', 'start-failed', 'not-installed']) assert.equal('localReason' in reason(other), false);
  assert.equal('localReason' in new MistralControl({provider, commandPath: 'm.json', publish() {}}).status(), false);
});

test('a saved conversation provider of groq (removed 2026-10-14) is the default, Convai: no provider change, no notice, no Groq state', async () => {
  for (const mistral of [KEY, null]) {
    const provider = await pair({mistral});
    assert.equal(provider.setPreference('groq'), false, 'the same as the default: nothing changed');
    assert.equal(provider.preference, 'convai');
    assert.equal(provider.requested, 'convai');
    assert.equal(provider.pending, false);
    provider.apply();
    assert.equal(provider.route, 'convai'); assert.equal(provider.active, false);
    assert.equal(provider.takeNotice(), undefined);
    assert.deepEqual(provider.secrets(), mistral ? [KEY] : []);
  }
  // From another provider, an old 'groq' lands on Convai too.
  const provider = await pair();
  provider.setPreference('mistral'); provider.apply();
  assert.equal(provider.route, 'mistral');
  assert.equal(provider.setPreference('groq'), true);
  assert.equal(provider.requested, 'convai');
});

test('the status has no Groq part and no Groq command file is read', async () => {
  const provider = await pair();
  const published = []; const reads = [];
  const instance = new MistralControl({provider, commandPath: 'cmd.json', model: 'm/free', publish: async value => published.push(JSON.parse(JSON.stringify(value))),
    read: async path => { reads.push(path); return ''; }, now: () => 10_000});
  await instance.open(); await instance.poll();
  assert.equal('groq' in published.at(-1), false);
  assert.deepEqual([...new Set(reads)], ['cmd.json']);
});

test('localUnused: the local model server has no job once neither the setting nor the provider in use is Local AI; it waits while Local AI still answers', async () => {
  const provider = await pair();
  assert.equal(provider.localUnused, true, 'the default provider is Convai');
  provider.setPreference('local');
  assert.equal(provider.localUnused, false, 'chosen, and loaded ahead of the switch');
  // The player changes their mind before the switch was applied: the model loaded ahead must go.
  provider.setPreference('convai');
  assert.equal(provider.localUnused, true);
  provider.setPreference('local'); provider.apply();
  assert.equal(provider.route, 'local');
  provider.setPreference('mistral');
  assert.equal(provider.localUnused, false, 'Local AI still answers until the switch is applied at an idle boundary');
  provider.apply();
  assert.equal(provider.route, 'mistral');
  assert.equal(provider.localUnused, true, 'applied: unloaded (the bridge also stops the server in applyProviderChoice)');
  provider.setPreference('groq'); provider.apply();
  assert.equal(provider.route, 'convai', 'an old saved groq is Convai');
  assert.equal(provider.localUnused, true);
});

test('the bridge unloads the local model server when the provider leaves Local AI: at the idle switch, and at once when the choice is withdrawn before it was applied', () => {
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const applyAt = source.indexOf('async function applyProviderChoice()');
  const apply = source.slice(applyAt, applyAt + 2200);
  assert.match(apply, /if \(mistral\.applied === 'local'\) void localServer\.ensure\(\{background: true\}\)\.catch\(\(\) => \{\}\);\n\s*else void localServer\.stop\(\)\.catch\(\(\) => \{\}\);/);
  const pollAt = source.indexOf('if (mistral.setPreference(settings.conversationProvider))');
  const poll = source.slice(pollAt, pollAt + 900);
  assert.match(poll, /if \(mistral\.preference === 'local'\) prepareLocal\(\);\n(\s*\/\/[^\n]*\n)+\s*else if \(mistral\.localUnused\) void localServer\.stop\(\)\.catch\(\(\) => \{\}\);/);
  // The tiny memory embedder is a different process (localEmbedder): the idle switch stops it only when Convai is the provider again and no
  // add-on (whose speakers use the text routes whatever the provider is) is installed (docs/RESOURCE_LIFECYCLE.md); the early stop never does.
  assert.match(apply, /if \(!mistral\.active && !addonHost\.active\) void localEmbedder\.close\(\)/);
  assert.ok(!/localEmbedder\.(close|stop)/.test(poll));
});

test('local: a Mature-only install that could not start while Mature content was off (mature-off) is lifted when it is turned on, and no other failure is', async () => {
  const provider = await pair({mistral: null});
  provider.setPreference('local'); provider.apply();
  provider.noteLocalFailure('mature-off');
  assert.equal(provider.requested, 'convai');
  assert.equal(provider.clearLocalFailure('low-memory'), false, 'only the named reason is lifted');
  assert.equal(provider.requested, 'convai');
  let changes = 0; provider.onChange(() => { changes++; });
  assert.equal(provider.clearLocalFailure('mature-off'), true);
  assert.equal(changes, 1);
  assert.equal(provider.requested, 'local');
  assert.equal(provider.takeNotice(), undefined, 'the failure notice that was waiting is dropped');
  assert.equal(provider.clearLocalFailure('mature-off'), false, 'nothing left to lift');
  // Not while another provider is chosen.
  const other = await pair();
  other.noteLocalFailure('mature-off');
  assert.equal(other.clearLocalFailure('mature-off'), false);
});

test('local-stepdown: a smaller model was loaded (said once, with its name) or the cloud took over (said once instead of local-fallback); a new choice drops it', () => {
  const model = new MistralProvider({});
  model.setPreference('local'); model.apply();
  // A smaller model was loaded: one notice, with the model's name, on the next reply; the Local AI stays the provider.
  model.noteLocalStepDown('Qwen3.5-2B');
  assert.equal(model.takeNotice(), 'local-stepdown');
  assert.equal(model.noticeModel, 'Qwen3.5-2B');
  assert.equal(model.takeNotice(), undefined);
  assert.equal(model.applied, 'local');
  // No smaller model: the supervisor's failure (low-memory) hands the turns to a cloud provider, and its one notice is the step-down's, without a name.
  const cloud = new MistralProvider({});
  cloud.key = 'k'.repeat(32);
  cloud.setPreference('local'); cloud.apply();
  cloud.noteLocalStepDown(null);
  cloud.noteLocalFailure('low-memory');
  assert.equal(cloud.requested, 'mistral');
  cloud.apply();
  assert.equal(cloud.takeNotice(), 'local-stepdown');
  assert.equal(cloud.noticeModel, '');
  assert.equal(cloud.takeNotice(), undefined);
  // An ordinary failure that follows is the usual 'local-fallback'.
  cloud.noteLocalFailure('start-failed');
  assert.equal(cloud.takeNotice(), 'local-fallback');
  // Another provider chosen: nothing stays pending.
  const gone = new MistralProvider({});
  gone.setPreference('local'); gone.apply();
  gone.noteLocalStepDown('X');
  gone.setPreference('convai'); gone.setPreference('local');
  assert.equal(gone.takeNotice(), undefined);
  const other = new MistralProvider({});
  other.noteLocalStepDown('X');
  assert.equal(other.takeNotice(), undefined, 'only while Local AI is the chosen provider');
});

test('local-cpu: a model that runs mostly on the processor is said once with the next reply, only while Local AI is chosen, and a new choice drops it', () => {
  const model = new MistralProvider({});
  model.setPreference('local'); model.apply();
  model.noteLocalCpuHeavy();
  assert.equal(model.takeNotice(), 'local-cpu');
  assert.equal(model.takeNotice(), undefined, 'once');
  model.noteLocalCpuHeavy();
  model.setPreference('convai'); model.setPreference('local');
  assert.equal(model.takeNotice(), undefined, 'a new choice drops it');
  const other = new MistralProvider({});
  other.noteLocalCpuHeavy();
  assert.equal(other.takeNotice(), undefined, 'only while Local AI is the chosen provider');
});
