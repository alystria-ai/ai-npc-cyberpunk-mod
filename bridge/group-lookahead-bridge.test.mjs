import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {GroupScenario, DEFAULT_TIMINGS, SPEAKERS, measureRound} from './group-lookahead-fixture.mjs';

// The real convai-bridge.mjs runs against a simulated game and a simulated
// Convai speech provider (see group-lookahead-fixture.mjs). Timing assertions
// carry wide margins; the measured numbers are printed by
// scripts/Measure-GroupGap.mjs.
const [JUDY, PANAM, ALEX] = SPEAKERS;
const last = (events, name, id) => events.findLast(row => row.event === name && row.characterId === id)?.t;
const first = (events, name, id) => events.find(row => row.event === name && row.characterId === id)?.t;
const count = (events, name, id) => events.filter(row => row.event === name && row.characterId === id).length;
const noErrors = output => assert.doesNotMatch(output, /poll:|Unhandled|uncaught|TypeError|ReferenceError|request failed/, output);

async function run(options, drive) {
  const scenario = new GroupScenario(options);
  try { await scenario.start(); return await drive(scenario); } finally { await scenario.stop(); }
}
async function finishRound(scenario) {
  await scenario.begin(); await scenario.waitFor(() => scenario.done, 'the round to finish', 90000);
}

describe('group look-ahead in the real bridge', {concurrency: 3, timeout: 240000}, () => {
  it('serial rounds pay a whole provider request per speaker change; look-ahead removes it', async () => {
    const [serial, ahead] = await Promise.all([measureRound({mode: 'serial'}), measureRound({mode: 'lookahead'})]);
    assert.equal(serial.gaps.length, 2); assert.equal(ahead.gaps.length, 2);
    for (const gap of serial.gaps) assert.ok(gap.gapMs > 1500, `serial gap ${gap.gapMs}`);
    // Wide margins: the full suite runs other work beside these bridges.
    for (const [index, gap] of ahead.gaps.entries()) {
      assert.ok(gap.gapMs > 0 && gap.gapMs < 1200, `look-ahead gap ${gap.gapMs}`);
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
    // The only wait left is Panam's own remaining generation time.
    const generation = panamStart - first(events, 'reply-start', PANAM.characterId);
    assert.ok(generation < DEFAULT_TIMINGS['panam-palmer'].firstPcmMs + 1200, `generation ${generation}`);
    noErrors(ahead.output);
  });

  it('a new message cancels the held next speaker: no audio, no reply for it, and the new round proceeds', async () => {
    await run({hooks: {
      stopAfterSpeaker: () => false,
      afterPrediction: async scenario => {
        if (scenario.round !== 1 || scenario.interrupted) return;
        scenario.interrupted = true; await sleep(700);
        scenario.oldPanam = scenario.nextInput;
        await scenario.begin('Actually, new question for everyone.');   // clears the prediction and submits Judy again
      },
    }}, async scenario => {
      await scenario.begin();
      await scenario.waitFor(() => scenario.done, 'the new round to finish', 90000);
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
      afterPrediction: async scenario => {
        await sleep(700); scenario.heldId = scenario.nextInput.requestId; scenario.nextInput = null;
        await scenario.publishPrediction(null);
      },
    }}, async scenario => {
      await scenario.begin();
      await scenario.waitFor(() => scenario.done, 'the first speaker to finish', 90000);
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
        republished = true; await sleep(500);
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
      const gaps = await scenario.gaps(); assert.ok(gaps[0].gapMs < 1400, `the rebuilt turn is still ahead: ${gaps[0].gapMs}`);
      noErrors(scenario.output);
    });
  });
});
