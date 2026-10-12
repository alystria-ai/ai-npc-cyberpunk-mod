import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MistralProvider, MistralControl, parseMistralKey, parseKeyCommand, keyTail, MISTRAL_KEY_FILE} from './mistral-key.mjs';
import {GroqKey} from './groq-key.mjs';

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

// ---- Groq and the local AI -------------------------------------------------------------------------------------------------

const GROQ = 'gsk_' + 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNb';
const groqKey = (text = null) => {
  const files = new Map(text === null ? [] : [['g.txt', text]]);
  return new GroqKey({keyPath: 'g.txt', readText: async path => { if (!files.has(path)) throw Error('ENOENT'); return files.get(path); },
    writeText: async (path, value) => { files.set(path, value); }, removeFile: async path => { files.delete(path); }});
};
async function pair({mistral = KEY, groq = GROQ} = {}) {
  const text = mistral === null ? null : `api-key=${mistral}`;
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => { if (text === null) throw Error('ENOENT'); return text; },
    writeText: async () => {}, removeFile: async () => {}, groq: await groqKey(groq === null ? null : `api-key=${groq}`).load()});
  await provider.load();
  return provider;
}

test('local: requested while it works; a failure sends turns to Mistral when a key exists, else Convai, with one notice', async () => {
  const withKey = await pair({groq: null});
  withKey.setPreference('local'); withKey.apply();
  assert.equal(withKey.route, 'local'); assert.equal(withKey.active, true);
  withKey.noteLocalFailure('low-memory');
  assert.equal(withKey.requested, 'mistral');
  assert.equal(withKey.pending, true);
  withKey.apply();
  assert.equal(withKey.route, 'mistral');
  assert.equal(withKey.takeNotice(), 'local-fallback');
  assert.equal(withKey.takeNotice(), undefined);
  const noKey = await pair({mistral: null, groq: null});
  noKey.setPreference('local'); noKey.apply();
  noKey.noteLocalFailure('not-installed'); noKey.apply();
  assert.equal(noKey.route, 'convai');
  assert.equal(noKey.takeNotice(), 'local-fallback');
  // Choosing Local again clears the failure.
  noKey.setPreference('convai'); noKey.setPreference('local');
  assert.equal(noKey.requested, 'local');
  // Another provider's setting never carries a local failure.
  const other = await pair({groq: null});
  other.noteLocalFailure('crashed');
  assert.equal(other.localBroken, null);
});

test('Groq: requested with its key, left alone for a while after a limit, then tried again; Mistral or Convai answer meanwhile', async () => {
  const provider = await pair();
  provider.setPreference('groq'); provider.apply();
  assert.equal(provider.route, 'groq');
  provider.noteGroqLimit('rate');
  assert.equal(provider.requested, 'mistral');
  provider.groqBlockedUntil = Date.now() - 1;
  assert.equal(provider.requested, 'groq');
  provider.noteGroqLimit('daily');
  assert(provider.groqBlockedUntil - Date.now() > 10 * 60_000);
  provider.noteGroqSuccess();
  assert.equal(provider.groqLimit, null);
  const noMistral = await pair({mistral: null});
  noMistral.setPreference('groq'); noMistral.apply();
  noMistral.noteGroqLimit('rate');
  assert.equal(noMistral.requested, 'convai');
  // An invalid Groq key stays blocked until a key is saved.
  provider.noteGroqLimit('invalid');
  assert.equal(provider.groqBlockedUntil, Infinity);
  await provider.groq.save(GROQ);
  assert.equal(provider.groqLimit, null);
  assert.equal(provider.requested, 'groq');
});

test('Groq without a key asks for Convai and says so once; the Groq key is scrubbed from reports', async () => {
  const provider = await pair({groq: null});
  provider.setPreference('groq');
  assert.equal(provider.requested, 'convai');
  provider.apply();
  assert.equal(provider.takeNotice(), 'groq-no-key');
  assert.equal(provider.takeNotice(), undefined);
  await provider.groq.save(GROQ);
  assert.deepEqual(provider.secrets().sort(), [KEY, GROQ].sort());
  assert.equal(provider.groqApiKey, GROQ);
});

test('the Groq key is pasted, checked and saved like the Mistral key, and the status never holds it', async () => {
  const provider = await pair({groq: null});
  const published = []; let command = '';
  const instance = new MistralControl({provider, commandPath: 'cmd.json', groqCommandPath: 'groq.json', model: 'm/free',
    publish: async value => published.push(JSON.parse(JSON.stringify(value))), readClipboard: async () => GROQ,
    validate: async () => 'valid', validateGroq: async key => { assert.equal(key, GROQ); return 'valid'; },
    localStatus: () => 'warming', read: async path => (path === 'groq.json' ? command : ''), now: () => 10_000});
  await instance.open();
  assert.equal(published.at(-1).groq.saved, false);
  assert.equal(published.at(-1).localAi, 'warming');
  command = JSON.stringify({version: 1, issuedAt: 9_999, id: 'g1', action: 'paste'});
  await instance.poll();
  assert.deepEqual(published.map(status => status.groq?.result?.state), [undefined, 'checking', 'saved']);
  assert.equal(provider.groq.key, GROQ);
  assert.equal(published.at(-1).groq.tail, GROQ.slice(-4));
  assert.doesNotMatch(JSON.stringify(published), new RegExp(GROQ));
  // A Mistral-shaped paste is refused.
  command = JSON.stringify({version: 1, issuedAt: 9_999, id: 'g2', action: 'clear'});
  await instance.poll();
  assert.equal(provider.groq.key, null);
  assert.equal(published.at(-1).groq.result.state, 'cleared');
});
