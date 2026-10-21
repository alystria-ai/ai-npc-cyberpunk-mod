import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {VoiceSelection, blockedByWindows} from './voice-selection.mjs';
import {LOCAL_VOICE_KEYS, ResidentVoice, NO_CUDA_FAILURE} from './resident-voice.mjs';
import {abortable} from './transport-pool.mjs';

const pocketSettings = voices => ({version:1,provider:'pocket',engine:'pocket-tts',voices,
  runtime:Object.fromEntries(['sourceDirectory','exportDirectory','referenceDirectory','workDirectory'].map(key=>[key,resolve('fixture',key)])),
  model:{sha256:'a'.repeat(64),configSha256:'b'.repeat(64),tokenizerSha256:'c'.repeat(64),receiptSha256:'d'.repeat(64),
    inputIdentity:'e'.repeat(64),selectedStep:1500}});

const tick = () => new Promise(done => setImmediate(done));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {resolve, promise}; };

test('Pocket draft and Invite warm optional phone analysis outside reply onset, then close it once',async()=>{
  const warm=defer(),events=[];
  const phoneAnalysis={setWanted:value=>events.push(['wanted',value]),
    prepare:()=>{events.push(['prepare']);return warm.promise;},retire:async()=>events.push(['retire']),
    close:async()=>events.push(['close'])};
  const h=fixture({phoneAnalysis});h.voice.update({voiceProvider:'convai'},null,false);
  h.voice.prepare({provider:'pocket'});assert.ok(events.some(([kind,value])=>kind==='wanted'&&value));
  h.voice.update({voiceProvider:'pocket'},null,false);let complete=false;
  const invited=h.voice.prepareProfile('judy-alvarez').then(value=>{complete=true;return value;});
  await tick();await tick();assert.equal(h.workers[0].loaded,true);assert.equal(complete,false);
  assert.ok(events.some(([kind])=>kind==='prepare'));assert.equal(h.workers[0].calls.length,0);
  warm.resolve({ready:true});assert.equal((await invited).ready,true);
  const first=h.voice.close(),second=h.voice.close();assert.equal(first,second);await first;
  assert.equal(events.filter(([kind])=>kind==='close').length,1);
});

test('an owned Pocket reply holds its analyser while a provider change waits for the idle boundary',async()=>{
  const events=[],phoneAnalysis={setWanted:value=>events.push(['wanted',value]),prepare:async()=>({ready:true}),
    retire:async()=>events.push(['retire']),close:async()=>events.push(['close'])};
  const h=fixture({phoneAnalysis});await h.voice.start();events.length=0;
  h.voice.update({voiceProvider:'convai'},null,true);
  assert.equal(h.voice.provider,'pocket');assert.ok(events.every(([kind,value])=>kind!=='wanted'||value));
  assert.equal(events.some(([kind])=>kind==='retire'),false);
  h.voice.update({voiceProvider:'convai'},null,false);await h.voice.retiring;
  assert.ok(events.some(([kind,value])=>kind==='wanted'&&!value));assert.ok(events.some(([kind])=>kind==='retire'));
  await h.voice.close();
});

