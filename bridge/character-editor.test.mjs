import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CharacterOverrides, EDIT_LIMITS} from './character-overrides.mjs';
import {CharacterEditor, V_EDITOR_KEYS, ROMANCE_KEYS, COMPANION_KEYS} from './character-editor.mjs';
import {RELATIONSHIP_PROFILES} from './relationship-routing.mjs';
import {TIER1_KEYS} from '../scripts/Create-MultilingualProfiles.mjs';
import {EditorServer, cleanStrings} from './character-editor-server.mjs';
import {EditorControl, parseEditorCommand} from './character-editor-control.mjs';
import {renderEditorPage} from './character-editor-page.mjs';
import {MemoryStore} from './memory-store.mjs';
import {PersonaBook, systemHead} from './mistral-prompt.mjs';
import {CustomCharacters, rosterIndex} from './custom-characters.mjs';
import {PlayerVoices} from './player-voices.mjs';
import {CLIP, prepareUpload} from './custom-voice-clip.mjs';
import {speechWav} from './voice-clip-fixture.mjs';
import {rosterLookup} from './addons.mjs';

const nonce0 = policy => /nonce-([A-Za-z0-9_-]+)/.exec(policy)[1];
const rows = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];

// A whole editor over a temporary state folder: the same files the bridge uses (character-overrides/, local-memory/player/).
// voices: the clips of story characters and of the player's own (state/player-voices/); voiceOptions reach PlayerVoices (a tighter limit, no ffmpeg).
async function workbench({route = 'local', seed = true, custom = false, voices = false, voiceOptions = {}} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'character-editor-'));
  const memoryDir = join(dir, 'local-memory');
  if (seed) {
    await mkdir(join(memoryDir, 'player'), {recursive: true});
    await writeFile(join(memoryDir, 'player', 'judy-alvarez.json'), JSON.stringify({version: 1, profileKey: 'judy-alvarez', updated: 5, summary: 'V asked me about the clinic.',
      overflow: [], channels: {private: [], phone: [], group: []}, embedder: null, pending: [],
      records: [{id: 'a', kind: 'preference', text: 'V likes whiskey.', created: 1, updated: 2, importance: 0.5, pinned: false, source: 'chat', v: ''},
        {id: 'b', kind: 'promise', text: 'I promised V a favour.', created: 1, updated: 3, importance: 0.6, pinned: false, source: 'chat', v: ''}]}));
  }
  const overrides = await CharacterOverrides.open({dir: join(dir, 'character-overrides')});
  const memory = await MemoryStore.open({dir: memoryDir});
  // custom: the characters the player makes (state/custom-characters.json, state/custom-voices/), with the game's list in runtime/.
  await mkdir(join(dir, 'runtime'), {recursive: true});
  const made = custom ? await CustomCharacters.open({dir: join(dir, 'state'), exchangePath: join(dir, 'runtime', 'custom-characters.json'), roster: rosterIndex(rows)}) : null;
  const personas = new PersonaBook(rows, {overrides, custom: made});
  const state = {route};
  const clips = voices ? await PlayerVoices.open({dir: join(dir, 'state'), ...voiceOptions}) : null;
  const editor = new CharacterEditor({personas, overrides, memory, route: () => state.route, custom: made, voices: clips});
  const server = new EditorServer({editor});
  return {dir, overrides, memory, personas, editor, server, state, custom: made, voices: clips,
    async done() { await server.stop(); await memory.flush().catch(() => {}); await rm(dir, {recursive: true, force: true}); }};
}
// One request to the server: Node's own client, so the headers can be set exactly (fetch will not let a test lie about Host).
function call(server, method, path, {body, headers = {}, token = true, host, raw} = {}) {
  const url = new URL(server.url);
  const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({host: '127.0.0.1', port: url.port, method, path,
      headers: {Host: host ?? `127.0.0.1:${url.port}`, ...(token ? {'X-Editor-Token': server.token} : {}), ...(data === undefined ? {} : {'Content-Type': 'application/json'}), ...headers}}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({status: response.statusCode, headers: response.headers, text, json, bytes});
      });
    });
    request.on('error', reject);
    request.end(data);
  });
}

// ---- the editor's logic

test('the catalogue lists story characters first, then everyday people, each by name, and marks edited ones', async t => {
  const bench = await workbench(); t.after(bench.done);
  const list = bench.editor.catalog();
  assert.equal(list.length, rows.length);
  const firstEveryday = list.findIndex(item => item.group === 'everyday');
  assert(firstEveryday > 0 && list.slice(0, firstEveryday).every(item => item.group === 'story') && list.slice(firstEveryday).every(item => item.group === 'everyday'));
  const names = list.slice(0, firstEveryday).map(item => item.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en', {sensitivity: 'base'})));
  assert(list.every(item => item.edited === false));
  await bench.editor.save('judy-alvarez', {style: 'Calm.'});
  assert.equal(bench.editor.catalog().find(item => item.key === 'judy-alvarez').edited, true);
  assert.equal(bench.editor.catalog().filter(item => item.edited).length, 1);
});

test('every shipped row has the role the picker filters by: romance, companion, story, side or minor, from the lists the rest of the mod already keeps', async t => {
  const bench = await workbench(); t.after(bench.done);
  const list = bench.editor.catalog();
  assert(list.every(item => ['romance', 'companion', 'story', 'side', 'minor'].includes(item.role)), 'a role on every row');
  // The two lists are the mod's own: the people the game lets V romance (bridge/relationship-routing.mjs), and the tier-1 characters (mod/auto-connect.lua, scripts/Create-MultilingualProfiles.mjs).
  const relationship = Object.entries(RELATIONSHIP_PROFILES).filter(([, row]) => row.kind === 'relationship').map(([key]) => key).sort();
  assert.deepEqual([...ROMANCE_KEYS].sort(), relationship);
  const tier1 = [...(await readFile(new URL('../mod/auto-connect.lua', import.meta.url), 'utf8')).match(/M\.TIER1 = \{\}\r?\nfor _, key in ipairs\(\{([^}]*)\}\)/)[1].matchAll(/'([a-z0-9-]+)'/g)].map(match => match[1]).sort();
  assert.deepEqual([...COMPANION_KEYS].sort(), tier1);
  assert.deepEqual([...COMPANION_KEYS].sort(), [...TIER1_KEYS].sort());
  const byKey = new Map(list.map(item => [item.key, item]));
  for (const key of [...ROMANCE_KEYS, ...COMPANION_KEYS]) assert(byKey.has(key), `${key} is a character of the roster`);
  for (const key of ROMANCE_KEYS) assert.equal(byKey.get(key).role, 'romance', key);
  for (const key of COMPANION_KEYS.filter(item => !ROMANCE_KEYS.includes(item))) assert.equal(byKey.get(key).role, 'companion', key);
  const count = role => list.filter(item => item.role === role).length;
  assert.equal(count('romance'), 4);
  assert.equal(count('companion'), COMPANION_KEYS.length - 4);
  assert.equal(count('story') + count('romance') + count('companion') + count('minor'), list.filter(item => item.group === 'story').length, 'every named character has one of the four');
  // The cast sweep's minor profiles (docs/CAST_SWEEP.md) are named rows with their own role, so the picker can keep them under their own chip.
  const roster = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));
  assert.equal(count('minor'), roster.filter(row => row.minor === true).length);
  assert(roster.filter(row => row.minor === true).every(row => byKey.get(row.key)?.role === 'minor'), 'a minor row is a minor character');
  assert.equal(count('side'), list.filter(item => item.group === 'everyday').length, 'everyday people are side characters');
  // The player's own rows and V's two rows carry no role: the page knows them by their group.
  const made = await workbench({custom: true, voices: true}); t.after(made.done);
  assert(made.editor.catalog().filter(item => item.group === 'v').every(item => !('role' in item)));
});

test('details give the shipped text, the current text and what is edited; defaults come from the Convai-derived profile', async t => {
  const bench = await workbench(); t.after(bench.done);
  const before = bench.editor.details('judy-alvarez');
  assert.equal(before.name, 'Judy Alvarez');
  assert.match(before.defaults.bio, /green and pink hair/);
  assert.doesNotMatch(before.defaults.bio, /CyberpunkConvai profile/);
  assert.match(before.defaults.style, /^Editorial delivery/);
  assert(before.defaults.examples.length >= 5 && before.defaults.examples.every(line => !line.includes('\n')));
  assert.deepEqual(before.defaults.rules, []);
  assert.deepEqual(before.values, before.defaults);
  assert.deepEqual(before.edited, {bio: false, style: false, rules: false, examples: false, memories: false});
  const after = await bench.editor.save('judy-alvarez', {rules: ['Never swear.'], memories: ['V has a sister called Lena.']});
  assert.deepEqual(after.values.rules, ['Never swear.']);
  assert.deepEqual(after.edited, {bio: false, style: false, rules: true, examples: false, memories: true});
  assert.deepEqual(after.defaults, before.defaults, 'the shipped text does not move');
});

