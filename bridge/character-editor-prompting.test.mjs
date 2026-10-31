import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createServer} from 'node:http';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CharacterOverrides} from './character-overrides.mjs';
import {CharacterEditor} from './character-editor.mjs';
import {EditorServer} from './character-editor-server.mjs';
import {parseEditorCommand} from './character-editor-control.mjs';
import {PromptProfiles} from './prompt-profile-store.mjs';
import {PROFILE_LIMITS, PROFILE_FIELDS, customProfileId, defaultProfile, renderRules, renderExamples, renderClosing} from './prompt-profiles.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {TextProviderHost, mistralRoute} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';

// The Prompting part of the character editor (bridge/prompting-editor.mjs and its routes): who may call it, which ids it accepts, what it refuses, and that a saved change
// is in the very next prompt and a reset brings the shipped prompt back byte for byte. The page itself is tested in character-editor-browser.test.mjs.
const rows = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const CUSTOM = {origin: 'https://openrouter.ai', model: 'qwen3-8b'};
const CUSTOM_ID = customProfileId(CUSTOM.origin, CUSTOM.model);
// The shipped defaults are read from the profile module, so tuning them later cannot break these tests. `differs` picks a value that is not the shipped one.
const shippedOf = (id, family) => defaultProfile(id, family ? {family} : undefined);
const differs = (shipped, ...options) => options.find(option => option !== shipped);

async function workbench({prompting = true, onChanged = () => {}, active} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'editor-prompting-'));
  const overrides = await CharacterOverrides.open({dir: join(dir, 'character-overrides')});
  const personas = new PersonaBook(rows, {overrides});
  const turn = active ?? {route: 'custom', tier: null, mature: false, custom: CUSTOM};
  const profiles = await PromptProfiles.open({dir: join(dir, 'prompt-overrides'), active: () => turn});
  const editor = new CharacterEditor({personas, overrides, route: () => 'local', promptProfiles: prompting ? profiles : null, onChanged});
  const server = new EditorServer({editor});
  await server.start();
  return {dir, profiles, editor, server, personas, files: () => readdir(join(dir, 'prompt-overrides')).catch(() => []), async done() { await server.stop(); await rm(dir, {recursive: true, force: true}); }};
}
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
const ROUTES = [['GET', '/api/prompting'], ['GET', '/api/prompting/mistral'], ['PUT', '/api/prompting/mistral', {closing: {text: 'Now answer.'}}],
  ['POST', '/api/prompting/mistral/validate', {}], ['POST', '/api/prompting/mistral/reset', {}], ['POST', '/api/prompting/mistral/preview', {}]];

test('every prompting route needs the session code, the exact Host and our own Origin, and takes JSON only', async t => {
  const b = await workbench(); t.after(b.done);
  for (const [method, path, body] of ROUTES) {
    assert.equal((await call(b.server, method, path, {body, token: false})).status, 401, `${method} ${path} without the code`);
    assert.equal((await call(b.server, method, path, {body, headers: {'X-Editor-Token': 'wrong'}, token: false})).status, 401, `${method} ${path} with a wrong code`);
    assert.equal((await call(b.server, method, path, {body, host: 'evil.example'})).status, 403, `${method} ${path} with another Host`);
    assert.equal((await call(b.server, method, path, {body, headers: {Origin: 'http://evil.example'}})).status, 403, `${method} ${path} from another origin`);
  }
  assert.equal((await call(b.server, 'GET', '/api/prompting', {headers: {Origin: new URL(b.server.url).origin}})).status, 200);
  assert.equal((await call(b.server, 'PUT', '/api/prompting/mistral', {raw: '{"closing":{"text":"x"}}', headers: {'Content-Type': 'text/plain'}})).status, 415);
  assert.equal((await call(b.server, 'POST', '/api/prompting/mistral/validate', {raw: '{broken'})).status, 400);
  assert.equal((await call(b.server, 'PUT', '/api/prompting/mistral', {raw: JSON.stringify({closing: {text: 'x'.repeat(200 * 1024)}})})).status, 413);
  assert.equal((await call(b.server, 'POST', '/api/prompting/mistral/preview', {raw: JSON.stringify({patch: {closing: {text: 'x'.repeat(200 * 1024)}}})})).status, 413);
  assert.equal((await call(b.server, 'DELETE', '/api/prompting/mistral')).status, 404, 'no other verbs');
  assert.deepEqual(await b.files(), [], 'nothing refused changed anything');
  assert.equal(b.profiles.getOverride('mistral'), null);
});