test('optional analyser unavailability preserves voice readiness while Invite cancellation still propagates',async()=>{
  const unavailable={setWanted(){},prepare:async()=>{throw Error('Optional assets missing');},retire:async()=>{},close:async()=>{}};
  const h=fixture({phoneAnalysis:unavailable});assert.equal((await h.voice.prepareProfile('judy-alvarez')).ready,true);await h.voice.close();
  const waiting=defer(),phoneAnalysis={...unavailable,prepare:({signal})=>abortable(waiting.promise,signal)};
  const next=fixture({phoneAnalysis}),controller=new AbortController();
  const invited=next.voice.prepareProfile('judy-alvarez',{signal:controller.signal});await tick();await tick();
  controller.abort();await assert.rejects(invited,{name:'AbortError'});waiting.resolve({ready:true});await next.voice.close();
});
function fixture({holdWarm = false, holdClose = false, extraProfiles = {}, unavailableProfiles = [], omniConfig = {}, phoneAnalysis, voiceOptions = {}} = {}) {
  const workers = [], states = []; let live = 0, peak = 0;
  const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(key => [key, {
    reference: `runtime/voice-references/${key}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.',
  }]));
  Object.assign(voices, extraProfiles);
  const voice = new VoiceSelection(pocketSettings(voices), {omniConfig, phoneAnalysis, ...voiceOptions, onState: value => states.push(value),
    factory: (config, {onState}) => {
      const warm = defer(), released = defer(); let loaded = false, owned = false;
      const worker = {warm, released, starts: 0, closes: 0, calls: [],
        get loaded() { return loaded; }, hasProfile(key) { return Object.hasOwn(config.voices, key) && !unavailableProfiles.includes(key); },
        profileReady(key) { return loaded && this.hasProfile(key); },
        async prepareProfile(key) { return {provider: 'pocket', ready: this.profileReady(key), profile: key}; },
        async start() {
          this.starts++; owned = true; live++; peak = Math.max(peak, live);
          if (holdWarm) await warm.promise;
          loaded = true;
          onState({state: 'ready', resident: true, workerPid: workers.length, gpuVramBytes: 0});
        },
        async synthesizeStream(profile, text, options) { this.calls.push({profile, text, ...options}); return {audio: 'wav'}; },
        async close() {
          this.closes++;
          if (holdWarm && owned) await warm.promise;
          if (holdClose && owned) await released.promise;
          if (owned) live--;
          owned = loaded = false; onState({state: 'stopped', resident: false});
        },
      };
      workers.push(worker); return worker;
    }});
  return {voice, workers, states, live: () => live, peak: () => peak};
}

test('saved Convai selection starts without loading a model; hybrid warms one shared worker', async () => {
  const h = fixture();
  h.voice.request({voiceProvider: 'convai', omniSteps: 16}); assert(h.voice.applyWhenIdle(false));
  await h.voice.start();
  assert.equal(h.workers.length, 0); assert.equal(h.voice.state, 'remote');
  for (const key of LOCAL_VOICE_KEYS) assert.equal(h.voice.usesProfile(key), false);
  h.voice.request({voiceProvider: 'pocket'}); h.voice.applyWhenIdle(false);
  await h.voice.start(); await h.voice.start();
  for (const key of LOCAL_VOICE_KEYS) assert.equal(h.voice.usesProfile(key), true);
  assert.equal(h.voice.usesProfile('blue-moon'), false);
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].starts, 1);
  await h.voice.synthesizeStream('judy-alvarez', 'Hi'); assert.equal(h.workers[0].calls[0].steps, undefined);
  await h.voice.close(); assert.equal(h.live(), 0);
});

test('Pocket never receives a voice tag: fillers, ellipses and dashes reach it, the tags do not', async () => {
  const h = fixture();
  h.voice.request({voiceProvider: 'pocket'}); h.voice.applyWhenIdle(false);
  await h.voice.start();
  await h.voice.synthesizeStream('judy-alvarez', 'Uh... [laughter] okay — [sigh] fine. [surprise-oh]');
  assert.equal(h.workers[0].calls[0].text, 'Uh... okay — fine.');
  await h.voice.close();
});

test('wider registry routes additional prepared characters locally and incomplete profiles remotely', async () => {
  const h = fixture({extraProfiles: {alex: {reference: 'runtime/voice-references/alex.wav',
    sha256: 'b'.repeat(64), transcript: 'Hello.'}, 'blue-moon': {status: 'unprepared'}}});
  assert.equal(h.voice.usesProfile('alex'), true);
  assert.equal(h.voice.usesProfile('blue-moon'), false);
  assert.equal(h.voice.profileReady('alex'), false);
  const prepared = await h.voice.prepareProfile('alex');
  assert.equal(prepared.provider, 'pocket'); assert.equal(prepared.ready, true);
  assert.equal(h.voice.profileReady('alex'), true);
  assert.deepEqual(await h.voice.prepareProfile('blue-moon'), {provider: 'text', ready: true, reason: 'unprepared'});
  await h.voice.synthesizeStream('alex', 'Additional character.');
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].calls[0].profile, 'alex');
  assert.deepEqual(h.voice.profileKeys, [...LOCAL_VOICE_KEYS, 'alex'].sort());
  await h.voice.close();
});

// A character the player made (bridge/custom-characters.mjs) has a voice of its own only when it was given a clip before the service started;
// until then it is spoken by the resident voice of its gender, always the same one of the variants, and prepared and read as that voice.
test('a key with no voice of its own is spoken by its alias: one voice for good, routed and prepared as the alias, and unaffected when it has its own', async () => {
  const entry = key => ({reference: `runtime/voice-references/${key}.wav`, sha256: 'c'.repeat(64), transcript: 'Ready when you are, V.'});
  const extraProfiles = Object.fromEntries(['resident-female', 'resident-female-v2', 'resident-female-v3', 'resident-male', 'custom-own-aaaa'].map(key => [key, entry(key)]));
  const aliases = key => key === 'custom-she-aaaa' || key === 'custom-her-bbbb' ? 'resident-female' : key === 'custom-he-cccc' ? 'resident-male' : null;
  const h = fixture({extraProfiles, voiceOptions: {aliases}});
  h.voice.request({voiceProvider: 'pocket'}); h.voice.applyWhenIdle(false);
  await h.voice.start();
  for (const key of ['custom-she-aaaa', 'custom-her-bbbb', 'custom-he-cccc', 'custom-own-aaaa']) assert.equal(h.voice.usesProfile(key), true, key);
  assert.equal(h.voice.usesProfile('custom-ghost-dddd'), false, 'an alias that names nothing is no voice');
  assert.equal(h.voice.profileReady('custom-she-aaaa'), true);
  // One voice of the alias for good: the body that speaks today (the seed) does not decide it, the character's own key does.
  const voice = h.voice.voiceKeyFor('custom-she-aaaa', '111ULL');
  assert(['resident-female', 'resident-female-v2', 'resident-female-v3'].includes(voice), voice);
  for (const seed of ['222ULL', '333ULL', undefined, null]) assert.equal(h.voice.voiceKeyFor('custom-she-aaaa', seed), voice);
  assert.equal(h.voice.voiceKeyFor('custom-he-cccc', '111ULL'), 'resident-male');
  assert.equal(h.voice.voiceKeyFor('custom-ghost-dddd', 'x'), 'custom-ghost-dddd', 'not spoken locally: the key is kept');
  // A character with a voice of its own is not aliased, and a roster character is untouched.
  assert.equal(h.voice.voiceKeyFor('custom-own-aaaa', '111ULL'), 'custom-own-aaaa');
  assert.equal(h.voice.voiceKeyFor('judy-alvarez', '111ULL'), 'judy-alvarez');
  // The worker is asked for the alias's voice, never for a key it does not know.
  assert.equal((await h.voice.prepareProfile('custom-he-cccc')).profile, 'resident-male');
  await h.voice.synthesizeStream('custom-he-cccc', 'Hi there.');
  await h.voice.synthesizeStream(voice, 'And again.');
  await h.voice.synthesizeStream('custom-own-aaaa', 'My own voice.');
  assert.deepEqual(h.workers[0].calls.map(call => call.profile), ['resident-male', voice, 'custom-own-aaaa']);
  await h.voice.close();
  // Without the option nothing is aliased.
  const plain = fixture({extraProfiles});
  plain.voice.request({voiceProvider: 'pocket'}); plain.voice.applyWhenIdle(false);
  await plain.voice.start();
  assert.equal(plain.voice.usesProfile('custom-she-aaaa'), false);
  assert.equal(plain.voice.voiceKeyFor('custom-she-aaaa', 'x'), 'custom-she-aaaa');
  await plain.voice.close();
});

test('an absent reference discovered during startup becomes remote before invitation readiness', async () => {
  const h = fixture({holdWarm: true, unavailableProfiles: ['judy-alvarez']});
  const preparation = h.voice.prepareProfile('judy-alvarez'); await tick();
  assert.equal(h.voice.usesProfile('judy-alvarez'), true, 'configured route stays provisional during worker startup');
  h.workers[0].warm.resolve();
  await tick(); assert.equal(h.voice.usesProfile('judy-alvarez'), true);
  assert.equal(h.voice.availabilityPending, true);
  h.voice.applyWhenIdle(false);
  assert.deepEqual(await preparation, {provider: 'text', ready: true, reason: 'unavailable'});
  assert.equal(h.voice.usesProfile('judy-alvarez'), false);
  assert.equal(h.workers[0].calls.length, 0);
  await h.voice.close();
});

test('startup availability discovered during an owned turn remains staged until the idle routing boundary', async () => {
  const h = fixture({holdWarm: true, unavailableProfiles: ['judy-alvarez']});
  const starting = h.voice.start(); await tick();
  assert.equal(h.voice.usesProfile('judy-alvarez'), true);
  h.workers[0].warm.resolve(); await starting;
  assert.equal(h.voice.availabilityPending, true);
  assert.equal(h.voice.usesProfile('judy-alvarez'), true, 'worker discovery cannot change an owned turn route');
  assert.equal(h.voice.update({voiceProvider: 'pocket', omniSteps: 32}, null, true), false);
  assert.equal(h.voice.routeRevision, 0); assert.deepEqual(h.voice.consumeRouteChanges(), []);
  let complete = false;
  const preparation = h.voice.prepareProfile('judy-alvarez').then(value => { complete = true; return value; });
  await tick(); assert.equal(complete, false, 'Invite waits without holding the polling loop');
  assert(h.voice.update({voiceProvider: 'pocket', omniSteps: 32}, null, false));
  assert.equal(h.voice.usesProfile('judy-alvarez'), false); assert.equal(h.voice.routeRevision, 1);
  assert.deepEqual(h.voice.consumeRouteChanges(), ['judy-alvarez']); assert.deepEqual(h.voice.consumeRouteChanges(), []);
  assert.deepEqual(await preparation, {provider: 'text', ready: true, reason: 'unavailable'});
  await h.voice.close();
});

test('valid preparation waits for any staged routing commit and preserves exact speaker receipt', async () => {
  const h = fixture({holdWarm: true, unavailableProfiles: ['judy-alvarez']});
  const preparation = h.voice.prepareProfile('johnny-silverhand'); await tick();
  h.workers[0].warm.resolve(); await tick();
  assert.equal(h.voice.routingWaiters.size, 1);
  h.voice.applyWhenIdle(false);
  assert.deepEqual(await preparation, {provider: 'pocket', ready: true, profile: 'johnny-silverhand'});
  assert.equal(h.voice.profileReady('johnny-silverhand'), true);
  await h.voice.close();
});

test('cancel and shutdown release pending invitation routing waits without another model or remote conversation', async () => {
  const h = fixture({holdWarm: true, unavailableProfiles: ['judy-alvarez']});
  const starting = h.voice.start(); await tick(); h.workers[0].warm.resolve(); await starting;
  const controller = new AbortController();
  const first = h.voice.prepareProfile('judy-alvarez', {signal: controller.signal});
  await tick(); const cancelled = assert.rejects(first, /cancelled/); controller.abort(); await cancelled;
  assert.equal(h.voice.routingWaiters.size, 0);
  const second = h.voice.prepareProfile('judy-alvarez'); await tick();
  const closed = assert.rejects(second, /closed/); await h.voice.close(); await closed;
  assert.equal(h.voice.routingWaiters.size, 0); assert.equal(h.workers.length, 1);
  assert.equal(h.workers[0].calls.length, 0);
});

test('a pending Pocket selection cannot issue an early remote-ready invitation receipt during an owned turn', async () => {
  const h = fixture(); h.voice.update({voiceProvider: 'convai'}, null, false);
  h.voice.update({voiceProvider: 'pocket'}, null, true);
  await tick(); let ready = false;
  const preparation = h.voice.prepareProfile('judy-alvarez').then(receipt => { ready = true; return receipt; });
  await tick(); assert.equal(ready, false); assert.equal(h.voice.provider, 'convai');
  h.voice.update({voiceProvider: 'pocket'}, null, false);
  assert.deepEqual(await preparation, {provider: 'pocket', ready: true, profile: 'judy-alvarez'});
  await h.voice.close();
});

test('all physically quarantined references defer during an owned turn then retire the unusable model at idle', async () => {
  const h = fixture({holdWarm: true, unavailableProfiles: LOCAL_VOICE_KEYS});
  const starting = h.voice.start(); await tick(); h.workers[0].warm.resolve(); await starting;
  assert.equal(h.voice.availabilityPending, true); assert.equal(h.voice.wantsLocal, true);
  assert.equal(h.voice.applyWhenIdle(true), false);
  assert.equal(h.live(), 1); assert.equal(h.workers[0].closes, 0);
  for (const key of LOCAL_VOICE_KEYS) assert.equal(h.voice.usesProfile(key), true);
  const preparation = h.voice.prepareProfile('judy-alvarez'); await tick();
  assert(h.voice.applyWhenIdle(false)); await h.voice.retiring;
  assert.equal(h.live(), 0); assert.equal(h.voice.wantsLocal, false);
  assert.deepEqual(await preparation, {provider: 'text', ready: true, reason: 'unavailable'});
  for (const key of LOCAL_VOICE_KEYS) assert.equal(h.voice.usesProfile(key), false);
  h.voice.prepare({provider: 'pocket', steps: 32});
  await h.voice.start(); h.voice.update({voiceProvider: 'convai'}, null, false);
  h.voice.update({voiceProvider: 'pocket'}, null, false); await h.voice.start();
  assert.equal(h.workers.length, 1, 'known empty availability cannot create a restart/warmup loop');
  assert.equal(h.states.at(-1).resident, false); assert.equal(h.states.at(-1).gpuVramBytes, 0);
  await h.voice.close();
});

test('a voice configuration with no ready references never starts a speculative CPU worker', async () => {
  const voice = new VoiceSelection(pocketSettings({alex: {status: 'unprepared'}}), {factory() { throw Error('must not create worker'); }});
  voice.prepare({provider: 'pocket', steps: 32}); await voice.start();
  assert.equal(voice.configured, false); assert.equal(voice.usesProfile('alex'), false);
  assert.deepEqual(await voice.prepareProfile('alex'), {provider: 'text', ready: true, reason: 'unprepared'});
  await voice.close();
});

test('the frozen worker configuration retains explicit remote entries and legacy source-key compatibility', () => {
  const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(key => [key, key === 'judy-alvarez' ? {status: 'unprepared'} : {
    reference: `runtime/voice-references/${key}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.',
  }]));
  const voice = new VoiceSelection(pocketSettings(voices));
  assert.equal(voice.config.voices['judy-alvarez'].status, 'unprepared');
  assert.equal(voice.usesProfile('judy-alvarez'), false);
  assert.equal(voice.registry.status('judy-alvarez'), 'unprepared');
  voices['judy-alvarez'].status = 'ready';
  assert.equal(voice.config.voices['judy-alvarez'].status, 'unprepared');
});

test('provider stays fixed while a turn owns local generation; obsolete steps do not alter the one-step student', async () => {
  const h = fixture(); await h.voice.start();
  h.voice.request({voiceProvider: 'convai', omniSteps: 16});
  assert.equal(h.voice.applyWhenIdle(true), false);
  assert.equal(h.voice.provider, 'pocket'); assert.equal(h.voice.steps, undefined);
  assert.equal(h.states.at(-1).pending, true);
  await h.voice.synthesizeStream('judy-alvarez', 'First phrase');
  await h.voice.synthesizeStream('judy-alvarez', 'Last phrase');
  assert.deepEqual(h.workers[0].calls.map(call => call.steps), [undefined, undefined]);
  assert(h.voice.applyWhenIdle(false)); await h.voice.retiring;
  assert.equal(h.voice.provider, 'convai'); assert.equal(h.voice.steps, undefined);
  assert.equal(h.live(), 0); assert.equal(h.states.at(-1).resident, false);
  assert.equal(h.states.at(-1).gpuVramBytes, 0);
});

test('rapid switches cannot overlap workers or start a local choice that was superseded', async () => {
  const h = fixture({holdClose: true}); await h.voice.start();
  h.voice.request({voiceProvider: 'convai'}); h.voice.applyWhenIdle(false); await tick();
  assert.equal(h.voice.state, 'releasing'); assert.equal(h.live(), 1);
  h.voice.request({voiceProvider: 'pocket'}); h.voice.applyWhenIdle(false);
  await tick(); assert.equal(h.workers[1].starts, 0);
  h.voice.request({voiceProvider: 'convai'}); h.voice.applyWhenIdle(false);
  h.workers[0].released.resolve(); await h.voice.retiring;
  assert.equal(h.workers[1].starts, 0); assert.equal(h.peak(), 1); assert.equal(h.live(), 0);
  assert.equal(h.voice.state, 'remote');
});

test('switching while warming lets CPU initialization finish then releases it without stale ready state', async () => {
  const h = fixture({holdWarm: true}); const starting = h.voice.start(); await tick();
  h.voice.request({voiceProvider: 'convai'}); h.voice.applyWhenIdle(false);
  await tick(); assert.equal(h.workers[0].closes, 1);
  h.workers[0].warm.resolve(); await starting; await h.voice.retiring;
  assert.equal(h.workers[0].closes, 1); assert.equal(h.live(), 0);
  assert.equal(h.voice.state, 'remote');
  assert(!h.states.some(state => state.provider === 'convai' && state.state === 'ready'));
});

