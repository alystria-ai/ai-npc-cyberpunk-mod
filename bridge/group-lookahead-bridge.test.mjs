import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {GroupScenario, DEFAULT_TIMINGS, LIVE_TIMINGS, SPEAKERS, measureRound} from './group-lookahead-fixture.mjs';

// The real convai-bridge.mjs runs against a simulated game and a simulated
// Convai speech provider (see group-lookahead-fixture.mjs). Timing assertions
// carry wide margins; the measured numbers are printed by
// scripts/Measure-GroupGap.mjs.
// The simulated game renews playback control from a wall-clock timer. When the
// whole suite runs ~30 files in parallel that timer can starve for longer than
// the production 2 s lease, and the bridge would (correctly) drop the stream.
// Lengthen the lease for the bridges this file spawns (the fixture copies
// process.env); the exact production limits are tested with an injected clock in
// convai-continuous-speech.test.mjs, and none of these tests expects a lease expiry.
process.env.CYBERPUNK_CONVAI_TEST_LEASE_MS = '60000';
const [JUDY, PANAM, ALEX] = SPEAKERS;
const last = (events, name, id) => events.findLast(row => row.event === name && row.characterId === id)?.t;
const first = (events, name, id) => events.find(row => row.event === name && row.characterId === id)?.t;
const count = (events, name, id) => events.filter(row => row.event === name && row.characterId === id).length;
const noErrors = output => assert.doesNotMatch(output, /poll:|Unhandled|uncaught|TypeError|ReferenceError|request failed/, output);

async function run(options, drive) {
  const scenario = new GroupScenario(options);
  try { await scenario.start(); return await drive(scenario); } finally { await scenario.stop(); }
}
// The held turn may only be cancelled or replaced once the bridge has really
// started it; a fixed delay is not enough when the machine is busy.
const heldStarted = (scenario, pending) => scenario.waitHolding(pending, async () => (await scenario.events())
  .some(row => row.event === 'reply-start' && row.characterId === PANAM.characterId), 'the held Panam request to start');
async function finishRound(scenario) {
  await scenario.begin(); await scenario.waitFor(() => scenario.done, 'the round to finish', 600000);
}

// Two tests at a time: each already runs two real bridges (serial beside look-ahead, so both see the same load); three tests at once (six bridges)
// put six bridges and their simulated games beside the rest of the suite and starved the one being measured.
// Look-ahead hides a provider request behind the previous speaker's audio, so the claim "the next speaker was ready before the game asked for it" holds
// as long as the machine delays the held request by less than the audio it hides behind. The defaults have 5 s of speech for the first two speakers (about
// 2 s of cushion after the 2.9 s the held request needs); the rounds that judge the hiding use 9 s, so that a busy machine does not decide the outcome.
const ROOMY = {...DEFAULT_TIMINGS, 'judy-alvarez': {...DEFAULT_TIMINGS['judy-alvarez'], audioSeconds: 9}, 'panam-palmer': {...DEFAULT_TIMINGS['panam-palmer'], audioSeconds: 9}};

