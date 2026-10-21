// A real bridge process (bridge/bridge-run-fixture.mjs) with a model server the player already runs (KoboldCpp, an `endpoint` entry of manifest.custom.json) and no
// Local AI pack: the 2026-10-21 report (a KoboldCpp 1.108 on port 5001 worked in 0.2.2, "Service not running" / "could not start" after the update). The bridge must
// start, list the server as the model, look at it once and report Local AI ready; the same with only a Mature pack, with the manifest in the data home outside the
// game folder, and with a saved choice of the server whose id changed. A server that does not answer must be reported as Local AI failing, never as a missing service.
// The side-effect guard of the fixture stays on: the only network it lets through is the loopback port of the fake server named in CYBERPUNK_TEST_ALLOW_LOOPBACK_PORTS.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {launchBridge, matureOnlyPack} from './bridge-run-fixture.mjs';

const FAKE_SERVER = 'llama/llama-server.exe';
const status = bridge => bridge.read('mistral-state.json');

// What KoboldCpp 1.108 answers: the model listing with its own prefix, the context question, and an event-stream with `event: message` lines.
async function koboldLike(t, {listen = true} = {}) {
  const seen = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      seen.push(`${request.method} ${request.url}`);
      const json = (code, value) => { response.writeHead(code, {'content-type': 'application/json'}); response.end(JSON.stringify(value)); };
      if (request.url === '/v1/models') return json(200, {object: 'list', data: [{id: 'koboldcpp/Qwen3.5-9B', object: 'model', created: 1, owned_by: 'koboldcpp', permission: [], root: 'koboldcpp'}]});
      if (request.url === '/api/extra/true_max_context_length') return json(200, {value: 8192});
      if (request.url === '/api/extra/version') return json(200, {result: 'KoboldCpp', version: '1.108.2'});
      json(404, {detail: 'Not Found'});
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  const close = () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); });
  if (!listen) await close();
  t.after(close);
  return {port, seen, endpoint: `http://127.0.0.1:${port}/v1`, id: `custom:ep-127.0.0.1-${port}`};
}
const manifest = (endpoint, extra = {}) => JSON.stringify({version: 1, models: [{endpoint, name: 'My Server', ...extra}]});
const allow = kobold => ({CYBERPUNK_TEST_ALLOW_LOOPBACK_PORTS: String(kobold.port)});
const ready = (bridge, label) => bridge.until(() => status(bridge), value => value?.localAi === 'ready', label, 30000);

test('no Local AI pack, a KoboldCpp-like server in the mod\'s Local AI folder: Local AI is ready on the server, the server is the listed and default model, nothing of ours is started', {timeout: 90000}, async t => {
  const kobold = await koboldLike(t);
  const bridge = await launchBridge({settings: {conversationProvider: 'local', voice: false}, localAi: {'manifest.custom.json': manifest(kobold.endpoint)}, env: allow(kobold)});
  try {
    await bridge.ready();
    const state = await ready(bridge, 'Local AI never became ready on the server');
    assert.deepEqual([state.provider, state.effective], ['local', 'local']);
    assert.deepEqual(state.localModels.map(model => [model.id, model.name, model.external === true]), [[kobold.id, 'My Server', true]]);
    assert.equal(state.localModelDefault, kobold.id);
    assert.equal(kobold.seen[0], 'GET /v1/models', 'the one look at the server');
    assert.deepEqual(await bridge.llama(), [], 'no llama-server of ours, no look at the graphics cards');
    assert.deepEqual(await bridge.forbidden(), []);
  } finally { await bridge.cleanup(); }
});

test('only a Mature pack installed (Mature content off or on), the server pinned or not pinned: the bridge starts and lists the server beside the Mature model; a pinned server is the one used', {timeout: 120000}, async t => {
  const kobold = await koboldLike(t);
  for (const settings of [{matureContent: false}, {matureContent: false, localModel: kobold.id}, {matureContent: true, localModel: kobold.id}]) {
    const bridge = await launchBridge({settings: {conversationProvider: 'local', voice: false, ...settings},
      localAi: {...matureOnlyPack(), 'manifest.custom.json': manifest(kobold.endpoint)}, fakeLlama: FAKE_SERVER, env: allow(kobold)});
    try {
      await bridge.ready();
      const state = await ready(bridge, 'Local AI never became ready on the server: ' + JSON.stringify(settings));
      assert.deepEqual(state.localModels.map(model => model.name).sort(), ['My Server', 'Test-Uncensored-2B'], JSON.stringify(settings));
      assert.deepEqual((await bridge.llama()).filter(event => event.event === 'spawn'), [], 'the Mature model was not started: ' + JSON.stringify(settings));
    } finally { await bridge.cleanup(); }
  }
});

test('the manifest in the data home outside the game folder (the report moved it there) is found while the bridge runs; a saved choice with an old id still means the only server', {timeout: 90000}, async t => {
  const kobold = await koboldLike(t);
  const bridge = await launchBridge({settings: {conversationProvider: 'local', voice: false, localModel: 'custom:ep-localhost-5001'},
    env: {...allow(kobold), CYBERPUNK_CONVAI_DATA_HOME: folder => join(folder, 'data-home')}});
  try {
    await bridge.ready();
    mkdirSync(join(bridge.folder, 'data-home', 'local-ai'), {recursive: true});
    writeFileSync(join(bridge.folder, 'data-home', 'local-ai', 'manifest.custom.json'), manifest(kobold.endpoint));
    const state = await ready(bridge, 'the server in the data home was never used');
    assert.equal(state.localModelDefault, kobold.id);
    assert.deepEqual(state.localModels.map(model => model.id), [kobold.id]);
    assert.doesNotMatch(bridge.errors(), /chosen model is not usable \(missing\)/, 'the old id is mapped without a notice');
  } finally { await bridge.cleanup(); }
});

test('a server that does not answer is Local AI failing (the server stays listed, the bridge stays up, the turns stay on Local AI), never a service that is not running', {timeout: 90000}, async t => {
  const kobold = await koboldLike(t, {listen: false});
  const bridge = await launchBridge({settings: {conversationProvider: 'local', voice: false}, localAi: {'manifest.custom.json': manifest(kobold.endpoint)}, env: allow(kobold)});
  try {
    await bridge.ready();
    const state = await bridge.until(() => status(bridge), value => value?.localAi === 'failed', 'the unreachable server was not reported');
    assert.deepEqual([state.provider, state.effective], ['local', 'local']);
    assert.deepEqual(state.localModels.map(model => model.name), ['My Server']);
    // The model row says which server and what to do, in the bridge's own words (no address, no key), not a generic "could not start".
    assert.match(state.localDetail, /^the model server you added does not answer: start it/);
    assert.doesNotMatch(state.localDetail, /127\.0\.0\.1/);
    assert.equal(bridge.closed, null, 'the bridge itself is running');
    assert.match(bridge.errors(), /the server of "My Server" did not answer: could not be reached/);
  } finally { await bridge.cleanup(); }
});
