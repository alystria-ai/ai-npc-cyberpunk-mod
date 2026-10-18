// Local AI on a model server the player already runs (KoboldCpp, LM Studio, Ollama, a llama.cpp server, anything OpenAI-compatible):
// an `endpoint` entry in manifest.custom.json (bridge/custom-models.mjs), chosen like any model of the Local AI row, answered by that server
// instead of our own llama-server (bridge/local-llm-server.mjs). Every test here talks to a fake OpenAI-compatible server on localhost.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {readFile, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CustomModelScanner, checkEndpoint, hostKind, validateEntry} from './custom-models.mjs';
import {detectLocalAiPack} from './local-ai-pack.mjs';
import {LocalLlmServer, LocalAiUnavailable, NO_KEY} from './local-llm-server.mjs';
import {chooseLocalModel, defaultModelIds, describeLocalModels, listLocalModels, stillSatisfies} from './local-model-choice.mjs';
import {TextProviderHost, localRoute, mistralRoute, isLocalUnavailable} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {MatureContent, allowanceFor} from './mature-content.mjs';
import {streamChat} from './mistral-client.mjs';
import {collectReport, customServerSecrets} from './support-report.mjs';
import {ReplyStream} from './reply-stream.mjs';

const FAKE_LLAMA = fileURLToPath(new URL('./fixtures/fake-llama-server.mjs', import.meta.url));
const DEVICES = 'Available devices:\n  Vulkan1: NVIDIA GeForce RTX 4080 Laptop GPU (11997 MiB, 11229 MiB free)\n';
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 'session-1',
  local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}, ...extra});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(15); }
  return false;
}

// A key long and odd enough that finding it in any output is no accident.
const SECRET = 'sk-ext-Zq81vTn4Lp0xRw7Hc2Yd9KbM3sGj5Fa6';

