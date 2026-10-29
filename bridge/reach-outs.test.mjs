// Characters reach out first (bridge/reach-outs.mjs, docs/QUEST_PRIMITIVES.md 10.7): the validator, the shipped files, the state and which triggers may fire now. Offline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateReachFile, shippedReachFiles, ReachOuts, textProblem, REACH_LIMITS} from './reach-outs.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const DAY = 86400, HOUR = 3600;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const roster = new Set(JSON.parse(read('../characters/roster.json')).map(row => row.key));
const premises = JSON.parse(read('../research/cyberpunk/quest-premises.json')).premises;
const clone = value => JSON.parse(JSON.stringify(value));

function journal(rows, {tracked = {status: 'untracked'}} = {}) {
  const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: rows.length, omitted: 0, unstable: false};
  return parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked, coverage: {active: coverage, history: coverage},
    quests: rows.map(([path, state], index) => ({id: String(100 + index), nativeId: path.slice(path.lastIndexOf('/') + 1), nativePath: path, title: 'Quest ' + index,
      state, lane: state === 'active' ? 'active' : 'history', observedAtMs: 1000, objectivesComplete: state !== 'active', objectives: []}))});
}

const trigger = (extra = {}) => ({id: 'xx-one', via: 'text', text: 'Hello there.', after: [{kind: 'bond', level: 3}], ...extra});
const file = (triggers, extra = {}) => ({format: 1, character: 'panam-palmer', triggers, ...extra});

test('the shipped files: ten characters, valid, English, at most 12 triggers each, unique ids, every quest path a known quest', () => {
  const files = shippedReachFiles();
  assert.equal(files.length, 10);
  const ids = new Set();
  let count = 0;
  for (const {file: name, data} of files) {
    assert.equal(name, `${data.character}.json`);
    assert.deepEqual(validateReachFile(data, {characters: roster}).errors, [], name);
    assert(data.triggers.length <= REACH_LIMITS.triggers, name);
    for (const t of data.triggers) {
      assert(!ids.has(t.id), `${t.id} is used twice`); ids.add(t.id); count++;
      assert.equal(textProblem(t.text, 240), null, t.id);
      for (const item of t.after ?? []) if (item.kind === 'quest') assert(Object.hasOwn(premises, item.path), `${t.id}: ${item.path}`);
    }
    for (const path of [...(data.requires?.questsFinished ?? []), ...(data.requires?.before ?? []), ...(data.requires?.notBegun ?? [])]) assert(Object.hasOwn(premises, path), `${name}: ${path}`);
  }
  assert(count >= 70, `${count} triggers`);
  assert.deepEqual(files.map(row => row.data.character).sort(), ['jackie-welles', 'johnny-silverhand', 'judy-alvarez', 'kerry-eurodyne', 'panam-palmer', 'rogue-amendiares', 'river-ward', 'songbird', 'takemura', 'viktor-vektor'].sort());
});

test('the character gates come from the files: Jackie before The Heist, Songbird on the freed branch, Takemura alive, Johnny while the head lasts', () => {
  const by = Object.fromEntries(shippedReachFiles().map(row => [row.data.character, row.data]));
  assert.deepEqual(by['jackie-welles'].requires.before, ['quests/main_quest/prologue/q005_heist']);
  assert.equal(by['jackie-welles'].requires.window.untracked, true);
  assert.deepEqual(by.songbird.requires.notBegun, ['ep1/quests/main_quest/q306_reed_epilogue']);
  assert(by.songbird.requires.questsFinished.includes('ep1/quests/main_quest/q306_postcontent'));
  assert.deepEqual(by.takemura.requires.facts, {'takemura-alive': true});
  assert(by['johnny-silverhand'].requires.notBegun[0].includes('q115'));
  assert(by['johnny-silverhand'].triggers.every(t => t.via === 'voice'));
});

