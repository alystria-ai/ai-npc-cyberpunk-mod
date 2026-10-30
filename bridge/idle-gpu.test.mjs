// Idle GPU work (Mei1429's report, 0.2.1: "about 3x GPU usage even with no companions and nothing in use"). Measured with the game closed:
// an idle OmniVoice worker, the hidden browser, Pocket and an idle llama-server all use 0 % of the card; what does use it with nobody
// speaking is the ahead-of-time work for characters that are only near V: OmniVoice prepares each one's voice (one hidden render, about
// 1.2 to 1.4 s at 16 steps, about twice that at Ultra's 32) and the local AI loads each one's persona (about 0.4 to 0.7 s). Both are now
// done when V starts to talk to a character, not when V walks past it. docs/RESOURCE_LIFECYCLE.md, "Nearby characters".
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {NearbyWarm} from './nearby-warm.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {attachTextProvider} from './text-provider-host.mjs';
import {PartyConnections} from './party-connections.mjs';

const flush = () => new Promise(done => setImmediate(done));

function nearbyFixture({gpu, partners = [], spawned = [], profiles = []} = {}) {
  let time = 1_000_000;
  const prepared = [];
  const connections = {setAmbient: async () => {}};
  const warm = new NearbyWarm({connections, now: () => time, canPrepare: () => true,
    prepareVoice: async profile => { prepared.push(profile); }, ...(gpu === undefined ? {} : {gpuVoice: () => gpu})});
  const document = () => JSON.stringify({updated: time, profiles, partners, spawned});
  return {warm, prepared, document};
}

test('with a GPU voice, characters that are only near are not prepared, however many pass by', async () => {
  const f = nearbyFixture({gpu: true, profiles: ['judy-alvarez', 'panam-palmer']});
  for (let pass = 0; pass < 3; pass++) { await f.warm.apply(f.document()); await flush(); }
  assert.deepEqual(f.prepared, [], 'a nearby character was prepared on the GPU with nobody speaking');
  assert.deepEqual(f.warm.diagnostic().voices, {});
  assert.deepEqual(f.warm.diagnostic().profiles, ['judy-alvarez', 'panam-palmer'], 'the connections still follow the nearby list');
});

test('with a GPU voice, partners and spawned characters are still prepared ahead, one at a time, partners first', async () => {
  const f = nearbyFixture({gpu: true, partners: ['river-ward'], spawned: ['lucy-kushinada'], profiles: ['judy-alvarez']});
  for (let pass = 0; pass < 4; pass++) { await f.warm.apply(f.document()); await flush(); }
  assert.deepEqual(f.prepared, ['river-ward', 'lucy-kushinada']);
});

test('without a GPU voice (Pocket, a cloud voice, no setting at all) nearby characters are prepared as before', async () => {
  for (const options of [{gpu: false}, {}]) {
    const f = nearbyFixture({...options, profiles: ['judy-alvarez', 'panam-palmer']});
    for (let pass = 0; pass < 3; pass++) { await f.warm.apply(f.document()); await flush(); }
    assert.deepEqual(f.prepared, ['judy-alvarez', 'panam-palmer']);
  }
});

test('the voice turning to OmniVoice later stops new nearby preparations without disturbing a partner', async () => {
  let gpu = false;
  const f = nearbyFixture({profiles: ['judy-alvarez']});
  f.warm.gpuVoice = () => gpu;
  await f.warm.apply(f.document()); await flush();
  assert.deepEqual(f.prepared, ['judy-alvarez']);
  gpu = true;
  const g = nearbyFixture({profiles: ['panam-palmer'], partners: ['river-ward']});
  g.warm.gpuVoice = () => gpu;
  for (let pass = 0; pass < 3; pass++) { await g.warm.apply(g.document()); await flush(); }
  assert.deepEqual(g.prepared, ['river-ward']);
});

test('a gpuVoice that throws counts as no GPU voice and never breaks the poll', async () => {
  const f = nearbyFixture({profiles: ['judy-alvarez']});
  f.warm.gpuVoice = () => { throw Error('state unreadable'); };
  await f.warm.apply(f.document()); await flush();
  assert.deepEqual(f.prepared, ['judy-alvarez']);
});

test('VoiceSelection.preparesOnGpu: OmniVoice speaking the companions with playback on, nothing else', () => {
  const selection = props => Object.assign(Object.create(VoiceSelection.prototype), {closed: false, playbackEnabled: true, ...props});
  assert.equal(selection({provider: 'omni'}).preparesOnGpu, true);
  assert.equal(selection({provider: 'omni', playbackEnabled: undefined}).preparesOnGpu, true, 'playback defaults to on');
  assert.equal(selection({provider: 'omni', playbackEnabled: false}).preparesOnGpu, false, 'playback Off prepares nothing');
  assert.equal(selection({provider: 'omni', closed: true}).preparesOnGpu, false);
  assert.equal(selection({provider: 'pocket'}).preparesOnGpu, false, 'Pocket prepares on the CPU');
  assert.equal(selection({provider: 'convai'}).preparesOnGpu, false);
  assert.equal(selection({provider: 'text'}).preparesOnGpu, false, 'a local voice that cannot run prepares nothing');
});

