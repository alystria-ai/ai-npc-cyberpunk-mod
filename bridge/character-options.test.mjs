import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir, mkdtemp, readFile, rm, writeFile, stat} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CharacterOptions, OPTION_FIELDS, OPTION_VALUES, REPLY_WORDS, readOptions, validateOptions} from './character-options.mjs';
import {OUTFITS, isOutfitOf, outfitRecord, outfitsFor} from './outfit-choices.mjs';
import {CharacterOverrides} from './character-overrides.mjs';
import {CharacterEditor} from './character-editor.mjs';
import {EditorServer} from './character-editor-server.mjs';
import {CustomCharacters, rosterIndex} from './custom-characters.mjs';
import {PersonaBook, systemHead} from './mistral-prompt.mjs';

// The character editor's "Look and moves" part (docs/CHARACTER_EDITOR.md): the store, the looks, the editor and its routes, and the reply length in the prompt.
// The Lua halves (the looks, the gestures, the seating, the file the game reads) are in bridge/character-options-lua.test.mjs.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rows = [...JSON.parse(read('../characters/roster.json')), ...JSON.parse(read('../characters/archetype-roster.json'))];

async function workbench({options = true, custom = false} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'character-options-'));
  await mkdir(join(dir, 'runtime'), {recursive: true});
  const exchange = join(dir, 'runtime', 'character-options.json');
  const store = options ? await CharacterOptions.open({dir: join(dir, 'state'), exchangePath: exchange}) : null;
  const overrides = await CharacterOverrides.open({dir: join(dir, 'character-overrides')});
  const made = custom ? await CustomCharacters.open({dir: join(dir, 'state'), exchangePath: join(dir, 'runtime', 'custom-characters.json'), roster: rosterIndex(rows)}) : null;
  const personas = new PersonaBook(rows, {overrides, custom: made, options: store});
  const changed = [];
  const editor = new CharacterEditor({personas, overrides, route: () => 'local', custom: made, options: store, onChanged: key => changed.push(key)});
  const server = new EditorServer({editor});
  return {dir, exchange, store, personas, editor, server, changed, made,
    async done() { await server.stop(); await rm(dir, {recursive: true, force: true}); }};
}
function call(server, method, path, {body, token = true} = {}) {
  const url = new URL(server.url);
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({host: '127.0.0.1', port: url.port, method, path,
      headers: {Host: `127.0.0.1:${url.port}`, ...(token ? {'X-Editor-Token': server.token} : {}), ...(data === undefined ? {} : {'Content-Type': 'application/json'})}}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({status: response.statusCode, json}); });
    });
    request.on('error', reject);
    request.end(data);
  });
}
const exists = async path => { try { await stat(path); return true; } catch { return false; } };

// ---- the choices and their checks

test('a row holds only known fields with allowed values; nothing else is ever stored', () => {
  assert.deepEqual(readOptions({outfit: 'judy__mq055__apartment_01', talk: 'calm', nods: false, idle: 'plain', sit: false, react: false, length: 'brief'}),
    {outfit: 'judy__mq055__apartment_01', talk: 'calm', nods: false, idle: 'plain', sit: false, react: false, length: 'brief'});
  assert.deepEqual(readOptions({talk: 'wild', nods: true, idle: 'x', sit: 0, react: 'no', length: 'long', outfit: '../x', other: 1}), {}, 'today\'s values and unknown ones are not stored');
  assert.deepEqual(readOptions(null), {});
  assert.deepEqual(readOptions([]), {});
  assert.deepEqual(OPTION_FIELDS, ['outfit', 'talk', 'nods', 'idle', 'sit', 'react', 'length', 'off']);
  assert.deepEqual(OPTION_VALUES.talk, ['calm', 'lively', 'none']);
  assert(Object.values(REPLY_WORDS).every(words => words >= 8 && words <= 60), 'the prompt builder accepts 8 to 60 words');
});