test('saving feeds the prompt builder on the next turn, and reset puts the shipped text back', async t => {
  const bench = await workbench(); t.after(bench.done);
  const shipped = systemHead({persona: bench.personas.persona('river-ward')});
  await bench.editor.save('river-ward', {bio: 'River is a quiet rancher who keeps the Aldecaldos horses and talks about them too much. '.repeat(2),
    rules: ['Never swear.'], memories: ['V helped with the fence.']});
  const edited = systemHead({persona: bench.personas.persona('river-ward')});
  assert.match(edited, /River is a quiet rancher/);
  assert.match(edited, /- Never swear\./);
  assert.match(edited, /- V helped with the fence\./);
  await bench.editor.reset('river-ward', ['rules']);
  assert.doesNotMatch(systemHead({persona: bench.personas.persona('river-ward')}), /Never swear/);
  assert.match(systemHead({persona: bench.personas.persona('river-ward')}), /V helped with the fence/);
  const reset = await bench.editor.reset('river-ward');
  assert.equal(systemHead({persona: bench.personas.persona('river-ward')}), shipped);
  assert.deepEqual(reset.edited, {bio: false, style: false, rules: false, examples: false, memories: false});
  assert.deepEqual(bench.overrides.keys(), []);
  assert.deepEqual(await readdir(join(bench.dir, 'character-overrides')), [], 'reset removes the file');
});

test('an edit is stored apart from the shipped data, in character-overrides/<key>.json, with only the changed fields', async t => {
  const bench = await workbench(); t.after(bench.done);
  await bench.editor.save('panam-palmer', {style: 'Blunt and fast.'});
  const file = JSON.parse(await readFile(join(bench.dir, 'character-overrides', 'panam-palmer.json'), 'utf8'));
  assert.deepEqual(Object.keys(file).sort(), ['key', 'style', 'updated', 'version']);
  assert.equal(file.style, 'Blunt and fast.');
});

test('validation errors are 422 with codes, store nothing, and unknown characters are 404', async t => {
  const bench = await workbench(); t.after(bench.done);
  await assert.rejects(bench.editor.save('judy-alvarez', {rules: Array.from({length: 11}, (_, i) => `rule ${i}`)}),
    error => error.status === 422 && error.errors[0].code === 'rules-many' && error.errors[0].max === EDIT_LIMITS.rules);
  assert.deepEqual(bench.overrides.keys(), []);
  for (const key of ['nobody', '../judy-alvarez', '', 'Judy Alvarez']) {
    assert.throws(() => bench.editor.details(key), {status: 404});
    await assert.rejects(bench.editor.save(key, {style: 'x'}), {status: 404});
  }
  await assert.rejects(bench.editor.reset('judy-alvarez', ['shoes']), {status: 400});
  await assert.rejects(bench.editor.reset('judy-alvarez', 'bio'), {status: 400});
});

test('memories picked up in talks can be changed and deleted, the summary can be edited and cleared, and everyday people have none', async t => {
  const bench = await workbench(); t.after(bench.done);
  const before = bench.editor.details('judy-alvarez').memory;
  assert.equal(before.available, true);
  assert.equal(before.learns, false);
  assert.equal(before.summary, 'V asked me about the clinic.');
  assert.deepEqual(before.records.map(record => record.id), ['b', 'a']);
  const edited = bench.editor.editRecord('judy-alvarez', 'a', '  V likes   rye whiskey.  ');
  assert.equal(edited.memory.records.find(record => record.id === 'a').text, 'V likes rye whiskey.');
  assert.equal(edited.memory.records.find(record => record.id === 'a').pinned, true, 'an edited memory is kept as the player wrote it');
  assert.throws(() => bench.editor.editRecord('judy-alvarez', 'a', '   '), {status: 422});
  assert.throws(() => bench.editor.editRecord('judy-alvarez', 'zzz', 'x'), {status: 404});
  assert.equal(bench.editor.deleteRecord('judy-alvarez', 'b').memory.records.length, 1);
  assert.throws(() => bench.editor.deleteRecord('judy-alvarez', 'b'), {status: 404});
  assert.equal(bench.editor.setSummary('judy-alvarez', 'V is the one who asked about the clinic.').memory.summary, 'V is the one who asked about the clinic.');
  assert.equal(bench.editor.setSummary('judy-alvarez', '').memory.summary, '');
  await bench.memory.flush();
  const stored = JSON.parse(await readFile(join(bench.dir, 'local-memory', 'player', 'judy-alvarez.json'), 'utf8'));
  assert.deepEqual(stored.records.map(record => [record.id, record.text, record.pinned]), [['a', 'V likes rye whiskey.', true]]);
  assert.equal(stored.summary, '');
  const vendor = bench.editor.details('npc-food-vendor-male');
  assert.equal(vendor.memory.available, false);
  assert.throws(() => bench.editor.deleteRecord('npc-food-vendor-male', 'a'), {status: 404});
  assert.throws(() => bench.editor.setSummary('npc-food-vendor-male', 'x'), {status: 404});
});

// ---- the server

test('the server listens on loopback only, gives a random per-session address, and closes cleanly', async t => {
  const bench = await workbench(); t.after(bench.done);
  assert.equal(bench.server.running, false);
  assert.equal(bench.server.url, null);
  const url = await bench.server.start();
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, '/editor');
  assert.match(parsed.searchParams.get('t'), /^[A-Za-z0-9_-]{32}$/);
  assert.equal(bench.server.server.address().address, '127.0.0.1');
  assert.equal(await bench.server.start(), url, 'starting again keeps the same address');
  await bench.server.stop();
  assert.equal(bench.server.running, false);
  await assert.rejects(call({url, token: 'x'}, 'GET', '/api/state'), /ECONNREFUSED/);
  const second = await bench.server.start();
  assert.notEqual(new URL(second).searchParams.get('t'), parsed.searchParams.get('t'), 'a new session has a new code');
});

test('the page needs the session code; the API needs it in a header; a wrong Host, Origin or content type is refused', async t => {
  const bench = await workbench(); t.after(bench.done);
  await bench.server.start();
  const page = new URL(bench.server.url);
  const get = (path, options) => call(bench.server, 'GET', path, {token: false, ...options});
  assert.equal((await get('/editor')).status, 404);
  assert.equal((await get('/editor?t=wrong')).status, 404);
  assert.equal((await get('/editor?t=' + page.searchParams.get('t'))).status, 200);
  assert.equal((await get('/editor?t=' + page.searchParams.get('t'), {host: 'evil.example:80'})).status, 403);
  assert.equal((await get('/editor?t=' + page.searchParams.get('t'), {host: `localhost:${page.port}`})).status, 403, 'only the exact loopback address and port');
  assert.equal((await get('/api/state')).status, 401);
  assert.equal((await get('/api/state', {headers: {'X-Editor-Token': 'wrong'}})).status, 401);
  assert.equal((await get('/api/state', {headers: {'X-Editor-Token': bench.server.token + 'x'}})).status, 401);
  assert.equal((await call(bench.server, 'GET', '/api/state', {host: 'evil.example'})).status, 403);
  assert.equal((await call(bench.server, 'GET', '/api/state', {headers: {Origin: 'http://evil.example'}})).status, 403);
  assert.equal((await call(bench.server, 'GET', '/api/state', {headers: {Origin: `http://127.0.0.1:${page.port}`}})).status, 200);
  assert.equal((await call(bench.server, 'PUT', '/api/character/judy-alvarez', {raw: '{"style":"x"}', headers: {'Content-Type': 'text/plain'}})).status, 415);
  assert.equal((await call(bench.server, 'PUT', '/api/character/judy-alvarez', {raw: '{broken'})).status, 400);
  assert.equal((await call(bench.server, 'PUT', '/api/character/judy-alvarez', {raw: JSON.stringify({style: 'x'.repeat(200 * 1024)})})).status, 413);
  assert.equal((await get('/elsewhere')).status, 404);
  assert.equal((await call(bench.server, 'GET', '/api/nothing')).status, 404);
  assert.deepEqual(bench.overrides.keys(), [], 'nothing refused changed anything');
});

