// Round 2 in the pack runner (docs/QUEST_PRIMITIVES.md section 10): hangouts, offers, unfinishedWhen, facts, memory share, reach-outs, gifts, paying a cast member, calls, music and
// sound effects in the play file, state that survives a restart. The game is simulated by hand. Offline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BondPacks, REACH_NOTE_TURNS} from './bond-pack-runner.mjs';
import {QuestLink, cleanData} from './quest-link.mjs';
import {createQuestPoller} from './quest-poller.mjs';
import {ReachOuts} from './reach-outs.mjs';
import {shippedPacks, validatePack} from './bond-packs.mjs';
import {parseJournalHistory} from './journal-history.mjs';
import {resolveGive, likesFor} from './gift-tables.mjs';
import {panamHangout} from './bond-pack-fixtures.mjs';

const DAY = 86400, HOUR = 3600;
const roster = new Set(JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8')).map(row => row.key));
const shipped = Object.fromEntries(shippedPacks().map(({pack}) => [pack.id, pack]));
const clone = value => JSON.parse(JSON.stringify(value));

function journal(rows, tracked = {status: 'untracked'}) {
  const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: rows.length, omitted: 0, unstable: false};
  return parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked, coverage: {active: coverage, history: coverage},
    quests: rows.map(([path, state], index) => ({id: String(100 + index), nativeId: path.slice(path.lastIndexOf('/') + 1), nativePath: path, title: 'Quest ' + index,
      state, lane: state === 'active' ? 'active' : 'history', observedAtMs: 1000, objectivesComplete: state !== 'active', objectives: []}))});
}
const SQ004 = [['quests/side_quest/sq004_riders_on_the_storm', 'succeeded']];
const T0 = 60 * DAY;
let counter = 0;
const turn = (profile, at, extra = {}, bondsBlock = {}) => ({requestId: `r-${++counter}`, profileKey: profile, name: profile, text: 'hey', entity: 'e1', turnContext: {gameTime: at},
  journalHistory: journal(SQ004), bonds: {on: true, copy: 'party', packs: true, invitations: true, reach: true, ...bondsBlock}, ...extra});

function make(packs, options = {}) {
  const log = [], awards = [], written = [];
  const bonds = {award: (key, points) => awards.push([key, points]), publish() {}, characters: () => options.levels ?? [{profileKey: 'panam-palmer', level: 6}]};
  const runner = new BondPacks({packs, characters: roster, random: () => 0, log: line => log.push(line), bonds, debounceMs: 0, path: 'packs.json', reach: null,
    write: async (file, text) => { written.push([file, text]); }, exists: () => false, ...options.runner});
  const say = (profile, at, extra, block, facts = {level: 6}) => {
    const input = turn(profile, at, extra, block);
    const decision = runner.forTurn(input, facts);
    return {input, decision, finish: (words = 'hello') => runner.afterTurn(input, words)};
  };
  return {runner, log, awards, written, say};
}

// ---- hangouts ---------------------------------------------------------------------------------------------------------------------------

test('a hangout starts on a talk with the first variation, is met, pays its bond and is startable again after three game days with the next variation', () => {
  const pack = panamHangout();
  pack.stages[0].choices.push({id: 'there', on: 'event:place:spot:arrived', next: 'fun'});
  const {runner, awards, say} = make([pack]);
  const first = say('panam-palmer', T0);
  assert.match(first.decision.note, /You ask V if V wants to do something/);
  assert.match(first.decision.note, /You are out with V\. It is dawn\./, 'the variation\'s know is added to the stage note');
  assert.equal(runner.entries.size, 0, 'nothing starts until the reply is out');
  first.finish();
  assert.equal(runner.entries.get('test-hangout').variation, 'first');
  assert.equal(runner.noteMeeting('panam-palmer', 'met', T0 + 600), 'met');
  assert.deepEqual(awards, [['panam-palmer', 12]]);
  assert.equal(runner.entries.get('test-hangout').status, 'done');
  // Not again the same game day, nor before three game days have passed.
  assert.equal(say('panam-palmer', T0 + 3600).decision.start, null);
  assert.equal(say('panam-palmer', T0 + 2 * DAY).decision.start, null);
  assert.equal(say('panam-palmer', T0 + 3 * DAY + 599).decision.start, null);
  // Three days later: the second variation, with its place swap in the play file.
  const second = say('panam-palmer', T0 + 3 * DAY + 601);
  assert.match(second.decision.note, /A story\./); assert.doesNotMatch(second.decision.note, /It is dawn/);
  second.finish();
  assert.equal(runner.entries.get('test-hangout').variation, 'second'); assert.equal(runner.entries.get('test-hangout').status, 'active');
  const quest = runner.playState().quests[0];
  assert.equal(quest.do[0].at, 'other'); assert.deepEqual(Object.keys(quest.places), ['other']);
  assert.deepEqual(quest.script.map(row => row.when), ['place:other:arrived']);
  // The game reports the swapped place; the stage waiting on the original id moves.
  assert.equal(runner.noteEvent({pack: 'test-hangout', serial: 1, name: 'place:other:arrived', at: T0 + 3 * DAY + 700}), true);
  assert.equal(runner.entries.get('test-hangout').status, 'done');
  // And the third, then the first again (never the same twice in a row).
  const variations = [];
  for (let n = 1; n <= 3; n++) {
    const next = say('panam-palmer', T0 + (3 + 4 * n) * DAY);
    next.finish();
    variations.push(runner.entries.get('test-hangout').variation);
    runner.noteMeeting('panam-palmer', 'met', T0 + (3 + 4 * n) * DAY + 5);
  }
  assert.deepEqual(variations, ['third', 'first', 'second']);
});

