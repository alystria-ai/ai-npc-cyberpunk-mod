import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, readdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConvaiKeys, OwnKeyControl} from './convai-key.mjs';
import {MistralProvider, MistralControl} from './mistral-key.mjs';
import {InworldKey} from './inworld-key.mjs';
import {PaidTierControl} from './convai-paid-tier.mjs';
import {EditorControl} from './character-editor-control.mjs';
import {PlayerMemoryControl} from './player-memory-control.mjs';

// Under Mod Organizer 2 every new file the service creates in the game folder lands in MO2's Overwrite folder, and a file it
// removes comes back. The command files the game writes (runtime/*-command.json, voice-preview.json) are shipped as empty
// placeholders and only ever modified in place, so the service must treat an empty file as "no request", and must never
// remove, rename or rewrite the command files itself. Nothing here uses a real key, clipboard or network.

const here = new URL('./', import.meta.url);
const source = name => readFileSync(new URL(name, here), 'utf8');
const KEY = 'player-fixture-key-1111111111111111';
const INWORLD = Buffer.from('test-key-id-0123456789:test-key-secret-abcdefghijklmnopqrstuvwxyz').toString('base64');
const MISTRAL = 'mistral-fixture-key-2222222222222222';

async function folder() { return mkdtemp(join(tmpdir(), 'convai-exchange-')); }
const command = (id, action, issuedAt) => JSON.stringify({version: 1, id, action, issuedAt});

