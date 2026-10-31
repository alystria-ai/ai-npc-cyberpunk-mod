// Fair story pack starts (bridge/quest-start.mjs, bridge/bond-pack-runner.mjs). The regression case is the owner's live test of 31 Oct 2026: Judy Alvarez, invited, in V's party,
// following V, romance partner, bond level 7. While V typed to her in person, judy-claws-calling started on `own`, its first stage is a call-in (rings only at a calm moment, so it
// never rang while V talked), the stage clock of 1 game hour ran from the start, and about 8 real minutes later the pack ended `late-end` with bond -15 for a quest V never saw.
// Rules pinned here, for every shipped pack:
//   1. a pack that opens with a call does not start in person, nor with her beside V or in V's party, and is a phone or holocall pack in its data;
//   2. a started pack is seen: the journal row is made at the start (the game side adds the tracker, the pin and the on-screen notice, see quest-journal-lua.test.mjs);
//   3. no time limit at all (owner decision 1 Nov 2026): no stage times out, no clock runs, no penalty for time, and a quest stays open until V does it or abandons it;
//   4. every line a pack's rows, calls and endings say exists in the pack (the prepared audio list is scripts/Check-QuestLineAudio.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BondPacks, ROLLBACK_SLACK} from './bond-pack-runner.mjs';
import {shippedPacks} from './bond-packs.mjs';
import {referencesOf} from './quest-format.mjs';
import {startAllowed, opensWithCall, castsHerAtStart, WITHDRAWN_DAYS} from './quest-start.mjs';
import {validatePack} from './bond-packs.mjs';
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
const journal2 = () => parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'},
  coverage: {active: coverage, history: coverage},
  quests: ['sq026_04_hiromi', 'sq030_judy_romance'].map((id, index) => ({id: String(200 + index), nativeId: id, nativePath: `quests/side_quest/${id}`, title: 'Quest', state: 'succeeded', lane: 'history', observedAtMs: 1000, objectivesComplete: true, objectives: []}))});
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

test('no time limit: a call opening started on a phone chat stays open for days and weeks, with no clock, no penalty and no timeout in the play file', () => {
  const {runner, awards} = make();
  talk(runner, turn('phone', T0), FAR);
  assert.equal(stageOf(runner).stage, 'call');
  assert.equal(play(runner).timeoutAt, undefined, 'the game is told no timeout');
  for (const days of [0.2, 2, 30]) {
    talk(runner, turn('phone', T0 + days * DAY, 'busy'), FAR);
    assert.equal(stageOf(runner).stage, 'call', `still waiting after ${days} game days`);
    assert.equal(entryOf(runner).status, 'active');
  }
  assert.deepEqual(awards, [], 'no penalty for time');
  game(runner, 'stage:timeout', T0 + 40 * DAY);
  assert.equal(stageOf(runner).stage, 'call', 'even a stray timeout event from the game ends nothing');
  const {runner: holocall} = make({...structuredClone(judy), start: {...judy.start, channels: ['phone', 'holocall']}});
  talk(holocall, turn('holocall', T0), FAR);
  assert.equal(play(holocall).timeoutAt, undefined, 'a holocall start has no clock either');
});

test('no pack, shipped or old, carries a time limit: no stage timeout, no meeting deadline, no ride, race or convoy limit, and every stage still has a way out', () => {
  for (const pack of all) {
    assert.deepEqual(validatePack(pack, {characters: roster}).errors, [], pack.id);
    for (const stage of pack.stages) {
      assert.equal(stage.timeout, undefined, `${pack.id}/${stage.id}: no timeout`);
      assert.equal(stage.meet?.inGameHours, undefined, `${pack.id}/${stage.id}: no meeting deadline`);
      assert.ok((stage.choices?.length ?? 0) > 0 || typeof stage.next === 'string', `${pack.id}/${stage.id}: a way out that is not a timer`);
      for (const spec of stage.do ?? []) assert.equal(spec.limitMinutes, undefined, `${pack.id}/${stage.id}: no ${spec.p} time limit`);
      for (const choice of stage.choices ?? []) assert.doesNotMatch(choice.on, /^event:(ride:timeout|race:[a-z0-9-]+:timeout)$/, `${pack.id}/${stage.id}: ${choice.id}`);
      assert.doesNotMatch(JSON.stringify(stage.choices ?? []), /meet:stood-up/, `${pack.id}/${stage.id}: a meeting she waited for in vain ends nothing`);
    }
  }
  // An old pack that still has them is read, warned about and its timeout is not a way out.
  const old = structuredClone(judy);
  old.stages[0].timeout = {gameHours: 1, next: 'wrecked'};
  const result = validatePack(old, {characters: roster});
  assert.ok(result.warnings.some(text => /timeout is ignored/.test(text)), result.warnings.join(' | '));
  const stuck = structuredClone(judy);
  delete stuck.stages[0].choices; delete stuck.stages[0].next; stuck.stages[0].timeout = {gameHours: 1, next: 'wrecked'};
  assert.ok(validatePack(stuck, {characters: roster}).errors.some(text => /must lead somewhere/.test(text)), 'a timeout alone leaves a stage with no way out');
});

