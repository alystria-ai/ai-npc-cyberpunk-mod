import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer, request as httpRequest} from 'node:http';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ResidentVoice} from './resident-voice.mjs';
import {OmniServer} from './omni-server.mjs';
import {RemoteVoice, probeOmniServer, exchange, remoteFailed, REMOTE_LIMITS} from './remote-voice.mjs';
import {parseServerAddress, OMNI_PROTOCOL, LIMITS} from './omni-remote.mjs';
import {parseOptions, gpuEnvironment, serverLayout, readVoiceList, missingParts, lanAddresses, packRevision} from './omni-server-main.mjs';
import {silentWav} from './speech-audio.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clipBytes = tag => { const bytes = silentWav(); bytes.write(tag.slice(0, 8).padEnd(8, '_'), 44); return bytes; };
const wait = ms => new Promise(done => setTimeout(done, ms));

// A server folder in a temp dir with the fake worker, two shipped clips on the server and a client that has those two plus a clip of its own and V's.
async function rig({loadMs = 0, restartDelays = [20], serverOptions = {}, clientLimits = {}, clientVoices = true, exitCode = '', vPath = 'v-voice/v-male.wav'} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'omni-server-test-'));
  const project = join(root, 'app'), serverRefs = join(root, 'voices'), serverPlayers = join(root, 'data', 'player-voices'), clientRefs = join(root, 'client-voices'), clientPlayers = join(root, 'client-players');
  for (const folder of [join(project, 'bridge'), serverRefs, serverPlayers, clientRefs, clientPlayers]) mkdirSync(folder, {recursive: true});
  copyFileSync(join(here, 'omni-fake-worker.cjs'), join(project, 'bridge', 'resident-voice-worker.py'));
  const shipped = {'johnny-silverhand': clipBytes('johnny'), 'judy-alvarez': clipBytes('judy')};
  const voices = {};
  for (const [key, bytes] of Object.entries(shipped)) {
    for (const folder of [serverRefs, clientRefs]) writeFileSync(join(folder, `${key}.wav`), bytes);
    voices[key] = {reference: `runtime/voice-references/${key}.wav`, sha256: sha(bytes), transcript: `Words of ${key}.`};
  }
  const own = clipBytes('own'), vClip = clipBytes('vvoice');
  mkdirSync(join(clientRefs, dirname(vPath)), {recursive: true});
  writeFileSync(join(clientPlayers, 'my-friend.wav'), own); writeFileSync(join(clientRefs, ...vPath.split('/')), vClip);
  const serverConfig = {version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 16, voices, playerVoiceDirectory: serverPlayers,
    preparation: {mode: 'lazy', startupProfiles: ['johnny-silverhand'], maxCachedProfiles: 8}};
  const configPath = join(root, 'local-voices.json');
  writeFileSync(configPath, JSON.stringify(serverConfig));
  const clientTable = {...voices, ...(clientVoices ? {
    'my-friend': {reference: 'runtime/player-voices/my-friend.wav', sha256: sha(own), transcript: 'My friend speaks here.'},
    'v-male': {reference: `runtime/voice-references/${vPath}`, sha256: sha(vClip), transcript: 'V speaks here.'},
    'not-there': {reference: 'runtime/voice-references/picked/none.wav', sha256: 'f'.repeat(64), transcript: 'No clip anywhere.'}} : {})};
  const logs = [];
  const server = new OmniServer({playerDirectory: serverPlayers, port: 0, version: '9.9.9-test', restartDelays, log: line => logs.push(line), ...serverOptions,
    createVoice: hooks => new ResidentVoice(serverConfig, {project, configPath, pythonExecutable: process.execPath, onState: hooks.onState,
      extraEnvironment: {FAKE_REFERENCES: serverRefs, FAKE_LOAD_MS: String(loadMs), ...(exitCode ? {FAKE_EXIT: String(exitCode)} : {})}})});
  const {port} = await server.listen();
  const endpoint = {host: '127.0.0.1', port, origin: `http://127.0.0.1:${port}`};
  const states = [];
  const client = new RemoteVoice({...serverConfig, voices: clientTable, playerVoiceDirectory: undefined},
    {endpoint, referenceRoots: [clientRefs], playerVoiceDirectory: clientPlayers, onState: value => states.push(value.state), limits: clientLimits});
  const ready = async () => { for (let at = 0; at < 200 && !server.loaded; at++) await wait(25); assert.ok(server.loaded, 'the server voice loaded'); };
  const done = async () => {
    await client.close().catch(() => {}); await server.close().catch(() => {});
    for (let at = 0; at < 20; at++) { try { rmSync(root, {recursive: true, force: true}); break; } catch { await wait(50); } }
  };
  return {root, server, client, endpoint, states, logs, ready, done, serverPlayers, clientTable, serverConfig, own, vClip};
}