test('cancel during warmup releases the conversation immediately while shared initialization stays owned', async () => {
  const h = fixture({holdWarm: true}), controller = new AbortController();
  const first = h.voice.synthesizeStream('judy-alvarez', 'Cancelled during warmup', {signal: controller.signal});
  await tick(); const rejected = assert.rejects(first, /cancelled/);
  controller.abort(); await rejected;
  assert.equal(h.workers[0].closes, 0); assert.equal(h.workers[0].calls.length, 0);
  h.workers[0].warm.resolve(); await h.voice.start();
  await h.voice.synthesizeStream('judy-alvarez', 'New conversation');
  assert.equal(h.workers[0].calls.length, 1); assert.equal(h.workers.length, 1);
  await h.voice.close();
});

test('an unconfirmed retirement keeps replacement workers from starting', async () => {
  const h = fixture(); await h.voice.start();
  h.workers[0].close = async () => { throw Error('exit could not be confirmed'); };
  h.voice.request({voiceProvider: 'convai'}); h.voice.applyWhenIdle(false);
  await assert.rejects(h.voice.retiring, /exit could not be confirmed/);
  h.voice.request({voiceProvider: 'pocket'}); h.voice.applyWhenIdle(false);
  await assert.rejects(h.voice.start(), /exit could not be confirmed/);
  assert.equal(h.workers[1].starts, 0); assert.equal(h.peak(), 1);
  h.voice.request({voiceProvider: 'convai'}); h.voice.applyWhenIdle(false);
  await assert.rejects(h.voice.retiring, /exit could not be confirmed/);
});

test('malformed settings retain the valid selection; a withdrawn pending change is never applied', async () => {
  const h = fixture(); await h.voice.start();
  h.voice.request({voiceProvider: 'convai'}); h.voice.applyWhenIdle(true);
  h.voice.request({voiceProvider: 'pocket'}); assert.equal(h.voice.applyWhenIdle(false), false);
  h.voice.request({voiceProvider: 'unknown', omniSteps: 8}); h.voice.request(null);
  assert.equal(h.voice.applyWhenIdle(false), false); assert.equal(h.voice.steps, undefined);
  assert.equal(h.voice.provider, 'pocket'); assert.equal(h.workers.length, 1);
  await h.voice.close(); assert.equal(h.voice.state, 'stopped');
});

test('a draft warms one model before Apply while saved routing stays Convai',async()=>{
  const h=fixture();
  h.voice.update({voiceProvider:'convai',omniSteps:32},null,false);await tick();
  assert.equal(h.workers.length,0,'initial saved Convai does not create a speculative worker');
  h.voice.update({voiceProvider:'convai',omniSteps:32},{provider:'pocket',steps:16},true);
  await tick();await h.voice.start();
  assert.equal(h.workers.length,1);assert.equal(h.workers[0].starts,1);
  assert.equal(h.voice.provider,'convai');assert.equal(h.voice.usesProfile('judy-alvarez'),false);
  assert.equal(h.voice.pending,false);assert.equal(h.states.at(-1).preparationOnly,true);
  assert.equal(h.states.at(-1).previewActive,true);
  h.voice.update({voiceProvider:'pocket',omniSteps:16},null,false);
  await h.voice.synthesizeStream('judy-alvarez','Hi');
  assert.equal(h.workers.length,1);assert.equal(h.workers[0].starts,1);
  assert.equal(h.workers[0].calls[0].steps,undefined);assert.equal(h.states.at(-1).preparationOnly,false);
  await h.voice.close();
});

test('committed Pocket prepares during a remote reply and changes routing only afterward',async()=>{
  const h=fixture({holdWarm:true});h.voice.update({voiceProvider:'convai'},null,false);
  assert.equal(h.voice.update({voiceProvider:'pocket',omniSteps:16},null,true),false);
  await tick();assert.equal(h.workers[0].starts,1);
  assert.equal(h.voice.provider,'convai');assert.equal(h.voice.steps,undefined);
  h.workers[0].warm.resolve();await h.voice.start();
  assert(h.voice.update({voiceProvider:'pocket',omniSteps:16},null,false));
  assert.equal(h.voice.provider,'pocket');assert.equal(h.voice.steps,undefined);
  assert.equal(h.workers[0].starts,1);await h.voice.close();
});

test('Revert releases preview-only memory; rapid reselect waits for confirmed retirement',async()=>{
  const h=fixture({holdClose:true});h.voice.update({voiceProvider:'convai'},null,false);
  h.voice.prepare({provider:'pocket',steps:32});await h.voice.start();
  h.voice.update({voiceProvider:'convai'},null,true);await tick();
  assert.equal(h.workers[0].closes,1);assert.equal(h.voice.state,'releasing');
  h.voice.prepare({provider:'pocket',steps:16});await tick();
  assert.equal(h.workers[1].starts,0);
  h.workers[0].released.resolve();await h.voice.start();
  assert.equal(h.workers[1].starts,1);assert.equal(h.peak(),1);
  h.workers[1].released.resolve();await h.voice.close();assert.equal(h.live(),0);
});

test('a remote draft does not unload an applied Pocket choice or alter an owned turn',async()=>{
  const h=fixture();await h.voice.start();
  h.voice.update({voiceProvider:'pocket',omniSteps:32},{provider:'convai',steps:16},true);
  assert.equal(h.workers[0].closes,0);assert.equal(h.voice.provider,'pocket');
  await h.voice.synthesizeStream('judy-alvarez','Current phrase');
  assert.equal(h.workers[0].calls[0].steps,undefined);
  h.voice.update({voiceProvider:'convai',omniSteps:16},null,true);
  assert.equal(h.workers[0].closes,0);
  h.voice.update({voiceProvider:'convai',omniSteps:16},null,false);await h.voice.retiring;
  assert.equal(h.workers[0].closes,1);assert.equal(h.live(),0);
});

test('legacy saved hybrid stays Omni while a saved Convai selection is preserved',async()=>{
  const h=dualFixture({start:'convai'});await h.voice.start();
  assert.equal(h.workers.length,0);assert.equal(h.voice.provider,'convai');
  h.voice.request({voiceProvider:'hybrid',omniSteps:16});h.voice.applyWhenIdle(false);await h.voice.start();
  assert.equal(h.voice.provider,'omni');assert.equal(h.workers.length,1);assert.equal(h.voice.steps,16);
  assert.equal(h.voice.fallback,null);
  await h.voice.close();
});

function dualFixture({holdClose=false,start,fail=[]}={}){
  const calls=[],workers=[],states=[];let live=0,peak=0;
  const voices={'johnny-silverhand':{reference:'runtime/voice-references/johnny.wav',sha256:'a'.repeat(64),transcript:'Original line.'},
    'blue-moon':{status:'unprepared'}};
  const factory=backend=>(config,{onState})=>{
    const released=defer();let loaded=false,owned=false;
    const worker={backend,released,starts:0,closes:0,steps:32,get loaded(){return loaded;},
      hasProfile:key=>Object.hasOwn(config.voices,key)&&!config.voices[key].status?.match(/unprepared|unavailable/),
      profileReady(key){return loaded&&this.hasProfile(key);},
      setSteps(value){this.steps=value;},
      async start(){this.starts++;
        if(fail.includes(backend)){this.failure=Error(backend+' worker failed');onState({state:'error'});throw this.failure;}
        owned=true;live++;peak=Math.max(peak,live);loaded=true;calls.push('start:'+backend);
        onState({state:'ready',resident:true,engine:backend==='omni'?'omnivoice':'pocket-tts'});},
      async prepareProfile(profile){return{provider:backend==='omni'?'omnivoice':'pocket',ready:true,profile};},
      async synthesize(profile,text,options){calls.push(['synthesize',backend,profile,text,options.steps]);return{};},
      async synthesizeStream(profile,text){calls.push(['stream',backend,profile,text]);return{};},
      async close(){this.closes++;calls.push('close:'+backend);if(holdClose&&owned)await released.promise;
        if(owned)live--;loaded=owned=false;onState({state:'stopped',resident:false});},};
    workers.push(worker);return worker;
  };
  const voice=new VoiceSelection(pocketSettings(voices),{onState:value=>states.push(value),factory:factory('pocket'),
    omniConfig:{version:2,provider:'hybrid',engine:'omnivoice',steps:32,voices},omniFactory:factory('omni')});
  // The default is Pocket TTS; a test that needs another committed start asks for it.
  if(start){voice.request({voiceProvider:start});voice.applyWhenIdle(false);}
  return{voice,calls,workers,states,live:()=>live,peak:()=>peak};
}

test('the default is Pocket TTS; both Omni qualities share the one warmed model and cache',async()=>{
  const fresh=dualFixture();
  assert.equal(fresh.voice.provider,'pocket');assert.equal(fresh.voice.requestedProvider,'pocket');
  assert.equal(fresh.voice.fallback,null);await fresh.voice.close();
  const h=dualFixture({start:'omni'});await h.voice.start();
  assert.equal(h.voice.provider,'omni');assert.equal(h.voice.requestedProvider,'omni');assert.equal(h.voice.steps,16);
  assert.equal(h.workers[0].backend,'omni');assert.equal(h.voice.fallback,null);
  h.voice.update({voiceProvider:'omni',omniSteps:32},null,false);await h.voice.start();
  assert.equal(h.peak(),1);assert.equal(h.workers.length,1);assert.equal(h.workers[0].steps,32);
  assert.deepEqual(await h.voice.prepareProfile('johnny-silverhand'),
    {provider:'omni',ready:true,profile:'johnny-silverhand'});
  await h.voice.synthesize('johnny-silverhand','First sentence.');
  h.voice.update({voiceProvider:'omni',omniSteps:16},null,false);await h.voice.start();
  await h.voice.synthesize('johnny-silverhand','Second sentence.');
  assert.equal(h.workers.length,1);assert.equal(h.workers[0].starts,1);assert.equal(h.workers[0].closes,0);
  assert.deepEqual(h.calls.filter(value=>Array.isArray(value)).map(value=>value.at(-1)),[32,16]);
  assert.deepEqual(await h.voice.prepareProfile('blue-moon'),{provider:'text',ready:true,reason:'unprepared'});
  h.voice.update({voiceProvider:'pocket'},null,false);await h.voice.start();
  assert.equal(h.voice.provider,'pocket');assert.equal(h.workers[0].closes,1);assert.equal(h.workers[1].backend,'pocket');
  assert.equal(h.peak(),1);assert.equal(h.voice.fallback,null);
  h.voice.update({voiceProvider:'convai',omniSteps:32},null,false);await h.voice.retiring;assert.equal(h.live(),0);
  assert.equal(h.voice.provider,'convai');await h.voice.close();
});

