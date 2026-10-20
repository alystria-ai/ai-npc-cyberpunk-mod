import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorldRules, WORLD_RULES_FILE, WORLD_RULES_HEADING, WORLD_RULES_LIMIT, convaiWorldRulesBlocks, validateWorldRules, worldRulesBlock, worldRulesContext} from './world-rules.mjs';
import {PersonaBook, buildMessages, systemHead, systemPrompt} from './mistral-prompt.mjs';
import {fitMessages, PERSONA_LEVELS} from './prompt-budget.mjs';
import {TextProviderHost, customRoute, localRoute, mistralRoute} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {CustomEndpoint, parseEndpointUrl} from './custom-endpoint.mjs';
import {CharacterOverrides} from './character-overrides.mjs';
import {CharacterEditor} from './character-editor.mjs';
import {EditorServer} from './character-editor-server.mjs';
import {MatureContent} from './mature-content.mjs';

const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const RULES = 'Nobody in Night City knows V’s name unless V tells them.\nEveryone speaks casually.';
const withRules = (text = RULES) => new PersonaBook(roster, {worldRules: {get: () => text}});
const dirOf = () => mkdtemp(join(tmpdir(), 'world-rules-'));
// The text of a Mistral key as the provider test of this repo uses it (a constant already in the tests, so no new key-shaped string).
const MISTRAL_KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';

const parts = (extra = {}) => ({now: 'You are with V in person. It is night, about 11 PM.', notes: 'Use {joy} tags for feelings.',
  world: 'Quest: Heist.\n\nV wears a jacket.', volatile: 'Whether you ask V anything is your own call.', ...extra});
const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON\nQuest facts here.', contextParts: parts(), sessionId: 'session-1',
  local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}, ...extra});

// ---- storage

test('the rules are stored in the data folder next to the character edits, and come back after a restart', async t => {
  const dir = await dirOf(); t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await WorldRules.open({dir});
  assert.equal(store.get(), '', 'no file: no rules');
  assert.equal(await store.set(`  ${RULES}  `), RULES);
  assert.deepEqual((await readdir(dir)).sort(), [WORLD_RULES_FILE]);
  const saved = JSON.parse(await readFile(join(dir, WORLD_RULES_FILE), 'utf8'));
  assert.equal(saved.version, 1); assert.equal(saved.text, RULES);
  const again = await WorldRules.open({dir});
  assert.equal(again.get(), RULES);
  assert.equal(again.block(), worldRulesBlock(RULES));
  // Cleared: the file is gone and nothing is left.
  assert.equal(await again.clear(), '');
  assert.deepEqual(await readdir(dir), []);
  assert.equal((await WorldRules.open({dir})).get(), '');
});

test('a text over the limit is refused and nothing changes; control characters and profile markers are tidied away', async t => {
  const dir = await dirOf(); t.after(() => rm(dir, {recursive: true, force: true}));
  const store = await WorldRules.open({dir});
  await store.set('Everyone speaks casually.');
  await assert.rejects(store.set('x'.repeat(WORLD_RULES_LIMIT + 1)), error => error.code === 'invalid' && error.errors[0].code === 'world-rules-long' && error.errors[0].max === WORLD_RULES_LIMIT);
  assert.equal(store.get(), 'Everyone speaks casually.');
  assert.equal(JSON.parse(await readFile(join(dir, WORLD_RULES_FILE), 'utf8')).text, 'Everyone speaks casually.');
  assert.equal((await store.set('x'.repeat(WORLD_RULES_LIMIT))).length, WORLD_RULES_LIMIT, 'exactly the limit is fine');
  assert.equal(validateWorldRules('A\u0007\r\n[CyberpunkConvai profile v2:x]\n\n\n\nB').text, 'A\n\nB');
  assert.equal(validateWorldRules(5).ok, false);
  assert.equal(validateWorldRules('   ').text, '', 'only blanks is an empty box');
});