test('the page runs under a policy that allows only itself, and contains no outside address', async t => {
  const bench = await workbench(); t.after(bench.done);
  await bench.server.start();
  const reply = await call(bench.server, 'GET', '/editor?t=' + bench.server.token, {token: false});
  const policy = reply.headers['content-security-policy'];
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /media-src blob:(?:;|$)/, 'audio may only play from addresses the page made itself');
  assert.equal(policy, `default-src 'none'; script-src 'nonce-${nonce0(policy)}'; style-src 'nonce-${nonce0(policy)}'; connect-src 'self'; media-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, 'nothing else was opened up');
  assert.match(policy, /script-src 'nonce-[A-Za-z0-9_-]+'/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|https?:|\*/);
  assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(reply.headers['referrer-policy'], 'no-referrer');
  assert.match(reply.headers['content-type'], /^text\/html/);
  const nonce = /nonce-([A-Za-z0-9_-]+)/.exec(policy)[1];
  assert.equal(reply.text.split(`nonce="${nonce}"`).length - 1, 2, 'exactly one script and one style carry the nonce');
  // (createObjectURL and revokeObjectURL make and release the addresses of the audio the page plays: nothing is loaded from a url() either)
  assert.doesNotMatch(reply.text, /<(?:link|img|iframe|object|embed|form)\b|\bsrc=|@import|(?<!Object)url\(/i, 'nothing is loaded from anywhere');
  assert.doesNotMatch(reply.text.replace(/http:\/\/127\.0\.0\.1/g, ''), /https?:\/\//, 'no outside address anywhere in the page');
  const other = await call(bench.server, 'GET', '/editor?t=' + bench.server.token, {token: false});
  assert.notEqual(/nonce-([A-Za-z0-9_-]+)/.exec(other.headers['content-security-policy'])[1], nonce, 'a fresh nonce for every page');
});

test('the page cannot be turned into script by a language code, and its boot data cannot close the script tag', () => {
  const html = renderEditorPage({nonce: 'n', token: '</script><script>alert(1)</script>', language: '"><script>alert(2)</script>'});
  assert.match(html, /<html lang="en">/);
  assert.equal(html.split('</script>').length - 1, 1, 'only the real closing tag');
  assert.doesNotMatch(html, /alert\(2\)/);
});

test('routes: state, one character, save, reset, summary, memory edit and delete, close', async t => {
  const bench = await workbench(); t.after(bench.done);
  await bench.server.start({strings: {Save: 'Speichern', 'Not a source': 'ok', bad: 7, '': 'x'}, language: 'de'});
  const state = await call(bench.server, 'GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.provider, 'local');
  assert.equal(state.json.language, 'de');
  assert.deepEqual(state.json.strings, {Save: 'Speichern', 'Not a source': 'ok'});
  assert.equal(state.json.characters.length, rows.length);
  assert.equal(state.json.limits.bio, EDIT_LIMITS.bio);
  assert.equal(state.json.limits.record, 220);
  bench.state.route = 'convai';
  assert.equal((await call(bench.server, 'GET', '/api/state')).json.provider, 'convai', 'the page can say Convai is answering');

  const one = await call(bench.server, 'GET', '/api/character/judy-alvarez');
  assert.equal(one.json.name, 'Judy Alvarez');
  assert.equal((await call(bench.server, 'GET', '/api/character/nobody')).status, 404);
  assert.equal((await call(bench.server, 'GET', '/api/character/..%2Fsecret')).status, 404);
  assert.equal((await call(bench.server, 'GET', '/api/character/%E0%A4%A')).status, 400);

  const saved = await call(bench.server, 'PUT', '/api/character/judy-alvarez', {body: {rules: ['Never swear.'], style: 'Calm.'}});
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.edited, {bio: false, style: true, rules: true, examples: false, memories: false});
  assert.deepEqual([...bench.overrides.get('judy-alvarez').rules], ['Never swear.']);
  const refused = await call(bench.server, 'PUT', '/api/character/judy-alvarez', {body: {bio: 'short'}});
  assert.equal(refused.status, 422);
  assert.deepEqual(refused.json, {error: 'invalid', errors: [{field: 'bio', code: 'bio-short', max: EDIT_LIMITS.bioMin}]});
  assert.equal((await call(bench.server, 'PUT', '/api/character/judy-alvarez', {body: {memories: ['m'.repeat(201)]}})).json.errors[0].code, 'memories-long');

  const reset = await call(bench.server, 'POST', '/api/character/judy-alvarez/reset', {body: {fields: ['rules']}});
  assert.deepEqual(reset.json.edited, {bio: false, style: true, rules: false, examples: false, memories: false});
  assert.equal((await call(bench.server, 'POST', '/api/character/judy-alvarez/reset', {body: {fields: ['shoes']}})).status, 400);
  assert.equal((await call(bench.server, 'POST', '/api/character/judy-alvarez/reset', {body: {}})).json.edited.style, false, 'no fields means all of them');

  assert.equal((await call(bench.server, 'PUT', '/api/character/judy-alvarez/summary', {body: {text: 'Short.'}})).json.memory.summary, 'Short.');
  assert.equal((await call(bench.server, 'PUT', '/api/character/judy-alvarez/summary', {body: {text: 7}})).status, 400);
  const changed = await call(bench.server, 'PUT', '/api/character/judy-alvarez/memory/a', {body: {text: 'V likes rye.'}});
  assert.equal(changed.json.memory.records.find(record => record.id === 'a').text, 'V likes rye.');
  assert.equal((await call(bench.server, 'PUT', '/api/character/judy-alvarez/memory/a', {body: {text: ' '}})).status, 422);
  assert.equal((await call(bench.server, 'DELETE', '/api/character/judy-alvarez/memory/b')).json.memory.records.length, 1);
  assert.equal((await call(bench.server, 'DELETE', '/api/character/judy-alvarez/memory/b')).status, 404);
  assert.equal((await call(bench.server, 'DELETE', '/api/character/judy-alvarez')).status, 404);
  assert.equal((await call(bench.server, 'GET', '/api/character/judy-alvarez/anything')).status, 404);

  assert.equal((await call(bench.server, 'POST', '/api/close', {body: {}})).status, 200);
  await new Promise(done => setTimeout(done, 400));
  assert.equal(bench.server.running, false, 'the Close button stops the server');
});

test('a quiet server closes itself, and every request pushes the deadline back', async t => {
  const bench = await workbench(); t.after(bench.done);
  const timers = [];
  const server = new EditorServer({editor: bench.editor, idleMs: 1000, setTimer: (fn, ms) => { const timer = {fn, ms, unref() {}}; timers.push(timer); return timer; }, clearTimer: timer => { timer.cleared = true; }});
  await server.start();
  const first = timers.at(-1);
  assert.equal(first.ms, 1000);
  await call(server, 'GET', '/api/state');
  const second = timers.at(-1);
  assert.notEqual(second, first);
  assert.equal(first.cleared, true);
  await call(server, 'GET', '/api/state', {token: false}); // refused: it must not keep the server alive
  assert.equal(timers.at(-1), second);
  second.fn();
  await new Promise(done => setTimeout(done, 50));
  assert.equal(server.running, false);
  assert.equal(server.idle, null);
});

test('translations from the game are plain strings, bounded', () => {
  assert.deepEqual(cleanStrings(null), {});
  assert.deepEqual(cleanStrings([1, 2]), {});
  assert.deepEqual(cleanStrings({a: 'b', c: 3, d: '  ', e: 'x'.repeat(1300), ['k'.repeat(401)]: 'v'}), {a: 'b'});
  const many = Object.fromEntries(Array.from({length: 500}, (_, i) => [`s${i}`, 'v']));
  assert.equal(Object.keys(cleanStrings(many)).length, 400);
});

// ---- the settings button (file IPC)

test('a command is accepted only when it is a fresh, well formed Open', () => {
  const now = 1_700_000_000_000;
  const valid = {version: 1, id: 'e1700000000-1', action: 'open', issuedAt: now - 1000, language: 'fr', strings: {Save: 'Enregistrer', bad: 3}};
  assert.deepEqual(parseEditorCommand(JSON.stringify(valid), now), {id: 'e1700000000-1', action: 'open', language: 'fr', strings: {Save: 'Enregistrer'}, facing: null});
  // The character V faced when the player chose Open: plain short text, or nothing.
  const facing = parseEditorCommand(JSON.stringify({...valid, facing: {record: 'Character.Rebecca', name: '  Rebecca  ', gender: 'FEMALE', extra: 'x'}}), now).facing;
  assert.deepEqual(facing, {record: 'Character.Rebecca', name: 'Rebecca', gender: 'female'});
  assert.deepEqual(parseEditorCommand(JSON.stringify({...valid, facing: {record: 'has a space!', name: '', gender: 'robot'}}), now).facing, null);
  assert.deepEqual(parseEditorCommand(JSON.stringify({...valid, facing: {name: 'N'.repeat(200)}}), now).facing, {record: '', name: 'N'.repeat(60), gender: ''});
  for (const bad of [7, 'Rebecca', [], null]) assert.equal(parseEditorCommand(JSON.stringify({...valid, facing: bad}), now).facing, null);
  for (const change of [{version: 2}, {id: 'bad id'}, {id: 7}, {action: 'copy'}, {action: 'delete'}, {issuedAt: now - 31_000}, {issuedAt: now + 6000}, {issuedAt: 'now'}])
    assert.equal(parseEditorCommand(JSON.stringify({...valid, ...change}), now), null, JSON.stringify(change));
  assert.equal(parseEditorCommand('', now), null);
  assert.equal(parseEditorCommand('{broken', now), null);
  assert.equal(parseEditorCommand('null', now), null);
  assert.equal(parseEditorCommand(JSON.stringify({...valid, strings: {x: 'y'.repeat(200 * 1024)}}), now), null);
});

test('Open starts the server, opens the page once, and answers in the status file; old and repeated commands do nothing', async t => {
  const bench = await workbench(); t.after(bench.done);
  const commandPath = join(bench.dir, 'editor-command.json'), statusPath = join(bench.dir, 'editor-status.json');
  let clock = 1_700_000_000_000;
  const opened = [];
  const command = (id, extra = {}) => JSON.stringify({version: 1, id, action: 'open', issuedAt: clock, language: 'de', strings: {Save: 'Speichern'}, ...extra});
  await writeFile(commandPath, command('left-over'));
  const control = await EditorControl.open({server: bench.server, commandPath, statusPath, now: () => clock, open: async url => { opened.push(url); }});
  await control.poll();
  assert.deepEqual(opened, [], 'a command from an earlier session is never replayed');
  assert.equal(bench.server.running, false, 'nothing is served until the player asks');
  await control.poll();
  await writeFile(commandPath, command('e1'));
  await control.poll();
  assert.equal(opened.length, 1);
  assert.equal(opened[0], bench.server.url);
  assert.equal(bench.server.language, 'de');
  assert.deepEqual(bench.server.strings, {Save: 'Speichern'});
  assert.deepEqual({...JSON.parse(await readFile(statusPath, 'utf8'))}, {version: 1, id: 'e1', state: 'open', updated: clock});
  await control.poll();
  await writeFile(commandPath, command('e1') + ' ');
  await control.poll();
  assert.equal(opened.length, 1, 'the same command is not run twice');
  await writeFile(commandPath, command('e2', {issuedAt: clock - 60_000}));
  await control.poll();
  assert.equal(opened.length, 1, 'a stale command is ignored');
  await writeFile(commandPath, command('e3'));
  await control.poll();
  assert.equal(opened.length, 2);
  assert.equal(opened[1], opened[0], 'a second click reopens the same page while it is open');
  await control.close();
  assert.equal(bench.server.running, false);
});

test('a browser that cannot be opened is reported as failed, and the page stays reachable until it times out', async t => {
  const bench = await workbench(); t.after(bench.done);
  const commandPath = join(bench.dir, 'editor-command.json'), statusPath = join(bench.dir, 'editor-status.json');
  const logged = [];
  const control = await EditorControl.open({server: bench.server, commandPath, statusPath, now: () => 1_700_000_000_000, log: message => logged.push(message),
    open: async () => { throw Object.assign(Error('no browser'), {code: 'ENOENT'}); }});
  await writeFile(commandPath, JSON.stringify({version: 1, id: 'e1', action: 'open', issuedAt: 1_700_000_000_000}));
  await control.poll();
  assert.equal(JSON.parse(await readFile(statusPath, 'utf8')).state, 'failed');
  assert.match(logged.join('\n'), /ENOENT/);
  await control.close();
});

// ---- the characters the player makes (docs/CHARACTER_EDITOR.md, "Your own characters")

const BIO = 'I am Rebecca, a small, loud, trigger-happy runner who grew up in Pacifica and still thinks every plan needs more explosions. I trust few people.';
const input = (extra = {}) => ({name: 'Rebecca', gender: 'female', records: ['Character.Rebecca'], names: ['Rebecca'], bio: BIO, style: 'Fast, loud.',
  examples: ['Boom. That is how I solve it.'], memories: ['V once lent me a gun.'], ...extra});
// ---- voice clips (docs/CHARACTER_EDITOR.md, "Voice clips"): a story character's or one of the player's own, kept in state/player-voices/
const WORDS = 'Hello there, this is me talking.';
const words = text => Buffer.from(text, 'utf8').toString('base64url');
const put = (bench, key, bytes, headers = {}, type = 'audio/wav') => call(bench.server, 'PUT', `/api/voice/${key}`, {raw: bytes, headers: {'Content-Type': type, 'X-Voice-Text': words(WORDS), ...headers}});
const clipFiles = bench => readdir(join(bench.dir, 'state', 'player-voices')).catch(() => []);

test('the state, the catalogue and the details say which characters may have a clip, and what speaks until they do', async t => {
  const bench = await workbench({custom: true, voices: true}); t.after(bench.done);
  assert.deepEqual(bench.editor.state().voice, {minSeconds: 5, maxSeconds: 20, goodMin: 10, goodMax: 18, transcript: 600, transcriptMin: 8, maxUploadBytes: 16 * 1024 * 1024,
    formats: ['wav', 'mp3', 'ogg', 'flac'], convertRate: 24000});
  const made = await bench.editor.createCustom(input());
  assert.deepEqual(made.voice, {clip: null, transcript: '', fallback: 'generic'}, 'a character of the player\'s own falls back to a generic voice of its gender');
  assert.deepEqual(bench.editor.details('judy-alvarez').voice, {clip: null, transcript: '', fallback: 'shipped'}, 'a story character keeps its shipped voice');
  assert.equal(bench.editor.details('npc-food-vendor-male').voice, null, 'everyday people have no voice section');
  const flags = () => Object.fromEntries(bench.editor.catalog().filter(item => ['judy-alvarez', made.key].includes(item.key)).map(item => [item.key, item.voice]));
  assert.deepEqual(flags(), {'judy-alvarez': false, [made.key]: false});
  const saved = await bench.editor.setVoice('judy-alvarez', speechWav({seconds: 12}), WORDS);
  assert.deepEqual(saved.voice.clip, {seconds: 12, rate: 24000, updated: saved.voice.clip.updated});
  assert.equal(typeof saved.voice.clip.updated, 'number');
  assert.equal(saved.voice.transcript, WORDS);
  assert.deepEqual(saved.clip, {seconds: 12, rate: 24000, notes: [], format: 'wav'});
  assert.equal(saved.name, 'Judy Alvarez', 'the reply is the character\'s details with the clip\'s own facts beside them');
  assert.equal(bench.editor.details('judy-alvarez').voice.clip.seconds, 12);
  assert.deepEqual(flags(), {'judy-alvarez': true, [made.key]: false});
  const own = await bench.editor.setVoice(made.key, speechWav({seconds: 7}), WORDS);
  assert.deepEqual(own.clip.notes, ['short']);
  assert.equal(own.group, 'custom');
  assert.equal(own.custom.voice, undefined, 'the clip is not part of the character\'s text');
  assert.deepEqual(flags(), {'judy-alvarez': true, [made.key]: true});
  assert.equal((await bench.editor.saveCustom(made.key, input({bio: BIO + ' More.'}))).voice.clip.seconds, 7, 'saving the text leaves the clip');
  // Without the store nothing offers a clip.
  const none = await workbench({custom: true}); t.after(none.done);
  assert.equal(none.editor.state().voice, null);
  assert.equal(none.editor.details('judy-alvarez').voice, null);
  await assert.rejects(none.editor.setVoice('judy-alvarez', speechWav(), WORDS), {status: 404});
  await assert.rejects(none.editor.voiceAudio('judy-alvarez'), {status: 404});
});

test('the words, the clip and the limits come back as codes the page turns into sentences, and a clip is changed, kept or removed as asked', async t => {
  const bench = await workbench({custom: true, voices: true, voiceOptions: {limits: {clips: 2}, prepare: bytes => prepareUpload(bytes, {ffmpeg: null})}}); t.after(bench.done);
  const why = async (key, bytes, text) => { try { await bench.editor.setVoice(key, bytes, text); return null; } catch (error) { assert.equal(error.status, 422, error.message); return error.errors; } };
  assert.deepEqual(await why('judy-alvarez', speechWav(), null), [{field: 'voiceText', code: 'voice-text-short', min: 8}], 'a first clip needs its words');
  assert.deepEqual(await why('judy-alvarez', speechWav(), 'x'.repeat(601)), [{field: 'voiceText', code: 'voice-text-long', max: 600}]);
  assert.deepEqual(await why('judy-alvarez', speechWav({seconds: 3}), WORDS), [{field: 'voice', code: 'clip-short', min: 5}]);
  assert.deepEqual(await why('judy-alvarez', speechWav({seconds: 25}), WORDS), [{field: 'voice', code: 'clip-long', max: 20}]);
  assert.deepEqual(await why('judy-alvarez', Buffer.from('this is not a recording, but it is long enough to be read as a file of some kind'), WORDS), [{field: 'voice', code: 'clip-format'}]);
  assert.deepEqual(await why('judy-alvarez', speechWav({silent: true}), WORDS), [{field: 'voice', code: 'clip-silent'}]);
  assert.deepEqual(await why('judy-alvarez', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(300)]), WORDS), [{field: 'voice', code: 'clip-needs-wav'}], 'an MP3 needs a converter this computer does not have');
  assert.equal(bench.voices.size, 0, 'nothing refused was kept');
  await bench.editor.setVoice('judy-alvarez', speechWav(), WORDS);
  // Words only: the clip stays; too short or too long words are refused; a non-string is a bad request.
  const sha = bench.voices.get('judy-alvarez').sha256;
  assert.equal((await bench.editor.setVoiceText('judy-alvarez', '  New   words,\nspoken clearly.  ')).voice.transcript, 'New words, spoken clearly.');
  assert.equal(bench.voices.get('judy-alvarez').sha256, sha);
  await assert.rejects(bench.editor.setVoiceText('judy-alvarez', 'short'), error => error.status === 422 && error.errors[0].code === 'voice-text-short' && error.errors[0].min === 8);
  await assert.rejects(bench.editor.setVoiceText('judy-alvarez', 7), {status: 400});
  await assert.rejects(bench.editor.setVoiceText('panam-palmer', 'Words without any clip to go with them.'), {status: 404});
  // A new file with no words keeps the words that are stored (the page always sends them, a script may not).
  const again = await bench.editor.setVoice('judy-alvarez', speechWav({seconds: 19.5}), null);
  assert.deepEqual([again.clip.notes, again.voice.transcript], [['long'], 'New words, spoken clearly.']);
  await assert.rejects(bench.editor.setVoice('judy-alvarez', speechWav(), 7), {status: 400});
  // Only as many clips as the store keeps (a replacement is not a new clip).
  await bench.editor.setVoice('panam-palmer', speechWav(), WORDS);
  assert.deepEqual(await why('river-ward', speechWav(), WORDS), [{field: 'voice', code: 'clips-full', max: 2}]);
  assert.equal((await bench.editor.setVoice('panam-palmer', speechWav({seconds: 14}), WORDS)).voice.clip.seconds, 14);
  // Audio and removal.
  assert.deepEqual(await bench.editor.voiceAudio('judy-alvarez'), await bench.voices.audio('judy-alvarez'));
  await assert.rejects(bench.editor.voiceAudio('river-ward'), {status: 404});
  assert.deepEqual((await bench.editor.clearVoice('judy-alvarez')).voice, {clip: null, transcript: '', fallback: 'shipped'});
  assert.deepEqual((await bench.editor.clearVoice('judy-alvarez')).voice.clip, null, 'removing none is not an error');
  await assert.rejects(bench.editor.voiceAudio('judy-alvarez'), {status: 404});
  // Who may have a clip: story characters and the player\'s own, nobody else.
  const made = await bench.editor.createCustom(input());
  for (const key of ['npc-food-vendor-male', 'nobody', '../judy-alvarez', '', 'Judy Alvarez', 'custom-ghost-abcd', 'constructor']) {
    await assert.rejects(bench.editor.setVoice(key, speechWav(), WORDS), {status: 404}, key);
    await assert.rejects(bench.editor.setVoiceText(key, WORDS), {status: 404}, key);
    await assert.rejects(bench.editor.clearVoice(key), {status: 404}, key);
    await assert.rejects(bench.editor.voiceAudio(key), {status: 404}, key);
  }
  assert.equal((await bench.editor.setVoice(made.key, speechWav(), WORDS)).voice.fallback, 'generic');
  assert.equal(bench.voices.size, 2);
});

test('a voice clip goes through the server: the file is the body, the words are in a header, and nothing is kept unless both are right', async t => {
  const bench = await workbench({voices: true}); t.after(bench.done);
  await bench.server.start();
  const key = 'judy-alvarez';
  assert.equal((await call(bench.server, 'GET', '/api/state')).json.voice.convertRate, 24000);
  // Wrong kind of request.
  assert.equal((await put(bench, key, speechWav(), {}, 'application/json')).status, 415);
  assert.equal((await put(bench, key, speechWav(), {}, 'text/plain')).status, 415);
  assert.equal((await put(bench, key, speechWav(), {}, 'audio/aac')).status, 415);
  for (const type of ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/flac', 'audio/x-flac', 'application/octet-stream', 'audio/wav; charset=binary'])
    assert.notEqual((await put(bench, key, Buffer.from('not audio, but a type the page may send for a file it could not decode'), {}, type)).status, 415, type);
  assert.equal((await put(bench, key, speechWav(), {}, 'audio/wav')).status, 200, 'a good one passes the same gate');
  await bench.voices.clear(key);
  // The words header: absent keeps the words (none yet: refused), malformed is 400, valid non-ASCII text survives.
  assert.deepEqual((await call(bench.server, 'PUT', `/api/voice/${key}`, {raw: speechWav(), headers: {'Content-Type': 'audio/wav'}})).json, {error: 'invalid', errors: [{field: 'voiceText', code: 'voice-text-short', min: 8}]});
  for (const bad of ['not base64!', '%%%%', 'A', '====', words(WORDS) + '!', Buffer.from([0xff, 0xfe, 0xfd, 0xfc]).toString('base64url'), 'A'.repeat(4100), 'AAAA AAAA'])
    assert.equal((await put(bench, key, speechWav(), {'X-Voice-Text': bad})).status, 400, bad.slice(0, 20));
  assert.equal((await put(bench, key, speechWav(), {'X-Voice-Text': words('x'.repeat(601))})).json.errors[0].code, 'voice-text-long');
  assert.equal((await put(bench, key, speechWav(), {'X-Voice-Text': words('')})).json.errors[0].code, 'voice-text-short');
  // The recording itself.
  const bad = await put(bench, key, Buffer.from('this is not a recording, but it is long enough to be read as a file of some kind'));
  assert.deepEqual([bad.status, bad.json], [422, {error: 'invalid', errors: [{field: 'voice', code: 'clip-format'}]}]);
  assert.equal((await put(bench, key, speechWav({seconds: 3}))).json.errors[0].code, 'clip-short');
  assert.deepEqual((await put(bench, key, speechWav({seconds: 25}))).json.errors, [{field: 'voice', code: 'clip-long', max: 20}]);
  assert.equal((await put(bench, key, speechWav({level: 0.004}))).json.errors[0].code, 'clip-quiet');
  assert.equal((await put(bench, key, speechWav({seconds: 12}), {}, 'application/octet-stream')).status, 200, 'the bytes decide what a file is, not its type');
  await bench.voices.clear(key);
  assert.equal(bench.voices.size, 0, 'nothing refused was kept');
  assert.deepEqual(await clipFiles(bench), []);
  // A good one, with words that are not ASCII.
  const spoken = 'Écoute-moi, choom: ça va très bien — vraiment ✓.';
  const done = await put(bench, key, speechWav({seconds: 11, rate: 22050}), {'X-Voice-Text': words(spoken)});
  assert.equal(done.status, 200);
  assert.deepEqual(done.json.clip, {seconds: 11, rate: 22050, notes: [], format: 'wav'});
  assert.deepEqual(done.json.voice, {clip: {seconds: 11, rate: 22050, updated: done.json.voice.clip.updated}, transcript: spoken, fallback: 'shipped'});
  assert.equal(done.json.name, 'Judy Alvarez');
  assert.deepEqual(await clipFiles(bench), [`${key}.wav`]);
  assert.equal(bench.voices.get(key).transcript, spoken);
  assert.equal((await call(bench.server, 'GET', '/api/state')).json.characters.find(item => item.key === key).voice, true);
  assert.equal((await call(bench.server, 'GET', `/api/character/${key}`)).json.voice.clip.seconds, 11);
  // Only the words.
  const stored = (await call(bench.server, 'GET', `/api/voice/${key}/audio`)).bytes;
  const edit = await call(bench.server, 'PUT', `/api/voice/${key}/text`, {body: {text: 'Other words, said the same way.'}});
  assert.deepEqual([edit.status, edit.json.voice.transcript, edit.json.voice.clip.seconds], [200, 'Other words, said the same way.', 11]);
  assert.deepEqual((await call(bench.server, 'GET', `/api/voice/${key}/audio`)).bytes, stored, 'the clip itself did not change');
  assert.deepEqual((await call(bench.server, 'PUT', `/api/voice/${key}/text`, {body: {text: 'short'}})).json, {error: 'invalid', errors: [{field: 'voiceText', code: 'voice-text-short', min: 8}]});
  assert.deepEqual((await call(bench.server, 'PUT', `/api/voice/${key}/text`, {body: {text: 'x'.repeat(601)}})).json.errors, [{field: 'voiceText', code: 'voice-text-long', max: 600}]);
  assert.equal((await call(bench.server, 'PUT', `/api/voice/${key}/text`, {body: {text: 7}})).status, 400);
  assert.equal((await call(bench.server, 'PUT', `/api/voice/${key}/text`, {raw: '{broken'})).status, 400);
  assert.equal((await call(bench.server, 'PUT', `/api/voice/${key}/text`, {raw: '{"text":"Words that are long enough."}', headers: {'Content-Type': 'text/plain'}})).status, 415);
  assert.equal((await call(bench.server, 'PUT', '/api/voice/panam-palmer/text', {body: {text: 'Words but no clip to put them with.'}})).status, 404, 'words alone do not make a clip');
  assert.equal(bench.voices.has('panam-palmer'), false);
  // A note for a short clip; no words header keeps the stored words.
  const short = await call(bench.server, 'PUT', `/api/voice/${key}`, {raw: speechWav({seconds: 7}), headers: {'Content-Type': 'audio/wav'}});
  assert.deepEqual([short.status, short.json.clip.notes, short.json.voice.transcript], [200, ['short'], 'Other words, said the same way.']);
  // Remove it.
  const removed = await call(bench.server, 'DELETE', `/api/voice/${key}`);
  assert.deepEqual([removed.status, removed.json.voice.clip], [200, null]);
  assert.deepEqual(await clipFiles(bench), []);
  assert.equal((await call(bench.server, 'GET', `/api/voice/${key}/audio`)).status, 404, 'no clip, no audio');
  assert.equal((await call(bench.server, 'DELETE', `/api/voice/${key}`)).status, 200, 'removing a second time is not an error');
});

test('V has two voice-only rows: a clip under v-male or v-female works through the editor and the server, and nothing else about V can be edited', async t => {
  const bench = await workbench({custom: true, voices: true}); t.after(bench.done);
  await bench.server.start();
  // The keys are the ones V's typed lines are spoken with.
  const {V_VOICE_KEYS} = await import('./v-voice.mjs');
  assert.deepEqual([...V_EDITOR_KEYS], [V_VOICE_KEYS.male, V_VOICE_KEYS.female]);
  const list = bench.editor.catalog(), v = list.filter(item => item.group === 'v');
  assert.deepEqual(v, [{key: 'v-female', name: 'V (female voice)', group: 'v', edited: false, voiceOnly: true, voice: false},
    {key: 'v-male', name: 'V (male voice)', group: 'v', edited: false, voiceOnly: true, voice: false}], 'by name, like every group');
  const first = list.findIndex(item => item.group === 'v'), story = list.findIndex(item => item.group === 'story');
  assert(first >= 0 && first < story && list.slice(first, first + 2).every(item => item.group === 'v'), 'V rows come before the story characters');
  assert.deepEqual(bench.editor.details('v-male'), {key: 'v-male', name: 'V (male voice)', group: 'v', voiceOnly: true, voice: {clip: null, transcript: '', fallback: 'v'}});
  assert.deepEqual((await call(bench.server, 'GET', '/api/character/v-female')).json.voice, {clip: null, transcript: '', fallback: 'v'});
  // A clip: saved, played back, listed as having one, removed (V goes back to the mod's or the shipped voice: the row stays).
  const saved = await put(bench, 'v-male', speechWav({seconds: 12}));
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.json.voice.clip.seconds, saved.json.voice.fallback, saved.json.voiceOnly, saved.json.group], [12, 'v', true, 'v']);
  assert.equal(bench.voices.has('v-male'), true);
  assert.equal((await call(bench.server, 'GET', '/api/state')).json.characters.find(item => item.key === 'v-male').voice, true);
  assert.equal((await call(bench.server, 'GET', '/api/voice/v-male/audio')).status, 200);
  assert.equal((await call(bench.server, 'PUT', '/api/voice/v-male/text', {body: {text: 'Other words, said the same way.'}})).json.voice.transcript, 'Other words, said the same way.');
  const gone = await call(bench.server, 'DELETE', '/api/voice/v-male');
  assert.deepEqual([gone.status, gone.json.voice, gone.json.group], [200, {clip: null, transcript: '', fallback: 'v'}, 'v']);
  assert.equal((await call(bench.server, 'GET', '/api/voice/v-male/audio')).status, 404);
  assert.equal(bench.editor.catalog().find(item => item.key === 'v-male').voice, false);
  // Nothing else of V is editable: no text, no memories, no reset, no custom character route.
  for (const key of ['v-male', 'v-female']) {
    await assert.rejects(bench.editor.save(key, {bio: 'x'.repeat(200)}), {status: 404}, key);
    await assert.rejects(bench.editor.reset(key, null), {status: 404}, key);
    assert.throws(() => bench.editor.setSummary(key, 'text'), {status: 404}, key);
    await assert.rejects(bench.editor.deleteCustom(key), {status: 404}, key);
    assert.equal((await call(bench.server, 'PUT', `/api/character/${key}`, {body: {bio: 'x'}})).status, 404, key);
  }
  // Only these two keys: other near-misses still have no clip.
  for (const key of ['v', 'v-other', 'v-male2', 'V-male']) await assert.rejects(bench.editor.setVoice(key, speechWav(), WORDS), {status: 404}, key);
  // Without a clip store the rows do not exist.
  const none = await workbench(); t.after(none.done);
  assert.equal(none.editor.catalog().some(item => item.group === 'v'), false);
  assert.throws(() => none.editor.details('v-male'), {status: 404});
});

test('the saved clip is played through a route that needs the session code, and the old address of a clip is gone', async t => {
  const bench = await workbench({custom: true, voices: true}); t.after(bench.done);
  await bench.server.start();
  const key = 'panam-palmer';
  const stored = (await put(bench, key, speechWav({seconds: 10}))).json;
  assert.equal(stored.voice.clip.seconds, 10);
  const audio = await call(bench.server, 'GET', `/api/voice/${key}/audio`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers['content-type'], 'audio/wav');
  assert.equal(Number(audio.headers['content-length']), audio.bytes.length);
  assert.deepEqual(audio.bytes, await readFile(join(bench.dir, 'state', 'player-voices', `${key}.wav`)), 'the bytes of the file that was kept');
  assert.deepEqual([audio.bytes.toString('ascii', 0, 4), audio.bytes.toString('ascii', 8, 12)], ['RIFF', 'WAVE']);
  assert.equal(audio.headers['cache-control'], 'no-store');
  assert.equal(audio.headers['x-content-type-options'], 'nosniff');
  assert.equal(audio.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(audio.headers['x-frame-options'], 'DENY');
  // Never without the code: not on the page's address, not without the header, not with a wrong one, not from another site, not by another Host.
  assert.equal((await call(bench.server, 'GET', `/api/voice/${key}/audio`, {token: false})).status, 401);
  assert.equal((await call(bench.server, 'GET', `/api/voice/${key}/audio?t=${bench.server.token}`, {token: false})).status, 401, 'the code in the address is not the header');
  assert.equal((await call(bench.server, 'GET', `/api/voice/${key}/audio`, {token: false, headers: {'X-Editor-Token': bench.server.token + 'x'}})).status, 401);
  for (const [response, name] of [[await call(bench.server, 'GET', `/api/voice/${key}/audio`, {headers: {Origin: 'http://evil.example'}}), 'audio'],
    [await put(bench, key, speechWav(), {Origin: 'http://evil.example'}), 'put'],
    [await call(bench.server, 'PUT', `/api/voice/${key}/text`, {body: {text: 'Words from another site.'}, headers: {Origin: 'http://evil.example'}}), 'text'],
    [await call(bench.server, 'DELETE', `/api/voice/${key}`, {headers: {Origin: 'http://evil.example'}}), 'delete']]) {
    assert.equal(response.status, 403, name);
    assert.equal(response.bytes.includes(Buffer.from('RIFF')), false, name + ': no audio in a refusal');
  }
  assert.equal((await call(bench.server, 'GET', `/api/voice/${key}/audio`, {host: 'evil.example'})).status, 403);
  assert.equal((await call(bench.server, 'GET', `/api/voice/${key}/audio`, {headers: {Origin: `http://127.0.0.1:${new URL(bench.server.url).port}`}})).status, 200, 'the page\'s own origin is fine');
  assert.equal(bench.voices.has(key), true, 'nothing refused removed the clip');
  // The routes of the player\'s own characters are gone; the clip is only at /api/voice.
  const made = (await call(bench.server, 'POST', '/api/custom', {body: input()})).json;
  for (const method of ['PUT', 'DELETE', 'GET']) assert.equal((await call(bench.server, method, `/api/custom/${made.key}/voice`, {raw: method === 'PUT' ? speechWav() : undefined, headers: {'Content-Type': 'audio/wav'}})).status, 404, method);
  // The clip's address is not served as a file either.
  assert.equal((await call(bench.server, 'GET', `/player-voices/${key}.wav`, {token: false})).status, 404);
  assert.equal((await call(bench.server, 'GET', `/voice/${key}/audio`, {token: false})).status, 404);
});

