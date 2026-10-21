// Which reference clones a voice in a reply's language (docs/VOICE_LANGUAGE_PACKS.md): the pack's clip when the language has a pack and lists the voice, the English
// reference otherwise. OmniVoice (VoiceSelection.synthesize -> the worker's languageReference), the Mistral voice (VoxtralVoice.reference, its slots), the routing
// log's ref, V's line and the Developer-mode capture. Pocket and English replies are untouched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {VoiceLanguagePacks} from './voice-language-packs.mjs';
import {FAKE_VOICES, sha256, sineWav, writePack} from './fixtures/voice-language-pack.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';
import {VoxtralVoice} from './voxtral-voice.mjs';
import {createReferencePreparer} from './voxtral-reference.mjs';
import {createVoiceProfileRegistry} from './voice-profile-registry.mjs';
import {describeVoiceRoute, formatVoiceRoute} from './voice-routing-log.mjs';
import {MistralScheduler} from './mistral-rate.mjs';
import {Utterance} from './voice-utterance.mjs';
import {LastReplyCapture} from './last-reply-capture.mjs';

async function folder(run) {
  const root = await mkdtemp(resolve(tmpdir(), 'convai-language-reference-'));
  try { return await run(root); } finally { await rm(root, {recursive: true, force: true}); }
}
async function installed(root, options = {}) {
  const written = await writePack(root, options), packs = new VoiceLanguagePacks({roots: [root]});
  await packs.scan();
  return {...written, packs};
}

// ---- OmniVoice: the descriptor handed to the worker -------------------------------------------------------------------------------------

