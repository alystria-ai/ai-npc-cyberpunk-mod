// The next line of a housemates' chat, written while the line before it is still being said (docs/HOUSEMATES.md, "Pair chat"), in the real
// convai-bridge.mjs against a simulated game and provider (bridge/speak-up-fixture.mjs). The game side here is what mod/init.lua does: line 1 is a house
// reaction with its lease; when its complete text is known the game publishes line 2 as {kind: 'ahead', input} (the text in `lines`) and, when line 1 has been
// heard, submits the very same table. The provider is SIMULATED: these tests prove the order of events, the gap against the serial game and what is
// dropped, not live latency.
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {SpeakUpScenario, JUDY, SPEAK_TIMINGS} from './speak-up-fixture.mjs';
import {SPEAKERS} from './group-lookahead-fixture.mjs';
import {validateAhead} from './group-lookahead.mjs';

process.env.CYBERPUNK_CONVAI_TEST_LEASE_MS = '60000';
const PANAM = SPEAKERS[1];
const first = (events, name, id, after = -Infinity) => events.find(row => row.event === name && row.characterId === id && row.t > after)?.t;
const last = (events, name, id) => events.findLast(row => row.event === name && row.characterId === id)?.t;
const count = (events, name, id) => events.filter(row => row.event === name && row.characterId === id).length;
const noErrors = output => assert.doesNotMatch(output, /poll:|Unhandled|uncaught|TypeError|ReferenceError|request failed/, output);
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };

const REACTION = {kind: 'house', event: 'chat', place: 'Corpo Plaza apartment', of: 7};
const houseTurn = (scenario, person, partner, n, lines, expiresInMs = 180000) => scenario.baseTurn(person, {
  text: `You are talking with ${partner.name} at V's place. Say your next line.`,
  reaction: {...REACTION, partner: partner.name, partnerKey: partner.key, n, lines, expiresAt: Date.now() + expiresInMs}});

// Line 1 (Judy) is the source; line 2 (Panam) is built when Judy's complete text is known, published when `prepare`, submitted when Judy has been heard.
class HouseScenario extends SpeakUpScenario {
  async onText(pending) {
    if (!pending.plan.house) return;
    const table = houseTurn(this, PANAM, JUDY, 2, [{speaker: JUDY.name, text: pending.text}]);
    this.nextTable = table;
    if (this.prepare) { await this.command({kind: 'ahead', input: table}); this.note('prepared-command', {requestId: table.requestId}); }
    this.detach(this.hooks.afterPrediction?.(this, pending));
  }

  async finish(pending) {
    await super.finish(pending);
    if (pending.plan.kind === 'house-2') { this.houseDone = true; return; }
    if (!pending.plan.house || !this.nextTable || this.hooks.noSubmit) return;
    // Judy has been heard: the game reads the end of the line and sends line 2 after its short beat.
    this.done = false;
    await sleep(this.submitDelayMs);
    if (!this.pending) await this.submit(this.nextTable, {kind: 'house-2'});
  }

  async lineOne() {
    this.done = false; this.houseDone = false;
    const input = houseTurn(this, JUDY, PANAM, 1, []);
    input.reaction.topic = 'what to have for dinner';
    this.lineOneInput = input;
    await this.submit(input, {kind: 'source', house: true});
    return input;
  }
}

async function run(options, drive) {
  const scenario = new HouseScenario({speakers: 1, timings: SPEAK_TIMINGS, ...options});
  try { await scenario.start(); return await drive(scenario); } finally { await scenario.stop(); }
}
async function chatRound(options) {
  return run(options, async scenario => {
    await scenario.lineOne();
    await scenario.waitFor(() => scenario.houseDone, 'line 2 to finish', 600000);
    const events = await scenario.events();
    return {events, scenario, output: scenario.output, latency: await readJson(join(scenario.runtime, 'bridge-latency.json')),
      second: events.find(row => row.event === 'reply-start' && row.characterId === PANAM.characterId)};
  });
}

