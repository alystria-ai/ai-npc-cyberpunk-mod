// The pilot quest "Coffee at the Sunset" (characters/bond-packs/panam-sunset-coffee.json) played end to end without the game: the pack runner, the quest link and the files
// between them, with the game's side simulated by hand (the events it would report). Covers the start, every stage, the talk gap read from V's words, the endings with their
// closing rows, the history line, the stage timeout, a lost position, rollback, and the play file the game reads. The game's own half is tested in bridge/quest-*-lua.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BondPacks} from './bond-pack-runner.mjs';
import {QuestLink} from './quest-link.mjs';
import {shippedPacks, validatePack} from './bond-packs.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const DAY = 86400, HOUR = 3600;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const roster = new Set(JSON.parse(read('../characters/roster.json')).map(row => row.key));
const pilot = shippedPacks().map(row => row.pack).find(pack => pack.id === 'panam-sunset-coffee');

function journal(rows) {
  const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: rows.length, omitted: 0, unstable: false};
  return parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'},
    coverage: {active: coverage, history: coverage},
    quests: rows.map(([path, state], index) => ({id: String(100 + index), nativeId: path.slice(path.lastIndexOf('/') + 1), nativePath: path, title: 'Quest ' + index,
      state, lane: state === 'active' ? 'active' : 'history', observedAtMs: 1000, objectivesComplete: state !== 'active', objectives: []}))});
}
const DONE = [['quests/main_quest/act_01/q104_02_av_chase', 'succeeded']];
let counter = 0;
const turn = (gameSeconds, extra = {}, bondsBlock = {}) => ({requestId: `r-${++counter}`, profileKey: 'panam-palmer', name: 'Panam', text: 'hey', entity: 'e1',
  turnContext: {gameTime: gameSeconds}, journalHistory: journal(DONE), bonds: {on: true, copy: 'party', packs: true, invitations: true, ...bondsBlock}, ...extra});

function make() {
  const log = [], awards = [], files = {};
  const bonds = {award: (key, points) => awards.push([key, points]), publish() {}};
  const runner = new BondPacks({packs: [pilot], characters: roster, random: () => 0, log: line => log.push(line), bonds, debounceMs: 0, path: 'packs.json',
    write: async (file, text) => { files[file] = text; }, exists: () => false});
  const events = {session: 'test-session', seq: 0, list: []};
  const played = [];
  const link = new QuestLink({packs: runner, readEvents: async () => JSON.stringify({version: 1, session: events.session, seq: events.seq, events: events.list}),
    writePlay: async text => { played.push(JSON.parse(text)); }, log: line => log.push('link ' + line)});
  // The game reports an event for the stage it is executing now.
  const game = async (name, at) => {
    const quest = runner.playState().quests[0];
    events.seq += 1;
    events.list.push({seq: events.seq, pack: 'panam-sunset-coffee', serial: quest?.serial, name, at});
    await link.poll();
    await link.sync();
  };
  const start = (t0 = 30 * DAY) => {
    const input = turn(t0);
    const decision = runner.forTurn(input, {level: 3});
    runner.afterTurn(input, 'ok');
    return decision;
  };
  const current = () => runner.playState().quests[0];
  return {runner, log, awards, files, played, link, game, start, current, events};
}

test('the pilot pack passes the validator, has a label on every stage and its positions still to be captured', () => {
  const result = validatePack(pilot, {characters: roster});
  assert.deepEqual(result.errors, []);
  for (const stage of pilot.stages) assert(stage.label, stage.id);
  assert(result.warnings.some(warning => /no position captured yet/.test(warning)), 'the places say they need capturing');
  assert(result.warnings.some(warning => /no prepared audio yet/.test(warning)), 'the lines say they have no audio yet');
  assert.equal(Object.values(pilot.lines).filter(line => line.text.includes(';')).length, 0);
});

test('it starts on a private turn with the bring-up note, and the first stage is in the play file with its places and lines, and no timeout', async () => {
  const {runner, current, link, played} = make();
  const t0 = 30 * DAY;
  const input = turn(t0);
  const decision = runner.forTurn(input, {level: 3});
  assert.match(decision.note, /Sunset Motel/);
  assert.equal(runner.questActive(), false, 'nothing yet: the turn has not been recorded');
  runner.afterTurn(input, 'ok');
  assert.equal(runner.questActive(), true);
  await link.sync();
  const file = played.at(-1), quest = file.quests[0];
  assert.equal(quest.pack, 'panam-sunset-coffee'); assert.equal(quest.stage, 'invite'); assert.equal(quest.serial, 1); assert.equal(quest.since, t0);
  assert.deepEqual(Object.keys(quest.places), ['sunset']);
  assert.deepEqual(quest.do.map(spec => spec.p), ['pin', 'place', 'cast']);
  assert.equal(quest.timeoutAt, undefined, 'a quest has no time limit: the play file carries no timeout');
  assert.equal(quest.lines['P1.invite.01'].text.startsWith('Motel coffee'), true);
  assert.equal(quest.lines['P1.walk.01'].emotion, 'happy');
  assert.deepEqual(quest.script.map(row => row.when), ['stage:enter', 'place:sunset:arrived']);
  assert.equal(quest.gap, null);
});