test('validation: null puts a choice back to today\'s behaviour, a wrong value or an unknown field is refused, the other choices stay', () => {
  const ok = name => name === 'panam_no_jacket';
  const first = validateOptions({talk: 'lively', outfit: 'panam_no_jacket', nods: false}, {}, {outfitOk: ok});
  assert.deepEqual(first, {ok: true, value: {talk: 'lively', outfit: 'panam_no_jacket', nods: false}});
  const next = validateOptions({talk: null}, first.value, {outfitOk: ok});
  assert.deepEqual(next.value, {outfit: 'panam_no_jacket', nods: false});
  assert.deepEqual(validateOptions({outfit: 'judy_default'}, {}, {outfitOk: ok}).errors, [{field: 'outfit', code: 'outfit-bad'}], 'a look of another character');
  assert.deepEqual(validateOptions({outfit: 'panam_no_jacket'}, {}).errors, [{field: 'outfit', code: 'outfit-bad'}], 'a character with no looks');
  assert.deepEqual(validateOptions({talk: 'wild'}, {}).errors, [{field: 'talk', code: 'option-bad'}]);
  assert.deepEqual(validateOptions({nods: true}, {}).errors, [{field: 'nods', code: 'option-bad'}], 'true is today\'s value: send null');
  assert.deepEqual(validateOptions({color: 'red'}, {}).errors, [{field: 'color', code: 'unknown-field'}]);
  assert.deepEqual(validateOptions('x', {}).errors, [{field: '', code: 'bad-request'}]);
  assert.deepEqual(validateOptions({outfit: '../../x'}, {}, {outfitOk: () => true}).errors, [{field: 'outfit', code: 'outfit-bad'}], 'a name is checked for its shape even when a list would accept it');
});

// ---- the store

test('the store keeps the choices on disk, reloads them, writes the game\'s copy without the reply length, and removes a row that holds nothing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'options-store-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const exchangePath = join(dir, 'runtime', 'character-options.json'), changes = [];
  const store = await CharacterOptions.open({dir: join(dir, 'state'), exchangePath, now: () => 1234, onChange: () => changes.push(1)});
  assert.equal(store.size, 0);
  assert.equal(store.talkWords('judy-alvarez'), 0);
  await store.set('judy-alvarez', {talk: 'calm', length: 'short', outfit: 'judy__mq055__apartment_01'});
  await store.set('panam-palmer', {sit: false});
  assert.equal(changes.length, 2);
  assert.equal(store.talkWords('judy-alvarez'), 25);
  assert.equal(store.talkWords('panam-palmer'), 0);
  const game = JSON.parse(await readFile(exchangePath, 'utf8'));
  assert.deepEqual(game, {version: 1, characters: {'judy-alvarez': {outfit: 'judy__mq055__apartment_01', talk: 'calm'}, 'panam-palmer': {sit: false}}},
    'the reply length stays in the service');
  const saved = JSON.parse(await readFile(join(dir, 'state', 'character-options.json'), 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.characters['judy-alvarez'], {outfit: 'judy__mq055__apartment_01', talk: 'calm', length: 'short'});
  const again = await CharacterOptions.open({dir: join(dir, 'state')});
  assert.deepEqual(again.get('judy-alvarez'), {outfit: 'judy__mq055__apartment_01', talk: 'calm', length: 'short'});
  assert(Object.isFrozen(again.get('judy-alvarez')));
  await store.reset('judy-alvarez', 'talk');
  assert.deepEqual(store.get('judy-alvarez'), {outfit: 'judy__mq055__apartment_01', length: 'short'});
  await store.reset('judy-alvarez');
  assert.equal(store.get('judy-alvarez'), null);
  assert.deepEqual(store.keys(), ['panam-palmer']);
  await assert.rejects(store.set('../x', {sit: false}), {code: 'bad-key'});
  await assert.rejects(store.reset('panam-palmer', 'bio'), {code: 'unknown-field'});
});

test('the game\'s copy: written at start only when there is something to say or an older copy to replace, and a failing write never fails a save', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'options-quiet-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const exchangePath = join(dir, 'runtime', 'character-options.json');
  const none = await CharacterOptions.open({dir: join(dir, 'state'), exchangePath});
  assert.equal(await none.publish({quiet: true}), false);
  assert.equal(await exists(exchangePath), false, 'no choices and no older copy: no new file in the game folder');
  await mkdir(join(dir, 'runtime'), {recursive: true});
  await writeFile(exchangePath, '{"version":1,"characters":{"old":{"sit":false}}}');
  assert.equal(await none.publish({quiet: true}), true);
  assert.deepEqual(JSON.parse(await readFile(exchangePath, 'utf8')).characters, {}, 'a copy of an earlier run is cleared');
  const broken = await CharacterOptions.open({dir: join(dir, 'state'), exchangePath, write: async file => { if (file === exchangePath) throw Error('locked'); return true; }, log: () => {}});
  await broken.set('judy-alvarez', {sit: false});
  assert.deepEqual(broken.get('judy-alvarez'), {sit: false}, 'the save counts although the game\'s copy was not written');
});

