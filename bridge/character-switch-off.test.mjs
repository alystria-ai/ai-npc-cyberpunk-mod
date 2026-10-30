import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CharacterOptions, OPTION_FIELDS, OPTION_LIMITS, readOptions, readPerson, validateOptions} from './character-options.mjs';
import {CharacterOverrides} from './character-overrides.mjs';
import {CharacterEditor} from './character-editor.mjs';
import {EditorServer} from './character-editor-server.mjs';
import {PersonaBook} from './mistral-prompt.mjs';

// "Don't talk to this one" (docs/CHARACTER_EDITOR.md, "Switching someone off"): a named or own character is switched off by its key (the `off` choice), an ordinary
// person by the game record they are built from. The store keeps both per player, the game reads both from runtime/character-options.json, and the editor
// lists everyone switched off. The game's half (who is skipped) is in bridge/talk-exclusion.test.mjs.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rows = [...JSON.parse(read('../characters/roster.json')), ...JSON.parse(read('../characters/archetype-roster.json'))];

async function workbench({limits} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'character-off-'));
  await mkdir(join(dir, 'runtime'), {recursive: true});
  const exchange = join(dir, 'runtime', 'character-options.json');
  const store = await CharacterOptions.open({dir: join(dir, 'state'), exchangePath: exchange, ...(limits ? {limits} : {})});
  const overrides = await CharacterOverrides.open({dir: join(dir, 'character-overrides')});
  const personas = new PersonaBook(rows, {overrides, options: store});
  const changed = [];
  const editor = new CharacterEditor({personas, overrides, route: () => 'local', options: store, onChanged: key => changed.push(key)});
  const server = new EditorServer({editor});
  return {dir, exchange, store, editor, server, changed, async done() { await server.stop(); await rm(dir, {recursive: true, force: true}); }};
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
const gameCopy = async bench => JSON.parse(await readFile(bench.exchange, 'utf8'));

test('off is a choice that holds only true; a person holds a plain game record and a short name', () => {
  assert.deepEqual(readOptions({off: true}), {off: true});
  assert.deepEqual(readOptions({off: false, talk: 'calm'}), {talk: 'calm'}, 'false is today\'s behaviour: nothing stored');
  assert.deepEqual(readOptions({off: 'yes'}), {});
  assert(OPTION_FIELDS.includes('off'));
  assert.deepEqual(validateOptions({off: true}, {talk: 'calm'}), {ok: true, value: {talk: 'calm', off: true}});
  assert.deepEqual(validateOptions({off: null}, {talk: 'calm', off: true}), {ok: true, value: {talk: 'calm'}});
  assert.equal(validateOptions({off: false}).ok, false, 'only true or null');
  assert.deepEqual(readPerson('Character.Wat_Lch_Ma_Citizen'), {record: 'Character.Wat_Lch_Ma_Citizen'});
  assert.deepEqual(readPerson({record: 'Character.X', name: '  Behnim  '}), {record: 'Character.X', name: 'Behnim'});
  assert.equal(readPerson({record: 'Character.X', name: 'n'.repeat(200)}).name.length, 80);
  for (const bad of ['', 'has space', '../x', 'a/b', 'x'.repeat(121), 7, null, {name: 'x'}, {record: 7}]) assert.equal(readPerson(bad), null, JSON.stringify(bad));
});

test('a character switched off is saved per player, listed with its name, written for the game and kept after a restart', async t => {
  const bench = await workbench(); t.after(bench.done);
  const saved = await bench.editor.saveOptions('judy-alvarez', {off: true});
  assert.equal(saved.options.values.off, true);
  assert.deepEqual(bench.editor.offForPage.characters, [{key: 'judy-alvarez', name: 'Judy Alvarez'}]);
  assert.deepEqual(bench.editor.state().off.characters, [{key: 'judy-alvarez', name: 'Judy Alvarez'}]);
  assert.deepEqual((await gameCopy(bench)).characters, {'judy-alvarez': {off: true}}, 'the game copy carries it, with no records key when none');
  assert.equal('records' in await gameCopy(bench), false);
  const reopened = await CharacterOptions.open({dir: join(bench.dir, 'state')});
  assert.equal(reopened.get('judy-alvarez').off, true);
  // Switched back on: the row is gone with nothing else in it.
  await bench.editor.saveOptions('judy-alvarez', {off: null});
  assert.deepEqual(bench.editor.offForPage.characters, []);
  assert.deepEqual((await gameCopy(bench)).characters, {});
});