test('a damaged file gives no rules, is left alone until the next save, and is then kept as .corrupt', async t => {
  const dir = await dirOf(); t.after(() => rm(dir, {recursive: true, force: true}));
  await writeFile(join(dir, WORLD_RULES_FILE), '{"version": 1, "text": ');
  const logs = [];
  const store = await WorldRules.open({dir, log: line => logs.push(line)});
  assert.equal(store.get(), '');
  assert.equal(logs.length, 1);
  assert.equal(await readFile(join(dir, WORLD_RULES_FILE), 'utf8'), '{"version": 1, "text": ');
  await store.set('Everyone speaks casually.');
  assert.equal(await readFile(join(dir, WORLD_RULES_FILE + '.corrupt'), 'utf8'), '{"version": 1, "text": ');
  assert.equal((await WorldRules.open({dir})).get(), 'Everyone speaks casually.');
  // A file edited by hand to be far too long is cut to the limit when it is read: a prompt never grows from it.
  await writeFile(join(dir, WORLD_RULES_FILE), JSON.stringify({version: 1, text: 'y'.repeat(WORLD_RULES_LIMIT * 3)}));
  assert.equal(Array.from((await WorldRules.open({dir})).get()).length, WORLD_RULES_LIMIT);
});

test('a failed write leaves the saved text as it was', async () => {
  const store = new WorldRules({dir: 'x', read: async () => { throw Object.assign(Error('none'), {code: 'ENOENT'}); }, write: async () => false});
  await assert.rejects(store.set('Everyone speaks casually.'));
  assert.equal(store.get(), '');
});

// ---- the prompt

test('every persona carries the rules: story characters, everyday people, Johnny and the player\'s own characters; with none there is no field', () => {
  const book = withRules();
  const keys = ['judy-alvarez', 'johnny-silverhand', roster.find(row => row.kind === 'archetype').key, 'resident-1234'];
  for (const key of keys) assert.equal(book.persona(key).worldRules, RULES, key);
  assert.equal(new PersonaBook(roster).persona('judy-alvarez').worldRules, undefined);
  assert.equal(new PersonaBook(roster, {worldRules: {get: () => ''}}).persona('judy-alvarez').worldRules, undefined);
  const custom = {has: key => key === 'custom-mine-abc', persona: () => ({name: 'Mine', backstory: 'I am a test person in Night City, quite ordinary.', style: '', samples: [], rules: [], memories: [], known: true})};
  assert.equal(new PersonaBook(roster, {custom, worldRules: {get: () => RULES}}).persona('custom-mine-abc').worldRules, RULES);
  // The shipped profile ("reset" goes back to it) never holds the world rules.
  assert.equal(book.defaults('judy-alvarez').worldRules, undefined);
});

test('the block comes right after the persona and the output rules, before the format notes, the world and the right-now block (cache order)', () => {
  const book = withRules();
  for (const key of ['judy-alvarez', 'johnny-silverhand', roster.find(row => row.kind === 'archetype').key]) {
    const system = buildMessages({persona: book.persona(key), memory: 'I fixed a rig for V.', contextParts: parts(), text: 'Hi.'})[0].content;
    const at = text => system.indexOf(text);
    assert(at('OUTPUT RULES') >= 0 && at('OUTPUT RULES') < at(WORLD_RULES_HEADING), key + ': after the output rules');
    assert(at(WORLD_RULES_HEADING) < at('FORMAT NOTES FOR EVERY REPLY'), key + ': before the format notes');
    assert(at(WORLD_RULES_HEADING) < at('WORLD AND QUEST CONTEXT'), key + ': before the world');
    assert(at(WORLD_RULES_HEADING) < at('WHAT YOU REMEMBER OF V FROM EARLIER TALKS'), key + ': before the summary');
    assert(at(WORLD_RULES_HEADING) < at('RIGHT NOW'), key + ': before the right-now block');
    assert(system.includes(RULES));
    assert.match(system, /never change or unlock them/, 'framed as setting facts under the hard rules, not a way past them');
  }
});

