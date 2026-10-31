// A pack that begins on the phone or a holocall (docs/QUEST_PRIMITIVES.md section 11, bridge/quest-rendezvous.mjs and bridge/bond-pack-runner.mjs): the stages that need her
// in person, what she is told about meeting V, V's answer on the same remote channel read against the stage's talk gap, the travel allowance on the stage clock, the
// means of getting her to V in the play file, and the packs this touches. Offline: the real packs, the real runner, no game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BondPacks} from './bond-pack-runner.mjs';
import {shippedPacks, validatePack} from './bond-packs.mjs';
import {inPerson, rendezvousSpecs, travelGrace, TRAVEL_GRACE_HOURS} from './quest-rendezvous.mjs';
import {intentKind} from './bond-intent.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const DAY = 86400, HOUR = 3600;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const roster = new Set(JSON.parse(read('../characters/roster.json')).map(row => row.key));
const packs = Object.fromEntries(shippedPacks().map(({pack}) => [pack.id, pack]));
const school = packs['panam-driving-school'];

function journal(rows, {complete = true} = {}) {
  const coverage = {status: complete ? 'complete' : 'partial', ageSeconds: 1, windowSeconds: 30, observed: rows.length, omitted: complete ? 0 : 3, unstable: false};
  return parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'},
    coverage: {active: coverage, history: coverage},
    quests: rows.map(([path, state], index) => ({id: String(100 + index), nativeId: path.slice(path.lastIndexOf('/') + 1), nativePath: path, title: 'Quest ' + index,
      state, lane: state === 'active' ? 'active' : 'history', observedAtMs: 1000, objectivesComplete: state !== 'active', objectives: []}))});
}
const PANAM_DONE = [['quests/side_quest/sq004_riders_on_the_storm', 'succeeded']];
const T0 = 40 * DAY;

let counter = 0;
const holocall = {version: 1, contact: 'panam-palmer', mode: 'audio'};
/** A turn of V's: `how` is 'holocall', 'phone' or 'own' (one of V's own copies beside V). */
const turn = (how, gameSeconds, text = 'hey', extra = {}, bondsBlock = {}) => ({requestId: `q-${++counter}`, profileKey: 'panam-palmer', name: 'Panam', text, entity: 'e1',
  turnContext: {gameTime: gameSeconds}, journalHistory: journal(PANAM_DONE),
  ...(how === 'holocall' ? {holocall} : how === 'phone' ? {channel: 'phone'} : {}),
  bonds: {on: true, copy: how === 'own' ? 'party' : null, packs: true, invitations: true, ...bondsBlock}, ...extra});
const make = (options = {}) => {
  const lines = [], files = new Map();
  const runner = new BondPacks({packs: [school], characters: roster, random: () => 0, log: line => lines.push(line), write: async (file, text) => { files.set(file, text); },
    read: async file => { if (!files.has(file)) throw new Error('none'); return files.get(file); }, path: 'packs.json', effectsPath: 'effects.json', debounceMs: 0, ...options});
  runner.on = true;
  return {runner, lines, files};
};
/** One turn through the runner as the bridge makes it: the context is built, then the reply is published. */
const talk = (runner, input, facts = {level: 6}) => {
  const decision = runner.forTurn(input, facts);
  runner.afterTurn(input, undefined);
  return decision;
};
const current = runner => runner.playState().quests.find(quest => quest.pack === 'panam-driving-school');
const stageOf = runner => runner.entries.get('panam-driving-school')?.trail.at(-1);

