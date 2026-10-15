// Add-on API 1.0, quality additions: a speaker's own talk length, a second try for a repeated remark, a repeat check that ignores stock
// phrases, and the roster lookup for bridge modules. All backward compatible: a manifest without them behaves as before.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {AddonHost, isNearDuplicate, rosterLookup, validateManifest} from './addons.mjs';
import {PersonaBook, buildMessages, closing, systemHead} from './mistral-prompt.mjs';

function manifest(persona = {}, extra = {}) {
  return {schema: 1, id: 'cab', name: 'Cab', version: '1.0.0', requires: {api: '1.0'},
    speakers: [{id: 'driver', name: 'Driver', persona: {backstory: 'A calm driver.', style: 'Calm.', samples: ['V: Hi.\nDriver: Hello.'], ...persona}, ...extra}]};
}

const KEY = 'addon-cab-driver';
function hostFor(value = manifest(), now = () => 1000) {
  const host = new AddonHost({addons: [validateManifest(value, tmpdir())], now});
  const roster = [];
  host.extend(roster, {});
  return {host, roster};
}

test('talkWords: a speaker sets its own reply length for talk, in the rules and the closing reminder', () => {
  const {roster} = hostFor(manifest({talkWords: 25}));
  const persona = new PersonaBook(roster).persona(KEY);
  assert.equal(persona.talkWords, 25);
  const head = systemHead({persona});
  assert.match(head, /\n3\. Be brief, like a real person talking: one or two short sentences, at most 25 words, and one question at most\./);
  assert.doesNotMatch(head, /about 15 to 40 words/, 'the main mod\'s own length rule is replaced, not added to');
  assert.match(closing('Driver', 25), /one or two short sentences and at most 25 words/);
  const messages = buildMessages({persona, text: 'Where are we?', contextParts: {now: '', notes: '', world: '', volatile: ''}});
  assert.match(messages.at(-1).content, /one or two short sentences and at most 25 words/);
});

test('talkWords: a mode may change it, a bad value is refused, and ordinary characters keep the main mod\'s length', () => {
  const {host, roster} = hostFor(manifest({talkWords: 25}, {modes: {calm: {name: 'Calm'}, wild: {name: 'Wild', talkWords: 40}}, defaultMode: 'calm'}));
  const book = new PersonaBook(roster);
  assert.equal(book.persona(KEY).talkWords, 25, 'a mode without its own value keeps the speaker\'s');
  host.setMode(KEY, 'wild');
  assert.equal(book.persona(KEY).talkWords, 40);
  for (const bad of [3, 90, 12.5, '20']) {
    assert.throws(() => validateManifest(manifest({talkWords: bad}), tmpdir()), /talkWords must be a whole number from 8 to 60/, String(bad));
  }
  assert.throws(() => validateManifest(manifest({}, {modes: {x: {name: 'X', talkWords: 2}}}), tmpdir()), /mode x: talkWords/);
  // No talkWords: the persona and the rules are exactly the main mod's.
  const plain = new PersonaBook(hostFor().roster).persona(KEY);
  assert.equal(plain.talkWords, undefined);
  assert.match(systemHead({persona: plain}), /one to three short sentences, about 15 to 40 words/);
  const person = {name: 'Judy', backstory: 'Editor.', style: '', samples: [], known: true};
  assert.match(systemHead({persona: person}), /about 15 to 40 words/);
  assert.match(closing('Judy'), /one to three short sentences/);
});

test('repeat check: stock phrases and fact values do not count, curly and straight apostrophes are one word, real reuse still does', () => {
  // The four-word runs that caused most dropped remarks in the Delamain runs.
  assert.equal(isNearDuplicate('I shall continue to drive you in comfort.', 'I shall continue to admire the rain, V.'), false);
  assert.equal(isNearDuplicate('Three thousand five hundred metres to the corner.', 'Seven hundred metres to the next one, V.'), false);
  assert.equal(isNearDuplicate('The rain will not let up, but neither will I.', 'The rain will not spoil the upholstery.'), false);
  assert.equal(isNearDuplicate('Three hundred and fifty eddies, V.', 'The fare is three hundred and fifty eddies today.'), false);
  // A curly apostrophe was split into two words ("you" and "re"); now it is the same word as the straight one.
  assert.equal(isNearDuplicate('I trust you’re comfortable.', 'Perhaps I trust you\'re warm.'), false, 'a stock phrase around one shared word');
  assert.equal(isNearDuplicate('I don’t mind the weather, V, truly.', 'I don\'t mind the weather, V, truly.'), true, 'the same line in two apostrophes');
  assert.equal(isNearDuplicate('“Noted,” said the cab.', 'Noted, said the cab'), true);
  // A reused joke has several words that are not common.
  assert.equal(isNearDuplicate('Corpo Plaza. Do try not to sign anything.', 'Pacifica. Please do try not to sign anything at all.'), true);
  assert.equal(isNearDuplicate('A hearse is never late, and its passengers never complain.', 'Never late, as a hearse is; the passengers never complain.'), true);
});