const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64), inputIdentity: 'e'.repeat(64), selectedStep: 1500}});
// Pocket's own list is the three legacy voices (version 1); OmniVoice's list is wider.
const pocketVoices = () => Object.fromEntries(LOCAL_VOICE_KEYS.map(key => [key, {reference: `runtime/voice-references/${key}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.'}]));
const reference = key => ({reference: `runtime/voice-references/picked/autobest/omni-long/${key}.wav`, sha256: 'a'.repeat(64), transcript: `English words of ${key}.`});
const OMNI_KEYS = ['panam-palmer', 'judy-alvarez', 'resident-female', 'npc-maelstrom-male-v2', 'alex'];

function omniSelection(packs) {
  const calls = [];
  const voices = Object.fromEntries(OMNI_KEYS.map(key => [key, reference(key)]));
  // The player gave Alex a clip of their own: it stands in his place whatever the language.
  voices.alex = {reference: 'runtime/player-voices/alex.wav', sha256: 'b'.repeat(64), transcript: 'The player\'s own words.'};
  const worker = backend => (config, {onState}) => {
    let loaded = false;
    return {get loaded() { return loaded; }, hasProfile: key => Object.hasOwn(config.voices, key), profileReady: key => loaded && Object.hasOwn(config.voices, key),
      setSteps() {}, async prepareProfile(key) { return {provider: backend, ready: true, profile: key}; },
      async start() { loaded = true; onState({state: 'ready', resident: true}); },
      async synthesize(profile, text, options) { calls.push({backend, profile, text, options}); return {audio: 'wav', timing: {}}; },
      async synthesizeStream(profile, text, options) { calls.push({backend, profile, text, options}); return {audio: 'pcm'}; },
      async close() { loaded = false; onState({state: 'stopped'}); }};
  };
  const voice = new VoiceSelection(pocketSettings(pocketVoices()), {languagePacks: packs, factory: worker('pocket'), omniFactory: worker('omni'),
    omniConfigs: {short: {version: 2, provider: 'hybrid', engine: 'omnivoice', voices}, long: {version: 2, provider: 'hybrid', engine: 'omnivoice', voices}}});
  return {voice, calls};
}

test('OmniVoice: a Mandarin reply of a named character, an archetype and an archetype\'s second voice is cloned from the pack\'s clip', async () => {
  await folder(async root => {
    const {packs, clips} = await installed(root);
    const h = omniSelection(packs);
    h.voice.update({voiceProvider: 'omni', omniSteps: 16}, null, false); await h.voice.start();
    for (const key of ['panam-palmer', 'resident-female', 'npc-maelstrom-male-v2']) {
      await h.voice.synthesize(key, 'Hello there.', {language: 'zh'});
      const options = h.calls.at(-1).options, folderName = key === 'panam-palmer' ? 'picked' : 'archetypes';
      assert.equal(h.calls.at(-1).profile, key, 'the profile (the English key) is what the worker is asked for');
      assert.deepEqual(options.languageReference, {reference: `runtime/voice-references/multilingual/zh-cn/${folderName}/${key}.wav`,
        sha256: sha256(clips[key]), transcript: FAKE_VOICES[key].text}, key);
      assert.equal(options.language, 'zh');
    }
    await h.voice.close();
  });
});

test('OmniVoice: an English reply, a language without a pack, a voice the pack lacks and a voice with the player\'s own clip keep their English reference', async () => {
  await folder(async root => {
    const {packs} = await installed(root);
    const h = omniSelection(packs);
    h.voice.update({voiceProvider: 'omni', omniSteps: 16}, null, false); await h.voice.start();
    const cases = [['panam-palmer', undefined, 'no language: English'], ['panam-palmer', 'en', 'English'], ['panam-palmer', 'ja', 'a language without a pack'],
      ['judy-alvarez', 'zh', 'a voice the pack does not list'], ['alex', 'zh', 'the player\'s own clip is not replaced']];
    for (const [key, language, name] of cases) {
      await h.voice.synthesize(key, 'Hello there.', {language});
      assert.equal(h.calls.at(-1).options.languageReference, undefined, name);
      assert.equal(h.calls.at(-1).profile, key, name);
    }
    await h.voice.close();
  });
});

test('OmniVoice: without any pack nothing changes (no field is added to the request)', async () => {
  const h = omniSelection(null);
  h.voice.update({voiceProvider: 'omni', omniSteps: 16}, null, false); await h.voice.start();
  await h.voice.synthesize('panam-palmer', 'Hello there.', {language: 'zh'});
  assert.equal('languageReference' in h.calls.at(-1).options, false);
  await h.voice.close();
});

test('Pocket is untouched: it never asks the packs and its worker gets no reference', async () => {
  await folder(async root => {
    const {packs} = await installed(root);
    let asked = 0;
    const spying = {entry: (...args) => { asked++; return packs.entry(...args); }, omniDescriptor: async (...args) => { asked++; return packs.omniDescriptor(...args); }};
    const h = omniSelection(spying);
    h.voice.update({voiceProvider: 'pocket'}, null, false); await h.voice.start();
    await h.voice.synthesizeStream('panam-palmer', 'Hello there.', {onPcm() {}, language: 'zh'});
    const call = h.calls.at(-1);
    assert.equal(call.backend, 'pocket');
    assert.equal(call.options.languageReference, undefined);
    assert.equal(asked, 0);
    await h.voice.close();
  });
});

// ---- the worker protocol ----------------------------------------------------------------------------------------------------------------

test('the routing log names the pack clip (multilingual/<lang>/picked/<voice>) for OmniVoice and the Mistral voice, and the English set otherwise', () => {
  const entries = {'panam-palmer': reference('panam-palmer')};
  const registry = createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice', voices: entries});
  const voice = {requestedProvider: 'omni', requestedOmniSteps: 16, requestedOmniReference: 'long', provider: 'omni', resolvedProvider: 'omni', omniSteps: 16, omniReference: 'long',
    omniVariants: {long: {registry, configured: true}}, registries: {pocket: registry}, configuredByBackend: {omni: true}, cloudActive: false};
  const describe = (extra = {}) => describeVoiceRoute({voice, input: {profileKey: 'panam-palmer'}, profile: {key: 'panam-palmer', name: 'Panam'}, plan: {engine: 'omni', language: 'zh'},
    reply: {engine: 'omni', language: 'zh'}, voiceKey: 'panam-palmer', sources: {omni: {long: {voices: {'panam-palmer': {pick: {seconds: 12}}}}}}, now: () => 0, ...extra});
  const english = formatVoiceRoute(describe());
  assert.ok(english.includes('ref="picked/autobest/omni-long 12s"'), english);
  const packed = formatVoiceRoute(describe({languageSet: 'multilingual/zh-cn/picked/panam-palmer'}));
  assert.ok(packed.includes('ref="multilingual/zh-cn/picked/panam-palmer"'), packed);
  assert.ok(packed.includes('lang=zh'), packed);
  // Pocket (a local, English-only voice) never shows a pack even when one is passed.
  const pocket = formatVoiceRoute(describeVoiceRoute({voice: {...voice, requestedProvider: 'pocket', provider: 'pocket', resolvedProvider: 'pocket', configuredByBackend: {pocket: true}},
    input: {profileKey: 'panam-palmer'}, profile: {key: 'panam-palmer', name: 'Panam'}, plan: {engine: 'pocket'}, reply: {engine: 'pocket'}, voiceKey: 'panam-palmer',
    languageSet: 'multilingual/zh-cn/picked/panam-palmer', now: () => 0}));
  assert.equal(pocket.includes('multilingual/'), false, pocket);
  // The Mistral voice (rides on Pocket's route): its line names the pack clip too, but not when the voice cannot be asked at all.
  const cloudVoice = {...voice, requestedProvider: 'pocket', provider: 'pocket', resolvedProvider: 'pocket', cloudActive: true, cloud: 'voxtral', cloudBlocked: null, cloudLast: null,
    configuredByBackend: {pocket: true}};
  const cloud = formatVoiceRoute(describeVoiceRoute({voice: cloudVoice, input: {profileKey: 'panam-palmer'}, profile: {key: 'panam-palmer', name: 'Panam'},
    plan: {engine: 'pocket', language: 'zh'}, reply: {engine: 'pocket', language: 'zh'}, voiceKey: 'panam-palmer', languageSet: 'multilingual/zh-cn/picked/panam-palmer', now: () => 0}));
  assert.ok(cloud.includes('ref="multilingual/zh-cn/picked/panam-palmer"'), cloud);
  const blocked = formatVoiceRoute(describeVoiceRoute({voice: {...cloudVoice, cloudBlocked: {reason: 'no-key'}}, input: {profileKey: 'panam-palmer'}, profile: {key: 'panam-palmer', name: 'Panam'},
    plan: {engine: 'pocket', language: 'zh'}, reply: {engine: 'pocket', language: 'zh'}, voiceKey: 'panam-palmer', languageSet: 'multilingual/zh-cn/picked/panam-palmer', now: () => 0}));
  assert.equal(blocked.includes('multilingual/'), false, blocked);
});

// ---- the Mistral voice: the pack's clip and its prepared slots --------------------------------------------------------------------------

const KEY = 'k'.repeat(8) + 'Secret0123456789abcdefghijkl';
const delta = bytes => `event: speech.audio.delta\ndata: ${JSON.stringify({type: 'speech.audio.delta', audio_data: bytes.toString('base64')})}\n\n`;
const done = `event: speech.audio.done\ndata: ${JSON.stringify({type: 'speech.audio.done', usage: {prompt_tokens: 1, completion_tokens: 1}})}\n\n`;
const ENGLISH = sineWav({seconds: 0.5, frequency: 330});

async function serve() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write(delta(Buffer.from(new Float32Array(2400).fill(0.2).buffer)));
      response.end(done);
    });
  });
  await new Promise(finish => server.listen(0, '127.0.0.1', finish));
  return {requests, endpoint: `http://127.0.0.1:${server.address().port}/v1/audio/speech`, close: () => { server.closeAllConnections?.(); return new Promise(finish => server.close(finish)); }};
}
const registryOf = keys => createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice',
  voices: Object.fromEntries(keys.map(key => [key, reference(key)].map((value, at) => at ? {...value, sha256: sha256(ENGLISH)} : value)))});

function cloudVoice(server, packs, {read, prepare, logs = [], registry = registryOf(['panam-palmer', 'judy-alvarez', 'resident-female', 'v-male'])} = {}) {
  return new VoxtralVoice({getKey: () => KEY, referenceRoot: resolve('fixture-references'), registry, endpoint: server.endpoint, languagePacks: packs, prepare,
    read: read ?? (async path => (String(path).includes('multilingual') ? readFile(path) : ENGLISH)), scheduler: new MistralScheduler({spacingMs: 0}), onLog: line => logs.push(line)});
}
const refOf = request => Buffer.from(request.ref_audio, 'base64');
const sink = () => { const packets = []; return {packets, onPcm: packet => { packets.push(packet); }}; };

test('the Mistral voice: a reply in Mandarin is cloned from the pack\'s clip, a named character, an archetype and V alike; English keeps the English reference', async () => {
  await folder(async root => {
    const {packs, clips} = await installed(root);
    const server = await serve();
    try {
      const voice = cloudVoice(server, packs);
      for (const key of ['panam-palmer', 'resident-female', 'v-male']) await voice.synthesizeStream(key, 'Hello there.', {onPcm() {}, language: 'zh'});
      assert.deepEqual(server.requests.map(refOf), [clips['panam-palmer'], clips['resident-female'], clips['v-male']]);
      // English (no language, or 'en'): the English clip, whatever the pack holds.
      await voice.synthesizeStream('panam-palmer', 'Hello there.', {onPcm() {}});
      await voice.synthesizeStream('panam-palmer', 'Hello there.', {onPcm() {}, language: 'en'});
      assert.deepEqual(refOf(server.requests[3]), ENGLISH); assert.deepEqual(refOf(server.requests[4]), ENGLISH);
      assert.equal(voice.languageSet('panam-palmer', 'zh'), 'multilingual/zh-cn/picked/panam-palmer');
      assert.equal(voice.languageSet('panam-palmer', 'en'), null);
    } finally { await server.close(); }
  });
});

test('the Mistral voice: a voice the pack lacks, a language without a pack and a player\'s own clip keep the English reference', async () => {
  await folder(async root => {
    const {packs} = await installed(root);
    const server = await serve();
    try {
      const voice = cloudVoice(server, packs);
      await voice.synthesizeStream('judy-alvarez', 'Hello there.', {onPcm() {}, language: 'zh'});
      await voice.synthesizeStream('panam-palmer', 'Hello there.', {onPcm() {}, language: 'fr'});
      assert.deepEqual(server.requests.map(refOf), [ENGLISH, ENGLISH]);
      const own = createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice',
        voices: {'panam-palmer': {reference: 'runtime/player-voices/panam-palmer.wav', sha256: sha256(ENGLISH), transcript: 'Mine.'}}});
      const player = cloudVoice(server, packs, {registry: own});
      assert.equal(player.languageEntry('panam-palmer', 'zh'), null, 'the player\'s choice is not replaced by a pack');
      const plain = new VoxtralVoice({getKey: () => KEY, registry: own});
      assert.equal(plain.languageEntry('panam-palmer', 'zh'), null, 'a voice with no packs at all asks for nothing');
    } finally { await server.close(); }
  });
});