test('only story characters and the player\'s own have a clip: everyday people, unknown and odd keys are 404 on every route', async t => {
  const bench = await workbench({custom: true, voices: true}); t.after(bench.done);
  await bench.server.start();
  const gone = (await call(bench.server, 'POST', '/api/custom', {body: input()})).json;
  await call(bench.server, 'DELETE', `/api/custom/${gone.key}`);
  for (const key of ['npc-food-vendor-male', 'nobody', '..%2Fjudy-alvarez', 'custom-ghost-abcd', 'custom-', 'CUSTOM-A', 'Judy%20Alvarez', gone.key, 'constructor', '__proto__']) {
    const reply = [await put(bench, key, speechWav()), await call(bench.server, 'PUT', `/api/voice/${key}/text`, {body: {text: 'Words that are long enough.'}}),
      await call(bench.server, 'DELETE', `/api/voice/${key}`), await call(bench.server, 'GET', `/api/voice/${key}/audio`)];
    assert.deepEqual(reply.map(item => item.status), [404, 404, 404, 404], key);
  }
  assert.equal((await call(bench.server, 'PUT', '/api/voice/%E0%A4%A', {raw: speechWav(), headers: {'Content-Type': 'audio/wav'}})).status, 400, 'a broken escape in the key');
  for (const [method, path] of [['PUT', '/api/voice'], ['PUT', '/api/voice/'], ['GET', '/api/voice/judy-alvarez'], ['PATCH', '/api/voice/judy-alvarez'], ['GET', '/api/voice/judy-alvarez/text'],
    ['PUT', '/api/voice/judy-alvarez/audio'], ['POST', '/api/voice/judy-alvarez/audio'], ['PUT', '/api/voice/judy-alvarez/other'], ['PUT', '/api/voice/judy-alvarez/text/more']])
    assert.equal((await call(bench.server, method, path, method === 'GET' ? {} : {raw: '{}', headers: {'Content-Type': 'audio/wav'}})).status, 404, method + ' ' + path);
  assert.equal(bench.voices.size, 0);
  // A server whose editor has no clip store has none of these routes working.
  const plain = await workbench(); t.after(plain.done);
  await plain.server.start();
  assert.equal((await put(plain, 'judy-alvarez', speechWav())).status, 404);
  assert.equal((await call(plain.server, 'GET', '/api/voice/judy-alvarez/audio')).status, 404);
  assert.equal((await call(plain.server, 'GET', '/api/state')).json.voice, null);
});