test('what changes between turns (world facts, the right-now block, the summary) never moves the text before and including the block', () => {
  const persona = withRules().persona('judy-alvarez');
  const one = buildMessages({persona, memory: 'Summary one.', contextParts: parts(), text: 'First.'})[0].content;
  const two = buildMessages({persona, memory: 'A different summary.', contextParts: parts({world: 'Quest: another one entirely.', now: 'You are with V in person. It is morning, in Kabuki.', notes: 'Use {joy} tags for feelings.'}), text: 'Second.'})[0].content;
  const end = system => system.indexOf(RULES) + RULES.length;
  assert.equal(one.slice(0, end(one)), two.slice(0, end(two)), 'the stable prefix is byte for byte the same');
  // Editing the rules is the only thing that moves the text after the persona.
  const edited = buildMessages({persona: withRules('Everyone speaks formally.').persona('judy-alvarez'), memory: 'Summary one.', contextParts: parts(), text: 'First.'})[0].content;
  assert.equal(edited.slice(0, one.indexOf(WORLD_RULES_HEADING)), one.slice(0, one.indexOf(WORLD_RULES_HEADING)));
  // The prewarmed head (the persona and the output rules) is still a prefix of every system message.
  assert(one.startsWith(systemHead({persona})));
});

test('the older layout (no context parts) carries the block too', () => {
  const system = systemPrompt({persona: withRules().persona('judy-alvarez'), memory: 'I fixed a rig for V.'});
  assert(system.includes(RULES) && system.indexOf('OUTPUT RULES') < system.indexOf(WORLD_RULES_HEADING));
});

test('with no rules the prompt is exactly what it was: nothing is added', () => {
  const plain = new PersonaBook(roster), empty = new PersonaBook(roster, {worldRules: {get: () => ''}}), blank = new PersonaBook(roster, {worldRules: {get: () => '  \n '}});
  const build = book => buildMessages({persona: book.persona('judy-alvarez'), memory: 'm', history: [{v: 'a', r: 'b'}], contextParts: parts(), text: 'Hi.'});
  assert.deepEqual(build(empty), build(plain));
  assert.deepEqual(build(blank).map(message => message.content), build(plain).map(message => message.content));
  assert.doesNotMatch(build(empty)[0].content, /WORLD RULES/);
  assert.equal(worldRulesBlock(''), ''); assert.equal(worldRulesBlock(undefined), '');
});

// ---- the three text providers, through the host (a real turn), and the phone and group channels

