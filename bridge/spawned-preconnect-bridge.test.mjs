import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {measureTalk, LIVE_TIMINGS} from './group-lookahead-fixture.mjs';

// The real convai-bridge.mjs runs against a simulated game and a simulated Convai provider (group-lookahead-fixture.mjs, provider delays
// shaped like the 2026-10-17 live round: a fresh connection 3.5 s, then the reply). The game side lists a character another mod or a
// spawner created in nearby-connections.json (`spawned`, mod/auto-connect.lua); the bridge opens its connection then, and V's first talk
// to that character finds the page open. scripts/Measure-SpawnedConnect.mjs prints the same cases as numbers.
// The simulated game renews playback control from a wall-clock timer; a long lease keeps a busy full-suite run from starving it.
process.env.CYBERPUNK_CONVAI_TEST_LEASE_MS = '60000';
const JUDY = 'judy-alvarez', PANAM = 'panam-palmer', ALEX = 'alex';
const noErrors = output => assert.doesNotMatch(output, /poll:|Unhandled|uncaught|TypeError|ReferenceError|request failed/, output);
const talk = options => measureTalk({timings: LIVE_TIMINGS, ...options});
// A turn that must open its own connection takes the connection (3.5 s) on top of the reply (about 3.9 s to its first audio).
const COLD_MS = 6500, WARM_MS = 5200;

describe('a spawned character is connected before the first talk', {concurrency: 2, timeout: 600000}, () => {
  it('on a paid plan the first talk has no connection cost; without the hint it pays it', async () => {
    const [ahead, cold] = await Promise.all([talk({playerKey: {connections: 6}, spawned: [JUDY], expectWarms: 1}), talk({playerKey: {connections: 6}})]);
    assert.deepEqual(ahead.opened, [JUDY]);
    assert.equal(ahead.connectedWarm, true, 'the talk found the page open');
    assert.ok(ahead.firstAudioMs < WARM_MS, `first audio after ${ahead.firstAudioMs} ms`);
    assert.deepEqual(cold.opened, []);
    assert.equal(cold.connectedWarm, false);
    assert.ok(cold.firstAudioMs > COLD_MS, `without the hint: ${cold.firstAudioMs} ms`);
    assert.ok(ahead.firstAudioMs < cold.firstAudioMs - 2000, `${ahead.firstAudioMs} vs ${cold.firstAudioMs}`);
    // Before the talk the page was ready under the spawned role (read from the connection state the bridge publishes).
    const row = ahead.state?.connections?.find(entry => entry.profile === 'judy-alvarez');
    assert.ok(row, 'the state lists the spawned connection'); assert.equal(row.role, 'spawned'); assert.equal(row.state, 'ready');
    assert.deepEqual(ahead.state.spawned, ['judy-alvarez']);
    // Opening sent nothing: the only provider request is the talk itself.
    assert.equal(ahead.events.filter(event => event.event === 'reply-start').length, 1, 'opening sent no message');
    noErrors(ahead.output); noErrors(cold.output);
  });

  it('on the shared key the same hint opens it; a free player plan opens nothing, as before', async () => {
    const [shared, free] = await Promise.all([talk({spawned: [JUDY], expectWarms: 1}), talk({playerKey: {connections: 1}, spawned: [JUDY]})]);
    assert.deepEqual(shared.opened, [JUDY]);
    assert.equal(shared.connectedWarm, true);
    assert.ok(shared.firstAudioMs < WARM_MS, `shared key: ${shared.firstAudioMs} ms`);
    assert.deepEqual(free.opened, [], 'a plan with one connection never opens a spawned character ahead');
    assert.equal(free.connectedWarm, false);
    assert.ok(free.firstAudioMs > COLD_MS, `free plan: ${free.firstAudioMs} ms`);
    noErrors(shared.output); noErrors(free.output);
  });

  it('a profile that is also a party member opens once; three spawned characters open on a paid plan, one on a plan of two', async () => {
    const [shared, three, small] = await Promise.all([
      talk({playerKey: {connections: 6}, party: [JUDY], spawned: [JUDY, PANAM], expectWarms: 2}),
      talk({playerKey: {connections: 6}, spawned: [JUDY, PANAM, ALEX], expectWarms: 3}),
      talk({playerKey: {connections: 2}, spawned: [JUDY, PANAM, ALEX], expectWarms: 1})]);
    assert.deepEqual([...shared.opened].sort(), [JUDY, PANAM], 'Judy is one connection, not two');
    assert.equal(shared.events.filter(event => event.event === 'warm' && event.characterId.startsWith('11111111')).length, 1);
    assert.ok(shared.firstAudioMs < WARM_MS);
    assert.deepEqual([...three.opened].sort(), [ALEX, JUDY, PANAM].sort());
    assert.ok(three.firstAudioMs < WARM_MS);
    // A plan of two keeps one connection for the page V is on: one spawned character, the first listed.
    assert.deepEqual(small.opened, [JUDY]);
    assert.ok(small.firstAudioMs < WARM_MS);
    for (const row of [shared, three, small]) noErrors(row.output);
  });
});
