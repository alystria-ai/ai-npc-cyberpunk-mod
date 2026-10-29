// A player with NO Local AI pack and a GGUF model of their own (the model browser or a `file` entry of manifest.custom.json, id `custom:<name>`) used to get "Local AI is
// unavailable (not-installed)": `detectLocalAiPack().installed` means "an engine AND a pack chat model", and every gate took it for "no model is possible". The
// error report that showed it: settings localModel `custom:gemma-4-12b-it-qat-ud-q4_k_xl`, localAi `not-installed`, on a Runtime whose engine (app/llama-cpp) was there.
// The engine ships in the Runtime, so the player's own file runs on it with no pack. These tests pin every gate: the model list, the supervisor, the settings status, the
// setup check, the retry after an install, and a real bridge process. A server the player runs (an `endpoint` entry) and an installed pack behave as before.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalLlmServer, NO_ENGINE, unavailableDetail} from './local-llm-server.mjs';
import {chooseLocalModel, engineMissingForOwnModel, listLocalModels, localAiAvailable, ownFileModels, usableModels} from './local-model-choice.mjs';
import {detectLocalAiPack} from './local-ai-pack.mjs';
import {localAiCheck} from './setup-check.mjs';
import {launchBridge} from './bridge-run-fixture.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-llama-server.mjs', import.meta.url));
const DEVICES = 'Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4080 Laptop GPU (11997 MiB, 11229 MiB free)\n';

// A pack folder holding the engine and no chat model: what a Runtime with no Local AI pack looks like to detectLocalAiPack (the fixture names the engine in a manifest).
const ENGINE_ONLY = {'manifest.json': JSON.stringify({version: 1, server: 'llama/llama-server.exe'}), 'llama/llama-server.exe': 'fake server'};
const own = (id, file, extra = {}) => ({id: 'custom:' + id, name: id.toUpperCase(), file, uncensored: false, family: null, contextSize: null, chatTemplate: null, tooLarge: false, ...extra});
const server = {id: 'custom:ep-127.0.0.1-5001', name: 'Kobold', file: null, external: true, endpoint: 'http://127.0.0.1:5001/v1', origin: 'http://127.0.0.1:5001'};