test('V closes a quest by telling the character it is off: no bond change, the journal row goes, and it is not offered again for a game day', async () => {
  const {runner, awards, files} = make({...structuredClone(judy), start: {...judy.start, channels: ['phone', 'holocall']}});
  talk(runner, turn('phone', T0), FAR);
  assert.equal(entryOf(runner)?.status, 'active');
  assert.equal(runner.playState().journal.length, 1);
  const first = turn('phone', T0 + HOUR, 'forget it, I am not doing this');
  runner.forTurn(first, FAR); runner.afterTurn(first, 'forget it, I am not doing this');
  assert.equal(entryOf(runner), undefined, 'abandoned: the quest is gone');
  assert.deepEqual(awards, [], 'no bond change');
  assert.deepEqual(runner.playState().journal, [], 'and its journal entry, tracker line and pin go with the next play file');
  assert.deepEqual(runner.playState().quests, []);
  // Not offered again inside a game day, offered again after it.
  talk(runner, turn('phone', T0 + 2 * HOUR), FAR);
  assert.equal(entryOf(runner), undefined, 'a game day of quiet first');
  talk(runner, turn('phone', T0 + 3 * HOUR), FAR);
  talk(runner, turn('phone', T0 + WITHDRAWN_DAYS * DAY + 2 * HOUR), FAR);
  talk(runner, turn('phone', T0 + WITHDRAWN_DAYS * DAY + 3 * HOUR), FAR);
  assert.equal(entryOf(runner)?.status, 'active', 'it can start again after the day');
  // The abandon survives a restart of the bridge.
  await runner.flush();
  assert.ok([...files.values()].some(text => /withdrawn/.test(text)), 'the quiet day is saved');
});

test('abandoned from the game (the journal or the probe): the event closes it with no bond change, a stale or unknown one does nothing', () => {
  const {runner, awards} = make({...structuredClone(judy), start: {...judy.start, channels: ['phone', 'holocall']}});
  talk(runner, turn('phone', T0), FAR);
  assert.equal(runner.noteEvent({pack: 'judy-claws-calling', serial: 99, name: 'quest:abandon', at: T0 + 60}), false, 'an event for another stage is dropped');
  assert.equal(entryOf(runner)?.status, 'active');
  assert.equal(runner.noteEvent({pack: 'no-such-pack', serial: 1, name: 'quest:abandon', at: T0 + 60}), false);
  assert.equal(runner.noteEvent({pack: 'judy-claws-calling', serial: 1, name: 'quest:abandon', at: T0 + 120}), true);
  assert.equal(entryOf(runner), undefined);
  assert.deepEqual(awards, []);
  assert.equal(runner.abandon('judy-claws-calling'), false, 'nothing open any more');
});

test('a stage\'s own no answer is read before the generic abandon: "forget it" on a yes or no stage takes the stage\'s no', () => {
  const dress = all.find(pack => pack.id === 'judy-dinner-dress');
  const {runner, awards} = make(dress);
  const start = turn('phone', T0); start.journalHistory = journal2(); runner.forTurn(start, FAR); runner.afterTurn(start, 'hi');
  const entry = runner.entries.get('judy-dinner-dress');
  assert.equal(entry?.status, 'active');
  const no = turn('phone', T0 + 60, 'forget it'); no.journalHistory = journal2(); runner.forTurn(no, FAR); runner.afterTurn(no, 'forget it');
  assert.equal(entry.trail.at(-1).choice, 'cant', 'the stage\'s no choice took it, not the generic abandon');
  assert.ok(runner.entries.get('judy-dinner-dress'), 'the quest closes through its own ending');
  void awards;
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