test('the validator: one example per rule', () => {
  const bad = (change, pattern, base = file([trigger()])) => {
    const data = clone(base); change(data);
    const result = validateReachFile(data, {characters: roster});
    assert.equal(result.ok, false, String(pattern));
    assert(result.errors.some(error => pattern.test(error)), `${pattern}: ${result.errors.join(' | ')}`);
  };
  assert.equal(validateReachFile(file([trigger()]), {characters: roster}).ok, true);
  bad(data => { data.format = 2; }, /format must be 1/);
  bad(data => { data.character = 'nobody'; }, /not on the roster/);
  bad(data => { data.extra = 1; }, /no field "extra"/);
  bad(data => { data.triggers = []; }, /1 to 12/);
  bad(data => { data.triggers = Array.from({length: 13}, (_, n) => trigger({id: `xx-${n}a`})); }, /1 to 12/);
  bad(data => { data.requires = {questsFinished: ['nope']}; }, /requires\.questsFinished/);
  bad(data => { data.requires = {facts: {'takemura-alive': 'yes'}}; }, /true or false/);
  bad(data => { data.requires = {eddies: true}; }, /requires has no field "eddies"/);
  bad(data => { data.triggers[0].id = 'X'; }, /id must be 2 to 32/);
  bad(data => { data.triggers.push(trigger()); }, /the id is used twice/);
  bad(data => { data.triggers[0].via = 'smoke'; }, /via must be one of/);
  bad(data => { data.triggers[0].text = 'Hi; there'; }, /semicolon/);
  bad(data => { data.triggers[0].text = 'Hi ' + String.fromCharCode(0x2014) + ' there'; }, /dash as punctuation/);
  bad(data => { data.triggers[0].text = 'Wait -- what'; }, /dash as punctuation/);
  bad(data => { data.triggers[0].text = 'Wait - what'; }, /dash as punctuation/);
  bad(data => { data.triggers[0].text = 'Hola, ¿qué tal?'; }, /English/);
  bad(data => { data.triggers[0].text = 'x'.repeat(241); }, /1 to 240/);
  bad(data => { data.triggers[0].note = 'a; b'; }, /note has a semicolon/);
  bad(data => { data.triggers[0].after = [{kind: 'bond', level: 11}]; }, /level must be from 1 to 10/);
  bad(data => { data.triggers[0].after = [{kind: 'bond', level: 3, levels: [2, 3]}]; }, /needs level or levels/);
  bad(data => { data.triggers[0].after = [{kind: 'bond', levels: [3]}]; }, /2 to 10 different levels/);
  bad(data => { data.triggers[0].after = [{kind: 'quest', path: 'x'}]; }, /journal quest path/);
  bad(data => { data.triggers[0].after = [{kind: 'idle-days', days: 1}]; }, /days must be from 2 to 60/);
  bad(data => { data.triggers[0].after = [{kind: 'weather'}]; }, /kind must be quest, bond, pack or idle-days/);
  bad(data => { data.triggers[0].after = [{kind: 'bond', levels: [2, 3]}, {kind: 'pack', ids: ['aaa-bbb', 'ccc-ddd']}]; }, /only one condition may be a list/);
  bad(data => { data.triggers[0].after = [{kind: 'bond', levels: [2, 3]}]; data.triggers[0].once = true; }, /drop once/);
  bad(data => { data.triggers[0].when = {kind: 'hours', from: 5, to: 5}; }, /different hours/);
  bad(data => { data.triggers[0].when = {kind: 'heat', atLeast: 9}; }, /atLeast must be from 1 to 5/);
  bad(data => { data.triggers[0].when = {kind: 'tide'}; }, /kind must be weather, hours/);
  bad(data => { data.triggers[0].when = {kind: 'weather', is: 'Rain!'}; }, /weather name/);
  bad(data => { data.triggers[0].minBond = 0; }, /minBond/);
  bad(data => { data.triggers[0].cooldownDays = 0; }, /cooldownDays/);
  bad(data => { data.triggers[0].once = true; data.triggers[0].cooldownDays = 2; }, /do not go together/);
  bad(data => { data.triggers[0].relationship = 'maybe'; }, /relationship/);
  bad(data => { data.triggers[0].offer = 'Bad Id'; }, /offer must be a hangout pack id/);
  bad(data => { delete data.triggers[0].after; }, /needs after, when or minBond/);
  assert.equal(validateReachFile(null).ok, false);
  // A pack id is checked against the mod's packs only when the caller gives them.
  const withOffer = file([trigger({offer: 'panam-diner-rules'})]);
  assert.equal(validateReachFile(withOffer, {characters: roster}).ok, true);
  assert.equal(validateReachFile(withOffer, {characters: roster, packIds: new Set(['other-pack'])}).ok, false);
});

// ---- eligibility --------------------------------------------------------------------------------------------------------------------------

