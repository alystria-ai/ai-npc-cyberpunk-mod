// Fair story pack starts (bridge/quest-start.mjs, bridge/bond-pack-runner.mjs). The regression case is the owner's live test of 31 Oct 2026: Judy Alvarez, invited, in V's party,
// following V, romance partner, bond level 7. While V typed to her in person, judy-claws-calling started on `own`, its first stage is a call-in (rings only at a calm moment, so it
// never rang while V talked), the stage clock of 1 game hour ran from the start, and about 8 real minutes later the pack ended `late-end` with bond -15 for a quest V never saw.
// Rules pinned here, for every shipped pack:
//   1. a pack that opens with a call does not start in person, nor with her beside V or in V's party, and is a phone or holocall pack in its data;
//   2. a started pack is seen: the journal row is made at the start (the game side adds the tracker, the pin and the on-screen notice, see quest-journal-lua.test.mjs);
//   3. the timeout clock starts only once the start was shown (the call rang, was answered or was texted), the pack's own hours are a minimum, and a timeout that costs bond
//      points needs V to have accepted;
//   4. every line a pack's rows, calls and endings say exists in the pack (the prepared audio list is scripts/Check-QuestLineAudio.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BondPacks, ROLLBACK_SLACK} from './bond-pack-runner.mjs';
import {shippedPacks} from './bond-packs.mjs';
import {referencesOf} from './quest-format.mjs';
import {startAllowed, opensWithCall, castsHerAtStart, timeoutHours, travelStage, penalty, presentedAtStart, START_FLOOR_HOURS, UNSEEN_WITHDRAW_HOURS} from './quest-start.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const DAY = 86400, HOUR = 3600;
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const roster = new Set(JSON.parse(read('../characters/roster.json')).map(row => row.key));
const all = shippedPacks().map(({pack}) => pack);
const judy = all.find(pack => pack.id === 'judy-claws-calling');
const T0 = 80 * DAY + 10 * HOUR;

const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: 1, omitted: 0, unstable: false};
const journal = () => parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'},
  coverage: {active: coverage, history: coverage},
  quests: [{id: '100', nativeId: 'sq026_04_hiromi', nativePath: 'quests/side_quest/sq026_04_hiromi', title: 'Quest', state: 'succeeded', lane: 'history', observedAtMs: 1000, objectivesComplete: true, objectives: []}]});
let counter = 0;
/** One turn of V's. `how`: 'own' (typed to her in person, one of V's party copies), 'phone' (a Phone Chat text) or 'holocall'. */
const turn = (how, gameSeconds, text = 'hey') => ({requestId: `s-${++counter}`, profileKey: 'judy-alvarez', name: 'Judy', text, entity: 'e1', turnContext: {gameTime: gameSeconds}, journalHistory: journal(),
  ...(how === 'holocall' ? {holocall: {version: 1, contact: 'judy-alvarez', mode: 'audio'}} : how === 'phone' ? {channel: 'phone'} : {}),
  bonds: {on: true, copy: how === 'own' ? 'party' : null, packs: true, invitations: true}});
const make = (pack = judy, options = {}) => {
  const lines = [], awards = [], files = new Map();
  const runner = new BondPacks({packs: [pack], characters: roster, random: () => 0, log: line => lines.push(line), write: async (file, text) => { files.set(file, text); },
    read: async file => { if (!files.has(file)) throw new Error('none'); return files.get(file); }, path: 'packs.json', effectsPath: 'effects.json', debounceMs: 0,
    bonds: {award: (key, points) => awards.push([key, points]), publish() {}, characters: () => [{profileKey: 'judy-alvarez', level: 7}]}, explain: () => true, ...options});
  runner.on = true;
  return {runner, lines, awards, files};
};
const FAR = {level: 7, romance: 'partner'}, BESIDE = {level: 7, romance: 'partner', near: true};
const talk = (runner, input, facts = FAR) => { const decision = runner.forTurn(input, facts); runner.afterTurn(input, 'ok'); return decision; };
const entryOf = runner => runner.entries.get('judy-claws-calling');
const stageOf = runner => entryOf(runner)?.trail.at(-1);
const play = runner => runner.playState().quests.find(quest => quest.pack === 'judy-claws-calling');
const game = (runner, name, at) => runner.noteEvent({pack: 'judy-claws-calling', serial: entryOf(runner).trail.length, name, at});