test('no consumer of a command file ever writes, renames or removes it', () => {
  const files = ['convai-key.mjs', 'mistral-key.mjs', 'inworld-key.mjs', 'convai-paid-tier.mjs', 'character-editor-control.mjs',
    'player-memory-control.mjs', 'voice-preview.mjs', 'addons.mjs'];
  for (const name of files) {
    const text = source(name);
    assert.doesNotMatch(text, /(?:rm|rmSync|unlink|unlinkSync|rename|renameSync|writeFile|writeFileSync|truncate|atomicFile|atomic)\s*\(\s*(?:this\.|control\.)?(?:inworldC|c)ommandPath/,
      `${name} changes a command file`);
  }
  // The only removals in the control modules are of the player's own key files in the state folder (never a runtime exchange file).
  assert.doesNotMatch(source('addons.mjs'), /\b(?:rm|rmSync|unlink|unlinkSync)\(/);
  assert.doesNotMatch(source('bridge-supervisor.mjs'), /\b(?:rm|rmSync|unlink|unlinkSync)\(/);
  assert.doesNotMatch(source('character-editor-control.mjs'), /\b(?:rm|rmSync|unlink|unlinkSync)\(/);
  assert.doesNotMatch(source('player-memory-control.mjs'), /\b(?:rm|rmSync|unlink|unlinkSync)\(/);
  assert.doesNotMatch(source('convai-paid-tier.mjs'), /\b(?:rm|rmSync|unlink|unlinkSync)\(/);
});

test('the Convai key command: an empty placeholder is no command, and a command file is left exactly as the game wrote it, with no key in it, on every path', async () => {
  const directory = await folder();
  try {
    const path = join(directory, 'own-key-command.json');
    await writeFile(path, '');
    const published = [];
    let clipboard = async () => KEY, validate = async () => 'valid', saved = null, now = 2_000_000;
    const keys = new ConvaiKeys({sharedKey: 'shared-fixture-key-0000000000000000', playerKeyPath: 'own',
      readText: async () => { if (!saved) throw Error('missing'); return `api-key=${saved}\n`; },
      writeText: async (_path, text) => { saved = /api-key=(\S+)/.exec(text)[1]; }, removeFile: async () => { saved = null; }});
    const instance = new OwnKeyControl({keys, commandPath: path, now: () => now,
      publish: async value => { published.push(JSON.parse(JSON.stringify(value))); },
      readClipboard: () => clipboard(), validate: key => validate(key)});
    await instance.open();
    for (let poll = 0; poll < 3; poll++) await instance.poll();
    assert.equal(published.length, 1, 'an empty placeholder is not a command: only the first status was published');
    assert.equal(saved, null);
    let sequence = 0;
    const send = async action => {
      const text = command(`s:key:${++sequence}`, action, now);
      await writeFile(path, text);
      now += 10;
      await instance.poll();
      assert.equal(await readFile(path, 'utf8'), text, `${action} left the command file as it was`);
      assert.ok(!(await readFile(path, 'utf8')).includes(KEY), 'a key reached the command file');
      assert.deepEqual(await readdir(directory), ['own-key-command.json'], 'a side file appeared next to the command file');
      return published.at(-1).result.state;
    };
    assert.equal(await send('paste'), 'saved');
    clipboard = async () => { throw Error('no clipboard'); };
    assert.equal(await send('paste'), 'clipboard');
    clipboard = async () => ''; assert.equal(await send('paste'), 'empty');
    clipboard = async () => 'hello world, not a key'; assert.equal(await send('paste'), 'not-a-key');
    clipboard = async () => KEY; validate = async () => 'invalid'; assert.equal(await send('paste'), 'invalid');
    validate = async () => { throw Error('boom'); }; assert.equal(await send('paste'), 'failed');
    assert.equal(await send('clear'), 'cleared');
    // The game empties the file (or the install ships it so): back to no command, nothing runs again.
    await writeFile(path, '');
    const count = published.length;
    await instance.poll();
    assert.equal(published.length, count);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the Mistral and Inworld key commands: empty files are no command, and both command files are left untouched on success and on every error path', async () => {
  const directory = await folder();
  try {
    const mistralPath = join(directory, 'mistral-key-command.json'), inworldPath = join(directory, 'inworld-key-command.json');
    await writeFile(mistralPath, ''); await writeFile(inworldPath, '');
    const store = {mistral: null, inworld: null};
    const inworld = new InworldKey({keyPath: 'i', readText: async () => { if (!store.inworld) throw Error('missing'); return `api-key=${store.inworld}\n`; },
      writeText: async (_path, text) => { store.inworld = /api-key=(\S+)/.exec(text)[1]; }, removeFile: async () => { store.inworld = null; }});
    const provider = new MistralProvider({keyPath: 'm', inworld,
      readText: async () => { if (!store.mistral) throw Error('missing'); return `api-key=${store.mistral}\n`; },
      writeText: async (_path, text) => { store.mistral = /api-key=(\S+)/.exec(text)[1]; }, removeFile: async () => { store.mistral = null; }});
    await provider.load();
    const published = [];
    let now = 2_000_000, clipboard = async () => MISTRAL, validate = async () => 'valid', validateInworld = async () => 'valid';
    const instance = new MistralControl({provider, commandPath: mistralPath, inworldCommandPath: inworldPath, model: () => 'm/free',
      localStatus: () => 'not-installed', publish: async value => { published.push(JSON.parse(JSON.stringify(value))); }, now: () => now,
      readClipboard: () => clipboard(), validate: key => validate(key), validateInworld: key => validateInworld(key)});
    await instance.open();
    const first = published.length;
    for (let poll = 0; poll < 3; poll++) { await instance.pollMistral(); await instance.pollInworld(); }
    assert.equal(published.length, first, 'empty placeholders are no command');
    let sequence = 0;
    const send = async (kind, action) => {
      const path = kind === 'mistral' ? mistralPath : inworldPath;
      const text = command(`s:${kind}:${++sequence}`, action, now);
      await writeFile(path, text);
      now += 10;
      await (kind === 'mistral' ? instance.pollMistral() : instance.pollInworld());
      assert.equal(await readFile(path, 'utf8'), text, `${kind} ${action} left its command file as it was`);
      for (const secret of [MISTRAL, INWORLD]) assert.ok(!text.includes(secret));
      assert.deepEqual((await readdir(directory)).sort(), ['inworld-key-command.json', 'mistral-key-command.json']);
      const status = published.at(-1);
      return kind === 'mistral' ? status.result.state : status.inworld.result.state;
    };
    assert.equal(await send('mistral', 'paste'), 'saved');
    clipboard = async () => { throw Error('no clipboard'); };
    assert.equal(await send('mistral', 'paste'), 'unreadable');
    clipboard = async () => 'hello world'; assert.equal(await send('mistral', 'paste'), 'invalid');
    clipboard = async () => MISTRAL; validate = async () => 'invalid'; assert.equal(await send('mistral', 'paste'), 'invalid');
    validate = async () => { throw Error('boom'); }; assert.equal(await send('mistral', 'paste'), 'failed');
    assert.equal(await send('mistral', 'clear'), 'cleared');
    clipboard = async () => INWORLD;
    assert.equal(await send('inworld', 'paste'), 'saved');
    clipboard = async () => { throw Error('no clipboard'); };
    assert.equal(await send('inworld', 'paste'), 'unreadable');
    clipboard = async () => INWORLD; validateInworld = async () => 'invalid'; assert.equal(await send('inworld', 'paste'), 'invalid');
    validateInworld = async () => { throw Error('boom'); }; assert.equal(await send('inworld', 'paste'), 'failed');
    assert.equal(await send('inworld', 'clear'), 'cleared');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the paid tier, editor and memory commands: an empty placeholder is no command and no file is touched', async () => {
  const directory = await folder();
  try {
    const paidPath = join(directory, 'paid-tier-command.json'), editorPath = join(directory, 'editor-command.json');
    const memoryPath = join(directory, 'memory-command.json');
    for (const path of [paidPath, editorPath, memoryPath]) await writeFile(path, '');
    const published = [], opened = [];
    const paid = await new PaidTierControl({keys: {player: null}, commandPath: paidPath, publish: async value => { published.push(value); },
      openBrowser: async url => { opened.push(url); }}).open();
    const before = published.length;
    for (let poll = 0; poll < 3; poll++) await paid.poll();
    assert.equal(published.length, before, 'the paid tier service answers nothing to an empty file');
    paid.close();
    const started = [];
    const editor = await EditorControl.open({server: {start: async () => { started.push(1); return 'http://127.0.0.1:1/'; }, stop: async () => {}},
      commandPath: editorPath, statusPath: join(directory, 'editor-status.json'), open: async url => { opened.push(url); }});
    for (let poll = 0; poll < 3; poll++) await editor.poll();
    assert.deepEqual(started, [], 'the editor does not start for an empty file');
    await assert.rejects(readFile(join(directory, 'editor-status.json'), 'utf8'), {code: 'ENOENT'}, 'and publishes nothing');
    const cleared = [];
    const memory = await PlayerMemoryControl.open({memory: {status: () => ({available: true, talkedToCount: 0, characters: []}),
      clearCharacter: async () => { cleared.push('character'); }, clearAll: async () => { cleared.push('all'); }},
      commandPath: memoryPath, publish: async () => {}});
    for (let poll = 0; poll < 3; poll++) await memory.poll();
    assert.deepEqual(cleared, [], 'no memory is cleared for an empty file');
    await memory.close();
    for (const path of [paidPath, editorPath, memoryPath]) assert.equal(await readFile(path, 'utf8'), '');
    assert.deepEqual(opened, []);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
