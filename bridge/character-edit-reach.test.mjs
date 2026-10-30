// What a player writes in the character editor has to reach the model (docs/CHARACTER_EDITOR_GUIDE.md): every text field, on every text provider and every model profile, on the very next
// turn, and neither a length cut nor an old answer in the chat may take it out (player report, Discord 31 Oct 2026: "sometimes I do modifications and it works, sometimes they seem not
// knowing"). These tests go through the real editor, the real persona book and the real text host, with a local server that only records the request.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {TextProviderHost, localRoute, customRoute, mistralRoute} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook, systemHead, buildMessages} from './mistral-prompt.mjs';
import {MatureContent} from './mature-content.mjs';
import {PromptProfiles} from './prompt-profile-store.mjs';
import {CharacterOverrides} from './character-overrides.mjs';
import {CharacterEditor} from './character-editor.mjs';
import {defaultProfile} from './prompt-profiles.mjs';
import {compactPersonaFor} from './compact-persona.mjs';
import {fitMessages, TokenMeter} from './prompt-budget.mjs';

const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const FACT = 'a tabby cat called Biscuit';
const SENTENCE = `You have ${FACT} that sleeps on your desk.`;

async function fakeServer() {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, {'content-type': 'text/event-stream'});
      for (const piece of 'Sure thing, V.'.match(/.{1,12}/gs)) response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {requests, endpoint: `${origin}/v1/chat/completions`, origin, close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
}
// kind: mistral | local (tier) | custom (model). `clock` is shared by the editor's store and the chat memory, so "before" and "after" a save are exact.
async function setup(kind, {tier = 'standard', model = 'qwen3-8b', clock = {t: 1_000_000}} = {}) {
  const llama = await fakeServer(), now = () => clock.t;
  const custom = kind === 'custom' ? {ready: true, local: true, origin: llama.origin, chatUrl: llama.endpoint, model, key: undefined} : null;
  const provider = new MistralProvider({keyPath: 'k.txt', custom, readText: async () => (kind === 'mistral' ? `api-key=${KEY}\n` : ''), writeText: async () => {}});
  await provider.load(); provider.setPreference(kind); provider.apply();
  const matureContent = new MatureContent(); matureContent.update({matureContent: false});
  const profiles = new PromptProfiles({active: () => (kind === 'custom' ? {route: 'custom', custom: {origin: llama.origin, model}} : kind === 'local' ? {route: 'local', tier} : {route: kind})});
  let route;
  if (kind === 'mistral') route = mistralRoute({provider, endpoint: llama.endpoint, gapMs: 0, cacheScope: 's'});
  else if (kind === 'local') {
    const server = {status: () => ({state: 'ready', tier, model: 'Test model'}), touch() {}, prewarm: async () => {}, ensure: async () => ({endpoint: llama.endpoint, apiKey: 'session-key-abcdef123456', model: 'Test model', tier})};
    route = localRoute({server, provider});
  } else route = customRoute({provider, custom});
  const overrides = await CharacterOverrides.open({dir: null, now});
  const personas = new PersonaBook(roster, {overrides, lean: true});
  const editor = new CharacterEditor({personas, overrides, route: () => kind});
  const memory = await MistralMemory.open({path: null, now});
  const host = new TextProviderHost({provider, memory, personas, routes: {[kind]: route}, matureContent, promptProfiles: profiles, log: () => {}});
  return {llama, host, editor, memory, overrides, personas, clock, close: async () => { host.close(); await llama.close(); }};
}
const turn = (text, key, name) => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 's1', local: {profileKey: key, name, channel: 'private'},
  contextParts: {now: 'Right now (from the game, this turn only): You are with V in person.', notes: 'Use {joy} tags.', world: 'Quest: Heist.', volatile: 'Your call whether to ask V anything.'}});
const ROUTES = [['mistral', {}], ['local', {tier: 'lite'}], ['local', {tier: 'standard'}], ['custom', {model: 'qwen3-8b'}], ['custom', {model: 'gemini-flash-lite-latest'}]];
const label = (kind, options) => [kind, options.tier, options.model].filter(Boolean).join(' ');
const CHARACTERS = [['judy-alvarez', 'Judy Alvarez'], ['alt-cunningham', 'Alt Cunningham'], ['johnny-silverhand', 'Johnny Silverhand'], ['npc-food-vendor-male', '']];