test('the Mistral voice: the English and the Mandarin reference of one character never replace each other in the cache', async () => {
  await folder(async root => {
    const {packs, clips} = await installed(root);
    const server = await serve(), reads = [];
    try {
      const voice = cloudVoice(server, packs, {read: async path => { reads.push(String(path)); return String(path).includes('multilingual') ? readFile(path) : ENGLISH; }});
      const order = ['zh', undefined, 'zh', undefined];
      for (const language of order) await voice.synthesizeStream('panam-palmer', 'Hello there.', {onPcm() {}, ...(language ? {language} : {})});
      assert.deepEqual(server.requests.map(refOf), [clips['panam-palmer'], ENGLISH, clips['panam-palmer'], ENGLISH]);
      assert.equal(reads.length, 2, 'each reference was read once and kept');
      assert.deepEqual([...voice.references.keys()].sort(), ['panam-palmer', 'zh-cn|panam-palmer']);
      voice.forgetLanguageReferences();
      assert.deepEqual([...voice.references.keys()], ['panam-palmer'], 'a pack that changed is read again, the English reference stays');
    } finally { await server.close(); }
  });
});

test('the Mistral voice: a pack clip that changed since the pack was checked (its hash) is not used; the English reference speaks, with one log line', async () => {
  await folder(async root => {
    const {packs} = await installed(root, {withHash: true});
    const server = await serve(), logs = [];
    try {
      const voice = cloudVoice(server, packs, {logs, read: async path => (String(path).includes('multilingual') ? sineWav({seconds: 0.4, frequency: 999}) : ENGLISH)});
      await voice.synthesizeStream('panam-palmer', 'Hello there.', {onPcm() {}, language: 'zh'});
      assert.deepEqual(refOf(server.requests[0]), ENGLISH);
      assert.ok(logs.some(line => line.includes('the zh-cn pack clip is not usable') && line.includes('using the English reference')), logs.join('|'));
    } finally { await server.close(); }
  });
});