test('cross-backend drafts wait for owned reply and confirmed retirement, then warm before Apply',async()=>{
  const h=dualFixture({holdClose:true,start:'pocket'});await h.voice.start();
  h.voice.update({voiceProvider:'pocket'},{provider:'omni',omniSteps:16},true);await tick();
  assert.equal(h.workers.length,1);assert.equal(h.workers[0].closes,0);assert.equal(h.voice.provider,'pocket');
  let inviteReady=false;const invite=h.voice.prepareProfile('johnny-silverhand').then(value=>{inviteReady=true;return value;});
  await tick();assert.equal(inviteReady,false);
  h.voice.update({voiceProvider:'pocket'},{provider:'omni',omniSteps:16},false);await tick();
  assert.equal(h.workers[0].closes,1);assert.equal(h.workers[1].starts,0);
  h.workers[0].released.resolve();await h.voice.start();assert.equal(h.workers[1].starts,1);assert.equal(h.voice.provider,'pocket');
  h.voice.update({voiceProvider:'omni',omniSteps:16},null,false);assert.equal((await invite).provider,'omni');
  assert.equal(h.workers.length,2);assert.equal(h.peak(),1);h.workers[1].released.resolve();await h.voice.close();
});

test('an unconfirmed cross-backend exit blocks replacement and cannot grant wrong-backend readiness',async()=>{
  const h=dualFixture({start:'pocket'});await h.voice.start();
  h.workers[0].close=async()=>{throw Error('owned exit not confirmed');};
  h.voice.update({voiceProvider:'omni',omniSteps:32},null,false);
  await assert.rejects(h.voice.start(),/not confirmed/);assert.equal(h.workers[1].starts,0);
  assert.equal(h.voice.profileReady('johnny-silverhand'),false);assert.equal(h.peak(),1);
  await assert.rejects(h.voice.close(),/not confirmed/);
});

test('an unavailable other-local draft preserves the committed worker and cannot starve invitation readiness',async()=>{
  for(const omniConfig of [{},{version:2,provider:'hybrid',engine:'omnivoice',steps:32,
    voices:{'johnny-silverhand':{status:'unprepared'}}}]){
    const h=fixture({omniConfig});await h.voice.start();
    try{
      h.voice.update({voiceProvider:'pocket'},{provider:'omni',omniSteps:32},false);
      await h.voice.retiring;
      const controller=new AbortController(),start=h.voice.start.bind(h.voice);let attempts=0;
      // Keep the pre-fix spinner bounded even though its resolved-await loop
      // prevents a timer or setImmediate from aborting it.
      h.voice.start=()=>{if(++attempts===16)controller.abort();return start();};
      const prepared=await h.voice.prepareProfile('johnny-silverhand',{signal:controller.signal})
        .then(value=>({value}),error=>({error}));
      await tick();
      assert.equal(attempts,1,'invitation must not retry an unavailable draft in a microtask loop');
      assert.ifError(prepared.error);
      assert.deepEqual(prepared.value,{provider:'pocket',ready:true,profile:'johnny-silverhand'});
      assert.equal(h.voice.targetBackend,'pocket');assert.equal(h.voice.previewRoutingPending,false);
      assert.equal(h.workers.length,1);assert.equal(h.workers[0].closes,0);assert.equal(h.peak(),1);
      assert.equal(h.voice.profileReady('johnny-silverhand'),true);
      h.voice.update({voiceProvider:'pocket'},null,false);
      assert.equal(h.workers.length,1,'Revert must retain the same committed worker');
      // Omni cannot serve this machine, so the committed choice falls to Pocket
      // and its warm worker is kept rather than retired.
      h.voice.update({voiceProvider:'omni',omniSteps:32},null,false);await h.voice.retiring;
      assert.equal(h.workers[0].closes,0,'the fallback keeps the Pocket worker');
      assert.equal(h.voice.provider,'pocket');assert.deepEqual(h.voice.fallback,{from:'omni',to:'pocket'});
      assert.equal((await h.voice.prepareProfile('johnny-silverhand')).provider,'pocket');
    }finally{await h.voice.close();}
  }
});

test('a settled local startup without a loaded worker rejects rather than retrying resolved readiness',async()=>{
  const h=fixture();await h.voice.start();
  try{
    Object.defineProperty(h.workers[0],'loaded',{get:()=>false});
    const start=h.voice.start.bind(h.voice);let attempts=0;
    h.voice.start=()=>{if(++attempts===16)throw Error('readiness loop guard');return start();};
    await assert.rejects(h.voice.prepareProfile('johnny-silverhand'),/local voice backend did not become ready/);
    assert.equal(attempts,1);await tick();
  }finally{await h.voice.close();}
});

test('shared selection rejects Omni readiness immediately on actual worker failure or closing',async()=>{
  for(const terminal of ['fail','close']){
    const h=dualFixture(),client=new ResidentVoice(h.voice.configs.omni,{spawnImpl(){throw Error('must not spawn');}});
    h.voice.provider=h.voice.requestedProvider='omni';h.voice.client=client;h.voice.clientBackend='omni';
    client.loaded=true;client.prepared.add('johnny-silverhand');
    assert.equal(h.voice.profileReady('johnny-silverhand'),true);
    if(terminal==='fail')client.fail(Error('owned worker failed'));else await client.close();
    assert.equal(client.loaded,true,'terminal state may precede physical worker exit');
    assert.equal(h.voice.profileReady('johnny-silverhand'),false,'stale ready receipt must not admit a spawn');
    await h.voice.close();
  }
});

test('the local voices are OmniVoice, then Pocket, though the menu lists Pocket first; no cloud voice is ever in the order',async()=>{
  const {VOICE_FALLBACK_ORDER,TEXT_ROUTE}=await import('./voice-selection.mjs');
  assert.deepEqual([...VOICE_FALLBACK_ORDER],['omni','pocket']);assert.equal(TEXT_ROUTE,'text');
  const h=dualFixture();
  assert.equal(h.voice.provider,'pocket');assert.equal(h.voice.requestedProvider,'pocket');
  h.voice.request({voiceProvider:'omni',omniSteps:16});h.voice.applyWhenIdle(false);
  assert.equal(h.voice.provider,'omni');assert.equal(h.voice.steps,16);
  await h.voice.close();
});

test('an Omni worker that cannot start leaves the replies as text, loads no Pocket for it, and invitation readiness follows',async()=>{
  const h=dualFixture({fail:['omni'],start:'omni'});
  const invited=h.voice.prepareProfile('johnny-silverhand');
  await tick();await tick();
  // The fallback commits at the next idle settings poll, like any routing change.
  h.voice.update({},null,false);
  assert.deepEqual(await invited,{provider:'text',ready:true,reason:'unavailable'});
  assert.equal(h.voice.provider,'text');assert.equal(h.voice.requestedProvider,'omni');assert.equal(h.voice.textOnly,true);
  assert.equal(h.workers.filter(worker=>worker.backend==='pocket').length,0,'no Pocket worker is started for an Omni that failed');
  // A failed Omni stays out of routing and is loaded again later in the background, so the text-only route is temporary.
  assert.deepEqual(h.voice.fallback,{from:'omni',to:'text',temporary:true});
  assert.deepEqual(h.states.at(-1).fallback,{from:'omni',to:'text',temporary:true});
  assert.equal(h.workers.filter(worker=>worker.backend==='omni').length,1,'a failed Omni is not restarted in a loop');
  h.voice.update({},null,false);await tick();
  assert.equal(h.workers.filter(worker=>worker.backend==='omni').length,1);
  // Choosing Pocket is the player's own choice; choosing OmniVoice again is an explicit retry.
  h.voice.update({voiceProvider:'pocket'},null,false);assert.equal(h.voice.fallback,null);
  h.voice.update({voiceProvider:'omni',omniSteps:32},null,false);await tick();await tick();
  assert.equal(h.workers.filter(worker=>worker.backend==='omni').length,2);
  await h.voice.close();
});

test('a failure during an owned turn waits for the idle boundary before the route changes',async()=>{
  const h=dualFixture({fail:['omni'],start:'omni'});h.voice.update({},null,true);
  await h.voice.start().catch(()=>{});await tick();
  assert.equal(h.voice.provider,'omni','the owned turn keeps its route');assert.equal(h.voice.pending,true);
  h.voice.update({},null,false);
  assert.equal(h.voice.provider,'text');assert.deepEqual(h.voice.fallback,{from:'omni',to:'text',temporary:true});
  await h.voice.close();
});

test('Pocket failing, or Omni failing, falls to text and never to the Convai voice (owner rule 2026-10-21)',async()=>{
  const pocketOnly=dualFixture({start:'pocket',fail:['pocket']});
  await pocketOnly.voice.start().catch(()=>{});await tick();pocketOnly.voice.update({},null,false);
  assert.equal(pocketOnly.voice.provider,'text');assert.deepEqual(pocketOnly.voice.fallback,{from:'pocket',to:'text',temporary:true});
  const receipt=await pocketOnly.voice.prepareProfile('johnny-silverhand');
  assert.equal(receipt.provider,'text');assert.notEqual(receipt.provider,'convai');
  assert.equal(pocketOnly.voice.convaiVoiceAllowed,false,'a failed local voice does not allow the Convai voice');
  await pocketOnly.voice.close();
  const both=dualFixture({fail:['omni','pocket'],start:'omni'});
  await both.voice.start().catch(()=>{});await tick();both.voice.update({},null,false);
  await both.voice.start().catch(()=>{});await tick();both.voice.update({},null,false);
  assert.equal(both.voice.provider,'text');assert.deepEqual(both.voice.fallback,{from:'omni',to:'text',temporary:true});
  assert.equal(both.workers.filter(worker=>worker.backend==='pocket').length,0);
  await both.voice.close();
});

test('the Convai voice is a route only when the player chose it; a local voice that cannot run is never replaced by it (every way a local voice can fail)',async()=>{
  const route=h=>({provider:h.voice.provider,resolved:h.voice.resolvedProvider,fallbackTo:h.voice.fallback?.to,allowed:h.voice.convaiVoiceAllowed,
    cloud:h.voice.cloudEngine,cloudActive:h.voice.cloudActive});
  const outcomes=[];
  // Omni chosen: pack missing; worker fails; nothing configured. Pocket chosen: worker fails; nothing configured.
  const packless=dualFixture({start:'omni'});packless.voice.omniPackSource=()=>({installed:false,missing:['model']});packless.voice.refreshOmniPack();
  packless.voice.update({voiceProvider:'omni'},null,false);outcomes.push(route(packless));await packless.voice.close();
  const omniFails=dualFixture({fail:['omni'],start:'omni'});await omniFails.voice.start().catch(()=>{});await tick();omniFails.voice.update({},null,false);outcomes.push(route(omniFails));await omniFails.voice.close();
  const pocketFails=dualFixture({fail:['pocket'],start:'pocket'});await pocketFails.voice.start().catch(()=>{});await tick();pocketFails.voice.update({},null,false);outcomes.push(route(pocketFails));await pocketFails.voice.close();
  const empty=new VoiceSelection({});empty.update({voiceProvider:'pocket'},null,false);outcomes.push(route({voice:empty}));await empty.close();
  const emptyOmni=new VoiceSelection({});emptyOmni.update({voiceProvider:'omni'},null,false);outcomes.push(route({voice:emptyOmni}));await emptyOmni.close();
  for(const outcome of outcomes){
    assert.equal(outcome.provider,'text',JSON.stringify(outcome));assert.equal(outcome.resolved,'text');assert.equal(outcome.fallbackTo,'text');assert.equal(outcome.allowed,false);
    assert.equal(outcome.cloud,null,'no cloud voice (Voxtral) takes over');assert.equal(outcome.cloudActive,false);
  }
  // Chosen on purpose, the Convai voice is a route and never reports a fallback.
  const chosen=dualFixture({start:'convai'});assert.equal(chosen.voice.provider,'convai');assert.equal(chosen.voice.convaiVoiceAllowed,true);assert.equal(chosen.voice.fallback,null);
  assert.equal((await chosen.voice.prepareProfile('johnny-silverhand')).provider,'convai');await chosen.voice.close();
});