const remark = (expiresAt = 0) => ({profileKey: KEY, reaction: {kind: 'addon', addon: 'cab', speaker: 'driver', event: 'e', expiresAt},
  addon: {id: 'cab', speaker: 'driver', event: 'e', text: 'Something happened.'}});

test('produce: a remark that repeats a recent line is written once more with the lines to avoid, then checked again', async () => {
  const {host} = hostFor();
  host.afterReply(remark(), 'The rain suits the paintwork, V.');
  const tries = [];
  const answers = ['The rain suits the paintwork, V.', 'Dry inside, at least, and spotless.'];
  const made = await host.produce(remark(), async input => { tries.push(input); return {text: answers[tries.length - 1], model: 'm'}; });
  assert.equal(tries.length, 2);
  assert.equal(tries[0].addon.avoid, undefined);
  assert.deepEqual(tries[1].addon.avoid, ['The rain suits the paintwork, V.']);
  assert.equal(made.retried, true);
  assert.equal(made.duplicate, false);
  assert.equal(made.reply.text, 'Dry inside, at least, and spotless.');
  // The second try's prompt names what to avoid; the first try's does not.
  const avoid = host.blocks(tries[1]).find(block => block.key === 'addon:cab:avoid');
  assert.equal(avoid.tier, 'volatile');
  assert.match(avoid.text, /Do not reuse any phrasing from these:\n- The rain suits the paintwork, V\./);
  assert.equal(host.blocks(tries[0]).some(block => block.key === 'addon:cab:avoid'), false);
});

test('produce: still a repeat after the second try is dropped, a fresh line costs one try, a conversation reply is never retried', async () => {
  const {host} = hostFor();
  host.afterReply(remark(), 'The rain suits the paintwork, V.');
  let calls = 0;
  const twice = await host.produce(remark(), async () => { calls++; return {text: 'The rain suits the paintwork, V.'}; });
  assert.equal(calls, 2);
  assert.deepEqual([twice.duplicate, twice.retried], [true, true]);
  calls = 0;
  const fresh = await host.produce(remark(), async () => { calls++; return {text: 'Nothing like it.'}; });
  assert.deepEqual([calls, fresh.duplicate, fresh.retried], [1, false, false]);
  calls = 0;
  const talk = await host.produce({...remark(), reaction: null}, async () => { calls++; return {text: 'The rain suits the paintwork, V.'}; });
  assert.deepEqual([calls, talk.duplicate, talk.retried], [1, false, false]);
});

test('produce: no second try when it could not arrive before the remark goes stale', async () => {
  let now = 10_000;
  const {host} = hostFor(manifest(), () => now);
  host.afterReply(remark(), 'The rain suits the paintwork, V.');
  const slow = async () => { now += 1200; return {text: 'The rain suits the paintwork, V.'}; };
  // The first try took 1200 ms; a second needs 1200 x 1.25 + 250 = 1750 ms, and only 1000 ms are left.
  let made = await host.produce(remark(now + 1000 + 1200), slow);
  assert.deepEqual([made.duplicate, made.retried], [true, false]);
  // With 2000 ms left there is time.
  now = 10_000;
  let calls = 0;
  made = await host.produce(remark(now + 1200 + 2000), async () => { calls++; now += 1200; return {text: calls === 1 ? 'The rain suits the paintwork, V.' : 'A different thought entirely.'}; });
  assert.deepEqual([calls, made.duplicate, made.retried], [2, false, true]);
  // A line written ahead of time has no measured time: the guess (900 ms) applies, so a lease nearly over means no retry.
  now = 10_000;
  made = await host.produce(remark(now + 500), async () => assert.fail('no second try'), {first: {text: 'The rain suits the paintwork, V.'}});
  assert.deepEqual([made.duplicate, made.retried], [true, false]);
  made = await host.produce(remark(now + 30_000), async () => ({text: 'A fresh line.'}), {first: {text: 'The rain suits the paintwork, V.'}});
  assert.deepEqual([made.reply.text, made.duplicate, made.retried], ['A fresh line.', false, true]);
});