test('addresses: names, numbers, ports and what is refused', () => {
  assert.deepEqual(parseServerAddress('192.168.1.20'), {host: '192.168.1.20', port: 8765, origin: 'http://192.168.1.20:8765'});
  assert.deepEqual(parseServerAddress(' http://Gaming-PC.local:9000/ '), {host: 'gaming-pc.local', port: 9000, origin: 'http://gaming-pc.local:9000'});
  assert.deepEqual(parseServerAddress('[::1]:8765'), {host: '[::1]', port: 8765, origin: 'http://[::1]:8765'});
  assert.equal(parseServerAddress('').reason, 'empty');
  assert.equal(parseServerAddress('https://host:1').reason, 'scheme');
  assert.equal(parseServerAddress('http://user:pw@host').reason, 'extras');
  assert.equal(parseServerAddress('host/path').reason, 'extras');
  assert.equal(parseServerAddress('host?x=1').reason, 'extras');
  assert.equal(parseServerAddress('host:0').reason, 'port');
  assert.equal(parseServerAddress('host:70000').reason, 'port');
  assert.equal(parseServerAddress('host:abc').reason, 'port');
  assert.equal(parseServerAddress('bad host').reason, 'host');
  assert.equal(parseServerAddress('::1').reason, 'host');
  assert.equal(parseServerAddress('a'.repeat(300)).reason, 'long');
  assert.equal(parseServerAddress('999.1.1.1').reason, 'host');
});

test('a client starts against the server, sends the clips it lacks, and speaks a phrase', async () => {
  const r = await rig(); await r.ready();
  try {
    await r.client.start();
    assert.equal(r.client.loaded, true);
    assert.equal(r.client.hasProfile('johnny-silverhand'), true);
    // the player's clip and V's voice were sent (they are not on the server); a reference that exists nowhere stays unavailable
    assert.equal(r.client.hasProfile('my-friend'), true);
    assert.equal(r.client.hasProfile('v-male'), true);
    assert.equal(r.client.hasProfile('not-there'), false);
    assert.deepEqual(readdirSync(r.serverPlayers).sort(), ['my-friend.wav', 'v-male.wav']);
    assert.equal(sha(readFileSync(join(r.serverPlayers, 'my-friend.wav'))), r.clientTable['my-friend'].sha256);
    const result = await r.client.synthesize('judy-alvarez', 'Hello there.', {steps: 32});
    assert.equal(result.wav.sampleRate, 24000);
    assert.ok(result.wav.duration > 0.2);
    assert.equal(Buffer.from(result.audio, 'base64').toString('ascii', 0, 4), 'RIFF');
    assert.equal(result.timing.voiceRemote, true); assert.equal(result.timing.voiceSteps, 32); assert.equal(result.timing.voiceGenerationMs, 7);
    assert.ok(result.timing.voiceNetworkMs >= 0);
    assert.equal(r.client.profileReady('judy-alvarez'), true);   // the phrase prepared it on the server
    const mine = await r.client.synthesize('my-friend', 'A clip I sent.');
    assert.ok(mine.wav.duration > 0.2);
  } finally { await r.done(); }
});

test('Vs voice, merged in as addons/v-male.wav, is sent before the first phrase, not in the background', async () => {
  const r = await rig({vPath: 'addons/v-male.wav'}); await r.ready();
  try {
    await r.client.start();
    assert.equal(r.client.hasProfile('v-male'), true, 'Vs clip is on the server when the client is ready');
    assert.ok(readdirSync(r.serverPlayers).includes('v-male.wav'));
  } finally { await r.done(); }
});

