import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VoiceSelection} from './voice-selection.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';
import {createVoiceProfileRegistry} from './voice-profile-registry.mjs';

const tick = () => new Promise(done => setImmediate(done));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {resolve, promise}; };
function fixture({holdWarm = false, holdClose = false, extraProfiles = {}, unavailableProfiles = []} = {}) {
  const workers = [], states = []; let live = 0, peak = 0;
  const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(key => [key, {
    reference: `runtime/voice-references/${key}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.',
  }]));
  Object.assign(voices, extraProfiles);
  const voice = new VoiceSelection({version: Object.keys(extraProfiles).length ? 2 : 1,
    provider: 'hybrid', engine: 'omnivoice', steps: 32, voices}, {onState: value => states.push(value),
    factory: (config, {onState}) => {
      const warm = defer(), released = defer(); let loaded = false, owned = false;
      const worker = {steps: config.steps, warm, released, starts: 0, closes: 0, calls: [],
        get loaded() { return loaded; }, hasProfile(key) { return Object.hasOwn(config.voices, key) && !unavailableProfiles.includes(key); },
        profileReady(key) { return loaded && this.hasProfile(key); },
        async prepareProfile(key) { return {provider: 'omnivoice', ready: this.profileReady(key), profile: key}; },
        setSteps(value) { this.steps = value; },
        async start() {
          this.starts++; owned = true; live++; peak = Math.max(peak, live);
          if (holdWarm) await warm.promise;
          loaded = true;
          onState({state: 'ready', resident: true, workerPid: workers.length, cudaReservedMiB: 2200});
        },
        async synthesize(profile, text, options) { this.calls.push({profile, text, ...options}); return {audio: 'wav'}; },
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
  h.voice.request({voiceProvider: 'hybrid'}); h.voice.applyWhenIdle(false);
  await h.voice.start(); await h.voice.start();
  for (const key of LOCAL_VOICE_KEYS) assert.equal(h.voice.usesProfile(key), true);
  assert.equal(h.voice.usesProfile('blue-moon'), false);
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].starts, 1);
  await h.voice.synthesize('judy-alvarez', 'Hi'); assert.equal(h.workers[0].calls[0].steps, 16);
  await h.voice.close(); assert.equal(h.live(), 0);
});

test('wider registry routes additional prepared characters locally and incomplete profiles remotely', async () => {
  const h = fixture({extraProfiles: {alex: {reference: 'runtime/voice-references/alex.wav',
    sha256: 'b'.repeat(64), transcript: 'Hello.'}, 'blue-moon': {status: 'unprepared'}}});
  assert.equal(h.voice.usesProfile('alex'), true);
  assert.equal(h.voice.usesProfile('blue-moon'), false);
  assert.equal(h.voice.profileReady('alex'), false);
  const prepared = await h.voice.prepareProfile('alex');
  assert.equal(prepared.provider, 'omnivoice'); assert.equal(prepared.ready, true);
  assert.equal(h.voice.profileReady('alex'), true);
  assert.deepEqual(await h.voice.prepareProfile('blue-moon'), {provider: 'convai', ready: true, reason: 'unprepared'});
  await h.voice.synthesize('alex', 'Additional character.');
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].calls[0].profile, 'alex');
  assert.deepEqual(h.voice.profileKeys, [...LOCAL_VOICE_KEYS, 'alex'].sort());
  await h.voice.close();
});

test('an absent reference discovered during startup becomes remote before invitation readiness', async () => {
  const h = fixture({holdWarm: true, unavailableProfiles: ['judy-alvarez']});
  const preparation = h.voice.prepareProfile('judy-alvarez'); await tick();
  assert.equal(h.voice.usesProfile('judy-alvarez'), true, 'configured route stays provisional during worker startup');
  h.workers[0].warm.resolve();
  await tick(); assert.equal(h.voice.usesProfile('judy-alvarez'), true);
  assert.equal(h.voice.availabilityPending, true);
  h.voice.applyWhenIdle(false);
  assert.deepEqual(await preparation, {provider: 'convai', ready: true, reason: 'unavailable'});
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
  assert.equal(h.voice.update({voiceProvider: 'hybrid', omniSteps: 32}, null, true), false);
  assert.equal(h.voice.routeRevision, 0); assert.deepEqual(h.voice.consumeRouteChanges(), []);
  let complete = false;
  const preparation = h.voice.prepareProfile('judy-alvarez').then(value => { complete = true; return value; });
  await tick(); assert.equal(complete, false, 'Invite waits without holding the polling loop');
  assert(h.voice.update({voiceProvider: 'hybrid', omniSteps: 32}, null, false));
  assert.equal(h.voice.usesProfile('judy-alvarez'), false); assert.equal(h.voice.routeRevision, 1);
  assert.deepEqual(h.voice.consumeRouteChanges(), ['judy-alvarez']); assert.deepEqual(h.voice.consumeRouteChanges(), []);
  assert.deepEqual(await preparation, {provider: 'convai', ready: true, reason: 'unavailable'});
  await h.voice.close();
});

test('valid preparation waits for any staged routing commit and preserves exact speaker receipt', async () => {
  const h = fixture({holdWarm: true, unavailableProfiles: ['judy-alvarez']});
  const preparation = h.voice.prepareProfile('johnny-silverhand'); await tick();
  h.workers[0].warm.resolve(); await tick();
  assert.equal(h.voice.routingWaiters.size, 1);
  h.voice.applyWhenIdle(false);
  assert.deepEqual(await preparation, {provider: 'omnivoice', ready: true, profile: 'johnny-silverhand'});
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

test('a pending Omni selection cannot issue an early remote-ready invitation receipt during an owned turn', async () => {
  const h = fixture(); h.voice.update({voiceProvider: 'convai'}, null, false);
  h.voice.update({voiceProvider: 'hybrid'}, null, true);
  await tick(); let ready = false;
  const preparation = h.voice.prepareProfile('judy-alvarez').then(receipt => { ready = true; return receipt; });
  await tick(); assert.equal(ready, false); assert.equal(h.voice.provider, 'convai');
  h.voice.update({voiceProvider: 'hybrid'}, null, false);
  assert.deepEqual(await preparation, {provider: 'omnivoice', ready: true, profile: 'judy-alvarez'});
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
  assert.deepEqual(await preparation, {provider: 'convai', ready: true, reason: 'unavailable'});
  for (const key of LOCAL_VOICE_KEYS) assert.equal(h.voice.usesProfile(key), false);
  h.voice.prepare({provider: 'hybrid', steps: 32});
  await h.voice.start(); h.voice.update({voiceProvider: 'convai'}, null, false);
  h.voice.update({voiceProvider: 'hybrid'}, null, false); await h.voice.start();
  assert.equal(h.workers.length, 1, 'known empty availability cannot create a restart/warmup loop');
  assert.equal(h.states.at(-1).resident, false); assert.equal(h.states.at(-1).cudaReservedMiB, 0);
  await h.voice.close();
});

test('a voice configuration with no ready references never starts a speculative GPU worker', async () => {
  const voice = new VoiceSelection({version: 2, provider: 'hybrid', engine: 'omnivoice',
    voices: {alex: {status: 'unprepared'}}}, {factory() { throw Error('must not create worker'); }});
  voice.prepare({provider: 'hybrid', steps: 32}); await voice.start();
  assert.equal(voice.configured, false); assert.equal(voice.usesProfile('alex'), false);
  assert.deepEqual(await voice.prepareProfile('alex'), {provider: 'convai', ready: true, reason: 'unprepared'});
  await voice.close();
});

test('the frozen worker configuration retains explicit remote entries and legacy source-key compatibility', () => {
  const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(key => [key, key === 'judy-alvarez' ? {status: 'unprepared'} : {
    reference: `runtime/voice-references/${key}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.',
  }]));
  const voice = new VoiceSelection({provider: 'hybrid', engine: 'omnivoice', voices});
  assert.equal(voice.config.voices['judy-alvarez'].status, 'unprepared');
  assert.equal(voice.usesProfile('judy-alvarez'), false);
  assert.equal(createVoiceProfileRegistry(voice.config).status('judy-alvarez'), 'unprepared');
  voices['judy-alvarez'].status = 'ready';
  assert.equal(voice.config.voices['judy-alvarez'].status, 'unprepared');
});

