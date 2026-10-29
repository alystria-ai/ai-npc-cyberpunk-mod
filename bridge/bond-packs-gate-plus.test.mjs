// Round 2 of the pack format (docs/QUEST_PRIMITIVES.md 10.8 and 10.9; bridge/bond-packs.mjs): kind and hangout, gate-plus (facts, before, notBegun, window, unfinishedWhen),
// community packs (no garage, a gift allowlist) and the arcs of Songbird, Jackie and Takemura. Offline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validatePack, packGate, shippedPacks, PACK_KINDS, HANGOUT_LIMITS, trackedPathOf, blockingQuest, journalGate, checkRequires} from './bond-packs.mjs';
import {shippedBondArcs, questStates} from './bonds.mjs';
import {parseJournalHistory} from './journal-history.mjs';
import {panamHangout} from './bond-pack-fixtures.mjs';

const roster = new Set(JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8')).map(row => row.key));
const byId = Object.fromEntries(shippedPacks().map(({pack}) => [pack.id, pack]));
const clone = value => JSON.parse(JSON.stringify(value));

function journal(rows, tracked = {status: 'untracked'}) {
  const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: rows.length, omitted: 0, unstable: false};
  return parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, tracked, coverage: {active: coverage, history: coverage},
    quests: rows.map(([path, state], index) => ({id: String(100 + index), nativeId: path.slice(path.lastIndexOf('/') + 1), nativePath: path, title: 'Quest ' + index,
      state, lane: state === 'active' ? 'active' : 'history', observedAtMs: 1000, objectivesComplete: state !== 'active', objectives: []}))});
}

const problems = (pack, options = {}) => validatePack(pack, {characters: roster, ...options}).errors;
const open = {level: 6, channel: 'own', settings: {eddies: true, invitations: true}};
const PANAM_STORY = [['quests/side_quest/sq027_02_raffen_shiv_attack', 'succeeded'], ['quests/side_quest/sq027_01_basilisk_convoy', 'succeeded']];

test('kind and hangout: a one-stage format 2 pack with its own block, 1 to 3 variations, place swaps between its own places', () => {
  assert.deepEqual([...PACK_KINDS], ['quest', 'hangout']);
  assert.deepEqual(problems(panamHangout()), []);
  const bad = (change, pattern) => { const pack = clone(panamHangout()); change(pack); assert(problems(pack).some(error => pattern.test(error)), `${pattern}: ${problems(pack).join(' | ')}`); };
  bad(pack => { pack.kind = 'raid'; }, /kind must be one of quest, hangout/);
  bad(pack => { delete pack.hangout; }, /needs a hangout block/);
  bad(pack => { pack.kind = 'quest'; }, /hangout needs kind "hangout"/);
  bad(pack => { pack.format = 1; }, /a hangout needs format 2/);
  bad(pack => { pack.hangout.variations = []; }, /variations must be a list of 1 to 3/);
  bad(pack => { pack.hangout.variations.push({id: 'fourth'}); }, /variations must be a list of 1 to 3/);
  bad(pack => { pack.hangout.variations[1].id = 'first'; }, /every variation needs its own id/);
  bad(pack => { pack.hangout.variations[1].places = {spot: 'nowhere'}; }, /must both be places of the pack/);
  bad(pack => { pack.hangout.variations[0].know = 'a; b'; }, /semicolon/);
  bad(pack => { pack.hangout.variations[0].secret = 'x'; }, /no field "secret"/);
  bad(pack => { pack.hangout.repeatDays = 0; }, /hangout\.repeatDays must be a whole number from 1 to 30/);
  bad(pack => { pack.hangout.capPerDay = 500; }, /hangout\.capPerDay/);
  bad(pack => { pack.hangout.stoodUp = 5; }, /hangout\.stoodUp must be a whole number from -50 to 0/);
  bad(pack => { pack.hangout.repeats = 2; }, /hangout has no field "repeats"/);
  bad(pack => { pack.stages.push({id: 'extra', know: 'x', next: 'fun'}); pack.stages[0].choices[0].next = 'extra'; }, /a hangout is a one-stage pack/);
  assert.equal(HANGOUT_LIMITS.variations, 3);
  assert.equal(problems(byId['panam-sunset-coffee']).length, 0, 'a quest has no hangout block and defaults to kind quest');
});