const T0 = 40 * DAY;
const SAVE = journal([['quests/side_quest/sq004_riders_on_the_storm', 'succeeded']]);
function make(files, options = {}) {
  const log = [];
  const reach = new ReachOuts({files, characters: roster, log: line => log.push(line), ...options});
  const ask = (extra = {}) => reach.eligible({enabled: true, gameSeconds: T0, journalHistory: SAVE, levels: {'panam-palmer': 6}, ...extra});
  return {reach, ask, log};
}

test('nothing is listed while reach-outs are off, the clock or the journal is unknown, or the file is invalid', () => {
  const {ask, reach, log} = make([file([trigger()])]);
  assert.deepEqual(ask().items.map(item => item.id), ['xx-one']);
  assert.deepEqual(ask({enabled: false}), {enabled: false, items: [], perHour: 1, perDay: 3});
  assert.deepEqual(ask({gameSeconds: null}).items, []);
  assert.deepEqual(ask({journalHistory: null}).items, [], 'missing journal data is a no');
  assert.equal(reach.size, 1);
  const broken = make([file([trigger({text: 'bad; text'})])]);
  assert.equal(broken.reach.size, 0); assert.match(broken.log[0], /left out/);
  const doubled = make([file([trigger()]), file([trigger({id: 'xx-two'})])]);
  assert.equal(doubled.reach.size, 1); assert.match(doubled.log[0], /has a file already/);
  const clash = make([file([trigger()]), {format: 1, character: 'judy-alvarez', triggers: [trigger()]}]);
  assert.match(clash.log[0], /used in another file/);
});

test('the items carry id, character, via, text, image, when and offer, and nothing else', () => {
  const {ask} = make([file([trigger({image: 'pic', when: {kind: 'weather', is: 'rain'}, offer: 'panam-diner-rules', cooldownDays: 2, note: 'private', minBond: 2})])]);
  assert.deepEqual(ask().items, [{id: 'xx-one', character: 'panam-palmer', via: 'text', text: 'Hello there.', image: 'pic', when: {kind: 'weather', is: 'rain'}, offer: 'panam-diner-rules'}]);
});

test('conditions: a quest finished, the bond, a story pack, days without talk, minBond and the romance', () => {
  const triggers = [
    trigger({id: 'aa-quest', after: [{kind: 'quest', path: 'quests/side_quest/sq004_riders_on_the_storm'}]}),
    trigger({id: 'aa-quest-open', after: [{kind: 'quest', path: 'quests/side_quest/sq027_02_raffen_shiv_attack'}]}),
    trigger({id: 'aa-bond7', after: [{kind: 'bond', level: 7}]}),
    trigger({id: 'aa-pack', after: [{kind: 'pack', id: 'panam-truck-ransom'}]}),
    trigger({id: 'aa-idle', after: [{kind: 'idle-days', days: 10}]}),
    trigger({id: 'aa-min', after: undefined, when: {kind: 'weather', is: 'rain'}, minBond: 7}),
    trigger({id: 'aa-love', after: [{kind: 'bond', level: 2}], relationship: 'partner'}),
    trigger({id: 'aa-friend', after: [{kind: 'bond', level: 2}], relationship: 'not-partner'}),
  ];
  const {ask} = make([file(triggers)]);
  const ids = extra => ask(extra).items.map(item => item.id);
  assert.deepEqual(ids(), ['aa-quest', 'aa-friend']);
  assert.deepEqual(ids({levels: {'panam-palmer': 7}}), ['aa-quest', 'aa-bond7', 'aa-min', 'aa-friend']);
  assert.deepEqual(ids({levels: {}}), [], 'a character V has never talked to does not text first');
  assert.deepEqual(ids({levels: {'panam-palmer': 1}}), ['aa-quest'], 'the friend line needs bond 2');
  assert.deepEqual(ids({romance: {'panam-palmer': 'partner'}}), ['aa-quest', 'aa-love']);
  assert.deepEqual(ids({finishedPacks: new Set(['panam-truck-ransom'])}), ['aa-quest', 'aa-pack', 'aa-friend']);
  assert.deepEqual(ids({talkedAt: {'panam-palmer': T0 - 9 * DAY}}), ['aa-quest', 'aa-friend']);
  assert.deepEqual(ids({talkedAt: {'panam-palmer': T0 - 10 * DAY}}), ['aa-quest', 'aa-idle', 'aa-friend']);
  assert.deepEqual(ids({talkedAt: {}}), ['aa-quest', 'aa-friend'], 'never talked is not "ten days without contact"');
  assert.deepEqual(ids({journalHistory: journal([['quests/side_quest/sq027_02_raffen_shiv_attack', 'failed']])}), ['aa-quest-open', 'aa-friend']);
});