test('a story character and a character of the player\'s own both keep a clip, and each is released with its owner', async t => {
  const bench = await workbench({custom: true, voices: true}); t.after(bench.done);
  await bench.server.start();
  const made = (await call(bench.server, 'POST', '/api/custom', {body: input()})).json;
  assert.deepEqual(made.voice, {clip: null, transcript: '', fallback: 'generic'});
  const own = await put(bench, made.key, speechWav({seconds: 12}));
  assert.equal(own.status, 200);
  assert.deepEqual([own.json.group, own.json.voice.fallback, own.json.voice.clip.seconds], ['custom', 'generic', 12]);
  assert.equal((await put(bench, 'river-ward', speechWav({seconds: 13}))).json.voice.clip.seconds, 13);
  assert.deepEqual((await clipFiles(bench)).sort(), [`${made.key}.wav`, 'river-ward.wav'].sort());
  const flags = (await call(bench.server, 'GET', '/api/state')).json.characters.filter(item => item.voice).map(item => item.key).sort();
  assert.deepEqual(flags, [made.key, 'river-ward'].sort());
  assert.equal((await call(bench.server, 'GET', `/api/voice/${made.key}/audio`)).bytes.length, 44 + 12 * 24000 * 2);
  // Saving the character's text leaves its clip alone; deleting the character takes its route away.
  assert.equal((await call(bench.server, 'PUT', `/api/custom/${made.key}`, {body: input({style: 'Calm.'})})).json.voice.clip.seconds, 12);
  await call(bench.server, 'DELETE', `/api/custom/${made.key}`);
  assert.equal((await call(bench.server, 'GET', `/api/voice/${made.key}/audio`)).status, 404);
  assert.equal((await call(bench.server, 'GET', '/api/voice/river-ward/audio')).status, 200, 'the story character\'s clip is untouched');
});

