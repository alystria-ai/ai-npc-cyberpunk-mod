// Quest invitations, reach-outs and bond lines beside V (live test 30 Oct: a romanced Panam standing next to V kept asking V to come over). The turn context already makes a
// Phone Chat or holocall turn of a character within a few metres of V an in-person one (bridge/turn-context.mjs); a quest's note and a reach-out's note get the same rule
// here (besideV, QUEST_NEAR_NOTE), a partner's fixed reach-out lines are warmer than the plain ones, and the partner tone has ONE source (bridge/romance-context.mjs). Offline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BondPacks} from './bond-pack-runner.mjs';
import {besideV, QUEST_NEAR_NOTE, describeTurnContext} from './turn-context.mjs';
import {ReachOuts, shippedReachFiles, validateReachFile, textProblem} from './reach-outs.mjs';
import {shippedPacks} from './bond-packs.mjs';
import {bondLine, LEVELS} from './bonds.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const DAY = 86400, HOUR = 3600;
const roster = new Set(JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8')).map(row => row.key));
const pilot = shippedPacks().map(row => row.pack).find(pack => pack.id === 'panam-sunset-coffee');
const DONE = [['quests/main_quest/act_01/q104_02_av_chase', 'succeeded'], ['quests/side_quest/sq027_02_raffen_shiv_attack', 'succeeded'], ['ep1/quests/main_quest/q305_reed_epilogue', 'succeeded']];

function journal(rows) {
  const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: rows.length, omitted: 0, unstable: false};
  return parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'}, coverage: {active: coverage, history: coverage},
    quests: rows.map(([path, state], index) => ({id: String(100 + index), nativeId: path.slice(path.lastIndexOf('/') + 1), nativePath: path, title: 'Quest ' + index,
      state, lane: state === 'active' ? 'active' : 'history', observedAtMs: 1000, objectivesComplete: state !== 'active', objectives: []}))});
}
const snapshot = (at, near) => ({version: 1, status: 'ready', hour: 14, minute: 5, gameTime: at, party: [{key: 'panam-palmer', name: 'Panam', ...(near ? {near: true} : {})}]});
let counter = 0;
const turn = (at, near, extra = {}) => ({requestId: `b-${++counter}`, profileKey: 'panam-palmer', name: 'Panam', text: 'hey', entity: 'e1', channel: 'phone',
  turnContext: snapshot(at, near), journalHistory: journal(DONE), bonds: {on: true, copy: 'party', packs: true, invitations: true}, ...extra});
const runnerOf = (packs = [pilot], extra = {}) => new BondPacks({packs, characters: roster, random: () => 0, log() {}, bonds: {award() {}, publish() {}}, debounceMs: 0, path: 'p.json',
  write: async () => {}, exists: () => false, ...extra});

test('besideV reads the party row of the snapshot for this turn\'s character, and is false for anything else', () => {
  assert.equal(besideV(turn(30 * DAY, true)), true);
  assert.equal(besideV(turn(30 * DAY, false)), false);
  assert.equal(besideV({...turn(30 * DAY, true), profileKey: 'judy-alvarez'}), false, 'another character');
  assert.equal(besideV({profileKey: 'panam-palmer'}), false, 'no snapshot');
  assert.equal(besideV({...turn(30 * DAY, true), turnContext: {version: 1, status: 'unavailable'}}), false);
  assert.equal(besideV(null), false);
});

test('a pack that starts on a phone turn while she stands beside V carries the beside-V rule, away from V it does not', () => {
  const near = runnerOf().forTurn(turn(30 * DAY, true), {level: 3, romance: 'partner', near: true});
  assert.equal(near.pack?.id, 'panam-sunset-coffee');
  assert(near.note.includes(QUEST_NEAR_NOTE), 'the rule is in the note');
  assert.match(near.note, /Sunset Motel/, 'the plan itself stays');
  const away = runnerOf().forTurn(turn(30 * DAY, false), {level: 3, romance: 'partner', near: false});
  assert(!away.note.includes(QUEST_NEAR_NOTE));
  assert.match(QUEST_NEAR_NOTE, /never 'come over'/);
  assert.match(QUEST_NEAR_NOTE, /never talk as if V were far away/);
  assert.doesNotMatch(QUEST_NEAR_NOTE, /[;–—]|--/, 'no semicolon or dash in the model text');
});

test('the meeting a stage hopes for is "go together from here" beside V, and "meet you at" away from V', () => {
  const pack = JSON.parse(JSON.stringify(pilot));
  pack.stages[0].meet = {where: 'waypoint', inGameHours: 6};
  const near = runnerOf([pack]).forTurn(turn(30 * DAY, true), {level: 3, romance: 'partner', near: true});
  assert.match(near.note, /You would like to go to the spot V marks on the map together with V, within about 6 game hours\. V is beside you/);
  assert.doesNotMatch(near.note, /meet you at the spot/);
  const away = runnerOf([pack]).forTurn(turn(30 * DAY, false), {level: 3, romance: 'partner', near: false});
  assert.match(away.note, /You would like V to meet you at the spot V marks on the map/);
  pack.stages[0].meet = {where: 'here', inGameHours: 2};
  assert.match(runnerOf([pack]).forTurn(turn(30 * DAY, true), {level: 3, romance: 'partner', near: true}).note, /You would like to go somewhere together with V/);
});