test('a hangout\'s bond counts into 20 points per character per game day; being stood up costs its own value, uncapped; a hangout does not start the quiet days of a story pack', () => {
  const a = panamHangout(), b = panamHangout();
  b.id = 'test-hangout-b'; b.hangout.variations = [{id: 'only'}];
  a.endings.fun.bond = 12; b.endings.fun.bond = 12;
  const {runner, awards, say} = make([a, b]);
  // A starts late on day 0 and ends early on day 1 (12 points on day 1). B starts and ends on day 1: 12 more is 24, so B pays the 8 that are left.
  say('panam-palmer', T0 + 23 * HOUR).finish();
  const day1 = T0 + DAY;
  runner.noteMeeting('panam-palmer', 'met', day1 + 100);
  assert.deepEqual(awards, [['panam-palmer', 12]]);
  say('panam-palmer', day1 + 200).finish();
  assert.equal(runner.entries.get('test-hangout-b').status, 'active');
  runner.noteMeeting('panam-palmer', 'met', day1 + 300);
  assert.deepEqual(awards, [['panam-palmer', 12], ['panam-palmer', 8]]);
  assert.equal(runner.meta.get('panam-palmer').endedAt, null, 'no quiet days after a hangout');
  // Stood up: the hangout block\'s value (the ending names none), not capped.
  say('panam-palmer', T0 + 9 * DAY).finish();
  runner.noteMeeting('panam-palmer', 'stood-up', T0 + 9 * DAY + 60);
  assert.deepEqual(awards.at(-1), ['panam-palmer', -10]);
  // An ending that names its own value keeps it.
  const own = panamHangout(); own.endings.late.bond = -3;
  const second = make([own]);
  second.say('panam-palmer', T0).finish(); second.runner.noteMeeting('panam-palmer', 'stood-up', T0 + 60);
  assert.deepEqual(second.awards, [['panam-palmer', -3]]);
});

test('an ending above the day\'s cap pays the cap', () => {
  const pack = panamHangout(); pack.endings.fun.bond = 60;
  const {runner, awards, say} = make([pack]);
  say('panam-palmer', T0).finish(); runner.noteMeeting('panam-palmer', 'met', T0 + 60);
  assert.deepEqual(awards, [['panam-palmer', 20]]);
});

test('a hangout never starts while a story pack of the character is open', () => {
  const pilot = shipped['panam-sunset-coffee'];
  const rows = [...SQ004, ['quests/main_quest/act_01/q104_02_av_chase', 'succeeded']];
  const {runner, say} = make([pilot, panamHangout()]);
  const story = say('panam-palmer', T0, {journalHistory: journal(rows)}, {}, {level: 6});
  assert.equal(story.decision.start.pack.id, 'panam-sunset-coffee', 'the story pack comes first');
  story.finish();
  const later = say('panam-palmer', T0 + 2 * DAY, {journalHistory: journal(rows)});
  assert.equal(later.decision.start, null); later.finish();
  assert.equal(runner.entries.has('test-hangout'), false);
});