test('the Test button: ready, loading, unreachable, not a server, another protocol', async () => {
  const r = await rig({loadMs: 700});
  try {
    const loading = await probeOmniServer(r.endpoint);
    assert.equal(loading.state, 'loading'); assert.equal(loading.version, '9.9.9-test'); assert.equal(loading.protocol, OMNI_PROTOCOL);
    await r.ready();
    const ok = await probeOmniServer(r.endpoint);
    assert.equal(ok.state, 'ok'); assert.ok(ok.ms >= 1 && ok.ms < 1000); assert.equal(ok.device, 'cuda:0'); assert.ok(ok.voices >= 2);
  } finally { await r.done(); }
  assert.deepEqual(await probeOmniServer({host: '127.0.0.1', port: 9}, {count: 1, timeoutMs: 800}), {state: 'failed', code: 'unreachable'});
  const other = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(req.url.endsWith('health') && other.mode === 'old'
    ? JSON.stringify({service: 'ai-npc-omnivoice-server', protocol: 99, version: '0.1'}) : '<html>router</html>'); });
  await new Promise(done => other.listen(0, '127.0.0.1', done));
  const where = {host: '127.0.0.1', port: other.address().port};
  try {
    assert.deepEqual(await probeOmniServer(where, {count: 1}), {state: 'failed', code: 'not-omnivoice'});
    other.mode = 'old';
    assert.deepEqual(await probeOmniServer(where, {count: 1}), {state: 'failed', code: 'protocol', version: '0.1', protocol: 99});
  } finally { other.close(); other.closeAllConnections(); }
});

test('an unreachable server fails the client (text, never another voice) and a loading server is not waited for long', async () => {
  const dead = new RemoteVoice({version: 2, provider: 'hybrid', engine: 'omnivoice', voices: {'judy-alvarez': {reference: 'runtime/voice-references/a.wav', sha256: 'a'.repeat(64), transcript: 'Words.'}},
    preparation: {mode: 'lazy', startupProfiles: [], maxCachedProfiles: 8}}, {endpoint: {host: '127.0.0.1', port: 9}, limits: {connectMs: 500}});
  const states = []; dead.onState = value => states.push(value.state);
  await assert.rejects(dead.start(), error => remoteFailed(error.message) && /cannot be reached/.test(error.message));
  assert.equal(dead.loaded, false); assert.ok(dead.failure); assert.deepEqual(states.slice(-1), ['error']);
  await assert.rejects(dead.synthesize('judy-alvarez', 'x'), /Convai voice|Remote OmniVoice/);
  const r = await rig({loadMs: 2000, clientLimits: {loadWaitMs: 300}});
  try {
    await assert.rejects(r.client.start(), /still loading its voice/);
    assert.ok(r.client.failure);
  } finally { await r.done(); }
});

test('a server that disappears in the middle fails that phrase and the client; the failure is a state the voice service reacts to', async () => {
  const r = await rig(); await r.ready();
  try {
    await r.client.start();
    await r.client.synthesize('judy-alvarez', 'First phrase.');
    await r.server.close();
    await assert.rejects(r.client.synthesize('judy-alvarez', 'Second phrase.'), error => remoteFailed(error.message));
    assert.ok(r.client.failure); assert.equal(r.client.loaded, false); assert.equal(r.states.at(-1), 'error');
    await assert.rejects(r.client.synthesize('judy-alvarez', 'Third phrase.'));
  } finally { await r.done(); }
});

test('a kept-open connection the server had closed is replaced without a failure', async () => {
  const r = await rig(); await r.ready();
  try {
    await r.client.start();
    await r.client.synthesize('judy-alvarez', 'Warm the connection.');
    r.server.server.closeAllConnections();
    const again = await r.client.synthesize('judy-alvarez', 'After the connection was dropped.');
    assert.ok(again.wav.duration > 0.2); assert.equal(r.client.failure, undefined);
  } finally { await r.done(); }
});

test('phrases are rendered in order and a cancelled one does not hold the next', async () => {
  const r = await rig(); await r.ready();
  try {
    await r.client.start();
    const control = new AbortController();
    const slow = r.client.synthesize('judy-alvarez', 'SLOW:400 first', {signal: control.signal});
    const next = r.client.synthesize('judy-alvarez', 'second');
    await wait(60); control.abort();
    await assert.rejects(slow, {name: 'AbortError'});
    const started = performance.now();
    assert.ok((await next).wav.duration > 0.2);
    assert.ok(performance.now() - started < 1500);
    assert.equal(r.client.failure, undefined);
  } finally { await r.done(); }
});