test('a clip that is too big is read to its end and refused, and a store that is full says how many it keeps', async t => {
  const bench = await workbench({custom: true, voices: true, voiceOptions: {limits: {clips: 1}}}); t.after(bench.done);
  await bench.server.start();
  const answer = await put(bench, 'judy-alvarez', Buffer.alloc(CLIP.maxUploadBytes + 10));
  assert.equal(answer.status, 413);
  assert.deepEqual(answer.json, {error: 'invalid', errors: [{field: 'voice', code: 'clip-big'}]});
  assert.equal((await put(bench, 'judy-alvarez', Buffer.alloc(CLIP.maxUploadBytes))).json.errors[0].code, 'clip-format', 'exactly the limit is read and judged as a recording');
  assert.equal(bench.voices.size, 0);
  assert.equal((await put(bench, 'judy-alvarez', speechWav())).status, 200);
  const full = await put(bench, 'panam-palmer', speechWav());
  assert.deepEqual([full.status, full.json], [422, {error: 'invalid', errors: [{field: 'voice', code: 'clips-full', max: 1}]}]);
  assert.equal((await put(bench, 'judy-alvarez', speechWav({seconds: 9}))).status, 200, 'a new clip for the same character is a replacement');
});

test('the routes of the player\'s own characters need the session code, take only their own keys, and leave the shipped characters alone', async t => {
  const bench = await workbench({custom: true}); t.after(bench.done);
  await bench.server.start({facing: {record: 'Character.Rebecca', name: 'Rebecca', gender: 'female'}});
  assert.equal((await call(bench.server, 'POST', '/api/custom', {body: input(), token: false})).status, 401);
  assert.equal((await call(bench.server, 'POST', '/api/custom', {body: input(), headers: {Origin: 'http://evil.example'}})).status, 403);
  assert.equal((await call(bench.server, 'POST', '/api/custom', {raw: '{broken', headers: {'Content-Type': 'application/json'}})).status, 400);
  const first = await call(bench.server, 'POST', '/api/custom', {body: input()});
  assert.equal(first.status, 200);
  const key = first.json.key;
  assert.equal((await call(bench.server, 'PUT', `/api/custom/${key}`, {body: input({style: 'Calm.'})})).json.custom.style, 'Calm.');
  assert.equal((await call(bench.server, 'PUT', `/api/custom/${key}`, {body: input({gender: 'x'})})).json.errors[0].code, 'gender-bad');
  for (const wrong of ['judy-alvarez', '..%2Fx', 'custom-', 'CUSTOM-A', 'custom-ghost-abcd']) {
    assert.equal((await call(bench.server, 'PUT', `/api/custom/${wrong}`, {body: input()})).status, 404, wrong);
    assert.equal((await call(bench.server, 'DELETE', `/api/custom/${wrong}`)).status, 404, wrong);
  }
  assert.equal((await call(bench.server, 'PATCH', `/api/custom/${key}`, {body: {}})).status, 404);
  assert.equal((await call(bench.server, 'GET', '/api/custom')).status, 404);
  assert.deepEqual((await call(bench.server, 'GET', '/api/facing')).json, {facing: {record: 'Character.Rebecca', name: 'Rebecca', gender: 'female'}});
  // Memory edits work for the player's own characters too.
  bench.memory.setSummary(key, 'Talked about guns.');
  assert.equal((await call(bench.server, 'PUT', `/api/character/${key}/summary`, {body: {text: 'Talked about rain.'}})).json.memory.summary, 'Talked about rain.');
  const gone = await call(bench.server, 'DELETE', `/api/custom/${key}`);
  assert.equal(gone.json.characters.some(item => item.key === key), false);
  assert.equal(JSON.parse(await readFile(join(bench.dir, 'runtime', 'custom-characters.json'), 'utf8')).characters.length, 0, 'the game list follows');
  // A server without the store has none of these routes working.
  const plain = await workbench(); t.after(plain.done);
  await plain.server.start();
  assert.equal((await call(plain.server, 'POST', '/api/custom', {body: input()})).status, 404);
  assert.equal((await call(plain.server, 'GET', '/api/facing')).json.facing, null);
});