async function hostFor(kind, book) {
  const prompts = [];
  const chat = async options => { prompts.push(options.messages); return {text: 'Fine, V.', model: 'x', finishReason: 'stop', usage: {}}; };
  const memory = await MistralMemory.open({path: null});
  let provider, routes, custom = null;
  if (kind === 'mistral') {
    provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${MISTRAL_KEY}\n`, writeText: async () => {}});
    await provider.load(); provider.setPreference('mistral'); provider.apply();
    routes = {mistral: mistralRoute({provider, chat, gapMs: 0})};
  } else if (kind === 'custom') {
    custom = new CustomEndpoint({path: null});
    await custom.setUrl(parseEndpointUrl('http://127.0.0.1:9/v1')); await custom.setModel('test-model');
    provider = new MistralProvider({keyPath: 'k', readText: async () => { throw Error('none'); }, writeText: async () => {}, custom});
    await provider.load(); provider.setPreference('custom'); provider.apply();
    routes = {custom: customRoute({provider, custom, chat})};
  } else {
    provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
    await provider.load(); provider.setPreference('local'); provider.apply();
    const server = {status: () => ({state: 'ready', model: 'Qwen3.5-2B'}), ensure: async () => ({endpoint: 'http://127.0.0.1:1/v1', apiKey: 'session-key-abcdef123456', model: 'Qwen3.5-2B'}), touch() {}, prewarm: async () => {}};
    routes = {local: localRoute({server, provider, chat})};
  }
  const matureContent = new MatureContent(); matureContent.setPack(true); matureContent.update({matureContent: false});
  const host = new TextProviderHost({provider, memory, personas: book, routes, matureContent});
  return {host, prompts};
}

for (const kind of ['local', 'mistral', 'custom']) {
  test(`${kind}: the system message of a face-to-face, a phone and a group turn carries the world rules; with none it does not`, async t => {
    const withBook = await hostFor(kind, withRules()); t.after(() => withBook.host.close());
    for (const channel of ['private', 'phone', 'group']) {
      await withBook.host.reply(turn(`hello ${channel}`, {sessionId: 'session-' + channel, local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel}}));
      const system = withBook.prompts.at(-1)[0].content;
      assert(system.includes(WORLD_RULES_HEADING + '\n' + RULES), `${kind}/${channel}: the block is in the system message`);
      assert(system.indexOf('OUTPUT RULES') < system.indexOf(WORLD_RULES_HEADING) && system.indexOf(WORLD_RULES_HEADING) < system.indexOf('WORLD AND QUEST CONTEXT'), `${kind}/${channel}: in cache order`);
    }
    // Johnny in V's head and an everyday person go through the same builder.
    await withBook.host.reply(turn('hey', {sessionId: 's-j', local: {profileKey: 'johnny-silverhand', name: 'Johnny Silverhand', channel: 'private'}}));
    assert(withBook.prompts.at(-1)[0].content.includes(RULES));
    await withBook.host.reply(turn('hey', {sessionId: 's-a', local: {profileKey: roster.find(row => row.kind === 'archetype').key, name: '', channel: 'private'}}));
    assert(withBook.prompts.at(-1)[0].content.includes(RULES));
    const none = await hostFor(kind, new PersonaBook(roster)); t.after(() => none.host.close());
    await none.host.reply(turn('hello'));
    assert.doesNotMatch(none.prompts.at(-1)[0].content, /WORLD RULES/);
  });
}

test('an edit made now is in the very next turn (a plain read, no restart)', async t => {
  let text = '';
  const {host, prompts} = await hostFor('local', new PersonaBook(roster, {worldRules: {get: () => text}})); t.after(() => host.close());
  await host.reply(turn('one'));
  assert.doesNotMatch(prompts.at(-1)[0].content, /WORLD RULES/);
  text = 'Everyone speaks casually.';
  await host.reply(turn('two'));
  assert.match(prompts.at(-1)[0].content, /WORLD RULES[^\n]*\nEveryone speaks casually\./);
  text = '';
  await host.reply(turn('three'));
  assert.doesNotMatch(prompts.at(-1)[0].content, /WORLD RULES/);
});

// ---- the small-context fitter

test('the fitter never cuts the world rules: not when it drops the optional blocks, and not when it shortens the persona to the smallest level', async () => {
  const rules = Array.from({length: 40}, (_, index) => `Rule ${index + 1}: nobody in this world ever mentions the name of the thing they all fear.`).join('\n');
  const persona = withRules(rules).persona('judy-alvarez');
  const blocks = [{key: 'knowledge', text: 'WORLD FACTS\n' + Array.from({length: 60}, (_, i) => `- fact ${i}: a plain fact about the world that the character may know of.`).join('\n')}];
  const args = {persona, memory: 'I remember that V helped me with a job.', history: Array.from({length: 8}, (_, i) => ({v: `Tell me about job ${i}.`, r: 'It was a long night, V.'})),
    contextParts: {...parts(), world: blocks[0].text, worldBlocks: blocks}, remembered: [{text: 'V likes noodles.'}], text: 'What are you up to?', reaction: false};
  const roomy = await fitMessages({args, budget: {contextTokens: 12288}});
  assert(roomy.messages[0].content.includes(worldRulesBlock(rules)));
  const tight = await fitMessages({args, budget: {contextTokens: 4096}, shrinkPersona: true});
  assert(tight.trimmed.some(name => name.startsWith('persona:')), 'the persona itself had to be shortened at this size');
  assert(tight.messages[0].content.includes(worldRulesBlock(rules)), 'the world rules are whole after the persona was shortened');
  assert(PERSONA_LEVELS.length > 0);
  assert(!tight.trimmed.some(name => /world-?rules/i.test(name)), 'no step is about the world rules');
  // The prompt without the rules is shorter by exactly the block: the persona levels were chosen with the block counted.
  const plain = await fitMessages({args: {...args, persona: {...persona, worldRules: undefined}}, budget: {contextTokens: 4096}, shrinkPersona: true});
  assert(plain.messages[0].content.length < tight.messages[0].content.length);
});

// ---- Convai

test('Convai: the rules are a block of the dynamic info, only while no text provider answers, and a text provider\'s layout never reads that tier', () => {
  assert.deepEqual(convaiWorldRulesBlocks('', false), []);
  assert.deepEqual(convaiWorldRulesBlocks(RULES, true), [], 'the text providers carry the rules in the persona');
  const [block] = convaiWorldRulesBlocks(RULES, false);
  assert.equal(block.tier, 'convai'); assert.equal(block.text, worldRulesContext(RULES));
  assert(block.text.endsWith(RULES) && /never change or unlock/.test(block.text));
  assert(Array.from(block.text).length <= WORLD_RULES_LIMIT + 400, 'a bounded addition to the dynamic info');
});

test('the bridge puts the Convai block after the facts of the game and before the voice and style notes, and builds the persona book with the store', async () => {
  const source = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /phoneRecentConversationContext\(prepared\.input\) : ''\),(?:\s*\/\/[^\n]*\n)+\s*\.\.\.convaiWorldRulesBlocks\(worldRules\.get\(\), mistral\.active\),(?:\s*\/\/[^\n]*\n)+\s*block\('volatile', followUpContext\(input\)\)/);
  assert.match(source, /WorldRules\.open\(\{dir: stateDirectory/);
  assert.match(source, /new PersonaBook\(roster, \{[^}]*worldRules\}\)/);
  assert.match(source, /new CharacterEditor\(\{[^]*?worldRules,/);
  // The tiers the text providers read are the four it names; 'convai' is none of them.
  assert.match(source, /\['now', 'notes', 'volatile'\]/);
});

// ---- the editor

test('the editor saves, clears and reports the rules over its own server, and its onChanged hook runs', async t => {
  const dir = await dirOf(); t.after(() => rm(dir, {recursive: true, force: true}));
  const worldRules = await WorldRules.open({dir});
  const overrides = await CharacterOverrides.open({dir: join(dir, 'character-overrides')});
  const changed = [];
  const personas = new PersonaBook(roster, {overrides, worldRules});
  const editor = new CharacterEditor({personas, overrides, route: () => 'local', worldRules, onChanged: key => changed.push(key)});
  assert.deepEqual(editor.state().worldRules, {text: '', limit: WORLD_RULES_LIMIT});
  assert.deepEqual(await editor.saveWorldRules(RULES), {text: RULES, limit: WORLD_RULES_LIMIT});
  assert.equal(personas.persona('judy-alvarez').worldRules, RULES, 'the next turn reads it');
  assert.equal(JSON.parse(await readFile(join(dir, WORLD_RULES_FILE), 'utf8')).text, RULES);
  await assert.rejects(editor.saveWorldRules('x'.repeat(WORLD_RULES_LIMIT + 1)), error => error.status === 422 && error.errors[0].code === 'world-rules-long' && error.errors[0].max === WORLD_RULES_LIMIT);
  await assert.rejects(editor.saveWorldRules(7), error => error.status === 400);
  assert.equal(personas.persona('judy-alvarez').worldRules, RULES, 'a refused save changes nothing');
  assert.equal((await editor.clearWorldRules()).text, '');
  assert.equal(personas.persona('judy-alvarez').worldRules, undefined);
  assert.equal(changed.length, 2, 'two saves reached the hook (the bridge drops prepared replies there)');
  // Without a store the editor has no World rules page.
  const bare = new CharacterEditor({personas: new PersonaBook(roster), overrides, route: () => 'local'});
  assert.equal(bare.state().worldRules, null);
  await assert.rejects(bare.saveWorldRules('x'), error => error.status === 404);
  // Over HTTP: GET, PUT and DELETE of /api/world-rules, with the token like every other call.
  const server = new EditorServer({editor});
  t.after(() => server.stop());
  const url = new URL(await server.start());
  const call = (method, body) => fetch(`http://127.0.0.1:${url.port}/api/world-rules`, {method, headers: {'X-Editor-Token': server.token, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
    body: body === undefined ? undefined : JSON.stringify(body)}).then(async response => ({status: response.status, json: await response.json()}));
  assert.equal((await call('PUT', {text: RULES})).json.text, RULES);
  assert.equal((await call('GET')).json.text, RULES);
  const refused = await call('PUT', {text: 'x'.repeat(WORLD_RULES_LIMIT + 1)});
  assert.equal(refused.status, 422); assert.equal(refused.json.errors[0].code, 'world-rules-long');
  assert.equal((await call('DELETE')).json.text, '');
  const noToken = await fetch(`http://127.0.0.1:${url.port}/api/world-rules`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: '{"text":"x"}'});
  assert.equal(noToken.status, 401);
});