test('the stages that need her in person are found from the pack data: own lines and the gap they lead to, a ride, a hangout seat; not a stage that makes her appear itself or a meeting', () => {
  const dare = inPerson(school, school.stages[0]);
  assert.equal(dare.needs, true);
  assert.equal(dare.gapId, 'g1', 'the gap opens after her second line, which follows the first');
  assert.equal(dare.place, 'meet', 'the place its pin marks');
  assert.deepEqual(dare.why, ['own-lines', 'gap']);
  const run = inPerson(school, school.stages[1]);
  assert.equal(run.needs, true);
  assert.equal(run.gapId, null);
  assert.equal(run.party, true, 'a ride needs her in the party');
  assert.equal(run.place, 'meet', 'meetAt names the camp where she waits');
  // A stage that places her itself (Kerry's boat stage casts him at the pier) still needs her in person, but has its own way of getting her there. A stage with a meeting, a
  // call and a stage with nothing to do need nothing.
  const tokyo = packs['kerry-tomorrow-tokyo'], pier = inPerson(tokyo, tokyo.stages[0]);
  assert.equal(pier.needs, true);
  assert.equal(pier.placed, true);
  assert.equal(pier.gapId, 'g1');
  assert.deepEqual(rendezvousSpecs(tokyo, tokyo.stages[0]), []);
  // The first stage of sunset coffee is a text and a pin: her greeting waits for V's arrival, so nothing is needed at its start, the walk after it needs her beside V.
  assert.equal(inPerson(packs['panam-sunset-coffee'], packs['panam-sunset-coffee'].stages[0]).needs, false);
  assert.equal(inPerson(packs['panam-sunset-coffee'], packs['panam-sunset-coffee'].stages[1]).needs, true);
  assert.equal(inPerson(packs['judy-dinner-dress'], packs['judy-dinner-dress'].stages[0]).needs, false);
  assert.equal(inPerson(packs['panam-truck-ransom'], packs['panam-truck-ransom'].stages[0]).needs, false);
  assert.equal(inPerson(null, null).needs, false);
  // A gap that opens after a text row is delivered to the phone: nobody has to be beside V.
  const text = structuredClone(school.stages[0]);
  text.script = [{when: 'stage:enter', text: 'P3.dare.01'}, {when: 'line:P3.dare.01:done', gap: 'g1'}];
  const viaText = inPerson(school, {...text, do: [{p: 'pin', at: 'meet'}]});
  assert.equal(viaText.gapId, null);
  assert.equal(viaText.needs, false);
  // A bark is not an opening line, and a line she says on the call is not an in-person line.
  const phoneLines = structuredClone(school);
  phoneLines.lines['P3.dare.01'].channel = 'holocall'; phoneLines.lines['P3.dare.02'].channel = 'holocall';
  assert.equal(inPerson(phoneLines, phoneLines.stages[0]).needs, false);
});