test('the Mistral voice reads the pack\'s prepared slot (same signature) and makes it in the pack\'s own prepared/ folder when it is missing', async () => {
  await folder(async root => {
    const {packs, clips} = await installed(root);
    const server = await serve(), encoded = [];
    // A stand-in encoder (ffmpeg is not needed to test the slot): an "Ogg" smaller than the WAV.
    const encode = async wav => { encoded.push(wav.length); return Buffer.concat([Buffer.from('OggS'), wav.subarray(0, 200)]); };
    const preparers = new Map();
    const prepare = (bytes, options) => {
      if (!preparers.has(options.slots)) preparers.set(options.slots, createReferencePreparer({cacheDirectory: options.slots, ffmpeg: async () => 'ffmpeg', encode}));
      return preparers.get(options.slots)(bytes, options);
    };
    const first = cloudVoice(server, packs, {prepare});
    const made = await first.reference('panam-palmer', 'zh');
    assert.equal(made.format, 'ogg'); assert.equal(made.cached, false); assert.equal(made.source, 'language-pack:zh-cn');
    assert.deepEqual(encoded.length, 1);
    const slots = resolve(root, 'multilingual', 'zh-cn', 'prepared');
    assert.deepEqual((await readdir(slots)).sort(), ['panam-palmer.json', 'panam-palmer.ogg']);
    const meta = JSON.parse(await readFile(resolve(slots, 'panam-palmer.json'), 'utf8'));
    assert.equal(meta.signature, createReferencePreparer({ffmpeg: async () => 'ffmpeg'}).signature(sha256(clips['panam-palmer'])), 'the signature names the clip and the settings, as for any slot');
    // A new service (a new process): the slot is found, nothing is encoded again.
    const second = cloudVoice(server, packs, {prepare: (bytes, options) => createReferencePreparer({cacheDirectory: options.slots, ffmpeg: async () => 'ffmpeg',
      encode: async () => { throw Error('the slot should have been read'); }})(bytes, options)});
    const read = await second.reference('panam-palmer', 'zh');
    assert.equal(read.cached, true); assert.equal(read.format, 'ogg');
    assert.equal(read.base64, made.base64);
    // The request carries the slot's bytes, not the 19 KB WAV.
    await second.synthesizeStream('panam-palmer', 'Hello there.', {onPcm() {}, language: 'zh'});
    assert.ok(refOf(server.requests.at(-1)).length < 400);
    // The English reference of the same key has no slot in the pack's folder.
    const english = await second.reference('panam-palmer');
    assert.equal(english.source !== 'language-pack:zh-cn', true);
    await server.close();
  });
});