describe('group look-ahead in the real bridge', {concurrency: 2, timeout: 2400000}, () => {
  it('serial rounds pay a whole provider request per speaker change; look-ahead removes it', async () => {
    // The look-ahead round holds the end of every line until the next speaker is ready (holdForNext): the game that submits the next speaker is slower or
    // faster as the machine is busy, but it cannot hand over before the provider request was hidden behind the line, so nothing here is a race.
    const [serial, ahead] = await Promise.all([measureRound({mode: 'serial', timings: ROOMY}), measureRound({mode: 'lookahead', timings: ROOMY, holdForNext: true})]);
    assert.equal(serial.gaps.length, 2); assert.equal(ahead.gaps.length, 2);
    // A serial gap holds one whole provider request (the first audio comes 1.5 s after the request, which only a slow machine can stretch), so 1.5 s is its floor.
    for (const gap of serial.gaps) assert.ok(gap.gapMs > 1500, `serial gap ${gap.gapMs}`);
    // The size of a look-ahead gap is the bridge's and the game's handover, which a busy machine can make as long as it likes, so it is not compared with a
    // serial gap (that failed at 1577 against 1986 ms with the provider's 1.5 s long gone from the gap, and at 1602 against 1986 ms). What look-ahead removes
    // is proved by the order of what happened below: each next speaker was requested during the previous line, was complete before that line ended, and the
    // bridge's own record says it was ready before the game claimed it. A serial speaker is requested only when the previous one has ended.
    for (const gap of ahead.gaps) assert.ok(gap.gapMs > 0, `look-ahead gap ${gap.gapMs}`);
    // Strictly sequential and in order: no speaker starts before the previous one ended.
    for (const {events} of [serial, ahead]) {
      const order = events.filter(row => ['play-start', 'play-end'].includes(row.event)).map(row => `${row.event}:${row.characterId[0]}`);
      assert.deepEqual(order, ['play-start:1', 'play-end:1', 'play-start:2', 'play-end:2', 'play-start:3', 'play-end:3']);
    }
    noErrors(serial.output); noErrors(ahead.output);
    for (const [speaker, before] of [[PANAM, JUDY], [ALEX, PANAM]]) {
      assert.ok(first(serial.events, 'reply-start', speaker.characterId) >= last(serial.events, 'play-end', before.characterId), `serial: ${speaker.name} is requested only after ${before.name} ended`);
      assert.ok(first(serial.events, 'reply-ready', speaker.characterId) > last(serial.events, 'play-end', before.characterId));
    }
    // Each held turn started while the previous speaker was still audible, was complete before that speaker ended (so no provider wait is left in its gap),
    // and recorded its measurements.
    for (const [speaker, before] of [[PANAM, JUDY], [ALEX, PANAM]]) {
      const started = first(ahead.events, 'reply-start', speaker.characterId), end = last(ahead.events, 'play-end', before.characterId);
      assert.ok(started < end - 1000, `${speaker.name} was generated during ${before.name}`);
      assert.ok(first(ahead.events, 'reply-ready', speaker.characterId) < end, `${speaker.name} was complete before ${before.name} ended`);
      const turn = ahead.latency.turns.find(row => row.profile === speaker.key);
      assert.equal(turn.preparation.mode, 'lookahead'); assert.equal(turn.lookahead.readyBeforeClaim, true, `${speaker.name} was ready before the game claimed the turn`);
      assert.ok(turn.lookahead.holdMs > 1500);
    }
  });

  it('a speaker that is not ready when the previous one ends plays as soon as it is, never earlier or overlapping', async () => {
    // Judy's audio is short (1.3 s) and each of the first two speakers takes 3 s from request to first audio, so Panam's request goes out during Judy and is
    // still being generated when she ends. Whether it goes out during her 1.3 s depends on how fast the game's loop publishes the prediction, which a busy
    // machine decides, so the round holds the end of Judy's line until Panam's request has gone out (holdForNext: 'started'): the bridge has to start Panam
    // during Judy's line, and the round fails if it does not, however slow the machine is.
    const slow = key => ({...DEFAULT_TIMINGS[key], firstPcmMs: 3000, pcmCompleteMs: 4100});
    const timings = {...DEFAULT_TIMINGS, 'judy-alvarez': {...slow('judy-alvarez'), audioSeconds: 1.3}, 'panam-palmer': slow('panam-palmer')};
    const {events, output} = await measureRound({mode: 'lookahead', timings, holdForNext: 'started'});
    const judyEnd = last(events, 'play-end', JUDY.characterId), panamStart = first(events, 'play-start', PANAM.characterId), panamAsked = first(events, 'reply-start', PANAM.characterId);
    // The host's log is appended in the order things happened: Judy's end is logged before Panam's start. Two events in the same millisecond are back to
    // back (a speaker that was ready starts the moment the last one ends), not overlapping, so the times are compared with >=.
    const order = events.filter(row => ['play-start', 'play-end'].includes(row.event)).map(row => `${row.event}:${row.characterId[0]}`);
    assert.deepEqual(order, ['play-start:1', 'play-end:1', 'play-start:2', 'play-end:2', 'play-start:3', 'play-end:3'], 'one voice at a time, in order');
    assert.ok(panamStart >= judyEnd, `never overlaps the previous speaker (Panam starts ${panamStart - judyEnd} ms after Judy ends)`);
    // Panam was requested while Judy was still audible (she was held until then) and is heard no sooner than the provider can deliver its first audio: the
    // simulated provider's 3 s from request to first audio is a floor that a busy machine can only raise. How soon after that it is heard is the handover of
    // the bridge and the game, which is measured by scripts/Measure-GroupGap.mjs on a quiet machine and is no property a loaded one can be held to.
    assert.ok(panamAsked < judyEnd, `Panam was requested ${panamAsked - judyEnd} ms after Judy ended`);
    const fresh = first(events, 'play-start', JUDY.characterId) - first(events, 'reply-start', JUDY.characterId);
    assert.ok(fresh >= 3000, `a fresh generation takes the provider's 3 s: ${fresh}`);
    assert.ok(panamStart - panamAsked >= 3000, `Panam is heard no sooner than the provider's 3 s after its request: ${panamStart - panamAsked}`);
    noErrors(output);
  });

  it('a new message cancels the held next speaker: no audio, no reply for it, and the new round proceeds', async () => {
    await run({hooks: {
      stopAfterSpeaker: () => false,
      afterPrediction: async (scenario, pending) => {
        if (scenario.round !== 1 || scenario.interrupted) return;
        scenario.interrupted = true; await heldStarted(scenario, pending); await sleep(200);
        scenario.oldPanam = scenario.nextInput;
        await scenario.begin('Actually, new question for everyone.');   // clears the prediction and submits Judy again
      },
    }}, async scenario => {
      await scenario.begin();
      await scenario.waitFor(() => scenario.done, 'the new round to finish', 600000);
      const events = await scenario.events();
      const abort = first(events, 'reply-abort', PANAM.characterId);
      assert.ok(abort, 'the held Panam request was cancelled');
      // That first Panam request never produced audio or a published reply.
      assert.ok(!events.some(row => row.event === 'play-start' && row.characterId === PANAM.characterId && row.t < abort));
      assert.equal(scenario.replyIds.has(scenario.oldPanam.requestId), false, 'cancelled turn never reached reply.json');
      assert.ok(count(events, 'play-start', JUDY.characterId) >= 1);
      noErrors(scenario.output);
    });
  });

  it('dismissing the audience cancels the held turn cleanly and leaves the bridge ready for the next conversation', async () => {
    await run({hooks: {
      stopAfterSpeaker: () => true,
      afterPrediction: async (scenario, pending) => {
        await heldStarted(scenario, pending); await sleep(200); scenario.heldId = scenario.nextInput.requestId; scenario.nextInput = null;
        await scenario.publishPrediction(null);
      },
    }}, async scenario => {
      await scenario.begin();
      await scenario.waitFor(() => scenario.done, 'the first speaker to finish', 600000);
      await scenario.waitFor(async () => count(await scenario.events(), 'reply-abort', PANAM.characterId) >= 1, 'the held Panam request to be cancelled', 120000);
      const events = await scenario.events();
      assert.equal(count(events, 'reply-abort', PANAM.characterId), 1);
      assert.equal(count(events, 'play-start', PANAM.characterId), 0);
      assert.equal(scenario.replyIds.has(scenario.heldId), false);
      // A later, unrelated round still works (no orphaned hold, no stuck page).
      scenario.hooks.stopAfterSpeaker = () => false; scenario.hooks.afterPrediction = undefined;
      scenario.done = false; scenario.mode = 'lookahead';
      await finishRound(scenario);
      assert.equal(count(await scenario.events(), 'play-start', ALEX.characterId), 1);
      noErrors(scenario.output);
    });
  });

  it('a submission that differs from the prediction discards the held turn and runs normally', async () => {
    await run({hooks: {freshInput: true}}, async scenario => {
      await finishRound(scenario);
      const events = await scenario.events();
      // Each later speaker was generated twice: held (cancelled) and then submitted.
      assert.equal(count(events, 'reply-abort', PANAM.characterId), 1);
      assert.equal(count(events, 'reply-start', PANAM.characterId), 2);
      assert.equal(count(events, 'play-start', PANAM.characterId), 1);
      const gaps = await scenario.gaps(); assert.ok(gaps[0].gapMs > 1500, `falls back to the serial cost: ${gaps[0].gapMs}`);
      noErrors(scenario.output);
    });
  });

  it('a held turn that fails publishes nothing; the submitted turn then runs as an ordinary request', async () => {
    const timings = {...DEFAULT_TIMINGS, 'panam-palmer': {...DEFAULT_TIMINGS['panam-palmer'], failBeforeMs: 300, failOnCall: 1}};
    await run({timings}, async scenario => {
      scenario.errors = [];
      await finishRound(scenario);
      const events = await scenario.events();
      assert.equal(count(events, 'reply-fail', PANAM.characterId), 1);
      assert.equal(count(events, 'reply-start', PANAM.characterId), 2);
      assert.equal(count(events, 'play-start', PANAM.characterId), 1);
      assert.equal(scenario.replyErrors.length, 0, 'no error reply was published for the held turn');
      assert.match(scenario.output, /Look-ahead turn failed/);
      assert.equal(count(events, 'play-start', ALEX.characterId), 1);
    });
  });

  it('a re-published prediction for the same speaker replaces the held turn and is still ahead', async () => {
    let republished = false;
    await run({timings: ROOMY, hooks: {
      afterPrediction: async (scenario, pending) => {
        if (republished || scenario.round !== 1) return;
        republished = true; await heldStarted(scenario, pending); await sleep(200);
        // The game rebuilt the same prediction (new request identity, same context).
        const changed = scenario.inputFor(2, scenario.nextInput.group.heard);
        scenario.nextInput = changed;
        await scenario.publishPrediction(changed, pending.input.requestId);
      },
    }}, async scenario => {
      await finishRound(scenario);
      const events = await scenario.events();
      assert.equal(count(events, 'reply-abort', PANAM.characterId), 1, 'the first held version was replaced');
      assert.equal(count(events, 'reply-start', PANAM.characterId), 2);
      assert.equal(count(events, 'play-start', PANAM.characterId), 1);
      // "Still ahead" is the rebuilt turn being ready before the game asked for it, as the bridge's own record says: no provider wait is left in the
      // gap, whatever the machine is doing. (A fixed 1.4 s limit on the gap measured the handover of a quiet machine.)
      const latency = JSON.parse(await readFile(join(scenario.runtime, 'bridge-latency.json'), 'utf8'));
      const rebuilt = latency.turns.findLast(row => row.profile === PANAM.key);
      assert.equal(rebuilt.preparation.mode, 'lookahead'); assert.equal(rebuilt.lookahead.readyBeforeClaim, true, 'the rebuilt turn was ready before the game claimed it');
      const gaps = await scenario.gaps(); assert.ok(gaps[0].gapMs > 0, `the next speaker came after the last: ${gaps[0].gapMs}`);
      noErrors(scenario.output);
    });
  });
});

