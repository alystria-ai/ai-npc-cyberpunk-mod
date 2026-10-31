// Retrieval in the prompt (docs/NATURAL_TALK_RESEARCH_2026-10-30.md, section 15): the sources a turn offers, what the prompt carries for small talk and for a question,
// the order that keeps a prompt cache working, a snapshot of the last message per provider, and the text host's use of it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {worldTurn, knowledgeContextFor} from './fixtures/talk-world.mjs';
import {conversationContextBlocks, conversationContext, retrievalSources, attachRetrieval, retrievalOf, journalContext} from './quest-context.mjs';
import {PersonaBook, buildMessages, withRetrievedParts, joinBlocks, worldBlocksInCacheOrder, systemHead} from './mistral-prompt.mjs';
import {TalkRetrieval, Corpus, RETRIEVAL_HEADING} from './talk-retrieval.mjs';
import {defaultProfile, profileIdFor, customProfileId, BASE_PROFILE, mergeProfile} from './prompt-profiles.mjs';
import {TextProviderHost, mistralRoute} from './text-provider-host.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {TurnClock, withClock} from './turn-clock.mjs';

const roster = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));
const book = new PersonaBook(roster, {lean: true, topics: true});
const corpus = new Corpus(roster.flatMap(row => book.topicMaterial(row.key, {raw: true})?.items.map(item => item.text.split('\n')[0]) ?? []));

// ---- A turn with world knowledge, journal history, jobs and a tracked quest ---------------------------------------------------------------------
let ids = 0;
const turnInput = text => worldTurn(text, {facts: 8});
const knowledgeContext = knowledgeContextFor('panam-palmer', 8);

const talkFor = options => new TalkRetrieval({topicFor: key => book.topicMaterial(key), corpus, ...options});
async function retrieve(input, talk = talkFor()) {
  const result = await talk.prepare({profileKey: input.profileKey, requestId: input.requestId, text: input.text, reaction: false}, {sources: retrievalSources(input)});
  return attachRetrieval(input, result), result;
}

