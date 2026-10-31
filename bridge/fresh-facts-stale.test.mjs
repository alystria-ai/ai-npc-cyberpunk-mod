// Fresh facts, second round (docs/FRESH_FACTS.md "The second drinks test"). Live 2026-10-27: V asked Claire "am i drunk" with Flesh and Chrome at drinks 3 and every Dark Future stage 0, and she said
// "No, you're not drunk. You're just exhausted." Her history held two earlier "Not drunk, just wired" and her memory two notes made from those answers ("energy levels fluctuate ... drained").
// The fact was in the prompt at both ends; the character's own earlier wrong answers outweighed it. They are now left out, and one log line says what each prompt carried.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {parseMods, modsStale, modsCodes} from './mod-state.mjs';
import {freshNote, PersonaBook, buildMessages} from './mistral-prompt.mjs';
import {TextProviderHost, localRoute} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {drinksLiveCase, CLAIRE_HISTORY, CLAIRE_MEMORY} from '../scripts/fresh-facts-eval/scenarios.mjs';

const READS = {darkFuture: 'installed=yes read=ok stage=hydration0,nutrition0,energy0,nerve0', fleshAndChrome: 'installed=yes read=ok state=breath0,energy0,drinks3,smoke0'};
const DRUNK = parseMods({fleshAndChrome: {drinks: 3}, darkFuture: {hydration: 0, nutrition: 0, energy: 0, nerve: 0}});
const stale = (mods, form = 'person', reads = READS) => { const source = modsStale(mods, form, reads); return source ? text => new RegExp(source, 'iu').test(text) : () => false; };

test('what a reply would say that the game read the opposite of: the denial of the drink, and tiredness, thirst and hunger that were read as fine', () => {
  const old = stale(DRUNK);
  for (const text of ['Not drunk, just wired.', 'No, you’re not drunk. You’re just exhausted.', 'You’re not even drunk.', 'You aren’t that drunk', 'You are sober as a judge.',
    'V’s energy levels fluctuate unpredictably, leaving them visibly drained', 'You look worn out.', 'You must be parched.', 'Hungry?']) assert.ok(old(text), text);
  for (const text of ['You smell like a bar.', 'You are drunk, choom.', 'Quiet night.', 'Want another one?', 'V’s habit of wearing Thermal Mantis Blades feels like a comfort routine.']) assert.ok(!old(text), text);
});

test('a state that is notable is never stale, and a need the game did not read is never judged', () => {
  const exhausted = parseMods({fleshAndChrome: {drinks: 3, energy: 4}, darkFuture: {energy: 4}});
  assert.ok(!stale(exhausted)('You are exhausted.'), 'a true "exhausted" stays');
  assert.ok(stale(exhausted)('You are not drunk.'));
  const unread = {darkFuture: undefined, fleshAndChrome: READS.fleshAndChrome};
  assert.ok(!stale(DRUNK, 'person', unread)('You look hungry and parched.'), 'hunger and thirst were not read: never judged');
  assert.ok(stale(DRUNK, 'person', unread)('You look tired.'));
  assert.equal(modsStale(DRUNK, 'person', undefined), String.raw`\b(?:(?:not|\w+n['’]t|never|no longer)\s+(?:\w+\s+)?(?:drunk|tipsy|drinking)|sober|stone cold)`, 'with no reads only the denial of the drink');
  assert.equal(modsStale(DRUNK, 'phone', READS), '', 'a phone or a call is told nothing');
  // Sobered up (drinks read as 0): saying V is drunk is what is stale.
  const sober = stale(undefined, 'person', {fleshAndChrome: 'installed=yes read=ok state=breath0,energy0,drinks0,smoke0'});
  assert.ok(sober('You are drunk, choom.'));
  assert.ok(!sober('Quiet night.'));
});

test('codes for the log are names and stages only', () => {
  assert.deepEqual(modsCodes(DRUNK, 'person'), ['drinks:3']);
  assert.deepEqual(modsCodes(parseMods({fleshAndChrome: {breath: 2, drinks: 2}}), 'person'), ['breath:2', 'drinks:2']);
  assert.deepEqual(modsCodes(DRUNK, 'phone'), []);
  assert.deepEqual(modsCodes(undefined, 'person'), []);
});

