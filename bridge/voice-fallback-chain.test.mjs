import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {PassThrough, Writable} from 'node:stream';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {LiveVoices} from './live-voices.mjs';
import {GameVoiceClips, applyStandIns, generatedReference, readManifest, readWords} from './voice-clips.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {fallbackAliases, readFallbacks} from './voice-fallbacks.mjs';

// The side characters (557 invitable, 27 with clips of their own) speak with their fallback archetype voice (characters/cast-sweep-voices.json) until they have clips.
// Everything here is local: files in a temporary folder and a scripted Pocket worker (no model, no GPU).

const tick = () => new Promise(done => setImmediate(done));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const shipped = name => ({reference: `runtime/voice-references/${name}.wav`, sha256: sha(`shipped ${name}`), transcript: `Shipped words of ${name}.`});
const KINDS = {pocket: 'pocket', short: 'omni-short', long: 'omni-long'};
const clipSpec = seed => ({sha256: sha(`generated ${seed}`), samples: 1000 + seed, lines: [], writer: 'sf'});
const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64), inputIdentity: 'e'.repeat(64), selectedStep: 1500}});

// A Pocket worker that keeps the table of the configuration it was started with and logs what it is asked.
function scriptedPocket(settings) {
  const table = {...settings.voices}, prepared = [], log = {streams: [], voices: [], prepares: []}, spawned = [];
  const lists = () => ({profiles: Object.keys(table).filter(key => !table[key].status), preparedProfiles: [...prepared], unavailableProfiles: {}});
  const spawnImpl = (exe, args) => {
    const owner = args[args.indexOf('--owner') + 1];
    const child = new EventEmitter();
    Object.assign(child, {pid: 700 + spawned.length, kill: () => true, stdout: new PassThrough(), stderr: new PassThrough()});
    const send = frame => child.stdout.write(JSON.stringify({owner, ...frame}) + '\n');
    let streaming = null;
    const handle = request => {
      if (request.op === 'voices') {
        log.voices.push(request);
        const changed = [];
        for (const [key, descriptor] of Object.entries(request.set ?? {})) { table[key] = descriptor; changed.push(key); }
        for (const key of request.remove ?? []) { delete table[key]; changed.push(key); }
        for (const key of changed) { const at = prepared.indexOf(key); if (at >= 0) prepared.splice(at, 1); }
        send({op: 'voices', id: request.id, changed, ...lists(), referenceHashes: Object.fromEntries(lists().profiles.map(key => [key, table[key].sha256]))});
      } else if (request.op === 'prepare') {
        log.prepares.push(request.profile);
        if (!prepared.includes(request.profile)) prepared.push(request.profile);
        send({op: 'prepared', id: request.id, profile: request.profile, preparationMs: 1, ...lists()});
      } else if (request.op === 'stream') {
        log.streams.push({profile: request.profile, reference: table[request.profile].reference, sha256: table[request.profile].sha256});
        streaming = request;
        const pcm = Buffer.alloc(16); pcm.writeFloatLE(0.1, 0);
        send({op: 'pcm', id: request.id, profile: request.profile, index: 1, offsetFrames: 0, frames: 4, sampleRate: 24000, channels: 1, format: 'f32le',
          pcm: pcm.toString('base64'), yieldMs: 10, copiedReadyMs: 12});
      } else if (request.op === 'ack' && streaming) {
        send({op: 'done', id: streaming.id, profile: streaming.profile, frames: 4, chunks: 1, sampleRate: 24000, channels: 1, preparationMs: 0,
          firstPcmYieldMs: 10, firstPcmCopiedReadyMs: 12, generationMs: 20, ...lists()});
        streaming = null;
      }
    };
    child.stdin = new Writable({write(bytes, encoding, done) { const request = JSON.parse(bytes.toString()); done(); queueMicrotask(() => handle(request)); }});
    spawned.push(child);
    queueMicrotask(() => send({op: 'ready', protocolVersion: 1, engine: 'pocket-tts', device: 'cpu', dtype: 'torch.float32', runtime: 'pytorch', layers: 6,
      decodeSteps: 1, sampleCfg: 1, threads: 2, gpuVramBytes: 0, sourceRevision: '41cbc84af539ea78a804ffca5f9c6edc1a22ce44',
      sourceSha256: 'b86f98955b6c4776bb24a748b321408aba89d3b66f6b911f415ef4f4191a7666', model: settings.model, workerPaths: settings.runtime,
      ...lists(), preparedProfiles: [], referenceHashes: Object.fromEntries(lists().profiles.map(key => [key, table[key].sha256]))}));
    return child;
  };
  return {table, prepared, log, spawnImpl, spawned};
}