test('an offer from a reach-out starts the pack on the next talk without the dice, expires after a game day, and still needs the gate', () => {
  const pack = panamHangout(); pack.start.chance = 0.1;
  const dice = {value: 0.9};
  const {runner, say} = make([pack], {runner: {random: () => dice.value}});
  assert.equal(say('panam-palmer', T0).decision.start, null, 'the dice said no');
  assert.equal(runner.offer('nope', T0), false); assert.equal(runner.offer('test-hangout', undefined), false);
  assert.equal(runner.offer('test-hangout', T0 + 100), true);
  // The same game day the dice were thrown, with the dice against it: the offer starts it.
  const offered = say('panam-palmer', T0 + 200);
  assert.equal(offered.decision.start.pack.id, 'test-hangout'); assert.equal(offered.decision.start.offered, true);
  offered.finish();
  assert.equal(runner.meta.get('panam-palmer').offer, null, 'used');
  // An expired offer starts nothing (the dice are still against it).
  const second = make([pack], {runner: {random: () => dice.value}});
  second.runner.offer('test-hangout', T0);
  assert.equal(second.say('panam-palmer', T0 + 25 * HOUR).decision.start, null);
  assert.equal(second.runner.meta.get('panam-palmer').offer, null, 'dropped');
  // The gate still applies: her story is not finished.
  const gated = make([pack], {runner: {random: () => dice.value}});
  gated.runner.offer('test-hangout', T0);
  assert.equal(gated.say('panam-palmer', T0 + 60, {journalHistory: journal([])}).decision.start, null);
});

// ---- unfinishedWhen -------------------------------------------------------------------------------------------------------------------------

test('unfinishedWhen: the story finishing a quest ends the open pack at its unfinished ending, paying nothing', () => {
  const pack = clone(shipped['judy-dinner-dress']);
  pack.id = 'jackie-test-dinner'; pack.character = 'jackie-welles';
  pack.requires = {bond: 2, questsFinished: ['quests/main_quest/prologue/q001_01_victor'], before: ['quests/main_quest/prologue/q005_heist'], invitations: true};
  pack.unfinishedWhen = {finished: 'quests/main_quest/prologue/q005_heist', ending: 'missed'};
  assert.deepEqual(validatePack(pack, {characters: roster}).errors, []);
  const victor = [['quests/main_quest/prologue/q001_01_victor', 'succeeded']];
  const {runner, awards, say} = make([pack]);
  say('jackie-welles', T0, {journalHistory: journal(victor)}, {}, {level: 3}).finish();
  assert.equal(runner.entries.get('jackie-test-dinner').status, 'active');
  const heist = [...victor, ['quests/main_quest/prologue/q005_heist', 'succeeded']];
  const after = say('jackie-welles', T0 + HOUR, {journalHistory: journal(heist)}, {}, {level: 3});
  assert.equal(runner.entries.get('jackie-test-dinner').status, 'done');
  assert.equal(runner.entries.get('jackie-test-dinner').trail.at(-1).stage, 'missed');
  assert.deepEqual(awards, [], 'unfinished: bond +0, though the ending has -5');
  assert.match(after.decision.note, /Something you remember about V/);
  // An unfinished journal changes nothing.
  const other = make([pack]);
  other.say('jackie-welles', T0, {journalHistory: journal(victor)}, {}, {level: 3}).finish();
  other.say('jackie-welles', T0 + HOUR, {journalHistory: journal(heist, {status: 'untracked'}).status === 'ready' ? parseJournalHistory({version: 1, status: 'unavailable'}) : null}, {}, {level: 3});
  assert.equal(other.runner.entries.get('jackie-test-dinner').status, 'active', 'no complete inventory: nothing is decided');
});

// ---- facts ------------------------------------------------------------------------------------------------------------------------------

test('facts: a pack that needs one starts only when the game reported it; the play file asks the game for the facts any pack needs; no pack needing one means no read', () => {
  const takemura = panamHangout();
  takemura.id = 'takemura-test-tea'; takemura.character = 'takemura'; takemura.kind = undefined; takemura.hangout = undefined;
  delete takemura.kind; delete takemura.hangout;
  takemura.requires = {questsFinished: ['quests/main_quest/act_01/q113_rescuing_hanako'], facts: {'takemura-alive': true}};
  assert.deepEqual(validatePack(takemura, {characters: roster}).errors, []);
  const rows = [['quests/main_quest/act_01/q113_rescuing_hanako', 'succeeded']];
  let facts = {}, reads = 0;
  const readFacts = () => { reads++; return facts; };
  const {runner, say} = make([takemura], {runner: {readFacts}});
  assert.deepEqual(runner.playState().factsWanted.map(item => item.id), ['takemura-alive']);
  assert.equal(say('takemura', T0, {journalHistory: journal(rows)}).decision.start, null, 'the game has not reported it');
  facts = {'takemura-alive': false};
  assert.equal(say('takemura', T0 + DAY, {journalHistory: journal(rows)}).decision.start, null, 'he is dead in this save');
  facts = {'takemura-alive': true};
  assert.equal(say('takemura', T0 + 2 * DAY, {journalHistory: journal(rows)}).decision.start.pack.id, 'takemura-test-tea');
  assert(reads >= 3);
  // Packs with no facts read none.
  let counted = 0;
  const plainRun = make([panamHangout()], {runner: {readFacts: () => { counted++; return {}; }}});
  plainRun.say('panam-palmer', T0).finish();
  assert.equal(counted, 0);
  assert.deepEqual(plainRun.runner.playState().factsWanted, []);
});