test('the look-and-moves reset leaves the switch alone, and resetting off by name switches the character back on', async t => {
  const bench = await workbench(); t.after(bench.done);
  await bench.editor.saveOptions('judy-alvarez', {off: true, talk: 'calm', sit: false});
  const all = await bench.editor.resetOptions('judy-alvarez');
  assert.deepEqual(all.options.values, {off: true}, 'Reset to default on the look and moves tab does not switch the character back on');
  const back = await bench.editor.resetOptions('judy-alvarez', ['off']);
  assert.deepEqual(back.options.values, {});
});

test('an ordinary person is switched off by the record: saved, listed, written for the game, kept after a restart, switched back on', async t => {
  const bench = await workbench(); t.after(bench.done);
  const list = await bench.editor.setPersonOff({record: 'Character.Wat_Lch_Ma_Citizen', name: 'Street man', off: true});
  assert.deepEqual(list.people, [{record: 'Character.Wat_Lch_Ma_Citizen', name: 'Street man'}]);
  assert.equal(list.max, OPTION_LIMITS.people);
  assert.deepEqual(bench.changed, [''], 'the bridge is told once');
  assert.deepEqual(await gameCopy(bench), {version: 1, characters: {}, records: ['Character.Wat_Lch_Ma_Citizen']}, 'the game gets the record names only');
  const file = JSON.parse(await readFile(join(bench.dir, 'state', 'character-options.json'), 'utf8'));
  assert.deepEqual(file.records, [{record: 'Character.Wat_Lch_Ma_Citizen', name: 'Street man'}], 'the player\'s file keeps the name for the list');
  const reopened = await CharacterOptions.open({dir: join(bench.dir, 'state')});
  assert.equal(reopened.isPersonOff('character.wat_lch_ma_citizen'), true, 'case ignored');
  assert.deepEqual(reopened.offPeople(), [{record: 'Character.Wat_Lch_Ma_Citizen', name: 'Street man'}]);
  // The same record again, in another case, is the same person; a name given earlier is kept when the new one has none.
  await bench.editor.setPersonOff({record: 'character.wat_lch_ma_citizen', off: true});
  assert.equal(bench.editor.offForPage.people.length, 1);
  assert.equal(bench.editor.offForPage.people[0].name, 'Street man');
  const gone = await bench.editor.setPersonOff({record: 'CHARACTER.WAT_LCH_MA_CITIZEN', off: false});
  assert.deepEqual(gone.people, []);
  assert.deepEqual(await gameCopy(bench), {version: 1, characters: {}}, 'no records key once none is left');
  assert.deepEqual((await CharacterOptions.open({dir: join(bench.dir, 'state')})).offPeople(), []);
});

test('a bad record, a bad body and a full list are refused with codes, and nothing is stored', async t => {
  const bench = await workbench({limits: {characters: 400, people: 2}}); t.after(bench.done);
  await assert.rejects(bench.editor.setPersonOff({record: 'two words', off: true}), error => error.status === 422 && error.errors[0].code === 'bad-record' && error.errors[0].field === 'record');
  await assert.rejects(bench.editor.setPersonOff({record: 'Character.X'}), {status: 400});
  await assert.rejects(bench.editor.setPersonOff({record: 'Character.X', off: 'yes'}), {status: 400});
  await assert.rejects(bench.editor.setPersonOff(null), {status: 400});
  await assert.rejects(bench.editor.setPersonOff([]), {status: 400});
  await bench.editor.setPersonOff({record: 'Character.A', off: true});
  await bench.editor.setPersonOff({record: 'Character.B', off: true});
  await assert.rejects(bench.editor.setPersonOff({record: 'Character.C', off: true}), error => error.status === 422 && error.errors[0].code === 'people-full' && error.errors[0].max === 2);
  assert.deepEqual(bench.editor.offForPage.people.map(person => person.record), ['Character.A', 'Character.B']);
  // Switching back on is always possible at the limit.
  assert.deepEqual((await bench.editor.setPersonOff({record: 'Character.A', off: false})).people.map(person => person.record), ['Character.B']);
});