test('the live case rebuilt from Claire’s real memory file: her own earlier denials and the notes made from them are not sent; the fact is at both ends', () => {
  const before = drinksLiveCase('am i drunk', {noDrop: true});
  assert.deepEqual(before.messages.map(row => row.role[0]).join(''), 'suauauau', 'the live prompt: three poisoned exchanges');
  assert.match(before.messages.at(-1).content, /energy levels fluctuate/, 'and the remembered notes');
  const now = drinksLiveCase('am i drunk');
  assert.equal(now.messages.map(row => row.role[0]).join(''), 'su');
  const text = JSON.stringify(now.messages);
  assert.doesNotMatch(text, /wired|exhaust|drained|fumes/i);
  assert.match(now.messages.at(-1).content, /Thermal Mantis Blades feels like a comfort routine/, 'a remembered fact that says nothing contrary stays');
  assert.ok(now.messages.at(-1).content.includes('TRUE RIGHT NOW: V is drunk. If V asks whether they are drunk, the answer is yes: slurring, unsteady on their feet, reeking of booze.'));
  assert.ok(now.messages.at(-1).content.includes('[RIGHT NOW, TRUE: V is drunk. If V asks whether they are drunk, the answer is yes: slurring, unsteady on their feet, reeking of booze.]\n\nV says: am i drunk'));
  assert.equal(freshNote(now.messages), 'facts=drinks:3 placed=context-end,before-v asked=yes dropped=history:3,memory:2');
  assert.equal(freshNote(before.messages), 'facts=drinks:3 placed=context-end,before-v asked=yes dropped=history:0,memory:0');
  assert.equal(CLAIRE_HISTORY.length, 3); assert.equal(CLAIRE_MEMORY.length, 3);
  // Nothing else says tired when no stage does (the block states what was read as fine).
  assert.match(now.messages.at(-1).content, /Otherwise V is fed, rested, not thirsty, not winded and steady\./);
});

test('not asked about oneself: nothing is left out, and the log says so', () => {
  const chat = drinksLiveCase('Another one, please.');
  assert.equal(chat.messages.map(row => row.role[0]).join(''), 'suauauau');
  assert.equal(freshNote(chat.messages), 'facts=none placed=none asked=no dropped=history:0,memory:0');
  assert.equal(freshNote(chat.messages, {quiet: true}), '', 'quiet: an ordinary turn writes no log line');
});

test('freshNote: nothing for a message list with no note, the placement of a profile that puts the notes after V\'s line', () => {
  assert.equal(freshNote([]), '');
  assert.equal(freshNote(undefined), '');
  const messages = buildMessages({persona: new PersonaBook([]).persona('x', 'X'), history: [], context: 'c', contextParts: {now: '', notes: '', world: '', volatile: 'v', fresh: 'V is naked.', freshCodes: 'clothes:changed', freshAsked: true}, text: 'hi'});
  assert.equal(freshNote(messages), 'facts=clothes:changed placed=context-end,before-v asked=yes dropped=history:0,memory:0');
});

test('the bridge log: one [FreshFacts] line per prompt of a text provider, codes and counts only, none for a reaction', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = ''; request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: 'You are drunk, choom.'}}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
  await provider.load(); provider.setPreference('local'); provider.apply();
  const llama = {status: () => ({state: 'ready', tier: 'lite', model: 'Test model'}), touch() {}, prewarm: async () => {}, ensure: async () => ({endpoint, apiKey: 'session-key-abcdef123456', model: 'Test model', tier: 'lite'})};
  const logs = [];
  const roster = [{key: 'claire-russell', name: 'Claire Russell', backstory: 'I tend the bar.', speakingStyleDescription: 'Brisk.', speakingStyleSampleDialogues: 'Hi.'}];
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: new PersonaBook(roster), routes: {local: localRoute({server: llama, provider})}, log: line => logs.push(line)});
  const turn = (text, parts = {}, extra = {}) => ({text, context: 'x', sessionId: 's1', local: {profileKey: 'claire-russell', name: 'Claire Russell', channel: 'private'},
    contextParts: {now: 'Right now: you are with V in person.', notes: '', world: 'w', volatile: 'v', ...parts}, ...extra});
  try {
    await host.reply(turn('Another round', {}));
    await host.reply(turn('do i seem drunk', {fresh: 'V is drunk: slurring.', freshDrop: String.raw`\bwired`, freshCodes: 'drinks:3', freshAsked: true}));
    const lines = logs.filter(line => line.startsWith('[FreshFacts]'));
    assert.deepEqual(lines, ['[FreshFacts] profile=claire-russell facts=drinks:3 placed=context-end,before-v asked=yes dropped=history:0,memory:0'], 'the ordinary first turn writes nothing');
    assert.ok(requests.at(-1).messages.at(-1).content.includes('TRUE RIGHT NOW: V is drunk: slurring.'));
    // The exchange the character answered "You are drunk, choom." has no "wired" in it: kept. A pattern that matches it drops it, and the log counts it.
    await host.reply(turn('am i drunk', {fresh: 'V is drunk: slurring.', freshDrop: String.raw`\bchoom`, freshCodes: 'drinks:3', freshAsked: true}));
    assert.equal(logs.filter(line => line.startsWith('[FreshFacts]')).at(-1), '[FreshFacts] profile=claire-russell facts=drinks:3 placed=context-end,before-v asked=yes dropped=history:2,memory:0');
    assert.ok(logs.filter(line => line.startsWith('[FreshFacts]')).every(line => !/drunk|slurring|choom/.test(line.replace(/drinks:3/, ''))), 'no text in the log');
  } finally { host.close(); server.closeAllConnections?.(); await new Promise(done => server.close(done)); }
});
