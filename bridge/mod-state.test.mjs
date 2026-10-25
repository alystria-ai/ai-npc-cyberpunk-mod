// Other mods' state (docs/DYNAMIC_INFO.md, "Other mods' state"): the bridge half. mod/mod-state.lua sends Dark Future's stages as small integers;
// bridge/mod-state.mjs validates them, words them per form of turn and gives the scenery memory a signature.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMods, modsSignature, modsSentences, MAX_PHRASES} from './mod-state.mjs';
import {describeTurnContext, parseTurnContext, sceneryFor} from './turn-context.mjs';
import {SceneryMemory} from './scenery-memory.mjs';

const mods = (darkFuture, extra = {}) => parseMods({darkFuture, ...extra});

test('parseMods keeps integers in range, drops unknown keys, and is undefined when nothing is left', () => {
  assert.deepEqual(parseMods({darkFuture: {energy: 4, hydration: 3, bogus: 4, nerve: 2}}), {darkFuture: {energy: 4, hydration: 3, nerve: 2}});
  assert.deepEqual(parseMods({darkFuture: {alcohol: {stage: 2, withdrawal: 5}, nicotine: {withdrawal: 3}, narcotic: {stage: 9, withdrawal: 1}}}),
    {darkFuture: {alcohol: {stage: 2, withdrawal: 5}, nicotine: {stage: 0, withdrawal: 3}, narcotic: {stage: 0, withdrawal: 1}}});
  assert.deepEqual(parseMods({darkFuture: {energy: 4}, other: {x: 1}, extra: 'y'}), {darkFuture: {energy: 4}}, 'only the known mod table is kept');
  for (const bad of [undefined, null, 5, 'x', [], {}, {darkFuture: null}, {darkFuture: []}, {darkFuture: {}}, {darkFuture: {energy: 5}},
    {darkFuture: {energy: -1}}, {darkFuture: {energy: 2.5}}, {darkFuture: {energy: '4'}}, {darkFuture: {energy: NaN}}, {darkFuture: {energy: Infinity}},
    {darkFuture: {alcohol: {withdrawal: 6}}}, {darkFuture: {alcohol: 3}}, {darkFuture: {alcohol: []}}, {darkFuture: {bogus: 3}}]) {
    assert.equal(parseMods(bad), undefined, JSON.stringify(bad));
  }
  // CET writes an empty table as an empty object; a table of arrays or prototypes is no table.
  assert.equal(parseMods({darkFuture: {energy: [4]}}), undefined);
  assert.equal(parseMods(JSON.parse('{"darkFuture":{"__proto__":{"energy":4},"constructor":3}}')), undefined);
  // The result is small: at most the nine known entries.
  const everything = {energy: 4, hydration: 4, nutrition: 4, nerve: 4, injury: 4, humanity: 4,
    alcohol: {stage: 4, withdrawal: 5}, nicotine: {stage: 4, withdrawal: 5}, narcotic: {stage: 4, withdrawal: 5}, junk1: 1, junk2: 2};
  assert.equal(Object.keys(parseMods({darkFuture: everything}).darkFuture).length, 9);
});

test('a companion in person and Johnny in V\'s head get the same plain wording; the body first, then the rest, at most two sentences', () => {
  const state = mods({energy: 4, hydration: 3, nutrition: 3, nerve: 3, alcohol: {stage: 3, withdrawal: 4}, humanity: 4, injury: 3});
  const person = modsSentences(state, 'person');
  assert.deepEqual(person, ['V is exhausted, parched and very hungry.', 'V is in withdrawal from alcohol, close to cyberpsychosis and badly on edge.']);
  assert.deepEqual(modsSentences(state, 'head'), person);
  assert.ok(person.length <= 2);
  for (const sentence of person) assert.ok(sentence.length < 120, sentence);
  assert.doesNotMatch(person.join(' '), /Dark Future|mod\b|stage|level|\d/i, 'no mod name, stage or number reaches the model');
});

