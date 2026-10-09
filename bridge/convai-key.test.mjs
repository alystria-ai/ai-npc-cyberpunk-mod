import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConvaiKeys, OwnKeyControl, PLAYER_KEY_FILE, keyTail, parseKeyCommand, parseKeyText, readClipboardText, validateKey}
  from './convai-key.mjs';
import {QuotaWatch} from './convai-quota.mjs';

// Fake keys only: long enough to pass the shape check, never a real credential.
const SHARED = 'shared-fixture-key-0000000000000000';
const PLAYER = 'player-fixture-key-1111111111111111';

test('a key is read from api-key= text or a bare value, and nothing else', () => {
  assert.equal(parseKeyText(`api-key=${PLAYER}\n`), PLAYER);
  assert.equal(parseKeyText(`  API-KEY = ${PLAYER}  `), PLAYER);
  assert.equal(parseKeyText(`${PLAYER}\r\n`), PLAYER);
  assert.equal(parseKeyText(`﻿${PLAYER}`), PLAYER);
  for (const text of ['', '   ', 'short', 'two words here that are long enough', `api-key=${PLAYER} extra`, 'x'.repeat(5000),
    `${PLAYER}\n${PLAYER}`, 'bad/characters/in/this/long/value/here', null, undefined, 42]) {
    assert.equal(parseKeyText(text), null, String(text).slice(0, 30));
  }
});

test('only the last four characters of a key can be shown', () => {
  assert.equal(keyTail(PLAYER), PLAYER.slice(-4));
  assert.equal(keyTail('short'), null);
  assert.equal(keyTail(null), null);
});

test('conversations use the shared key until the key of the player is switched on and applied', async () => {
  const files = new Map([['own', `api-key=${PLAYER}\n`]]);
  const keys = await new ConvaiKeys({sharedKey: SHARED, playerKeyPath: 'own', readText: async path => {
    if (!files.has(path)) throw Error('missing');
    return files.get(path);
  }}).load();
  assert.equal(keys.current(), SHARED); assert.equal(keys.source, 'shared'); assert.equal(keys.singleSession, false);
  assert.equal(keys.pending, false);
  assert.equal(keys.setPreference(true), true); assert.equal(keys.setPreference(true), false);
  assert.equal(keys.current(), SHARED, 'the key in use changes only when applied');
  assert.equal(keys.pending, true);
  assert.equal(keys.apply(), true);
  assert.equal(keys.current(), PLAYER); assert.equal(keys.source, 'player'); assert.equal(keys.singleSession, true);
  assert.equal(keys.pending, false); assert.equal(keys.apply(), false);
  keys.setPreference(false);
  assert.equal(keys.current(), PLAYER); assert.equal(keys.pending, true);
  keys.apply();
  assert.equal(keys.current(), SHARED); assert.equal(keys.singleSession, false);
  assert.deepEqual(keys.secrets().sort(), [SHARED, PLAYER].sort());
});

test('switching on without a saved key keeps the shared key; a malformed or missing file means none', async () => {
  for (const text of [null, 'garbage', 'api-key=short']) {
    const keys = await new ConvaiKeys({sharedKey: SHARED, playerKeyPath: 'own',
      readText: async () => { if (text === null) throw Error('missing'); return text; }}).load();
    keys.setPreference(true);
    assert.equal(keys.pending, false); assert.equal(keys.requested.source, 'shared');
    assert.equal(keys.tail, null);
  }
});