// The pack as it was when the owner's test ran: the call opening listed `own` as a start channel.
const original = () => ({...structuredClone(judy), start: {...judy.start, channels: ['own', 'phone']}});

test('the owner\'s case: Judy in V\'s party and beside V, V typing to her in person, the call pack does not start (with the old data and with the new)', () => {
  for (const [pack, label] of [[original(), 'the old data that listed own'], [judy, 'the shipped data']]) {
    const {runner, lines, awards} = make(pack);
    const decision = talk(runner, turn('own', T0, 'hey judy'), BESIDE);
    assert.equal(entryOf(runner), undefined, `${label}: nothing started`);
    assert.equal(decision?.start ?? null, null);
    assert.deepEqual(awards, []);
    assert.equal(lines.some(line => /started on/.test(line)), false, label);
    assert.ok(lines.some(line => /judy-claws-calling waits:/.test(line)), `${label}: the Developer log says why it waits: ${lines.join(' | ')}`);
    assert.deepEqual(runner.playState().quests, [], 'and the play file holds no quest, so nothing moves Judy and no timer runs');
  }
  // Her party copy typed to is still not a start with the old data even when she is not within a few metres.
  const far = make(original());
  talk(far.runner, turn('own', T0), FAR);
  assert.equal(entryOf(far.runner), undefined, 'in person never starts a call opening, near or not');
  // On the phone with her beside V, or in V's party, it waits too.
  const phoneBeside = make();
  talk(phoneBeside.runner, turn('phone', T0), BESIDE);
  assert.equal(entryOf(phoneBeside.runner), undefined, 'a text to the person beside V');
  const input = turn('phone', T0); input.bonds.copy = 'party';
  const phoneParty = make();
  talk(phoneParty.runner, input, FAR);
  assert.equal(entryOf(phoneParty.runner), undefined, 'a text to her in V\'s party');
});

test('the same pack starts on a phone chat or a holocall with her apart from V', () => {
  for (const how of ['phone', 'holocall']) {
    const {runner, lines} = make({...structuredClone(judy), start: {...judy.start, channels: ['phone', 'holocall']}});
    talk(runner, turn(how, T0), FAR);
    assert.equal(entryOf(runner)?.status, 'active', how);
    assert.ok(lines.some(line => /pack=judy-claws-calling started on/.test(line)));
  }
});

test('every shipped pack that opens with a call lists no in-person start, and the rule holds for each of them', () => {
  const calls = all.filter(opensWithCall);
  assert.ok(calls.length >= 19, `the 19 packs found by the live test audit: ${calls.length}`);
  for (const pack of calls) {
    assert.equal(pack.start.channels.includes('own'), false, `${pack.id}: a call opening is not an in-person start`);
    assert.equal(startAllowed(pack, {channel: 'own', near: false, party: false}).ok, false, pack.id);
    assert.equal(startAllowed(pack, {channel: 'phone', near: true}).ok, false, pack.id);
    assert.equal(startAllowed(pack, {channel: 'holocall', party: true}).ok, false, pack.id);
    assert.equal(startAllowed(pack, {channel: 'phone', near: false, party: false}).ok, true, pack.id);
    assert.equal(startAllowed(pack, {channel: 'holocall'}).ok, true, pack.id);
  }
  // Every other pack is unaffected by the call rule.
  for (const pack of all.filter(item => !opensWithCall(item))) assert.equal(startAllowed(pack, {channel: 'own', near: true, party: true}).ok, true, pack.id);
});