test('a body over the limit is answered 413 and read to its end, so the same connection serves the next request', async t => {
  const b = await workbench(); t.after(b.done);
  const agent = new http.Agent({keepAlive: true, maxSockets: 1});
  t.after(() => agent.destroy());
  const url = new URL(b.server.url);
  const send = (method, path, data) => new Promise((resolve, reject) => {
    const request = http.request({agent, host: '127.0.0.1', port: url.port, method, path,
      headers: {Host: `127.0.0.1:${url.port}`, 'X-Editor-Token': b.server.token, ...(data === undefined ? {} : {'Content-Type': 'application/json'})}}, response => {
      response.resume();
      response.on('end', () => resolve({status: response.statusCode, socket: request.socket}));
    });
    request.on('error', reject);
    request.end(data);
  });
  const big = await send('PUT', '/api/prompting/mistral', JSON.stringify({closing: {text: 'x'.repeat(200 * 1024)}}));
  assert.equal(big.status, 413);
  const next = await send('GET', '/api/prompting');
  assert.equal(next.status, 200);
  assert.equal(next.socket, big.socket, 'one connection served both');
  assert.deepEqual(await b.files(), [], 'nothing was stored');
});

test('only the ids of the store\'s own list are accepted: no path, key or look-alike reaches the store, and a body is never read for an unknown id', async t => {
  const b = await workbench(); t.after(b.done);
  const listed = (await call(b.server, 'GET', '/api/prompting')).json.profiles.map(row => row.id);
  assert.deepEqual(listed, ['mistral', 'local-lite', 'local-standard', 'mature-lite', 'mature-standard', CUSTOM_ID]);
  for (const id of ['..%2Fsecret', '..', '%2e%2e%2fmistral', 'mistral%2F..', 'Mistral', 'MISTRAL', 'base', 'family:qwen', 'custom-evil-example-com-model', 'custom-', 'local-lite.json', 'local-lite%00',
    'x'.repeat(200), '', '%E0%A4%A', 'toString', '__proto__', 'constructor']) {
    for (const [method, tail, body] of [['GET', '', undefined], ['PUT', '', {closing: {text: 'x'}}], ['POST', '/validate', {}], ['POST', '/reset', {}], ['POST', '/preview', {}]]) {
      const reply = await call(b.server, method, '/api/prompting/' + id + tail, {body});
      assert([404, 400].includes(reply.status), `${method} ${id}${tail} -> ${reply.status}`);
    }
  }
  // An unknown id is answered before the body is read: a broken or over-sized body does not change the answer.
  assert.equal((await call(b.server, 'PUT', '/api/prompting/nobody', {raw: '{broken'})).status, 404);
  assert.equal((await call(b.server, 'PUT', '/api/prompting/nobody', {raw: JSON.stringify({a: 'x'.repeat(300 * 1024)})})).status, 404);
  assert.equal((await call(b.server, 'GET', '/api/prompting/mistral/extra')).status, 404);
  assert.equal((await call(b.server, 'POST', '/api/prompting/mistral/other', {body: {}})).status, 404);
  assert.deepEqual(await b.files(), []);
  assert.deepEqual(b.profiles.list().filter(row => row.changed), []);
});

test('the list names every option, marks the one in use, and names a Custom option by its host and model', async t => {
  const b = await workbench(); t.after(b.done);
  const list = (await call(b.server, 'GET', '/api/prompting')).json.profiles;
  assert.deepEqual(list.map(row => row.provider), ['mistral', 'local', 'local', 'local', 'local', 'custom']);
  const custom = list.find(row => row.id === CUSTOM_ID);
  assert.deepEqual({provider: custom.provider, host: custom.host, models: custom.models, family: custom.family, active: custom.active, changed: custom.changed}, {provider: 'custom', host: 'openrouter.ai', models: 'qwen3-8b', family: 'qwen', active: true, changed: false});
  assert.deepEqual(list.filter(row => row.active).map(row => row.id), [CUSTOM_ID]);
  const state = (await call(b.server, 'GET', '/api/state')).json;
  assert.deepEqual(state.prompting.fields, PROFILE_FIELDS);
  assert.deepEqual(state.prompting.limits.temperature, PROFILE_LIMITS.temperature);
  assert.equal(state.prompting.limits.rules, PROFILE_LIMITS.rules);
  // A profile of an endpoint that is no longer configured stays listed once it has a saved change.
  const edit = await call(b.server, 'PUT', '/api/prompting/' + CUSTOM_ID, {body: {closing: {text: 'Answer, {name}.'}}});
  assert.equal(edit.status, 200);
  const other = await workbench({active: {route: 'mistral'}}); t.after(other.done);
  assert.equal(other.profiles.list().some(row => row.provider === 'custom'), false, 'with no Custom endpoint the list has none');
});