test('the worker dying is the server\'s business: it starts again, puts the voices back and the client goes on', async () => {
  const r = await rig({restartDelays: [30]}); await r.ready();
  try {
    await r.client.start();
    await assert.rejects(r.client.synthesize('judy-alvarez', 'CRASH now'));
    for (let at = 0; at < 200 && !(r.server.loaded && r.server.restarts === 1); at++) await wait(25);
    assert.equal(r.server.restarts, 1); assert.ok(r.server.loaded);
    assert.ok(r.logs.some(line => /starting it again/.test(line)));
    assert.ok(r.logs.some(line => /voices put back/.test(line)));
    // a fresh client finds the player's clip still there, and the restored table holds the client's voices
    const health = await probeOmniServer(r.endpoint);
    assert.equal(health.state, 'ok');
    const again = new RemoteVoice({...r.serverConfig, voices: r.clientTable, playerVoiceDirectory: undefined}, {endpoint: r.endpoint, referenceRoots: [join(r.root, 'client-voices')], playerVoiceDirectory: join(r.root, 'client-players')});
    try { await again.start(); assert.equal(again.hasProfile('my-friend'), true); assert.ok((await again.synthesize('my-friend', 'Back again.')).wav.duration > 0.2); }
    finally { await again.close(); }
  } finally { await r.done(); }
});

test('a voice that can never start (no NVIDIA card) is not started again and the server says so in words', async () => {
  const r = await rig({exitCode: 78, restartDelays: [10]});
  try {
    for (let at = 0; at < 100 && r.server.workerState !== 'failed'; at++) await wait(25);
    assert.equal(r.server.workerState, 'failed'); await wait(100);
    assert.equal(r.server.restarts, 0, 'not started again');
    assert.ok(r.logs.some(line => /NVIDIA graphics card/.test(line)));
    const health = await probeOmniServer(r.endpoint);
    assert.deepEqual([health.state, health.code], ['failed', 'server']);
    await assert.rejects(r.client.start(), /could not load its voice/);
  } finally { await r.done(); }
});

test('a render the worker refuses fails that phrase only', async () => {
  const r = await rig(); await r.ready();
  try {
    await r.client.start();
    await assert.rejects(r.client.synthesize('judy-alvarez', 'REFUSE this'), /refused a phrase|could not generate/);
    assert.equal(r.client.failure, undefined);
    assert.ok((await r.client.synthesize('judy-alvarez', 'fine')).wav.duration > 0.2);
  } finally { await r.done(); }
});

test('a server that started again is told the voices again', async () => {
  const r = await rig(); await r.ready();
  try {
    await r.client.start();
    let sent = 0; const original = r.server.voices.bind(r.server);
    r.server.voices = (...args) => { sent++; return original(...args); };
    await r.client.synthesize('my-friend', 'Same server: nothing is sent again.');
    assert.equal(sent, 0);
    // another instance id, as a restarted process answers: the client sees it on the next answer and sends the table before the phrase after that
    r.server.instance = 'another-instance';
    await r.client.synthesize('my-friend', 'This answer carries the new id.');
    assert.equal(r.client.synced, '');
    const result = await r.client.synthesize('my-friend', 'Voices were sent again.');
    assert.ok(result.wav.duration > 0.2); assert.equal(sent, 1); assert.ok(r.client.synced.length > 10);
  } finally { await r.done(); }
});