test('the whole quest, the warm way: arrive, walk, sit, the gap answered in V\'s words, leave', async () => {
  const {runner, game, start, current, awards, played, link, log} = make();
  const t0 = 30 * DAY;
  start(t0);
  await game('place:sunset:arrived', t0 + 600);
  assert.equal(current().stage, 'walk');
  assert.equal(current().serial, 2);
  assert.deepEqual(current().do.map(spec => spec.p), ['party', 'place', 'together']);
  assert.deepEqual(Object.keys(current().places), ['lookout']);
  // An event of the stage before is dropped.
  runner.noteEvent({pack: 'panam-sunset-coffee', serial: 1, name: 'place:sunset:arrived', at: t0 + 700});
  assert.equal(current().stage, 'walk');
  await game('place:lookout:arrived', t0 + 900);
  assert.equal(current().stage, 'walk', 'a place event only fires a row, it does not end the stage');
  await game('together:tour:done', t0 + 1900);
  assert.equal(current().stage, 'sit');
  await game('seat:seated', t0 + 2000);
  await game('line:P1.sit.01:done', t0 + 2010);
  await game('gap:g1:open', t0 + 2010);
  assert.deepEqual(current().gap, {id: 'g1', openedAt: t0 + 2010});
  assert.equal(runner.playState().quests[0].gaps.g1.resumeAfterSeconds, 900);
  // V answers, in person: the next turn carries the gap's note, and a real answer picks the "shared" tag.
  const reply = turn(t0 + 2100, {text: 'Honestly I would run a small repair garage in the Badlands, fix old trucks and not talk to anyone.'});
  const decision = runner.forTurn(reply, {level: 3});
  assert.match(decision.note, /You have just asked V: "So\. If you weren't running jobs/);
  assert.match(decision.note, /Sunset Motel at dawn/);
  assert(decision.note.length < 2000);
  runner.afterTurn(reply, reply.text);
  assert.equal(current().stage, 'last-sip-warm');
  assert.equal(current().gap, null);
  const commands = runner.playState().commands;
  assert.deepEqual(commands.map(command => command.cmd + ':' + (command.name ?? command.gap)), ['event:meet:met'].slice(0, 0).concat(['event:gap:g1:shared', 'resume:g1']));
  assert.equal(commands[0].serial, 3, 'commands carry the stage they were decided in');
  await link.sync();
  // She leaves: the ending, its closing rows and the lasting history.
  await game('place:sunset:left', t0 + 3600);
  assert.equal(runner.playState().quests.length, 0);
  const closing = runner.playState().closing[0];
  assert.equal(closing.ending, 'sunrise-shared');
  assert.deepEqual(closing.script, [{when: 'ending:sunrise-shared', text: 'P1.sunrise.01', image: 'sunset-coffee'}]);
  assert.equal(closing.lines['P1.sunrise.01'].text, 'Proof the view was worth it.');
  assert.deepEqual(closing.images['sunset-coffee'], {atlas: 'cyberpunk_convai\\phone_images\\panam_sunset_coffee_sunset_coffee.inkatlas', part: 'panam_sunset_coffee_sunset_coffee', width: 1024, height: 576});
  assert.deepEqual(awards, [['panam-palmer', 55]]);
  assert.equal(runner.questActive(), true, 'the closing rows are waiting for the game');
  assert(played.at(-1).closing.length === 1);
  // The scripted line request: the text comes from the pack, never from the request.
  assert.equal(runner.lineFor('panam-sunset-coffee', 'P1.sunrise.01').text, 'Proof the view was worth it.');
  assert.equal(runner.lineFor('panam-sunset-coffee', 'P1.sunrise.01').audioPath, null);
  assert.equal(runner.lineFor('panam-sunset-coffee', 'nope'), null);
  assert.equal(runner.lineFor('panam-truck-ransom', 'x'), null);
  // The next turn remembers it for good.
  const next = runner.forTurn(turn(t0 + 3 * DAY), {level: 4});
  assert.match(next.note, /What you and V have been through together: You and V have had motel mornings at the Sunset in Rocky Ridge, and V told you something real there\./);
  assert(!log.some(line => /failed/.test(line)), log.join('\n'));
});

test('the light way and the quiet way both end in the plain sunrise, and the timer of a gap ends it', async () => {
  const light = make();
  light.start();
  const t0 = 30 * DAY;
  await light.game('place:sunset:arrived', t0 + 10);
  await light.game('together:tour:done', t0 + 1000);
  await light.game('gap:g1:open', t0 + 1100);
  const joke = turn(t0 + 1150, {text: 'ok'});
  light.runner.forTurn(joke, {level: 3}); light.runner.afterTurn(joke, 'looks great');
  assert.equal(light.current().stage, 'last-sip');
  await light.game('place:sunset:left', t0 + 2000);
  assert.equal(light.runner.playState().closing[0].ending, 'sunrise');
  assert.deepEqual(light.awards, [['panam-palmer', 45]]);

  const quiet = make();
  quiet.start();
  await quiet.game('place:sunset:arrived', t0 + 10);
  await quiet.game('together:tour:done', t0 + 1000);
  await quiet.game('gap:g1:open', t0 + 1100);
  await quiet.game('gap:g1:resume', t0 + 2000);
  assert.equal(quiet.current().gap, null, 'the gap ended by its timer');
  assert.equal(quiet.current().stage, 'sit');
  await quiet.game('together:sunrise:done', t0 + 2100);
  assert.equal(quiet.current().stage, 'last-sip');
});

test('V walks off: the left ending, and V who never comes leaves the quest open (no cold-coffee ending, no time limit)', async () => {
  const t0 = 30 * DAY;
  const left = make();
  left.start();
  await left.game('place:sunset:arrived', t0 + 10);
  await left.game('together:tour:broken', t0 + 500);
  assert.equal(left.runner.playState().closing[0].ending, 'left');
  assert.deepEqual(left.runner.playState().closing[0].script, [{when: 'ending:left', say: 'P1.left.01'}]);
  assert.deepEqual(left.awards, [['panam-palmer', 15]]);

  const never = make();
  never.start();
  assert.equal(never.current().timeoutAt, undefined);
  await never.game('stage:timeout', t0 + 30 * DAY);
  assert.equal(never.current().stage, 'invite', 'a month later the coffee is still waiting');
  assert.deepEqual(never.runner.playState().closing, []);
  assert.deepEqual(never.awards, [], 'no penalty for time');
  assert.equal('cold-coffee' in pilot.endings, false, 'the cold-coffee ending went with the timeout that led to it');
});

test('the state follows the save: a load of an earlier clock rewinds the quest and drops its gap and history', async () => {
  const t0 = 30 * DAY;
  const a = make();
  a.start(t0);
  await a.game('place:sunset:arrived', t0 + 600);
  await a.game('together:tour:done', t0 + 1900);
  await a.game('gap:g1:open', t0 + 2010);
  assert.equal(a.current().stage, 'sit');
  a.runner.rewind(t0 + 700);
  assert.equal(a.current().stage, 'walk');
  assert.equal(a.current().gap, null);
  a.runner.rewind(t0 - 500);
  assert.equal(a.runner.playState().quests.length, 0, 'a quest that had not started by then is forgotten');
  assert.equal(a.runner.questActive(), false);
});

test('the quest link: events are handled once per session and sequence, a half-written file is read again, the play file is written only when it changed, and an idle service reads nothing', async () => {
  const t0 = 30 * DAY;
  const reads = [];
  const runner = new BondPacks({packs: [pilot], characters: roster, random: () => 0, debounceMs: 0, exists: () => false, write: async () => {}});
  let text = '';
  const wrote = [];
  const link = new QuestLink({packs: runner, readEvents: async () => { reads.push(1); return text; }, writePlay: async body => { wrote.push(body); }});
  assert.equal(link.active(), false);
  const input = turn(t0);
  runner.forTurn(input, {level: 3}); runner.afterTurn(input, 'ok');
  assert.equal(link.active(), true);
  assert.equal(await link.poll(), 0, 'no file');
  text = '{"version":1,"session":"s","seq":2,"events":[{"seq":1,"pack":"panam-sunset-coffee","serial":1,"name":"place:sunset:ar';
  assert.equal(await link.poll(), 0, 'half written');
  text = JSON.stringify({version: 1, session: 's', seq: 2, events: [{seq: 1, pack: 'panam-sunset-coffee', serial: 1, name: 'noise:one', at: t0 + 1}, {seq: 2, pack: 'panam-sunset-coffee', serial: 1, name: 'place:sunset:arrived', at: t0 + 2}]});
  assert.equal(await link.poll(), 2);
  assert.equal(await link.poll(), 0, 'the same file again');
  assert.equal(runner.playState().quests[0].stage, 'walk');
  text = text.replace('"session":"s"', '"session":"t"');
  assert.equal(await link.poll(), 2, 'a new game session starts its numbers again (the old serial no longer matches, so nothing moves)');
  assert.equal(runner.playState().quests[0].stage, 'walk');
  assert.equal(await link.sync(), true);
  assert.equal(await link.sync(), false, 'unchanged');
  assert.equal(wrote.length, 1);
  assert.equal(JSON.parse(wrote[0]).quests[0].stage, 'walk');
});

test('a play file with a gap open on restore, and the cost of building it', async () => {
  const t0 = 30 * DAY;
  const {runner, game, start} = make();
  start(t0);
  await game('place:sunset:arrived', t0 + 10);
  await game('together:tour:done', t0 + 100);
  await game('gap:g1:open', t0 + 200);
  const began = performance.now();
  for (let index = 0; index < 200; index++) runner.playState();
  assert((performance.now() - began) / 200 < 1, 'building the play file is under a millisecond');
  const state = runner.playState();
  assert.deepEqual(state.quests[0].gap, {id: 'g1', openedAt: t0 + 200});
  assert.equal(JSON.stringify(state).length < 6000, true);
});