test('one option in full: the shipped default, the effective profile and the stored change; Convai has none', async t => {
  const b = await workbench(); t.after(b.done);
  const plain = (await call(b.server, 'GET', '/api/prompting/mistral')).json;
  assert.equal(plain.id, 'mistral');
  assert.deepEqual(plain.default, JSON.parse(JSON.stringify(defaultProfile('mistral'))));
  assert.deepEqual(plain.effective, plain.default);
  assert.deepEqual(plain.override, {});
  assert.equal(plain.provider, 'mistral');
  assert.equal(plain.active, false);
  assert.equal((await call(b.server, 'GET', '/api/prompting/convai')).status, 404);
  assert.equal((await call(b.server, 'GET', '/api/prompting/' + CUSTOM_ID)).json.default.sampling.temperature, shippedOf(CUSTOM_ID, 'qwen').sampling.temperature);
  const shippedTemperature = shippedOf('mistral').sampling.temperature, mine = differs(shippedTemperature, 0.3, 0.35);
  const saved = (await call(b.server, 'PUT', '/api/prompting/mistral', {body: {sampling: {temperature: mine}}})).json;
  assert.deepEqual(saved.override, {sampling: {temperature: mine}});
  assert.equal(saved.effective.sampling.temperature, mine);
  assert.equal(saved.default.sampling.temperature, shippedTemperature, 'the default is untouched');
});