test('a reach-out V answers (its note rides on the next turns) carries the rule beside V, and a partner answers the warmer line she was sent', () => {
  const reach = new ReachOuts({files: [{data: {format: 1, character: 'panam-palmer', triggers: [triggerOf({id: 'xx-warm', text: 'Come hand me things.', partnerText: 'Come hand me things, babe.', note: 'The truck is making a noise.', once: false})]}}], log() {}});
  const runner = runnerOf([pilot], {reach});
  const eligible = (romance) => reach.eligible({enabled: true, gameSeconds: 40 * DAY, journalHistory: journal(DONE), levels: {'panam-palmer': 5}, romance: {'panam-palmer': romance}});
  assert.equal(eligible('partner').items[0].text, 'Come hand me things, babe.');
  runner.forTurn(turn(40 * DAY - 10, false), {level: 5, romance: 'partner'});   // the runner learns the romance of the save
  assert.equal(runner.noteReach('xx-warm', 40 * DAY), true);
  const answered = runner.forTurn(turn(40 * DAY + 60, true), {level: 5, romance: 'partner', near: true});
  assert.match(answered.note, /with this message: "Come hand me things, babe."/, 'the line she sent');
  assert(answered.note.includes(QUEST_NEAR_NOTE), 'and she is beside V when V answers');
});

test('the partner tone has one source: the bond line carries none, relationshipContext and the closing reminder do', () => {
  for (const row of LEVELS) assert.doesNotMatch(bondLine(row.level, 0), /pet name|couple|missed V/);
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal((source.match(/block\('closing'/g) ?? []).length, 2, 'two closing blocks, the partner reminder and the pet name note (bridge/pet-names.mjs), never one from the bond');
  assert.match(source, /block\('closing', admitted && !input\.reaction && prepared\.route\.channel !== 'group' \? petNameNote\(ownReplyMemory\.get\(input\.profileKey\)\) : ''\)/);
  assert.match(source, /block\('closing', admitted && !input\.reaction \? romanceReminder\(prepared\.relationship, prepared\.route\.channel\) : ''\)/);
  assert.match(source, /return \{romance, near: besideV\(input\)\}/);
});

// ---- the fixed lines of a reach-out -------------------------------------------------------------------------------------------------------

const triggerOf = extra => ({id: 'xx-one', via: 'text', text: 'Come by the garage.', after: [{kind: 'bond', level: 3}], ...extra});
const filesFor = trigger => [{data: {format: 1, character: 'panam-palmer', triggers: [trigger]}}];

test('a partner gets the partnerText of a trigger, anyone else the plain text', () => {
  const make = trigger => new ReachOuts({files: filesFor(trigger), log() {}});
  const listed = (romance, trigger) => {
    const reach = make(trigger);
    const block = reach.eligible({enabled: true, gameSeconds: 40 * DAY, journalHistory: journal(DONE), levels: {'panam-palmer': 5}, talkedAt: {}, romance: romance ? {'panam-palmer': romance} : {}, finishedPacks: new Set(), busy: new Set()});
    return block.items.map(item => item.text);
  };
  const both = triggerOf({partnerText: 'Come by the garage, babe. I want you around.'});
  assert.deepEqual(listed('partner', both), ['Come by the garage, babe. I want you around.']);
  assert.deepEqual(listed('casual', both), ['Come by the garage.']);
  assert.deepEqual(listed(null, both), ['Come by the garage.']);
  assert.deepEqual(listed('partner', triggerOf()), ['Come by the garage.'], 'no partnerText: the plain text for everyone');
});

test('partnerText is validated like text and does not go with a relationship field', () => {
  const check = trigger => validateReachFile({format: 1, character: 'panam-palmer', triggers: [trigger]}, {characters: roster});
  assert.equal(check(triggerOf({partnerText: 'Come by, babe.'})).ok, true);
  assert(check(triggerOf({partnerText: 'Come by; now.'})).errors.some(error => /partnerText.*semicolon/.test(error)));
  assert(check(triggerOf({partnerText: 'Come by — now.'})).errors.some(error => /partnerText.*dash/.test(error)));
  assert(check(triggerOf({partnerText: 'x'.repeat(300)})).errors.some(error => /partnerText/.test(error)));
  assert(check(triggerOf({partnerText: 'Come by, babe.', relationship: 'partner'})).errors.some(error => /partnerText and relationship/.test(error)));
});

test('the shipped partner lines: every hangout invitation of a character V can romance has a warmer line, and they are all fit to read', () => {
  const by = Object.fromEntries(shippedReachFiles().map(row => [row.data.character, row.data]));
  for (const character of ['panam-palmer', 'judy-alvarez', 'river-ward', 'kerry-eurodyne']) {
    const offers = by[character].triggers.filter(item => item.offer);
    assert(offers.length >= 5, character);
    for (const item of offers) {
      assert.equal(typeof item.partnerText, 'string', `${item.id} has a partnerText`);
      assert.notEqual(item.partnerText, item.text, item.id);
      assert.equal(textProblem(item.partnerText, 240), null, item.id);
    }
    assert.deepEqual(validateReachFile(by[character], {characters: roster}).errors, [], character);
  }
  for (const character of ['jackie-welles', 'viktor-vektor', 'takemura', 'songbird', 'rogue-amendiares', 'johnny-silverhand']) {
    assert(by[character].triggers.every(item => item.partnerText === undefined), `${character} has no romance to speak of`);
  }
});

test('turn context beside V: a phone turn of a character within a few metres is in person (main\'s rule), which the quest note builds on', () => {
  const text = describeTurnContext(turn(30 * DAY, true)).text;
  assert.match(text, /You are with V in person, right next to V/);
  assert.match(text, /never ask V to come over/);
  assert.doesNotMatch(describeTurnContext(turn(30 * DAY, false)).text, /right next to V/);
});

test('the offline eval (scripts/Eval-BesideInvite.mjs) builds the real prompts for a quest invitation and a reach-out, beside V and far away, and finds the rule where it belongs', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/Eval-BesideInvite.mjs', import.meta.url))], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /quest beside V .*ok/);
  assert.match(run.stdout, /reach far away .*ok/);
});