test('the facing character is plain short text and goes when the server is started again without one', async t => {
  const bench = await workbench({custom: true}); t.after(bench.done);
  await bench.server.start({facing: {record: 'NCA.Character.Rebecca', name: 'Rebecca', gender: 'Female'}});
  assert.deepEqual((await call(bench.server, 'GET', '/api/facing')).json.facing, {record: 'NCA.Character.Rebecca', name: 'Rebecca', gender: 'female'});
  await bench.server.start({facing: {record: '<script>', name: '<b>x</b>'.repeat(30), gender: 7}});
  assert.equal((await call(bench.server, 'GET', '/api/facing')).json.facing.record, '');
  assert.equal((await call(bench.server, 'GET', '/api/facing')).json.facing.name.length, 60);
  await bench.server.start();
  assert.equal((await call(bench.server, 'GET', '/api/facing')).json.facing, null);
  assert.match(renderEditorPage({nonce: 'n', token: 't'}), /id="new"/);
});

test('Open passes the facing character on, and a newly made character reaches the game\'s list and the persona book in one step', async t => {
  const bench = await workbench({custom: true}); t.after(bench.done);
  const commandPath = join(bench.dir, 'editor-command.json'), statusPath = join(bench.dir, 'editor-status.json');
  const clock = 1_700_000_000_000;
  await writeFile(commandPath, '');
  const control = await EditorControl.open({server: bench.server, commandPath, statusPath, now: () => clock, open: async () => {}});
  await writeFile(commandPath, JSON.stringify({version: 1, id: 'e1', action: 'open', issuedAt: clock, language: 'en', strings: {}, facing: {record: 'Character.Rebecca', name: 'Rebecca', gender: 'female'}}));
  await control.poll();
  assert.deepEqual((await call(bench.server, 'GET', '/api/facing')).json.facing, {record: 'Character.Rebecca', name: 'Rebecca', gender: 'female'});
  const made = (await call(bench.server, 'POST', '/api/custom', {body: input()})).json;
  const game = JSON.parse(await readFile(join(bench.dir, 'runtime', 'custom-characters.json'), 'utf8'));
  assert.deepEqual(game.characters.map(row => [row.key, row.records, row.names, row.gender]), [[made.key, ['Character.Rebecca'], ['Rebecca'], 'female']]);
  assert.equal(bench.personas.has(made.key), true);
});