test('validate stores nothing and answers with the codes; save refuses what validate refuses (422), and every limit is enforced', async t => {
  const b = await workbench(); t.after(b.done);
  const validate = patch => call(b.server, 'POST', '/api/prompting/mistral/validate', {body: patch});
  assert.deepEqual((await validate({closing: {text: 'Now answer.'}})).json, {ok: true, fields: ['closing']});
  assert.deepEqual((await validate({})).json, {ok: true, fields: []});
  assert.equal((await validate(null)).status, 400);
  assert.equal((await validate([])).status, 400);
  const L = PROFILE_LIMITS;
  const cases = [
    [{rules: []}, {field: 'rules', code: 'rules-few'}],
    [{rules: Array.from({length: L.rules + 1}, (_, i) => ({id: `r${i}`, text: 'x'}))}, {field: 'rules', code: 'rules-many', max: L.rules}],
    [{rules: [{id: 'a', text: 'x'.repeat(L.ruleText + 1)}]}, {field: 'rules', code: 'rule-long', index: 0, max: L.ruleText}],
    [{rules: [{id: 'a', text: '  '}]}, {field: 'rules', code: 'rule-empty', index: 0}],
    [{rules: Array.from({length: 6}, (_, i) => ({id: `r${i}`, text: 'x'.repeat(1700)}))}, {field: 'rules', code: 'rules-total', max: L.rulesTotal}],
    [{examples: Array.from({length: L.examples + 1}, (_, i) => `line ${i}`)}, {field: 'examples', code: 'examples-many', max: L.examples}],
    [{examples: ['x'.repeat(L.example + 1)]}, {field: 'examples', code: 'examples-long', index: 0, max: L.example}],
    [{examples: Array.from({length: 6}, (_, i) => `${i}`.repeat(299))}, {field: 'examples', code: 'examples-total', max: L.examplesTotal}],
    [{intro: {named: 'x'.repeat(L.intro + 1)}}, {field: 'intro', key: 'named', code: 'intro-long', max: L.intro}],
    [{intro: {ambient: ''}}, {field: 'intro', key: 'ambient', code: 'empty'}],
    [{closing: {text: 'x'.repeat(L.closing + 1)}}, {field: 'closing', key: 'text', code: 'closing-long', max: L.closing}],
    [{labels: {rules: 'x'.repeat(L.label + 1)}}, {field: 'labels', key: 'rules', code: 'labels-long', max: L.label}],
    [{labels: {nonsense: 'x'}}, {field: 'labels', key: 'nonsense', code: 'unknown-field'}],
    [{sampling: {temperature: 2.5}}, {field: 'sampling', key: 'temperature', code: 'out-of-range', min: 0, max: 2}],
    [{sampling: {topP: 1.5}}, {field: 'sampling', key: 'topP', code: 'out-of-range', min: 0, max: 1}],
    [{sampling: {repeatPenalty: 0.5}}, {field: 'sampling', key: 'repeatPenalty', code: 'not-for-mistral'}],   // Mistral takes no repeat penalty (fix/report-mistral-repeat), so it is refused before the range is looked at
    [{sampling: {maxTokens: 5}}, {field: 'sampling', key: 'maxTokens', code: 'out-of-range', min: 16, max: 2000}],
    [{sampling: {maxTokens: 100.5}}, {field: 'sampling', key: 'maxTokens', code: 'out-of-range', min: 16, max: 2000}],
    [{sampling: {temperature: '0.5'}}, {field: 'sampling', key: 'temperature', code: 'out-of-range', min: 0, max: 2}],
    [{limits: {persona: 100}}, {field: 'limits', key: 'persona', code: 'out-of-range', min: 2000, max: 16000}],
    [{limits: {turns: 12}}, {field: 'limits', key: 'turns', code: 'out-of-range', min: 0, max: 11}],
    [{stop: Array.from({length: L.stops + 1}, (_, i) => `stop${i}`)}, {field: 'stop', code: 'stop-many', max: L.stops}],
    [{stop: ['x'.repeat(L.stop + 1)]}, {field: 'stop', code: 'stop-long', index: 0, max: L.stop}],
    [{layout: {volatile: 'sideways'}}, {field: 'layout', key: 'volatile', code: 'bad-value'}],
    [{nothing: 1}, {field: 'nothing', code: 'unknown-field'}],
  ];
  for (const [patch, expected] of cases) {
    const checked = (await validate(patch)).json;
    assert.equal(checked.ok, false, JSON.stringify(patch).slice(0, 80));
    assert(checked.errors.some(error => Object.entries(expected).every(([key, value]) => error[key] === value)), `${JSON.stringify(expected)} in ${JSON.stringify(checked.errors)}`);
    const refused = await call(b.server, 'PUT', '/api/prompting/mistral', {body: patch});
    assert.equal(refused.status, 422, JSON.stringify(expected));
    assert.equal(refused.json.error, 'invalid');
    assert.deepEqual(refused.json.errors, checked.errors, 'save and validate agree');
  }
  // The edges that are allowed.
  for (const patch of [{sampling: {temperature: 0}}, {sampling: {temperature: 2}}, {sampling: {maxTokens: 16}}, {sampling: {maxTokens: 2000}}, {sampling: {topP: 'off'}}, {limits: {persona: 2000, turns: 0}},
    {limits: {persona: 16000, turns: 11}}, {stop: ['\nV:']}, {rules: [{id: 'a', text: 'x'.repeat(L.ruleText)}]}]) assert.equal((await validate(patch)).json.ok, true, JSON.stringify(patch));
  assert.deepEqual(await b.files(), [], 'nothing refused or only checked was stored');
  assert.equal(b.profiles.getOverride('mistral'), null);
});