test('a turn with a saved world offers its blocks as sources: world facts, journal history, jobs and the tracked quest', () => {
  const sources = retrievalSources(turnInput('hey'));
  assert.deepEqual(sources.map(source => source.key).sort(), ['history', 'jobs', 'journal', 'knowledge']);
  const knowledge = sources.find(source => source.key === 'knowledge');
  assert.equal(knowledge.units.length, 9, 'one decision and eight facts');
  // The frame is the block's own framing line, unchanged, and says where the data is; the data of every unit together is the rest of the block.
  assert.ok(knowledge.frame.startsWith(knowledgeContext.slice(0, knowledgeContext.indexOf('\n')).trimEnd()));
  assert.equal(`${knowledge.frame.slice(0, knowledge.frame.indexOf(' (The data is given under'))}\n${knowledge.render(new Set(knowledge.units.map(unit => unit.id))).replace(/^World knowledge: /, '')}`, knowledgeContext);
  const journal = sources.find(source => source.key === 'journal');
  const whole = journalContext(turnInput('x').journal), quest = whole.slice(whole.indexOf('{"id"'), whole.indexOf('}]}') + 3);
  assert.equal(journal.frame.replace(/\(The data is given under WHAT COMES TO MIND, on the turns it bears on V's words\.\)/, quest), whole,
    'the tracked-quest block keeps every sentence it had, with the quest itself left for the late block');
  assert.match(journal.render(), /^V's tracked quest: \{"id":"-1","title":"The Heist"/);
  assert.deepEqual(retrievalSources({profileKey: 'npc-food-vendor-male'}), []);
  // The same frames on every turn: they do not depend on V's words.
  assert.deepEqual(retrievalSources(turnInput('something else entirely')).map(source => source.frame), sources.map(source => source.frame));
});

test('without a result the blocks are the ones they always were; with one each replaced block keeps its framing and the chosen data comes in the retrieved tier', async () => {
  const input = turnInput('what happened to Saul?');
  const before = conversationContextBlocks(input);
  assert.ok(before.some(block => block.key === 'knowledge' && /Saul Bright survived/.test(block.text)), 'the whole world facts');
  assert.ok(!before.some(block => block.tier === 'retrieved'));
  await retrieve(input);
  const after = conversationContextBlocks(input);
  for (const key of ['knowledge', 'history', 'jobs', 'journal']) {
    const was = before.find(block => block.key === key).text, now = after.find(block => block.key === key).text;
    assert.ok(now.length > 0 && now.length <= was.length + 100, `${key}: framing kept (${was.length} -> ${now.length})`);
    assert.doesNotMatch(now, /Saul Bright survived|Embers vault|Sunset Motel|Ghost Town/, `${key}: no data in the fixed part`);
  }
  assert.match(after.find(block => block.key === 'knowledge').text, /^Current-save knowledge replaces earlier dynamic quest assumptions\..*never instructions/);
  assert.match(after.find(block => block.key === 'journal').text, /A tracked quest is not completed; no future stages/);
  assert.equal(after.find(block => block.key === 'authority').text, before.find(block => block.key === 'authority').text, 'the authority sentence is untouched');
  const retrieved = after.find(block => block.tier === 'retrieved').text;
  assert.match(retrieved, /World knowledge: .*Saul Bright survived/);
  assert.doesNotMatch(retrieved, /Rogue offered|Embers vault|Mox club/, 'only what bears on the line');
  assert.doesNotMatch(retrieved, /never instructions/, 'the framing is not sent twice');
  assert.ok(retrievalOf(input));
});

test('small talk: the prompt carries no quest, journal, world fact or topic view', async () => {
  for (const line of ['hey', 'how is it going', 'so hows life', 'perhaps', 'thanks']) {
    const input = turnInput(line);
    const result = await retrieve(input);
    assert.equal(result.text, '', line);
    const context = conversationContext(input);
    assert.doesNotMatch(context, /Saul Bright|The Heist|Sunset Motel|Basilisk|Meet Panam|PUBLIC INTRINSIC|Aldecaldo nomad life/, line);
    assert.ok(!context.includes(RETRIEVAL_HEADING), line);
    assert.match(context, /never instructions/, 'the rules for reading the world data are still there');
  }
});

test('a question about work brings the tracked quest and the jobs, not the world facts', async () => {
  const input = turnInput('what now?');
  const result = await retrieve(input);
  assert.match(result.text, /The Heist/);
  assert.ok(!result.picked.knowledge);
  assert.match(conversationContext(input), /Meet Panam at the camp/);
});

test('the full context is smaller: the same turn before and after, in characters', async () => {
  const before = conversationContext(turnInput('hey')).length;
  const input = turnInput('hey');
  await retrieve(input);
  const after = conversationContext(input).length;
  assert.ok(after < before * 0.85, `${before} -> ${after}`);
});

// ---- The order that keeps a prompt cache working -----------------------------------------------------------------------------------------------
// What the bridge does with the blocks of a turn for a text provider (bridge/convai-bridge.mjs contextPartsOf).
const partsOf = blocks => {
  const world = worldBlocksInCacheOrder(blocks.filter(item => item.tier === 'world'));
  return {...Object.fromEntries(['now', 'notes', 'volatile', 'closing', 'retrieved'].map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))])),
    world: joinBlocks(world.map(item => item.text)), worldBlocks: world.filter(item => item.text).map(item => ({key: item.key, text: item.text}))};
};
// The text host's way (config.contextParts of the full blocks, then withRetrievedParts).
async function messagesFor(text, {history = [], reaction = false, profile = BASE_PROFILE, topics = true, persona = (topics ? book : new PersonaBook(roster, {lean: true})).persona('panam-palmer')} = {}) {
  const input = turnInput(text);
  const full = partsOf(conversationContextBlocks(input));
  const talk = talkFor();
  const result = await talk.prepare({profileKey: input.profileKey, requestId: input.requestId, text, reaction}, {sources: retrievalSources(input)});
  const contextParts = topics ? withRetrievedParts(full, result) : full;
  return buildMessages({persona, memory: 'I remember V from the camp.', history, contextParts, remembered: [], text, reaction, ...(profile ? {profile} : {})});
}