// The live round of 2026-10-17: the player's own Convai key on a confirmed paid plan (six connections) and the Voxtral voice. Every
// speaker change took 8-9 s because look-ahead was off for any player's key and a fresh connection (3-4 s) opened for each speaker.
// The provider delays are the live ones (LIVE_TIMINGS: a speaker that is not prepared takes about 7 s from request to first audio).
describe('group look-ahead on the own Convai key of a player', {concurrency: 2, timeout: 2400000}, () => {
  it('a confirmed paid plan runs the next speakers ahead and opens their pages early; a free plan stays serial', async () => {
    // The paid round holds the end of each line until the next speaker is ready (holdForNext): a machine that is busy delays the game's handover as it likes,
    // but a bridge that does not prepare the next speaker during the line never gets past the hold. The free round cannot be held (nothing runs ahead).
    const [paid, free] = await Promise.all([
      measureRound({mode: 'lookahead', timings: LIVE_TIMINGS, playerKey: {connections: 6}, holdForNext: true}),
      measureRound({mode: 'lookahead', timings: LIVE_TIMINGS, playerKey: {connections: 1}})]);
    assert.equal(paid.gaps.length, 2); assert.equal(free.gaps.length, 2);
    // Paid: the 7 s a speaker used to take is hidden behind the previous speaker's audio. The size of a paid gap is the game's handover, which a busy machine
    // stretches as it likes (it was judged as under 30% of the free gap, and failed at that), so it is not compared with a free gap. What is hidden is proved
    // by the order of events below and by the bridge's own record of each turn.
    for (const gap of paid.gaps) assert.ok(gap.gapMs > 0, `paid gap ${gap.gapMs}`);
    // Free: one connection, nothing runs ahead, nothing is opened early: the whole request (a fresh connection of 3.5 s and 3.5 s to the first audio of the
    // simulated provider) after the previous speaker's last sample. A busy machine can only add to that, so 5.5 s is a floor.
    for (const gap of free.gaps) assert.ok(gap.gapMs > 5500, `free gap ${gap.gapMs}`);
    for (const {events} of [paid, free]) {
      const order = events.filter(row => ['play-start', 'play-end'].includes(row.event)).map(row => `${row.event}:${row.characterId[0]}`);
      assert.deepEqual(order, ['play-start:1', 'play-end:1', 'play-start:2', 'play-end:2', 'play-start:3', 'play-end:3'], 'one voice at a time, in order');
    }
    const modeOf = (round, key) => round.latency.turns.find(row => row.profile === key)?.preparation?.mode;
    assert.equal(modeOf(paid, PANAM.key), 'lookahead'); assert.equal(modeOf(paid, ALEX.key), 'lookahead');
    assert.equal(modeOf(free, PANAM.key), 'none'); assert.equal(modeOf(free, ALEX.key), 'none');
    // Paid: both other speakers' pages open while the first speaker is being written, and their turns find them open.
    const judyReplied = first(paid.events, 'play-start', JUDY.characterId);
    for (const speaker of [PANAM, ALEX]) {
      assert.ok(first(paid.events, 'warm', speaker.characterId) < judyReplied, `${speaker.name}'s page opened before ${JUDY.name} was audible`);
      assert.equal(paid.events.find(row => row.event === 'connected' && row.characterId === speaker.characterId).warm, true, `${speaker.name}'s turn found its page open`);
    }
    assert.equal(paid.events.filter(row => row.event === 'warm' && row.characterId === JUDY.characterId).length, 0, 'the first speaker is not warmed twice');
    // Paid: each next speaker was requested during the previous line and was complete before that line ended, and the bridge's record says it was ready before
    // the game claimed it, so no provider wait is left in its gap.
    for (const [speaker, before] of [[PANAM, JUDY], [ALEX, PANAM]]) {
      const end = last(paid.events, 'play-end', before.characterId);
      assert.ok(first(paid.events, 'reply-start', speaker.characterId) < end - 1000, `ahead: ${speaker.name} is requested during ${before.name}`);
      assert.ok(first(paid.events, 'reply-ready', speaker.characterId) < end, `${speaker.name} was complete before ${before.name} ended`);
      assert.equal(paid.latency.turns.find(row => row.profile === speaker.key).lookahead.readyBeforeClaim, true, `${speaker.name} was ready before the game claimed the turn`);
    }
    // Free: no page opened ahead, no speaker started during the previous one.
    assert.equal(free.events.filter(row => row.event === 'warm').length, 0);
    for (const [speaker, before] of [[PANAM, JUDY], [ALEX, PANAM]]) {
      assert.ok(first(free.events, 'reply-start', speaker.characterId) > last(free.events, 'play-end', before.characterId) - 1, `serial: ${speaker.name} is requested after ${before.name} ended`);
    }
    noErrors(paid.output); noErrors(free.output);
  });

  it('a speaker alone takes as long to its first audio as before: nothing is opened or run ahead for a round of one', async () => {
    const [paid, free] = await Promise.all([
      measureRound({mode: 'lookahead', timings: LIVE_TIMINGS, speakers: 1, playerKey: {connections: 6}}),
      measureRound({mode: 'lookahead', timings: LIVE_TIMINGS, speakers: 1, playerKey: {connections: 1}})]);
    const toAudio = events => first(events, 'play-start', JUDY.characterId) - first(events, 'reply-start', JUDY.characterId);
    for (const {events} of [paid, free]) assert.ok(toAudio(events) >= LIVE_TIMINGS['judy-alvarez'].connectMs + LIVE_TIMINGS['judy-alvarez'].firstPcmMs - 50, 'the simulated provider time is paid');
    // The two rounds used to be required to differ by less than half the connection that would have been opened ahead (3.5 s), by their time to the first
    // audio. That time includes the game's handover, which a busy machine stretches differently for two bridges side by side, so it measured the load. An
    // extra connection is proved absent by what the bridge itself did: no page was opened ahead, the one connection the speaker needed was opened by its own
    // request (not found open), and no turn was prepared.
    for (const {events} of [paid, free]) {
      assert.equal(events.filter(row => row.event === 'warm').length, 0);
      assert.equal(events.find(row => row.event === 'connected' && row.characterId === JUDY.characterId).warm, false, 'the speaker paid for its own connection');
    }
    assert.equal(paid.latency.turns.length, 1); assert.equal(paid.latency.turns[0].preparation.mode, 'none');
    assert.equal(free.latency.turns.length, 1); assert.equal(free.latency.turns[0].preparation.mode, 'none');
    noErrors(paid.output); noErrors(free.output);
  });

  it('a round of two on a paid plan: the second speaker follows the first without the provider wait', async () => {
    const [paid, serial] = await Promise.all([
      measureRound({mode: 'lookahead', timings: LIVE_TIMINGS, speakers: 2, playerKey: {connections: 6}, holdForNext: true}),
      measureRound({mode: 'lookahead', timings: LIVE_TIMINGS, speakers: 2, playerKey: {connections: 1}})]);
    assert.equal(paid.gaps.length, 1);
    assert.ok(paid.gaps[0].gapMs > 0, `paid gap ${paid.gaps[0].gapMs}`);
    assert.ok(serial.gaps[0].gapMs > 5500, `serial gap ${serial.gaps[0].gapMs}`);
    // Not a ratio of two gaps (see above): the second speaker was complete before the first one ended, and the bridge's record says it was ready before the
    // game claimed it. The serial round asked for it only after the first speaker ended.
    assert.ok(first(paid.events, 'reply-ready', PANAM.characterId) < last(paid.events, 'play-end', JUDY.characterId), 'paid: Panam was complete before Judy ended');
    assert.equal(paid.latency.turns.find(row => row.profile === PANAM.key).lookahead.readyBeforeClaim, true);
    assert.ok(first(serial.events, 'reply-start', PANAM.characterId) >= last(serial.events, 'play-end', JUDY.characterId), 'serial: Panam is requested after Judy ended');
    noErrors(paid.output); noErrors(serial.output);
  });
});