test('save, then reset one field, then reset all: the file holds only what differs, and an unknown field is refused', async t => {
  const changes = [];
  const b = await workbench({onChanged: () => changes.push(1)}); t.after(b.done);
  const put = body => call(b.server, 'PUT', '/api/prompting/local-lite', {body});
  const first = await put({rules: [{id: 'short', text: 'Be short, {name}.', talk: 'Be shorter, {name}: {words} words.'}], closing: {text: 'Now answer.'}, sampling: {temperature: differs(shippedOf('local-lite').sampling.temperature, 0.4, 0.45), topP: differs(shippedOf('local-lite').sampling.topP, 0.9, 0.85)}, stop: ['\nV:']});
  assert.equal(first.status, 200);
  assert.equal(first.json.changed, true);
  assert.deepEqual(await b.files(), ['local-lite.json']);
  const file = JSON.parse(await readFile(join(b.dir, 'prompt-overrides', 'local-lite.json'), 'utf8'));
  assert.deepEqual(Object.keys(file).filter(key => PROFILE_FIELDS.includes(key)).sort(), ['closing', 'rules', 'sampling', 'stop']);
  assert.equal(changes.length, 1, 'the bridge was told once');
  // A value equal to the shipped one is not a change.
  const same = await put({sampling: {temperature: shippedOf('local-lite').sampling.temperature}});
  assert.equal(same.json.override.sampling.temperature, undefined);
  assert.equal(same.json.override.sampling.topP, first.json.override.sampling.topP, 'the other sub-fields are kept');
  // One field.
  const oneField = await call(b.server, 'POST', '/api/prompting/local-lite/reset', {body: {field: 'rules'}});
  assert.equal(oneField.status, 200);
  assert.deepEqual(Object.keys(oneField.json.override).sort(), ['closing', 'sampling', 'stop']);
  assert.deepEqual(oneField.json.effective.rules, oneField.json.default.rules);
  assert.equal((await call(b.server, 'POST', '/api/prompting/local-lite/reset', {body: {field: 'bio'}})).status, 400);
  assert.equal((await call(b.server, 'POST', '/api/prompting/local-lite/reset', {body: {field: 5}})).status, 400);
  assert.equal((await call(b.server, 'POST', '/api/prompting/local-lite/reset', {body: []})).status, 400);
  // The whole option: the file is gone.
  const all = await call(b.server, 'POST', '/api/prompting/local-lite/reset', {body: {}});
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.override, {});
  assert.equal(all.json.changed, false);
  assert.deepEqual(await b.files(), []);
  assert.deepEqual(all.json.effective, all.json.default);
  assert.equal(changes.length, 4, 'every change that reached the store told the bridge');
  // The empty body resets all too.
  await put({closing: {text: 'Again.'}});
  assert.equal((await call(b.server, 'POST', '/api/prompting/local-lite/reset', {raw: ''})).status, 200);
  assert.equal(b.profiles.getOverride('local-lite'), null);
});

test('an option\'s change never reaches another option, and a Custom option is its own', async t => {
  const b = await workbench(); t.after(b.done);
  await call(b.server, 'PUT', '/api/prompting/' + CUSTOM_ID, {body: {sampling: {repeatPenalty: 1.05}}});
  await call(b.server, 'PUT', '/api/prompting/mature-lite', {body: {closing: {text: 'Mature closing.'}}});
  const changed = (await call(b.server, 'GET', '/api/prompting')).json.profiles.filter(row => row.changed).map(row => row.id).sort();
  assert.deepEqual(changed, [CUSTOM_ID, 'mature-lite'].sort());
  assert.equal(b.profiles.getOverride('local-lite'), null);
  assert.equal(b.profiles.getOverride('mistral'), null);
});

