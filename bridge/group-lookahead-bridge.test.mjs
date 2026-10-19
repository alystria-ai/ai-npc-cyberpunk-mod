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
describe('group look-ahead in the real bridge', {concurrency: 2, timeout: 2400000}, () => {
  it('serial rounds pay a whole provider request per speaker change; look-ahead removes it', async () => {
    const [serial, ahead] = await Promise.all([measureRound({mode: 'serial'}), measureRound({mode: 'lookahead'})]);
    assert.equal(serial.gaps.length, 2); assert.equal(ahead.gaps.length, 2);
    for (const gap of serial.gaps) assert.ok(gap.gapMs > 1500, `serial gap ${gap.gapMs}`);
    // The size of a gap is only judged against its serial twin, which runs beside it under the same load. A fixed figure for the look-ahead gap
    // (the old 1.2 s) measured the bridge's own handover on a quiet machine: it failed at 1577 ms on a busy one, with the provider's 1.5 s long
    // gone from the gap. Every serial gap holds one whole provider request, so 70% of it is a bound that rises with the load.
    for (const [index, gap] of ahead.gaps.entries()) {
      assert.ok(gap.gapMs > 0, `look-ahead gap ${gap.gapMs}`);
      assert.ok(gap.gapMs < serial.gaps[index].gapMs * .7, `look-ahead ${gap.gapMs} vs serial ${serial.gaps[index].gapMs}`);
    }
    // Strictly sequential and in order: no speaker starts before the previous one ended.
    for (const {events} of [serial, ahead]) {
      const order = events.filter(row => ['play-start', 'play-end'].includes(row.event)).map(row => `${row.event}:${row.characterId[0]}`);
      assert.deepEqual(order, ['play-start:1', 'play-end:1', 'play-start:2', 'play-end:2', 'play-start:3', 'play-end:3']);
    }
    noErrors(serial.output); noErrors(ahead.output);
    // The held turn started while the previous speaker was still audible and recorded its measurements.
    const started = first(ahead.events, 'reply-start', PANAM.characterId);
    assert.ok(started < last(ahead.events, 'play-end', JUDY.characterId) - 1000, 'Panam was generated during Judy');
    const turn = ahead.latency.turns.find(row => row.profile === PANAM.key);
    assert.equal(turn.preparation.mode, 'lookahead'); assert.equal(turn.lookahead.readyBeforeClaim, true);
    assert.ok(turn.lookahead.holdMs > 1500);
  });

  it('a speaker that is not ready when the previous one ends plays as soon as it is, never earlier or overlapping', async () => {
    const timings = {...DEFAULT_TIMINGS, 'judy-alvarez': {...DEFAULT_TIMINGS['judy-alvarez'], audioSeconds: 1.3}};
    const [serial, ahead] = await Promise.all([measureRound({mode: 'serial', timings}), measureRound({mode: 'lookahead', timings})]);
    const {events, gaps} = ahead;
    const judyEnd = last(events, 'play-end', JUDY.characterId), panamStart = first(events, 'play-start', PANAM.characterId);
    assert.ok(panamStart > judyEnd, 'never overlaps the previous speaker');
    assert.ok(gaps[0].gapMs < serial.gaps[0].gapMs - 400, `partial overlap still helps: ${gaps[0].gapMs} vs ${serial.gaps[0].gapMs}`);
    // The only wait left is Panam's own remaining generation time. That time is the simulated provider's plus what the bridge itself
    // adds on this machine right now, so the bound is the same pipeline measured beside it (the serial run's first speaker,
    // generated under the same load, with the same simulated provider time) plus the margin.
    const generation = panamStart - first(events, 'reply-start', PANAM.characterId);
    const reference = first(serial.events, 'play-start', JUDY.characterId) - first(serial.events, 'reply-start', JUDY.characterId);
    assert.ok(reference >= DEFAULT_TIMINGS['judy-alvarez'].firstPcmMs, `reference generation ${reference}`);
    assert.ok(generation < reference + 1200, `generation ${generation} vs ${reference} for the first speaker of the serial run`);
    noErrors(ahead.output);
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
      await sleep(500);
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
    await run({hooks: {
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
    const [paid, free] = await Promise.all([
      measureRound({mode: 'lookahead', timings: LIVE_TIMINGS, playerKey: {connections: 6}}),
      measureRound({mode: 'lookahead', timings: LIVE_TIMINGS, playerKey: {connections: 1}})]);
    assert.equal(paid.gaps.length, 2); assert.equal(free.gaps.length, 2);
    // Paid: the 7 s a speaker used to take is hidden behind the previous speaker's audio. A gap is judged against its twin from the free round beside it
    // (same load), not against a fixed figure from a quiet machine: under 30% of the free gap, which is at least 5.5 s.
    for (const [index, gap] of paid.gaps.entries()) assert.ok(gap.gapMs > 0 && gap.gapMs < free.gaps[index].gapMs * .3, `paid gap ${gap.gapMs} vs free ${free.gaps[index].gapMs}`);
    // Free: one connection, nothing runs ahead, nothing is opened early: the whole request after the previous speaker's last sample.
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
    // Free: no page opened ahead, no speaker started during the previous one.
    assert.equal(free.events.filter(row => row.event === 'warm').length, 0);
    assert.ok(first(free.events, 'reply-start', PANAM.characterId) > last(free.events, 'play-end', JUDY.characterId) - 1, 'serial: Panam is requested after Judy ended');
    assert.ok(first(paid.events, 'reply-start', PANAM.characterId) < last(paid.events, 'play-end', JUDY.characterId) - 1000, 'ahead: Panam is requested during Judy');
    noErrors(paid.output); noErrors(free.output);
  });

  it('a speaker alone takes as long to its first audio as before: nothing is opened or run ahead for a round of one', async () => {
    const [paid, free] = await Promise.all([
      measureRound({mode: 'lookahead', timings: LIVE_TIMINGS, speakers: 1, playerKey: {connections: 6}}),
      measureRound({mode: 'lookahead', timings: LIVE_TIMINGS, speakers: 1, playerKey: {connections: 1}})]);
    const toAudio = events => first(events, 'play-start', JUDY.characterId) - first(events, 'reply-start', JUDY.characterId);
    assert.ok(toAudio(paid.events) >= LIVE_TIMINGS['judy-alvarez'].connectMs + LIVE_TIMINGS['judy-alvarez'].firstPcmMs - 50, 'the simulated provider time is paid');
    // The two rounds must differ by less than the connection that would have been opened ahead (3.5 s): half of it, so that load noise between the two
    // bridges cannot look like a connection and a real extra connection cannot look like noise.
    const connectMs = LIVE_TIMINGS['judy-alvarez'].connectMs;
    assert.ok(Math.abs(toAudio(paid.events) - toAudio(free.events)) < connectMs / 2, `paid ${toAudio(paid.events)} vs free ${toAudio(free.events)}`);
    for (const {events} of [paid, free]) assert.equal(events.filter(row => row.event === 'warm').length, 0);
    assert.equal(paid.latency.turns.length, 1); assert.equal(paid.latency.turns[0].preparation.mode, 'none');
    noErrors(paid.output); noErrors(free.output);
  });

  it('a round of two on a paid plan: the second speaker follows the first without the provider wait', async () => {
    const [paid, serial] = await Promise.all([
      measureRound({mode: 'lookahead', timings: LIVE_TIMINGS, speakers: 2, playerKey: {connections: 6}}),
      measureRound({mode: 'lookahead', timings: LIVE_TIMINGS, speakers: 2, playerKey: {connections: 1}})]);
    assert.equal(paid.gaps.length, 1);
    assert.ok(paid.gaps[0].gapMs > 0, `paid gap ${paid.gaps[0].gapMs}`);
    assert.ok(serial.gaps[0].gapMs > 5500, `serial gap ${serial.gaps[0].gapMs}`);
    assert.ok(paid.gaps[0].gapMs < serial.gaps[0].gapMs * .3, `${paid.gaps[0].gapMs} vs ${serial.gaps[0].gapMs}`);
    noErrors(paid.output); noErrors(serial.output);
  });
});
