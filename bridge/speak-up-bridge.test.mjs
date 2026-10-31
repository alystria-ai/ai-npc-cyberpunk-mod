// Johnny's follow-on and a companion's after-scene line, prepared ahead, in the real convai-bridge.mjs against a simulated game and provider
// (bridge/speak-up-fixture.mjs, docs/COMPANION_SPEAK_UP.md "Bridge side"). Timing assertions carry wide margins; the measured numbers are printed by
// scripts/Measure-GroupGap.mjs --follow. The providers here are SIMULATED: these tests prove the order of events and what is dropped, not live latency.
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {SpeakUpScenario, JUDY, JOHNNY, SPEAK_TIMINGS, LIVE_SPEAK_TIMINGS, startChatServer, gapBetween} from './speak-up-fixture.mjs';

// The simulated game renews playback control from a wall-clock timer; the bridges these tests spawn run beside the rest of the suite (see
// group-lookahead-bridge.test.mjs), so the lease is lengthened. None of these tests expects a lease expiry of the playback control.
process.env.CYBERPUNK_CONVAI_TEST_LEASE_MS = '60000';
const first = (events, name, id, after = -Infinity) => events.find(row => row.event === name && row.characterId === id && row.t > after)?.t;
const last = (events, name, id) => events.findLast(row => row.event === name && row.characterId === id)?.t;
const count = (events, name, id) => events.filter(row => row.event === name && row.characterId === id).length;
const noErrors = output => assert.doesNotMatch(output, /poll:|Unhandled|uncaught|TypeError|ReferenceError|request failed/, output);
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };

async function run(options, drive) {
  const scenario = new SpeakUpScenario(options);
  try { await scenario.start(); return await drive(scenario); } finally { await scenario.stop(); }
}
// One follow-on round: the source line, the follow-on (prepared or not), until the game is done. Returns what the tests judge.
async function followRound({source = {kind: 'speakup', follow: 'companion'}, before, ...options} = {}) {
  return run(options, async scenario => {
    await before?.(scenario);
    await scenario.source(source);
    await scenario.waitFor(() => scenario.done, 'the follow-on to finish', 600000);
    const events = await scenario.events();
    return {events, trail: scenario.trail, latency: await readJson(join(scenario.runtime, 'bridge-latency.json')), output: scenario.output, held: scenario.held,
      followId: scenario.followFor?.table.requestId, replyIds: [...scenario.replyIds], gap: gapBetween(events, JUDY, JOHNNY)};
  });
}
const orderOf = events => events.filter(row => ['play-start', 'play-end'].includes(row.event)).map(row => `${row.event}:${row.characterId[0]}`);
// What the held follow-on had done by the time it was ready, before the game submitted it (set by a hook of the game's loop). The round holds the end of
// Judy's line (hold: [JUDY]): her line has played in full but is not drained, so it is still playing for as long as this check takes, however slow the machine
// is, and the check waits for what it judges (Johnny's reply is complete and buffered, Judy is audible, the game's loop has read the bridge's answer many
// times) instead of a pause. Judy is released afterwards, so that the round goes on.
const checkHeld = async scenario => {
  const happened = (name, who) => async () => (await scenario.events()).some(row => row.event === name && row.characterId === who.characterId);
  await scenario.waitFor(happened('reply-start', JOHNNY), 'the held follow-on to start', 120000);
  await scenario.waitFor(happened('reply-ready', JOHNNY), 'the held follow-on to be written and voiced', 300000);
  await scenario.waitFor(happened('play-start', JUDY), 'Judy to be audible', 300000);
  const ticks = scenario.ticks;
  await scenario.waitFor(() => scenario.ticks >= ticks + 20, 'the game to look at the bridge\'s answer again', 120000);
  const events = await scenario.events();
  scenario.held = {published: scenario.replyIds.has(scenario.followFor.table.requestId), played: events.some(row => row.event === 'play-start' && row.characterId === JOHNNY.characterId),
    judyStillPlaying: count(events, 'play-start', JUDY.characterId) === 1 && count(events, 'play-end', JUDY.characterId) === 0};
  await scenario.releaseLine(JUDY);
};