test('for cache reuse the system message is the same on every turn, small talk, a question or a reaction, and the changing text is last', async () => {
  const history = [{v: 'hello', r: 'Hey.'}, {v: 'nice night', r: 'Cold, though.'}];
  const turns = await Promise.all(['hey', 'what happened to Saul?', 'tell me about the Aldecaldos', 'what now?', 'so hows life'].map(text => messagesFor(text, {history})));
  const reaction = await messagesFor('Panam, a gunfight broke out', {history, reaction: true});
  for (const messages of [...turns, reaction]) assert.equal(messages[0].content, turns[0][0].content, 'one system message for every kind of turn');
  // History is the same prefix, and only the last message differs.
  for (const messages of turns) assert.deepEqual(messages.slice(1, -1), turns[0].slice(1, -1));
  const last = turns.map(messages => messages.at(-1).content);
  assert.equal(new Set(last.map(text => text.replace(/V says: .*/, 'V says: _'))).size, 4, 'small talk twice reads alike, the other three differ');
  assert.equal(last[0].replace(/V says: hey/, 'V says: so hows life'), last[4]);
  // In the last message the retrieved block comes after the turn notes and the memories and before V's words.
  const question = last[1];
  assert.ok(question.indexOf(RETRIEVAL_HEADING) > -1);
  assert.ok(question.indexOf(RETRIEVAL_HEADING) < question.indexOf('V says: what happened to Saul?'));
  assert.ok(!turns[1][0].content.includes('Saul Bright survived'), 'the world fact is not in the system message');
  assert.ok(!turns[1][0].content.includes('PUBLIC INTRINSIC TOPIC MATERIAL'));
});

test('without retrieval the system message holds the whole world and the whole topic material, and is a different (longer) prefix', async () => {
  const without = await messagesFor('hey', {topics: false});
  const withIt = await messagesFor('hey');
  assert.match(without[0].content, /Saul Bright survived/);
  assert.match(without[0].content, /PUBLIC INTRINSIC TOPIC MATERIAL/);
  assert.ok(without[0].content.length - withIt[0].content.length > 4000, `${without[0].content.length} vs ${withIt[0].content.length}`);
});

test('the fixed part keeps every rule and limit exactly: output rules, save rules, authority, world rules', async () => {
  const [messages] = [await messagesFor('hey')], plain = await messagesFor('hey', {topics: false});
  const system = messages[0].content, old = plain[0].content;
  for (const text of ['OUTPUT RULES', 'Verified current-save context overrides memory.', 'KNOWLEDGE LIMITS', 'Current verified save facts and the current tracked-quest snapshot override older journal observations',
    'You speak out loud, as Panam Palmer', 'Use only facts from this prompt']) assert.equal(system.includes(text), old.includes(text), text);
  for (const text of ['OUTPUT RULES', 'Verified current-save context overrides memory.', 'Current verified save facts and the current tracked-quest snapshot override']) assert.ok(system.includes(text), text);
  // The rules block is byte for byte the same.
  assert.equal(system.slice(system.indexOf('OUTPUT RULES'), system.indexOf('WORLD AND QUEST CONTEXT')), old.slice(old.indexOf('OUTPUT RULES'), old.indexOf('WORLD AND QUEST CONTEXT')));
});

// ---- A snapshot of the last message per provider -----------------------------------------------------------------------------------------------
const SYNTHETIC = {preface: 'Background and personal views, not proof that V met you; use one detail, in your own words; verified game facts override.',
  items: [{text: 'I never forgave Saul for leaving the family.\nScope: My own view; no invented dates.'}, {text: 'Sunsets over the Badlands calm me down.'}]};
const section = (text, marker) => text.slice(text.indexOf(marker));
async function lastMessage(profile, text = 'what about Saul?') {
  const talk = new TalkRetrieval({topicFor: () => SYNTHETIC, corpus});
  const result = await talk.prepare({profileKey: 'panam-palmer', requestId: `s${++ids}`, text}, {sources: [{key: 'history', units: [{id: 'quests:0', text: 'Ghost Town. Meet Panam', data: '{"title":"Ghost Town"}', importance: 0.3, recency: 0.5}], render: () => 'HISTORY'}]});
  const parts = {now: 'Right now: You are with V in person.', notes: 'NOTES', world: 'WORLD', worldBlocks: [{key: 'history', text: 'HISTORY FULL'}, {key: 'story', text: 'STORY'}], volatile: 'Whether you ask V anything is your own call.', closing: ''};
  const messages = buildMessages({persona: book.persona('panam-palmer'), memory: '', history: [], contextParts: withRetrievedParts(parts, result), remembered: [{text: 'V likes noodles.'}], text, profile});
  return messages.at(-1).content;
}