test('the archetype slots follow the English archetype rule (one clip of the joined reference), and V\'s clip is a named one', async () => {
  await folder(async root => {
    const {packs} = await installed(root);
    const server = await serve(), seen = [];
    try {
      const voice = cloudVoice(server, packs, {prepare: async (bytes, options) => { seen.push(options); return null; }});
      await voice.reference('resident-female', 'zh'); await voice.reference('v-male', 'zh'); await voice.reference('panam-palmer', 'zh');
      const by = key => seen.find(options => options.key === key);
      assert.equal(by('panam-palmer').sha256, sha256(sineWav({seconds: 0.4, frequency: 200})));
      assert.equal(by('v-male').slots, resolve(root, 'multilingual', 'zh-cn', 'prepared'));
      // One clip only (nothing to choose between): the archetype's source hash is the clip's own, as for a named one.
      assert.equal(by('resident-female').sha256, sha256(sineWav({seconds: 0.4, frequency: 240})));
    } finally { await server.close(); }
  });
});

test('through the voice selection: the head and the tail of one reply both ask the Mistral voice for the pack\'s clip', async () => {
  await folder(async root => {
    const {packs, clips} = await installed(root);
    const server = await serve();
    try {
      const cloud = cloudVoice(server, packs);
      const voices = Object.fromEntries(OMNI_KEYS.map(key => [key, reference(key)]));
      const voice = new VoiceSelection(pocketSettings(pocketVoices()), {voxtral: cloud, languagePacks: packs,
        omniConfigs: {short: {}, long: {version: 2, provider: 'hybrid', engine: 'omnivoice', voices}},
        factory: (config, {onState}) => ({loaded: false, hasProfile: () => true, profileReady: () => true, async start() { this.loaded = true; onState({state: 'ready', resident: true}); },
          async prepareProfile(name) { return {provider: 'pocket', ready: true, profile: name}; }, async close() { onState({state: 'stopped'}); }})});
      voice.update({voiceProvider: 'voxtral'}, null, false); await voice.start();
      assert.equal(voice.cloudActive, true);
      const utterance = new Utterance(), head = sink(), tail = sink();
      await Promise.all([voice.synthesizeStream('panam-palmer', '你好，V。', {onPcm: head.onPcm, utterance, role: 'head', language: 'zh'}),
        voice.synthesizeStream('panam-palmer', '今晚我能为你做什么？', {onPcm: tail.onPcm, utterance, role: 'tail', language: 'zh'})]);
      assert.equal(server.requests.length, 2);
      assert.deepEqual(server.requests.map(refOf), [clips['panam-palmer'], clips['panam-palmer']]);
      await voice.close();
    } finally { await server.close(); }
  });
});

