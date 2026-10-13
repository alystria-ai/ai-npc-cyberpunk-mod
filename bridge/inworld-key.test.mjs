import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseInworldKey, validateInworldKey, InworldKey, INWORLD_KEY_FILE} from './inworld-key.mjs';
import {MistralProvider, MistralControl} from './mistral-key.mjs';

// Base64 of the shape the Inworld portal copies; not a real key.
const KEY = Buffer.from('test-key-id-0123456789:test-key-secret-abcdefghijklmnopqrstuvwxyz').toString('base64');
const OTHER = Buffer.from('another-id-9876543210:another-secret-zyxwvutsrqponmlkjihgfedcba').toString('base64');

test('a key is accepted bare, labelled or with the Basic prefix; sentences, paths and short text are refused', () => {
  assert.equal(INWORLD_KEY_FILE, 'player-inworld-key.txt');
  assert.equal(parseInworldKey(KEY), KEY);
  assert.equal(parseInworldKey(`api-key=${KEY}\n`), KEY);
  assert.equal(parseInworldKey(`key: ${KEY}`), KEY);
  assert.equal(parseInworldKey(`Basic ${KEY}`), KEY);
  assert.equal(parseInworldKey(`﻿  ${KEY}  \r\n`), KEY);
  for (const bad of ['', '   ', 'short', 'two words in a sentence here that is long enough to pass', '/usr/local/share/some/file/path/that/is/long/enough', `${KEY} extra`, `${KEY}\n${OTHER}`, 'x'.repeat(5000), null, 7])
    assert.equal(parseInworldKey(bad), null, String(bad).slice(0, 30));
});

test('the key is checked with a free request: accepted, refused (401, 403) or unknown (anything else)', async () => {
  const answer = status => async (url, init) => {
    assert.match(url, /pageSize=1$/); assert.equal(init.headers.authorization, `Basic ${KEY}`);
    return {ok: status === 200, status, body: {cancel: async () => {}}};
  };
  assert.equal(await validateInworldKey(KEY, {fetchImpl: answer(200)}), 'valid');
  assert.equal(await validateInworldKey(KEY, {fetchImpl: answer(401)}), 'invalid');
  assert.equal(await validateInworldKey(KEY, {fetchImpl: answer(403)}), 'invalid');
  assert.equal(await validateInworldKey(KEY, {fetchImpl: answer(503)}), 'unknown');
  assert.equal(await validateInworldKey(KEY, {fetchImpl: async () => { throw Error('offline'); }}), 'unknown');
});

const memoryKey = (text = null) => {
  const files = new Map(text === null ? [] : [['i.txt', text]]);
  return {files, key: new InworldKey({keyPath: 'i.txt', readText: async path => { if (!files.has(path)) throw Error('ENOENT'); return files.get(path); },
    writeText: async (path, value) => { files.set(path, value); }, removeFile: async path => { files.delete(path); }})};
};

test('the saved key loads from its file, is saved and removed, tells observers, and exposes only its last four characters', async () => {
  const {files, key} = memoryKey(`api-key=${KEY}\n`);
  await key.load();
  assert.equal(key.key, KEY); assert.equal(key.tail.length, 4);
  assert.deepEqual(key.secrets(), [KEY]);
  let changes = 0; const off = key.onChange(() => { changes++; });
  await key.save(OTHER); assert.equal(files.get('i.txt'), `api-key=${OTHER}\n`); assert.equal(key.key, OTHER);
  await key.remove(); assert.equal(files.has('i.txt'), false); assert.equal(key.key, null); assert.deepEqual(key.secrets(), []);
  assert.equal(changes, 2);
  off(); await key.save(KEY); assert.equal(changes, 2);
  const missing = memoryKey(); await missing.key.load(); assert.equal(missing.key.key, null);
  const garbage = memoryKey('not a key at all'); await garbage.key.load(); assert.equal(garbage.key.key, null);
});

async function control(inworldText = null) {
  const {key} = memoryKey(inworldText);
  await key.load();
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => { throw Error('ENOENT'); }, writeText: async () => {}, removeFile: async () => {}, inworld: key});
  await provider.load();
  const published = []; const clip = {text: KEY}; let command = '';
  const instance = new MistralControl({provider, commandPath: 'cmd.json', inworldCommandPath: 'inworld.json', model: 'm/free',
    publish: async value => published.push(JSON.parse(JSON.stringify(value))), readClipboard: async () => clip.text,
    validate: async () => 'valid', validateInworld: async () => clip.verdict ?? 'valid',
    localStatus: () => 'off', read: async path => (path === 'inworld.json' ? command : ''), now: () => 10_000});
  return {instance, provider, published, clip, send: (id, action) => { command = JSON.stringify({version: 1, issuedAt: 9_999, id, action}); return instance.poll(); }};
}

test('the Inworld key is pasted, checked and saved like the Groq key, and the status never holds it', async () => {
  const {instance, provider, published, send} = await control();
  await instance.open();
  assert.equal(published.at(-1).inworld.saved, false);
  await send('i1', 'paste');
  assert.deepEqual(published.map(status => status.inworld?.result?.state), [undefined, 'checking', 'saved']);
  assert.equal(provider.inworld.key, KEY);
  assert.equal(published.at(-1).inworld.tail, provider.inworld.tail);
  assert.equal(JSON.stringify(published).includes(KEY), false);
  assert.ok(provider.secrets().includes(KEY), 'logs scrub it');
  await send('i2', 'clear');
  assert.equal(provider.inworld.key, null);
  assert.equal(published.at(-1).inworld.result.state, 'cleared');
});

test('a paste that is not a key, or that Inworld refuses, saves nothing', async () => {
  const bad = await control();
  await bad.instance.open();
  bad.clip.text = 'definitely not an inworld key';
  await bad.send('i1', 'paste');
  assert.equal(bad.provider.inworld.key, null);
  assert.notEqual(bad.published.at(-1).inworld.result.state, 'saved');
  const refused = await control();
  await refused.instance.open();
  refused.clip.verdict = 'invalid';
  await refused.send('i1', 'paste');
  assert.equal(refused.provider.inworld.key, null);
  assert.equal(refused.published.at(-1).inworld.result.state, 'invalid');
  const unknown = await control();
  await unknown.instance.open();
  unknown.clip.verdict = 'unknown';
  await unknown.send('i1', 'paste');
  assert.equal(unknown.provider.inworld.key, KEY, 'an unreachable service does not block saving');
});
