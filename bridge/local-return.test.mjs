import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RETURN_LIMITS, lookRefusal, returnAvailableMiB, returnBackoffMs, returnCandidate, returnVerdict} from './local-return.mjs';

test('the back-off grows 1, 2, 5, 10, 15 minutes and then repeats the last gap', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 40].map(looks => returnBackoffMs(looks)), [60_000, 120_000, 300_000, 600_000, 900_000, 900_000, 900_000]);
  assert.equal(returnBackoffMs(0), 60_000, 'a look count below one reads as the first');
  assert.equal(returnBackoffMs(undefined), 60_000);
});

test('the room for a return is what is free less the voice engine still to load less the room kept for the game; the old server is not added back', () => {
  assert.equal(returnAvailableMiB({freeMiB: 6000}), 6000 - RETURN_LIMITS.roomKeptMiB);
  assert.equal(returnAvailableMiB({freeMiB: 6000, voiceMiB: 2500}), 6000 - 2500 - RETURN_LIMITS.roomKeptMiB);
  assert.equal(returnAvailableMiB({freeMiB: 500}), 500 - RETURN_LIMITS.roomKeptMiB, 'can be negative');
  assert.equal(returnAvailableMiB({freeMiB: null}), null);
  assert.equal(returnAvailableMiB({freeMiB: NaN}), null);
  assert.equal(returnAvailableMiB({freeMiB: 6000, voiceMiB: -5}), 6000 - RETURN_LIMITS.roomKeptMiB, 'a negative voice size counts as none');
});

test('the verdict picks the largest context rung whose projection plus the margin fits, and says what the smallest rung needs', () => {
  const projections = [{contextSize: 16384, kvType: null, projectedMiB: 3734}, {contextSize: 8192, kvType: null, projectedMiB: 3598}, {contextSize: 8192, kvType: 'q8_0', projectedMiB: 3520}];
  assert.deepEqual(returnVerdict({availableMiB: 4246, projections, marginMiB: 512}).pick?.contextSize, 16384, 'exactly at the threshold: enough');
  assert.equal(returnVerdict({availableMiB: 4245, projections, marginMiB: 512}).pick?.contextSize, 8192, 'one MiB short of the large context: the next rung');
  assert.equal(returnVerdict({availableMiB: 4110, projections, marginMiB: 512}).pick?.contextSize, 8192);
  assert.equal(returnVerdict({availableMiB: 4032, projections, marginMiB: 512}).pick?.kvType, 'q8_0', 'the 8-bit cache rung at its own threshold');
  const none = returnVerdict({availableMiB: 4031, projections, marginMiB: 512});
  assert.deepEqual([none.enough, none.pick, none.needMiB], [false, null, 4032], 'needs 3,520 + 512');
  const unknown = returnVerdict({availableMiB: 9000, projections: null, marginMiB: 512});
  assert.deepEqual([unknown.enough, unknown.needMiB], [false, null]);
  assert.equal(returnVerdict({availableMiB: null, projections, marginMiB: 512}).enough, false);
  assert.equal(returnVerdict({availableMiB: 9000, projections: [{contextSize: 16384, kvType: null, projectedMiB: null}], marginMiB: 512}).enough, false, 'a rung with no projection is no rung');
});

test('only a model of ours that is off the card is a candidate: spilled by the counters, or loaded with part on the CPU; never a server the player runs', () => {
  assert.equal(returnCandidate({loaded: {offload: false}, spilled: true}), true);
  assert.equal(returnCandidate({loaded: {offload: true}, spilled: false}), true);
  assert.equal(returnCandidate({loaded: {offload: false}, spilled: false}), false, 'whole on the card and healthy counters: nothing to do');
  assert.equal(returnCandidate({loaded: {offload: true}, external: true}), false);
  assert.equal(returnCandidate({loaded: {offload: true, external: true}}), false);
  assert.equal(returnCandidate({loaded: null, spilled: true}), false);
});

test('a look waits while anything holds the model, until the back-off ran out and until the last turn is 20 s old; nothing else stops it', () => {
  const idle = {now: 100_000, nextAt: 50_000, inflight: 0, foregroundEndedAt: 10_000, background: false, busy: false, stepping: false};
  assert.equal(lookRefusal(idle), null);
  assert.equal(lookRefusal({...idle, inflight: 1}).retryMs, null, 'a turn in flight: never mid-turn, the end of the request will ask again');
  assert.match(lookRefusal({...idle, inflight: 1}).why, /request/);
  assert.match(lookRefusal({...idle, background: true}).why, /background/);
  assert.match(lookRefusal({...idle, busy: true}).why, /already/);
  assert.match(lookRefusal({...idle, stepping: true}).why, /changed/);
  assert.deepEqual(lookRefusal({...idle, nextAt: 130_000}), {why: 'not yet, the back-off has not run out', retryMs: 30_000});
  assert.deepEqual(lookRefusal({...idle, foregroundEndedAt: 90_000}), {why: 'a turn ended a moment ago', retryMs: 10_000}, '20 s of quiet after the turn');
  assert.equal(lookRefusal({...idle, foregroundEndedAt: 80_000}), null, 'exactly 20 s later');
  assert.equal(lookRefusal({...idle, foregroundEndedAt: -Infinity}), null, 'no turn yet this session');
});