test('provider and quality stay fixed while a turn owns local generation', async () => {
  const h = fixture(); await h.voice.start();
  h.voice.request({voiceProvider: 'convai', omniSteps: 16});
  assert.equal(h.voice.applyWhenIdle(true), false);
  assert.equal(h.voice.provider, 'hybrid'); assert.equal(h.voice.steps, 32);
  assert.equal(h.states.at(-1).pending, true);
  await h.voice.synthesize('judy-alvarez', 'First phrase');
  await h.voice.synthesize('judy-alvarez', 'Last phrase');
  assert.deepEqual(h.workers[0].calls.map(call => call.steps), [32, 32]);
  assert(h.voice.applyWhenIdle(false)); await h.voice.retiring;
  assert.equal(h.voice.provider, 'convai'); assert.equal(h.voice.steps, 16);
  assert.equal(h.live(), 0); assert.equal(h.states.at(-1).resident, false);
  assert.equal(h.states.at(-1).cudaReservedMiB, 0);
});

test('rapid switches cannot overlap workers or start a local choice that was superseded', async () => {
  const h = fixture({holdClose: true}); await h.voice.start();
  h.voice.request({voiceProvider: 'convai'}); h.voice.applyWhenIdle(false); await tick();
  assert.equal(h.voice.state, 'releasing'); assert.equal(h.live(), 1);
  h.voice.request({voiceProvider: 'hybrid'}); h.voice.applyWhenIdle(false);
  await tick(); assert.equal(h.workers[1].starts, 0);
  h.voice.request({voiceProvider: 'convai'}); h.voice.applyWhenIdle(false);
  h.workers[0].released.resolve(); await h.voice.retiring;
  assert.equal(h.workers[1].starts, 0); assert.equal(h.peak(), 1); assert.equal(h.live(), 0);
  assert.equal(h.voice.state, 'remote');
});