test('the local AI does not load the persona of a character that is only near; the composer and the other roles still do', async () => {
  const prewarmed = [];
  const textHost = {prewarm: config => { prewarmed.push(config.local.profileKey); return Promise.resolve(); }};
  const host = {reply: async () => ({}), prepare: async () => ({}), warm: async () => ({}), readiness: async () => ({}),
    lateEmotion: async () => ({}), refreshIdle: async () => true, voiceChannel: () => ({})};
  const provider = {active: true, route: 'local'};
  attachTextProvider(host, {provider, mistral: textHost, speech: {available: () => false}, prewarmVoice: false});
  const config = key => ({local: {profileKey: key, name: key}});
  assert.deepEqual(await host.warm(config('judy-alvarez'), {role: 'nearby'}), {connectionMs: 0, provider: 'local'});
  assert.deepEqual(prewarmed, [], 'a passer-by loaded a persona into the card');
  for (const role of ['target', 'party', 'invitation', 'partner', 'spawned', 'group']) await host.warm(config(role), {role});
  await host.warm(config('no-role'));
  assert.deepEqual(prewarmed, ['target', 'party', 'invitation', 'partner', 'spawned', 'group', 'no-role']);
  provider.route = 'mistral';
  await host.warm(config('mistral-key'), {role: 'target'});
  assert.equal(prewarmed.includes('mistral-key'), false, 'only the local route prewarms');
});

test('party connections hand the entry\'s role to the host that warms it', async () => {
  let time = 100000;
  const warms = [];
  const host = {retain: async () => {}, refreshIdle: async () => true, readiness: async () => ({present: true, ready: true}),
    warm: async (config, options) => { warms.push([config.characterId, options.role]); return {connectionMs: 1}; }};
  const connections = new PartyConnections({host, now: () => time, canWarm: () => true, isKnown: () => true,
    configFor: (profile, scope) => ({characterId: profile, scope}), onState: () => {}});
  connections.ingest({updated: time, profiles: ['alex']});
  await connections.setNearby(['judy']);
  for (const advance of [0, 500, 500]) { time += advance; await connections.maintain(); await flush(); }
  assert.deepEqual(warms, [['alex', 'party'], ['judy', 'nearby']]);
});

// The bridge's wiring, checked against its source (the bridge is a script: importing it would start it). The helper itself is run
// against stand-ins, so the behaviour is tested, not just its presence.
const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
function warmTalkTargetsWith(stand) {
  const start = bridge.indexOf('function warmTalkTargets(');
  assert.ok(start > 0, 'warmTalkTargets is missing from the bridge');
  let depth = 0, end = -1;
  for (let at = bridge.indexOf(') {', start) + 2; at < bridge.length; at++) {
    if (bridge[at] === '{') depth++;
    if (bridge[at] === '}' && --depth === 0) { end = at + 1; break; }
  }
  const source = bridge.slice(start, end);
  return new Function('stopped', 'ids', 'localVoice', 'mistral', 'mistralHost', 'profileFor', 'roster', 'multilingual', 'mistralMemory', 'memoryNamespace', 'wantVoiceClips',
    `${source}\nreturn warmTalkTargets;`)(stand.stopped ?? false, stand.ids, stand.localVoice, stand.mistral, stand.mistralHost,
    stand.profileFor, [], stand.multilingual ?? {fixed: null}, stand.mistralMemory ?? {warmFor: () => false}, {keyFor: key => key}, stand.wantVoiceClips ?? (() => null));
}