test('a pack that casts her at its first place never moves a party member: the game side skips the cast for a party copy, so these packs stay startable with her beside V', () => {
  // The packs the audit found with a first stage that makes her stand at a place.
  const cast = all.filter(castsHerAtStart);
  assert.ok(cast.length >= 40, `the audit found ${cast.length} packs`);
  assert.ok(cast.some(pack => pack.id === 'panam-sunset-coffee') && cast.some(pack => pack.id === 'judy-door-duty'));
  // The protection is in mod/quest-prims.lua (a party member is not placed, quest-prims-lua.test.mjs), so the data needs no change; the call openings are the packs that wait.
  assert.equal(cast.some(pack => opensWithCall(pack) && pack.id !== 'viktor-corner'), false, 'only Viktor\'s corner both casts her and calls, and it is a call opening');
});

test('the timeout clock waits until the call was shown: no timeoutAt in the play file, no timeout however long the game runs', () => {
  const {runner, awards} = make();
  talk(runner, turn('phone', T0), FAR);
  assert.equal(stageOf(runner).unshown, true, 'the phone text is not the call');
  assert.equal(play(runner).timeoutAt, undefined, 'the game is told no timeout yet');
  // Hours of game time pass with no call ever rung (V talks to someone else, drives): the pack does not end, there is no penalty.
  talk(runner, turn('phone', T0 + 5 * HOUR, 'busy'), FAR);
  assert.equal(stageOf(runner).stage, 'call');
  assert.deepEqual(awards, []);
  game(runner, 'stage:timeout', T0 + 9 * HOUR);
  assert.equal(stageOf(runner).stage, 'call', 'even a timeout event from the game does not end a stage that was not shown');
});