// ---- memory share -----------------------------------------------------------------------------------------------------------------------

test('memory share: a stage\'s primitive and an ending\'s share give another character a lasting line, shown in its notes, rolled back with the save and cleared by Forget', () => {
  const pack = panamHangout();
  pack.stages[0].do.push({p: 'memory-share', id: 'tell', to: 'judy-alvarez', note: 'Panam says V can fix a truck.'});
  pack.endings.fun.share = [{to: 'viktor-vektor'}, {to: 'judy-alvarez', note: 'Panam had a good day with V.'}];
  assert.deepEqual(validatePack(pack, {characters: roster}).errors, []);
  const {runner, say} = make([pack]);
  say('panam-palmer', T0).finish();
  const judy = say('judy-alvarez', T0 + 600);
  assert.match(judy.decision.note, /What you have heard about V from the people around you: Panam Palmer said: Panam says V can fix a truck\./);
  assert.equal(say('viktor-vektor', T0 + 600).decision, null, 'nothing yet for Viktor');
  runner.noteMeeting('panam-palmer', 'met', T0 + 900);
  const viktor = say('viktor-vektor', T0 + 1000).decision.note;
  assert.match(viktor, /Panam Palmer said: Had fun\./, 'the ending\'s memory is the default note');
  assert.match(say('judy-alvarez', T0 + 1000).decision.note, /Panam had a good day with V\./);
  assert.match(say('panam-palmer', T0 + 1000).decision.note, /What you and V have been through together|Something you remember about V/);
  // The save is rolled back to before the ending: the ending's lines are gone, the stage's stay.
  const back = say('judy-alvarez', T0 + 700).decision.note;
  assert.match(back, /Panam says V can fix a truck/); assert.doesNotMatch(back, /good day/);
  assert.equal(say('viktor-vektor', T0 + 700).decision, null);
  // Forget clears the shared lines with the history.
  assert.equal(runner.forgetHistory({profileKeys: ['judy-alvarez']}) >= 1, true);
  assert.equal(say('judy-alvarez', T0 + 800).decision, null);
});

// ---- reach-outs ------------------------------------------------------------------------------------------------------------------------

const reachFile = (triggers, extra = {}) => ({format: 1, character: 'panam-palmer', triggers, ...extra});
const oneTrigger = (extra = {}) => ({id: 'pr-test', via: 'text', text: 'Mitch says I mention you too much.', after: [{kind: 'bond', level: 5}], once: true, note: 'The bond rose.', ...extra});
const makeReach = (triggers, packs = [], options = {}) => {
  const reach = new ReachOuts({files: [reachFile(triggers)], characters: roster});
  return make(packs, {...options, runner: {reach, ...options.runner}});
};

test('reach-outs: the play file lists what may fire, the poller asks for the slow clock, a delivery starts the cooldown and its note rides on V\'s answer for three turns', () => {
  const {runner, say, written} = makeReach([oneTrigger()]);
  assert.deepEqual(runner.playState().reach, {enabled: false, items: [], perHour: 1, perDay: 3}, 'nothing is known before a first turn');
  const first = say('panam-palmer', T0);
  const block = runner.playState().reach;
  assert.equal(block.enabled, true);
  assert.deepEqual(block.items, [{id: 'pr-test', character: 'panam-palmer', via: 'text', text: 'Mitch says I mention you too much.'}]);
  assert.equal(runner.questActive(), false); assert.equal(runner.reachWanted(), true);
  const link = new QuestLink({packs: runner, readEvents: async () => '', writePlay: async () => {}});
  assert.equal(link.active(), 'reach');
  // The game delivers it: an event of the pack "reach".
  assert.equal(runner.noteEvent({pack: 'reach', serial: 0, name: 'reach:pr-test', at: T0 + 120}), false);
  assert.deepEqual(runner.playState().reach.items, [], 'once, and the hour cap');
  assert.equal(link.active(), false, 'nothing wanted: no timer at all');
  // V answers: the note on this turn and the next two, then it is gone.
  const notes = [];
  for (let n = 0; n < REACH_NOTE_TURNS + 1; n++) notes.push(say('panam-palmer', T0 + 200 + n * 60).decision?.note ?? '');
  assert(notes.slice(0, REACH_NOTE_TURNS).every(note => /You have just reached out to V first, with this message: "Mitch says I mention you too much\."/.test(note) && /What is behind it: The bond rose\./.test(note)), notes.join(' | '));
  assert.equal(notes.at(-1), '', 'the fourth turn carries nothing');
  first.finish();
  // The state is saved and comes back.
  return runner.flush().then(() => {
    const saved = JSON.parse(written.at(-1)[1]);
    assert.equal(saved.settings.packs, true); assert.equal(saved.settings.reach, true);
    assert.equal(saved.reach.triggers['pr-test'].lastFired, T0 + 120);
    assert.deepEqual(saved.reach.triggers['pr-test'].done, {'': T0 + 120});
  });
});