test('a save that changes nothing the game reads does not rewrite the copy of the game: the reply length stays in the service', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'options-length-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const exchangePath = join(dir, 'runtime', 'character-options.json'), writes = [];
  const store = await CharacterOptions.open({dir: join(dir, 'state'), exchangePath,
    write: async (file, text) => { writes.push(file === exchangePath ? 'game' : 'state'); await mkdir(join(file, '..'), {recursive: true}); await writeFile(file, text); return true; }});
  await store.set('judy-alvarez', {length: 'short'});
  assert.deepEqual(writes, ['state', 'game'], 'the first publish writes the (empty) copy once');
  writes.length = 0;
  await store.set('judy-alvarez', {length: 'brief'});
  assert.deepEqual(writes, ['state'], 'only the own file of the service');
  await store.set('judy-alvarez', {length: 'brief', sit: false});
  assert.deepEqual(writes, ['state', 'state', 'game']);
});

test('a damaged file is left alone and kept aside before the first save; prune and remove drop rows of characters that are gone', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'options-damaged-')); t.after(() => rm(dir, {recursive: true, force: true}));
  await mkdir(join(dir, 'state'), {recursive: true});
  const file = join(dir, 'state', 'character-options.json');
  await writeFile(file, '{ not json');
  const logs = [];
  const store = await CharacterOptions.open({dir: join(dir, 'state'), log: line => logs.push(line)});
  assert.equal(store.size, 0);
  assert.match(logs.join('\n'), /could not be read/);
  assert.equal(await readFile(file, 'utf8'), '{ not json', 'left as it is until a save');
  await store.set('judy-alvarez', {react: false});
  assert.equal(await readFile(file + '.corrupt', 'utf8'), '{ not json');
  await store.set('custom-rebecca-k3j9', {sit: false});
  assert.equal(await store.prune(key => !key.startsWith('custom-')), 1);
  assert.deepEqual(store.keys(), ['judy-alvarez']);
  await store.remove('judy-alvarez');
  await store.remove('nobody');
  assert.equal(store.size, 0);
  await writeFile(file, JSON.stringify({version: 1, characters: {'judy-alvarez': {talk: 'calm', evil: 1, nods: true}, 'Bad Key': {sit: false}, empty: {}}}));
  const loaded = await CharacterOptions.open({dir: join(dir, 'state')});
  assert.deepEqual(loaded.keys(), ['judy-alvarez']);
  assert.deepEqual(loaded.get('judy-alvarez'), {talk: 'calm'}, 'only allowed values survive a hand-edited file');
});

// ---- the looks

const dataSource = read('../mod/companion-outfits-data.lua');
function luaList() {
  const characters = {};
  let current = null;
  for (const line of dataSource.split('\n')) {
    const head = /\['(Character\.[^']+)'\] = \{base = '([^']+)'/.exec(line);
    if (head) { current = characters[head[1]] = {base: head[2], looks: []}; continue; }
    const look = /^\s*\{'([^']+)', '(\w+)'\}/.exec(line);
    if (look && current) current.looks.push([look[1], look[2]]);
  }
  return characters;
}

test('the looks the editor offers are exactly the curated list the game changes companions into, and each name is one the character\'s own template lists', () => {
  const lua = luaList(), evidence = JSON.parse(read('../characters/companion-outfit-evidence.json')).records;
  assert.deepEqual(Object.keys(OUTFITS).sort(), Object.keys(lua).sort());
  for (const [record, {base, looks}] of Object.entries(OUTFITS)) {
    assert.equal(base, lua[record].base, record);
    assert.deepEqual(looks.map(([name, kind]) => [name, kind]), lua[record].looks, record);
    assert.equal(looks[0][0], base, `${record}: the first look is the usual one`);
    for (const [name, , label] of looks) {
      assert(evidence[record].listedAppearances.includes(name), `${record}: ${name} is not in its template`);
      assert(label && !/[;]/.test(label), `${record}: ${name} has a label`);
    }
    assert(rows.some(row => (row.records ?? []).includes(record) && row.kind === 'named'), `${record} belongs to a named character`);
  }
});