test('provider snapshot: the last message of each provider, the retrieved block between the memories and V\'s words', async () => {
  const geminiId = customProfileId('https://generativelanguage.googleapis.com', 'gemini-flash-lite-latest');
  const profiles = {
    gemini: defaultProfile(geminiId, {family: 'gemini'}),
    localStandard: defaultProfile(profileIdFor({route: 'local', tier: 'standard'})),
    mistral: defaultProfile(profileIdFor({route: 'mistral'})),
    custom: defaultProfile(customProfileId('https://openrouter.ai', 'some-model'), {family: 'generic'}),
  };
  const retrieved = [RETRIEVAL_HEADING, SYNTHETIC.preface, '- I never forgave Saul for leaving the family.', '  Scope: My own view; no invented dates.'].join('\n');
  const expected = {
    gemini: ['[YOU, RIGHT NOW: You are with V in person. That is all you are doing; never claim to be anywhere else. Never announce that you are here or beside V, or that V is here.]',
      '[THIS TURN: notes for you, not to be said]\nWhether you ask V anything is your own call.',
      '[THINGS YOU REMEMBER ABOUT V THAT MAY MATTER NOW: true unless the world context says otherwise; mention one only if it fits]\n- V likes noodles.',
      retrieved, 'V says: what about Saul?'],
  };
  const text = await lastMessage(profiles.gemini);
  const head = expected.gemini.join('\n\n');
  assert.ok(text.startsWith(head), text.slice(0, 1400));
  assert.match(text.slice(head.length), /^\n\n\(Reply as Panam Palmer: react to what V just said/);
  // The same four pieces, in the same order, for every provider; the wording of the labels is the profile's, the retrieved block is the same text.
  const order = ['[YOU, RIGHT NOW', '[THIS TURN', '[THINGS YOU REMEMBER', RETRIEVAL_HEADING, 'V says: what about Saul?'];
  for (const [name, profile] of Object.entries(profiles)) {
    const message = await lastMessage(profile);
    const at = order.map(marker => message.indexOf(marker));
    assert.ok(at.every(index => index >= 0), `${name}: ${at}`);
    if (name !== 'mistral' && name !== 'localStandard') assert.deepEqual(at, [...at].sort((a, b) => a - b), name);
    assert.ok(message.includes(retrieved), `${name}: the retrieved block is the same text for every provider`);
    assert.ok(!message.includes('HISTORY FULL'), `${name}: the whole history block is gone`);
    assert.ok(message.indexOf(RETRIEVAL_HEADING) < message.indexOf('V says:'), name);
  }
  // Profiles that put the turn's notes after V's line (Mistral, Local AI Standard) keep the retrieved block before V's words and the notes after.
  for (const name of ['mistral', 'localStandard']) {
    const message = await lastMessage(profiles[name]);
    assert.ok(message.indexOf('[THIS TURN') > message.indexOf('V says:'), `${name}: notes after V's line`);
    assert.ok(message.indexOf(RETRIEVAL_HEADING) < message.indexOf('V says:'), name);
  }
});

test('provider snapshot: Convai gets the retrieved block through its turn context, the Gemini, Local AI and Custom prompts through the last message', async () => {
  const input = turnInput('what happened to Saul?');
  await retrieve(input);
  const context = conversationContext(input);   // what Convai's dynamic info is built from
  assert.ok(context.includes(RETRIEVAL_HEADING));
  assert.ok(context.indexOf(RETRIEVAL_HEADING) < context.indexOf('Current verified save facts and the current tracked-quest snapshot override'), 'before the authority sentence that is about it');
  assert.match(context, /Saul Bright survived/);
  assert.doesNotMatch(context, /Embers vault|Sunset Motel/);
  const messages = await messagesFor('what happened to Saul?');
  assert.ok(messages.at(-1).content.includes(RETRIEVAL_HEADING));
});

// ---- The text host ----------------------------------------------------------------------------------------------------------------------------
async function fakeServer(script) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      response.writeHead(200, {'content-type': 'text/event-stream'});
      for (const piece of String(script(body)).match(/.{1,12}/gs) ?? []) response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {requests, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
}
async function hostHarness() {
  const server = await fakeServer(() => 'Fine, V.');
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => 'api-key=aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL\n', writeText: async () => {}});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const logs = [];
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book,
    routes: {mistral: mistralRoute({provider, endpoint: server.endpoint, gapMs: 0})}, log: line => logs.push(line)});
  return {server, host, logs, close: async () => { host.close(); await server.close(); }};
}
const hostTurn = (text, input, {reaction = false} = {}) => {
  const talk = talkFor();
  const blocks = conversationContextBlocks(input);
  return {text, context: '', contextParts: partsOf(blocks), sessionId: 's', ...(reaction ? {reaction: {kind: 'battle'}} : {}),
    local: {profileKey: 'panam-palmer', name: 'Panam Palmer', channel: 'private'},
    retrieval: {run: ({text: said, reaction: react, signal}) => talk.prepare({profileKey: 'panam-palmer', requestId: input.requestId, text: said, reaction: react}, {sources: retrievalSources(input), signal})}};
};