test('the other local voice stands in only if it is already loaded, and is never loaded for that',async()=>{
  // Pocket is loaded; the player asks for Omni, which cannot start (settings preview not involved): resolve() may name Pocket only while it is loaded.
  const h=dualFixture({start:'pocket'});await h.voice.start();
  assert.equal(h.voice.loadedBackend('pocket'),true);
  h.voice.requestedProvider='omni';h.voice.failedBackends.add('omni');
  assert.equal(h.voice.resolve('omni'),'pocket','an already loaded Pocket may speak while Omni is down');
  await h.voice.retire();
  assert.equal(h.voice.resolve('omni'),'text','with Pocket not loaded the replies are written; Pocket is not started');
  assert.equal(h.workers.filter(worker=>worker.backend==='pocket').length,1);
  await h.voice.close();
});

test('a saved Convai choice never reports a fallback, and a missing Omni setup leaves the replies as text without starting Pocket',async()=>{
  const convai=dualFixture({start:'convai'});
  assert.equal(convai.voice.provider,'convai');assert.equal(convai.voice.fallback,null);await convai.voice.close();
  const h=fixture();
  assert.equal(h.voice.requestedProvider,'pocket');assert.equal(h.voice.provider,'pocket');assert.equal(h.voice.fallback,null);
  h.voice.update({voiceProvider:'omni',omniSteps:16},null,false);
  assert.equal(h.voice.requestedProvider,'omni');assert.equal(h.voice.provider,'text');
  assert.deepEqual(h.voice.fallback,{from:'omni',to:'text'});assert.equal(h.workers.length,0,'Pocket is not started in place of OmniVoice');
  await h.voice.close();
});

test('a draft that keeps changing never starts or retires a worker until it has settled',async()=>{
  let now=1000;const h=fixture({voiceOptions:{previewSettleMs:1500,clock:()=>now}});
  h.voice.update({voiceProvider:'convai'},null,false);
  // Cycle quickly through the choices: each one is new, none has settled.
  for(const provider of ['pocket','convai','pocket','convai','pocket']){
    h.voice.update({voiceProvider:'convai'},{provider},false);now+=300;await tick();
  }
  assert.equal(h.workers.length,0,'rapid draft changes reached the worker');
  assert.equal(h.voice.targetBackend,null);
  // The last choice stays for the settle time, then prepares exactly one worker.
  now+=1500;h.voice.update({voiceProvider:'convai'},{provider:'pocket'},false);await tick();await h.voice.start();
  assert.equal(h.workers.length,1);assert.equal(h.workers[0].starts,1);assert.equal(h.workers[0].closes,0);
  assert.equal(h.voice.provider,'convai','a staged draft changed the committed route');
  // Moving on again waits for the new choice to settle before the worker is retired.
  h.voice.update({voiceProvider:'convai'},null,false);await tick();
  assert.equal(h.workers[0].closes,1);
  await h.voice.close();
});

// Omni's two reference choices (short, long) each have their own configuration and worker; the optional pack
// decides whether Omni can run at all; "Keep prepared voices" reaches whichever worker is live.
function referenceFixture({omniPack,fail=[],clock}={}){
  const workers=[],states=[];let now=1000;
  const ref=name=>({'johnny-silverhand':{reference:`runtime/voice-references/${name}/johnny.wav`,sha256:'a'.repeat(64),transcript:'Original line.'},
    'judy-alvarez':{reference:`runtime/voice-references/${name}/judy.wav`,sha256:'b'.repeat(64),transcript:'Another line.'}});
  const omni=name=>({version:2,provider:'hybrid',engine:'omnivoice',steps:32,voices:ref(name)});
  const factory=backend=>(config,hooks)=>{
    const {onState}=hooks;let loaded=false;
    const worker={backend,config,hooks,keep:hooks.keepPreparedVoices,starts:0,closes:0,steps:32,keepCalls:[],
      get loaded(){return loaded;},hasProfile:key=>Object.hasOwn(config.voices,key),profileReady(key){return loaded&&this.hasProfile(key);},
      setSteps(value){this.steps=value;},setKeepPrepared(value){this.keep=value;this.keepCalls.push(value);},
      async start(){this.starts++;
        if(fail.includes(backend)){this.failure=Error(backend+' failed');onState({state:'error'});throw this.failure;}
        loaded=true;onState({state:'ready',resident:true});},
      async prepareProfile(profile){return{provider:backend,ready:true,profile};},
      async synthesize(){return{};},async synthesizeStream(){return{};},
      async close(){this.closes++;loaded=false;onState({state:'stopped',resident:false});}};
    workers.push(worker);return worker;
  };
  const voices=ref('pocket');
  const voice=new VoiceSelection(pocketSettings(voices),{onState:value=>states.push(value),factory:factory('pocket'),
    omniFactory:factory('omni'),omniConfigs:{short:omni('short'),long:omni('long')},
    omniConfigPaths:{short:resolve('runtime/local-voices.short.json'),long:resolve('runtime/local-voices.long.json')},
    omniPack,clock:clock||(()=>now),previewSettleMs:0});
  return{voice,workers,states,advance:ms=>{now+=ms;}};
}