test('every look label is a page sentence: the page translates it, the game sends it and all fifteen dictionaries have it', () => {
  const page = read('./character-editor-page.mjs'), lua = read('../mod/character-editor.lua');
  const labels = new Set(Object.values(OUTFITS).flatMap(({looks}) => looks.map(look => look[2])));
  assert(labels.size >= 20);
  for (const label of labels) {
    assert(page.includes(`'${label}': T('${label}')`), `${label} is looked up by the page`);
    assert(lua.includes(`['${label}'] = ui.t('${label}')`), `${label} is sent by the game`);
  }
  for (const lang of ['cs', 'de', 'es', 'fr', 'hu', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'uk', 'zh-cn', 'zh-tw']) {
    const text = read(`../mod/locales/${lang}.lua`);
    for (const label of labels) assert(text.includes(`["${label}"] =`), `${lang}: ${label}`);
  }
});

test('outfitsFor finds a character by any of its records and answers null for one with a single look', () => {
  assert.equal(outfitRecord(['Character.Nobody', 'Character.Judy']), 'Character.Judy');
  assert.equal(outfitRecord(['Character.Nobody']), null);
  assert.equal(outfitRecord(undefined), null);
  assert.equal(outfitsFor(['Character.Nobody']), null);
  const judy = outfitsFor(['Character.Judy']);
  assert.deepEqual(judy.looks[0], {name: 'judy_default', kind: 'any', label: 'Usual look'});
  assert(isOutfitOf('Character.Judy', 'judy__mq055__apartment_01'));
  assert(!isOutfitOf('Character.Judy', 'panam_default') && !isOutfitOf('Character.Nobody', 'x') && !isOutfitOf('Character.Judy', undefined));
  assert(!isOutfitOf('toString', 'x') && !isOutfitOf('__proto__', 'x'), 'no prototype names');
});

// ---- the editor

test('details carry the choices and the character\'s looks; everyday people and V\'s voices have none', async t => {
  const bench = await workbench(); t.after(bench.done);
  const judy = bench.editor.details('judy-alvarez');
  assert.deepEqual(judy.options.values, {});
  assert.equal(judy.options.outfits.record, 'Character.Judy');
  assert(judy.options.outfits.looks.some(look => look.name === 'judy__mq055__apartment_01'));
  const plain = rows.find(row => row.kind === 'named' && !outfitRecord(row.records));
  assert.equal(bench.editor.details(plain.key).options.outfits, null, `${plain.key} has one look in the game files`);
  const everyday = rows.find(row => row.kind === 'archetype');
  assert.equal(bench.editor.details(everyday.key).options, null);
  assert.deepEqual(Object.keys(bench.editor.state().options), ['values', 'words']);
  assert.deepEqual(bench.editor.state().options.words, REPLY_WORDS);
});

test('saving a choice stores it, tells the bridge, writes the game\'s copy and survives a restart; reset puts today\'s behaviour back', async t => {
  const bench = await workbench(); t.after(bench.done);
  const saved = await bench.editor.saveOptions('judy-alvarez', {outfit: 'judy__mq055__apartment_01', talk: 'none', nods: false, idle: 'plain', sit: false, react: false, length: 'brief'});
  assert.deepEqual(saved.options.values, {outfit: 'judy__mq055__apartment_01', talk: 'none', nods: false, idle: 'plain', sit: false, react: false, length: 'brief'});
  assert.deepEqual(bench.changed, ['judy-alvarez']);
  const game = JSON.parse(await readFile(bench.exchange, 'utf8'));
  assert.deepEqual(game.characters['judy-alvarez'], {outfit: 'judy__mq055__apartment_01', talk: 'none', nods: false, idle: 'plain', sit: false, react: false});
  const reopened = await CharacterOptions.open({dir: join(bench.dir, 'state')});
  assert.equal(reopened.talkWords('judy-alvarez'), 12);
  const partial = await bench.editor.saveOptions('judy-alvarez', {talk: null, outfit: null});
  assert.deepEqual(partial.options.values, {nods: false, idle: 'plain', sit: false, react: false, length: 'brief'});
  const part = await bench.editor.resetOptions('judy-alvarez', ['idle', 'sit']);
  assert.deepEqual(part.options.values, {nods: false, react: false, length: 'brief'});
  const clean = await bench.editor.resetOptions('judy-alvarez');
  assert.deepEqual(clean.options.values, {});
  assert.deepEqual(JSON.parse(await readFile(bench.exchange, 'utf8')).characters, {});
  assert.equal(bench.editor.details('judy-alvarez').edited.bio, false, 'the text edits are untouched by the choices');
  await assert.rejects(bench.editor.resetOptions('judy-alvarez', ['bio']), {status: 400});
  await assert.rejects(bench.editor.resetOptions('judy-alvarez', 'talk'), {status: 400});
});