test('safety: no browser origin, JSON only, limits, key shapes, no paths', async () => {
  const r = await rig(); await r.ready();
  const send = (method, path, {headers = {}, body} = {}) => new Promise((done, fail) => {
    const req = httpRequest({host: '127.0.0.1', port: r.endpoint.port, method, path, headers}, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => done({status: res.statusCode, text: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', error => done({status: 0, error: error.code})); req.end(body);
  });
  const json = {'content-type': 'application/json'};
  try {
    assert.equal((await send('GET', '/v1/health')).status, 200);
    assert.equal((await send('GET', '/v1/health', {headers: {origin: 'https://evil.example'}})).status, 403);
    assert.equal((await send('POST', '/v1/synthesize', {headers: {origin: 'null', ...json}, body: '{}'})).status, 403);
    assert.equal((await send('POST', '/v1/synthesize', {headers: {'content-type': 'text/plain'}, body: '{}'})).status, 415);
    assert.equal((await send('POST', '/v1/synthesize', {headers: json, body: 'not json'})).status, 400);
    assert.equal((await send('POST', '/v1/synthesize', {headers: json, body: JSON.stringify({profile: '../../etc/passwd', text: 'x'})})).status, 400);
    assert.equal((await send('POST', '/v1/synthesize', {headers: json, body: JSON.stringify({profile: 'judy-alvarez', text: 'x'.repeat(LIMITS.textChars + 1)})})).status, 400);
    assert.equal((await send('POST', '/v1/synthesize', {headers: json, body: JSON.stringify({profile: 'nobody', text: 'x'})})).status, 404);
    assert.equal((await send('POST', '/v1/voices', {headers: json, body: JSON.stringify({voices: {'..': {}}})})).status, 400);
    assert.equal((await send('POST', '/v1/voices', {headers: json, body: JSON.stringify({voices: {a: {reference: '../../secret.wav', sha256: 'a'.repeat(64), transcript: 'x'}}})})).status, 400);
    assert.equal((await send('POST', '/v1/voices', {headers: json, body: JSON.stringify({voices: {a: {reference: 'C:/Windows/x.wav', sha256: 'a'.repeat(64), transcript: 'x'}}})})).status, 400);
    assert.equal((await send('PUT', '/v1/clips/..%2Fevil?sha256=' + 'a'.repeat(64), {body: clipBytes('x')})).status, 400);
    assert.equal((await send('PUT', '/v1/clips/ok-key?sha256=' + 'a'.repeat(64), {body: clipBytes('x')})).status, 400);        // the hash is not the body's
    assert.equal((await send('PUT', '/v1/clips/ok-key?sha256=' + sha(Buffer.from('not a wav at all, but long enough to pass the size floor ......'))
      , {body: 'not a wav at all, but long enough to pass the size floor ......'})).status, 400);
    assert.equal((await send('GET', '/v1/nothing')).status, 405);
    assert.equal((await send('GET', '/elsewhere')).status, 404);
    assert.deepEqual(readdirSync(r.serverPlayers), []);
  } finally { await r.done(); }
});

test('an oversized body is refused before it is read', async () => {
  const r = await rig(); await r.ready();
  try {
    const answer = await exchange({endpoint: r.endpoint, method: 'POST', path: '/v1/synthesize', body: Buffer.alloc(LIMITS.jsonBytes + 10, 32), timeoutMs: 3000});
    assert.equal(answer.status, 413);
  } finally { await r.done(); }
});

test('default options are local-only; the options are read, bounded and named in plain words when wrong', () => {
  const options = parseOptions([], 'C:/server');
  assert.equal(options.listen, '127.0.0.1'); assert.equal(options.port, 8765); assert.equal(options.gpu, 0); assert.equal(options.quality, 16);
  const set = parseOptions(['--listen', '0.0.0.0', '--port', '9001', '--gpu', '1', '--quality', '32', '--root', 'C:/s', '--data', 'C:/d']);
  assert.deepEqual([set.listen, set.port, set.gpu, set.quality], ['0.0.0.0', 9001, 1, 32]);
  assert.match(parseOptions(['--port', '99999']).error, /port/); assert.match(parseOptions(['--gpu', 'x']).error, /graphics card/);
  assert.match(parseOptions(['--quality', '20']).error, /quality/); assert.match(parseOptions(['--bogus']).error, /Unknown option/);
  assert.match(parseOptions(['--listen']).error, /needs a value/); assert.match(parseOptions(['--listen', 'a b']).error, /address/);
  assert.equal(parseOptions(['--list-gpus']).listGpus, true);
  assert.deepEqual(gpuEnvironment(2), {CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: '2', HIP_VISIBLE_DEVICES: '2', ROCR_VISIBLE_DEVICES: '2'});
  assert.deepEqual(lanAddresses({Ethernet: [{family: 'IPv4', address: '192.168.1.5', internal: false}, {family: 'IPv6', address: 'fe80::1', internal: false}], lo: [{family: 'IPv4', address: '127.0.0.1', internal: true}]}), ['192.168.1.5']);
});

test('the server folder layout and its voice list', () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-layout-'));
  try {
    const layout = serverLayout(root, join(root, 'server-data'));
    assert.deepEqual(missingParts(layout)?.length, 4);
    mkdirSync(join(layout.app, 'defaults'), {recursive: true}); mkdirSync(layout.omni, {recursive: true});
    writeFileSync(join(layout.omni, 'omni-pack.json'), JSON.stringify({model: 'k2-fsa/OmniVoice@abcdef1234567'}));
    writeFileSync(join(layout.app, 'defaults', 'local-voices.autobest-long.json'), JSON.stringify({revision: 'old', voices: {}}));
    mkdirSync(join(layout.omni, 'defaults'), {recursive: true});
    writeFileSync(join(layout.omni, 'defaults', 'local-voices.autobest-long.json'), JSON.stringify({revision: 'abcdef1234567', voices: {a: {}}}));
    assert.equal(packRevision(layout), 'abcdef1234567');
    assert.deepEqual(readVoiceList(layout).voices, {a: {}});   // the list that names the pack's model wins over the Runtime's older one
    assert.equal(missingParts(layout, () => true), null);
    assert.equal(layout.voices, join(root, 'voices'));
  } finally { rmSync(root, {recursive: true, force: true}); }
});