test('Omni short and long references each run on their own configuration; steps never restart the worker',async()=>{
  const h=referenceFixture();
  assert.equal(h.voice.omniReference,'long','long is the default reference');
  h.voice.update({voiceProvider:'omni',omniSteps:16,omniReference:'short'},null,false);
  assert.equal(h.voice.provider,'omni');assert.equal(h.voice.omniReference,'short');
  await h.voice.start();
  assert.equal(h.workers.length,1);assert.match(h.workers[0].config.voices['judy-alvarez'].reference,/\/short\//);
  assert.equal(h.workers[0].hooks.configPath,resolve('runtime/local-voices.short.json'));
  h.voice.update({voiceProvider:'omni',omniSteps:32,omniReference:'short'},null,false);await h.voice.start();
  assert.equal(h.workers.length,1,'16 to 32 steps keeps the worker');assert.equal(h.workers[0].steps,32);
  // Long needs the other configuration: a new worker after the old one is released.
  assert.equal(h.voice.update({voiceProvider:'omni',omniSteps:32,omniReference:'long'},null,false),true);
  assert.equal(h.voice.omniReference,'long');await h.voice.start();
  assert.equal(h.workers[0].closes,1);assert.equal(h.workers.length,2);
  assert.match(h.workers[1].config.voices['judy-alvarez'].reference,/\/long\//);
  assert.equal(h.workers[1].hooks.configPath,resolve('runtime/local-voices.long.json'));
  assert.equal(h.states.at(-1).omniReference,'long');assert.equal(h.states.at(-1).requestedOmniReference,'long');
  assert.deepEqual(await h.voice.prepareProfile('judy-alvarez'),{provider:'omni',ready:true,profile:'judy-alvarez'});
  await h.voice.close();
});

test('a reference change waits for the idle boundary and an owned turn keeps its worker',async()=>{
  const h=referenceFixture();
  h.voice.update({voiceProvider:'omni',omniSteps:16,omniReference:'short'},null,false);await h.voice.start();
  assert.equal(h.voice.update({voiceProvider:'omni',omniSteps:16,omniReference:'long'},null,true),false);
  assert.equal(h.voice.pending,true);assert.equal(h.voice.omniReference,'short');assert.equal(h.workers[0].closes,0);
  h.voice.update({voiceProvider:'omni',omniSteps:16,omniReference:'long'},null,false);await h.voice.start();
  assert.equal(h.voice.pending,false);assert.equal(h.workers[0].closes,1);assert.equal(h.workers.length,2);
  await h.voice.close();
});

test('a Settings draft warms the draft reference before Apply, and Apply keeps that worker',async()=>{
  const h=referenceFixture();
  h.voice.update({voiceProvider:'pocket',omniReference:'long'},null,false);await h.voice.start();
  h.voice.update({voiceProvider:'pocket',omniReference:'long'},{provider:'omni',omniSteps:16,omniReference:'short'},false);
  await h.voice.retiring;await tick();await h.voice.start();
  const omniWorkers=h.workers.filter(worker=>worker.backend==='omni');
  assert.equal(omniWorkers.length,1);assert.match(omniWorkers[0].config.voices['judy-alvarez'].reference,/\/short\//);
  assert.equal(h.voice.provider,'pocket','a draft never commits the route');
  h.voice.update({voiceProvider:'omni',omniSteps:16,omniReference:'short'},{provider:'omni',omniSteps:16,omniReference:'short'},false);
  assert.equal(h.voice.provider,'omni');assert.equal(h.workers.filter(worker=>worker.backend==='omni').length,1);
  assert.equal(omniWorkers[0].closes,0,'Apply reuses the warmed worker');
  await h.voice.close();
});

test('without the optional OmniVoice pack an Omni choice shows replies as text (no Pocket, no cloud voice) and says what is missing',async()=>{
  let installed=false;
  const h=referenceFixture({omniPack:()=>({installed,missing:installed?[]:['python','model']})});
  assert.equal(h.voice.omniPack.installed,false);
  h.voice.update({voiceProvider:'omni',omniSteps:16,omniReference:'short'},null,false);
  assert.equal(h.voice.requestedProvider,'omni');assert.equal(h.voice.provider,'text');
  assert.deepEqual(h.voice.fallback,{from:'omni',to:'text'});
  h.voice.publish();
  assert.deepEqual(h.states.at(-1).omniPack,{installed:false,missing:['python','model']});
  // A draft of an unavailable Omni never starts an Omni worker.
  h.voice.update({voiceProvider:'omni',omniSteps:16,omniReference:'short'},{provider:'omni',omniSteps:16,omniReference:'short'},false);
  await tick();assert.equal(h.workers.filter(worker=>worker.backend==='omni').length,0);
  assert.equal((await h.voice.prepareProfile('judy-alvarez')).provider,'text');
  assert.equal(h.workers.length,0,'no worker of any kind was started while the pack is missing');
  // Installing the pack while the game runs is noticed on a later settings poll.
  installed=true;h.advance(31_000);
  h.voice.update({voiceProvider:'omni',omniSteps:16,omniReference:'short'},null,false);
  assert.equal(h.voice.omniPack.installed,true);assert.equal(h.voice.provider,'omni');assert.equal(h.voice.fallback,null);
  await h.voice.close();
});

test('prepared voices are always kept: on for every worker, and an old saved keepPreparedVoices false is ignored',async()=>{
  const h=referenceFixture();
  await h.voice.start();
  assert.equal(h.voice.keepPrepared,true);assert.equal(h.workers[0].hooks.keepPreparedVoices,true);assert.equal(h.workers[0].keep,true);
  h.voice.update({voiceProvider:'pocket',keepPreparedVoices:false},null,false);
  assert.equal(h.workers[0].keep,true);assert.equal(h.voice.keepPrepared,true);
  h.voice.update({voiceProvider:'omni',omniSteps:16,omniReference:'long',keepPreparedVoices:false},null,false);
  await h.voice.start();
  const omni=h.workers.find(worker=>worker.backend==='omni');
  assert.equal(omni.hooks.keepPreparedVoices,true);assert.equal(omni.keep,true);
  await h.voice.close();
});

// A slow or failed OmniVoice is not a lost one: the replies are written meanwhile (Pocket is not loaded in its place, and no cloud voice speaks),
// Omni loads again in the background, and the voice returns at an idle reply boundary. `omni` scripts each Omni attempt in order: 'fail', 'hold' (a gate the test
// opens), or 'ok' (the default once the script runs out). `pocket` scripts the Pocket attempts the same way.
function retryFixture({omni = [], pocket = [], options = {}} = {}) {
  const workers = [], states = [], logs = []; let now = 1000, live = 0, peak = 0;
  const voices = {'johnny-silverhand': {reference: 'runtime/voice-references/johnny.wav', sha256: 'a'.repeat(64), transcript: 'Original line.'}};
  const factory = backend => (config, hooks) => {
    const attempt = workers.filter(worker => worker.backend === backend).length, mode = (backend === 'omni' ? omni : pocket)[attempt] || 'ok';
    const gate = defer(); let loaded = false, owned = false;
    const worker = {backend, hooks, gate, mode, starts: 0, closes: 0, steps: 32, failure: undefined,
      get loaded() { return loaded; }, hasProfile: key => Object.hasOwn(config.voices, key),
      profileReady(key) { return loaded && this.hasProfile(key); }, setSteps(value) { this.steps = value; }, setKeepPrepared() {},
      async start() {
        this.starts++;
        if (mode === 'fail' || mode === 'blocked' || mode === 'paths' || mode === 'nocuda') {
          this.failure = Error(mode === 'blocked' ? 'Pocket student runtime is unavailable (ImportError: DLL load failed while importing _streams: An Application Control policy has blocked this file.)'
            : mode === 'paths' ? 'Local voice worker did not confirm its portable asset and data paths' : mode === 'nocuda' ? NO_CUDA_FAILURE : backend + ' worker failed');
          hooks.onState({state: 'error'}); throw this.failure;
        }
        owned = true; live++; peak = Math.max(peak, live);
        hooks.onState({state: 'loading', resident: false});
        if (mode === 'hold') await gate.promise;
        loaded = true; hooks.onState({state: 'ready', resident: true, engine: backend === 'omni' ? 'omnivoice' : 'pocket-tts'});
      },
      async prepareProfile(profile) { return {provider: backend, ready: true, profile}; },
      async synthesize() { return {}; }, async synthesizeStream() { return {}; },
      async close() { this.closes++; if (owned) live--; owned = loaded = false; hooks.onState({state: 'stopped', resident: false}); }};
    workers.push(worker); return worker;
  };
  const failures = [];
  const voice = new VoiceSelection(pocketSettings(voices), {...options, onState: value => states.push(value), onLog: line => logs.push(line), onFailure: info => failures.push(info),
    factory: factory('pocket'), omniFactory: factory('omni'), clock: () => now,
    omniConfig: {version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 32, voices}});
  const omniWorkers = () => workers.filter(worker => worker.backend === 'omni');
  const pocketWorkers = () => workers.filter(worker => worker.backend === 'pocket');
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  return {voice, workers, states, logs, failures, omniWorkers, pocketWorkers, settle, advance: ms => { now += ms; }, live: () => live, peak: () => peak,
    pocket: () => workers.find(worker => worker.backend === 'pocket')};
}

test('an Omni that fails shows replies as text, loads again in the background, and returns at an idle boundary, never mid-reply', async () => {
  const h = retryFixture({omni: ['fail', 'hold']});
  h.voice.update({voiceProvider: 'omni', omniSteps: 16}, null, false); await h.settle();
  h.voice.update({}, null, false); await h.voice.start(); await h.settle();
  assert.equal(h.voice.provider, 'text'); assert.deepEqual(h.voice.fallback, {from: 'omni', to: 'text', temporary: true});
  assert.equal(h.states.at(-1).omniRetry.failures, 1); assert.equal(h.states.at(-1).omniRetry.loading, false);
  assert.ok(h.states.at(-1).omniRetry.nextInMs > 0 && h.states.at(-1).omniRetry.nextInMs <= 45_000);
  assert.equal(h.voice.profileReady('johnny-silverhand'), false, 'nothing speaks while Omni is away');
  assert.equal(h.pocketWorkers().length, 0, 'Pocket is not loaded in its place');
  // Not due yet: nothing starts. Due, but a reply is in flight: still nothing.
  h.advance(44_000); h.voice.update({}, null, false); await h.settle(); assert.equal(h.omniWorkers().length, 1);
  h.advance(1000); h.voice.update({}, null, true); await h.settle(); assert.equal(h.omniWorkers().length, 1, 'no load during a reply');
  // Idle: one background worker starts, at low priority, with nothing else loaded.
  h.voice.update({}, null, false); await h.settle();
  assert.equal(h.omniWorkers().length, 2); const candidate = h.omniWorkers()[1];
  assert.equal(candidate.starts, 1); assert.equal(candidate.hooks.lowPriority, true);
  assert.equal(h.states.at(-1).omniRetry.loading, true);
  assert.equal(h.voice.provider, 'text'); assert.equal(h.pocketWorkers().length, 0); assert.equal(h.voice.profileReady('johnny-silverhand'), false);
  h.voice.update({}, null, false); await h.settle(); assert.equal(h.omniWorkers().length, 2, 'a loading candidate is not started twice');
  // It finishes while a reply is in flight: the reply keeps its route (written); routing is staged, not switched.
  candidate.gate.resolve(); await h.settle();
  assert.equal(h.voice.pending, true); assert.equal(h.voice.fallback, null); assert.equal(h.voice.omniRetry, null);
  h.voice.update({}, null, true); await h.settle();
  assert.equal(h.voice.provider, 'text', 'the reply in flight keeps its route');
  // The next idle poll commits: Omni is the route and its loaded worker is adopted (not loaded again).
  assert.equal(h.voice.update({}, null, false), true); await h.voice.retiring; await h.settle();
  assert.equal(h.voice.provider, 'omni'); assert.equal(h.voice.fallback, null);
  assert.equal(h.omniWorkers().length, 2, 'no third Omni load'); assert.equal(h.pocketWorkers().length, 0);
  assert.equal(h.voice.client, candidate); assert.equal(h.voice.profileReady('johnny-silverhand'), true);
  assert.equal(h.states.at(-1).omniRetry, null); assert.equal(h.states.at(-1).provider, 'omni');
  assert.equal(candidate.steps, 16);
  assert.ok(h.logs.some(line => /attempt 1 failed/.test(line)) && h.logs.some(line => /ready; it takes over/.test(line)));
  assert.equal((await h.voice.prepareProfile('johnny-silverhand')).provider, 'omni');
  await h.voice.close(); assert.equal(h.live(), 0);
});

test('an Omni worker that could not confirm its paths is not tried again: every try loads both models and fails the same way', async () => {
  const h = retryFixture({omni: ['paths', 'ok']});
  h.voice.update({voiceProvider: 'omni'}, null, false); await h.settle();
  h.voice.update({}, null, false); await h.voice.start(); await h.settle();
  assert.equal(h.omniWorkers().length, 1);
  assert.equal(h.voice.omniRetry, null); assert.deepEqual(h.voice.fallback, {from: 'omni', to: 'text'});
  assert.equal(h.states.at(-1).omniRetry, null);
  assert.ok(h.logs.some(line => /\[OmniRetry\] not trying again: .*portable asset and data paths/.test(line)));
  assert.equal(h.failures.length, 1, 'the failure is still recorded for the error report');
  for (const delay of [45_000, 180_000, 600_000]) { h.advance(delay); h.voice.update({}, null, false); await h.settle(); }
  assert.equal(h.omniWorkers().length, 1, 'no second load, however long it waits');
  await h.voice.close(); assert.equal(h.live(), 0);
});

test('an Omni worker with no CUDA is never tried again, says so once, is not reported as a bug, and names the card vendors', async () => {
  let vendors = null;
  const h = retryFixture({omni: ['nocuda', 'ok'], options: {gpuVendors: () => vendors}});
  vendors = ['amd'];
  h.voice.update({voiceProvider: 'omni'}, null, false); await h.settle();
  h.voice.update({}, null, false); await h.voice.start(); await h.settle();
  assert.equal(h.omniWorkers().length, 1);
  assert.ok(h.logs.some(line => /\[OmniVoice\] starting OmniVoice \(graphics: amd\)/.test(line)), 'the start line names the vendors');
  assert.equal(h.voice.omniRetry, null); assert.equal(h.states.at(-1).omniRetry, null);
  assert.deepEqual(h.voice.fallback, {from: 'omni', to: 'text', reason: 'omni-no-nvidia'});
  assert.equal(h.logs.filter(line => /\[OmniRetry\]/.test(line)).length, 1);
  assert.ok(h.logs.some(line => /\[OmniRetry\] not trying again: OmniVoice needs an NVIDIA graphics card .*\(graphics: amd\)/.test(line)));
  assert.ok(!h.logs.some(line => /trying again in/.test(line)));
  assert.equal(h.failures.length, 0, 'a PC without an NVIDIA card is not filed as an error report');
  assert.equal(h.states.at(-1).omniNoNvidia, true); assert.deepEqual(h.states.at(-1).gpuVendors, ['amd']);
  assert.equal(h.pocketWorkers().length, 0, 'no other voice is loaded in its place');
  for (const delay of [45_000, 180_000, 600_000]) { h.advance(delay); h.voice.update({}, null, false); await h.settle(); }
  assert.equal(h.omniWorkers().length, 1, 'no background load, however long it waits');
  // Choosing another voice and Omni again does not start the worker again either (the failure is for the life of the service).
  h.voice.update({voiceProvider: 'convai'}, null, false); await h.settle();
  h.voice.update({voiceProvider: 'omni'}, null, false); await h.settle(); h.voice.update({}, null, false); await h.settle();
  assert.equal(h.omniWorkers().length, 1); assert.equal(h.logs.filter(line => /not trying again/.test(line)).length, 1);
  assert.equal(h.voice.fallback?.reason, 'omni-no-nvidia');
  await h.voice.close(); assert.equal(h.live(), 0, 'the failed worker is released');
});

test('the menu fact omniNoNvidia needs a known card list without an NVIDIA card; unknown claims nothing', async () => {
  let vendors = null;
  const h = retryFixture({options: {gpuVendors: () => vendors}});
  h.voice.publish(); assert.equal(h.states.at(-1).omniNoNvidia, false); assert.equal(h.states.at(-1).gpuVendors, null);
  vendors = []; h.voice.publish(); assert.equal(h.states.at(-1).omniNoNvidia, false);
  vendors = ['other']; h.voice.publish(); assert.equal(h.states.at(-1).omniNoNvidia, false);
  vendors = ['intel', 'nvidia']; h.voice.publish(); assert.equal(h.states.at(-1).omniNoNvidia, false);
  vendors = ['intel', 'amd']; h.voice.publish(); assert.equal(h.states.at(-1).omniNoNvidia, true);
  assert.equal(h.voice.fallback, null, 'a PC without an NVIDIA card is not told anything until the voice is chosen and fails');
  const broken = retryFixture({options: {gpuVendors: () => { throw Error('x'); }}});
  broken.voice.publish(); assert.equal(broken.states.at(-1).omniNoNvidia, false);
  await h.voice.close(); await broken.voice.close();
});

test('the card list is asked for only while Omni is wanted (chosen or starting), never for another voice', async () => {
  const asked = [];
  const h = retryFixture({options: {gpuVendors: wanted => { asked.push(wanted); return ['amd']; }}});
  h.voice.publish(); assert.equal(asked.at(-1), false, 'Pocket is the voice: nothing to look up');
  assert.ok(asked.every(wanted => wanted === false));
  h.voice.update({voiceProvider: 'omni'}, null, false); await h.settle(); h.voice.publish();
  assert.equal(asked.at(-1), true, 'Omni chosen: the source is told to look the cards up');
  await h.voice.close();
});

test('Omni retries back off, give up after the last one, and choosing Omni again starts over', async () => {
  const h = retryFixture({omni: ['fail', 'fail', 'fail', 'fail']});
  h.voice.update({voiceProvider: 'omni'}, null, false); await h.settle();
  h.voice.update({}, null, false); await h.voice.start(); await h.settle();
  const waits = [];
  for (const delay of [45_000, 180_000, 600_000]) {
    waits.push(h.states.at(-1).omniRetry.nextInMs);
    h.advance(delay - 1); h.voice.update({}, null, false); await h.settle();
    assert.equal(h.omniWorkers().length, waits.length, 'not before the wait is over');
    h.advance(1); h.voice.update({}, null, false); await h.settle();
    assert.equal(h.omniWorkers().length, waits.length + 1);
  }
  assert.deepEqual(waits, [45_000, 180_000, 600_000]);
  // The fourth failure ends it: a plain, permanent fallback.
  assert.equal(h.voice.omniRetry, null); assert.deepEqual(h.voice.fallback, {from: 'omni', to: 'text'});
  assert.equal(h.states.at(-1).omniRetry, null); assert.ok(h.logs.some(line => /giving up/.test(line)));
  h.advance(86_400_000); h.voice.update({}, null, false); await h.settle(); assert.equal(h.omniWorkers().length, 4);
  // The player chooses Omni again: the normal start path, with the retry story reset.
  h.voice.update({voiceProvider: 'pocket'}, null, false); h.voice.update({voiceProvider: 'omni'}, null, false); await h.settle();
  assert.equal(h.omniWorkers().length, 5); assert.equal(h.voice.provider, 'omni'); assert.equal(h.voice.fallback, null);
  await h.voice.close();
});

test('a background Omni load is dropped when the player changes the voice, and when the service closes', async () => {
  for (const ending of ['pocket', 'close']) {
    const h = retryFixture({omni: ['fail', 'hold']});
    h.voice.update({voiceProvider: 'omni'}, null, false); await h.settle();
    h.voice.update({}, null, false); await h.voice.start(); await h.settle();
    h.advance(45_000); h.voice.update({}, null, false); await h.settle();
    const candidate = h.omniWorkers()[1]; assert.ok(candidate && h.voice.candidate);
    if (ending === 'pocket') { h.voice.update({voiceProvider: 'pocket'}, null, false); await h.settle(); }
    else { await h.voice.close(); }
    assert.equal(candidate.closes, 1); assert.equal(h.voice.candidate, null); assert.equal(h.voice.omniRetry, null);
    candidate.gate.resolve(); await h.settle();
    assert.equal(h.omniWorkers().length, 2, 'a dropped candidate is never adopted or replaced');
    assert.notEqual(h.voice.provider, 'omni');
    await h.voice.close(); assert.equal(h.live(), 0);
  }
});

test('a failed background load is retried again after its worker has exited', async () => {
  const h = retryFixture({omni: ['fail', 'fail', 'hold']});
  h.voice.update({voiceProvider: 'omni'}, null, false); await h.settle();
  h.voice.update({}, null, false); await h.voice.start(); await h.settle();
  h.advance(45_000); h.voice.update({}, null, false); await h.settle();
  assert.equal(h.omniWorkers().length, 2); assert.equal(h.omniWorkers()[1].closes, 1, 'the failed candidate is closed');
  assert.equal(h.voice.candidate, null); assert.equal(h.voice.omniRetry.failures, 2); assert.equal(h.voice.fallback.temporary, true);
  h.advance(180_000); h.voice.update({}, null, false); await h.settle();
  assert.equal(h.omniWorkers().length, 3);
  h.omniWorkers()[2].gate.resolve(); await h.settle(); h.voice.update({}, null, false); await h.voice.retiring; await h.settle();
  assert.equal(h.voice.provider, 'omni'); assert.equal(h.voice.client, h.omniWorkers()[2]);
  await h.voice.close();
});

// A Pocket worker that failed (two stalled starts while the game loads, a crash) is not lost for the session: the replies are written (never
// given to the Convai voice), Pocket loads again after the same waits as Omni, and a Pocket that is up again is routed at the next idle poll.
test('a Pocket that fails is loaded again after each wait, only when due and idle, and the fourth failure is the last', async () => {
  const h = retryFixture({pocket: ['fail', 'fail', 'fail', 'fail']});
  h.voice.update({}, null, false); await h.settle(); h.voice.update({}, null, false); await h.settle();
  assert.equal(h.pocketWorkers().length, 1); assert.equal(h.voice.provider, 'text');
  assert.deepEqual(h.voice.fallback, {from: 'pocket', to: 'text', temporary: true});
  assert.equal(h.pocketWorkers()[0].closes, 1, 'the failed worker is released while it waits');
  const waits = [];
  for (const delay of [45_000, 180_000, 600_000]) {
    waits.push(h.states.at(-1).pocketRetry.nextInMs);
    h.advance(delay - 1); h.voice.update({}, null, false); await h.settle();
    assert.equal(h.pocketWorkers().length, waits.length, 'not before the wait is over');
    h.advance(1); h.voice.update({}, null, true); await h.settle();
    assert.equal(h.pocketWorkers().length, waits.length, 'no load during a reply');
    h.voice.update({}, null, false); await h.settle();
    assert.equal(h.pocketWorkers().length, waits.length + 1);
    assert.equal(h.pocketWorkers().at(-1).starts, 1);
    h.voice.update({}, null, false); await h.settle();
    assert.equal(h.pocketWorkers().length, waits.length + 1, 'one load per retry, however many polls follow');
  }
  assert.deepEqual(waits, [45_000, 180_000, 600_000]);
  // The fourth failure ends it: a plain, permanent fallback, and nothing more is ever loaded.
  assert.equal(h.voice.pocketRetry, null); assert.deepEqual(h.voice.fallback, {from: 'pocket', to: 'text'});
  assert.equal(h.states.at(-1).pocketRetry, null); assert.ok(h.logs.some(line => /\[PocketRetry\] giving up/.test(line)));
  assert.equal(h.pocketWorkers().every(worker => worker.closes === 1), true);
  h.advance(86_400_000); h.voice.update({}, null, false); await h.settle(); assert.equal(h.pocketWorkers().length, 4);
  // The player chooses Pocket again: the normal start path, with the retry story reset.
  h.voice.update({voiceProvider: 'convai'}, null, false); h.voice.update({voiceProvider: 'pocket'}, null, false); await h.settle();
  assert.equal(h.pocketWorkers().length, 5); assert.equal(h.voice.provider, 'pocket'); assert.equal(h.voice.fallback, null);
  await h.voice.close(); assert.equal(h.live(), 0);
});

test('a Pocket that Windows blocked (Smart App Control, an Application Control policy) is not tried again and the problem says what blocked it', async () => {
  const h = retryFixture({pocket: ['blocked', 'ok']});
  h.voice.update({}, null, false); await h.settle(); h.voice.update({}, null, false); await h.settle();
  assert.equal(h.voice.provider, 'text');
  assert.equal(h.voice.voiceProblem().cause, 'blocked'); assert.equal(h.voice.voiceProblem().engine, 'pocket');
  assert.equal(h.voice.pocketRetry, null, 'no second try: it would import the same blocked file again');
  h.advance(86_400_000); h.voice.update({}, null, false); await h.settle();
  assert.equal(h.pocketWorkers().length, 1, 'no second worker was started');
  assert.ok(h.logs.some(line => /\[PocketRetry\] not trying again: Windows blocked/.test(line)));
  assert.equal(h.failures.length, 1, 'the failure is still reported once');
  // Another failure is retried as before and carries no cause.
  const other = retryFixture({pocket: ['fail', 'ok']});
  other.voice.update({}, null, false); await other.settle();
  assert.equal(other.voice.voiceProblem().cause, undefined); assert.ok(other.voice.pocketRetry);
  assert.equal(blockedByWindows('ImportError: DLL load failed while importing _streams: An Application Control policy has blocked this file.'), true);
  assert.equal(blockedByWindows('Pocket source differs from the pinned official revision'), false);
  assert.equal(blockedByWindows(undefined), false);
});

test('a Pocket that loads on a retry takes the route back at the next idle poll, and its failures start over', async () => {
  const h = retryFixture({pocket: ['fail', 'ok']});
  h.voice.update({}, null, false); await h.settle(); h.voice.update({}, null, false); await h.settle();
  assert.equal(h.voice.provider, 'text'); assert.equal(h.voice.profileReady('johnny-silverhand'), false);
  // The failure is told once with its reason and is a problem for the setup check while it lasts; a Pocket that loaded again is none.
  assert.deepEqual(h.failures, [{engine: 'pocket', reason: 'pocket worker failed'}]);
  assert.deepEqual(h.voice.voiceProblem(), {engine: 'pocket', reason: 'pocket worker failed'});
  h.advance(45_000); h.voice.update({}, null, false); await h.settle();
  assert.equal(h.pocketWorkers().length, 2); assert.equal(h.pocketWorkers()[1].loaded, true);
  assert.equal(h.voice.pocketRetry, null, 'a loaded Pocket ends the story');
  assert.equal(h.voice.voiceProblem(), null);
  h.voice.update({}, null, false); await h.settle();
  assert.equal(h.voice.provider, 'pocket'); assert.equal(h.voice.fallback, null); assert.equal(h.states.at(-1).pocketRetry, null);
  assert.equal(h.voice.profileReady('johnny-silverhand'), true);
  assert.ok(h.logs.some(line => /\[PocketRetry\] attempt 1 failed/.test(line)) && h.logs.some(line => /\[PocketRetry\] Pocket is ready again/.test(line)));
  // A crash later is a new story with the first wait again.
  h.pocketWorkers()[1].hooks.onState({state: 'error'}); await h.settle();
  assert.equal(h.voice.pocketRetry.failures, 1);
  h.voice.update({}, null, false); await h.settle();
  assert.deepEqual(h.voice.fallback, {from: 'pocket', to: 'text', temporary: true});
  await h.voice.close(); assert.equal(h.live(), 0);
});

test('a Pocket retry ends, or waits, when the voice is not wanted: another voice, playback Off, a closed service', async () => {
  // Another voice chosen while the retry waits: the story ends and nothing is loaded when it comes due.
  const away = retryFixture({pocket: ['fail']});
  away.voice.update({}, null, false); await away.settle(); away.voice.update({}, null, false); await away.settle();
  assert.ok(away.voice.pocketRetry);
  away.voice.update({voiceProvider: 'convai'}, null, false); await away.settle();
  assert.equal(away.voice.pocketRetry, null); away.advance(600_000); away.voice.update({}, null, false); await away.settle();
  assert.equal(away.pocketWorkers().length, 1); assert.equal(away.voice.provider, 'convai'); assert.equal(away.voice.fallback, null);
  await away.voice.close();
  // A worker loading on a retry is released when the player moves to another voice (the normal release of an unused worker).
  const loading = retryFixture({pocket: ['fail', 'hold']});
  loading.voice.update({}, null, false); await loading.settle(); loading.voice.update({}, null, false); await loading.settle();
  loading.advance(45_000); loading.voice.update({}, null, false); await loading.settle();
  const worker = loading.pocketWorkers()[1]; assert.ok(worker && worker.loaded === false);
  loading.voice.update({voiceProvider: 'convai'}, null, false); await loading.voice.retiring; await loading.settle();
  assert.equal(worker.closes, 1); assert.equal(loading.live(), 0); assert.equal(loading.voice.pocketRetry, null);
  await loading.voice.close();
  // Playback Off: due, but no worker is loaded; the wait keeps its place and the load follows when playback comes back.
  const quiet = retryFixture({pocket: ['fail']});
  quiet.voice.update({}, null, false); await quiet.settle(); quiet.voice.update({}, null, false); await quiet.settle();
  quiet.voice.update({voice: false}, null, false); await quiet.settle(); quiet.advance(60_000);
  quiet.voice.update({voice: false}, null, false); await quiet.settle();
  assert.equal(quiet.pocketWorkers().length, 1); assert.ok(quiet.voice.pocketRetry);
  quiet.voice.update({voice: true}, null, false); await quiet.settle(); quiet.voice.update({}, null, false); await quiet.settle();
  assert.equal(quiet.pocketWorkers().length, 2); assert.equal(quiet.voice.provider, 'pocket');
  await quiet.voice.close();
  // The service closing ends it.
  const closing = retryFixture({pocket: ['fail']});
  closing.voice.update({}, null, false); await closing.settle(); closing.voice.update({}, null, false); await closing.settle();
  await closing.voice.close(); assert.equal(closing.voice.pocketRetry, null);
  closing.advance(600_000); closing.voice.update({}, null, false); await closing.settle(); assert.equal(closing.pocketWorkers().length, 1);
});

test('with the real OmniVoice client, a silent start leaves replies as text (no Pocket), then a below-normal worker loads and takes over at idle', async () => {
  const {EventEmitter} = await import('node:events');
  const {PassThrough, Writable} = await import('node:stream');
  const {constants} = await import('node:os');
  const {VOICE_WORKER_LIMITS} = await import('./resident-voice.mjs');
  // Fake timers for the worker (stall window, exit allowances) and a separate selection clock for the retry wait.
  const jobs = new Map(); let time = 0, sequence = 0;
  const timers = {set: (callback, delay) => { jobs.set(++sequence, {callback, at: time + delay}); return sequence; }, clear: id => jobs.delete(id),
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const next = [...jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        jobs.delete(next[0]); time = next[1].at; next[1].callback();
      }
      time = target;
    }};
  let now = 1000; const children = [], priorities = [];
  const spawnImpl = () => {
    const child = new EventEmitter(); child.pid = 4000 + children.length; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({write(chunk, encoding, done) { done(); }});
    child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true; };
    children.push(child); return child;
  };
  const omniVoices = Object.fromEntries(LOCAL_VOICE_KEYS.map(key => [key, {reference: `runtime/voice-references/${key}.wav`,
    sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.'}]));
  const pocketWorkers = [];
  const voice = new VoiceSelection(pocketSettings(omniVoices), {project: process.cwd(), spawnImpl, setTimer: timers.set, clearTimer: timers.clear,
    setPriority: (pid, level) => priorities.push([pid, level]), clock: () => now,
    omniConfig: {provider: 'hybrid', engine: 'omnivoice', voices: omniVoices},
    factory: (config, {onState}) => {
      let loaded = false;
      const worker = {get loaded() { return loaded; }, hasProfile: key => Object.hasOwn(config.voices, key), profileReady(key) { return loaded && this.hasProfile(key); },
        async prepareProfile(profile) { return {provider: 'pocket', ready: true, profile}; },
        async start() { loaded = true; onState({state: 'ready', resident: true}); },
        async close() { loaded = false; this.closed = true; onState({state: 'stopped'}); }};
      pocketWorkers.push(worker); return worker;
    }});
  const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
  const ready = child => child.stdout.write(JSON.stringify({op: 'ready', profiles: LOCAL_VOICE_KEYS, device: 'cuda:0', dtype: 'torch.float16',
    runtime: 'pytorch', tensorrt: false, compiled: false, cudaAllocatedMiB: 1800, cudaReservedMiB: 2208}) + '\n');
  // The first OmniVoice start never says a word.
  voice.update({voiceProvider: 'omni', omniSteps: 16}, null, false); await settle();
  assert.equal(children.length, 1); assert.deepEqual(priorities, [], 'the first start keeps normal priority');
  timers.advance(VOICE_WORKER_LIMITS.startupStallMs - 1); await settle(); assert.equal(voice.failedBackends.has('omni'), false);
  timers.advance(1); await settle(); assert.equal(voice.failedBackends.has('omni'), true);
  timers.advance(VOICE_WORKER_LIMITS.exitGraceMs); await settle();
  voice.update({}, null, false); await voice.start(); await settle();
  assert.equal(voice.provider, 'text'); assert.deepEqual(voice.fallback, {from: 'omni', to: 'text', temporary: true});
  assert.equal(pocketWorkers.length, 0, 'Pocket is not loaded in place of OmniVoice');
  // 45 s later, with the game idle, a second worker loads at below-normal priority.
  now += 45_000; voice.update({}, null, false); await settle();
  assert.equal(children.length, 2); assert.deepEqual(priorities, [[4001, constants.priority.PRIORITY_BELOW_NORMAL]]);
  assert.equal(voice.provider, 'text');
  // It reports progress and finishes; the route stays written until the idle poll.
  children[1].stdout.write(JSON.stringify({op: 'state', state: 'loading'}) + '\n'); await settle();
  ready(children[1]); await settle();
  assert.equal(voice.omniRetry, null); assert.equal(voice.provider, 'text');
  assert.deepEqual(priorities.at(-1), [4001, constants.priority.PRIORITY_NORMAL], 'normal priority once ready');
  voice.update({}, null, true); await settle(); assert.equal(voice.provider, 'text', 'never mid-reply');
  voice.update({}, null, false); await voice.retiring; await settle();
  assert.equal(voice.provider, 'omni'); assert.equal(voice.fallback, null); assert.equal(children.length, 2, 'the loaded worker is adopted');
  assert.equal(pocketWorkers.length, 0); assert.equal(voice.profileReady('johnny-silverhand'), true);
  assert.equal(voice.client.loaded, true); assert.equal(voice.client.child, children[1]);
  const closed = voice.close(); children[1].emit('close', 0); await closed;
});

test('a loaded background Omni for a reference the player no longer wants is released, and the wanted one loads after its exit', async () => {
  const h = retryFixture({omni: ['fail', 'hold']});
  h.voice.update({voiceProvider: 'omni', omniReference: 'long'}, null, false); await h.settle();
  h.voice.update({}, null, false); await h.voice.start(); await h.settle();
  h.advance(45_000); h.voice.update({}, null, false); await h.settle();
  const candidate = h.omniWorkers()[1]; candidate.gate.resolve(); await h.settle();
  assert.equal(h.voice.candidate.loaded, true);
  // A reply is in flight, so the commit waits; meanwhile the player picks the other reference set. Nothing else is loaded, so the loaded worker
  // takes the empty slot at once (the route stays written until the idle commit), and the reference change then releases it.
  h.voice.update({omniReference: 'short'}, null, true); await h.settle();
  assert.equal(h.voice.candidate, null); assert.equal(h.voice.client, candidate); assert.equal(h.voice.provider, 'text', 'never mid-reply');
  h.voice.update({omniReference: 'short'}, null, false); await h.voice.retiring; await h.settle();
  assert.equal(candidate.closes, 1, 'the unwanted worker is released'); assert.equal(h.omniWorkers().length, 3); assert.equal(h.omniWorkers()[2].starts, 1);
  assert.equal(h.voice.provider, 'omni'); assert.equal(h.voice.omniReference, 'short'); assert.equal(h.voice.client, h.omniWorkers()[2]);
  await h.voice.close(); assert.equal(h.live(), 0);
});

test('a failure that carries the worker graphics memory passes it on to the observer; one without it stays as it was', () => {
  const h = retryFixture({omni: ['hold']});
  h.voice.noteFailure('omni', 'Local voice generation timed out', {dedicatedMiB: 2100, sharedMiB: 1650});
  h.voice.noteFailure('pocket', 'Pocket student runtime is unavailable');
  assert.deepEqual(h.failures, [{engine: 'omni', reason: 'Local voice generation timed out', gpu: {dedicatedMiB: 2100, sharedMiB: 1650}},
    {engine: 'pocket', reason: 'Pocket student runtime is unavailable'}]);
});
