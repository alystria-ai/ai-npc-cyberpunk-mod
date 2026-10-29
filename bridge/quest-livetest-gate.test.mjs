// The 30 Oct live test: Panam's pilot never started on a save that finished Phantom Liberty but never called Reed. The quest `q307_before_tomorrow` sat at its first
// stage (wait for Reed's text, call Reed), and the end-of-story guard (ep1 q307) counted it as the finale for good. A finale quest at its hook no longer stops a pack,
// one past its hook still does, and with Developer mode on a pack that does not start says why in the log.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BondPacks} from './bond-pack-runner.mjs';
import {shippedPacks, packGate, explainGate} from './bond-packs.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const DAY = 86400;
const pilot = shippedPacks().map(row => row.pack).find(pack => pack.id === 'panam-sunset-coffee');
const roster = new Set(['panam-palmer', 'judy-alvarez']);

/** rows: [path, state, [stage of each open objective]]: a quest row with one objective per stage given. */
function journal(rows) {
  const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: rows.length, omitted: 0, unstable: false};
  return parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'},
    coverage: {active: coverage, history: coverage},
    quests: rows.map(([path, state, stages = []], index) => {
      const nativeId = path.slice(path.lastIndexOf('/') + 1);
      return {id: String(100 + index), nativeId, nativePath: path, title: 'Quest ' + index, state, lane: state === 'active' ? 'active' : 'history', observedAtMs: 1000,
        objectivesComplete: state !== 'active',
        objectives: stages.map(([stage, objectiveState], at) => ({id: String(900 + index * 10 + at), nativeId: `o${at}`, questRelativePath: [nativeId, stage, `o${at}`],
          text: 'Do it.', state: objectiveState, observedAtMs: 1000}))};
    })});
}
// The owner's save at that point: the Panam quests done, the Reed hook open, the epilogue waiting.
const DONE = [['quests/main_quest/act_01/q104_02_av_chase', 'succeeded'], ['quests/side_quest/sq027_02_raffen_shiv_attack', 'succeeded'],
  ['ep1/quests/main_quest/q305_reed_epilogue', 'succeeded']];
const HOOK = ['ep1/quests/main_quest/q307_before_tomorrow', 'active', [['00_hook', 'active'], ['00_hook', 'succeeded']]];
const FINALE = ['ep1/quests/main_quest/q307_before_tomorrow', 'active', [['01_tower', 'active'], ['00_hook', 'succeeded']]];

let counter = 0;
const turn = (gameSeconds, rows, extra = {}) => ({requestId: `r-${++counter}`, profileKey: 'panam-palmer', name: 'Panam', text: 'hey', entity: 'e1',
  turnContext: {gameTime: gameSeconds}, journalHistory: journal(rows), bonds: {on: true, copy: 'party', packs: true, invitations: true}, ...extra});
function make(explain = null) {
  const log = [];
  const runner = new BondPacks({packs: [pilot], characters: roster, random: () => 0, log: line => { if (!line.startsWith('reach-outs')) log.push(line); }, bonds: {award() {}, publish() {}}, debounceMs: 0, path: 'p.json',
    write: async () => {}, exists: () => false, explain});
  return {runner, log};
}
const gate = rows => packGate(pilot, {level: 7, journalHistory: journal(rows), romance: 'partner', channel: 'own', settings: {invitations: true}});

test('a finale quest that only waits at its hook does not stop the pilot, one past its hook does', () => {
  assert.deepEqual(gate([...DONE, HOOK]), {open: true});
  const closed = gate([...DONE, FINALE]);
  assert.equal(closed.open, false);
  assert.equal(closed.why, 'quest-active');
  assert.equal(closed.path, 'ep1/quests/main_quest/q307_before_tomorrow');
});

test('the hook only counts for the end-of-story guard: the character\'s own quest lines and the pack\'s notActive still stop it at their hook', () => {
  const own = ['quests/side_quest/sq004_riders_on_the_storm', 'active', [['00_hook', 'active']]];
  assert.equal(gate([...DONE, own]).why, 'quest-active');
  const noObjectives = ['ep1/quests/main_quest/q307_before_tomorrow', 'active', []];
  assert.equal(gate([...DONE, noObjectives]).why, 'quest-active', 'a quest with no open objective row is not known to be idle');
  const mixed = ['ep1/quests/main_quest/q307_before_tomorrow', 'active', [['00_hook', 'active'], ['01_tower', 'active']]];
  assert.equal(gate([...DONE, mixed]).why, 'quest-active');
});

test('on the owner\'s save state the pilot starts on Panam\'s turn (it never rolled before)', () => {
  const {runner} = make();
  const input = turn(30 * DAY, [...DONE, HOOK]);
  const decision = runner.forTurn(input, {level: 7, romance: 'partner'});
  assert.equal(decision.pack?.id, 'panam-sunset-coffee');
  assert.match(decision.note, /Sunset Motel/);
});

test('with Developer mode on, a pack that does not start says why once per game day, and nothing is logged with it off', () => {
  const on = make(() => true), off = make(() => false), none = make();
  for (const {runner, log} of [on, off, none]) {
    const t = 30 * DAY;
    runner.forTurn(turn(t, [...DONE, FINALE]), {level: 7, romance: 'partner'});
    runner.forTurn(turn(t + 600, [...DONE, FINALE]), {level: 7, romance: 'partner'});
    runner.forTurn(turn(t + DAY, [...DONE, FINALE]), {level: 7, romance: 'partner'});
  }
  assert.deepEqual(on.log, ['panam-sunset-coffee waits: q307_before_tomorrow still active', 'panam-sunset-coffee waits: q307_before_tomorrow still active']);
  assert.deepEqual(off.log, []);
  assert.deepEqual(none.log, []);
});

test('the reasons read as words: bond level, channel, journal, busy and the dice', () => {
  const log = [];
  const runner = new BondPacks({packs: [pilot], characters: roster, random: () => 0.99, log: line => { if (!line.startsWith('reach-outs')) log.push(line); }, bonds: {award() {}, publish() {}}, debounceMs: 0, path: 'p.json',
    write: async () => {}, exists: () => false, explain: () => true});
  const t = 40 * DAY;
  runner.forTurn(turn(t, DONE), {level: 1});
  runner.forTurn(turn(t + DAY, DONE, {bonds: {on: true, copy: 'party', packs: true, busy: true}}), {level: 7});
  runner.forTurn(turn(t + 2 * DAY, DONE, {journalHistory: undefined}), {level: 7});
  runner.forTurn(turn(t + 3 * DAY, DONE), {level: 7});
  runner.forTurn(turn(t + 4 * DAY, DONE, {bonds: {on: true, packs: true}}), {level: 7});
  assert.deepEqual(log, [
    'panam-sunset-coffee waits: bond level 1 is under 3',
    'panam-sunset-coffee waits: the game is busy (a scene, a choice, a fight or a call)',
    'panam-sunset-coffee waits: the quest journal is not complete yet',
    'panam-sunset-coffee waits: the dice said no today (chance 0.5)',
    "panam-palmer waits: story never starts a pack (a pack starts on one of V's own copies, a phone chat or a holocall)"]);
  assert.equal(explainGate({open: false, why: 'quest-not-finished', path: 'quests/a/q104_02_av_chase'}, pilot), 'q104_02_av_chase is not finished');
});