test('switching while warming lets GPU initialization finish then releases it without stale ready state', async () => {
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
  const first = h.voice.synthesize('judy-alvarez', 'Cancelled during warmup', {signal: controller.signal});
  await tick(); const rejected = assert.rejects(first, /cancelled/);
  controller.abort(); await rejected;
  assert.equal(h.workers[0].closes, 0); assert.equal(h.workers[0].calls.length, 0);
  h.workers[0].warm.resolve(); await h.voice.start();
  await h.voice.synthesize('judy-alvarez', 'New conversation');
  assert.equal(h.workers[0].calls.length, 1); assert.equal(h.workers.length, 1);
  await h.voice.close();
});

test('an unconfirmed retirement keeps replacement workers from starting', async () => {
  const h = fixture(); await h.voice.start();
  h.workers[0].close = async () => { throw Error('exit could not be confirmed'); };
  h.voice.request({voiceProvider: 'convai'}); h.voice.applyWhenIdle(false);
  await assert.rejects(h.voice.retiring, /exit could not be confirmed/);
  h.voice.request({voiceProvider: 'hybrid'}); h.voice.applyWhenIdle(false);
  await assert.rejects(h.voice.start(), /exit could not be confirmed/);
  assert.equal(h.workers[1].starts, 0); assert.equal(h.peak(), 1);
  h.voice.request({voiceProvider: 'convai'}); h.voice.applyWhenIdle(false);
  await assert.rejects(h.voice.retiring, /exit could not be confirmed/);
});