test('reach-outs: off with the Characters text first setting, with Story packs off, for a character with a pack open, and while the journal is unknown', () => {
  const pack = shipped['panam-sunset-coffee'];
  const { runner, say } = makeReach([oneTrigger()], [pack]);
  say('panam-palmer', T0, {}, {reach: undefined});
  assert.equal(runner.playState().reach.enabled, false, 'the player turned Characters text first off');
  say('panam-palmer', T0 + 10, {}, {});
  assert.equal(runner.playState().reach.items.length, 1);
  runner.on = false;
  assert.equal(runner.playState().reach.enabled, false, 'Story packs off');
  // A story pack of hers open takes the slot.
  const rows = [...SQ004, ['quests/main_quest/act_01/q104_02_av_chase', 'succeeded']];
  const second = makeReach([oneTrigger({id: 'pr-other'})], [pack]);
  const start = second.say('panam-palmer', T0, {journalHistory: journal(rows)}, {}, {level: 5});
  start.finish();
  assert.equal(second.runner.entries.get('panam-sunset-coffee').status, 'active');
  assert.deepEqual(second.runner.playState().reach.items, []);
  // No journal, no list.
  const third = makeReach([oneTrigger()]);
  third.say('panam-palmer', T0, {journalHistory: undefined});
  assert.deepEqual(third.runner.playState().reach.items, []);
});

test('reach-outs: an offer on a trigger makes the hangout startable on the next talk; the facts and gates of the character\'s file apply', () => {
  const hang = panamHangout(); hang.start.chance = 0.1;
  const {runner, say} = makeReach([oneTrigger({offer: 'test-hangout'})], [hang], {runner: {random: () => 0.9}});
  say('panam-palmer', T0).finish();
  runner.noteEvent({pack: 'reach', serial: 0, name: 'reach:pr-test', at: T0 + 60});
  assert.equal(runner.meta.get('panam-palmer').offer.pack, 'test-hangout');
  assert.deepEqual(runner.playState().reach.items, [], 'she waits for V to answer');
  const answer = say('panam-palmer', T0 + 120);
  assert.equal(answer.decision.start.pack.id, 'test-hangout');
  // The file's gate: a pack-like requires with a fact the game has not reported.
  const gated = new ReachOuts({files: [reachFile([oneTrigger()], {requires: {facts: {'takemura-alive': true}}})], characters: roster});
  const run = make([], {runner: {reach: gated, readFacts: () => ({})}});
  run.say('panam-palmer', T0);
  assert.deepEqual(run.runner.playState().reach.items, []);
  assert.deepEqual(run.runner.playState().factsWanted.map(item => item.id), ['takemura-alive']);
  const fine = make([], {runner: {reach: gated, readFacts: () => ({'takemura-alive': true})}});
  fine.say('panam-palmer', T0);
  assert.equal(fine.runner.playState().reach.items.length, 1);
});

test('reach-outs: a delivery in the events file reaches the runner through the link, which polls slowly while only reach-outs are wanted', async () => {
  const { runner, say } = makeReach([oneTrigger()]);
  say('panam-palmer', T0);
  const fileText = {value: ''};
  const link = new QuestLink({packs: runner, readEvents: async () => fileText.value, writePlay: async () => {}});
  const made = [];
  const poller = createQuestPoller({link, setTimer: (fn, ms) => { const timer = {fn, ms, unref() {}}; made.push(timer); return timer; }, clearTimer: () => {}});
  assert.equal(poller.arm(), true);
  assert.equal(made.length, 1); assert.equal(made[0].ms, 10000); assert.equal(poller.armed, false); assert.equal(poller.reachArmed, true);
  fileText.value = JSON.stringify({version: 1, session: 's', seq: 1, events: [{seq: 1, pack: 'reach', serial: 0, name: 'reach:pr-test', at: T0 + 30}]});
  assert.equal(await link.poll(), 1);
  assert.equal(runner.reach.state.get('pr-test').lastFired, T0 + 30);
  assert.equal(link.active(), false);
  await poller.poll();
  assert.equal(poller.reachArmed, false, 'the timer is gone when nothing is wanted');
  // A real quest uses the 500 ms clock.
  assert.equal(cleanData({amount: 5, flag: true, word: 'ok'}).word, 'ok');
  assert.equal(cleanData({a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7}), undefined);
  assert.equal(cleanData({word: 'x'.repeat(81)}), undefined); assert.equal(cleanData({nested: {a: 1}}), undefined); assert.equal(cleanData([1]), undefined); assert.equal(cleanData({}), undefined);
});