// ---- every editor save counts from the next turn, with no restart (docs/CHARACTER_EDITOR.md, "What applies when")

test('every kind of save tells the bridge once it reached the store, so a reply prepared before it can be dropped; a hook that fails never fails the save', async t => {
  const bench = await workbench({custom: true}); t.after(bench.done);
  const seen = [];
  bench.editor.onChanged = key => { seen.push(key); };
  await bench.editor.save('river-ward', {style: 'Slow and dry, with a long pause before anything that matters.'});
  await bench.editor.reset('river-ward', ['style']);
  bench.editor.editRecord('judy-alvarez', 'a', 'V likes tea now.');
  bench.editor.deleteRecord('judy-alvarez', 'b');
  bench.editor.setSummary('judy-alvarez', 'V and I talked about the clinic again.');
  const made = await bench.editor.createCustom(input());
  await bench.editor.saveCustom(made.key, input({name: 'Becca', names: ['Becca']}));
  await bench.editor.deleteCustom(made.key);
  assert.deepEqual(seen, ['river-ward', 'river-ward', 'judy-alvarez', 'judy-alvarez', 'judy-alvarez', made.key, made.key, made.key]);
  // Nothing is reported for a change that was refused.
  seen.length = 0;
  await assert.rejects(bench.editor.save('river-ward', {bio: 'too short'}), {status: 422});
  await assert.rejects(bench.editor.saveCustom('custom-nobody-abcd', input()), {status: 404});
  assert.deepEqual(seen, []);
  bench.editor.onChanged = () => { throw Error('hook'); };
  const saved = await bench.editor.save('river-ward', {style: 'Plain.'});
  assert.equal(saved.values.style, 'Plain.');
});

test('a character the player made, renamed and deleted is what the next turn sees, with no reload: the persona, the roster rows and the name lookup follow', async t => {
  const bench = await workbench({custom: true}); t.after(bench.done);
  const roster = [...rows];
  const sync = () => { for (let at = roster.length - 1; at >= 0; at--) if (roster[at]?.kind === 'custom') roster.splice(at, 1); roster.push(...bench.custom.rosterRows()); lookup.reset(); };
  const lookup = rosterLookup(roster);
  assert.equal(lookup('Rebecca'), null);
  const made = await bench.editor.createCustom(input());
  sync();
  assert.equal(bench.personas.persona(made.key).name, 'Rebecca');
  assert.equal(lookup('rebecca').key, made.key);
  await bench.editor.saveCustom(made.key, input({name: 'Becca', names: ['Becca'], bio: BIO.replace('Rebecca', 'Becca'), memories: ['V lent me a gun twice.']}));
  sync();
  const persona = bench.personas.persona(made.key);
  assert.equal(persona.name, 'Becca');
  assert.deepEqual(persona.memories, ['V lent me a gun twice.']);
  assert.match(systemHead({persona}), /V lent me a gun twice/);
  assert.equal(lookup('Rebecca'), null, 'the old name is gone from the lookup');
  assert.equal(lookup('becca').key, made.key);
  assert.deepEqual(JSON.parse(await readFile(join(bench.dir, 'runtime', 'custom-characters.json'), 'utf8')).characters.map(row => row.name), ['Becca'], 'the game\'s list follows at once');
  await bench.editor.deleteCustom(made.key);
  sync();
  assert.equal(bench.personas.has(made.key), false);
  assert.equal(lookup('becca'), null);
  assert.deepEqual(JSON.parse(await readFile(join(bench.dir, 'runtime', 'custom-characters.json'), 'utf8')).characters, []);
});