test('malformed settings retain the valid selection; a withdrawn pending change is never applied', async () => {
  const h = fixture(); await h.voice.start();
  h.voice.request({voiceProvider: 'convai'}); h.voice.applyWhenIdle(true);
  h.voice.request({voiceProvider: 'hybrid'}); assert.equal(h.voice.applyWhenIdle(false), false);
  h.voice.request({voiceProvider: 'unknown', omniSteps: 8}); h.voice.request(null);
  assert.equal(h.voice.applyWhenIdle(false), false); assert.equal(h.voice.steps, 32);
  assert.equal(h.voice.provider, 'hybrid'); assert.equal(h.workers.length, 1);
  await h.voice.close(); assert.equal(h.voice.state, 'stopped');
});

test('a draft warms one model before Apply while saved routing stays Convai',async()=>{
  const h=fixture();
  h.voice.update({voiceProvider:'convai',omniSteps:32},null,false);await tick();
  assert.equal(h.workers.length,0,'initial saved Convai does not create a speculative worker');
  h.voice.update({voiceProvider:'convai',omniSteps:32},{provider:'hybrid',steps:16},true);
  await tick();await h.voice.start();
  assert.equal(h.workers.length,1);assert.equal(h.workers[0].starts,1);
  assert.equal(h.voice.provider,'convai');assert.equal(h.voice.usesProfile('judy-alvarez'),false);
  assert.equal(h.voice.pending,false);assert.equal(h.states.at(-1).preparationOnly,true);
  assert.equal(h.states.at(-1).previewActive,true);
  h.voice.update({voiceProvider:'hybrid',omniSteps:16},null,false);
  await h.voice.synthesize('judy-alvarez','Hi');
  assert.equal(h.workers.length,1);assert.equal(h.workers[0].starts,1);
  assert.equal(h.workers[0].calls[0].steps,16);assert.equal(h.states.at(-1).preparationOnly,false);
  await h.voice.close();
});

test('committed Omni prepares during a remote reply and changes routing only afterward',async()=>{
  const h=fixture({holdWarm:true});h.voice.update({voiceProvider:'convai'},null,false);
  assert.equal(h.voice.update({voiceProvider:'hybrid',omniSteps:16},null,true),false);
  await tick();assert.equal(h.workers[0].starts,1);
  assert.equal(h.voice.provider,'convai');assert.equal(h.voice.steps,32);
  h.workers[0].warm.resolve();await h.voice.start();
  assert(h.voice.update({voiceProvider:'hybrid',omniSteps:16},null,false));
  assert.equal(h.voice.provider,'hybrid');assert.equal(h.voice.steps,16);
  assert.equal(h.workers[0].starts,1);await h.voice.close();
});

test('Revert releases preview-only memory; rapid reselect waits for confirmed retirement',async()=>{
  const h=fixture({holdClose:true});h.voice.update({voiceProvider:'convai'},null,false);
  h.voice.prepare({provider:'hybrid',steps:32});await h.voice.start();
  h.voice.update({voiceProvider:'convai'},null,true);await tick();
  assert.equal(h.workers[0].closes,1);assert.equal(h.voice.state,'releasing');
  h.voice.prepare({provider:'hybrid',steps:16});await tick();
  assert.equal(h.workers[1].starts,0);
  h.workers[0].released.resolve();await h.voice.start();
  assert.equal(h.workers[1].starts,1);assert.equal(h.peak(),1);
  h.workers[1].released.resolve();await h.voice.close();assert.equal(h.live(),0);
});

test('a remote draft does not unload an applied Omni choice or alter an owned turn',async()=>{
  const h=fixture();await h.voice.start();
  h.voice.update({voiceProvider:'hybrid',omniSteps:32},{provider:'convai',steps:16},true);
  assert.equal(h.workers[0].closes,0);assert.equal(h.voice.provider,'hybrid');
  await h.voice.synthesize('judy-alvarez','Current phrase');
  assert.equal(h.workers[0].calls[0].steps,32);
  h.voice.update({voiceProvider:'convai',omniSteps:16},null,true);
  assert.equal(h.workers[0].closes,0);
  h.voice.update({voiceProvider:'convai',omniSteps:16},null,false);await h.voice.retiring;
  assert.equal(h.workers[0].closes,1);assert.equal(h.live(),0);
});