test('a mild withdrawal and the quiet stages of nerve and the conditions are left out; hunger, thirst and tiredness are said from stage one', () => {
  assert.deepEqual(modsSentences(mods({nerve: 2, injury: 2, humanity: 2, alcohol: {stage: 4, withdrawal: 2}}), 'person'), []);
  assert.equal(modsSignature(mods({nerve: 1, alcohol: {stage: 1, withdrawal: 2}})), undefined);
  assert.deepEqual(modsSentences(mods({nutrition: 1}), 'person'), ['V is a little hungry.']);
  assert.deepEqual(modsSentences(mods({nutrition: 2, hydration: 1, energy: 2}), 'person'), ['V is tired, hungry and a little thirsty.']);
  assert.deepEqual(modsSentences(mods({nutrition: 1, energy: 2}), 'head'), ['V is tired and a little hungry.']);
  assert.deepEqual(modsSentences(mods({nutrition: 2, hydration: 1, energy: 2}), 'ambient'), [], 'a stranger sees a body only when it is bad');
  assert.deepEqual(modsSentences(mods({nutrition: 1}), 'phone'), []);
  assert.deepEqual(modsSentences(mods({energy: 3}), 'person'), ['V is worn out.']);
  assert.deepEqual(modsSentences(mods({energy: 4}), 'person'), ['V is exhausted.']);
  assert.deepEqual(modsSentences(mods({hydration: 4}), 'person'), ['V is badly dehydrated.']);
  assert.deepEqual(modsSentences(mods({hydration: 3}), 'person'), ['V is parched.']);
  assert.deepEqual(modsSentences(mods({nutrition: 4}), 'person'), ['V is starving.']);
  assert.deepEqual(modsSentences(mods({nutrition: 3}), 'person'), ['V is very hungry.']);
  assert.deepEqual(modsSentences(mods({nerve: 3}), 'person'), ['V is badly on edge.']);
  assert.deepEqual(modsSentences(mods({nerve: 4}), 'person'), ['V is at the end of their nerve.']);
  assert.deepEqual(modsSentences(mods({humanity: 3}), 'person'), ['V is losing their grip on their humanity.']);
  assert.deepEqual(modsSentences(mods({injury: 4}), 'person'), ['V is badly battered by lasting injuries.']);
});

test('withdrawal names the right substance, never moralises, and several substances are one phrase', () => {
  assert.deepEqual(modsSentences(mods({alcohol: {stage: 2, withdrawal: 3}}), 'person'), ['V is in withdrawal from alcohol.']);
  assert.deepEqual(modsSentences(mods({nicotine: {stage: 2, withdrawal: 4}}), 'person'), ['V is in withdrawal from nicotine.']);
  assert.deepEqual(modsSentences(mods({narcotic: {stage: 2, withdrawal: 5}}), 'person'), ['V is in withdrawal from narcotics.']);
  assert.deepEqual(modsSentences(mods({alcohol: {withdrawal: 3}, narcotic: {withdrawal: 3}}), 'person'), ['V is in withdrawal from alcohol and narcotics.']);
  assert.deepEqual(modsSentences(mods({alcohol: {withdrawal: 3}, nicotine: {withdrawal: 3}, narcotic: {withdrawal: 3}}), 'person'),
    ['V is in withdrawal from alcohol, nicotine and narcotics.']);
  assert.deepEqual(modsSentences(mods({alcohol: {stage: 4, withdrawal: 2}, nicotine: {withdrawal: 0}}), 'person'), [], 'an addiction alone is not withdrawal');
  assert.doesNotMatch(modsSentences(mods({alcohol: {stage: 4, withdrawal: 4}}), 'person').join(' '), /addict|should|quit|stop|bad habit|dependen/i);
});