test('every text field of the editor reaches the very next request, on every provider and model profile, for the characters whose shipped text is longest and for an everyday person', async () => {
  const misses = [];
  for (const [key, name] of CHARACTERS) for (const [kind, options] of ROUTES) for (const field of ['bio-end', 'bio-start', 'style', 'rules', 'examples', 'memories']) {
    const t = await setup(kind, options);
    try {
      const shown = t.editor.details(key).values;
      const patch = {
        'bio-end': {bio: `${shown.bio}\n\n${SENTENCE}`}, 'bio-start': {bio: `${SENTENCE}\n\n${shown.bio}`}, style: {style: `${shown.style}\n${SENTENCE}`},
        rules: {rules: [SENTENCE]}, examples: {examples: [...shown.examples, `V: Any pets? / You: Yeah, ${FACT}.`]}, memories: {memories: [SENTENCE]}}[field];
      await t.editor.save(key, patch);
      await t.host.reply(turn('Do you have any pets?', key, name));
      if (!JSON.stringify(t.llama.requests.at(-1).messages).includes('Biscuit')) misses.push(`${key} ${label(kind, options)} ${field}`);
    } finally { await t.close(); }
  }
  assert.deepEqual(misses, []);
});

test('the Lite model\'s shorter character text cuts the shipped end of a long bio, never what the player added to it, and never the player\'s own example lines first', async () => {
  const t = await setup('local', {tier: 'lite'});
  try {
    const shown = t.editor.details('judy-alvarez').values;
    const mine = ['My editing room smells of ozone and cold coffee, and a tabby cat called Biscuit sleeps on the console. '.repeat(5).trim(), 'Biscuit hates loud music and hisses at strangers. '.repeat(6).trim()];
    const lines = ['V: Any pets? / You: Biscuit, a tabby. Do not ask me to move him.', 'V: Coffee? / You: Black, and do not touch the console.'];
    await t.editor.save('judy-alvarez', {bio: [shown.bio, ...mine].join('\n\n'), examples: [...shown.examples, ...lines]});
    await t.host.reply(turn('Do you have any pets?', 'judy-alvarez', 'Judy Alvarez'));
    const system = t.llama.requests.at(-1).messages[0].content;
    for (const text of [...mine, ...lines]) assert(system.includes(text), `kept: ${text.slice(0, 50)}`);
    assert(system.includes(shown.bio.slice(0, 300)), 'the start of the shipped bio is still there');
    assert(!system.includes(shown.bio), 'the shipped end made the room');
    // No shipped example line is kept once the room is short (they go first), the player's are.
    assert(!system.includes(shown.examples[0]));
  } finally { await t.close(); }
});

test('nothing changes for a character the player did not edit, and for one whose edit fits: the shipped paragraphs and example lines are all kept', async () => {
  const plain = new PersonaBook(roster, {lean: true});
  const profile = defaultProfile('local-lite');
  const before = systemHead({persona: plain.persona('judy-alvarez'), profile});
  const overrides = await CharacterOverrides.open({dir: null});
  const book = new PersonaBook(roster, {lean: true, overrides});
  const johnny = book.defaults('johnny-silverhand');
  await overrides.set('johnny-silverhand', {memories: ['V has a sister called Lena.'], bio: `${johnny.backstory}\n\nI like rain.`});
  const head = systemHead({persona: book.persona('johnny-silverhand'), profile});
  assert(head.includes('I like rain.') && head.includes('V has a sister called Lena.'));
  // An everyday person has room: a short addition leaves the shipped example lines in.
  const vendor = book.defaults('npc-food-vendor-male');
  await overrides.set('npc-food-vendor-male', {memories: ['V is a regular here.']});
  const vendorHead = systemHead({persona: book.persona('npc-food-vendor-male'), profile});
  assert(vendor.samples.length && vendorHead.includes(vendor.samples[0].replace(/\s*\n\s*/g, ' ')));
  assert.equal(systemHead({persona: book.persona('judy-alvarez'), profile}), before, 'an unedited character is byte for byte as before');
});

