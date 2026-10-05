import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {VoiceSelection} from './voice-selection.mjs';
import {LOCAL_VOICE_KEYS, ResidentVoice} from './resident-voice.mjs';
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
function fixture({holdWarm = false, holdClose = false, extraProfiles = {}, unavailableProfiles = [], omniConfig = {}, phoneAnalysis} = {}) {
  const workers = [], states = []; let live = 0, peak = 0;
  const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(key => [key, {
    reference: `runtime/voice-references/${key}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.',
  }]));
  Object.assign(voices, extraProfiles);
  const voice = new VoiceSelection(pocketSettings(voices), {omniConfig, phoneAnalysis, onState: value => states.push(value),
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

test('wider registry routes additional prepared characters locally and incomplete profiles remotely', async () => {
  const h = fixture({extraProfiles: {alex: {reference: 'runtime/voice-references/alex.wav',
    sha256: 'b'.repeat(64), transcript: 'Hello.'}, 'blue-moon': {status: 'unprepared'}}});
  assert.equal(h.voice.usesProfile('alex'), true);
  assert.equal(h.voice.usesProfile('blue-moon'), false);
  assert.equal(h.voice.profileReady('alex'), false);
  const prepared = await h.voice.prepareProfile('alex');
  assert.equal(prepared.provider, 'pocket'); assert.equal(prepared.ready, true);
  assert.equal(h.voice.profileReady('alex'), true);
  assert.deepEqual(await h.voice.prepareProfile('blue-moon'), {provider: 'convai', ready: true, reason: 'unprepared'});
  await h.voice.synthesizeStream('alex', 'Additional character.');
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
  assert.equal(h.voice.update({voiceProvider: 'pocket', omniSteps: 32}, null, true), false);
  assert.equal(h.voice.routeRevision, 0); assert.deepEqual(h.voice.consumeRouteChanges(), []);
  let complete = false;
  const preparation = h.voice.prepareProfile('judy-alvarez').then(value => { complete = true; return value; });
  await tick(); assert.equal(complete, false, 'Invite waits without holding the polling loop');
  assert(h.voice.update({voiceProvider: 'pocket', omniSteps: 32}, null, false));
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
  assert.deepEqual(await preparation, {provider: 'convai', ready: true, reason: 'unavailable'});
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
  assert.deepEqual(await voice.prepareProfile('alex'), {provider: 'convai', ready: true, reason: 'unprepared'});
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
  // The default is OmniVoice; a test that needs another committed start asks for it.
  if(start){voice.request({voiceProvider:start});voice.applyWhenIdle(false);}
  return{voice,calls,workers,states,live:()=>live,peak:()=>peak};
}

test('four choices default to OmniVoice 32; both Omni qualities share the one warmed model and cache',async()=>{
  const h=dualFixture();await h.voice.start();
  assert.equal(h.voice.provider,'omni');assert.equal(h.voice.requestedProvider,'omni');assert.equal(h.voice.steps,32);
  assert.equal(h.workers[0].backend,'omni');assert.equal(h.voice.fallback,null);
  h.voice.update({voiceProvider:'omni',omniSteps:16},null,false);await h.voice.start();
  assert.equal(h.peak(),1);assert.equal(h.workers.length,1);assert.equal(h.workers[0].steps,16);
  assert.deepEqual(await h.voice.prepareProfile('johnny-silverhand'),
    {provider:'omni',ready:true,profile:'johnny-silverhand'});
  await h.voice.synthesize('johnny-silverhand','First sentence.');
  h.voice.update({voiceProvider:'omni',omniSteps:32},null,false);await h.voice.start();
  await h.voice.synthesize('johnny-silverhand','Second sentence.');
  assert.equal(h.workers.length,1);assert.equal(h.workers[0].starts,1);assert.equal(h.workers[0].closes,0);
  assert.deepEqual(h.calls.filter(value=>Array.isArray(value)).map(value=>value.at(-1)),[16,32]);
  assert.deepEqual(await h.voice.prepareProfile('blue-moon'),{provider:'convai',ready:true,reason:'unprepared'});
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

test('the default list order is OmniVoice, then Pocket, then Convai',async()=>{
  const {VOICE_FALLBACK_ORDER}=await import('./voice-selection.mjs');
  assert.deepEqual([...VOICE_FALLBACK_ORDER],['omni','pocket','convai']);
  const h=dualFixture();
  assert.equal(h.voice.provider,'omni');assert.equal(h.voice.requestedProvider,'omni');assert.equal(h.voice.steps,32);
  await h.voice.close();
});

test('an Omni worker that cannot start falls to Pocket once, and invitation readiness follows the fallback',async()=>{
  const h=dualFixture({fail:['omni']});
  const invited=h.voice.prepareProfile('johnny-silverhand');
  await tick();await tick();
  // The fallback commits at the next idle settings poll, like any routing change.
  h.voice.update({},null,false);
  assert.deepEqual(await invited,{provider:'pocket',ready:true,profile:'johnny-silverhand'});
  assert.equal(h.voice.provider,'pocket');assert.equal(h.voice.requestedProvider,'omni');
  assert.deepEqual(h.voice.fallback,{from:'omni',to:'pocket'});
  assert.deepEqual(h.states.at(-1).fallback,{from:'omni',to:'pocket'});
  assert.equal(h.workers.filter(worker=>worker.backend==='omni').length,1,'a failed Omni is not restarted in a loop');
  h.voice.update({},null,false);await tick();
  assert.equal(h.workers.filter(worker=>worker.backend==='omni').length,1);
  // Choosing OmniVoice again is an explicit retry.
  h.voice.update({voiceProvider:'pocket'},null,false);assert.equal(h.voice.fallback,null);
  h.voice.update({voiceProvider:'omni',omniSteps:32},null,false);await tick();await tick();
  assert.equal(h.workers.filter(worker=>worker.backend==='omni').length,2);
  await h.voice.close();
});

test('a failure during an owned turn waits for the idle boundary before the route changes',async()=>{
  const h=dualFixture({fail:['omni']});h.voice.update({},null,true);
  await h.voice.start().catch(()=>{});await tick();
  assert.equal(h.voice.provider,'omni','the owned turn keeps its route');assert.equal(h.voice.pending,true);
  h.voice.update({},null,false);
  assert.equal(h.voice.provider,'pocket');assert.deepEqual(h.voice.fallback,{from:'omni',to:'pocket'});
  await h.voice.close();
});

test('Pocket failing, or both local voices failing, falls down to Convai',async()=>{
  const pocketOnly=dualFixture({start:'pocket',fail:['pocket']});
  await pocketOnly.voice.start().catch(()=>{});await tick();pocketOnly.voice.update({},null,false);
  assert.equal(pocketOnly.voice.provider,'convai');assert.deepEqual(pocketOnly.voice.fallback,{from:'pocket',to:'convai'});
  assert.equal((await pocketOnly.voice.prepareProfile('johnny-silverhand')).provider,'convai');
  await pocketOnly.voice.close();
  const both=dualFixture({fail:['omni','pocket']});
  await both.voice.start().catch(()=>{});await tick();both.voice.update({},null,false);
  await both.voice.start().catch(()=>{});await tick();both.voice.update({},null,false);
  assert.equal(both.voice.provider,'convai');assert.deepEqual(both.voice.fallback,{from:'omni',to:'convai'});
  await both.voice.close();
});

test('a saved Convai choice never reports a fallback, and a missing Omni setup starts on Pocket',async()=>{
  const convai=dualFixture({start:'convai'});
  assert.equal(convai.voice.provider,'convai');assert.equal(convai.voice.fallback,null);await convai.voice.close();
  const h=fixture();
  assert.equal(h.voice.requestedProvider,'omni');assert.equal(h.voice.provider,'pocket');
  assert.deepEqual(h.voice.fallback,{from:'omni',to:'pocket'});
  await h.voice.close();
});