test('the routes: GET and POST /api/off need the session code, and the list reaches the page with the state', async t => {
  const bench = await workbench(); t.after(bench.done);
  await bench.server.start();
  assert.equal((await call(bench.server, 'GET', '/api/off', {token: false})).status, 401);
  assert.equal((await call(bench.server, 'POST', '/api/off', {token: false, body: {record: 'Character.X', off: true}})).status, 401);
  const post = await call(bench.server, 'POST', '/api/off', {body: {record: 'Character.X', name: 'X', off: true}});
  assert.equal(post.status, 200);
  assert.deepEqual(post.json.people, [{record: 'Character.X', name: 'X'}]);
  await call(bench.server, 'PUT', '/api/character/judy-alvarez/options', {body: {off: true}});
  const get = await call(bench.server, 'GET', '/api/off');
  assert.deepEqual(get.json.characters, [{key: 'judy-alvarez', name: 'Judy Alvarez'}]);
  assert.deepEqual(get.json.people, [{record: 'Character.X', name: 'X'}]);
  assert.deepEqual((await call(bench.server, 'GET', '/api/state')).json.off, get.json);
  assert.equal((await call(bench.server, 'POST', '/api/off', {body: {record: 'bad name', off: true}})).status, 422);
  assert.equal((await call(bench.server, 'POST', '/api/off', {body: {record: 'Character.X'}})).status, 400);
  assert.equal((await call(bench.server, 'DELETE', '/api/off')).status, 404);
});

test('without a store there is no switch: the state says so and the routes are 404', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'character-off-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const overrides = await CharacterOverrides.open({dir: join(dir, 'character-overrides')});
  const editor = new CharacterEditor({personas: new PersonaBook(rows, {overrides}), overrides, route: () => 'local'});
  const server = new EditorServer({editor});
  t.after(() => server.stop());
  await server.start();
  assert.equal(editor.state().off, null);
  assert.equal((await call(server, 'GET', '/api/off')).status, 404);
  assert.equal((await call(server, 'POST', '/api/off', {body: {record: 'Character.X', off: true}})).status, 404);
});

test('a start with only switched-off people and no copy of the game writes it, and a start with nothing writes nothing', async t => {
  const bench = await workbench(); t.after(bench.done);
  await bench.editor.setPersonOff({record: 'Character.A', off: true});
  const fresh = await mkdtemp(join(tmpdir(), 'character-off-'));
  t.after(() => rm(fresh, {recursive: true, force: true}));
  await mkdir(join(fresh, 'runtime'), {recursive: true});
  const copy = join(fresh, 'runtime', 'character-options.json');
  const empty = await CharacterOptions.open({dir: join(fresh, 'state'), exchangePath: copy});
  assert.equal(await empty.publish({quiet: true}), false, 'nothing to say, no file in the game folder');
  const store = await CharacterOptions.open({dir: join(bench.dir, 'state'), exchangePath: copy});
  assert.equal(await store.publish({quiet: true}), true);
  assert.deepEqual(JSON.parse(await readFile(copy, 'utf8')).records, ['Character.A']);
});

test('the page carries the switch, the list, the person card and every sentence of them, and the game sends and translates the same sentences', () => {
  const page = read('./character-editor-page.mjs'), lua = read('../mod/character-editor.lua');
  assert.match(page, /\/api\/off/);
  assert.match(page, /id: 'f-off'/);
  assert.doesNotMatch(page, /innerHTML/);
  const sentences = ['Don’t talk to this character', 'While this is on, they do not answer you and never join a group chat. Untick it to talk to them again.', 'Don’t talk to this person',
    'It also stops everyone the game builds from the same record, so other people of the same kind may stop answering too.', 'Switched off', 'Switched off.', 'Switched back on.', 'Switch back on',
    'People and characters you chose not to talk to. Switch one back on to talk to them again.', 'That person cannot be switched off.',
    'You have switched off as many people as the editor keeps ({max}). Switch one back on first.'];
  const english = JSON.parse(read('../localization/en.json')).strings;
  for (const text of sentences) {
    assert(page.includes(`T('${text}'`), `the page uses: ${text}`);
    assert(lua.includes(`['${text}'] = ui.t('${text}')`), `the game sends: ${text}`);
    assert(text in english, `the catalogue has: ${text}`);
  }
  for (const lang of ['cs', 'de', 'es', 'fr', 'hu', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'uk', 'zh-cn', 'zh-tw']) {
    const dictionary = read(`../mod/locales/${lang}.lua`);
    for (const text of sentences) assert(dictionary.includes(`["${text}"] =`), `${lang}: ${text}`);
  }
});