function folder(t) {
  const directory = mkdtempSync(join(tmpdir(), 'own-model-nopack-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return directory;
}
const withEngine = (directory, extra = {}) => {
  const exe = join(directory, 'llama-server.exe');
  writeFileSync(exe, 'fake server');
  return {installed: false, missing: ['model', 'embed'], root: directory, server: exe, tiers: {standard: null, lite: null}, embed: null, dev: false, ...extra};
};
const withoutEngine = directory => ({installed: false, missing: ['server', 'model', 'embed'], root: directory, server: null, tiers: {standard: null, lite: null}, embed: null, dev: false});

test('the model gates: an installed pack lists all, no pack keeps servers and (with the engine) the player\'s own files, never a pack model or a Mature one', t => {
  const directory = folder(t);
  const file = join(directory, 'mine.gguf');
  writeFileSync(file, 'x');
  const mine = own('mine', file);
  const packModels = listLocalModels({pack: {installed: true, server: 'x', tiers: {standard: {file: 'a.gguf', name: 'S'}, lite: null}}, customModels: [mine, server]});
  assert.deepEqual(usableModels(packModels, {installed: true}).map(model => model.id), ['standard', 'custom:mine', server.id], 'with a pack nothing is taken out');
  const engine = withEngine(directory);
  const models = listLocalModels({pack: engine, matureModels: [], customModels: [mine, server]});
  assert.deepEqual(usableModels(models, engine).map(model => model.id), ['custom:mine', server.id], 'no pack, the engine is there: the file and the server');
  assert.deepEqual(usableModels(models, withoutEngine(directory)).map(model => model.id), [server.id], 'no engine: a file cannot run, a server of theirs still answers');
  assert.deepEqual(ownFileModels(models).map(model => model.id), ['custom:mine']);
  // a pack model whose pack has no engine (tiers listed, server missing) is not usable either
  const tiersOnly = {...withoutEngine(directory), tiers: {standard: {file, name: 'Standard'}, lite: null}};
  assert.deepEqual(usableModels(listLocalModels({pack: tiersOnly, customModels: [mine]}), tiersOnly).map(model => model.id), []);
});

test('one answer for "can Local AI answer at all": pack, server, or an own file with the engine; no model at all, or a file with no engine, is not available', t => {
  const directory = folder(t);
  const file = join(directory, 'mine.gguf');
  const engine = withEngine(directory), none = withoutEngine(directory);
  assert.equal(localAiAvailable({pack: engine, customModels: [own('mine', file)]}), true, 'no pack, engine, own model: available');
  assert.equal(localAiAvailable({pack: engine, customModels: []}), false, 'no pack and no model of their own: not installed');
  assert.equal(localAiAvailable({pack: none, customModels: [own('mine', file)]}), false, 'no engine: a model file alone cannot run');
  assert.equal(localAiAvailable({pack: none, customModels: [server]}), true, 'a server of the player\'s needs no engine');
  assert.equal(localAiAvailable({pack: {installed: true}, customModels: []}), true, 'an installed pack is unchanged');
  assert.equal(localAiAvailable({}), false);
  assert.equal(engineMissingForOwnModel({pack: none, customModels: [own('mine', file)]}), true);
  assert.equal(engineMissingForOwnModel({pack: engine, customModels: [own('mine', file)]}), false);
  assert.equal(engineMissingForOwnModel({pack: none, customModels: [server]}), false, 'a server is not a model file');
  assert.equal(engineMissingForOwnModel({pack: none, customModels: []}), false);
});

test('the real detection: a manifest that names only the server gives a non-null server with installed false, which is what the gates read', t => {
  const directory = folder(t);
  mkdirSync(join(directory, 'local-ai', 'llama'), {recursive: true});
  for (const [name, text] of Object.entries(ENGINE_ONLY)) writeFileSync(join(directory, 'local-ai', name), text);
  const pack = detectLocalAiPack({project: directory, environment: {}});
  assert.equal(pack.installed, false, 'installed still means an engine and a pack chat model');
  assert.ok(pack.server, 'the engine is there');
  assert.equal(localAiAvailable({pack, customModels: [own('mine', join(directory, 'mine.gguf'))]}), true);
  assert.equal(localAiAvailable({pack, customModels: []}), false);
});

// ---- The supervisor, on the fake llama-server ---------------------------------------------------------------------------------------

function supervisor(t, {pack, customModels = [], pin = 'auto', matureOn = false, freeMiB = 9000, sizes = {}, ...options} = {}) {
  const directory = folder(t);
  const state = {pin, matureOn, matureModels: [], customModels};
  const calls = [], logs = [], failures = [], fallbacks = [];
  const made = new LocalLlmServer({pack: pack ?? withEngine(directory), selection: () => state, listDevices: async () => DEVICES, freeVramMiB: () => freeMiB, freeMemMiB: () => 32000,
    fileSizeMiB: file => sizes[String(file).split(/[\\/]/).pop()] ?? 0, command: process.execPath, argsPrefix: [FAKE], warmup: false, backoffMs: 5, startupMs: 60_000, processOptions: {pollMs: 20},
    spawnImpl: (command, args, spawnOptions) => { const child = spawn(command, args, spawnOptions); calls.push({args, child}); return child; }, log: line => logs.push(line), ...options});
  made.on('failed', event => failures.push(event));
  made.on('model-fallback', event => fallbacks.push(event));
  t.after(async () => { await made.stop(); for (const {child} of calls) if (child.exitCode === null) child.kill(); });
  return {server: made, state, calls, logs, failures, fallbacks, directory, loaded: () => calls.map(call => call.args[call.args.indexOf('-m') + 1].split(/[\\/]/).pop())};
}

test('no pack, the Runtime\'s engine and a GGUF of the player\'s own: it is chosen by default and by pin, started on the engine, and Local AI is ready', async t => {
  const directory = folder(t);
  const file = join(directory, 'gemma-4-12b-it-qat-ud-q4_k_xl.gguf');
  writeFileSync(file, 'x');
  for (const pin of ['auto', 'custom:gemma']) {
    const h = supervisor(t, {pack: withEngine(directory), customModels: [own('gemma', file)], pin, sizes: {'gemma-4-12b-it-qat-ud-q4_k_xl.gguf': 4000}});
    const info = await h.server.ensure();
    assert.deepEqual([info.model, h.server.modelId, h.loaded(), h.server.status().state], ['GEMMA', 'custom:gemma', ['gemma-4-12b-it-qat-ud-q4_k_xl.gguf'], 'ready'], 'pin ' + pin);
    assert.deepEqual(h.failures, []);
    assert.deepEqual(h.fallbacks, []);
    assert.equal(h.server.plannedModel().name, 'GEMMA');
  }
});

test('no pack and no model of any kind: not-installed, with the new wording, and nothing is started', async t => {
  const h = supervisor(t, {customModels: []});
  await assert.rejects(h.server.ensure(), error => error.reason === 'not-installed' && error.detail === undefined && /\[local:unavailable\] no Local AI model is installed/.test(error.message));
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.failures, [{reason: 'not-installed'}]);
  assert.ok(h.logs.some(line => /no Local AI model is installed/.test(line)));
  assert.equal(unavailableDetail('not-installed'), 'no Local AI model is installed: add the Local AI pack or a model of your own', 'the game shows the pack or a model of their own as the two cures');
});

test('a model file of their own but no engine in the Runtime: still not-installed, and the log and the detail say the engine is missing', async t => {
  const directory = folder(t);
  const file = join(directory, 'mine.gguf');
  writeFileSync(file, 'x');
  const h = supervisor(t, {pack: withoutEngine(directory), customModels: [own('mine', file)], pin: 'custom:mine'});
  await assert.rejects(h.server.ensure(), error => error.reason === 'not-installed' && error.detail === NO_ENGINE);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.failures, [{reason: 'not-installed', detail: NO_ENGINE}]);
  assert.deepEqual(h.server.status(), {state: 'failed', reason: 'not-installed', detail: NO_ENGINE, tier: null, model: null});
  assert.ok(h.logs.some(line => /Local AI engine/.test(line) && /update or reinstall the Runtime/.test(line)), h.logs.join('\n'));
  assert.match(unavailableDetail('not-installed', NO_ENGINE), /engine of the Runtime/);
});