test('a look of another character, a wrong value, an unknown field, an unknown or everyday character are refused and nothing is stored', async t => {
  const bench = await workbench(); t.after(bench.done);
  const refused = async (key, patch, code) => {
    await assert.rejects(bench.editor.saveOptions(key, patch), error => error.status === 422 && error.errors[0].code === code, JSON.stringify(patch));
  };
  await refused('judy-alvarez', {outfit: 'panam_default'}, 'outfit-bad');
  await refused('judy-alvarez', {outfit: 'judy_default\n'}, 'outfit-bad');
  await refused('judy-alvarez', {talk: 'loud'}, 'option-bad');
  await refused('judy-alvarez', {mood: 'sad'}, 'unknown-field');
  const plain = rows.find(row => row.kind === 'named' && !outfitRecord(row.records));
  await refused(plain.key, {outfit: 'judy_default'}, 'outfit-bad');
  const ok = await bench.editor.saveOptions(plain.key, {talk: 'calm'});
  assert.deepEqual(ok.options.values, {talk: 'calm'}, 'a character with one look still has the other choices');
  await assert.rejects(bench.editor.saveOptions('nobody-here', {talk: 'calm'}), {status: 404});
  await assert.rejects(bench.editor.saveOptions(rows.find(row => row.kind === 'archetype').key, {talk: 'calm'}), {status: 404});
  await assert.rejects(bench.editor.saveOptions('v-male', {talk: 'calm'}), {status: 404});
  await assert.rejects(bench.editor.saveOptions('judy-alvarez', 'talk'), {status: 422});
  assert.equal(bench.store.get('judy-alvarez'), null);
  assert.deepEqual(bench.store.keys(), [plain.key]);
});

test('without a store there is no Look and moves: details and state say so and the routes are 404', async t => {
  const bench = await workbench({options: false}); t.after(bench.done);
  assert.equal(bench.editor.details('judy-alvarez').options, null);
  assert.equal(bench.editor.state().options, null);
  await bench.server.start();
  assert.equal((await call(bench.server, 'PUT', '/api/character/judy-alvarez/options', {body: {talk: 'calm'}})).status, 404);
  assert.equal((await call(bench.server, 'POST', '/api/character/judy-alvarez/options/reset', {body: {}})).status, 404);
});

test('the routes: PUT saves, POST reset resets, both need the session code, and a bad body is a plain refusal', async t => {
  const bench = await workbench(); t.after(bench.done);
  await bench.server.start();
  const path = '/api/character/panam-palmer/options';
  assert.equal((await call(bench.server, 'PUT', path, {body: {talk: 'calm'}, token: false})).status, 401);
  const put = await call(bench.server, 'PUT', path, {body: {talk: 'lively', outfit: 'panam_no_jacket'}});
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.options.values, {talk: 'lively', outfit: 'panam_no_jacket'});
  assert.deepEqual((await call(bench.server, 'GET', '/api/character/panam-palmer')).json.options.values, {talk: 'lively', outfit: 'panam_no_jacket'});
  const bad = await call(bench.server, 'PUT', path, {body: {outfit: 'judy_default'}});
  assert.equal(bad.status, 422);
  assert.equal(bad.json.errors[0].code, 'outfit-bad');
  assert.equal((await call(bench.server, 'PUT', '/api/character/zzz-nobody/options', {body: {talk: 'calm'}})).status, 404);
  assert.equal((await call(bench.server, 'PUT', path, {body: ['x']})).status, 422);
  const reset = await call(bench.server, 'POST', path + '/reset', {body: {fields: ['talk']}});
  assert.deepEqual(reset.json.options.values, {outfit: 'panam_no_jacket'});
  assert.deepEqual((await call(bench.server, 'POST', path + '/reset', {body: {}})).json.options.values, {});
  assert.equal((await call(bench.server, 'POST', path + '/reset', {body: {fields: ['bio']}})).status, 400);
});