test('gate-plus fields: facts, before, notBegun, window and the pack\'s unfinishedWhen are checked', () => {
  const bad = (change, pattern) => { const pack = clone(panamHangout()); change(pack); assert(problems(pack).some(error => pattern.test(error)), `${pattern}: ${problems(pack).join(' | ')}`); };
  const good = change => { const pack = clone(panamHangout()); change(pack); assert.deepEqual(problems(pack), []); };
  good(pack => { pack.requires.facts = {'takemura-alive': true}; });
  good(pack => { pack.requires.facts = {'pisces-outcome': ['spared', 'killed']}; });
  good(pack => { pack.requires.before = ['quests/main_quest/prologue/q005_heist']; pack.requires.notBegun = ['ep1/quests/main_quest/q306_reed_epilogue']; });
  good(pack => { pack.requires.window = {allowActive: ['quests/main_quest/prologue/q003', 'quests/main_quest/prologue/q004'], untracked: true}; });
  good(pack => { pack.unfinishedWhen = {finished: 'quests/main_quest/prologue/q005_heist', ending: 'late'}; });
  bad(pack => { pack.requires.facts = {'takemura-alive': 'yes'}; }, /requires\.facts: takemura-alive must be true or false/);
  bad(pack => { pack.requires.facts = {'mystery-fact': true}; }, /not a known fact/);
  bad(pack => { pack.requires.facts = {}; }, /requires\.facts must be an object of 1 to 4 facts/);
  bad(pack => { pack.requires.before = ['not a path']; }, /requires\.before must be a list/);
  bad(pack => { pack.requires.notBegun = 'quests/side_quest/sq004'; }, /requires\.notBegun must be a list/);
  bad(pack => { pack.requires.window = {allowActive: [], untracked: true}; }, /allowActive must list some/);
  bad(pack => { pack.requires.window = {allowActive: ['quests/main_quest/prologue/q003']}; }, /untracked must be true/);
  bad(pack => { pack.requires.window = {allowActive: ['quests/main_quest/prologue/q003'], untracked: true, scene: false}; }, /may only have allowActive and untracked/);
  bad(pack => { pack.unfinishedWhen = {finished: 'quests/main_quest/prologue/q005_heist', ending: 'nowhere'}; }, /unfinishedWhen\.ending must be one of the pack's endings/);
  bad(pack => { pack.unfinishedWhen = {ending: 'late'}; }, /unfinishedWhen needs finished/);
  bad(pack => { pack.unfinishedWhen = {finished: 'x', ending: 'late'}; }, /unfinishedWhen needs finished/);
  const found = []; checkRequires({questsFinished: ['quests/side_quest/sq004_riders_on_the_storm'], bond: 11}, message => found.push(message));
  assert.deepEqual(found, ['requires.bond must be a level from 1 to 10'], 'the generic part is shared with the reach-outs');
});

test('a community pack may not use garage, and its gifts may name only the allowlist; a shipped pack may name any Items.* record', () => {
  const withDo = list => { const pack = clone(panamHangout()); pack.stages[0].do = [{p: 'place', at: 'spot'}, ...list]; return pack; };
  const garage = withDo([{p: 'garage', id: 'car', vehicle: 'Vehicle.v_sport2_quadra_turbo_r'}]);
  assert.deepEqual(problems(garage), [], 'the mod\'s own pack may');
  assert(problems(garage, {community: true}).some(error => /garage is only for the packs shipped with the mod/.test(error)));
  const gift = withDo([{p: 'gift', id: 'present', dir: 'receive', item: 'Items.Totally_Custom_Thing', second: 'Items.Nomad_01_Set_TShirt'}]);
  assert.deepEqual(problems(gift), []);
  assert(problems(gift, {community: true}).some(error => /gift\.item "Items\.Totally_Custom_Thing" is not on the gift allowlist/.test(error)));
  assert(!problems(gift, {community: true}).some(error => /gift\.second/.test(error)), 'the allowlisted second is fine');
  assert.deepEqual(problems(withDo([{p: 'gift', id: 'present', dir: 'receive', tier: 'rare'}]), {community: true}), [], 'a tier gift names no item');
  assert.deepEqual(problems(gift, {community: true, giftAllowed: () => true}), [], 'the check is injectable');
  assert(problems(withDo([{p: 'gift', id: 'present', dir: 'receive', item: 'Weapons.Nope'}])).some(error => /must be an Items\.\* record/.test(error)));
});

test('the gate with facts: a fact the game has not reported is a no', () => {
  const pack = clone(byId['panam-truck-ransom']);
  pack.requires.facts = {'takemura-alive': true};
  const story = journal(PANAM_STORY);
  assert.equal(packGate(pack, {...open, journalHistory: story}).why, 'fact');
  assert.equal(packGate(pack, {...open, journalHistory: story, facts: {}}).why, 'fact');
  assert.equal(packGate(pack, {...open, journalHistory: story, facts: {'takemura-alive': false}}).why, 'fact');
  assert.deepEqual(packGate(pack, {...open, journalHistory: story, facts: {'takemura-alive': true}}), {open: true});
});

test('the gate with before and notBegun: Jackie before The Heist, Songbird on the freed branch', () => {
  const jackie = clone(byId['panam-truck-ransom']);
  jackie.character = 'jackie-welles';
  jackie.requires = {questsFinished: ['quests/main_quest/prologue/q001_01_victor'], before: ['quests/main_quest/prologue/q005_heist']};
  const victor = ['quests/main_quest/prologue/q001_01_victor', 'succeeded'];
  const gate = rows => packGate(jackie, {...open, settings: {}, journalHistory: journal(rows)}).why ?? 'open';
  assert.equal(gate([victor]), 'open');
  assert.equal(gate([victor, ['quests/main_quest/prologue/q005_heist', 'succeeded']]), 'before');
  assert.equal(gate([victor, ['quests/main_quest/prologue/q005_heist', 'failed']]), 'before');
  assert.equal(gate([victor, ['quests/main_quest/prologue/q005_heist', 'active']]), 'quest-active', 'active, not finished: the arc line blocks');
  const songbird = clone(jackie);
  songbird.character = 'songbird';
  songbird.requires = {questsFinished: ['ep1/quests/main_quest/q306_somi_epilogue', 'ep1/quests/main_quest/q306_postcontent'], notBegun: ['ep1/quests/main_quest/q306_reed_epilogue']};
  const done = [['ep1/quests/main_quest/q306_somi_epilogue', 'succeeded'], ['ep1/quests/main_quest/q306_postcontent', 'succeeded']];
  const sgate = rows => packGate(songbird, {...open, settings: {}, journalHistory: journal(rows)}).why ?? 'open';
  assert.equal(sgate(done), 'open');
  assert.equal(sgate([...done, ['ep1/quests/main_quest/q306_reed_epilogue', 'succeeded']]), 'begun');
  assert.equal(sgate([...done, ['ep1/quests/main_quest/q306_reed_epilogue', 'active']]), 'begun');
  assert.equal(sgate(done.slice(1)), 'quest-not-finished');
});

test('the window: a quest of the allowed lines may be active when V does not track it', () => {
  const jackie = clone(byId['panam-truck-ransom']);
  jackie.character = 'jackie-welles';
  jackie.requires = {questsFinished: ['quests/main_quest/prologue/q001_01_victor'], before: ['quests/main_quest/prologue/q005_heist'],
    window: {allowActive: ['quests/main_quest/prologue/q003', 'quests/main_quest/prologue/q004'], untracked: true}};
  const base = [['quests/main_quest/prologue/q001_01_victor', 'succeeded']];
  const q3 = ['quests/main_quest/prologue/q003_maelstrom', 'active'];
  const gate = (rows, extra = {}, tracked = {status: 'untracked'}) => packGate(jackie, {...open, settings: {}, journalHistory: journal(rows, tracked), ...extra}).why ?? 'open';
  assert.equal(gate([...base, q3]), 'open', 'active and not tracked');
  assert.equal(gate([...base, q3], {}, {status: 'known', questId: '101'}), 'quest-active', 'tracked');
  assert.equal(gate([...base, q3], {}, {status: 'unknown'}), 'quest-active', 'tracking unknown is a no');
  assert.equal(gate([...base, q3], {tracked: null}, {status: 'unknown'}), 'open', 'the caller may say nothing is tracked');
  assert.equal(gate([...base, q3], {tracked: 'quests/main_quest/prologue/q003_maelstrom'}), 'quest-active');
  assert.equal(gate([...base, ['quests/main_quest/prologue/q005_heist', 'active']]), 'quest-active', 'q005 is not in the window');
  assert.equal(gate([...base, ['quests/main_quest/prologue/q001_intro', 'active']]), 'quest-active', 'a quest outside the window still blocks');
  const history = journal([...base, q3], {status: 'known', questId: '101'});
  assert.equal(trackedPathOf(history), 'quests/main_quest/prologue/q003_maelstrom');
  assert.equal(trackedPathOf(journal(base)), null);
  assert.equal(trackedPathOf(journal(base, {status: 'known', questId: '999'})), undefined);
  assert.equal(blockingQuest(jackie, questStates(history), {tracked: undefined}), 'quests/main_quest/prologue/q003_maelstrom');
  assert.equal(journalGate(jackie, {journalHistory: journal([...base, q3])}).open, true);
});

test('the Songbird arc is in bond-arcs: three Phantom Liberty quests worth 350, the Phantom Liberty lines as its active prefix; Jackie and Takemura have theirs', () => {
  const arcs = shippedBondArcs().arcs;
  assert.deepEqual(Object.keys(arcs.songbird.quests), ['ep1/quests/main_quest/q306_devils_bargain', 'ep1/quests/main_quest/q306_somi_epilogue', 'ep1/quests/main_quest/q306_postcontent']);
  assert.equal(Object.values(arcs.songbird.quests).reduce((a, b) => a + b, 0), 350);
  assert.deepEqual(arcs.songbird.active, ['ep1/quests/main_quest/q30']);
  assert.equal(Object.values(arcs['jackie-welles'].quests).reduce((a, b) => a + b, 0), 350);
  assert(Object.hasOwn(arcs['jackie-welles'].quests, 'quests/main_quest/prologue/q005_heist'));
  assert.equal(Object.values(arcs.takemura.quests).reduce((a, b) => a + b, 0), 350);
  assert(Object.hasOwn(arcs.takemura.quests, 'quests/main_quest/act_01/q113_rescuing_hanako'));
  const pack = clone(panamHangout()); pack.character = 'songbird'; pack.requires = {};
  assert(problems(pack).some(error => /requires\.questsFinished must name at least one of songbird's quests/.test(error)));
});