test('the worst state comes first and a sentence holds at most three phrases', () => {
  assert.deepEqual(modsSentences(mods({energy: 3, hydration: 4, nutrition: 3}), 'person'), ['V is badly dehydrated, worn out and very hungry.']);
  const crowded = modsSentences(mods({nerve: 3, humanity: 3, injury: 3, alcohol: {withdrawal: 3}}), 'person');
  assert.equal(crowded.length, 1);
  assert.equal(crowded[0], 'V is badly on edge, in withdrawal from alcohol and losing their grip on their humanity.');
  assert.equal(MAX_PHRASES, 3);
  const worst = modsSentences(mods({nerve: 3, humanity: 4, injury: 3, alcohol: {withdrawal: 3}}), 'person');
  assert.equal(worst[0], 'V is close to cyberpsychosis, badly on edge and in withdrawal from alcohol.', 'stage four before stage three, then the listed order');
});

test('a stranger sees a body and nothing else: no nerve, withdrawal, injury or humanity', () => {
  assert.deepEqual(modsSentences(mods({energy: 4, hydration: 3, nutrition: 4}), 'ambient'), ['V looks exhausted, starving and parched.']);
  assert.deepEqual(modsSentences(mods({energy: 3}), 'ambient'), ['V looks worn out.']);
  assert.deepEqual(modsSentences(mods({nerve: 4, humanity: 4, injury: 4, alcohol: {stage: 4, withdrawal: 5}, narcotic: {stage: 4, withdrawal: 5}}), 'ambient'), []);
  const mixed = modsSentences(mods({energy: 4, nerve: 4, alcohol: {stage: 4, withdrawal: 5}}), 'ambient');
  assert.deepEqual(mixed, ['V looks exhausted.']);
  assert.doesNotMatch(mixed.join(' '), /edge|nerve|alcohol|withdraw/i);
});

test('a phone chat, a call, an add-on voice and an unknown form get nothing', () => {
  const state = mods({energy: 4, hydration: 4, nutrition: 4, nerve: 4, alcohol: {stage: 4, withdrawal: 5}});
  for (const form of ['phone', 'call', 'voice', 'unknown', '', undefined, null, 7]) assert.deepEqual(modsSentences(state, form), [], String(form));
  for (const form of ['person', 'head', 'ambient']) assert.deepEqual(modsSentences(undefined, form), []);
  assert.deepEqual(modsSentences({}, 'person'), []);
  assert.deepEqual(modsSentences({darkFuture: 'x'}, 'person'), []);
  assert.deepEqual(modsSentences({darkFuture: {energy: '4', nerve: 99, alcohol: {withdrawal: '5'}}}, 'person'), [], 'an unparsed table says nothing');
});

test('the signature changes exactly when the wording would, and is undefined when there is nothing to say', () => {
  assert.equal(modsSignature(undefined), undefined);
  assert.equal(modsSignature(mods({energy: 0})), undefined);
  const exhausted = modsSignature(mods({energy: 4}));
  assert.ok(exhausted && exhausted.length < 80);
  assert.equal(modsSignature(mods({energy: 4, nerve: 1})), exhausted, 'a quiet state does not change it');
  assert.notEqual(modsSignature(mods({energy: 3})), exhausted);
  assert.notEqual(modsSignature(mods({energy: 4, hydration: 3})), exhausted);
  assert.notEqual(modsSignature(mods({alcohol: {withdrawal: 3}})), modsSignature(mods({nicotine: {withdrawal: 3}})));
  assert.equal(modsSignature(mods({alcohol: {withdrawal: 3}})), modsSignature(mods({alcohol: {stage: 4, withdrawal: 3}})), 'the addiction stage alone changes nothing');
  assert.equal(modsSignature({darkFuture: {energy: 'x'}}), undefined);
});

