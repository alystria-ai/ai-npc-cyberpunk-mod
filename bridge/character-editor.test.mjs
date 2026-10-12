import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CharacterOverrides, EDIT_LIMITS} from './character-overrides.mjs';
import {CharacterEditor} from './character-editor.mjs';
import {EditorServer, cleanStrings} from './character-editor-server.mjs';
import {EditorControl, parseEditorCommand} from './character-editor-control.mjs';
import {renderEditorPage} from './character-editor-page.mjs';
import {MemoryStore} from './memory-store.mjs';
import {PersonaBook, systemHead} from './mistral-prompt.mjs';

const rows = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];

// A whole editor over a temporary state folder: the same files the bridge uses (character-overrides/, local-memory/player/).
async function workbench({route = 'local', seed = true} = {}) {
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
  const personas = new PersonaBook(rows, {overrides});
  const state = {route};
  const editor = new CharacterEditor({personas, overrides, memory, route: () => state.route});
  const server = new EditorServer({editor});
  return {dir, overrides, memory, personas, editor, server, state,
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
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({status: response.statusCode, headers: response.headers, text, json});
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
  assert.match(policy, /script-src 'nonce-[A-Za-z0-9_-]+'/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|https?:|\*/);
  assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(reply.headers['referrer-policy'], 'no-referrer');
  assert.match(reply.headers['content-type'], /^text\/html/);
  const nonce = /nonce-([A-Za-z0-9_-]+)/.exec(policy)[1];
  assert.equal(reply.text.split(`nonce="${nonce}"`).length - 1, 2, 'exactly one script and one style carry the nonce');
  assert.doesNotMatch(reply.text, /<(?:link|img|iframe|object|embed|form)\b|\bsrc=|@import|url\(/i, 'nothing is loaded from anywhere');
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
  assert.deepEqual(parseEditorCommand(JSON.stringify(valid), now), {id: 'e1700000000-1', action: 'open', language: 'fr', strings: {Save: 'Enregistrer'}});
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