describe('Johnny\'s follow-on, prepared while the line plays (Convai, the shared key)', {concurrency: 2, timeout: 2400000}, () => {
  it('after a companion\'s speak-up: written and voiced while she speaks, held, heard right after her; the serial game pays a whole request', async () => {
    const [prepared, serial] = await Promise.all([
      followRound({prepare: true, hold: [JUDY], hooks: {afterPrediction: scenario => checkHeld(scenario)}}),
      followRound({prepare: false})]);
    for (const {events, output} of [prepared, serial]) {
      assert.deepEqual(orderOf(events), ['play-start:1', 'play-end:1', 'play-start:4', 'play-end:4'], 'one voice at a time, in order');
      noErrors(output);
    }
    // The follow-on is generated during her line, from her complete text, as Johnny's remark about it (quoted data, no question).
    const started = first(prepared.events, 'reply-start', JOHNNY.characterId);
    assert.ok(started < last(prepared.events, 'play-end', JUDY.characterId) - 1500, `Johnny was written during Judy's line (${last(prepared.events, 'play-end', JUDY.characterId) - started} ms before it ended)`);
    const request = prepared.events.find(row => row.event === 'reply-start' && row.characterId === JOHNNY.characterId);
    assert.equal(request.reaction, 'head'); assert.equal(request.reactionEvent, 'follow');
    assert.match(request.text, /Judy" has just said this to V on her own, out loud, without being asked: "Quiet night, V\. I could get used to this\."/);
    assert.match(request.text, /only V hears you/); assert.doesNotMatch(request.text, /\?/);
    // Held: ready (text and audio buffered) while she was still speaking, and nothing of it reached the game before the game submitted it.
    assert.deepEqual(prepared.held, {published: false, played: false, judyStillPlaying: true});
    const turn = prepared.latency.turns.find(row => row.profile === 'johnny-silverhand');
    assert.equal(turn.preparation.mode, 'lookahead'); assert.equal(turn.lookahead.readyBeforeClaim, true, 'ready before the game asked for it'); assert.ok(turn.lookahead.holdMs > 1500);
    // The silence between her last audio and his first: the serial game pays a whole provider request.
    assert.ok(prepared.gap > 0, `prepared gap ${prepared.gap}`);
    assert.ok(serial.gap > 1500, `serial gap ${serial.gap}`);
    assert.ok(prepared.gap < serial.gap - 900, `prepared ${prepared.gap} vs serial ${serial.gap}`);
    assert.equal(serial.latency.turns.find(row => row.profile === 'johnny-silverhand').preparation.mode, 'none');
    // The order the game follows: the prediction is published when her text is complete, the submission comes after she has been heard.
    const at = event => prepared.trail.find(row => row.event === event)?.t;
    const submitted = prepared.trail.findLast(row => row.event === 'submit')?.t;
    assert.ok(at('prepared-command') < at('ended') && at('ended') < submitted, 'prediction, her end, then the submission');
  });

  it('after a reply in a conversation V is having ("talk"): the same, and the line it is about is the character\'s answer to V', async () => {
    // V opened the text box, typed and sent a line a moment ago: the game leaves that hint in the file, and it is old news, not V talking now.
    const prepared = await followRound({source: {kind: 'talk', follow: 'talk'}, prepare: true, hold: [JUDY], hooks: {afterPrediction: scenario => checkHeld(scenario)},
      before: async scenario => { await scenario.openComposer(JUDY); await sleep(1200); }});
    assert.deepEqual(orderOf(prepared.events), ['play-start:1', 'play-end:1', 'play-start:4', 'play-end:4']);
    const request = prepared.events.find(row => row.event === 'reply-start' && row.characterId === JOHNNY.characterId);
    assert.match(request.text, /V has been talking with "Judy", who has just said this to V, out loud: "Quiet night, V\./);
    assert.deepEqual(prepared.held, {published: false, played: false, judyStillPlaying: true});
    assert.ok(first(prepared.events, 'reply-start', JOHNNY.characterId) < last(prepared.events, 'play-end', JUDY.characterId) - 1500);
    noErrors(prepared.output);
  });

  it('Johnny\'s lines are no part of the companion\'s context: her later turns, her prompt and the follow-on\'s own request carry none of each other', async () => {
    await run({prepare: true, hold: [JUDY], hooks: {afterPrediction: scenario => checkHeld(scenario)}}, async scenario => {
      await scenario.source({follow: 'companion'});
      await scenario.waitFor(() => scenario.done, 'the follow-on to finish', 600000);
      // Then V talks to Judy again, a speak-up for her follows: whatever she is sent is built from her own turn.
      scenario.done = false;
      await scenario.submit(scenario.talkInput(JUDY, 'And what did you think of that?'), {kind: 'talk'});
      await scenario.waitFor(() => scenario.done, 'the next talk to finish', 600000);
      const events = await scenario.events();
      const judyAsks = events.filter(row => row.event === 'reply-start' && row.characterId === JUDY.characterId);
      assert.equal(judyAsks.length, 2);
      const spoken = SPEAK_TIMINGS['johnny-silverhand'].text;
      for (const row of judyAsks) {
        assert.ok(!String(row.context).includes(spoken), 'Johnny\'s line is not in her context');
        assert.ok(!String(row.context).includes('Johnny Silverhand'), 'nor is he');
        assert.ok(!String(row.text).includes(spoken));
      }
      // And his own request carries hers only as the quoted data of the trigger (never as her context): what she said once, in the trigger.
      const johnnyAsk = events.find(row => row.event === 'reply-start' && row.characterId === JOHNNY.characterId);
      assert.ok(String(johnnyAsk.text).includes('Quiet night, V. I could get used to this.'));
      assert.ok(!String(johnnyAsk.context).includes('Quiet night, V. I could get used to this.'), 'her line is data in his trigger, not a block of his context');
      noErrors(scenario.output);
    });
  });

  it('a request of V\'s while the follow-on is held drops it: no audio, no reply for it, V\'s own turn is answered as soon as its provider can', async () => {
    await run({prepare: true, hooks: {
      noFollowSubmit: true,
      afterPrediction: async scenario => {
        await scenario.waitFor(async () => (await scenario.events()).some(row => row.event === 'reply-start' && row.characterId === JOHNNY.characterId), 'the held follow-on to start', 60000);
        await sleep(300);
        scenario.vSubmittedAt = Date.now();
        await scenario.submit(scenario.talkInput(JUDY, 'Hey Judy, one more thing.'), {kind: 'talk'});
      }}}, async scenario => {
      await scenario.source({follow: 'companion'});
      await scenario.waitFor(() => scenario.vSubmittedAt && scenario.done, 'V\'s turn to finish', 600000);
      const events = await scenario.events();
      const abort = first(events, 'reply-abort', JOHNNY.characterId);
      assert.ok(abort, 'the held follow-on was cancelled');
      assert.ok(abort >= scenario.vSubmittedAt - 100 && abort < scenario.vSubmittedAt + 1500, `cancelled by V's request (${abort - scenario.vSubmittedAt} ms after it)`);
      assert.equal(count(events, 'play-start', JOHNNY.characterId), 0); assert.equal(scenario.replyIds.has(scenario.followFor.table.requestId), false);
      // V's turn reached the provider at once and was voiced: the held turn stood in nobody's way.
      const asks = events.filter(row => row.event === 'reply-start' && row.characterId === JUDY.characterId);
      assert.equal(asks.length, 2);
      assert.ok(asks[1].t - scenario.vSubmittedAt < 1500, `V's turn was sent to the provider ${asks[1].t - scenario.vSubmittedAt} ms after it was written`);
      assert.equal(count(events, 'play-start', JUDY.characterId), 2);
      noErrors(scenario.output);
    });
  });

  it('the text box opening while the follow-on is held drops it at once, before V has sent anything', async () => {
    await run({prepare: true, hooks: {
      noFollowSubmit: true,
      afterPrediction: async scenario => {
        await scenario.waitFor(async () => (await scenario.events()).some(row => row.event === 'reply-start' && row.characterId === JOHNNY.characterId), 'the held follow-on to start', 60000);
        await sleep(300);
        scenario.openedAt = Date.now();
        await scenario.openComposer(JUDY);
      }}}, async scenario => {
      await scenario.source({follow: 'companion'});
      await scenario.waitFor(() => scenario.openedAt, 'the text box to open', 60000);
      await scenario.waitFor(async () => (await scenario.events()).some(row => row.event === 'reply-abort' && row.characterId === JOHNNY.characterId), 'the held follow-on to be dropped', 20000);
      const events = await scenario.events();
      assert.ok(first(events, 'reply-abort', JOHNNY.characterId) - scenario.openedAt < 2000, 'dropped within a poll or two of the box opening');
      assert.equal(count(events, 'play-start', JOHNNY.characterId), 0);
      // And a prediction written while the box is open is never started.
      await scenario.command({kind: 'follow', sourceRequestId: scenario.followFor.source.requestId, input: scenario.followInput(scenario.followFor.source, scenario.pending?.text ?? SPEAK_TIMINGS['judy-alvarez'].text, 'companion')});
      await sleep(1500);
      assert.equal(count(await scenario.events(), 'reply-start', JOHNNY.characterId), 1, 'no second start while V is typing');
      noErrors(scenario.output);
    });
  });

  it('the source cancelled (its lease withdrawn) drops the held follow-on after a short grace; the prediction withdrawn drops it at once', async () => {
    await run({prepare: true, hooks: {
      noFollowSubmit: true,
      afterPrediction: async scenario => {
        await scenario.waitFor(async () => (await scenario.events()).some(row => row.event === 'reply-start' && row.characterId === JOHNNY.characterId), 'the held follow-on to start', 60000);
        await sleep(300);
        scenario.cancelledAt = Date.now();
        scenario.pending.leaseDropped = true;   // the game stops the source: its lease is withdrawn (a scene starts, a fight, a menu ...)
      }}}, async scenario => {
      await scenario.source({follow: 'companion'});
      await scenario.waitFor(() => scenario.cancelledAt, 'the source to be cancelled', 60000);
      await scenario.waitFor(async () => (await scenario.events()).some(row => row.event === 'reply-abort' && row.characterId === JOHNNY.characterId), 'the held follow-on to be dropped', 30000);
      const events = await scenario.events();
      assert.ok(first(events, 'reply-abort', JUDY.characterId), 'the source line itself was stopped');
      assert.equal(count(events, 'play-start', JOHNNY.characterId), 0);
      assert.equal(scenario.replyIds.has(scenario.followFor.table.requestId), false);
      noErrors(scenario.output);
    });
    await run({prepare: true, hooks: {
      noFollowSubmit: true,
      afterPrediction: async scenario => {
        await scenario.waitFor(async () => (await scenario.events()).some(row => row.event === 'reply-start' && row.characterId === JOHNNY.characterId), 'the held follow-on to start', 60000);
        await sleep(300);
        scenario.withdrawnAt = Date.now();
        await scenario.command({});
      }}}, async scenario => {
      await scenario.source({follow: 'companion'});
      await scenario.waitFor(() => scenario.withdrawnAt, 'the prediction to be withdrawn', 60000);
      await scenario.waitFor(async () => (await scenario.events()).some(row => row.event === 'reply-abort' && row.characterId === JOHNNY.characterId), 'the held follow-on to be dropped', 20000);
      assert.ok(first(await scenario.events(), 'reply-abort', JOHNNY.characterId) - scenario.withdrawnAt < 1200, 'withdrawn: dropped within a poll');
      noErrors(scenario.output);
    });
  });

  it('a follow-on nobody claims is dropped after its maximum hold (90 s in production)', async () => {
    await run({prepare: true, env: {CYBERPUNK_CONVAI_TEST_PREPARED_HOLD_MS: '2500'}, hooks: {noFollowSubmit: true}}, async scenario => {
      await scenario.source({follow: 'companion'});
      await scenario.waitFor(async () => (await scenario.events()).some(row => row.event === 'reply-start' && row.characterId === JOHNNY.characterId), 'the held follow-on to start', 60000);
      const started = first(await scenario.events(), 'reply-start', JOHNNY.characterId);
      await scenario.waitFor(async () => (await scenario.events()).some(row => row.event === 'reply-abort' && row.characterId === JOHNNY.characterId), 'the held follow-on to expire', 30000);
      const dropped = first(await scenario.events(), 'reply-abort', JOHNNY.characterId) - started;
      assert.ok(dropped >= 2400 && dropped < 4500, `dropped ${dropped} ms after it started, 2.5 s being its hold`);
      assert.equal(count(await scenario.events(), 'play-start', JOHNNY.characterId), 0);
    });
  });

  it('a prediction that does not match what was heard is never started, and the game\'s own submission then runs as an ordinary request', async () => {
    const wrong = [
      ['another line than the one heard', table => ({...table, reaction: {...table.reaction, facts: {...table.reaction.facts, line: 'Something she never said.'}}})],
      ['another speaker\'s name', table => ({...table, reaction: {...table.reaction, facts: {...table.reaction.facts, who: 'Panam'}}})],
      ['a reply to V claimed for a speak-up', table => ({...table, reaction: {...table.reaction, facts: {...table.reaction.facts, via: 'talk'}}})],
    ];
    for (const [what, change] of wrong) {
      await run({prepare: true, hooks: {followTable: table => change(table)}}, async scenario => {
        await scenario.source({follow: 'companion'});
        await scenario.waitFor(() => scenario.done, 'the follow-on to finish', 600000);
        const events = await scenario.events();
        // Exactly one request for Johnny, made after her line ended (the serial path); never a held one.
        assert.equal(count(events, 'reply-start', JOHNNY.characterId), 1, what);
        assert.ok(first(events, 'reply-start', JOHNNY.characterId) >= last(events, 'play-end', JUDY.characterId), what);
        assert.equal(count(events, 'reply-abort', JOHNNY.characterId), 0, what);
        assert.equal(count(events, 'play-start', JOHNNY.characterId), 1, what);
        noErrors(scenario.output);
      });
    }
  });
});

describe('a companion\'s after-scene line, prepared while the scene\'s last line plays', {concurrency: 2, timeout: 2400000}, () => {
  async function sceneRound(options) {
    return run({speakers: 1, ...options}, async scenario => {
      await scenario.scene({sceneMs: 6000});
      await scenario.waitFor(() => scenario.done, 'the after-scene line to finish', 600000);
      const events = await scenario.events();
      return {events, scene: scenario, sceneEndedAt: scenario.sceneEndedAt, output: scenario.output, latency: await readJson(join(scenario.runtime, 'bridge-latency.json')),
        heard: events.find(row => row.event === 'reply-start' && row.characterId === JUDY.characterId)};
    });
  }
  it('is written during the scene, held, and said right after it; the serial game starts only when the scene is over', async () => {
    const [prepared, serial] = await Promise.all([sceneRound({prepare: true}), sceneRound({prepare: false})]);
    for (const round of [prepared, serial]) {
      assert.equal(round.heard.reaction, 'speakup'); assert.equal(round.heard.reactionEvent, 'scene'); noErrors(round.output);
      assert.match(round.heard.text, /scene that you were present for has just ended/);
      assert.match(round.heard.context, /The job pays double if you finish by dawn\./, 'the scene\'s lines are in her context');
      assert.match(round.heard.context, /The Heist|Playing for Time/, 'and the tracked quest');
    }
    assert.ok(prepared.heard.t < prepared.sceneEndedAt - 2000, `written during the scene (${prepared.sceneEndedAt - prepared.heard.t} ms before it ended)`);
    assert.ok(serial.heard.t > serial.sceneEndedAt, 'the serial game asks only when the scene is over');
    const gap = round => first(round.events, 'play-start', JUDY.characterId) - round.sceneEndedAt;
    assert.ok(gap(prepared) > 0 && gap(serial) > 1400, `serial ${gap(serial)}`);
    assert.ok(gap(prepared) < gap(serial) - 800, `prepared ${gap(prepared)} vs serial ${gap(serial)}`);
    assert.equal(prepared.latency.turns.find(row => row.profile === 'judy-alvarez').preparation.mode, 'lookahead');
    assert.equal(prepared.latency.turns.find(row => row.profile === 'judy-alvarez').lookahead.readyBeforeClaim, true);
  });

  it('Johnny follows an after-scene line the same way: both prepared, the scene line first and his remark right after it', async () => {
    await run({speakers: 1, prepare: true, hold: [JUDY], hooks: {afterPrediction: scenario => checkHeld(scenario)}}, async scenario => {
      await scenario.scene({sceneMs: 5000, follow: 'companion'});
      await scenario.waitFor(() => scenario.done, 'both lines to finish', 600000);
      const events = await scenario.events();
      assert.deepEqual(orderOf(events), ['play-start:1', 'play-end:1', 'play-start:4', 'play-end:4']);
      const judyAsk = events.find(row => row.event === 'reply-start' && row.characterId === JUDY.characterId), johnnyAsk = events.find(row => row.event === 'reply-start' && row.characterId === JOHNNY.characterId);
      assert.ok(judyAsk.t < scenario.sceneEndedAt - 2000, 'her line was written during the scene');
      assert.ok(johnnyAsk.t < last(events, 'play-end', JUDY.characterId) - 1500, 'and his during her line');
      assert.match(johnnyAsk.text, /Judy" has just said this to V on her own/);
      assert.ok(gapBetween(events, JUDY, JOHNNY) < 900, `his remark follows her line closely (${gapBetween(events, JUDY, JOHNNY)} ms)`);
      noErrors(scenario.output);
    });
  });

  it('nothing of it reaches the game before the scene is over, and a request of V\'s during the scene drops it', async () => {
    await run({speakers: 1, prepare: true}, async scenario => {
      const input = scenario.speakUpInput('scene', JUDY);
      await scenario.command({kind: 'ahead', input});
      await scenario.waitFor(async () => (await scenario.events()).some(row => row.event === 'reply-start' && row.characterId === JUDY.characterId), 'the held line to start', 60000);
      await sleep(3600);
      assert.equal(scenario.replyIds.has(input.requestId), false, 'not published'); assert.equal(count(await scenario.events(), 'play-start', JUDY.characterId), 0, 'not heard');
      // V starts talking in the middle of the scene: dropped.
      scenario.done = false;
      await scenario.submit(scenario.talkInput(JUDY, 'Judy, wait.'), {kind: 'talk'});
      await scenario.waitFor(() => scenario.done, 'V\'s turn to finish', 600000);
      const events = await scenario.events();
      assert.equal(count(events, 'reply-abort', JUDY.characterId), 1, 'the held line was dropped');
      assert.equal(scenario.replyIds.has(input.requestId), false);
      assert.equal(count(events, 'play-start', JUDY.characterId), 1, 'only V\'s own turn was heard');
      noErrors(scenario.output);
    });
  });
});

describe('who may prepare a line ahead on Convai', {concurrency: 2, timeout: 2400000}, () => {
  it('the shared key and a confirmed paid plan prepare it; a player\'s own free plan keeps the serial path', async () => {
    const [shared, paid, free] = await Promise.all([
      followRound({prepare: true, timings: LIVE_SPEAK_TIMINGS}),
      followRound({prepare: true, timings: LIVE_SPEAK_TIMINGS, playerKey: {connections: 6}}),
      followRound({prepare: true, timings: LIVE_SPEAK_TIMINGS, playerKey: {connections: 1}})]);
    const mode = round => round.latency.turns.find(row => row.profile === 'johnny-silverhand').preparation.mode;
    assert.equal(mode(shared), 'lookahead'); assert.equal(mode(paid), 'lookahead'); assert.equal(mode(free), 'none');
    assert.ok(first(free.events, 'reply-start', JOHNNY.characterId) >= last(free.events, 'play-end', JUDY.characterId), 'free plan: asked only after her line');
    assert.ok(free.gap > 5500, `free plan gap ${free.gap}`);
    for (const round of [shared, paid]) assert.ok(round.gap > 0 && round.gap < free.gap * .3, `prepared gap ${round.gap} vs free ${free.gap}`);
    for (const round of [shared, paid, free]) { assert.deepEqual(orderOf(round.events), ['play-start:1', 'play-end:1', 'play-start:4', 'play-end:4']); noErrors(round.output); }
  });
});

// ---- the text providers ---------------------------------------------------------------------------------------------------------------------

describe('the text providers (Custom here: a simulated server on this computer) prepare the same lines', {concurrency: 2, timeout: 2400000}, () => {
  const runText = async (options, drive) => {
    const chat = await startChatServer({firstTokenMs: 900});
    return run({provider: 'custom', chat, ...options}, scenario => drive(scenario, chat));
  };
  it('the follow-on is written during her line, held, and published only after the game submits it; her later turn never carries his line', async () => {
    await runText({prepare: true, playMs: 5000}, async (scenario, chat) => {
      await scenario.source({follow: 'companion'});
      await scenario.waitFor(() => scenario.done, 'the follow-on to finish', 600000);
      const trail = scenario.trail, at = event => trail.find(row => row.event === event)?.t;
      const johnnyAsk = chat.requests.find(row => /Johnny Silverhand/.test(JSON.stringify(row.messages[0])));
      assert.ok(johnnyAsk, 'the model was asked for his line');
      assert.ok(johnnyAsk.t < at('ended'), `asked ${at('ended') - johnnyAsk.t} ms before her line was over`);
      assert.ok(johnnyAsk.endedAt < at('ended'), 'and answered before it was over');
      const submitted = trail.findLast(row => row.event === 'submit' && row.profile === JOHNNY.key).t, admitted = trail.find(row => row.event === 'admitted' && row.profile === JOHNNY.key).t;
      assert.ok(submitted > at('ended') && admitted >= submitted, 'published only after the game asked for it');
      assert.ok(admitted - submitted < 800, `and then at once (${admitted - submitted} ms)`);
      assert.match(JSON.stringify(johnnyAsk.messages), /Quiet night, V\. I could get used to this\./);
      // Privacy: her next turn is built from her own memory and context. Neither line is in it, and nothing of either is in any memory file.
      scenario.done = false;
      await scenario.submit(scenario.talkInput(JUDY, 'And what did you think of that?'), {kind: 'talk', playMs: 500});
      await scenario.waitFor(() => scenario.done, 'her next turn to finish', 600000);
      const next = chat.requests.at(-1);
      assert.ok(!JSON.stringify(next.messages).includes(SPEAK_TIMINGS['johnny-silverhand'].text), 'Johnny\'s line is not in her prompt');
      assert.ok(!JSON.stringify(next.messages).includes('Quiet night, V. I could get used to this.'), 'and neither is her own speak-up (a reaction is no conversation memory)');
      const found = [];
      const walk = async dir => { for (const entry of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else { const text = await readFile(path, 'utf8').catch(() => ''); if (text.includes('stop talking') || text.includes('get used to this')) found.push(path); }
      } };
      await walk(scenario.state);
      assert.deepEqual(found, [], 'no memory or state file holds either line');
      noErrors(scenario.output);
    });
  });

  it('V\'s own request while the follow-on is being written stops the model\'s generation and is sent to the model at once', async () => {
    const chat = await startChatServer({firstTokenMs: 2500});
    await run({provider: 'custom', chat, prepare: true, playMs: 6000, hooks: {
      noFollowSubmit: true,
      afterPrediction: async scenario => {
        await scenario.waitFor(() => chat.requests.some(row => /Johnny Silverhand/.test(JSON.stringify(row.messages[0]))), 'the model to be asked for his line', 60000);
        await sleep(200);
        scenario.vSubmittedAt = Date.now();
        await scenario.submit(scenario.talkInput(JUDY, 'Hey Judy, listen.'), {kind: 'talk', playMs: 500});
      }}}, async scenario => {
      await scenario.source({follow: 'companion'});
      await scenario.waitFor(() => scenario.vSubmittedAt && scenario.done, 'V\'s turn to finish', 600000);
      const johnnyAsk = chat.requests.find(row => /Johnny Silverhand/.test(JSON.stringify(row.messages[0])));
      assert.equal(johnnyAsk.aborted, true, 'the model server saw the generation stopped');
      assert.ok(johnnyAsk.closedAt - scenario.vSubmittedAt < 1500, `stopped ${johnnyAsk.closedAt - scenario.vSubmittedAt} ms after V's request was written`);
      const mine = chat.requests.findLast(row => !/Johnny Silverhand/.test(JSON.stringify(row.messages[0])));
      assert.ok(mine.t - scenario.vSubmittedAt < 1500, `V's request reached the model ${mine.t - scenario.vSubmittedAt} ms after it was written`);
      assert.equal(scenario.replyIds.has(scenario.followFor.table.requestId), false, 'his line was never published');
      noErrors(scenario.output);
    });
  });

  it('the after-scene line is prepared on a text provider too', async () => {
    await runText({prepare: true, speakers: 1}, async (scenario, chat) => {
      await scenario.scene({sceneMs: 5000});
      await scenario.waitFor(() => scenario.done, 'the after-scene line to finish', 600000);
      const ask = chat.requests.find(row => /scene that you were present for/.test(JSON.stringify(row.messages)));
      assert.ok(ask && ask.t < scenario.sceneEndedAt - 1500, 'written during the scene');
      assert.match(JSON.stringify(ask.messages), /The job pays double if you finish by dawn\./);
      const admitted = scenario.trail.find(row => row.event === 'admitted').t, submitted = scenario.trail.find(row => row.event === 'submit').t;
      assert.ok(admitted > scenario.sceneEndedAt && admitted - submitted < 800, 'published only after the scene, then at once');
      noErrors(scenario.output);
    });
  });
});