test('a stage that casts her itself: the note names the place without offering to come over and her question waits for the game gap', () => {
  const tokyo = packs['kerry-tomorrow-tokyo'];
  const {runner} = make({packs: [tokyo]});
  const input = turn('holocall', T0, 'hey', {profileKey: 'kerry-eurodyne', journalHistory: journal([['quests/side_quest/sq028_kerry_romance', 'succeeded']])});
  const start = talk(runner, input, {level: 9});
  assert(start.start, 'the pack starts');
  assert.match(start.note, /Tell V to come to the marina pier where Kerry's boat is moored\./);
  assert.doesNotMatch(start.note, /offer to come over|Ask V this/);
  assert.equal(runner.entries.get('kerry-tomorrow-tokyo').trail[0].grace, TRAVEL_GRACE_HOURS * HOUR, 'the clock is stretched all the same');
  // V's yes on the call is not read against the gap: the game opens it once he is at the pier.
  const reply = {...turn('holocall', T0 + 60, 'yes, i will be there at dusk', {profileKey: 'kerry-eurodyne', journalHistory: input.journalHistory}), requestId: 'k2'};
  talk(runner, reply, {level: 9});
  assert.equal(runner.entries.get('kerry-tomorrow-tokyo').trail.at(-1).stage, 'ask');
});

test('the pack still validates with meetAt, and meetAt must name a place of the pack', () => {
  assert.deepEqual(validatePack(school, {characters: roster}).errors, []);
  const bad = structuredClone(school);
  bad.stages[1].meetAt = 'nowhere';
  assert(validatePack(bad, {characters: roster}).errors.some(error => /meetAt must name a place of the pack/.test(error)));
  const odd = structuredClone(school);
  odd.stages[0].do.push({p: 'cast', id: 'tom', who: 'self', at: 'meet', ifAbsent: 'yes'});
  assert(validatePack(odd, {characters: roster}).errors.some(error => /cast\.ifAbsent must be true or false/.test(error)));
});

test('V\'s "you\'re on" is a yes, and "you are on the wrong road" and "you\'re on your own" are not', () => {
  assert.equal(intentKind('you\'re on. 500 eddies says i beat your time on the kids\' route', ['yes', 'no']), 'yes');
  assert.equal(intentKind('ok, you are on!', ['yes', 'no']), 'yes');
  assert.equal(intentKind('you are on the wrong road', ['yes', 'no']), null);
  assert.equal(intentKind('you\'re on your own', ['yes', 'no']), 'no');
  assert.equal(intentKind('game on', ['yes', 'no']), 'yes');
});

test('begun on a holocall: the bring-up asks the question and tells V where to meet her; V\'s answer on the call takes the bet and moves the pack on', () => {
  const {runner, lines} = make();
  const start = talk(runner, turn('holocall', T0));
  assert.equal(start.start.pack.id, 'panam-driving-school');
  assert.match(start.note, /clan kids' route through the Badlands/, 'the bring-up');
  assert.match(start.note, /only with V on this call/);
  assert.match(start.note, /Tell V to come to the camp at Rocky Ridge where the trucks are parked, or offer to come over to where V is instead/);
  assert.match(start.note, /Ask V this, in your own words, before anything else: "What's it going to be, a bet or are you scared\?"/);
  assert(lines.some(line => /started on holocall \(stage dare\)/.test(line)));
  assert.equal(stageOf(runner).grace, TRAVEL_GRACE_HOURS * HOUR, 'the first stage was entered remotely');
  // The next turn: she knows she asked, and V takes the bet. The pack moves to the ride without anybody having said the opening lines in the game.
  const second = turn('holocall', T0 + 120, 'you\'re on. 500 eddies says i beat your time on the kids\' route');
  const note = runner.forTurn(second, {level: 6}).note;
  assert.match(note, /You have just asked V: "What's it going to be, a bet or are you scared\?" Once V has answered, do not ask it again\./);
  assert.doesNotMatch(note, /Ask V this, in your own words/);
  runner.afterTurn(second, undefined);
  assert.equal(stageOf(runner).stage, 'run');
  assert.equal(stageOf(runner).choice, 'bet');
  assert(lines.some(line => /gap g1 tag bet/.test(line)), lines.join('\n'));
  assert(lines.some(line => /stage=run via bet/.test(line)));
  assert.equal(stageOf(runner).grace, TRAVEL_GRACE_HOURS * HOUR, 'she still has to be got to V for the ride');
  // The ride note keeps telling V to come to the camp and asks nothing (no gap on this stage).
  const ride = runner.forTurn(turn('holocall', T0 + 240), {level: 6}).note;
  assert.match(ride, /Tell V to come to the camp/);
  assert.doesNotMatch(ride, /Ask V this/);
  assert.doesNotMatch(ride, /You have just asked V/);
});

test('V refusing on the call ends it as the pack says, an unclear answer leaves the question open, and nothing is read on the turn that brought it up', () => {
  const {runner} = make();
  const first = turn('phone', T0, 'you\'re on, whatever it is');
  talk(runner, first);
  assert.equal(stageOf(runner).stage, 'dare', 'the words that came with the bring-up do not answer it');
  talk(runner, turn('phone', T0 + 60, 'hmm what are the stakes'));
  assert.equal(stageOf(runner).stage, 'dare');
  talk(runner, turn('phone', T0 + 120, 'no way, i am busy'));
  assert.equal(runner.entries.get('panam-driving-school').status, 'done');
  assert.equal(runner.entries.get('panam-driving-school').trail.at(-1).stage, 'chicken');
});

test('the stage clock does not punish V for the way to her: the timeout comes later by the travel allowance, and still comes', () => {
  const {runner} = make();
  talk(runner, turn('holocall', T0));
  // The stage's own timeout is 2 game hours, raised to the 6 of a first stage (chicken), and the way to her adds 6. Three hours later V is still on the way.
  talk(runner, turn('holocall', T0 + 3 * HOUR, 'on my way'));
  assert.equal(stageOf(runner).stage, 'dare', 'not timed out after 3 hours');
  talk(runner, turn('holocall', T0 + 11 * HOUR, 'still on my way'));
  assert.equal(stageOf(runner).stage, 'dare', 'not timed out after 11 hours (6 + 6 are 12)');
  assert.equal(current(runner).timeoutAt, T0 + 12 * HOUR, 'the game is told the same moment');
  talk(runner, turn('holocall', T0 + 12 * HOUR + 60, 'hello?'));
  assert.equal(runner.entries.get('panam-driving-school').trail.at(-1).stage, 'chicken');
});

test('begun in person nothing changes: no meeting talk, no question in the note, no allowance, and V\'s words are not read against a gap the game has not opened', () => {
  const {runner} = make();
  const start = talk(runner, turn('own', T0));
  assert.doesNotMatch(start.note, /only with V|Tell V to come|Ask V this/);
  assert.equal(stageOf(runner).grace, undefined);
  assert.deepEqual(current(runner).do.map(spec => spec.p), ['pin'], 'a stage entered in person gets nothing added to its primitives');
  talk(runner, turn('own', T0 + 60, 'you\'re on'));
  assert.equal(stageOf(runner).stage, 'dare', 'the game opens the gap after her lines, then the bridge reads it');
  // Even the game's own gap works as before.
  runner.noteEvent({pack: 'panam-driving-school', serial: 1, name: 'gap:g1:open', at: T0 + 70});
  talk(runner, turn('own', T0 + 90, 'you\'re on'));
  assert.equal(stageOf(runner).stage, 'run');
  assert.equal(stageOf(runner).grace, undefined, 'entered by a word in person');
});

test('she is beside V while V writes: the near note stands and nothing about meeting is added', () => {
  const {runner} = make();
  const start = talk(runner, turn('phone', T0), {level: 6, near: true});
  assert.doesNotMatch(start.note, /Tell V to come|Ask V this|only with V/);
  assert.match(start.note, /right beside you/);
  assert.equal(stageOf(runner).grace, undefined);
  talk(runner, turn('phone', T0 + 60, 'you\'re on'), {level: 6, near: true});
  assert.equal(stageOf(runner).stage, 'dare', 'near: the game plays the stage, the bridge does not read it from here');
});

test('with Immersive invitations off she does not offer to come over, and with no place and no invitations she says V should find her', () => {
  const {runner} = make();
  const start = talk(runner, turn('holocall', T0, 'hey', {}, {invitations: undefined}));
  assert.match(start.note, /Tell V to come to the camp at Rocky Ridge where the trucks are parked\./);
  assert.doesNotMatch(start.note, /offer to come over/);
  const noPlace = structuredClone(school);
  delete noPlace.stages[0].do; noPlace.stages[0].do = [{p: 'party'}];
  const other = make({packs: [noPlace]});
  const bare = talk(other.runner, turn('holocall', T0, 'hey', {}, {invitations: undefined}));
  assert.match(bare.note, /Tell V to come and find you\./);
  const only = make({packs: [noPlace]});
  assert.match(talk(only.runner, turn('holocall', T0)).note, /Offer to come over to where V is, and let V arrange it in V's own words\./);
});

test('the play file: the stage the pack wrote plus the means of getting her to V, the allowance in the timeout, and it survives a restart of the bridge', async () => {
  const {runner, files} = make();
  talk(runner, turn('holocall', T0));
  const dare = current(runner);
  assert.deepEqual(dare.do.map(spec => spec.p), ['pin', 'cast']);
  assert.deepEqual(dare.do[0], {p: 'pin', at: 'meet'}, 'the pack\'s own pin is not doubled');
  assert.equal(dare.do[1].ifAbsent, true);
  assert.equal(dare.places.meet.name, 'the camp at Rocky Ridge where the trucks are parked');
  assert.equal(dare.timeoutAt, T0 + 12 * HOUR);
  talk(runner, turn('holocall', T0 + 60, 'sure, you\'re on'));
  const run = current(runner);
  assert.equal(run.stage, 'run');
  assert.deepEqual(run.do.map(spec => spec.p), ['ride', 'pin', 'cast', 'party']);
  assert.deepEqual(Object.keys(run.places).sort(), ['bridge', 'meet', 'ramp', 'riverbed', 'sunset', 'turbines']);
  assert.equal(run.timeoutAt, T0 + 60 + 8 * HOUR);
  await runner.flush();
  const again = make({read: async file => files.get(file)}).runner;
  await again.load();
  assert.equal(again.entries.get('panam-driving-school').trail.at(-1).grace, TRAVEL_GRACE_HOURS * HOUR);
  assert.equal(again.playState().quests[0].timeoutAt, T0 + 60 + 8 * HOUR);
  // Her hands: a stage entered in person is not stretched, and an earlier clock rewinds past the allowance too.
  const rewound = make().runner;
  talk(rewound, turn('holocall', T0));
  talk(rewound, turn('holocall', T0 + 60, 'sure, you\'re on'));
  rewound.rewind(T0 - 100);
  assert.equal(rewound.entries.get('panam-driving-school').trail.at(-1).stage, 'dare');
  assert.equal(rewound.entries.get('panam-driving-school').trail.at(-1).grace, TRAVEL_GRACE_HOURS * HOUR);
});

test('a hangout with its place swapped keeps the allowance place right: the rendezvous place goes through the same swap', () => {
  const hangouts = shippedPacks().map(row => row.pack).filter(pack => pack.kind === 'hangout' && pack.hangout?.variations?.some(item => item.places));
  for (const pack of hangouts) {
    const stage = pack.stages[0], found = inPerson(pack, stage);
    if (!found.needs || !found.place || found.placed) continue;
    const {runner} = make({packs: [pack]});
    for (const variation of pack.hangout.variations) {
      const entry = {status: 'active', trail: [{stage: stage.id, at: T0, grace: TRAVEL_GRACE_HOURS * HOUR}], presented: true, beat: null, variation: variation.id};
      runner.entries.set(pack.id, entry);
      const quest = runner.playState().quests.find(item => item.pack === pack.id);
      const cast = quest.do.find(spec => spec.id === 'rendezvous');
      assert(cast, pack.id);
      assert(quest.places[cast.at], `${pack.id} ${variation.id}: the place ${cast.at} is in the play file`);
    }
  }
});

test('every shipped pack: the analysis never throws, every rendezvous place is a place of the pack, and the packs this touches are the ones with a stage that waits for her', () => {
  const affected = [];
  for (const pack of Object.values(packs)) {
    for (const stage of pack.stages) {
      const found = inPerson(pack, stage);
      for (const spec of rendezvousSpecs(pack, stage)) if (spec.at !== undefined) assert(pack.places?.[spec.at], `${pack.id} ${stage.id}: ${spec.at}`);
      if (found.needs && pack.start.channels.some(channel => channel === 'phone' || channel === 'holocall')) affected.push(`${pack.id}:${stage.id}`);
      if (found.needs && found.gapId) assert(pack.gaps[found.gapId].tags?.length || true);
    }
  }
  const ids = new Set(affected.map(item => item.split(':')[0]));
  for (const id of ['panam-driving-school', 'panam-convoy-home', 'jackie-drink', 'jackie-sticky-fingers', 'kerry-first-string', 'kerry-guinevere-race', 'kerry-incognito',
    'river-off-the-clock', 'river-open-window', 'takemura-look-twice', 'takemura-pincers', 'viktor-third-card']) assert(ids.has(id), `${id} is among the packs that wait for her`);
  // The packs that make her appear themselves (sunset coffee, judy's door duty, kerry's caliente) are in the list, but get no cast or pin added and no question asked on the phone.
  for (const id of ['panam-sunset-coffee', 'judy-door-duty', 'kerry-caliente']) {
    const first = inPerson(packs[id], packs[id].stages[0]);
    assert.equal(first.placed, true, id);
    assert.deepEqual(rendezvousSpecs(packs[id], packs[id].stages[0]).filter(spec => spec.p !== 'party'), [], id);
  }
});

test('an unfinished journal read on a turn: the gate is shut, no dice are thrown and no turn is counted toward the next roll', () => {
  const {runner} = make();
  const meta = () => runner.meta.get('panam-palmer');
  const partial = turn('own', T0, 'hey', {journalHistory: journal(PANAM_DONE, {complete: false})});
  const decision = runner.forTurn(partial, {level: 6});
  assert.equal(decision?.start ?? null, null);
  assert.equal(meta()?.rolls ?? 0, 0, 'no roll spent');
  assert.equal(meta()?.idle ?? 1, 1, 'and the counter toward the next roll did not move (it starts at ROLL_EVERY_TURNS - 1)');
  // The next turn, with the journal complete, rolls at once and starts the pack.
  const full = talk(runner, turn('own', T0 + 30));
  assert.equal(full.start?.pack.id, 'panam-driving-school');
});