// ---- gifts ------------------------------------------------------------------------------------------------------------------------------

function giftPack() {
  const pack = panamHangout();
  pack.id = 'test-gifts'; delete pack.kind; delete pack.hangout;
  pack.stages = [{id: 'gifts', type: 'play', know: 'You are with V.', label: 'Gifts', do: [{p: 'gift', id: 'present', dir: 'receive', tier: 'rare'}, {p: 'gift', id: 'thanks', dir: 'give'}],
    choices: [{id: 'done', on: 'event:gift:present:given', next: 'fun'}], timeout: {gameHours: 48, next: 'late'}}];
  return pack;
}

test('gifts she gives: the tables\' item and second go into the play file, a tier given is used for good, and the likes rules ride along', () => {
  const pack = giftPack(); pack.stages.push({id: 'again', type: 'play', know: 'More.', do: [{p: 'gift', id: 'second-present', dir: 'receive', tier: 'rare'}, {p: 'gift', id: 'own-pick', dir: 'receive', item: 'Items.Nomad_01_Set_TShirt'}], next: 'fun'});
  pack.stages[0].choices[0].next = 'again';
  const { runner, say } = make([pack]);
  say('panam-palmer', T0).finish();
  const quest = runner.playState().quests[0];
  assert.equal(quest.do[0].item, resolveGive('panam-palmer', 'rare').item);
  assert.equal(quest.do[0].item, 'Items.Preset_Ajax_Moron');
  assert.deepEqual(quest.gifts, likesFor('panam-palmer'));
  assert.equal(quest.do[1].item, undefined, 'a gift V gives names no item');
  // The game gave it: the tier is used. The next stage\'s rare gift is not offered again, an item of the pack\'s own is.
  runner.noteEvent({pack: 'test-gifts', serial: 1, name: 'gift:present:given', at: T0 + 300});
  assert.deepEqual(runner.meta.get('panam-palmer').gifts.used, [{tier: 'rare', at: T0 + 300}]);
  const next = runner.playState().quests[0];
  assert.equal(next.stage, 'again');
  assert.equal(next.do[0].item, undefined); assert.equal(next.do[0].unavailable, 'tier-used');
  assert.equal(next.do[1].item, 'Items.Nomad_01_Set_TShirt');
  assert.equal(next.gifts, undefined, 'no gift of V\'s in this stage');
  // Kerry\'s legendary hands over the second thing, since the car is a garage matter.
  const kerry = giftPack(); kerry.character = 'kerry-eurodyne'; kerry.requires = {questsFinished: ['quests/side_quest/sq011_kerry']};
  kerry.stages[0].do[0].tier = 'legendary';
  const k = make([kerry]);
  k.say('kerry-eurodyne', T0, {journalHistory: journal([['quests/side_quest/sq011_kerry', 'succeeded']])}).finish();
  assert.equal(k.runner.playState().quests[0].do[0].item, 'Items.Preset_Overture_Kerry');
  // A used tier survives a restart.
});