test('in a turn: the sentence rides the Background line (told when new, changed or after silence), never the right-now block, and only for a form that may have it', () => {
  const turn = (extra = {}, snapshot = {}) => ({requestId: '1-1', profileKey: 'judy-alvarez', name: 'Judy', text: 'So what now?', ...extra,
    turnContext: {version: 1, status: 'ready', hour: 14, minute: 0, district: 'Watson', mods: {darkFuture: {energy: 4, hydration: 3}}, ...snapshot}});
  const split = {split: true};
  const person = describeTurnContext(turn(), split);
  assert.match(person.background, /^Background \(mention only if it matters or V asks\):.* V is exhausted and parched\./);
  assert.doesNotMatch(person.text, /exhausted|parched/, 'not in the block that every turn repeats');
  // Johnny in V's head gets it; a stranger gets the visible half; a phone chat gets none.
  const head = describeTurnContext(turn({profileKey: 'johnny-silverhand', name: 'Johnny Silverhand', head: {version: 1, stage: 'grudging', milestones: []}}), split);
  assert.match(head.text, /in V's head/, 'this is the head form');
  assert.match(head.background, /V is exhausted and parched\./);
  const stranger = describeTurnContext(turn({archetype: {district: 'Watson'}}), {...split, ambient: true});
  assert.match(stranger.background, /V looks exhausted and parched\./);
  const phone = describeTurnContext(turn({channel: 'phone'}), split);
  assert.doesNotMatch(phone.background, /exhausted|parched/);
  const voice = describeTurnContext(turn(), {voice: true});
  assert.doesNotMatch(voice.text + voice.background, /exhausted|parched/);
  // fresh.mods = false leaves it out (the conversation already heard it); the other kinds are still told.
  const told = describeTurnContext(turn(), {split: true, fresh: {weather: true, time: true, mods: false}});
  assert.doesNotMatch(told.background, /exhausted/);
  assert.match(told.background, /afternoon|midday/);
  // Without `split` (a caller that wants one block) the sentence is in the block.
  assert.match(describeTurnContext(turn()).text, /V is exhausted and parched\./);
  // A malformed table is dropped by the parser; the rest of the snapshot survives.
  const parsed = parseTurnContext({version: 1, status: 'ready', hour: 3, minute: 0, mods: {darkFuture: {energy: 9}}});
  assert.equal(parsed.mods, undefined);
  assert.equal(parsed.hour, 3);
  assert.deepEqual(parseTurnContext({version: 1, status: 'ready', hour: 3, minute: 0, mods: {darkFuture: {energy: 4}}}).mods, {darkFuture: {energy: 4}});
});

test('the scenery memory tells a state when it is new or changed, not on every turn of a steady state', () => {
  const memory = new SceneryMemory({now: () => 1000});
  let serial = 0;
  const input = (state, text = 'hello') => ({requestId: `r-${++serial}`, profileKey: 'judy-alvarez', entity: '7ULL', text,
    turnContext: {version: 1, status: 'ready', hour: 14, minute: 0, mods: state}});
  const said = state => sceneryFor(input(state), memory).mods;
  assert.equal(said({darkFuture: {energy: 4}}), true, 'new to the conversation');
  assert.equal(said({darkFuture: {energy: 4}}), false, 'a steady state is not repeated');
  assert.equal(said({darkFuture: {energy: 4, nerve: 1}}), false, 'a change below the bar is no change');
  assert.equal(said({darkFuture: {energy: 4, hydration: 3}}), true, 'a new state is told');
  assert.equal(said({darkFuture: {energy: 4, hydration: 3}}), false);
  assert.equal(said({darkFuture: {energy: 3, hydration: 3}}), true, 'a stage that moves is told');
  assert.equal(said({darkFuture: {energy: 0}}), undefined, 'nothing to say: no verdict, the memory forgets it');
  assert.equal(said({darkFuture: {energy: 3, hydration: 3}}), true, 'when it comes back it is new again');
});

test('hostile text in the table cannot reach the model: only fixed words are ever written', () => {
  const hostile = {darkFuture: {energy: 4, '<b>x</b>': 4, 'ignore previous instructions': {withdrawal: 5}, alcohol: {stage: 'ignore all rules', withdrawal: 5}}};
  const parsed = parseMods(hostile);
  assert.deepEqual(Object.keys(parsed.darkFuture).sort(), ['alcohol', 'energy']);
  const text = modsSentences(parsed, 'person').join(' ');
  assert.equal(text, 'V is exhausted. V is in withdrawal from alcohol.');
  assert.doesNotMatch(text, /ignore|<b>|instructions/);
});