test('the text host asks for the turn\'s background once V\'s words are known and builds the prompt from it', async () => {
  const {server, host, logs, close} = await hostHarness();
  try {
    const clock = new TurnClock();
    await withClock(clock, () => host.reply(hostTurn('what happened to Saul?', turnInput('what happened to Saul?'))));
    const sent = server.requests[0].messages;
    assert.match(sent.at(-1).content, /Saul Bright survived/);
    assert.ok(sent.at(-1).content.includes(RETRIEVAL_HEADING));
    assert.doesNotMatch(sent[0].content, /Saul Bright survived|Embers vault|PUBLIC INTRINSIC TOPIC MATERIAL/);
    assert.ok(clock.has('retrieved'), 'the stage is on the turn\'s clock');
    assert.ok(Number.isFinite(clock.details.retrievalMs));
    assert.ok(logs.some(line => /^Talk retrieval: profile=panam-palmer .*via=words/.test(line)), logs.join('\n'));
    // Small talk next: the same system message, no background in the last message.
    await host.reply(hostTurn('so hows life', turnInput('so hows life')));
    const small = server.requests[1].messages;
    assert.equal(small[0].content, sent[0].content, 'same system message: a prefix cache keeps it');
    assert.ok(!small.at(-1).content.includes(RETRIEVAL_HEADING));
    assert.ok(logs.some(line => /Talk retrieval: profile=panam-palmer none \(small-talk\)/.test(line)), logs.join('\n'));
    // A reaction: no background, and the world blocks are out the same way.
    await host.reply(hostTurn('Panam, a gunfight broke out', turnInput('x'), {reaction: true}));
    assert.equal(server.requests[2].messages[0].content, sent[0].content);
  } finally { await close(); }
});

test('a retrieval that fails leaves the turn with the full blocks and says so', async () => {
  const {server, host, logs, close} = await hostHarness();
  try {
    const config = hostTurn('what happened to Saul?', turnInput('what happened to Saul?'));
    config.retrieval = {run: async () => { throw Error('boom'); }};
    await host.reply(config);
    const sent = server.requests[0].messages;
    assert.match(sent[0].content, /Saul Bright survived/, 'the whole world block');
    assert.ok(!sent.at(-1).content.includes(RETRIEVAL_HEADING));
    assert.ok(logs.some(line => /Talk retrieval failed \(boom\)/.test(line)));
  } finally { await close(); }
});

test('a turn with no retrieval in its config is built as it always was', async () => {
  const {server, host, close} = await hostHarness();
  try {
    const config = hostTurn('what happened to Saul?', turnInput('what happened to Saul?'));
    delete config.retrieval;
    await host.reply(config);
    assert.match(server.requests[0].messages[0].content, /Saul Bright survived/);
  } finally { await close(); }
});