test('the compact text of a slow computer and the shortest levels of a small context keep the paragraphs the player added', async () => {
  const overrides = await CharacterOverrides.open({dir: null});
  const book = new PersonaBook(roster, {lean: true, overrides});
  const shipped = book.defaults('panam-palmer');
  const mine = 'MY ADDITION: Panam keeps a tabby cat called Biscuit in the Basilisk, and she talks to it when she thinks nobody hears.';
  await overrides.set('panam-palmer', {bio: `${shipped.backstory}\n\n${mine}`});
  const persona = book.persona('panam-palmer');
  assert.deepEqual(persona.bioEdits, [mine]);
  const compact = compactPersonaFor(persona, {});
  assert.notEqual(compact, persona);
  assert(compact.backstory.includes(mine), 'the compact text keeps the player\'s paragraph');
  assert(compact.backstory.length < persona.backstory.length * 0.7, 'and is still compact');
  const args = {persona, memory: '', history: [], contextParts: {now: 'Right now: You are with V in person.', notes: '', world: '', volatile: ''}, remembered: [], text: 'Hi.', mature: 'full'};
  const fit = await fitMessages({args, budget: {contextTokens: 4096, meter: new TokenMeter()}, shrinkPersona: true});
  assert(fit.trimmed.some(step => /^persona:\d+$/.test(step)), 'the persona was shortened');
  assert(fit.messages[0].content.includes(mine), 'the shortest levels keep it too');
});

test('a save leaves the chat before it out of the prompt, so an old answer cannot outvote the new fact; later exchanges are shown again', async () => {
  const clock = {t: 1_000_000};
  const t = await setup('custom', {clock});
  try {
    const key = 'judy-alvarez', name = 'Judy Alvarez';
    const history = () => t.llama.requests.at(-1).messages.slice(1, -1).map(message => message.content);
    t.memory.record({profileKey: key, channel: 'private', v: 'Do you have any pets?', r: 'Pets? No. No time for them, V.'});
    clock.t += 1000;
    await t.host.reply(turn('And a plant?', key, name));
    assert(history().includes('Pets? No. No time for them, V.'), 'with no edit the earlier answer is in the chat');
    clock.t += 1000;
    await t.editor.save(key, {memories: [SENTENCE]});
    clock.t += 1000;
    await t.host.reply(turn('So, any pets at all?', key, name));
    const request = t.llama.requests.at(-1).messages;
    assert(request[0].content.includes('- ' + SENTENCE));
    assert.deepEqual(history(), [], 'nothing from before the save is shown');
    assert.equal(t.memory.recall({profileKey: key, channel: 'private'}).turns.length, 3, 'the memory still has them (they reach the summary when they roll out)');
    clock.t += 1000;
    await t.host.reply(turn('What is his name?', key, name));
    assert.deepEqual(history(), ['So, any pets at all?', 'Sure thing, V.'], 'the exchange after the save is shown');
    // Another character keeps its chat, and so does one whose save changes nothing.
    t.memory.record({profileKey: 'panam-palmer', channel: 'private', v: 'Where to?', r: 'Out past the Badlands.'});
    clock.t += 1000;
    await t.host.reply(turn('And then?', 'panam-palmer', 'Panam Palmer'));
    assert(history().includes('Out past the Badlands.'));
    clock.t += 1000;
    await t.editor.save(key, {memories: [SENTENCE]});
    clock.t += 1000;
    await t.host.reply(turn('And his age?', key, name));
    assert(history().includes('What is his name?'), 'the same words saved again are no change');
    // A reset is a change too.
    clock.t += 1000;
    await t.editor.reset(key);
    clock.t += 1000;
    await t.host.reply(turn('Never mind the cat.', key, name));
    assert.deepEqual(history(), []);
  } finally { await t.close(); }
});

test('buildMessages leaves out the exchanges before a persona\'s editedAt for any caller, and only for a persona that carries the moment', () => {
  const persona = {name: 'Judy', backstory: 'I am Judy.', style: '', samples: [], editedAt: 500, known: true};
  const history = [{v: 'old question', r: 'old answer', at: 100}, {v: 'new question', r: 'new answer', at: 900}, {v: 'no time', r: 'unknown', at: undefined}];
  const text = buildMessages({persona, history, text: 'Hi.'}).map(message => message.content).join('\n');
  assert(!text.includes('old answer') && text.includes('new answer') && text.includes('unknown'));
  const without = buildMessages({persona: {...persona, editedAt: undefined}, history, text: 'Hi.'}).map(message => message.content).join('\n');
  assert(without.includes('old answer'));
});

test('the header of the hand-written memories tells the model to answer from them when V asks', () => {
  const head = systemHead({persona: {name: 'Judy', backstory: 'I am Judy.', style: '', samples: [], memories: [SENTENCE]}});
  assert.match(head, /WHAT YOU KNOW AND REMEMBER \(true\. If V asks about any of it, answer from it\./);
});
