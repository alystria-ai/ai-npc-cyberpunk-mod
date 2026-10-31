import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {TurnClock} from './turn-clock.mjs';
import {VOICE_SILENCE, VoiceSilenceWatch} from './voice-silence.mjs';

// A finished turn's clock: `marks` are stage -> ms after the request; `details` are what the bridge annotated.
function turn({marks = {}, details = {voicePlan: 'omni', voiceReason: 'omni'}} = {}) {
  let at = 1000;
  const clock = new TurnClock({origin: 1000, now: () => at});
  clock.mark('received', 1000);
  for (const [name, ms] of Object.entries(marks)) clock.mark(name, 1000 + ms);
  clock.annotate(details);
  return clock;
}
const silentTurn = (extra = {}) => turn({marks: {voiceStart: 1500, ttsSent: 1800, published: 4000}, ...extra});
const playedTurn = () => turn({marks: {voiceStart: 1500, ttsSent: 1800, firstPcm: 2500, published: 4000, playbackObserved: 4600}});

function watchWith(extra = {}) {
  const sent = [];
  const watch = new VoiceSilenceWatch({onSilent: data => sent.push(data), context: () => ({engine: 'omni', requested: 'omni', active: 'omni', fellBackTo: 'omni'}), ...extra});
  return {watch, sent};
}

test('the defaults are the agreed ones, as constants', () => {
  assert.equal(VOICE_SILENCE.silentTurns, 3);
  assert.equal(VOICE_SILENCE.graceMs, 30_000);
  assert.throws(() => { VOICE_SILENCE.silentTurns = 1; });
});

test('three silent replies and none that ever sounded send one report with the counts and the furthest stage; later ones add nothing', () => {
  const {watch, sent} = watchWith();
  watch.observe(silentTurn()); watch.observe(silentTurn());
  assert.equal(sent.length, 0, 'two are a hiccup');
  watch.observe(silentTurn({details: {voicePlan: 'omni', voiceReason: 'local-voice-unavailable'}}));
  assert.equal(sent.length, 1);
  const [data] = sent;
  assert.deepEqual([data.turns, data.silentTurns, data.playedTurns, data.lastStage], [3, 3, 0, 'published']);
  assert.deepEqual(data.reasons, ['omni', 'local-voice-unavailable']);
  assert.deepEqual([data.engine, data.requested, data.active, data.fellBackTo], ['omni', 'omni', 'omni', 'omni']);
  for (let index = 0; index < 5; index++) watch.observe(silentTurn());
  assert.equal(sent.length, 1, 'one report per run');
});

test('the furthest voice stage the last silent reply reached says where the sound stopped', () => {
  for (const [marks, stage] of [[{voiceStart: 10, published: 4000}, 'published'], [{voiceStart: 10, ttsSent: 30, firstPcm: 50, published: 4000, leaseRead: 4100}, 'leaseRead']]) {
    const {watch, sent} = watchWith({thresholds: {silentTurns: 1}});
    watch.observe(turn({marks}));
    assert.equal(sent[0].lastStage, stage);
  }
});

test('one reply that made a sound means the voice works: no report, however many are silent after it', () => {
  const {watch, sent} = watchWith();
  watch.observe(playedTurn());
  for (let index = 0; index < 6; index++) watch.observe(silentTurn());
  assert.equal(sent.length, 0);
});

test('turns that are not silence are left out: failed, paused, not published, a language the voice does not speak, a turn the planner gave no voice, playback off', () => {
  let on = true;
  const {watch, sent} = watchWith({wanted: () => on});
  for (let round = 0; round < 3; round++) {
    watch.observe(silentTurn({details: {voicePlan: 'omni', voiceReason: 'omni', failed: true}}));
    watch.observe(silentTurn({details: {voicePlan: 'omni', voiceReason: 'omni', gamePaused: true}}));
    watch.observe(turn({marks: {voiceStart: 10}}));
    for (const reason of ['english-only-voice', 'pocket-language-pack-missing', 'voice-language-unsupported']) watch.observe(silentTurn({details: {voicePlan: 'none', voiceReason: reason}}));
    watch.observe(silentTurn({details: {}}));
  }
  on = false;
  for (let round = 0; round < 5; round++) watch.observe(silentTurn());
  assert.equal(sent.length, 0);
  assert.equal(watch.silent, 0, 'none of them was counted');
});