test('the preview shows the stored profile, or the unsaved change laid over it, as the prompt would; a change that is not valid shows its codes instead', async t => {
  const b = await workbench(); t.after(b.done);
  const preview = body => call(b.server, 'POST', '/api/prompting/mistral/preview', {body});
  const plain = (await preview({})).json;
  const shipped = shippedOf('mistral');
  const shows = (sample = {}) => ({rules: renderRules(shipped, {name: 'Judy', ...sample}), examples: renderExamples(shipped), closing: renderClosing(shipped, {name: 'Judy', talkWords: sample.talkWords ?? 0})});
  assert.equal(plain.ok, true);
  assert.deepEqual({rules: plain.rules, examples: plain.examples, closing: plain.closing}, shows(), 'the shipped profile, as the prompt module renders it');
  assert(plain.rules.startsWith(shipped.labels.rules + '\n1. '));
  const rogue = (await preview({name: 'Rogue'})).json;
  assert.equal(rogue.rules, shows({name: 'Rogue'}).rules);
  assert.notEqual(rogue.rules, plain.rules);
  const talking = (await preview({talkWords: 25})).json;
  assert.deepEqual({rules: talking.rules, closing: talking.closing}, {rules: shows({talkWords: 25}).rules, closing: shows({talkWords: 25}).closing});
  assert.notEqual(talking.rules, plain.rules, 'a speaker with a reply length reads the talk versions');
  assert.equal((await preview({mature: true})).json.rules, shows({mature: true}).rules);
  assert.notEqual((await preview({mature: true})).json.rules, plain.rules, 'Mature content reads the Mature versions');
  assert.equal((await preview({mature: false})).json.rules, plain.rules);
  // An unsaved change.
  const draft = (await preview({patch: {rules: [{id: 'one', text: 'Be short, {name}.'}], examples: ['Fine, V.'], closing: {text: 'Go, {name}.'}}})).json;
  assert.equal(draft.rules, `${shipped.labels.rules}\n1. Be short, Judy.`);
  assert.equal(draft.examples, `${shipped.labels.examples}\n- Fine, V.`);
  assert.equal(draft.closing, '(Go, Judy.)');
  assert.equal(b.profiles.getOverride('mistral'), null, 'a preview stores nothing');
  assert.deepEqual(await b.files(), []);
  // The preview of an unsaved change lies over what is stored.
  await call(b.server, 'PUT', '/api/prompting/mistral', {body: {closing: {text: 'Stored closing.'}}});
  assert.equal((await preview({patch: {examples: ['Fine.']}})).json.closing, '(Stored closing.)');
  assert.equal((await preview({})).json.closing, '(Stored closing.)');
  // A change that is not valid.
  const bad = (await preview({patch: {sampling: {temperature: 9}}})).json;
  assert.deepEqual(bad, {ok: false, errors: [{field: 'sampling', key: 'temperature', code: 'out-of-range', min: 0, max: 2}]});
  // The sample is plain and bounded.
  assert.equal((await preview({talkWords: 'many'})).status, 400);
  assert.equal((await preview({talkWords: 0.5})).status, 400);
  assert.equal((await preview({talkWords: 9999})).status, 400);
  assert.equal((await preview(null)).status, 400);
  assert.equal((await preview({name: 'x'.repeat(500)})).json.rules, shows({name: 'x'.repeat(60)}).rules);
  assert.equal((await preview({name: 'A\nB\u0000C'})).json.rules, shows({name: 'A B C'}).rules);
  assert.equal((await preview({name: 7})).json.rules, plain.rules);
});

test('a editor with no profile store has no Prompting: the state says so and every route is 404', async t => {
  const b = await workbench({prompting: false}); t.after(b.done);
  assert.equal((await call(b.server, 'GET', '/api/state')).json.prompting, null);
  for (const [method, path, body] of ROUTES) assert.equal((await call(b.server, method, path, {body})).status, 404, path);
});