// ---- A fake OpenAI-compatible server ---------------------------------------------------------------------------------------------
// Options: key (required bearer token), models (the /v1/models listing), props (/props body), kobold (true_max_context_length value),
// reply (chat text), echoKey (a 401 whose message repeats the key it was given), listing (extra fields of each listed model).
async function fakeServer(t, {key = null, models = [{id: 'qwen3.5-9b'}], props, kobold, reply = 'Sure thing, V. What do you need?', echoKey = false, port = 0, paceMs = 0} = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
      requests.push({method: request.method, url: request.url, headers: request.headers, body});
      const given = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      if (key && given !== key) {
        response.writeHead(401, {'content-type': 'application/json'});
        response.end(JSON.stringify({error: {message: echoKey ? `Incorrect API key provided: ${given}` : 'Invalid API key'}}));
        return;
      }
      const json = (status, value) => { response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(value)); };
      if (request.method === 'GET' && request.url === '/v1/models') return json(200, {object: 'list', data: models});
      if (request.method === 'GET' && request.url === '/props' && props) return json(200, props);
      if (request.method === 'GET' && request.url === '/api/extra/true_max_context_length' && kobold) return json(200, {value: kobold});
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        response.writeHead(200, {'content-type': 'text/event-stream'});
        const text = typeof reply === 'function' ? reply(body) : reply;
        void (async () => {
          for (const piece of String(text).match(/.{1,9}/gs) ?? []) {
            response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
            if (paceMs) await sleep(paceMs);
          }
          response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 120, completion_tokens: 9}})}\n\ndata: [DONE]\n\n`);
        })();
        return;
      }
      json(404, {error: {message: 'not found'}});
    });
  });
  await new Promise(done => server.listen(port, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise(done => { server.closeAllConnections?.(); server.close(done); });
  t.after(close);
  return {origin, endpoint: origin + '/v1', port: server.address().port, requests, close,
    chats: () => requests.filter(request => request.method === 'POST' && request.url === '/v1/chat/completions'),
    gets: () => requests.filter(request => request.method === 'GET')};
}

// A pack-less install (a project folder with nothing in local-ai) or a fake pack with the fake llama-server.
function emptyProject(t) {
  const project = mkdtempSync(join(tmpdir(), 'ext-endpoint-'));
  t.after(() => rmSync(project, {recursive: true, force: true}));
  return project;
}
function fakePack(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ext-pack-'));
  const write = name => { const path = join(directory, name); writeFileSync(path, name); return path; };
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return {directory, pack: {installed: true, missing: [], root: directory, server: write('llama-server.exe'),
    tiers: {standard: {file: write('q4.gguf'), name: 'Qwen3.5-4B'}, lite: {file: write('q2.gguf'), name: 'Qwen3.5-2B'}},
    embed: {file: write('embed.gguf'), dim: 8, id: 'fake-embed'}, dev: false}};
}

// Writes manifest.custom.json under <project>/local-ai and scans it like the bridge does.
function scanManifest(project, models, log = () => {}) {
  mkdirSync(join(project, 'local-ai'), {recursive: true});
  writeFileSync(join(project, 'local-ai', 'manifest.custom.json'), JSON.stringify({version: 1, models}));
  return new CustomModelScanner({project, environment: {}, log}).scan();
}
const entryFor = (server, extra = {}) => ({endpoint: server.endpoint, name: 'KoboldCpp Qwen 9B', family: 'qwen', ...extra});

// A supervisor over the scan result; `spawned` records any attempt to start a process of ours, `devices` any look at the graphics cards.
function supervisor(t, {pack, project, selected = {}, spawnImpl, ...options} = {}) {
  const logs = [], spawned = [], devices = [];
  const state = {pin: 'auto', matureOn: false, matureModels: [], customModels: [], ...selected};
  const real = spawnImpl ?? ((command, args, spawnOptions) => { spawned.push({command, args}); throw new Error('a llama-server of ours must not start'); });
  const counting = (...args) => { spawned.push({command: args[0], args: args[1]}); return real(...args); };
  const server = new LocalLlmServer({pack: pack ?? detectLocalAiPack({project, environment: {}}), selection: () => state, spawnImpl: counting,
    listDevices: async () => { devices.push(1); return DEVICES; }, freeVramMiB: () => null, fileSizeMiB: () => 0, warmup: false, idleMs: 0, backoffMs: 5,
    log: line => logs.push(line), ...options});
  const failures = [], fallbacks = [];
  server.on('failed', event => failures.push(event));
  server.on('model-fallback', event => fallbacks.push(event));
  t.after(async () => { await server.stop(); });
  return {server, state, logs, spawned, devices, failures, fallbacks};
}

// ---- Validation ------------------------------------------------------------------------------------------------------------------

test('hostKind: this computer and the private network are local; everything else, including look-alike names, is remote', () => {
  for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.9.9.9', '[::1]', '::1']) assert.equal(hostKind(host), 'loopback', host);
  for (const host of ['192.168.1.20', '10.0.0.5', '172.16.0.1', '172.31.255.255', '169.254.10.10', '100.64.0.1', '100.127.1.1', '[fd12:3456::1]', 'fe80::1',
    'gaming-pc', 'desktop.local', 'box.lan', 'nas.home.arpa', 'host.internal']) assert.equal(hostKind(host), 'lan', host);
  for (const host of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '100.128.0.1', '192.169.1.1', '11.0.0.1', '256.1.1.1', 'example.com', 'api.openai.com',
    '127.0.0.1.example.com', 'localhost.example.com', 'my.local.example.com', '2001:db8::1', '']) assert.equal(hostKind(host), 'remote', host);
});

test('checkEndpoint accepts http and https addresses, normalises the path and refuses everything that is not one', () => {
  const ok = (value, expected, options) => assert.deepEqual(checkEndpoint(value, options), expected, String(value));
  ok('http://127.0.0.1:5001/v1', {endpoint: 'http://127.0.0.1:5001/v1', origin: 'http://127.0.0.1:5001', kind: 'loopback'});
  ok('http://127.0.0.1:1234/v1/', {endpoint: 'http://127.0.0.1:1234/v1', origin: 'http://127.0.0.1:1234', kind: 'loopback'});
  ok('  http://localhost:11434  ', {endpoint: 'http://localhost:11434/v1', origin: 'http://localhost:11434', kind: 'loopback'});   // no path: /v1
  ok('http://192.168.1.20:8080/api/v1', {endpoint: 'http://192.168.1.20:8080/api/v1', origin: 'http://192.168.1.20:8080', kind: 'lan'});
  ok('http://[::1]:5001/v1', {endpoint: 'http://[::1]:5001/v1', origin: 'http://[::1]:5001', kind: 'loopback'});
  ok('https://llm.example.com/v1', {endpoint: 'https://llm.example.com/v1', origin: 'https://llm.example.com', kind: 'remote'}, {remote: true});
  for (const bad of [undefined, null, 5, '', '   ', 'not a url', 'localhost:5001', 'ftp://127.0.0.1/v1', 'file:///C:/x', 'ws://127.0.0.1:5001/v1', 'http://',
    'http://user:pass@127.0.0.1:5001/v1', 'http://127.0.0.1:5001/v1?key=abc', 'http://127.0.0.1:5001/v1#frag', 'http://127.0.0.1:5001/v 1', 'http://' + 'a'.repeat(400)]) {
    assert.ok(checkEndpoint(bad).error, String(bad).slice(0, 40));
  }
});

test('a host outside this computer and the private network needs "remote": true and https, so a typo cannot send chats to the internet', () => {
  assert.match(checkEndpoint('http://llm.example.com/v1').error, /"remote": true/);
  assert.match(checkEndpoint('https://llm.example.com/v1').error, /"remote": true/);
  assert.match(checkEndpoint('http://203.0.113.9:5001/v1', {remote: true}).error, /https/);
  assert.equal(checkEndpoint('https://203.0.113.9:5001/v1', {remote: true}).kind, 'remote');
  // A typo of localhost is a remote name.
  assert.equal(checkEndpoint('http://localhots:5001/v1').error, undefined, 'a name with no dot is a name on the local network (it fails at the first look if it is a typo)');
  assert.match(checkEndpoint('http://localhost.com:5001/v1').error, /"remote": true/);
  assert.match(checkEndpoint('http://127.0.0.1.nip.io:5001/v1').error, /"remote": true/);
  assert.equal(checkEndpoint('http://127.0.01.1:5001/v1').kind, 'loopback', 'the URL parser reads 127.0.01.1 as 127.0.1.1');
  // The flag is only a permission: on a local host it changes nothing.
  assert.equal(validateEntry('/root', {endpoint: 'http://127.0.0.1:5001/v1', remote: true}).entry.remote, false);
  assert.equal(validateEntry('/root', {endpoint: 'https://llm.example.com/v1', remote: true}).entry.remote, true);
  assert.match(validateEntry('/root', {endpoint: 'https://llm.example.com/v1', remote: 'yes'}).error, /"remote" must be true or false/);
});

test('validateEntry reads an endpoint entry: name, model, key, flags; one of file or endpoint, never both', () => {
  const {entry} = validateEntry('/root', {endpoint: 'http://127.0.0.1:5001/v1', name: ' KoboldCpp Qwen 9B ', model: ' qwen3.5-9b ', apiKey: ` ${SECRET} `,
    uncensored: true, family: 'qwen', contextSize: 16384, chatTemplate: 'chatml'});
  assert.deepEqual(entry, {file: null, name: 'KoboldCpp Qwen 9B', uncensored: true, family: 'qwen', contextSize: 16384, chatTemplate: null, external: true,
    endpoint: 'http://127.0.0.1:5001/v1', origin: 'http://127.0.0.1:5001', hostKind: 'loopback', remote: false, model: 'qwen3.5-9b', apiKey: SECRET});
  assert.equal(validateEntry('/root', {endpoint: 'http://192.168.1.20:5001/v1'}).entry.name, '192.168.1.20:5001', 'the host stands in for a missing name');
  assert.deepEqual([validateEntry('/root', {endpoint: 'http://127.0.0.1:5001/v1'}).entry.apiKey, validateEntry('/root', {endpoint: 'http://127.0.0.1:5001/v1'}).entry.model], [null, null]);
  assert.match(validateEntry('/root', {endpoint: 'http://127.0.0.1:5001/v1', file: 'custom/a.gguf'}).error, /either "file" or "endpoint"/);
  assert.match(validateEntry('/root', {name: 'x'}).error, /"file" or an "endpoint"/);
  for (const [field, value] of [['apiKey', 12], ['apiKey', ''], ['apiKey', 'two words'], ['apiKey', 'k'.repeat(600)], ['model', 3], ['model', '  '], ['model', 'm'.repeat(200)],
    ['name', ''], ['uncensored', 'yes'], ['family', '../x'], ['contextSize', 100]]) {
    assert.ok(validateEntry('/root', {endpoint: 'http://127.0.0.1:5001/v1', [field]: value}).error, field + ' ' + String(value).slice(0, 10));
  }
  // A file entry is exactly what it was.
  const file = validateEntry('/root', {file: 'custom/a.gguf', chatTemplate: 'chatml'}).entry;
  assert.equal(file.external, undefined); assert.equal(file.chatTemplate, 'chatml');
});

// ---- Detection --------------------------------------------------------------------------------------------------------------------

test('the scanner lists servers beside file models, skips bad entries with a log line that has neither address nor key, and never touches the network', t => {
  const project = emptyProject(t);
  const logs = [];
  const scan = scanManifest(project, [
    {endpoint: 'http://127.0.0.1:5001/v1', name: 'KoboldCpp Qwen 9B', apiKey: SECRET},
    {endpoint: 'http://127.0.0.1:1234/v1', name: 'LM Studio', model: 'qwen3.5-9b'},
    {endpoint: 'http://127.0.0.1:11434', name: 'Ollama', model: 'qwen3:8b', contextSize: 8192},
    {endpoint: 'http://127.0.0.1:11434', name: 'Ollama again', model: 'qwen3:8b'},                       // the same server and model twice
    {endpoint: 'http://token-in-path.example.com/v1/' + SECRET, name: 'Typo'},                            // remote without the flag
    {endpoint: 'ftp://127.0.0.1/v1', name: 'Wrong scheme'},
    {endpoint: 'https://llm.example.com/v1', remote: true, name: 'Cloud', apiKey: SECRET + '-2'},
    {file: 'custom/missing.gguf', name: 'No file there'},
  ], line => logs.push(line));
  assert.deepEqual(scan.models.map(model => [model.id, model.name, model.external === true, model.sizeMiB, model.tooLarge]), [
    ['custom:ep-127.0.0.1-5001', 'KoboldCpp Qwen 9B', true, 0, false],
    ['custom:ep-127.0.0.1-1234-qwen3.5-9b', 'LM Studio', true, 0, false],
    ['custom:ep-127.0.0.1-11434-qwen3-8b', 'Ollama', true, 0, false],
    ['custom:ep-llm.example.com', 'Cloud', true, 0, false]]);
  assert.equal(scan.models[0].apiKey, SECRET, 'the supervisor gets the key from the scan');
  assert.deepEqual(scan.problems.map(problem => problem.reason), ['missing'], 'only a file model is reported as not usable');
  assert.equal(logs.length, 4, logs.join('\n'));   // twice listed, no "remote", wrong scheme, the missing file
  for (const line of logs) assert(!line.includes(SECRET) && !/token-in-path|llm\.example|127\.0\.0\.1/.test(line), line);
  assert(logs.some(line => /listed twice/.test(line)) && logs.some(line => /"remote": true/.test(line)) && logs.some(line => /http:\/\/ or https:\/\//.test(line)));
  assert(scan.models.every(model => /^[A-Za-z0-9._:-]{1,80}$/.test(model.id)), 'ids are valid saved choices');
});

test('detection without a pack: the pack is not installed, the server entry still lists and is the only choice; with a pack it joins the others', t => {
  const project = emptyProject(t);
  const scan = scanManifest(project, [{endpoint: 'http://127.0.0.1:5001/v1', name: 'KoboldCpp Qwen 9B'}]);
  const none = detectLocalAiPack({project, environment: {}});
  assert.equal(none.installed, false, 'the pack logic is unchanged: no llama-server, not installed');
  assert.deepEqual(listLocalModels({pack: none, customModels: scan.models}).map(model => model.id), ['custom:ep-127.0.0.1-5001']);
  assert.equal(listLocalModels({pack: none, customModels: scan.models})[0].external, true);

  const {pack} = fakePack(t);
  const both = listLocalModels({pack, customModels: scan.models});
  assert.deepEqual(both.map(model => model.id), ['standard', 'lite', 'custom:ep-127.0.0.1-5001']);
  // The published row never carries the address or the key: only id, name, size 0 and the custom/external marks.
  const withKey = scanManifest(project, [{endpoint: 'http://127.0.0.1:5001/v1', name: 'KoboldCpp Qwen 9B', apiKey: SECRET, model: 'm'}]);
  const published = describeLocalModels(listLocalModels({pack, customModels: withKey.models}), () => 4000);
  assert.deepEqual(published.find(row => row.custom), {id: 'custom:ep-127.0.0.1-5001-m', name: 'KoboldCpp Qwen 9B', sizeMiB: 0, custom: true, needMiB: 0, external: true});
  assert(!JSON.stringify(published).includes(SECRET) && !JSON.stringify(published).includes('http'));
  assert.equal(published.find(row => row.id === 'standard').sizeMiB, 4000, 'file models keep their size; the server model has none (size 0): the page shows it as "(custom)"');
});

// ---- The choice -------------------------------------------------------------------------------------------------------------------

test('a server is used when it is chosen, or as the last resort of its group: never ahead of a file model that fits', t => {
  const project = emptyProject(t);
  const scan = scanManifest(project, [{endpoint: 'http://127.0.0.1:5001/v1', name: 'Kobold'}, {endpoint: 'http://127.0.0.1:1234/v1', name: 'Heretic', uncensored: true}]);
  const {pack} = fakePack(t);
  const sizeOf = file => ({'q4.gguf': 5000, 'q2.gguf': 1500}[String(file).split(/[\\/]/).pop()] ?? 0);
  const models = listLocalModels({pack, customModels: scan.models});
  const kobold = 'custom:ep-127.0.0.1-5001', heretic = 'custom:ep-127.0.0.1-1234';
  const pick = (extra = {}) => chooseLocalModel({models, sizeOf, freeMiB: 24000, ...extra});
  assert.equal(pick().model.id, 'standard', 'auto: the largest file model that fits');
  assert.equal(pick({matureOn: true}).model.id, heretic, 'Mature on, no uncensored file model: the uncensored server is the group\'s only candidate');
  assert.deepEqual([pick({pin: kobold}).model.id, pick({pin: kobold}).pinned, pick({pin: kobold}).fellBack, pick({pin: kobold, freeMiB: 10}).model.id], [kobold, true, null, kobold], 'a pin always fits');
  assert.equal(pick({freeMiB: 10}).model.id, kobold, 'nothing of ours fits: the server is the last resort, not an error');
  assert.equal(pick({freeMiB: 10, pin: 'standard'}).fellBack, 'low-memory');
  assert.equal(pick({freeMiB: 3000}).model.id, 'lite', 'a smaller file model that fits still comes first');
  assert.throws(() => chooseLocalModel({models: listLocalModels({pack, customModels: scan.models.slice(1)}), sizeOf, freeMiB: 10}), /not enough free graphics memory/,
    'an uncensored server is never the last resort with Mature content off');
  assert.equal(chooseLocalModel({models: listLocalModels({pack, customModels: scan.models.slice(1)}), sizeOf, freeMiB: 10, matureOn: true}).model.id, heretic);
  // A server that failed to start is broken, like a custom file: its pin falls back with a reason.
  const broken = models.map(model => (model.id === kobold ? {...model, broken: true} : model));
  const back = chooseLocalModel({models: broken, sizeOf, freeMiB: 24000, pin: kobold});
  assert.deepEqual([back.model.id, back.fellBack], ['standard', 'start-failed']);
  // With only servers installed: the default is the ordinary one; nothing fits is no error either.
  const only = listLocalModels({pack: detectLocalAiPack({project, environment: {}}), customModels: scan.models});
  assert.equal(chooseLocalModel({models: only, freeMiB: 0}).model.id, kobold);
  assert.deepEqual(defaultModelIds({models: only, freeMiB: 0}), {default: kobold, mature: heretic});
  assert.equal(stillSatisfies({loadedId: kobold, models: only, pin: kobold}), true);
  assert.equal(stillSatisfies({loadedId: 'standard', models, pin: kobold}), false, 'the pin changing to a server reloads');
});

// ---- The supervisor ---------------------------------------------------------------------------------------------------------------

test('with no pack at all, a listed server answers: one look at /models with the key, nothing of ours started, nothing polled afterwards', async t => {
  const api = await fakeServer(t, {key: SECRET});
  const project = emptyProject(t);
  const scan = scanManifest(project, [entryFor(api, {apiKey: SECRET})]);
  const h = supervisor(t, {project, selected: {customModels: scan.models}, idleMs: 30});
  const handle = await h.server.ensure();
  assert.deepEqual([handle.endpoint, handle.apiKey, handle.model, handle.external, handle.trustedOrigin, handle.requestModel, handle.tier],
    [api.endpoint + '/chat/completions', SECRET, 'KoboldCpp Qwen 9B', true, api.origin, 'qwen3.5-9b', null]);
  assert.deepEqual([h.spawned.length, h.devices.length], [0, 0], 'no llama-server and no look at the graphics cards');
  assert.deepEqual(h.server.status(), {state: 'ready', tier: null, model: 'KoboldCpp Qwen 9B', contextSize: 8192, external: true});
  assert.equal(h.server.modelId, 'custom:ep-127.0.0.1-' + api.port);
  assert.deepEqual(h.server.modelHints, {uncensored: false, family: 'qwen'});
  const gets = api.gets();
  assert.equal(gets.length, 3, 'GET /models, then the two context questions (/props and the KoboldCpp one) because nothing named a context');
  assert.equal(gets[0].url, '/v1/models');
  assert.equal(gets[0].headers.authorization, 'Bearer ' + SECRET);
  const seen = api.requests.length;
  await sleep(120);   // longer than the idle time: a server of the player's is not unloaded by us
  assert.equal(h.server.status().state, 'ready');
  await h.server.ensure(); await h.server.ensure();
  assert.equal(api.requests.length, seen, 'no polling, no health ping, no request at all until a turn');
});

test('the context comes from the entry, else the listing, else /props, else the KoboldCpp question, else 8192; the model id from the entry, else the only listed model, else "local"', async t => {
  const contextOf = async (apiOptions, extra = {}) => {
    const api = await fakeServer(t, apiOptions);
    const project = emptyProject(t);
    const h = supervisor(t, {project, selected: {customModels: scanManifest(project, [entryFor(api, extra)]).models}});
    const handle = await h.server.ensure();
    return {context: handle.contextSize, model: handle.requestModel, gets: api.gets().map(request => request.url)};
  };
  assert.deepEqual(await contextOf({}, {contextSize: 12288}), {context: 12288, model: 'qwen3.5-9b', gets: ['/v1/models']});
  assert.deepEqual(await contextOf({models: [{id: 'a', context_length: 20000}]}), {context: 20000, model: 'a', gets: ['/v1/models']});
  assert.deepEqual(await contextOf({models: [{id: 'a', loaded_context_length: 6000}]}), {context: 6000, model: 'a', gets: ['/v1/models']});
  const viaProps = await contextOf({props: {default_generation_settings: {n_ctx: 32768}}});
  assert.deepEqual([viaProps.context, viaProps.gets[0], viaProps.gets.includes('/props')], [32768, '/v1/models', true]);
  assert.equal((await contextOf({kobold: 16384})).context, 16384);
  assert.equal((await contextOf({props: {n_ctx: 5000}, kobold: 9000})).context, 5000, 'llama.cpp\'s answer first');
  assert.equal((await contextOf({})).context, 8192, 'nothing says: 8192');
  assert.equal((await contextOf({models: [{id: 'a', meta: {n_ctx_train: 262144}}]})).context, 8192, 'the training context is not the context the server runs');
  assert.equal((await contextOf({models: [{id: 'a'}, {id: 'b'}]})).model, 'local', 'several listed models and none named: local');
  assert.equal((await contextOf({models: [{id: 'a'}, {id: 'b'}]}, {model: 'b'})).model, 'b');
  assert.equal((await contextOf({models: []})).model, 'local');
});

test('a server that cannot be reached, refuses the key or has the wrong address fails like a custom model that did not start', async t => {
  const dead = await fakeServer(t); const deadEndpoint = dead.endpoint; await dead.close();
  const project = emptyProject(t);
  const down = supervisor(t, {project, selected: {customModels: scanManifest(project, [{endpoint: deadEndpoint, name: 'Down'}]).models}});
  const error = await down.server.ensure().catch(caught => caught);
  assert.ok(error instanceof LocalAiUnavailable && isLocalUnavailable(error), String(error));
  assert.equal(error.reason, 'start-failed');
  assert.deepEqual(down.failures.map(event => event.reason), ['start-failed'], 'one failure episode');
  assert.equal(down.server.status().state, 'failed');
  assert.equal(down.spawned.length, 0);
  assert(down.logs.some(line => /did not answer: could not be reached \(ECONNREFUSED\)/.test(line)), down.logs.join('\n'));
  // Until reset(): the same failure is not tried again on every turn.
  await assert.rejects(down.server.ensure(), /local:unavailable/);
  down.server.reset();

  const locked = await fakeServer(t, {key: SECRET});
  const noKey = supervisor(t, {project, selected: {customModels: scanManifest(project, [entryFor(locked, {apiKey: 'a-wrong-key-12345'})]).models}});
  await assert.rejects(noKey.server.ensure(), /local:unavailable/);
  assert(noKey.logs.some(line => /did not accept the API key/.test(line)));
  assert(!noKey.logs.join('\n').includes('a-wrong-key-12345'));

  const wrongPath = await fakeServer(t);
  const noV1 = supervisor(t, {project, selected: {customModels: scanManifest(project, [{endpoint: wrongPath.origin + '/api', name: 'No v1'}]).models}});
  await assert.rejects(noV1.server.ensure(), /local:unavailable/);
  assert(noV1.logs.some(line => /HTTP 404 at \/models \(the address usually ends in \/v1\)/.test(line)), noV1.logs.join('\n'));
});

test('with a pack installed: a pinned server that is down falls back to our model with one model-fallback, and a pinned server that is up starts nothing of ours', async t => {
  const {pack} = fakePack(t);
  const project = emptyProject(t);
  const real = (command, args, options) => spawn(process.execPath, [FAKE_LLAMA, ...args], {...options, env: {...options.env, FAKE_LLAMA_REPLY: 'from our own server'}});
  const options = {pack, spawnImpl: real, fileSizeMiB: () => 3000, listDevices: async () => DEVICES, command: process.execPath, argsPrefix: [FAKE_LLAMA],
    processOptions: {pollMs: 20, tmpDir: tmpdir()}};
  const dead = await fakeServer(t); const deadEndpoint = dead.endpoint; await dead.close();
  const downModels = scanManifest(project, [{endpoint: deadEndpoint, name: 'Down'}]).models;
  const fallen = supervisor(t, {...options, selected: {customModels: downModels, pin: downModels[0].id}});
  const handle = await fallen.server.ensure();
  assert.match(handle.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/);
  assert.equal(handle.external, undefined, 'our own server answers');
  assert.equal(fallen.spawned.length, 1);
  assert.deepEqual(fallen.fallbacks.map(event => [event.pin, event.reason]), [[downModels[0].id, 'start-failed']]);
  assert.notEqual(fallen.fallbacks[0].model, 'Down');
  await fallen.server.stop();

  const api = await fakeServer(t);
  const upModels = scanManifest(project, [entryFor(api)]).models;
  const used = supervisor(t, {...options, selected: {customModels: upModels, pin: upModels[0].id}});
  const info = await used.server.ensure();
  assert.deepEqual([info.external, info.trustedOrigin, used.spawned.length, used.devices.length], [true, api.origin, 0, 0], 'no llama-server of ours for a chosen server');
});

test('choosing a server unloads our llama-server at an idle moment, and choosing ours again starts it', async t => {
  const {pack} = fakePack(t);
  const project = emptyProject(t);
  const api = await fakeServer(t);
  const children = [];
  const real = (command, args, options) => { const child = spawn(process.execPath, [FAKE_LLAMA, ...args], options); children.push(child); return child; };
  const models = scanManifest(project, [entryFor(api)]).models;
  const h = supervisor(t, {pack, spawnImpl: real, fileSizeMiB: () => 3000, command: process.execPath, argsPrefix: [FAKE_LLAMA], processOptions: {pollMs: 20, tmpDir: tmpdir()},
    selected: {customModels: models, pin: 'standard'}});
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  await h.server.ensure();
  assert.equal(children.length, 1); assert.equal(children[0].exitCode, null);
  h.state.pin = models[0].id;
  assert.equal(await h.server.reselect(), true);
  assert.ok(await until(() => h.server.status().state === 'ready' && h.server.status().external === true), 'the server of the player\'s is the model now');
  assert.ok(await until(() => children[0].exitCode !== null || children[0].signalCode !== null), 'our llama-server was stopped');
  assert.equal(children.length, 1, 'nothing of ours was started for it');
  h.state.pin = 'standard';
  assert.equal(await h.server.reselect(), true);
  assert.ok(await until(() => h.server.status().state === 'ready' && !h.server.status().external));
  assert.equal(children.length, 2);
});

test('a server that stops answering mid-session is looked at again before the next turn, and a bad turn on it does not touch our own server\'s handling', async t => {
  const api = await fakeServer(t);
  const project = emptyProject(t);
  const h = supervisor(t, {project, selected: {customModels: scanManifest(project, [entryFor(api, {contextSize: 8192})]).models}});
  await h.server.ensure();
  assert.equal(h.server.externalLost(), true);
  assert.equal(h.server.status().state, 'stopped');
  const before = api.gets().length;
  await h.server.ensure();
  assert.equal(api.gets().length, before + 1, 'one short look, then ready again');
  assert.equal(h.server.status().state, 'ready');
  assert.equal(h.server.externalLost(), true);
  await api.close();
  await assert.rejects(h.server.ensure(), /local:unavailable/);
  assert.equal(h.server.externalLost(), false, 'nothing to forget once it failed');
  // Our own server has an exit handler of its own: externalLost does nothing for it.
  assert.equal(supervisor(t, {pack: fakePack(t).pack}).server.externalLost(), false);
});

// ---- A turn through the provider --------------------------------------------------------------------------------------------------

async function hostFor(t, {server, mistralKey = null, cloud, matureContent = null, log = () => {}} = {}) {
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => (mistralKey ? `api-key=${mistralKey}\n` : ''), writeText: async () => {}});
  await provider.load(); provider.setPreference('local'); provider.apply();
  const routes = {local: localRoute({server, provider, log})};
  if (cloud) routes.mistral = mistralRoute({provider, endpoint: cloud.origin + '/v1/chat/completions', gapMs: 0, chatDefaults: {retries: 0, backoffMs: [0], firstByteMs: 3000, totalMs: 3000}});
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, routes, matureContent: matureContent ?? undefined, log});
  t.after(() => host.close());
  return {host, provider};
}

test('a streamed reply end to end: the turn goes to <endpoint>/chat/completions with the key, the entry\'s model and the usual parameters, and comes back cleaned', async t => {
  const api = await fakeServer(t, {key: SECRET, paceMs: 10, reply: 'Hey V, good to see you here again. What can I do for you tonight? Pull up a chair.'});
  const project = emptyProject(t);
  const models = scanManifest(project, [entryFor(api, {apiKey: SECRET, model: 'qwen3.5-9b', contextSize: 8192})]).models;
  const h = supervisor(t, {project, selected: {customModels: models}});
  const logs = [];
  const {host} = await hostFor(t, {server: h.server, log: line => logs.push(line)});
  const stream = new ReplyStream({name: 'Judy Alvarez'});
  let headWhen = null;
  stream.onChange(() => { if (headWhen === null) headWhen = stream.complete ? 'after' : 'before'; });
  const result = await host.reply(turn('What are you up to?'), {stream});
  assert.equal(headWhen, 'before', 'the first sentence reached the voice while the server was still writing the reply: it is streamed');
  assert.equal(stream.head, 'Hey V, good to see you here again.');
  assert.equal(result.text, 'Hey V, good to see you here again. What can I do for you tonight? Pull up a chair.');
  assert.equal(result.transport, 'local');
  const chats = api.chats();
  assert.equal(chats.length, 1);
  assert.equal(chats[0].headers.authorization, 'Bearer ' + SECRET);
  assert.equal(chats[0].body.model, 'qwen3.5-9b');
  assert.equal(chats[0].body.stream, true);
  assert.deepEqual(chats[0].body.stream_options, {include_usage: true});
  assert.equal(chats[0].body.messages[0].role, 'system');
  assert(chats[0].body.messages.at(-1).content.includes('What are you up to?'));
  assert.equal(typeof chats[0].body.max_tokens, 'number');
  assert.equal(typeof chats[0].body.temperature, 'number');
  assert.deepEqual([h.spawned.length, h.devices.length], [0, 0]);
  for (const line of logs) assert(!line.includes(SECRET), line);
});

test('the reply is fitted to the server\'s context: the entry\'s size is the budget, so a small one cuts a long prompt that a large one sends whole', async t => {
  const lines = Array.from({length: 300}, (_, index) => `- fact ${index}: a plain fact about the world that the character may know of.`).join('\n');
  const blocks = [{key: 'knowledge', text: 'WORLD FACTS\n' + lines}];
  const long = () => turn('What are you up to right now?', {contextParts: {now: 'Right now: night in Kabuki.', notes: 'Use {joy} tags for feelings.', world: blocks[0].text, worldBlocks: blocks, volatile: 'Your call.'}});
  const sentWith = async contextSize => {
    const api = await fakeServer(t);
    const project = emptyProject(t);
    const models = scanManifest(project, [entryFor(api, {contextSize})]).models;
    const h = supervisor(t, {project, selected: {customModels: models}});
    const logs = [];
    const {host} = await hostFor(t, {server: h.server, log: line => logs.push(line)});
    await host.reply(long());
    return {sent: JSON.stringify(api.chats()[0].body.messages), logs};
  };
  const small = await sentWith(6144), large = await sentWith(32768);
  assert(small.sent.length < large.sent.length, `${small.sent.length} against ${large.sent.length} characters`);
  assert(!small.sent.includes('fact 299') && large.sent.includes('fact 299'), 'the small context lost the lowest-priority knowledge, the large one kept it');
  assert(small.logs.some(line => /local AI/i.test(line)), 'the cut is logged');
  assert(!large.logs.some(line => /local AI/i.test(line)));
});

test('a server that is down leads to the fallback provider, with one notice; a server that went away mid-session does too, and is looked at again', async t => {
  const cloud = await fakeServer(t, {reply: 'The cloud answers, V.'});
  // No pack, no cloud account: the turn fails once, the provider asks for Convai and queues the single notice.
  const dead = await fakeServer(t); const deadEndpoint = dead.endpoint; await dead.close();
  const project = emptyProject(t);
  const down = supervisor(t, {project, selected: {customModels: scanManifest(project, [{endpoint: deadEndpoint, name: 'Down'}]).models}});
  const bare = await hostFor(t, {server: down.server});
  const error = await bare.host.reply(turn('hi')).catch(caught => caught);
  assert.ok(isLocalUnavailable(error), String(error));
  assert.equal(bare.provider.localBroken, 'start-failed');
  assert.equal(bare.provider.requested, 'convai');
  bare.provider.apply();
  assert.equal(bare.provider.takeNotice(), 'local-fallback');
  assert.equal(bare.provider.takeNotice(), undefined);

  // With a Mistral key saved: the cloud answers the turn the local one could not.
  const api = await fakeServer(t);
  const live = supervisor(t, {project, selected: {customModels: scanManifest(project, [entryFor(api)]).models}});
  const both = await hostFor(t, {server: live.server, mistralKey: 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL', cloud});
  assert.equal((await both.host.reply(turn('first'))).text, 'Sure thing, V. What do you need?');
  await api.close();
  const second = await both.host.reply(turn('second'));
  assert.equal(second.text, 'The cloud answers, V.', 'the turn the server could not answer went to the cloud');
  assert.equal(live.server.status().state, 'stopped', 'the lost server is looked at again before the next turn');
  const third = await both.host.reply(turn('third'));
  assert.equal(third.text, 'The cloud answers, V.');
  assert.equal(live.failures.length, 1, 'the look found it still down: one failure episode');
  assert.equal(both.provider.localBroken, 'start-failed');
});

// ---- The key stays a secret -------------------------------------------------------------------------------------------------------

test('the key goes only to the entry\'s own origin: a LAN address works when the entry names it, and nothing else does', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push([String(url), init.headers.Authorization]); return new Response('data: ' + JSON.stringify({choices: [{delta: {content: 'ok there'}}]}) + '\n\ndata: [DONE]\n\n', {status: 200}); };
  const call = options => streamChat({apiKey: SECRET, messages: [{role: 'user', content: 'hi'}], provider: 'local', fetchImpl, retries: 0, ...options});
  assert.equal((await call({endpoint: 'http://192.168.1.20:5001/v1/chat/completions', trustedOrigin: 'http://192.168.1.20:5001'})).text, 'ok there');
  assert.deepEqual(seen[0], ['http://192.168.1.20:5001/v1/chat/completions', 'Bearer ' + SECRET]);
  await assert.rejects(call({endpoint: 'http://192.168.1.20:5001/v1/chat/completions'}), /only ever sent to/);
  await assert.rejects(call({endpoint: 'http://192.168.1.21:5001/v1/chat/completions', trustedOrigin: 'http://192.168.1.20:5001'}), /only ever sent to/);
  await assert.rejects(call({endpoint: 'http://192.168.1.20:5002/v1/chat/completions', trustedOrigin: 'http://192.168.1.20:5001'}), /only ever sent to/);
  await assert.rejects(call({endpoint: 'https://evil.example.com/v1/chat/completions', trustedOrigin: 'http://192.168.1.20:5001'}), /only ever sent to/);
  // The trusted origin is for the local route only: Mistral's key still goes to Mistral and nowhere else.
  await assert.rejects(streamChat({apiKey: SECRET, messages: [], fetchImpl, endpoint: 'http://192.168.1.20:5001/v1/chat/completions', trustedOrigin: 'http://192.168.1.20:5001'}), /only ever sent to/);
  assert.equal(seen.length, 1, 'no request left for a refused address');
});

test('the apiKey is in no log line, no status, no published list and no error, whether the server works, refuses it or echoes it back', async t => {
  const everything = [];
  const log = line => everything.push(String(line));
  const project = emptyProject(t);
  const good = await fakeServer(t, {key: SECRET});
  const echo = await fakeServer(t, {key: 'the-real-key-98765', echoKey: true});
  const models = scanManifest(project, [entryFor(good, {apiKey: SECRET, name: 'Good'}), entryFor(echo, {apiKey: SECRET, name: 'Echo'})], log).models;
  // The good one: lookup, a turn, status and the published list.
  const works = supervisor(t, {project, selected: {customModels: models, pin: models[0].id}, log});
  const {host} = await hostFor(t, {server: works.server, log});
  await host.reply(turn('hello there'));
  everything.push(JSON.stringify(works.server.status()), JSON.stringify(describeLocalModels(listLocalModels({pack: works.server.pack, customModels: models}))),
    JSON.stringify(works.server.modelHints), ...works.logs);
  // The one that refuses the key and echoes it in its error message: the lookup fails, and a direct chat error is redacted too.
  const refused = supervisor(t, {project, selected: {customModels: models, pin: models[1].id}, log});
  await refused.server.ensure().catch(error => everything.push(String(error?.message)));
  everything.push(...refused.logs);
  const direct = await streamChat({apiKey: SECRET, messages: [{role: 'user', content: 'hi'}], provider: 'local', endpoint: echo.endpoint + '/chat/completions', retries: 0}).catch(error => error);
  everything.push(String(direct.message));
  assert(/key/i.test(direct.message), direct.message);
  const text = everything.join('\n');
  assert(text.length > 200, 'something was logged');
  assert(!text.includes(SECRET), 'the key leaked:\n' + text.split('\n').filter(line => line.includes(SECRET)).join('\n'));
  assert(!text.includes('the-real-key-98765'));
  // The log lines name a server by its name, never by its address (a path can carry a secret too).
  assert(!/127\.0\.0\.1:\d+/.test(everything.filter(line => /^\[local\]|^\[custom models\]/.test(line)).join('\n')));
});

test('the support report scrubs a key that is in manifest.custom.json from every line, lists the manifest by name only, and marks a server model', async t => {
  const base = mkdtempSync(join(tmpdir(), 'ext-report-'));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const [game, runtime, state, project] = ['game', 'runtime', 'state', 'project'].map(name => join(base, name));
  for (const folder of [game, runtime, state, join(project, 'local-ai')]) await mkdir(folder, {recursive: true});
  // A key with no shape the scrubber's patterns know, so only the manifest's own value can remove it.
  const KEY = 'Plain-Local-Server-Key-Rm4Vb8Xc1Nq6';
  await writeFile(join(runtime, 'mistral-state.json'), JSON.stringify({version: 1, localAi: 'ready', localModels: [
    {id: 'custom:ep-127.0.0.1-5001', name: 'KoboldCpp Qwen 9B', sizeMiB: 0, custom: true, needMiB: 0, external: true}]}));
  // A log line that (wrongly) carries the key: the report must still not.
  await writeFile(join(state, 'bridge-service.log'), `[LocalAI] something went wrong with ${KEY} here\n`);
  const build = () => collectReport({game, runtime, stateDirectory: state, project, reportId: 'r-external', environment: {}});
  const text = report => report.entries.map(row => row.data).join('\n') + JSON.stringify(report.summary);
  assert(text(await build()).includes(KEY), 'control: with no manifest the scrubber cannot know this key');
  await writeFile(join(project, 'local-ai', 'manifest.custom.json'), JSON.stringify({version: 1, models: [{endpoint: 'http://127.0.0.1:5001/v1', name: 'KoboldCpp Qwen 9B', apiKey: KEY}]}));
  const report = await build();
  assert(!text(report).includes(KEY), 'the key is scrubbed from every line');
  assert(text(report).includes('[secret-redacted]'));
  assert.deepEqual(report.summary.localAi.manifests, ['manifest.custom.json']);
  assert.deepEqual(report.summary.localAi.localModels, [{id: 'custom:ep-127.0.0.1-5001', name: 'KoboldCpp Qwen 9B', sizeMiB: 0, external: true}]);
  assert(!text(report).includes('127.0.0.1:5001'), 'the address is not in the report');
  assert.deepEqual(await customServerSecrets({project, environment: {}}), [KEY]);
  assert.deepEqual(await customServerSecrets({project: join(base, 'nowhere'), environment: {}}), []);
  assert.deepEqual(await customServerSecrets({project: join(base, 'nowhere'), environment: {CYBERPUNK_CONVAI_LOCAL_AI: join(project, 'local-ai')}}), [KEY], 'the environment override is honoured');
});

// ---- Safety: the Mature rules and the hard-limit guard apply as they do for a custom file model ----------------------------------------

test('the manifest\'s uncensored and family reach the Mature allowance in both directions, as for a custom file model', async t => {
  const api = await fakeServer(t);
  const project = emptyProject(t);
  const hints = async extra => {
    const models = scanManifest(project, [entryFor(api, {name: 'Some Server', ...extra})]).models;
    const h = supervisor(t, {project, selected: {customModels: models, pin: models[0].id}});
    await h.server.ensure();
    const route = localRoute({server: h.server, provider: {}});
    return {hints: route.modelHints(), model: route.modelName(), allowance: allowanceFor(route.modelName(), route.modelHints())};
  };
  const free = await hints({uncensored: true, family: 'qwen'});
  assert.deepEqual(free.hints, {uncensored: true, family: 'qwen'});
  assert.equal(free.allowance.uncensored, true);
  const restrained = await hints({uncensored: false, family: 'gemma'});
  assert.deepEqual(restrained.hints, {uncensored: false, family: 'gemma'});
  assert.equal(restrained.allowance.uncensored, false);
  assert.deepEqual([restrained.allowance.family, restrained.allowance.level], ['gemma', 'suggestive'], 'the family label picks the row when the name does not');
  assert.equal(free.allowance.level, 'full');
});

test('a server marked uncensored is not the default while Mature content is off, runs when chosen, and is the default once Mature content is on', async t => {
  const api = await fakeServer(t);
  const project = emptyProject(t);
  const models = scanManifest(project, [entryFor(api, {uncensored: true})]).models;
  const off = supervisor(t, {project, selected: {customModels: models}});
  const error = await off.server.ensure().catch(caught => caught);
  assert.equal(error.reason, 'mature-off', String(error));
  assert.match(error.message, /marked uncensored/);
  assert.equal(api.requests.length, 0, 'the server was not even asked');
  const pinned = supervisor(t, {project, selected: {customModels: models, pin: models[0].id}});
  assert.equal((await pinned.server.ensure()).external, true);
  const on = supervisor(t, {project, selected: {customModels: models, matureOn: true}});
  assert.equal((await on.server.ensure()).external, true);
});

test('the hard-limit guard screens a server\'s reply: a flagged reply is replaced by the character\'s own refusal, and nothing of it is stored', async t => {
  const flagged = 'Alright, V. That kid was nude in the picture. We should get going.';
  const api = await fakeServer(t, {reply: flagged});
  const project = emptyProject(t);
  const models = scanManifest(project, [entryFor(api, {uncensored: true})]).models;
  const h = supervisor(t, {project, selected: {customModels: models, matureOn: true}});
  const matureContent = new MatureContent(); matureContent.setPack(true); matureContent.update({matureContent: true});
  const logs = [];
  const {host} = await hostFor(t, {server: h.server, matureContent, log: line => logs.push(line)});
  const result = await host.reply(turn('hello'));
  assert.notEqual(result.text, flagged);
  assert(logs.some(line => /Mature guard: refused a reply/.test(line)), logs.join('\n'));
  assert(!logs.some(line => /nude|kid/.test(line)), 'the words are never logged');
  assert.deepEqual(host.memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns, []);
  // The model is uncensored, so the guard runs even with the setting off (it follows the model that answers).
  const off = new MatureContent(); off.setPack(true); off.update({matureContent: false});
  const second = await hostFor(t, {server: h.server, matureContent: off});
  assert.notEqual((await second.host.reply(turn('hello again'))).text, flagged);
});

test('the placeholder key is long enough for the client and is what a keyless server gets', async t => {
  assert.ok(NO_KEY.length >= 8);
  const api = await fakeServer(t);
  const project = emptyProject(t);
  const h = supervisor(t, {project, selected: {customModels: scanManifest(project, [entryFor(api)]).models}});
  const handle = await h.server.ensure();
  assert.equal(handle.apiKey, NO_KEY);
  assert.equal(api.gets()[0].headers.authorization, undefined, 'no Authorization header is sent to a server with no key');
  // A keyless server is also fine for our own prewarm: it is one small request, and only for a local address.
  await h.server.prewarm([{role: 'user', content: 'hi'}]);
  assert.equal(api.chats().length, 1);
  assert.equal(api.chats()[0].body.model, 'qwen3.5-9b');
  assert.equal(api.chats()[0].body.max_tokens, 1);
});
