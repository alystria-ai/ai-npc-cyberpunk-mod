import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VoiceSelection} from './voice-selection.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';

const tick = () => new Promise(done => setImmediate(done));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {resolve, promise}; };
function fixture({holdWarm = false, holdClose = false} = {}) {
  const workers = [], states = []; let live = 0, peak = 0;
  const voice = new VoiceSelection({provider: 'hybrid', steps: 32}, {onState: value => states.push(value),
    factory: (config, {onState}) => {
      const warm = defer(), released = defer(); let loaded = false;
      const worker = {steps: config.steps, warm, released, starts: 0, closes: 0, calls: [],
        setSteps(value) { this.steps = value; },
        async start() {
          this.starts++; live++; peak = Math.max(peak, live); loaded = true;
          if (holdWarm) await warm.promise;
          onState({state: 'ready', resident: true, workerPid: workers.length, cudaReservedMiB: 2200});
        },
        async synthesize(profile, text, options) { this.calls.push({profile, text, ...options}); return {audio: 'wav'}; },
        async close() {
          this.closes++;
          if (holdClose && loaded) await released.promise;
          if (loaded) live--;
          loaded = false; onState({state: 'stopped', resident: false});
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