test('a character with a story pack open, or an offer waiting, is left alone', () => {
  const {ask} = make([file([trigger()])]);
  assert.deepEqual(ask({busy: new Set(['panam-palmer'])}).items, []);
  assert.equal(ask({busy: new Set(['judy-alvarez'])}).items.length, 1);
});

test('the character gate of the file: finished quests, before, notBegun, facts, and a quest of her own lines active', () => {
  const requires = {questsFinished: ['quests/side_quest/sq004_riders_on_the_storm'], before: ['quests/side_quest/sq027_02_raffen_shiv_attack'], notBegun: ['quests/side_quest/sq027_01_basilisk_convoy'],
    facts: {'takemura-alive': true}};
  const {ask} = make([file([trigger()], {requires})]);
  const facts = {'takemura-alive': true};
  assert.equal(ask({facts}).items.length, 1);
  assert.equal(ask({}).items.length, 0, 'the fact is not reported: no');
  assert.equal(ask({facts: {'takemura-alive': false}}).items.length, 0);
  assert.equal(ask({facts, journalHistory: journal([])}).items.length, 0, 'her quest is not finished');
  assert.equal(ask({facts, journalHistory: journal([['quests/side_quest/sq004_riders_on_the_storm', 'succeeded'], ['quests/side_quest/sq027_02_raffen_shiv_attack', 'failed']])}).items.length, 0, 'the before quest is finished');
  assert.equal(ask({facts, journalHistory: journal([['quests/side_quest/sq004_riders_on_the_storm', 'succeeded'], ['quests/side_quest/sq027_01_basilisk_convoy', 'active']])}).items.length, 0, 'begun');
  const plainFile = make([file([trigger()])]);
  assert.equal(plainFile.ask({journalHistory: journal([['quests/side_quest/sq027_01_basilisk_convoy', 'active']])}).items.length, 0, 'one of her own quest lines is active');
});

test('the window lets Jackie\'s opening quests be active when they are not tracked', () => {
  const requires = {questsFinished: ['quests/main_quest/prologue/q001_01_victor'], before: ['quests/main_quest/prologue/q005_heist'],
    window: {allowActive: ['quests/main_quest/prologue/q003'], untracked: true}};
  const jackie = file([trigger({id: 'jk-one'})], {character: 'jackie-welles', requires});
  const done = ['quests/main_quest/prologue/q001_01_victor', 'succeeded'], active = ['quests/main_quest/prologue/q003_maelstrom', 'active'];
  const {reach} = make([jackie]);
  const ask = journalHistory => reach.eligible({enabled: true, gameSeconds: T0, journalHistory, levels: {'jackie-welles': 3}}).items.length;
  assert.equal(ask(journal([done])), 1);
  assert.equal(ask(journal([done, active])), 1, 'active but untracked: allowed');
  assert.equal(ask(journal([done, active], {tracked: {status: 'known', questId: '101'}})), 0, 'tracked: not allowed');
  assert.equal(ask(journal([done, active], {tracked: {status: 'unknown'}})), 0, 'unknown tracking is a no');
  assert.equal(ask(journal([done, ['quests/main_quest/prologue/q005_heist', 'succeeded']])), 0, 'after The Heist: never');
});

test('cooldown and once: a delivered trigger waits its cooldown, a once trigger never comes back', () => {
  const {reach, ask} = make([file([trigger({id: 'cc-cool', cooldownDays: 3}), trigger({id: 'cc-once', once: true}), trigger({id: 'cc-default'})])]);
  assert.deepEqual(ask().items.map(item => item.id), ['cc-cool', 'cc-once', 'cc-default']);
  assert.equal(reach.noteFired('cc-cool', T0).trigger.id, 'cc-cool');
  reach.noteFired('cc-once', T0 + 5 * DAY); reach.fired = [];
  assert.deepEqual(ask({gameSeconds: T0 + 2 * DAY}).items.map(item => item.id), ['cc-default']);
  assert.deepEqual(ask({gameSeconds: T0 + 3 * DAY}).items.map(item => item.id), ['cc-cool', 'cc-default']);
  reach.noteFired('cc-default', T0); reach.fired = [];
  assert.deepEqual(ask({gameSeconds: T0 + 6 * DAY}).items.map(item => item.id), ['cc-cool', 'cc-default'], 'a trigger without a cooldown waits a game day');
  assert.equal(reach.noteFired('nope', T0), null);
});