test('their own file that does not start is that model\'s failure (start-failed), never "not installed"; a pack present behaves as before', async t => {
  const directory = folder(t);
  const file = join(directory, 'broken-model.gguf');
  writeFileSync(file, 'x');
  const h = supervisor(t, {pack: withEngine(directory), customModels: [own('broken', file)], pin: 'custom:broken', processOptions: {pollMs: 20, env: {FAKE_LLAMA_EXIT_FOR_MODEL: 'broken-model'}}});
  await assert.rejects(h.server.ensure(), error => error.reason === 'start-failed');
  assert.deepEqual(h.failures.map(event => event.reason), ['start-failed']);
  // with a pack, the same file failing falls back to the pack's model
  const standard = join(directory, 'standard.gguf');
  writeFileSync(standard, 'x');
  const packed = supervisor(t, {pack: {...withEngine(directory), installed: true, tiers: {standard: {file: standard, name: 'Std'}, lite: null}}, customModels: [own('broken', file)], pin: 'custom:broken',
    processOptions: {pollMs: 20, env: {FAKE_LLAMA_EXIT_FOR_MODEL: 'broken-model'}}});
  const info = await packed.server.ensure();
  assert.deepEqual([info.model, packed.fallbacks.map(event => [event.pin, event.reason, event.model])], ['Std', [['custom:broken', 'start-failed', 'Std']]]);
});

test('an uncensored file of their own is not the default while Mature content is off (it runs when chosen, or with Mature content on): mature-off, not not-installed', async t => {
  const directory = folder(t);
  const file = join(directory, 'spicy.gguf');
  writeFileSync(file, 'x');
  const off = supervisor(t, {pack: withEngine(directory), customModels: [own('spicy', file, {uncensored: true})], matureOn: false});
  await assert.rejects(off.server.ensure(), error => error.reason === 'mature-off');
  const chosen = supervisor(t, {pack: withEngine(directory), customModels: [own('spicy', file, {uncensored: true})], matureOn: false, pin: 'custom:spicy'});
  assert.equal((await chosen.server.ensure()).model, 'SPICY');
  const on = supervisor(t, {pack: withEngine(directory), customModels: [own('spicy', file, {uncensored: true})], matureOn: true});
  assert.equal((await on.server.ensure()).model, 'SPICY');
});

test('a server of the player\'s own, with no engine and no pack, is unchanged: it answers and nothing of ours is started', async t => {
  const directory = folder(t);
  const h = supervisor(t, {pack: withoutEngine(directory), customModels: [server], fetchImpl: async url => (String(url).endsWith('/models') ? new Response(JSON.stringify({data: [{id: 'm'}]}), {status: 200}) : new Response('{}', {status: 404}))});
  const info = await h.server.ensure();
  assert.deepEqual([info.external, info.model, h.calls.length], [true, 'Kobold', 0]);
});

test('the choice itself picks the file for a player with only their own models, by size when there are several', () => {
  const models = listLocalModels({pack: {installed: false, server: 'x', tiers: {}}, customModels: [own('big', 'big.gguf'), own('small', 'small.gguf')]});
  const sizeOf = file => ({'big.gguf': 7600, 'small.gguf': 2000}[file] ?? 0);
  const usable = usableModels(models, {installed: false, server: 'x'});
  assert.equal(chooseLocalModel({models: usable, sizeOf, freeMiB: 22000}).model.id, 'custom:big');
  assert.equal(chooseLocalModel({models: usable, sizeOf, freeMiB: 22000, pin: 'custom:small'}).model.id, 'custom:small');
});