test('a character the player made has the choices too (no looks), and deleting it takes them away', async t => {
  const bench = await workbench({custom: true}); t.after(bench.done);
  const row = await bench.editor.createCustom({name: 'Rebecca', gender: 'female', records: ['Character.Rebecca'], names: [], bio: 'I am Rebecca, a small and loud gunslinger from Pilar who never stops talking.', style: '', examples: [], memories: []});
  const key = row.key;
  assert.equal(row.options.outfits, null);
  const saved = await bench.editor.saveOptions(key, {sit: false, react: false});
  assert.deepEqual(saved.options.values, {sit: false, react: false});
  assert.deepEqual(JSON.parse(await readFile(bench.exchange, 'utf8')).characters[key], {sit: false, react: false});
  await bench.editor.deleteCustom(key);
  await bench.store.remove(key);   // what the bridge does when the character is deleted (convai-bridge onDeleted)
  assert.equal(bench.store.get(key), null);
  assert.deepEqual(JSON.parse(await readFile(bench.exchange, 'utf8')).characters, {});
  await assert.rejects(bench.editor.saveOptions(key, {sit: false}), {status: 404});
});

// ---- the reply length in the prompt

test('a chosen reply length is the persona\'s talkWords and reaches the rules and the closing line; no choice leaves the prompt as it was, byte for byte', async t => {
  const bench = await workbench(); t.after(bench.done);
  const before = systemHead({persona: bench.personas.persona('judy-alvarez')});
  assert.equal(bench.personas.persona('judy-alvarez').talkWords, undefined);
  await bench.editor.saveOptions('judy-alvarez', {length: 'short', talk: 'calm'});
  const persona = bench.personas.persona('judy-alvarez');
  assert.equal(persona.talkWords, 25);
  const after = systemHead({persona});
  assert.notEqual(after, before);
  assert.match(after, /at most 25 words/);
  assert.equal(bench.personas.persona('panam-palmer').talkWords, undefined, 'another character is not touched');
  await bench.editor.saveOptions('judy-alvarez', {length: null});
  assert.equal(systemHead({persona: bench.personas.persona('judy-alvarez')}), before);
  await bench.editor.saveOptions('judy-alvarez', {length: 'brief'});
  assert.match(systemHead({persona: bench.personas.persona('judy-alvarez')}), /at most 12 words/);
  // A choice that is not about the length changes nothing in the prompt.
  await bench.editor.saveOptions('judy-alvarez', {length: null, sit: false});
  assert.equal(systemHead({persona: bench.personas.persona('judy-alvarez')}), before);
  // An add-on speaker's own reply length wins over the player's.
  const speaker = new PersonaBook([{key: 'addon-x', name: 'X', kind: 'named', backstory: 'I am X.', speakingStyleDescription: '', speakingStyleSampleDialogues: '', talkWords: 30}], {options: {talkWords: () => 12}});
  assert.equal(speaker.persona('addon-x').talkWords, 30);
});

test('the player-made character\'s persona takes the length too', async t => {
  const bench = await workbench({custom: true}); t.after(bench.done);
  const row = await bench.editor.createCustom({name: 'Rebecca', gender: 'female', records: ['Character.Rebecca'], names: [], bio: 'I am Rebecca, a small and loud gunslinger from Pilar who never stops talking.', style: '', examples: [], memories: []});
  assert.equal(bench.personas.persona(row.key).talkWords, undefined);
  await bench.editor.saveOptions(row.key, {length: 'short'});
  assert.equal(bench.personas.persona(row.key).talkWords, 25);
});

test('the page offers the tab and the section only where there are choices, and a saved page draft is compared with the stored choices', () => {
  const page = read('./character-editor-page.mjs');
  assert.match(page, /\['look', \['look'\]\]/);
  assert.match(page, /\/options'/);
  assert.match(page, /T\('Look and moves'\)/);
  assert.doesNotMatch(page, /innerHTML/);
});