// ---- the bridge wires it all, and does nothing per frame ---------------------------------------------------------------------------------

test('the bridge finds the packs once at start, hands them to both voices, re-scans from the settings poll, and names the pack clip in the routing line', async () => {
  const bridge = await readFile(resolve(import.meta.dirname, 'convai-bridge.mjs'), 'utf8');
  assert.match(bridge, /const languagePacks = new VoiceLanguagePacks\(\{roots: referenceRoots,/);
  assert.match(bridge, /await languagePacks\.scan\(\)/);
  assert.match(bridge, /referenceRoot: voxtralReferenceRoot, playerRoot: playerVoices\.folder, languagePacks,/);
  assert.match(bridge, /voxtral:voxtralVoice,languagePacks,/);
  assert.match(bridge, /void languagePacks\.refresh\(\)/);
  assert.match(bridge, /languageSet: languagePackFor\(reply\?\.engine, reply\?\.language, voiceKey\)\?\.set/);
  assert.match(bridge, /supportReport = await SupportReportControl\.open\([\s\S]*?voiceLanguagePacks: languagePacks\.report\(\)/);
  // Pocket (English only) and the Convai voice never get a pack clip; only OmniVoice and the cloud voice do.
  const block = bridge.slice(bridge.indexOf('function languagePackFor('), bridge.indexOf('function referenceSetFor('));
  assert.match(block, /engine === 'omni'/); assert.match(block, /engine === 'pocket' && localVoice\.cloudActive/);
  assert.doesNotMatch(block, /convai/);
  // Developer mode: the capture is only begun when it is on; the poll reads the setting; nothing is asked per frame.
  assert.match(bridge, /replyCapture\.enabled \? replyCapture\.begin\(/);
  assert.match(bridge, /replyCapture\.update\(settings\)/);
  const speech = await readFile(resolve(import.meta.dirname, 'pocket-speech.mjs'), 'utf8');
  assert.match(speech, /capture\?\.push\(packet\)/);
});

// ---- Developer mode: the last reply's audio and its reference ---------------------------------------------------------------------------

test('Developer mode keeps the last reply (WAV and the reference it used); with it off nothing is held or written', async () => {
  await folder(async root => {
    const capture = new LastReplyCapture({directory: resolve(root, 'debug')});
    assert.equal(capture.begin({engine: 'omni'}), undefined, 'off by default');
    assert.equal(capture.update({developerMode: false}), false);
    assert.equal(capture.update({developerMode: true}), true);
    assert.equal(capture.update(undefined), false, 'an unreadable settings file changes nothing');
    assert.equal(capture.enabled, true);
    const reply = capture.begin({engine: 'omni', voiceKey: 'panam-palmer', language: 'zh', reference: 'multilingual/zh-cn/picked/panam-palmer'});
    reply.addWav(sineWav({seconds: 0.5})); reply.addWav(sineWav({seconds: 0.25}));
    await capture.flush();
    const wav = await readFile(resolve(root, 'debug', 'last-reply-omni.wav')), info = JSON.parse(await readFile(resolve(root, 'debug', 'last-reply-omni.json'), 'utf8'));
    assert.equal(wav.toString('latin1', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 24000);
    assert.ok(Math.abs((wav.length - 44) / 2 / 24000 - 0.75) < 0.001, 'both phrases, in order');
    assert.deepEqual({engine: info.engine, voiceKey: info.voiceKey, language: info.language, reference: info.reference, seconds: info.seconds},
      {engine: 'omni', voiceKey: 'panam-palmer', language: 'zh', reference: 'multilingual/zh-cn/picked/panam-palmer', seconds: 0.75});
    assert.equal(JSON.stringify(info).includes('Hello'), false, 'no words of the reply');
    // A stream (the Mistral voice): packets are added, the file is written at the end.
    const stream = capture.begin({engine: 'voxtral', voiceKey: 'v-male', language: 'zh', reference: 'multilingual/zh-cn/v-voice/v-male'});
    stream.push({pcm: new Float32Array(2400).fill(0.1), sampleRate: 24000}); stream.push({pcm: new Float32Array(2400).fill(0.1), sampleRate: 24000}); stream.finish();
    await capture.flush();
    assert.equal(JSON.parse(await readFile(resolve(root, 'debug', 'last-reply-voxtral.json'), 'utf8')).seconds, 0.2);
    // Off again: nothing more is written.
    assert.equal(capture.update({developerMode: false}), true);
    assert.equal(capture.begin({engine: 'omni'}), undefined);
  });
});