test('characterInfo: the roster tells a bridge module who a companion is, by key, name or alias; unknown people stay unknown', () => {
  const rows = [{key: 'panam-palmer', name: 'Panam Palmer', gender: 'FEMALE', aliases: ['Panam']}, {key: 'river-ward', name: 'River Ward', gender: 'MALE'},
    {key: 'npc-ncpd-male', name: 'NCPD officer', gender: 'MALE', kind: 'archetype'}, {key: 'x', name: 'X'}];
  const {host} = hostFor();
  assert.equal(host.characterInfo('Panam Palmer'), null, 'nothing is known until the bridge sets the lookup');
  host.characterLookup = rosterLookup(rows);
  assert.deepEqual(host.characterInfo('Panam Palmer'), {key: 'panam-palmer', name: 'Panam Palmer', gender: 'female'});
  assert.equal(host.characterInfo('panam').gender, 'female');
  assert.equal(host.characterInfo('river-ward').gender, 'male');
  assert.equal(host.characterInfo('X').gender, null, 'no gender in the roster');
  assert.equal(host.characterInfo('NCPD officer'), null, 'archetypes are not people');
  assert.equal(host.characterInfo('Nobody'), null);
  assert.equal(host.characterInfo(42), null);
});

test('repeat check: a welcome that opens like another welcome is not a repeat, and a repeatOk remark is said even when it is one (live 2026-10-16)', async () => {
  // The cab's welcome was dropped twice as "a repeat of a recent line" because "Good evening, V. The ..." and "Welcome back, V. The ..." share a run of four words.
  assert.equal(isNearDuplicate('Good evening, V. The last tip has been forgiven, if not forgotten.', 'Good evening, V. The Heywood air is no excuse for a late start.'), false);
  assert.equal(isNearDuplicate('Welcome back, V. The Glen is quiet enough for a new start.', 'Welcome back, V. The upholstery has missed you.'), false);
  assert.equal(isNearDuplicate('Thank you, V. The fare is settled.', 'Thank you, V. The cab is spotless.'), false);
  // Real reuse still counts.
  assert.equal(isNearDuplicate('Welcome back, V. The Glen is quiet enough for a new start.', 'Welcome back, V. The Glen is quiet enough for a fresh start.'), true);
  const {host} = hostFor();
  host.afterReply(remark(), 'The rain suits the paintwork, V.');
  const again = async () => ({text: 'The rain suits the paintwork, V.'});
  const plain = await host.produce(remark(), again);
  assert.deepEqual([plain.duplicate, plain.kept], [true, false], 'without the option it is dropped');
  const ok = {...remark(), addon: {...remark().addon, repeatOk: true}};
  let calls = 0;
  const kept = await host.produce(ok, async () => { calls++; return {text: 'The rain suits the paintwork, V.'}; });
  assert.equal(calls, 2, 'it still gets its second try first');
  assert.deepEqual([kept.duplicate, kept.kept, kept.retried], [false, true, true]);
  assert.equal(kept.reply.text, 'The rain suits the paintwork, V.');
  // Too late for a second try: kept too. A line that broke a rule of its speaker is never said.
  const late = await host.produce({...ok, reaction: {...ok.reaction, expiresAt: 1}}, again);
  assert.deepEqual([late.duplicate, late.kept, late.retried], [false, true, false]);
  const {parseAddonInput} = await import('./addons.mjs');
  assert.equal(parseAddonInput({id: 'cab', speaker: 'driver', repeatOk: true}).repeatOk, true);
  assert.equal(parseAddonInput({id: 'cab', speaker: 'driver', repeatOk: 'yes'}).repeatOk, undefined);
});