// ---- The setup check (Help > Setup check) ---------------------------------------------------------------------------------------------

test('the setup check counts an own model file with the engine as installed; with no model at all it is not-installed', () => {
  const selected = {conversationProvider: 'local'};
  assert.deepEqual(localAiCheck(selected, {status: 'ready', ownModel: true}), {state: 'ok', code: 'ready', selected: true, installed: true});
  assert.equal(localAiCheck(selected, {status: 'not-installed'}).code, 'not-installed');
  assert.equal(localAiCheck(selected, {status: 'not-installed'}).installed, false);
  assert.equal(localAiCheck(selected, {status: 'warming', ownModel: true}).code, 'warming');
  // a Mature pack alone with Mature content off is mature-off, unless a model of their own can run
  const matureOnly = {packInstalled: true, matureOnly: true, status: 'failed', reason: 'mature-off'};
  assert.equal(localAiCheck({...selected, matureContent: false}, matureOnly).code, 'mature-off');
  assert.equal(localAiCheck({...selected, matureContent: false}, {packInstalled: true, matureOnly: true, ownModel: true, status: 'ready'}).code, 'ready');
});

// ---- A real bridge process ---------------------------------------------------------------------------------------------------------------

const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const str = text => Buffer.concat([u64(Buffer.byteLength(text)), Buffer.from(text)]);
const kvString = (key, value) => Buffer.concat([str(key), u32(8), str(value)]);
const kvU32 = (key, value) => Buffer.concat([str(key), u32(4), u32(value)]);
const kvStringArray = (key, values) => Buffer.concat([str(key), u32(9), u32(8), u64(values.length), ...values.map(str)]);
// A GGUF header the model scanner accepts as a chat model (it reads the header only, and wants a file of at least 1 MiB).
const chatGguf = () => {
  const pairs = [kvString('general.architecture', 'gemma3'), kvString('general.name', 'Own'), kvU32('gemma3.context_length', 8192), kvStringArray('tokenizer.ggml.tokens', ['x'])];
  const header = Buffer.concat([Buffer.from('GGUF', 'latin1'), u32(3), u64(0), u64(pairs.length), ...pairs]);
  return Buffer.concat([header, Buffer.alloc(1024 * 1024)]);
};
const status = bridge => bridge.read('mistral-state.json');
const spawned = async bridge => (await bridge.llama()).filter(event => event.event === 'spawn').map(event => event.args[event.args.indexOf('-m') + 1].split(/[\\/]/).pop());

test('a real bridge with the engine, no pack and a model file of the player\'s own: Local AI is not "not-installed" and the file is the model that is started', {timeout: 90000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'local', voice: false, localModel: 'custom:own-model-q4'}, fakeLlama: 'llama/llama-server.exe',
    localAi: {...ENGINE_ONLY, 'manifest.custom.json': JSON.stringify({version: 1, models: [{file: 'custom/own-model-q4.gguf', name: 'Own model'}]})}});
  try {
    await bridge.installPack({'custom/own-model-q4.gguf': ''});
    writeFileSync(join(bridge.pack, 'custom', 'own-model-q4.gguf'), chatGguf());
    await bridge.ready();
    const state = await bridge.until(() => status(bridge), value => Array.isArray(value?.localModels) && value.localModels.some(model => model.id === 'custom:own-model-q4'), 'the own model was never listed');
    assert.notEqual(state.localAi, 'not-installed');
    await bridge.until(() => spawned(bridge), value => value.length > 0, 'the own model was never started on the engine');
    assert.equal((await spawned(bridge))[0], 'own-model-q4.gguf');
    assert.doesNotMatch(bridge.errors(), /no Local AI model is installed/);
  } finally { await bridge.cleanup(); }
});

test('a real bridge with the engine and nothing else: Local AI says not-installed and starts nothing', {timeout: 90000}, async () => {
  const bridge = await launchBridge({settings: {conversationProvider: 'local', voice: false}, fakeLlama: 'llama/llama-server.exe', localAi: ENGINE_ONLY});
  try {
    await bridge.ready();
    const state = await bridge.until(() => status(bridge), value => value?.localAi === 'not-installed', 'the missing model was not reported');
    assert.equal(state.effective, 'local');
    assert.deepEqual(await spawned(bridge), []);
  } finally { await bridge.cleanup(); }
});
