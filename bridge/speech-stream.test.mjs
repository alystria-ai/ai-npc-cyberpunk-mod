import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SpeechSlots, SpeechStream, splitSpeechText} from './speech-stream.mjs';
import {silentWav} from './speech-audio.mjs';

const tick = () => new Promise(done => setImmediate(done));
const owner = {requestId: 'one', generation: 4, entity: 'judy-2'};
const audio = {audio: silentWav().toString('base64'), timing: {voiceSteps: 32}};
function harness(count = 6) {
  const h = {state: {}, current: true, writes: [], manifests: [], generated: [], waiters: []};
  const slots = new SpeechSlots({depot: 'unused', readState: async () => h.state,
    store: async (base64, depot, slot) => {
      assert.notEqual(slot, h.state.requestId && h.state.slot);
      h.writes.push(slot); return {slot, event: `convai_reply_${slot}`, duration: 2};
    }});
  h.stream = new SpeechStream({input: owner, steps: 32, phrases: Array.from({length: count}, (_, n) => `Phrase ${n + 1}.`),
    slots, current: async () => h.current, readState: async () => h.state,
    writeManifest: async value => h.manifests.push(structuredClone(value)),
    synthesize: async (text, options) => { h.generated.push({text, options}); return audio; },
    wait: () => new Promise(done => h.waiters.push(done))});
  h.ack = (completed, extra = {}) => {
    h.state = {requestId: owner.requestId, state: 'playing', updated: Date.now(),
      streamId: h.stream.manifest.streamId, completedChunk: completed,
      slot: h.writes[completed], ...extra};
    h.waiters.splice(0).forEach(done => done());
  };
  return h;
}

test('phrases preserve every word and favour natural boundaries with a short first phrase', () => {
  const text = 'Hey V, I have been thinking about what happened last night. We could head down to the market together, pick up some food and talk about the next job. That sounds good to me.';
  const phrases = splitSpeechText(text);
  assert.equal(phrases.join(' '), text);
  assert.equal(phrases[0], 'Hey V, I have been thinking about what happened last night.');
  assert.ok(phrases.length > 1);
  assert.deepEqual(splitSpeechText('Hey, V.'), ['Hey, V.']);
  assert.throws(() => splitSpeechText(''), /Invalid/);
  const unpunctuated = Array.from({length: 100}, (_, n) => `word${n}`).join(' ');
  assert.equal(splitSpeechText(unpunctuated).join(' '), unpunctuated);
});

test('first phrase publishes immediately; production stays two phrases ahead and never overwrites playing audio', async () => {
  const h = harness(10);
  await h.stream.begin(audio);
  assert.equal(h.manifests.length, 1); assert.equal(h.generated.length, 0);
  h.ack(0);
  const finished = h.stream.finish();
  await tick();
  assert.equal(h.writes.length, 3);
  assert.equal(h.stream.manifest.complete, false);
  // A paused consumer does not cause generation of the whole reply.
  h.ack(0, {paused: true}); await tick(); assert.equal(h.writes.length, 3);
  for (let done = 1; done <= 8; done++) {
    h.ack(done); await tick();
    assert.ok(h.writes.length - done <= 3);
  }
  await finished;
  assert.equal(h.writes.length, 10); assert.equal(h.stream.manifest.complete, true);
  assert.ok(h.generated.every(x => x.options.steps === 32));
  assert.equal(new Set(h.writes).size, 8); // safely reused only after acknowledgement
});

test('late generation after cancellation cannot publish another phrase or its face timeline', async () => {
  const h = harness(3); let release;
  h.stream.synthesize = () => new Promise(done => { release = done; });
  await h.stream.begin(audio); h.ack(0);
  const finished = h.stream.finish(); await tick();
  h.current = false; release(audio); await finished;
  assert.equal(h.manifests.length, 1); assert.equal(h.writes.length, 1);
});

test('mid-reply generation failure terminates the partial manifest without losing the spoken phrase', async () => {
  const h = harness(3);
  h.stream.synthesize = async () => { throw Error('worker disconnected'); };
  await h.stream.begin(audio); h.ack(0); await h.stream.finish();
  assert.equal(h.manifests.at(-1).chunks.length, 1);
  assert.equal(h.manifests.at(-1).complete, true);
  assert.match(h.manifests.at(-1).error, /rest of the voice/);
  assert.equal(h.stream.error, 'worker disconnected');
});

test('consumer cancellation stops read-ahead even though input.json has not changed', async () => {
  const h = harness(6);
  await h.stream.begin(audio); h.ack(0);
  const finished = h.stream.finish(); await tick();
  h.ack(1, {requestId: undefined, state: 'target-lost'}); await finished;
  assert.equal(h.writes.length, 3);
  assert.equal(h.manifests.at(-1).complete, false);
});