test('warmTalkTargets prepares an OmniVoice voice and a local persona for the people V talks to, and nothing otherwise', () => {
  const log = [];
  const stand = {ids: {'judy-alvarez': 1, 'panam-palmer': 2},
    localVoice: {preparesOnGpu: true, usesProfile: key => key !== 'panam-palmer', prepareProfile: key => { log.push(['voice', key]); return Promise.resolve(); }},
    mistral: {active: true, route: 'local'},
    mistralHost: {prewarm: config => { log.push(['persona', config.local.profileKey, config.local.name]); return Promise.resolve(); }},
    profileFor: ({profileKey}) => ({name: profileKey.toUpperCase()})};
  const warm = warmTalkTargetsWith(stand);
  warm(['judy-alvarez', 'judy-alvarez', 'panam-palmer', 'stranger', 7]);
  // The local server has one slot and a newer persona warm-up for another character stops the older: only the first speaker's persona is read.
  assert.deepEqual(log, [['voice', 'judy-alvarez'], ['persona', 'judy-alvarez', 'JUDY-ALVAREZ']]);
  log.length = 0;
  stand.localVoice.usesProfile = () => true;
  warm(['judy-alvarez', 'panam-palmer']);
  assert.deepEqual(log, [['voice', 'judy-alvarez'], ['persona', 'judy-alvarez', 'JUDY-ALVAREZ'], ['voice', 'panam-palmer']],
    'a group: every voice is prepared, one persona is read (a second warm-up would stop the first)');
  log.length = 0;
  warm(['judy-alvarez'], {persona: false});
  assert.deepEqual(log, [['voice', 'judy-alvarez']], 'a turn that has begun must not queue a prefill in front of its own request');
  // The memory embedder starts with a private talk (one target) on a text route, never for a group and never for a turn that has begun.
  stand.mistralMemory = {warmFor: key => { log.push(['memory', key]); return true; }};
  const warmWithMemory = warmTalkTargetsWith(stand);
  log.length = 0;
  warmWithMemory(['judy-alvarez']);
  assert.deepEqual(log, [['memory', 'judy-alvarez'], ['voice', 'judy-alvarez'], ['persona', 'judy-alvarez', 'JUDY-ALVAREZ']]);
  log.length = 0;
  warmWithMemory(['judy-alvarez', 'panam-palmer']);
  assert.equal(log.some(item => item[0] === 'memory'), false, 'a group retrieves nothing');
  log.length = 0;
  warmWithMemory(['judy-alvarez'], {persona: false});
  assert.equal(log.some(item => item[0] === 'memory'), false);
  stand.mistral.active = false;
  log.length = 0;
  warmWithMemory(['judy-alvarez']);
  assert.equal(log.some(item => item[0] === 'memory'), false, 'Convai answering keeps its own memory');
  stand.mistral.active = true;
  log.length = 0;
  stand.localVoice.preparesOnGpu = false; stand.mistral.route = 'mistral';
  warm(['judy-alvarez']);
  assert.deepEqual(log, [], 'Pocket, a cloud voice and a cloud text route have nothing of this kind to do');
  stand.localVoice.preparesOnGpu = true;
  assert.doesNotThrow(() => warm(null));
});

test('warmTalkTargets with a fixed reply language prepares the pack clip of the voice, and the English voice only when the pack has no clip of it', async () => {
  const log = [];
  const stand = {ids: {'judy-alvarez': 1, 'panam-palmer': 2}, multilingual: {fixed: 'pl'},
    localVoice: {preparesOnGpu: true, usesProfile: () => true, prepareProfile: key => { log.push(['voice', key]); return Promise.resolve(); },
      warmOmniLanguage: (key, language) => { log.push(['pack', key, language]); return Promise.resolve(key === 'judy-alvarez'); }},
    mistral: {active: false}, mistralHost: {}, profileFor: () => null};
  const warm = warmTalkTargetsWith(stand);
  warm(['judy-alvarez', 'panam-palmer']);
  await new Promise(done => setImmediate(done));
  assert.deepEqual(log, [['pack', 'judy-alvarez', 'pl'], ['pack', 'panam-palmer', 'pl'], ['voice', 'panam-palmer']]);
  // English fixed, or no fixed language: the English voice, as before.
  for (const fixed of ['en', null]) {
    log.length = 0; stand.multilingual.fixed = fixed;
    warm(['judy-alvarez']);
    assert.deepEqual(log, [['voice', 'judy-alvarez']], String(fixed));
  }
  // A pack lookup that fails prepares nothing and throws nowhere.
  log.length = 0; stand.multilingual.fixed = 'pl'; stand.localVoice.warmOmniLanguage = () => Promise.reject(Error('x'));
  assert.doesNotThrow(() => warm(['judy-alvarez']));
  await new Promise(done => setImmediate(done));
  assert.deepEqual(log, []);
});

test('the bridge asks for it at the composer, at the talk key and at the start of a turn, and nearby preparation follows the GPU', () => {
  assert.match(bridge, /gpuVoice: \(\) => localVoice\.preparesOnGpu/, 'the nearby warm-up is not told whether a voice costs GPU time');
  assert.match(bridge, /vVoice\.warmUp\(\);\s*warmTalkTargets\(hint\.audience\);\s*const opening = connections\.setComposer/,
    'the composer hint does not prepare who V is about to talk to');
  assert.match(bridge, /void mic\.start\(prepared\.input, realtimeConfig\(prepared\.input\)\)[^\n]*\n[^\n]*\n\s*warmTalkTargets\(\[prepared\.input\.profileKey, \.\.\.\(prepared\.input\.group\?\.audience \?\? \[\]\)\]\);/,
    'the talk key does not prepare the speaker');
  assert.match(bridge, /companionVision\.beginTurn\(input\);(?:\s*\/\/[^\n]*|\s*companionVision\.stageForNext\([^\n]*\);)*\s*(?:if \(input\.reaction\?\.kind !== 'scripted'\) )?warmTalkTargets\(\[input\.profileKey\], \{persona: false\}\);/,
    'a turn does not make sure its voice is prepared');
});