test('gifts V gives: V\'s words while the stage waits send the offer to the game, and the game\'s verdict pays the bond, once a game day', () => {
  const { runner, awards, say } = make([giftPack()]);
  say('panam-palmer', T0).finish();
  const commands = () => runner.playState().commands.filter(command => command.name?.startsWith('gift:'));
  const plain = say('panam-palmer', T0 + 60); plain.finish('how is the truck');
  assert.deepEqual(commands(), []);
  const gift = say('panam-palmer', T0 + 120); gift.finish('Here, I got you something. A bottle of tequila.');
  assert.equal(commands().length, 1);
  assert.deepEqual({name: commands()[0].name, data: commands()[0].data, cmd: commands()[0].cmd}, {name: 'gift:thanks:offer', data: {words: 'Here, I got you something. A bottle of tequila.'}, cmd: 'event'});
  runner.noteEvent({pack: 'test-gifts', serial: 1, name: 'gift:thanks:loved', at: T0 + 200});
  assert.deepEqual(awards, [['panam-palmer', 8]]);
  runner.noteEvent({pack: 'test-gifts', serial: 1, name: 'gift:thanks:liked', at: T0 + 300});
  assert.deepEqual(awards, [['panam-palmer', 8]], 'one counted gift a game day');
  runner.noteEvent({pack: 'test-gifts', serial: 1, name: 'gift:thanks:disliked', at: T0 + DAY + 10});
  runner.noteEvent({pack: 'test-gifts', serial: 1, name: 'gift:thanks:neutral', at: T0 + 2 * DAY + 10});
  runner.noteEvent({pack: 'test-gifts', serial: 1, name: 'gift:thanks:nothing', at: T0 + 3 * DAY + 10});
  assert.deepEqual(awards, [['panam-palmer', 8], ['panam-palmer', -4], ['panam-palmer', 1]]);
  // A stage with no gift of V\'s sends nothing for the same words.
  const other = make([panamHangout()]);
  other.say('panam-palmer', T0).finish('I got you something');
  assert.deepEqual(other.runner.playState().commands.filter(command => command.name?.startsWith('gift:')), []);
});

// ---- pay -------------------------------------------------------------------------------------------------------------------------------

test('paying a cast member: the armed stage tells the cast member what is asked; V\'s words after the reply become the offer command; nothing else is touched', () => {
  const pack = panamHangout();
  pack.id = 'test-toll'; delete pack.kind; delete pack.hangout;
  pack.stages = [{id: 'toll', type: 'play', know: 'A guard blocks the way.', label: 'Toll', do: [{p: 'cast', id: 'guard', who: 'a guard'}, {p: 'pay', id: 'toll', to: 'guard', amount: 100, min: 60, reason: 'toll'}],
    choices: [{id: 'paid', on: 'event:pay:toll:paid', next: 'fun'}], timeout: {gameHours: 3, next: 'late'}}];
  assert.deepEqual(validatePack(pack, {characters: roster}).errors, []);
  const { runner, say } = make([pack]);
  say('panam-palmer', T0).finish();
  const guard = {requestId: 'g-1', profileKey: 'npc-fixer-male', text: 'Fine, 80 then.', quest: {pack: 'test-toll', cast: 'guard'}};
  assert.match(runner.payNote(guard), /You want eddies from V to let V through\. You ask 100 eddies/);
  assert.equal(runner.payNote({...guard, quest: {pack: 'test-toll', cast: 'cook'}}), '');
  assert.equal(runner.payNote({...guard, quest: {pack: 'other-pack', cast: 'guard'}}), '');
  assert.equal(runner.payNote({text: 'hi'}), '');
  assert.equal(runner.afterPay(guard, undefined), true);
  const command = runner.playState().commands.at(-1);
  assert.deepEqual({cmd: command.cmd, name: command.name, data: command.data, pack: command.pack}, {cmd: 'event', name: 'pay:toll:offer', data: {amount: 80}, pack: 'test-toll'});
  assert.equal(runner.afterPay({...guard, text: 'what?'}, 'what?'), false, 'nothing to act on');
  assert.equal(runner.afterPay({...guard, text: 'no way'}, 'no way'), true);
  assert.deepEqual(runner.playState().commands.at(-1).data, {amount: 0, declined: true});
  assert.equal(runner.afterPay({...guard, quest: undefined}, 'sure'), false);
  // The game says it was paid: the stage moves.
  runner.noteEvent({pack: 'test-toll', serial: 1, name: 'pay:toll:paid', at: T0 + 400});
  assert.equal(runner.entries.get('test-toll').status, 'done');
  assert.equal(runner.payNote(guard), '', 'the stage is over');
});

// ---- calls, music, sound effects, situation -----------------------------------------------------------------------------------------------

