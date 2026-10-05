import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SpeechSlots, SpeechStream, splitSpeechText} from './speech-stream.mjs';
import {silentWav} from './speech-audio.mjs';

const tick = () => new Promise(done => setImmediate(done));
const owner = {requestId: 'one', generation: 4, entity: 'judy-2'};
const audio = {audio: silentWav().toString('base64'), timing: {voiceSteps: 32}};
function harness(count = 6, options = {}) {
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
    wait: () => new Promise(done => h.waiters.push(done)), ...options});
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

test('every locally synthesized Omni phrase retains one correlated Convai expression receipt',async()=>{
  const h=harness(3),expressionSignal={version:1,correlated:true,sequence:0,emotion:'Grief',scale:2};
  await h.stream.begin({...audio,expressionSignal});h.ack(0);await h.stream.finish();
  assert.equal(h.manifests.at(-1).chunks.length,3);
  for(const chunk of h.manifests.at(-1).chunks)
    assert.deepEqual(chunk.face.expression,{version:1,...owner,sequence:0,emotion:'Grief',scale:2});
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
  const h = harness(3), releases = [];
  h.stream.synthesize = () => new Promise(done => { releases.push(done); });
  await h.stream.begin(audio); h.ack(0);
  const finished = h.stream.finish(); await tick();
  h.current = false; releases.forEach(release => release(audio)); await finished;
  assert.equal(h.manifests.length, 1); assert.equal(h.writes.length, 1);
});

test('the next phrase is queued while the current one is still being prepared, without extra slot writes', async () => {
  const h = harness(4), jobs = [];
  h.stream.synthesize = (text, options) => new Promise(done => { jobs.push({text, options, done}); });
  await h.stream.begin(audio); h.ack(0);
  const finished = h.stream.finish(); await tick();
  // Phrase 2 is being prepared and phrase 3 is already queued behind it, in order.
  assert.deepEqual(jobs.map(job => job.text), ['Phrase 2.', 'Phrase 3.']);
  assert.equal(h.writes.length, 1);
  jobs[0].done(audio); await tick(); await tick();
  assert.equal(h.writes.length, 2);
  assert.deepEqual(jobs.map(job => job.text), ['Phrase 2.', 'Phrase 3.', 'Phrase 4.']);
  h.ack(1); jobs[1].done(audio); jobs[2].done(audio); await finished;
  assert.equal(h.writes.length, 4); assert.equal(h.stream.manifest.complete, true);
  assert.equal(jobs.every(job => job.options.steps === 32), true);
  assert.equal(jobs[0].options.signal.aborted, true, 'the finished stream releases its queue signal');
});

test('read-ahead stays one phrase beyond the slot window while playback is paused', async () => {
  const h = harness(10);
  await h.stream.begin(audio); h.ack(0, {paused: true});
  const finished = h.stream.finish(); await tick(); await tick();
  assert.equal(h.writes.length, 3, 'one playing and two ready chunks');
  assert.equal(h.generated.length, 3, 'two written phrases and one waiting in memory');
  h.ack(1, {requestId: undefined, state: 'target-lost'}); await finished;
});

test('a phrase-2 lookahead queued beside phrase 1 supplies chunk two, and is cancelled if the stream stops early', async () => {
  let cancels = 0;
  const h = harness(3, {lookahead: {promise: Promise.resolve({...audio, timing: {voiceSteps: 32, lookahead: true}}),
    cancel: () => { cancels++; }}});
  await h.stream.begin(audio); h.ack(0);
  await h.stream.finish();
  assert.deepEqual(h.generated.map(row => row.text), ['Phrase 3.']);
  assert.equal(h.manifests.at(-1).chunks[1].timing.lookahead, true);
  let resolveLookahead;
  const stopped = harness(3, {lookahead: {promise: new Promise(done => { resolveLookahead = done; }), cancel: () => { cancels++; }}});
  await stopped.stream.begin(audio); stopped.ack(0);
  const finishing = stopped.stream.finish(); await tick();
  stopped.current = false; resolveLookahead(audio); await finishing;
  assert.equal(stopped.writes.length, 1, 'a stopped stream publishes nothing further');
  assert.ok(cancels >= 2, 'both streams release their phrase-2 lookahead when they end');
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