test('whole chain (Pocket): a side character with only a fallback archetype is routed to that voice and named in the manager list, the worker is told nothing and prepares the archetype once, and built clips still win', async () => {
  // 'adam-brocki' and 'adam-finlay' share an archetype, 'agent-weiss' names an archetype the table does not hold, 'aaron-mccarlson' is in the manifest with no row and no stand-in
  // on disk, so only its fallback speaks for him until his clips are built.
  const fallbacks = readFallbacks(JSON.stringify({version: 1, characters: {
    'adam-brocki': {fallback: 'npc-corpo-resident-male', clip: null}, 'adam-finlay': {fallback: 'npc-corpo-resident-male', clip: null},
    'agent-weiss': {fallback: 'npc-nusa-male', clip: null}, 'aaron-mccarlson': {fallback: 'npc-ncpd-male', clip: {stem: 'aaron'}}, 'judy-alvarez': {fallback: 'npc-ncpd-male', clip: null}}}));
  const roster = ['judy-alvarez', 'adam-brocki', 'adam-finlay', 'agent-weiss', 'aaron-mccarlson'];
  const manifest = readManifest(JSON.stringify({version: 1, voices: {'aaron-mccarlson': {'omni-short': clipSpec(1), 'omni-long': clipSpec(2), pocket: {sameAs: 'omni-long'}}}}));
  const words = readWords(JSON.stringify({version: 1, voices: {'aaron-mccarlson': {pocket: 'Aaron pocket.', short: 'Aaron short.', long: 'Aaron long.'}}}));
  const tablesOf = prefix => ({'judy-alvarez': shipped(prefix + 'judy'), 'npc-corpo-resident-male': shipped(prefix + 'corpo'), 'npc-corpo-resident-male-v2': shipped(prefix + 'corpo2'),
    'npc-ncpd-male': shipped(prefix + 'ncpd')});
  const shippedTables = {pocket: tablesOf(''), short: tablesOf('short-'), long: tablesOf('long-')};
  const settings = pocketSettings({...shippedTables.pocket});
  const startTables = {pocket: settings.voices, short: {...shippedTables.short}, long: {...shippedTables.long}};
  const dir = await mkdtemp(join(tmpdir(), 'live-fallback-'));
  const live = {};
  const builder = async (command, args) => {
    const out = args[args.indexOf('--out') + 1], key = args[args.indexOf('--key') + 1];
    for (const kind of Object.values(KINDS)) {
      await mkdir(join(out, kind), {recursive: true});
      await writeFile(join(out, kind, `${key}.wav`), Buffer.alloc(60, kind.length + key.length));
    }
    return {code: 0, stdout: '', stderr: ''};
  };
  const clips = new GameVoiceClips({manifest, words, gameDirectory: join(dir, 'game'), referenceRoot: join(dir, 'references'), stateDirectory: join(dir, 'state'), python: 'python.exe',
    script: 'build.py', manifestPath: 'manifest.json', run: builder, shippedPresentSync: () => false, onBuilt: key => live.voices.refresh(key)});
  assert.deepEqual(applyStandIns(clips, startTables, () => 'male'), [], 'no stand-in voice is on disk');
  assert.equal(Object.hasOwn(settings.voices, 'aaron-mccarlson'), false);
  const states = [];
  const worker = scriptedPocket(settings);
  const voice = new VoiceSelection(settings, {project: process.cwd(), configPath: resolve('live-fixture/config.json'), pythonExecutable: resolve('live-fixture/python.exe'),
    spawnImpl: worker.spawnImpl, aliases: fallbackAliases(fallbacks), profileKeys: roster, onState: value => { states.push(value); }});
  live.voices = new LiveVoices({players: {extras: async () => []}, folder: join(dir, 'player'), voices: startTables, shipped: async () => shippedTables, apply: update => voice.setVoices(update),
    generated: (key, shippedRows) => clips.descriptors(key, shippedRows)});
  try {
    voice.request({voiceProvider: 'pocket'}); voice.applyWhenIdle(false);
    await voice.start();
    voice.applyWhenIdle(false);
    for (const key of ['adam-brocki', 'adam-finlay', 'aaron-mccarlson']) {
      assert.equal(voice.usesProfile(key), true, `${key}: routed to Pocket`);
      assert.match(voice.voiceKeyFor(key, '123ULL'), key === 'aaron-mccarlson' ? /^npc-ncpd-male$/ : /^npc-corpo-resident-male(-v2)?$/, `${key}: the archetype voice`);
    }
    assert.equal(voice.usesProfile('agent-weiss'), false, 'an archetype the table does not hold is no voice: text, no error');
    assert.equal(voice.voiceKeyFor('agent-weiss', 'x'), 'agent-weiss');
    assert.equal(voice.usesProfile('judy-alvarez'), true);
    assert.equal(voice.voiceOf('judy-alvarez'), 'judy-alvarez', 'a character with a row of its own keeps it');
    const routed = states.at(-1).routedProfiles;
    for (const key of ['adam-brocki', 'adam-finlay', 'aaron-mccarlson', 'judy-alvarez', 'npc-corpo-resident-male']) assert.ok(routed.includes(key), `${key} is listed, so the manager names the voice`);
    assert.equal(routed.includes('agent-weiss'), false);
    assert.equal(routed.includes('npc-corpo-resident-male-v2'), false, 'a variant is never a profile');
    assert.equal(new Set(routed).size, routed.length);
    // Nothing is copied to the worker, and the archetype is prepared once for the two people who share it.
    assert.deepEqual(Object.keys(worker.table).sort(), Object.keys(settings.voices).sort());
    assert.equal(worker.log.voices.length, 0);
    await voice.prepareProfile('adam-brocki'); await voice.prepareProfile('adam-finlay'); await voice.prepareProfile('adam-brocki');
    // The worker keeps one prepared setup per voice key (its cache answers the later asks): the two people share the archetype's, and neither key reaches it.
    const preparedFor = worker.prepared.filter(key => key.startsWith('npc-corpo-resident-male'));
    assert.equal(preparedFor.length, 1, 'one prepared voice for both people');
    assert.equal(worker.log.prepares.some(key => key === 'adam-brocki' || key === 'adam-finlay'), false, 'the worker is never asked for a side character key');
    assert.equal(worker.prepared.length, 1, 'nothing else was prepared');
    const preparedBefore = [...worker.prepared];
    await voice.synthesizeStream('adam-finlay', 'A line.', {onPcm: () => {}});
    assert.match(worker.log.streams.at(-1).reference, /corpo/);
    assert.deepEqual(worker.prepared, preparedBefore, 'speaking prepares nothing new');
    await voice.synthesizeStream('aaron-mccarlson', 'Before his clips.', {onPcm: () => {}});
    assert.equal(worker.log.streams.at(-1).reference, shippedTables.pocket['npc-ncpd-male'].reference);
    // His clips are built while the service runs: from the next line they speak, and he is routed throughout.
    assert.equal(await clips.ensure('aaron-mccarlson'), 'ready');
    await live.voices.chain; await tick(); await tick();
    voice.applyWhenIdle(false); await tick(); await tick();
    voice.applyWhenIdle(false);
    assert.equal(voice.voiceOf('aaron-mccarlson'), 'aaron-mccarlson');
    assert.equal(voice.usesProfile('aaron-mccarlson'), true);
    await voice.prepareProfile('aaron-mccarlson');
    await voice.synthesizeStream('aaron-mccarlson', 'After.', {onPcm: () => {}});
    assert.equal(worker.log.streams.at(-1).reference, generatedReference('pocket', 'aaron-mccarlson'), 'the built clip speaks from the next line');
    assert.ok(states.at(-1).routedProfiles.includes('aaron-mccarlson'));
    assert.equal(voice.voiceOf('adam-brocki'), 'npc-corpo-resident-male', 'the others are unchanged');
    assert.equal(worker.spawned.length, 1, 'the worker was never restarted');
    const closing = voice.close(); await tick(); worker.spawned.forEach(child => child.emit('close', 0)); await closing;
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the routes follow the engine: with no alias option the side characters stay unrouted and the list is the table\'s', async () => {
  const roster = ['judy-alvarez', 'adam-brocki'];
  const settings = pocketSettings({'judy-alvarez': shipped('judy'), 'npc-corpo-resident-male': shipped('corpo')});
  const worker = scriptedPocket(settings), states = [];
  const voice = new VoiceSelection(settings, {project: process.cwd(), configPath: resolve('live-fixture/config.json'), pythonExecutable: resolve('live-fixture/python.exe'),
    spawnImpl: worker.spawnImpl, profileKeys: roster, onState: value => { states.push(value); }});
  voice.request({voiceProvider: 'pocket'}); voice.applyWhenIdle(false);
  await voice.start();
  voice.applyWhenIdle(false);
  assert.equal(voice.usesProfile('adam-brocki'), false);
  assert.deepEqual(states.at(-1).routedProfiles, ['judy-alvarez', 'npc-corpo-resident-male']);
  const closing = voice.close(); await tick(); worker.spawned.forEach(child => child.emit('close', 0)); await closing;
});

// ---- the invitation: prepareInvitedVoice and invitedVoiceCurrent (bridge/convai-bridge.mjs) -----------------------------------------

// The checks the bridge makes of the voice service receipt before it lets an invitation through: the receipt names the REQUESTED profile (not the voice that speaks it),
// the route is the receipt provider, and the profile is routed and ready.
const invitationAccepts = (voice, profile, receipt) => receipt?.ready === true && ['pocket', 'omni'].includes(receipt.provider) && receipt.profile === profile
  && receipt.provider === voice.provider && voice.usesProfile(profile) && voice.profileReady(profile);

test('the bridge still checks the invitation receipt against the requested profile (the tests below stand in for those lines)', async () => {
  const source = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /receipt\.profile === profile/);
  assert.match(source, /receipt\.profile !== profile/);
});

test('whole chain (Pocket): inviting a side character with only a fallback archetype prepares and reports ready under its own key, and a manifest character whose clips are built during the invitation too', async () => {
  const fallbacks = readFallbacks(JSON.stringify({version: 1, characters: {
    'adam-brocki': {fallback: 'npc-corpo-resident-male', clip: null}, 'aaron-mccarlson': {fallback: 'npc-ncpd-male', clip: {stem: 'aaron'}}}}));
  const manifest = readManifest(JSON.stringify({version: 1, voices: {'aaron-mccarlson': {'omni-short': clipSpec(1), 'omni-long': clipSpec(2), pocket: {sameAs: 'omni-long'}}}}));
  const words = readWords(JSON.stringify({version: 1, voices: {'aaron-mccarlson': {pocket: 'Aaron pocket.', short: 'Aaron short.', long: 'Aaron long.'}}}));
  const tablesOf = prefix => ({'judy-alvarez': shipped(prefix + 'judy'), 'npc-corpo-resident-male': shipped(prefix + 'corpo'), 'npc-ncpd-male': shipped(prefix + 'ncpd')});
  const shippedTables = {pocket: tablesOf(''), short: tablesOf('short-'), long: tablesOf('long-')};
  const settings = pocketSettings({...shippedTables.pocket});
  const startTables = {pocket: settings.voices, short: {...shippedTables.short}, long: {...shippedTables.long}};
  const dir = await mkdtemp(join(tmpdir(), 'live-invite-'));
  const live = {};
  const builder = async (command, args) => {
    const out = args[args.indexOf('--out') + 1], key = args[args.indexOf('--key') + 1];
    for (const kind of Object.values(KINDS)) {
      await mkdir(join(out, kind), {recursive: true});
      await writeFile(join(out, kind, `${key}.wav`), Buffer.alloc(60, kind.length + key.length));
    }
    return {code: 0, stdout: '', stderr: ''};
  };
  const clips = new GameVoiceClips({manifest, words, gameDirectory: join(dir, 'game'), referenceRoot: join(dir, 'references'), stateDirectory: join(dir, 'state'), python: 'python.exe',
    script: 'build.py', manifestPath: 'manifest.json', run: builder, shippedPresentSync: () => false, onBuilt: key => live.voices.refresh(key)});
  const worker = scriptedPocket(settings);
  const voice = new VoiceSelection(settings, {project: process.cwd(), configPath: resolve('live-fixture/config.json'), pythonExecutable: resolve('live-fixture/python.exe'),
    spawnImpl: worker.spawnImpl, aliases: fallbackAliases(fallbacks), profileKeys: ['judy-alvarez', 'adam-brocki', 'aaron-mccarlson', 'agent-weiss']});
  live.voices = new LiveVoices({players: {extras: async () => []}, folder: join(dir, 'player'), voices: startTables, shipped: async () => shippedTables, apply: update => voice.setVoices(update),
    generated: (key, shippedRows) => clips.descriptors(key, shippedRows)});
  try {
    voice.request({voiceProvider: 'pocket'}); voice.applyWhenIdle(false);
    await voice.start();
    voice.applyWhenIdle(false);
    const adam = await voice.prepareProfile('adam-brocki', {required: true});
    assert.equal(adam.ready, true);
    assert.equal(adam.provider, 'pocket');
    assert.equal(adam.profile, 'adam-brocki', 'the receipt names the invited character, not the archetype voice that speaks for it');
    assert.equal(invitationAccepts(voice, 'adam-brocki', adam), true);
    assert.ok(worker.prepared.includes('npc-corpo-resident-male'));
    // Aaron: his clips are made first (the invitation waits for them), then his voice is prepared.
    assert.equal(await clips.ensure('aaron-mccarlson'), 'ready');
    await live.voices.chain; await tick(); await tick();
    voice.applyWhenIdle(false); await tick(); await tick();
    const aaron = await voice.prepareProfile('aaron-mccarlson', {required: true});
    assert.equal(aaron.profile, 'aaron-mccarlson');
    assert.equal(invitationAccepts(voice, 'aaron-mccarlson', aaron), true);
    assert.equal(voice.voiceOf('aaron-mccarlson'), 'aaron-mccarlson', 'his own clips speak');
    assert.ok(worker.prepared.includes('aaron-mccarlson'));
    // A character no voice speaks keeps the answer it had: a written reply, no profile, no error.
    const weiss = await voice.prepareProfile('agent-weiss', {required: true});
    assert.equal(weiss.ready, true);
    assert.equal(invitationAccepts(voice, 'agent-weiss', weiss), false);
    const closing = voice.close(); await tick(); worker.spawned.forEach(child => child.emit('close', 0)); await closing;
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('whole chain (OmniVoice): inviting a side character with only a fallback archetype prepares and reports ready under its own key', async () => {
  const voices = {'judy-alvarez': shipped('judy'), 'npc-corpo-resident-male': shipped('corpo')};
  const omniConfig = {version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 16, voices};
  const asked = [];
  const make = backend => (config, hooks) => {
    let loaded = false;
    return {backend, hooks, get loaded() { return loaded; }, hasProfile: key => Object.hasOwn(config.voices, key), profileReady(key) { return loaded && this.hasProfile(key); },
      setSteps() {}, setKeepPrepared() {}, async setVoices() { return true; },
      // Like the real clients, the answer names the voice it was asked for.
      async prepareProfile(profile) { asked.push(profile); return {provider: 'omnivoice', ready: true, profile}; },
      async synthesize() { return {}; }, async synthesizeStream() { return {}; },
      async start() { loaded = true; hooks.onState({state: 'ready', resident: false, engine: backend === 'omni' ? 'omnivoice' : 'pocket-tts'}); },
      async close() { loaded = false; hooks.onState({state: 'stopped'}); }};
  };
  const fallbacks = readFallbacks(JSON.stringify({version: 1, characters: {'adam-brocki': {fallback: 'npc-corpo-resident-male'}, 'agent-weiss': {fallback: 'npc-nusa-male'}}}));
  const voice = new VoiceSelection(pocketSettings(voices), {factory: make('pocket'), omniFactory: make('omni'), omniConfig, omniPack: () => ({installed: true}),
    omniRemoteAddress: () => '192.168.1.20:8765', aliases: fallbackAliases(fallbacks), profileKeys: ['judy-alvarez', 'adam-brocki', 'agent-weiss']});
  voice.update({voiceProvider: 'omni', remoteOmni: true}, null, false);
  await voice.start();
  assert.equal(voice.provider, 'omni');
  const adam = await voice.prepareProfile('adam-brocki', {required: true});
  assert.equal(adam.provider, 'omni');
  assert.equal(adam.profile, 'adam-brocki');
  assert.equal(invitationAccepts(voice, 'adam-brocki', adam), true);
  assert.deepEqual(asked, ['npc-corpo-resident-male'], 'the worker is asked for the archetype voice only');
  assert.equal(invitationAccepts(voice, 'agent-weiss', await voice.prepareProfile('agent-weiss', {required: true})), false, 'an archetype the table lacks: written, no error');
  await voice.close();
});