test('saving writes only the own key file of the player, and removing deletes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convai-key-'));
  try {
    const path = join(directory, PLAYER_KEY_FILE);
    const keys = await new ConvaiKeys({sharedKey: SHARED, playerKeyPath: path}).load();
    await keys.save(PLAYER);
    assert.equal(await readFile(path, 'utf8'), `api-key=${PLAYER}\n`);
    assert.equal(keys.tail, PLAYER.slice(-4));
    assert.equal((await new ConvaiKeys({sharedKey: SHARED, playerKeyPath: path}).load()).player, PLAYER);
    await keys.remove();
    assert.equal(keys.player, null);
    await assert.rejects(readFile(path, 'utf8'), {code: 'ENOENT'});
    await keys.remove();
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('only well-formed, current, small commands are accepted', () => {
  const now = 1_000_000;
  const good = {version: 1, id: 'session:key:1', action: 'paste', issuedAt: now};
  assert.deepEqual(parseKeyCommand(JSON.stringify(good), now), {id: 'session:key:1', action: 'paste'});
  assert.deepEqual(parseKeyCommand(JSON.stringify({...good, action: 'clear'}), now), {id: 'session:key:1', action: 'clear'});
  for (const bad of [{...good, version: 2}, {...good, action: 'save'}, {...good, id: ''}, {...good, id: 'a b'},
    {...good, issuedAt: now + 60000}, {...good, issuedAt: -1}, {...good, issuedAt: 'now'}, [good], 'text', null]) {
    assert.equal(parseKeyCommand(JSON.stringify(bad), now), null, JSON.stringify(bad));
  }
  assert.equal(parseKeyCommand('not json', now), null);
  assert.equal(parseKeyCommand(JSON.stringify({...good, pad: 'x'.repeat(5000)}), now), null);
});

function control({clipboard = PLAYER, validate = async () => 'valid', stored = null} = {}) {
  const store = {key: stored};
  const file = {text: ''};
  const published = [];
  const keys = new ConvaiKeys({sharedKey: SHARED, playerKeyPath: 'own',
    readText: async () => { if (!store.key) throw Error('missing'); return `api-key=${store.key}\n`; },
    writeText: async (_path, text) => { store.key = /api-key=(\S+)/.exec(text)[1]; },
    removeFile: async () => { store.key = null; }});
  let now = 2_000_000;
  const quota = new QuotaWatch({keys});
  const instance = new OwnKeyControl({keys, quota, commandPath: 'cmd', now: () => now,
    publish: async value => { published.push(JSON.parse(JSON.stringify(value))); },
    readClipboard: typeof clipboard === 'function' ? clipboard : async () => clipboard, validate,
    read: async () => { if (file.text === '') throw Error('missing'); return file.text; }});
  let sequence = 0;
  const send = async action => {
    file.text = JSON.stringify({version: 1, id: `test:${++sequence}`, action, issuedAt: now});
    now += 10;
    await instance.poll();
    return published.at(-1);
  };
  return {instance, keys, quota, published, send, store, file};
}

test('Paste reads the clipboard once, checks the key and saves it without ever publishing it', async () => {
  const fixture = control();
  await fixture.instance.open();
  assert.equal(fixture.published.at(-1).saved, false);
  const status = await fixture.send('paste');
  assert.deepEqual(status.result, {id: 'test:1', state: 'saved'});
  assert.equal(status.saved, true); assert.equal(status.tail, PLAYER.slice(-4));
  assert.equal(fixture.store.key, PLAYER);
  assert.ok(fixture.published.some(entry => entry.result?.state === 'checking'), 'a checking state is published first');
  for (const entry of fixture.published) {
    const text = JSON.stringify(entry);
    assert.ok(!text.includes(PLAYER) && !text.includes(SHARED) && !text.includes(PLAYER.slice(0, -4)), 'the key reached the status file');
  }
  const before = fixture.published.length;
  await fixture.instance.poll();
  assert.equal(fixture.published.length, before, 'an already handled command is not run again');
});

test('Paste says why when the clipboard is empty, not a key, unreadable, or the key is refused', async () => {
  for (const [options, state] of [
    [{clipboard: ''}, 'empty'], [{clipboard: '   \n'}, 'empty'],
    [{clipboard: 'hello world, this is not a key'}, 'not-a-key'],
    [{clipboard: async () => { throw Error('no clipboard'); }}, 'clipboard'],
    [{validate: async () => 'invalid'}, 'invalid'],
  ]) {
    const fixture = control(options);
    await fixture.instance.open();
    const status = await fixture.send('paste');
    assert.equal(status.result.state, state);
    assert.equal(status.saved, false); assert.equal(fixture.store.key, null);
  }
});

test('an unreachable Convai does not block saving a well-formed key', async () => {
  const fixture = control({validate: async () => 'unknown'});
  await fixture.instance.open();
  assert.equal((await fixture.send('paste')).result.state, 'saved');
});

test('Remove deletes the saved key, clears the recorded limit and switches nothing by itself', async () => {
  const fixture = control({stored: PLAYER});
  await fixture.keys.load();
  fixture.keys.setPreference(true); fixture.keys.apply();
  fixture.quota.observe(Error('Convai usage limit reached [convai-quota:interaction]'));
  await fixture.instance.open();
  assert.equal(fixture.published.at(-1).limit.state, 'used-up');
  const status = await fixture.send('clear');
  assert.equal(status.result.state, 'cleared'); assert.equal(status.saved, false); assert.equal(status.limit, undefined);
  assert.equal(fixture.keys.current(), PLAYER, 'the key in use changes only at the idle boundary');
  assert.equal(status.pending, true, 'removing the key in use leaves a pending change back to the shared key');
});

test('a command left from an earlier session is ignored, and a failing handler reports failed', async () => {
  const fixture = control();
  fixture.file.text = JSON.stringify({version: 1, id: 'old:1', action: 'paste', issuedAt: 1});
  await fixture.instance.open();
  await fixture.instance.poll();
  assert.equal(fixture.store.key, null);
  const failing = control({validate: async () => { throw Error('boom'); }});
  await failing.instance.open();
  assert.equal((await failing.send('paste')).result.state, 'failed');
});

test('the clipboard reader runs PowerShell once, hidden, with a timeout', async () => {
  let call;
  const text = await readClipboardText({exec: (file, args, options, done) => { call = {file, args, options}; done(null, `${PLAYER}\r\n`); }});
  assert.equal(text, `${PLAYER}\r\n`);
  assert.equal(call.file, 'powershell.exe'); assert.equal(call.options.windowsHide, true);
  assert.ok(call.options.timeout > 0 && call.options.timeout <= 10000);
  assert.ok(call.args.includes('-NoProfile'));
  await assert.rejects(readClipboardText({exec: (_f, _a, _o, done) => done(Error('secret detail'))}), /clipboard could not be read/);
});

test('key validation lists characters with the key header only, and treats network trouble as unknown', async () => {
  const seen = [];
  const reply = status => async (url, options) => { seen.push({url, options}); return {ok: status === 200, status, body: {cancel: async () => {}}}; };
  assert.equal(await validateKey(PLAYER, {fetchImpl: reply(200)}), 'valid');
  assert.equal(await validateKey(PLAYER, {fetchImpl: reply(401)}), 'invalid');
  assert.equal(await validateKey(PLAYER, {fetchImpl: reply(403)}), 'invalid');
  assert.equal(await validateKey(PLAYER, {fetchImpl: reply(500)}), 'unknown');
  assert.equal(await validateKey(PLAYER, {fetchImpl: async () => { throw Error('offline'); }}), 'unknown');
  assert.equal(seen[0].url, 'https://api.convai.com/character/list');
  assert.equal(seen[0].options.headers['CONVAI-API-KEY'], PLAYER);
  assert.ok(!seen[0].url.includes(PLAYER), 'the key is never put in a URL');
});