test('the sentences the game sends for this page fit the command file: the biggest language stays under the limits', async () => {
  const lua = await readFile(new URL('../mod/character-editor.lua', import.meta.url), 'utf8');
  const sources = [...lua.matchAll(/\['((?:[^'\\]|\\.)*)'\] = ui\.t/g)].map(match => match[1]);
  assert(sources.length > 250 && sources.length < 400, `${sources.length} sentences (the server keeps 400)`);
  for (const lang of ['ru', 'uk', 'ja', 'de', 'fr']) {
    const text = await readFile(new URL(`../mod/locales/${lang}.lua`, import.meta.url), 'utf8');
    const table = new Map([...text.matchAll(/^\s*\["((?:[^"\\]|\\.)*)"\] = "((?:[^"\\]|\\.)*)",/gm)].map(match => [match[1].replace(/\\"/g, '"'), match[2]]));
    // The worst case: every non-ASCII character written as a \uXXXX escape, which is as long as a JSON encoder can make it.
    const strings = Object.fromEntries(sources.map(source => [source, table.get(source) ?? source]));
    const escaped = JSON.stringify({version: 1, id: 'e1700000000-1', action: 'open', issuedAt: 1_700_000_000_000, language: lang, strings}).replace(/[^\x00-\x7f]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    assert(Buffer.byteLength(escaped) < 128 * 1024, `${lang}: ${Buffer.byteLength(escaped)} bytes`);
    const parsed = parseEditorCommand(escaped, 1_700_000_000_000);
    assert(parsed, `${lang}: the command is accepted`);
    assert.equal(Object.keys(parsed.strings).length, sources.length, `${lang}: no sentence is dropped`);
  }
});

// ---- a saved change is in the very next prompt; a reset brings the shipped prompt back byte for byte
const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
async function fakeServer() {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: 'Sure thing, V.'}}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {requests, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
}
const turn = text => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 's1', local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'},
  contextParts: {now: 'Right now (from the game, this turn only): You are with V in person, at the Clouds.', notes: 'Use {joy} tags.', world: 'Quest: Heist.', volatile: 'Your call whether to ask V anything.'}});

test('an override saved through the editor is in the next turn\'s prompt and request, and Reset restores the byte-identical default', async t => {
  const b = await workbench({active: {route: 'mistral'}}); t.after(b.done);
  const llama = await fakeServer(); t.after(llama.close);
  const provider = new MistralProvider({keyPath: 'k.txt', custom: null, readText: async () => `api-key=${KEY}\n`, writeText: async () => {}});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: new PersonaBook(rows), routes: {mistral: mistralRoute({provider, endpoint: llama.endpoint, gapMs: 0, cacheScope: 's'})},
    promptProfiles: b.profiles, log: () => {}});
  t.after(() => host.close());
  const system = body => body.messages[0].content, last = body => body.messages.at(-1).content;

  await host.reply(turn('first'));
  const shipped = llama.requests[0], def = shippedOf('mistral');
  assert.equal(shipped.temperature, def.sampling.temperature);
  assert(system(shipped).includes(renderRules(def, {name: 'Judy Alvarez'})), 'the shipped rules, as the prompt module renders them');

  // Saved through the editor's own route, as the page does.
  const saved = await call(b.server, 'PUT', '/api/prompting/mistral', {body: {rules: [{id: 'short', text: 'Be short, {name}.'}], examples: ['Fine, V.'], closing: {text: 'Now answer.'},
    labels: {rules: 'MY RULES'}, sampling: {temperature: differs(def.sampling.temperature, 0.2, 0.25), topP: differs(def.sampling.topP, 0.8, 0.85), maxTokens: differs(def.sampling.maxTokens, 123, 124)}, stop: ['\nV says:']}});
  assert.equal(saved.status, 200);
  await host.reply(turn('second'));
  const tuned = llama.requests[1];
  assert(system(tuned).includes('MY RULES\n1. Be short, Judy Alvarez.'), 'the new wording is in the very next prompt');
  assert(system(tuned).includes('- Fine, V.'));
  assert(last(tuned).endsWith('(Now answer.)'));
  const mineSampling = saved.json.override.sampling;
  assert.equal(tuned.temperature, mineSampling.temperature); assert.equal(tuned.top_p, mineSampling.topP); assert.equal(tuned.max_tokens, mineSampling.maxTokens); assert.deepEqual(tuned.stop, ['\nV says:']);
  assert.notEqual(system(tuned), system(shipped));

  // One field back: only that part returns.
  await call(b.server, 'POST', '/api/prompting/mistral/reset', {body: {field: 'sampling'}});
  await host.reply(turn('third'));
  const partly = llama.requests[2];
  assert.equal(partly.temperature, def.sampling.temperature); assert.equal('top_p' in partly, def.sampling.topP !== null); assert.equal('stop' in partly, true, 'the stop strings are another field');
  assert(system(partly).includes('MY RULES\n1. Be short'));

  // Everything back: the shipped prompt, byte for byte, and the shipped request.
  const reset = await call(b.server, 'POST', '/api/prompting/mistral/reset', {body: {}});
  assert.equal(reset.status, 200);
  await host.reply(turn('fourth'));
  const back = llama.requests[3];
  assert.equal(system(back), system(shipped), 'the system message is the shipped one, byte for byte');
  assert.equal(JSON.stringify({...back, messages: back.messages.slice(0, 1)}), JSON.stringify({...shipped, messages: shipped.messages.slice(0, 1)}), 'and so is the rest of the request');
  assert(last(back).includes('V says: fourth'));
  // The answers of this fake model are all the same, so from the third turn on the last message also carries the note about her repeating herself (bridge/reply-variety.mjs): not part of the profile.
  assert.equal(last(back).replace('fourth', 'first').replace(/\n\nYour last replies repeat themselves[^\n]*/, ''), last(shipped), 'the last line is the shipped one too');
  assert.deepEqual(await b.files(), [], 'the file is gone');
});