describe('the next line of a housemates\' chat, written while the line before it plays', {concurrency: 2, timeout: 2400000}, () => {
  it('line 2 is written from line 1\'s text during line 1, held, and heard right after it; the serial game pays a whole request after line 1', async () => {
    const [prepared, serial] = await Promise.all([chatRound({prepare: true}), chatRound({prepare: false})]);
    for (const round of [prepared, serial]) {
      noErrors(round.output);
      assert.equal(round.second.reaction, 'house'); assert.equal(round.second.reactionEvent, 'chat');
      assert.match(round.second.text, /This is line 2 of a short chat of 7 lines/);
      assert.match(round.second.text, /Quiet night, V. I could get used to this./, 'line 1\'s text is in line 2\'s context');
      assert.deepEqual(round.events.filter(row => ['play-start', 'play-end'].includes(row.event)).map(row => `${row.event}:${row.characterId[0]}`),
        ['play-start:1', 'play-end:1', 'play-start:2', 'play-end:2'], 'one voice at a time, in order');
    }
    assert.ok(prepared.second.t < last(prepared.events, 'play-end', JUDY.characterId) - 1500, `Panam was written during Judy's line (${last(prepared.events, 'play-end', JUDY.characterId) - prepared.second.t} ms before it ended)`);
    assert.ok(serial.second.t >= last(serial.events, 'play-end', JUDY.characterId), 'the serial game asks only when the line is over');
    const gap = round => first(round.events, 'play-start', PANAM.characterId) - last(round.events, 'play-end', JUDY.characterId);
    assert.ok(gap(serial) > 1400, `serial gap ${gap(serial)}`);
    assert.ok(gap(prepared) < gap(serial) - 800, `prepared gap ${gap(prepared)} vs serial ${gap(serial)}`);
    assert.ok(gap(prepared) < 1000, `well under a second: ${gap(prepared)} ms`);
    const turn = prepared.latency.turns.find(row => row.profile === 'panam-palmer');
    assert.equal(turn.preparation.mode, 'lookahead'); assert.equal(turn.lookahead.readyBeforeClaim, true);
  });

  it('nothing of the held line reaches the game before line 1 is over, and V talking during line 1 drops it', async () => {
    await run({prepare: true, hooks: {noSubmit: true}}, async scenario => {
      await scenario.lineOne();
      await scenario.waitFor(() => scenario.nextTable, 'line 2 to be published', 60000);
      await scenario.waitFor(async () => (await scenario.events()).some(row => row.event === 'reply-start' && row.characterId === PANAM.characterId), 'the held line to start', 60000);
      await sleep(2500);
      assert.equal(scenario.replyIds.has(scenario.nextTable.requestId), false, 'not published');
      assert.equal(count(await scenario.events(), 'play-start', PANAM.characterId), 0, 'not heard');
      // V presses the talk key: the game withdraws the prediction ({}), the held line is dropped.
      await scenario.command({});
      await scenario.waitFor(async () => count(await scenario.events(), 'reply-abort', PANAM.characterId) === 1, 'the held line to be dropped', 60000);
      assert.equal(scenario.replyIds.has(scenario.nextTable.requestId), false);
      noErrors(scenario.output);
    });
  });

  it('a line that differs from the prepared one runs as an ordinary request and the held one is dropped', async () => {
    await run({prepare: true, hooks: {noSubmit: true}}, async scenario => {
      await scenario.lineOne();
      await scenario.waitFor(() => scenario.nextTable, 'line 2 to be published', 60000);
      await scenario.waitFor(async () => (await scenario.events()).some(row => row.event === 'reply-start' && row.characterId === PANAM.characterId), 'the held line to start', 60000);
      await scenario.waitFor(() => scenario.pending === null, 'line 1 to end', 60000);
      // Somebody left the flat meanwhile: line 2 is another request (another speaker, other lines).
      const other = houseTurn(scenario, SPEAKERS[2], JUDY, 2, [{speaker: JUDY.name, text: 'Quiet night, V. I could get used to this.'}]);
      scenario.done = false;
      await scenario.submit(other, {kind: 'house-2'});
      await scenario.waitFor(() => scenario.houseDone, 'the other line to finish', 600000);
      const events = await scenario.events();
      assert.equal(count(events, 'reply-abort', PANAM.characterId), 1, 'the held line was dropped');
      assert.equal(count(events, 'play-start', PANAM.characterId), 0, 'Panam never spoke');
      assert.equal(count(events, 'play-start', SPEAKERS[2].characterId), 1, 'the other speaker did');
      noErrors(scenario.output);
    });
  });
});

describe('what the bridge accepts as a prepared housemate line', () => {
  const wire = (scenario, change = {}) => {
    const turn = houseTurn(scenario, PANAM, JUDY, 2, [{speaker: 'Judy', text: 'Quiet night.'}]);
    return {...turn, ...change, reaction: {...turn.reaction, ...(change.reaction ?? {})}};
  };
  const scenario = new HouseScenario({speakers: 1});
  it('accepts a private chat line and refuses a welcome, a group turn, an expired line and a command with a source', () => {
    assert.ok(validateAhead({kind: 'ahead', input: wire(scenario)}));
    assert.equal(validateAhead({kind: 'ahead', input: wire(scenario), sourceRequestId: 'x'}), null);
    assert.equal(validateAhead({kind: 'ahead', input: wire(scenario, {reaction: {expiresAt: Date.now() - 1000}})}), null);
    assert.equal(validateAhead({kind: 'ahead', input: wire(scenario, {group: {id: 'g', index: 2, count: 3}})}), null);
    assert.equal(validateAhead({kind: 'ahead', input: wire(scenario, {reaction: {event: 'welcome', awayHours: 3, others: []}})}), null);
    assert.equal(validateAhead({kind: 'ahead', input: wire(scenario, {reaction: {kind: 'meet'}})}), null);
    assert.equal(validateAhead({kind: 'ahead', input: wire(scenario, {reaction: {n: 9}})}), null);
  });
});