test('a list of levels or packs fires once for each, and one delivery covers every level reached', () => {
  const {reach, ask} = make([file([trigger({id: 'll-level', after: [{kind: 'bond', levels: [3, 4, 5, 6]}]}), trigger({id: 'll-pack', after: [{kind: 'pack', ids: ['aaa-one', 'bbb-two']}], cooldownDays: 1})])]);
  assert.deepEqual(ask({levels: {'panam-palmer': 2}}).items.map(item => item.id), []);
  assert.deepEqual(ask({levels: {'panam-palmer': 4}}).items.map(item => item.id), ['ll-level']);
  reach.noteFired('ll-level', T0);
  reach.fired = [];
  assert.deepEqual(ask({levels: {'panam-palmer': 4}, gameSeconds: T0 + 5 * DAY}).items.map(item => item.id), [], 'levels 3 and 4 are used up');
  assert.deepEqual(ask({levels: {'panam-palmer': 6}, gameSeconds: T0 + 5 * DAY}).items.map(item => item.id), ['ll-level'], 'level 5 and 6 are new');
  const packs = new Set(['aaa-one']), low = {'panam-palmer': 1};
  assert.deepEqual(ask({finishedPacks: packs, levels: low}).items.map(item => item.id), ['ll-pack']);
  reach.noteFired('ll-pack', T0); reach.fired = [];
  assert.deepEqual(ask({finishedPacks: packs, levels: low, gameSeconds: T0 + 3 * DAY}).items.map(item => item.id), [], 'that pack was answered');
  assert.deepEqual(ask({finishedPacks: new Set(['aaa-one', 'bbb-two']), levels: low, gameSeconds: T0 + 3 * DAY}).items.map(item => item.id), ['ll-pack']);
});

test('the caps: one delivery per game hour and three per game day across all characters hide the list', () => {
  const files = [file([trigger({id: 'cap-a'}), trigger({id: 'cap-b'}), trigger({id: 'cap-c'}), trigger({id: 'cap-d'})])];
  const {reach, ask} = make(files);
  assert.equal(ask().items.length, 4);
  reach.noteFired('cap-a', T0);
  assert.deepEqual(ask({gameSeconds: T0 + 30 * 60}).items, [], 'inside the hour');
  assert.equal(ask({gameSeconds: T0 + HOUR + 1}).items.length, 3);
  reach.noteFired('cap-b', T0 + 2 * HOUR); reach.noteFired('cap-c', T0 + 4 * HOUR);
  assert.deepEqual(ask({gameSeconds: T0 + 6 * HOUR}).items, [], 'three in a day');
  assert.equal(ask({gameSeconds: T0 + DAY + 1}).items.length, 2, 'the day moved on: the delivered triggers still wait their own cooldown');
});

test('state: saved, loaded, and rolled back to an earlier save', () => {
  const files = [file([trigger({id: 'st-a', once: true}), trigger({id: 'st-b', cooldownDays: 5})])];
  const first = make(files);
  first.reach.noteFired('st-a', T0 + HOUR); first.reach.noteFired('st-b', T0 + 3 * HOUR);
  const saved = JSON.parse(JSON.stringify(first.reach.toJSON()));
  const second = make(files);
  second.reach.load(saved);
  assert.deepEqual(second.reach.toJSON(), saved);
  assert.deepEqual(second.ask({gameSeconds: T0 + 4 * HOUR}).items, []);
  // A load of an earlier save: whatever was stamped after the clock never happened.
  assert.equal(second.reach.rewind(T0), true);
  assert.deepEqual(second.ask({gameSeconds: T0}).items.map(item => item.id), ['st-a', 'st-b']);
  assert.equal(second.reach.rewind(T0), false);
  assert.deepEqual(second.reach.toJSON(), {triggers: {}, fired: []});
  // Junk in a state file is ignored.
  second.reach.load({triggers: {'st-a': {lastFired: 'x', done: {'!!': 1, '': 5}}, ghost: {lastFired: 1}}, fired: ['a', 5]});
  assert.deepEqual(second.reach.toJSON().triggers, {'st-a': {lastFired: null, done: {'': 5}}});
  assert.deepEqual(second.reach.fired, [5]);
  second.reach.load(null);
});

test('the facts the files need are listed for the game to read', () => {
  const {reach} = make(shippedReachFiles());
  assert.deepEqual(reach.factsWanted().map(item => item.id), ['takemura-alive']);
});