test('once the call rang the clock starts from that moment, with the pack\'s 1 hour only a minimum', () => {
  const {runner, lines} = make();
  talk(runner, turn('phone', T0), FAR);
  const rang = T0 + 3 * HOUR;
  assert.equal(game(runner, 'call:claws-ring:ringing', rang), false);
  assert.equal(stageOf(runner).unshown, undefined);
  assert.equal(stageOf(runner).shownAt, rang);
  assert.equal(timeoutHours(judy, judy.stages[0]), START_FLOOR_HOURS);
  assert.equal(play(runner).timeoutAt, rang + START_FLOOR_HOURS * HOUR, 'the game is told the moment, from the ring and not from the start');
  assert.ok(lines.some(line => /pack=judy-claws-calling presented: call:claws-ring:ringing/.test(line)));
  assert.ok(lines.some(line => /\[dev\] pack=judy-claws-calling stage call: the timeout clock started at day \d+ .* \(6 game hours, the pack says 1/.test(line)), lines.filter(line => /dev/.test(line)).join(' | '));
  // 5 hours after the ring V is still on the way: no ending.
  talk(runner, turn('phone', rang + 5 * HOUR, 'on my way'), FAR);
  assert.equal(stageOf(runner).stage, 'call');
});

test('a timeout that costs bond points needs V to have accepted: unaccepted it lapses with no penalty, accepted it is the pack\'s ending', () => {
  // Never accepted: the call rang and V missed it.
  const missed = make();
  talk(missed.runner, turn('phone', T0), FAR);
  game(missed.runner, 'call:claws-ring:ringing', T0 + HOUR);
  game(missed.runner, 'call:claws-ring:missed', T0 + HOUR + 40);
  game(missed.runner, 'call:claws-ring:texted', T0 + HOUR + 41);
  assert.equal(entryOf(missed.runner).accepted, false, 'a missed call is not taking it up');
  const late = T0 + HOUR + 6 * HOUR + 30;
  game(missed.runner, 'stage:timeout', late);
  assert.equal(entryOf(missed.runner), undefined, 'the pack lapsed');
  assert.deepEqual(missed.awards, [], 'no bond change: late-end would have cost 15');
  assert.ok(missed.lines.some(line => /pack=judy-claws-calling lapsed, no bond change \(its time ran out and V had not accepted it/.test(line)));
  assert.deepEqual(missed.runner.playState().quests, [], 'and the game is told the quest is gone');
  assert.deepEqual(missed.runner.playState().journal, [], 'so the journal entry goes too, no failed quest V never saw');
  // It is not offered again the same game day, but is after it.
  talk(missed.runner, turn('phone', late + HOUR), FAR);
  assert.equal(entryOf(missed.runner), undefined, 'not again within a game day');
  talk(missed.runner, turn('phone', late + 25 * HOUR), FAR);
  assert.equal(entryOf(missed.runner)?.status, 'active', 'and offered again a day later');

  // Accepted: V answered the call. The same timeout is now the ending the pack wrote, with its penalty.
  const answered = make();
  talk(answered.runner, turn('phone', T0), FAR);
  game(answered.runner, 'call:claws-ring:ringing', T0 + HOUR);
  game(answered.runner, 'call:claws-ring:answered', T0 + HOUR + 10);
  assert.equal(entryOf(answered.runner).accepted, true);
  game(answered.runner, 'stage:timeout', T0 + HOUR + 6 * HOUR + 30);
  assert.equal(entryOf(answered.runner).status, 'done');
  assert.equal(entryOf(answered.runner).trail.at(-1).stage, 'late-end');
  assert.deepEqual(answered.awards, [['judy-alvarez', -15]]);
  assert.ok(answered.lines.some(line => /pack=judy-claws-calling ended late-end bond -15/.test(line)));

  // Accepted in words: V says yes on a turn after the one that brought it up.
  const yes = make();
  talk(yes.runner, turn('phone', T0), FAR);
  assert.equal(entryOf(yes.runner).accepted, false);
  game(yes.runner, 'call:claws-ring:ringing', T0 + 600);
  const second = turn('phone', T0 + 900, 'yes, I am on my way');
  yes.runner.forTurn(second, FAR); yes.runner.afterTurn(second, 'yes, I am on my way');
  assert.equal(entryOf(yes.runner).accepted, true);
});

test('a call that is never shown lapses after a game day without a penalty', () => {
  const {runner, awards, lines} = make();
  talk(runner, turn('phone', T0), FAR);
  talk(runner, turn('phone', T0 + (UNSEEN_WITHDRAW_HOURS - 1) * HOUR), FAR);
  assert.equal(entryOf(runner)?.status, 'active', 'still waiting for a calm moment');
  talk(runner, turn('phone', T0 + UNSEEN_WITHDRAW_HOURS * HOUR + 60), FAR);
  assert.equal(entryOf(runner), undefined);
  assert.deepEqual(awards, []);
  assert.ok(lines.some(line => /lapsed, no bond change \(its call was never shown in 24 game hours\)/.test(line)));
});

test('a start on a holocall is shown by the call itself: the clock starts at the start', () => {
  const {runner} = make({...structuredClone(judy), start: {...judy.start, channels: ['phone', 'holocall']}});
  talk(runner, turn('holocall', T0), FAR);
  assert.equal(stageOf(runner).unshown, undefined);
  assert.equal(presentedAtStart(judy, judy.stages[0], 'holocall'), true);
  assert.equal(presentedAtStart(judy, judy.stages[0], 'phone'), false);
  assert.equal(play(runner).timeoutAt, T0 + START_FLOOR_HOURS * HOUR);
});

test('the clock state survives a restart of the bridge, and a load of an earlier save rewinds to the stage the clock had it at', async () => {
  const {runner, files} = make();
  talk(runner, turn('phone', T0), FAR);
  await runner.flush();
  const shared = {read: async file => files.get(file), write: async (file, text) => { files.set(file, text); }};
  const again = make(judy, shared).runner;
  await again.load();
  assert.equal(again.entries.get('judy-claws-calling').trail.at(-1).unshown, true, 'still waiting for its call');
  game(again, 'call:claws-ring:ringing', T0 + 600);
  await again.flush();
  const third = make(judy, shared).runner;
  await third.load();
  assert.equal(third.entries.get('judy-claws-calling').trail.at(-1).shownAt, T0 + 600);
  assert.equal(third.playState().quests[0].timeoutAt, T0 + 600 + START_FLOOR_HOURS * HOUR);
  third.rewind(T0 - ROLLBACK_SLACK - 1000);
  assert.equal(third.entries.get('judy-claws-calling'), undefined, 'a load before the start forgets the pack');
});

test('every shipped pack: a first stage and a travel stage run at least the floor, any other stage keeps its own hours, and the audit finds the packs it changes', () => {
  let raised = 0;
  for (const pack of all) {
    for (const stage of pack.stages) {
      if (!stage.timeout) continue;
      const hours = timeoutHours(pack, stage);
      assert.ok(hours >= stage.timeout.gameHours, `${pack.id}/${stage.id}: the pack's value is a minimum`);
      if (pack.stages[0] === stage || travelStage(stage)) assert.ok(hours >= START_FLOOR_HOURS, `${pack.id}/${stage.id}`);
      else assert.equal(hours, stage.timeout.gameHours, `${pack.id}/${stage.id}: a fight or a scene beat keeps its hours`);
      if (hours > stage.timeout.gameHours) raised += 1;
    }
  }
  assert.ok(raised > 100, `${raised} stage timeouts are raised`);
  // The packs whose first stage ends with a penalty are the ones the unaccepted rule protects.
  const guarded = all.filter(pack => penalty(pack, pack.stages[0].timeout?.next));
  assert.ok(guarded.length >= 10, `${guarded.length} packs have a first stage whose timeout costs bond points`);
});

test('every line a pack says exists in the pack: rows, call steps, call texts and endings', () => {
  for (const pack of all) {
    const used = new Set();
    const add = refs => { for (const id of refs.lines) used.add(id); };
    for (const stage of pack.stages) add(referencesOf(stage.script ?? []));
    for (const ending of Object.values(pack.endings)) add(referencesOf(ending.script ?? []));
    for (const call of Object.values(pack.calls ?? {})) { for (const step of call.steps) if (typeof step.say === 'string') used.add(step.say); if (call.text) used.add(call.text); }
    for (const id of used) assert.ok(pack.lines?.[id], `${pack.id}: line ${id} is used but not defined`);
  }
});

test('the live case end to end: the typed talk with Judy starts nothing and costs nothing, and nothing in the play file could move her', () => {
  const {runner, awards} = make(original());
  for (let step = 0; step < 6; step++) talk(runner, turn('own', T0 + step * 600, 'tell me about the workshop'), BESIDE);
  talk(runner, turn('own', T0 + 9 * HOUR, 'still here'), BESIDE);
  assert.equal(entryOf(runner), undefined);
  assert.deepEqual(awards, [], 'she is not hurt for a quest V never saw');
  const body = JSON.stringify(runner.playState());
  assert.equal(/"p":"(cast|place|post)"/.test(body), false, 'nothing is armed that could place her');
});

test('a started pack is in the journal block of the play file at once, with its objective and its map position, even while its call has not rung', () => {
  const {runner} = make();
  assert.deepEqual(runner.playState().journal, [], 'nothing before the start');
  talk(runner, turn('phone', T0), FAR);
  const [row] = runner.playState().journal;
  assert.equal(row.pack, 'judy-claws-calling');
  assert.equal(row.state, 'active');
  assert.equal(row.title, 'The Claws Come Calling');
  assert.equal(row.objective, 'Answer Judy\'s call about the Tyger Claws at Lizzie\'s Bar');
  assert.equal(row.since, T0);
  assert.equal(row.place.id, 'front');
  assert.ok(Number.isFinite(row.place.x) && Number.isFinite(row.place.y) && Number.isFinite(row.place.z), 'Lizzie\'s street has a position, so the pin is made');
  assert.equal(runner.playState().quests[0].timeoutAt, undefined, 'and still no clock');
});