test('the play file carries the calls a stage names with their lines, and the stage\'s music, sound effects and situation (the gap\'s too)', () => {
  const pack = panamHangout();
  pack.id = 'test-calls'; delete pack.kind; delete pack.hangout; pack.start = {...pack.start, channels: ['holocall']};
  pack.lines = {'C.1': {text: 'Hey. Can you talk?', channel: 'holocall', emotion: 'neutral'}, 'C.2': {text: 'I will text you later.', channel: 'holocall'}, 'C.text': {text: 'Call me.', channel: 'own'}, 'X.unused': {text: 'Not in this stage.'}};
  pack.gaps = {g1: {asks: 'Are you okay?', know: 'She worries.', situation: 'nervous', resumeAfterSeconds: 60}};
  pack.calls = {c1: {caller: 'self', picture: 'live', text: 'C.text', onHangUp: 'call:ring:hung-up', steps: [{say: 'C.1'}, {gap: 'g1'}, {say: 'C.2'}, {hangup: true}]}};
  pack.stages = [{id: 'ring', type: 'play', know: 'You call V.', label: 'Ring', do: [{p: 'call-in', id: 'ring', call: 'c1'}], music: [{source: 'radio:Pacific Dreams', start: 'stage:enter', volume: 0.4}],
    sfx: [{source: 'game:ui_menu_hover', at: 'v', start: 'call:ring:answered'}], situation: 'nervous', choices: [{id: 'done', on: 'event:call:ring:done', next: 'fun'}], timeout: {gameHours: 2, next: 'late'}}];
  assert.deepEqual(validatePack(pack, {characters: roster}).errors, []);
  const { runner, say } = make([pack]);
  // A pack that opens with a call starts on a holocall with her apart from V, not in person (bridge/quest-start.mjs).
  say('panam-palmer', T0, {holocall: {version: 1, contact: 'panam-palmer', mode: 'audio'}}, {copy: null}).finish();
  const quest = runner.playState().quests[0];
  assert.deepEqual(quest.calls.c1, {caller: 'self', picture: 'live', text: 'C.text', onHangUp: 'call:ring:hung-up', steps: pack.calls.c1.steps});
  assert.deepEqual(Object.keys(quest.lines).sort(), ['C.1', 'C.2', 'C.text']);
  assert.equal(quest.lines['C.1'].channel, 'holocall'); assert.equal(quest.lines['C.1'].text, 'Hey. Can you talk?');
  assert.equal(quest.gaps.g1.situation, 'nervous'); assert.equal(quest.gaps.g1.resumeAfterSeconds, 60);
  assert.deepEqual(quest.music, pack.stages[0].music); assert.deepEqual(quest.sfx, pack.stages[0].sfx); assert.equal(quest.situation, 'nervous');
  // A stage with none of these carries none of these keys.
  const plain = make([panamHangout()]);
  plain.say('panam-palmer', T0).finish();
  const bare = plain.runner.playState().quests[0];
  for (const key of ['calls', 'music', 'sfx', 'situation', 'gifts']) assert.equal(Object.hasOwn(bare, key), false, key);
});

// ---- state ------------------------------------------------------------------------------------------------------------------------------

test('hangout, gift, offer, romance and reach state survives a restart', async () => {
  const pack = giftPack();
  const hang = panamHangout();
  const first = makeReach([oneTrigger({offer: 'test-hangout'})], [pack, hang]);
  first.say('panam-palmer', T0, {}, {}, {level: 6, romance: 'partner'}).finish();
  first.runner.noteEvent({pack: 'test-gifts', serial: 1, name: 'gift:thanks:loved', at: T0 + 110});
  first.runner.noteEvent({pack: 'test-gifts', serial: 1, name: 'gift:present:given', at: T0 + 100});
  first.runner.noteEvent({pack: 'reach', serial: 0, name: 'reach:pr-test', at: T0 + 200});
  await first.runner.flush();
  const text = first.written.at(-1)[1];
  const second = makeReach([oneTrigger({offer: 'test-hangout'})], [pack, hang], {runner: {read: async () => text}});
  await second.runner.load();
  const meta = second.runner.meta.get('panam-palmer');
  assert.deepEqual(meta.gifts, {used: [{tier: 'rare', at: T0 + 100}], day: Math.floor((T0 + 110) / DAY)});
  assert.equal(meta.romance, 'partner'); assert.equal(meta.talkedAt, T0);
  assert.equal(meta.offer.pack, 'test-hangout'); assert.equal(meta.reachNote.left, REACH_NOTE_TURNS);
  assert.equal(second.runner.settings.reach, true);
  assert.deepEqual(second.runner.reach.toJSON(), first.runner.reach.toJSON());
  assert.match(second.say('panam-palmer', T0 + 300).decision.note, /You have just reached out to V first/);
  // A file from before round 2 (no new fields) loads as it did.
  const old = make([pack], {runner: {read: async () => JSON.stringify({version: 1, entries: {}, meta: {'panam-palmer': {rolled: 5, endedAt: null}}})}});
  await old.runner.load();
  assert.equal(old.runner.meta.get('panam-palmer').rolled, 5); assert.deepEqual(old.runner.meta.get('panam-palmer').gifts, {used: [], day: null});
});