test('a voice that failed and left the replies written still counts: the planner kept them written because the voice is unavailable', () => {
  const {watch, sent} = watchWith();
  for (let index = 0; index < 3; index++) watch.observe(silentTurn({details: {voicePlan: 'none', voiceReason: 'local-voice-unavailable'}}));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].reasons, ['none', 'local-voice-unavailable']);
});

test('the clock path: a sound before or after the end of the run counts as played; no sound is judged when the grace is over', () => {
  const timers = [];
  const {watch, sent} = watchWith({thresholds: {silentTurns: 1}, setTimer: (fn, ms) => { const timer = {fn, ms, cleared: false}; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; }});
  // sounds before the run ends
  const early = silentTurn(); const endedEarly = watch.track(early);
  early.mark('playbackObserved', 1000 + 4600); endedEarly();
  assert.equal(timers.length, 0, 'no timer for a turn that already sounded');
  assert.equal(watch.played, 1);
  // sounds after the run ended, before the grace is over
  const late = silentTurn(); const endedLate = watch.track(late);
  endedLate();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 30_000);
  late.mark('playbackObserved', 1000 + 9000);
  assert.equal(timers[0].cleared, true, 'the timer is gone once it sounded');
  assert.equal(watch.played, 2);
  assert.equal(sent.length, 0);
  // never sounds: judged when the grace is over (but not once something has sounded: this run is fine)
  const quiet = silentTurn(); watch.track(quiet)();
  timers.at(-1).fn();
  assert.equal(sent.length, 0, 'earlier turns sounded, so a silent one is not "never played"');
  const fresh = watchWith({thresholds: {silentTurns: 1}, setTimer: (fn, ms) => { const timer = {fn, ms}; timers.push(timer); return timer; }});
  fresh.watch.track(silentTurn())();
  timers.at(-1).fn();
  assert.equal(fresh.sent.length, 1);
});

test('a turn that never gets a playbackObserved mark and whose clock has no listener support is ignored, and a throwing context or wanted never fails a turn', () => {
  const {watch, sent} = watchWith({context: () => { throw new Error('no'); }, thresholds: {silentTurns: 1}});
  assert.doesNotThrow(() => watch.track({})());
  assert.doesNotThrow(() => watch.observe(null));
  watch.observe(silentTurn());
  assert.equal(sent.length, 1, 'the report goes out without the context');
  assert.equal(sent[0].silentTurns, 1);
  const broken = new VoiceSilenceWatch({wanted: () => { throw new Error('no'); }});
  assert.equal(broken.observe(silentTurn()), null);
});

test('the bridge wires it: the clock learns the voice plan, every turn is watched, playback off is not a failure, and nothing runs per frame', async () => {
  const bridge = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /const voiceSilence = new VoiceSilenceWatch\(\{onSilent: data => errorEvents\.voiceSilent\(data\), wanted: \(\) => !localVoice\.closed && !localVoice\.silent && !localVoice\.baseOld,/);
  assert.match(bridge, /silenceEnded = voiceSilence\.track\(clock\);/);
  assert.match(bridge, /turnClocks\.get\(input\?\.requestId\)\?\.annotate\(\{voicePlan: plan\.engine, voiceReason: plan\.reason\}\)/);
  assert.match(bridge, /errorEvents\.voiceFailed\(\{engine: 'v-line'/);
  const module = await readFile(new URL('./voice-silence.mjs', import.meta.url), 'utf8');
  assert.ok(!/setInterval|requestAnimationFrame|readFile|stat\(/.test(module.replace(/^\/\/.*$/gm, '')), 'a few property reads and one timer per turn, no polling and no file access');
});
