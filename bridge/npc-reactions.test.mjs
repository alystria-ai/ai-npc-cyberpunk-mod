// What a conversation can do to an ordinary world NPC (docs/NPC_REACTIONS.md), the bridge half: the tag in a text reply and its stripping, the offer's
// parsing and admission, the delivery packet, the Convai action window, the one short instruction, and the whole turn on every provider. The game
// half (the rails, the natives) is bridge/npc-reactions-lua.test.mjs. Offline: no game, no Convai, no real network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseInput} from './protocol.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {CompanionActions, CompanionActionWindow, publishCompanionActionContext, REACTION_ACTIONS, REACTION_KINDS, parseReactionOffer, reactionActionName} from './companion-actions.mjs';
import {actionMenu, reactionMenu, reactionNotes, splitActions} from './text-actions.mjs';
import {TextProviderHost, customRoute, localRoute, mistralRoute} from './text-provider-host.mjs';
import {CustomEndpoint, parseEndpointUrl} from './custom-endpoint.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {streamChat} from './mistral-client.mjs';
import {ReplyStream} from './reply-stream.mjs';
import {startOpenAiMock} from './openai-mock-server.mjs';

const KEY = 'test' + 'x'.repeat(28);
const TOKEN = 'drive-0123456789abcdefghij';
const KEY_NPC = 'npc-street-resident-male';
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
const quick = {firstByteMs: 600, retryFirstByteMs: 600, totalMs: 2500, retries: 1, backoffMs: [5]};
const settle = () => new Promise(done => setTimeout(done, 10));
const isDecision = body => /^You read one message from V/.test(body?.messages?.[0]?.content ?? '');
const reactionConfig = (kinds, extra = {}) => ({version: 1, token: TOKEN, source: 'private-text', expiresAt: 99999, drive: false, reaction: {kinds}, ...extra});
const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON', sessionId: 'session-1',
  contextParts: {now: 'Right now: you are with V in person.', notes: '', world: 'Night City.', volatile: 'Whether you ask V anything is your own call.'},
  local: {profileKey: KEY_NPC, name: 'Street local', channel: 'private', ambientKey: 'npc-1:44ULL'}, ...extra});

// ---- The tag: parsing and stripping ----------------------------------------------------------------------------------------

test('the three reaction tags are cut from the text in every spelling a model uses, and only those', () => {
  const rows = [
    ['Back off, or I swear. [call-police]', 'Back off, or I swear. ', 'CALL-POLICE'],
    ['Go away. [Call Police]', 'Go away. ', 'CALL-POLICE'],
    ['Go away. [call_police]', 'Go away. ', 'CALL-POLICE'],
    ['Go away. [police]', 'Go away. ', 'CALL-POLICE'],
    ['I am done with you. [leave]', 'I am done with you. ', 'LEAVE'],
    ['I am done with you. [ LEAVE ].', 'I am done with you. ', 'LEAVE'],
    ['You asked for it. [attack]', 'You asked for it. ', 'ATTACK'],
    ['You asked for it. [ACTION: attack]', 'You asked for it. ', 'ATTACK'],
  ];
  for (const [raw, text, code] of rows) {
    const split = splitActions(raw);
    assert.equal(split.text, text, raw);
    assert.deepEqual(split.found.map(item => item.code), [code], raw);
  }
  // Sounds and feelings the voice uses are not reaction tags, and a stray "police" inside a word is not one.
  for (const raw of ['Ha. [laughter] Fine.', 'It is {anger} and [sigh] over.', 'The [police-line] is closed.', 'Call the police yourself.']) {
    assert.deepEqual(splitActions(raw), {text: raw, found: []}, raw);
  }
});

test('a tag still being written is held back from the voice and the subtitle, and a harmless bracket is not', () => {
  for (const partial of ['Back off. [', 'Back off. [c', 'Back off. [call', 'Back off. [call ', 'Back off. [call-pol', 'Back off. [call police', 'Back off. [call police]',
    'Back off. [at', 'Back off. [attack', 'Back off. [attack]', 'Back off. [lea', 'Back off. [leave', 'Back off. [leave]']) {
    assert.equal(splitActions(partial, {streaming: true}).text, 'Back off. ', JSON.stringify(partial));
  }
  for (const text of ['See [leave it', 'Hi [laughter', 'Hi [laughter]', 'Hello [x']) {
    assert.equal(splitActions(text, {streaming: true}).text, text, text);
  }
});

test('the companion codes are cut the way they always were', () => {
  assert.equal(splitActions('[DRIVE] Sure, hop in.').text, 'Sure, hop in.');
  assert.deepEqual(splitActions('Fine [DISMISSED: Judy] bye').found, [{code: 'LEAVE', argument: 'Judy'}]);
  assert.equal(splitActions('Right [NONE] then.').text, 'Right then.');
});

// ---- Which reply counts ----------------------------------------------------------------------------------------------------

test('a tag counts only at the very end of a reply with words before it, once, and only for a kind the game offered', () => {
  const menu = reactionMenu(reactionConfig(['leave', 'call-police']));
  const pick = raw => menu.pick(raw);
  assert.deepEqual(pick('Back off, or I call the cops. [call-police]'), {kind: 'call-police'});
  assert.deepEqual(pick('I am done here. [leave]'), {kind: 'leave'});
  assert.deepEqual(pick('I am done here. [leave].'), {kind: 'leave'});
  assert.deepEqual(pick('I am done here.\n[leave]\n'), {kind: 'leave'});
  assert.deepEqual(pick('Fine.'), {kind: null, why: 'no-tag'});
  assert.deepEqual(pick(''), {kind: null, why: 'no-tag'});
  assert.deepEqual(pick('[leave] I am done here.'), {kind: null, why: 'not-at-end'}, 'a tag at the start never counts');
  assert.deepEqual(pick('Go [leave] and do not come back.'), {kind: null, why: 'not-at-end'});
  assert.deepEqual(pick('[leave]'), {kind: null, why: 'no-words'});
  assert.deepEqual(pick('I warned you. [attack]'), {kind: null, why: 'not-offered'}, 'a civilian is never offered an attack');
  assert.deepEqual(pick('Enough. [leave] Enough. [leave]'), {kind: null, why: 'several-tags'});
  assert.deepEqual(pick('Enough. [leave] [call-police]'), {kind: null, why: 'several-tags'});
  assert.deepEqual(menu.resolve('leave'), {version: 1, token: TOKEN, reaction: 'leave'});
  assert.equal(menu.resolve('attack'), null);
});

test('the menu exists only for an offer, and an offer of companion actions has none', () => {
  assert.equal(reactionMenu(undefined), null);
  assert.equal(reactionMenu({}), null);
  assert.equal(reactionMenu({token: TOKEN}), null);
  assert.equal(reactionMenu(reactionConfig([])), null);
  assert.equal(reactionMenu(reactionConfig(['teleport'])), null, 'an unknown kind offers nothing');
  assert.equal(reactionMenu({version: 1, token: TOKEN, drive: false, follow: {name: 'Judy'}}), null);
  assert.deepEqual(reactionMenu(reactionConfig(['attack', 'leave'])).kinds, ['leave', 'attack'], 'in the fixed order');
  // The companion menu is untouched by a reaction offer next to it.
  assert.equal(actionMenu(reactionConfig(['leave'])), null);
});

// ---- The instruction -------------------------------------------------------------------------------------------------------

test('the instruction is short, says "rare", lists only the offered kinds and never names the others', () => {
  const civilian = reactionNotes(['leave', 'call-police']);
  const ganger = reactionNotes(['leave', 'attack']);
  const cop = reactionNotes(['attack']);
  const clerk = reactionNotes(['call-police']);
  for (const text of [civilian, ganger, cop, clerk]) {
    assert.ok(text.length < 520, `short: ${text.length}`);
    assert.match(text, /rare/i);
    assert.match(text, /threatens you or seriously insults you/);
    assert.match(text, /rude-but-harmless or joking/);
    assert.match(text, /never at the start/);
    assert.match(text, /Never speak of tags/);
  }
  assert.match(civilian, /\[leave\]/); assert.match(civilian, /\[call-police\]/); assert.doesNotMatch(civilian, /attack/i);
  assert.match(ganger, /\[attack\]/); assert.match(ganger, /\[leave\]/); assert.doesNotMatch(ganger, /police/i);
  assert.match(cop, /\[attack\]/); assert.doesNotMatch(cop, /leave|police/i);
  assert.match(clerk, /\[call-police\]/); assert.doesNotMatch(clerk, /leave|attack/i);
  assert.equal(reactionNotes([]), '');
  assert.equal(reactionNotes(undefined), '');
});

// ---- The offer on the wire, and its admission ------------------------------------------------------------------------------

const offer = (kinds = ['leave', 'call-police']) => ({available: true, actor: {id: '44ULL', key: KEY_NPC}, kinds});

test('the offer is bounded: known kinds, no duplicates, the fixed order, nothing else on it', () => {
  assert.deepEqual(parseReactionOffer(offer(['attack', 'leave'])), offer(['leave', 'attack']));
  for (const bad of [{...offer(), kinds: []}, {...offer(), kinds: ['leave', 'leave']}, {...offer(), kinds: ['leave', 'drive']}, {...offer(), kinds: 'leave'},
    {...offer(), kinds: ['leave', 'call-police', 'attack', 'leave']}, {...offer(), extra: 1}, {...offer(), available: false}, {...offer(), actor: {id: 'x', key: KEY_NPC}},
    {...offer(), actor: {id: '44ULL', key: 'Bad Key'}}, null, 'leave']) {
    assert.equal(parseReactionOffer(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(REACTION_KINDS, ['leave', 'call-police', 'attack']);
  assert.deepEqual(REACTION_ACTIONS, {leave: 'Walk Away', 'call-police': 'Call Police', attack: 'Attack V'});
});

const prepared = (reactionOffer = offer()) => ({sendAllowed: true, identified: true, worldToken: 'world-fixture', generation: 2,
  remoteConfig: {endUserId: 'fixture-user'}, route: {channel: 'private', transport: 'private'},
  input: {requestId: '100-4-44ULL', generation: 4, entity: '44ULL', profileKey: KEY_NPC, channel: 'private',
    name: 'Street local', bodyType: 'Man', text: 'Keep your hands off me, I will make you regret this', reactionOffer}});
function fixture() {
  let now = 10000, current = true, sequence = 0;
  const files = [], broker = new CompanionActions({now: () => now,
    createToken: () => 'drive-' + String(++sequence).padStart(20, '0'),
    publish: async (packet, options) => {
      if (options?.isCurrent && !await options.isCurrent()) return false;
      if (options?.isCurrentSync && !options.isCurrentSync()) return false;
      files.push(packet); return true;
    }});
  return {broker, files, advance: value => { now += value; }, stale: () => { current = false; },
    options: {source: 'private-text', isCurrent: async () => current, isCurrentSync: () => current}};
}

test('the game input keeps an ordinary NPC\'s offer, and drops it from a person who has companion offers', () => {
  const input = prepared().input;
  assert.deepEqual(parseInput(JSON.stringify(input)).reactionOffer, offer());
  assert.equal(parseInput(JSON.stringify({...input, reactionOffer: {available: true}})).reactionOffer, undefined);
  const withFollow = {...input, followOffer: {available: true, actor: {id: '44ULL', key: KEY_NPC}, name: 'Judy'}};
  const parsed = parseInput(JSON.stringify(withFollow));
  assert.ok(parsed.followOffer); assert.equal(parsed.reactionOffer, undefined, 'a companion is not an ordinary NPC');
  assert.equal(parseInput(JSON.stringify(input)).requestId, input.requestId, 'the conversation itself is untouched');
});

test('an ordinary NPC\'s private manual turn arms the offer; any other turn, owner or channel does not', () => {
  const {broker, options} = fixture();
  const config = broker.admit(prepared(), options);
  assert.deepEqual(config.reaction, {kinds: ['leave', 'call-police']});
  assert.equal(config.drive, false, 'no drive offer is made for the person');
  assert.equal(config.tactic, undefined); assert.equal(config.follow, undefined); assert.equal(config.leave, undefined);
  assert.equal(config.token, 'drive-00000000000000000001');
  for (const change of [p => p.route.channel = 'phone', p => p.route.channel = 'group', p => p.input.group = {id: 'g', index: 1},
    p => p.input.reaction = {phase: 'after'}, p => p.input.channel = 'phone', p => p.identified = false, p => p.sendAllowed = false,
    p => p.input.reactionOffer.actor.id = '99ULL', p => p.input.reactionOffer.actor.key = 'npc-other', p => p.input.requestId = '100-7-44ULL',
    p => p.input.reactionOffer = {...offer(), kinds: []}, p => delete p.input.reactionOffer]) {
    const {broker: other, options: opts} = fixture(), p = prepared(); change(p);
    assert.equal(other.admit(p, opts), null);
  }
  // A group round never carries a reaction.
  const group = fixture(), g = prepared(); g.route.channel = 'group'; g.input.channel = 'group'; g.input.group = {id: 'g', index: 1};
  assert.equal(group.broker.admit(g, {...group.options, source: 'group-text'}), null);
  // A person with a companion offer is a companion: the reaction offer beside it is ignored.
  const mixed = fixture(), m = prepared(); m.input.followOffer = {available: true, actor: {id: '44ULL', key: KEY_NPC}, name: 'Judy'};
  const mixedConfig = mixed.broker.admit(m, mixed.options);
  assert.ok(mixedConfig.follow); assert.equal(mixedConfig.reaction, undefined);
});

test('the real knowledge router admits an ordinary NPC turn, so the offer reaches the Convai window and the text host', async () => {
  const boundary = {worldToken: 'world-fixture', generation: 2};
  const guard = {endUserId: 'fixture-user', characterId: 'fixture-character', resetEpoch: 0, characterEpoch: 0};
  const router = new PlayerKnowledge({
    playerMemory: {route: () => ({endUserId: guard.endUserId, guard}), isCurrent: value => JSON.stringify(value) === JSON.stringify(guard)},
    pack: {version: 1, id: 'reactions-fixture', revision: 1, gameVersions: ['2.31'], profileKeys: [KEY_NPC],
      sources: [], evidence: [], factAllowlist: {}, journalAllowlist: {}, rules: []},
    getBoundary: () => boundary, isWorldCurrent: () => true,
  });
  const native = structuredClone(prepared().input); delete native.channel;
  const parsed = parseInput(JSON.stringify(native));
  const actual = await router.prepare(parsed, boundary);
  assert.equal(actual.identified, true, 'an ordinary NPC turn carries the player\'s end-user id like any other');
  assert.deepEqual(actual.input.reactionOffer, offer());
  const {broker} = fixture();
  const config = broker.admit(actual, {source: 'private-text', isCurrent: () => router.current(actual), isCurrentSync: () => router.currentSync(actual)});
  assert.deepEqual(config.reaction, {kinds: ['leave', 'call-police']});
});

test('delivery makes one npc-reaction packet from the frozen offer, once, only for an offered kind', async () => {
  const {broker, options, files} = fixture(), p = prepared(), config = broker.admit(p, options);
  p.input.reactionOffer.kinds.push('attack');   // the live input changes after admission
  const message = kind => ({version: 1, token: config.token, reaction: kind});
  assert.equal(await broker.deliver(message('attack')), false, 'not offered');
  assert.equal(await broker.deliver({version: 1, token: config.token}), false, 'a ride is not offered to a person');
  assert.equal(await broker.deliver({version: 1, token: config.token, tactic: 'fight'}), false);
  assert.equal(await broker.deliver({version: 1, token: config.token, follow: true}), false);
  assert.equal(await broker.deliver({version: 1, token: config.token, leave: 1}), false);
  assert.equal(await broker.deliver({...message('leave'), extra: 1}), false);
  assert.equal(await broker.deliver({version: 1, token: 'drive-wrongwrongwrongwrong', reaction: 'leave'}), false);
  assert.deepEqual(await Promise.all([broker.deliver(message('call-police')), broker.deliver(message('call-police'))]), [true, false]);
  assert.equal(files.filter(packet => packet.action === 'npc-reaction').length, 1);
  const packet = files.find(item => item.action === 'npc-reaction');
  assert.equal(packet.reaction, 'call-police');
  assert.deepEqual(packet.reactionOffer, offer(), 'the offer the game made, not the changed input');
  assert.equal(packet.requestId, '100-4-44ULL'); assert.equal(packet.entity, '44ULL'); assert.equal(packet.profileKey, KEY_NPC);
  assert.equal(packet.worldGeneration, 2); assert.equal(packet.expiresAt - packet.createdAt, 5000);
});

test('a new turn, a stale world and expiry each reject a late reaction', async () => {
  const a = fixture(), configA = a.broker.admit(prepared(), a.options);
  a.stale();
  assert.equal(await a.broker.deliver({version: 1, token: configA.token, reaction: 'leave'}), false);
  const b = fixture(), configB = b.broker.admit(prepared(), b.options);
  b.advance(95000);
  assert.equal(await b.broker.deliver({version: 1, token: configB.token, reaction: 'leave'}), false);
  const c = fixture(), configC = c.broker.admit(prepared(), c.options);
  const next = prepared(); next.input.requestId = '101-4-44ULL';
  c.broker.admit(next, c.options);
  assert.equal(await c.broker.deliver({version: 1, token: configC.token, reaction: 'leave'}), false);
  assert.equal(c.files.filter(packet => packet.action !== 'none').length, 0, 'only empty mailboxes were written');
});

// ---- The Convai route: the action window -----------------------------------------------------------------------------------

test('Convai: the window accepts exactly one offered reaction action, bound to this request, and nothing else', () => {
  let now = 1000;
  const window = new CompanionActionWindow({now: () => now});
  const open = (kinds = ['leave', 'call-police']) => window.open({version: 1, token: TOKEN, source: 'private-text', expiresAt: now + 60000, drive: false, reaction: {kinds}});
  assert.equal(open(), true);
  const proposal = (name, target) => ({actions: [{name, ...(target === undefined ? {} : {target})}]});
  assert.equal(window.accept(proposal('Attack V ' + TOKEN, TOKEN)), null, 'a kind that was not offered');
  assert.equal(window.accept(proposal('Attack V', TOKEN)), null);
  assert.equal(window.accept(proposal('Drive To Waypoint', TOKEN)), null);
  assert.equal(window.accept(proposal('Walk Away', 'other-token')), null);
  assert.equal(window.accept({actions: [{name: 'Walk Away ' + TOKEN}, {name: 'Call Police ' + TOKEN}]}), null, 'two proposals at once');
  assert.equal(window.accept({actions: [{name: 'Walk Away ' + TOKEN, arbitrary: 1}]}), null);
  assert.deepEqual(window.accept(proposal('Call Police ' + TOKEN)), {version: 1, token: TOKEN, reaction: 'call-police'});
  assert.equal(window.accept(proposal('Call Police ' + TOKEN)), null, 'consumed');
  assert.equal(open(), true);
  assert.deepEqual(window.accept(proposal('Walk Away', TOKEN)), {version: 1, token: TOKEN, reaction: 'leave'}, 'the plain name with the target works too');
  // Bad windows are not opened.
  const bad = reaction => window.open({version: 1, token: TOKEN, source: 'private-text', expiresAt: now + 60000, drive: false, reaction});
  assert.equal(bad({kinds: []}), false); assert.equal(bad({kinds: ['teleport']}), false); assert.equal(bad({kinds: ['leave', 'leave']}), false);
  assert.equal(window.open({version: 1, token: TOKEN, source: 'private-text', expiresAt: now + 60000, reaction: {kinds: ['leave']}}), false, 'not beside a drive offer');
  assert.equal(window.open({version: 1, token: TOKEN, source: 'group-text', expiresAt: now + 60000, drive: false, group: true, reaction: {kinds: ['leave']}}), false);
  assert.equal(window.open({version: 1, token: TOKEN, source: 'private-text', expiresAt: now + 60000, drive: false, reaction: {kinds: ['leave']}, follow: {name: 'Judy'}}), false);
});

test('Convai: the context text is short, rare-worded and names only the offered actions; the action list carries the same names', () => {
  const text = CompanionActionWindow.contextText({version: 1, token: TOKEN, drive: false, reaction: {kinds: ['leave', 'attack']}});
  assert.ok(text.length < 1100, `short: ${text.length}`);
  assert.match(text, /rare/i); assert.match(text, /almost every reply has no action/);
  assert.match(text, /"Walk Away drive-[^"]+" means you end the talk and walk or run away/);
  assert.match(text, /"Attack V drive-[^"]+" means you turn on V and attack/);
  assert.doesNotMatch(text, /Call Police|Drive To Waypoint/);
  assert.match(text, /never say them aloud/);
  assert.equal(CompanionActionWindow.contextText({version: 1, token: TOKEN, drive: false, follow: {name: 'Judy'}}).includes('Walk Away'), false, 'companions are untouched');
  assert.equal(reactionActionName({token: TOKEN}, 'leave'), 'Walk Away ' + TOKEN);
  assert.equal(reactionActionName({token: 'bad'}, 'leave'), null);
  assert.equal(reactionActionName({token: TOKEN}, 'teleport'), null);
  // A window that could not publish its action list still says nothing about the reaction.
  assert.equal(CompanionActionWindow.unavailableText({version: 1, token: TOKEN, drive: false, reaction: {kinds: ['leave']}}), '');
});

test('Convai: the action list published with the context holds exactly the offered reaction names, and clears with the next ordinary request', async () => {
  const sent = [], client = {isBotReady: true, room: {localParticipant: {sid: 'local',
    publishData: async (bytes, options) => sent.push({message: JSON.parse(new TextDecoder().decode(bytes)), options})}}};
  const offered = {token: TOKEN, drive: false, reaction: {kinds: ['leave', 'attack']}};
  await publishCompanionActionContext(client, {text: 'Current native context', mode: 'replace', run_llm: 'true'}, offered);
  assert.equal(sent.length, 1); assert.equal(sent[0].message.type, 'context-update');
  assert.deepEqual(sent[0].options, {reliable: true});
  assert.equal(sent[0].message.data.run_llm, 'false', 'one silent update, never an extra utterance');
  assert.deepEqual(sent[0].message.data.action_config.actions, ['Walk Away ' + TOKEN, 'Attack V ' + TOKEN]);
  assert.equal(sent[0].message.data.action_config.objects[0].name, TOKEN);
  assert.equal(sent[0].message.data.current_attention_object, TOKEN);
  await publishCompanionActionContext(client, {text: 'Next ordinary request', mode: 'replace'}, null);
  assert.deepEqual(sent[1].message.data.action_config, {actions: [], objects: [], characters: [], current_attention_object: ''});
  // A companion's follow offer publishes its own name and nothing of the reaction.
  await publishCompanionActionContext(client, {text: 'x', mode: 'replace'}, {token: TOKEN, drive: false, follow: {name: 'Judy'}});
  assert.deepEqual(sent[2].message.data.action_config.actions, ['Follow V ' + TOKEN]);
});

// ---- A whole turn on every text provider -----------------------------------------------------------------------------------

async function customHarness(mock) {
  const custom = new CustomEndpoint({path: null});
  await custom.setUrl(parseEndpointUrl(mock.url)); await custom.setModel('vendor/test-model');
  await custom.setKey(KEY);
  const provider = new MistralProvider({keyPath: 'k', readText: async () => { throw Error('none'); }, writeText: async () => {}, custom});
  await provider.load(); provider.setPreference('custom'); provider.apply();
  const delivered = [], logs = [], memory = await MistralMemory.open({path: null});
  const route = customRoute({provider, custom, chat: options => streamChat({...options, ...quick})});
  const host = new TextProviderHost({provider, memory, personas: book, routes: {custom: route},
    log: line => logs.push(line), deliverAction: async message => { delivered.push(message); return true; }});
  return {host, delivered, logs, memory};
}
const said = text => () => ({sse: [text]});

test('custom provider: a threat answered with a closing tag hands the reaction to the game, and no tag is spoken, shown or remembered', async () => {
  const mock = await startOpenAiMock();
  const {host, delivered, memory} = await customHarness(mock);
  const streamed = [];
  try {
    mock.behave(said('Back off, or I swear I will call the cops on you. [call-police]'));
    const result = await host.reply(turn('give me your money or I will cut you', {companionAction: reactionConfig(['leave', 'call-police'])}),
      {stream: {update: text => streamed.push(text), finish() {}, fail() {}, reconcile: text => text, committed: false, head: ''}});
    await settle();
    assert.equal(result.text, 'Back off, or I swear I will call the cops on you.');
    assert.deepEqual(delivered, [{version: 1, token: TOKEN, reaction: 'call-police'}]);
    assert.ok(streamed.every(text => !/\[|call-police/i.test(text)), 'the streamed view never shows the tag: ' + JSON.stringify(streamed));
    assert.equal(mock.requests.length, 1, 'one request: the reply decides, there is no decision request');
    const prompt = mock.requests[0].body.messages.map(message => message.content).join('\n');
    assert.match(prompt, /GAME REACTION \(rare\)/); assert.match(prompt, /\[leave\]/); assert.match(prompt, /\[call-police\]/); assert.doesNotMatch(prompt, /\[attack\]/);
    const recalled = memory.recall({profileKey: KEY_NPC, channel: 'private', ambientKey: 'npc-1:44ULL'});
    assert.equal(recalled.turns.at(-1).r, 'Back off, or I swear I will call the cops on you.');
  } finally { host.close(); await mock.close(); }
});

test('custom provider: a tag split across the stream never reaches the voice, the head or the finished text, and the reaction still arrives', async () => {
  const mock = await startOpenAiMock();
  const {host, delivered} = await customHarness(mock);
  try {
    // Different words each time: a reply that says a line it said before is asked again, which is not what is under test.
    for (const [first, second, pieces] of [
      ['Listen here, you had better get away from me right now. ', 'I am dead serious about this.', ['Listen here, you had better get away from me right now. ', 'I am dead serious about this. [call', '-police]']],
      ['Pal, I will not say it a second time, back away from me. ', 'My patience ran out a while ago.', ['Pal, I will not say it a second time, back away from me. ', 'My patience ran out a while ago. [', 'call-', 'police', ']']],
      ['Hey, do not touch my bag, I am warning you right here. ', 'Next time I scream for the cops.', ['Hey, do not touch my bag, I am warning you right here. Next time I scream for the cops. [call-police]']],
    ]) {
      delivered.length = 0;
      mock.behave(() => ({sse: pieces}));
      const stream = new ReplyStream({name: 'Street local'});
      const seen = [];
      stream.onChange(() => seen.push(stream.text));
      const result = await host.reply(turn('stay away or I will hurt you', {companionAction: reactionConfig(['leave', 'call-police'])}), {stream});
      await settle();
      assert.equal(result.text, first + second);
      assert.deepEqual(delivered, [{version: 1, token: TOKEN, reaction: 'call-police'}], JSON.stringify(pieces));
      assert.ok(stream.committed, 'the first sentence was voiced early');
      for (const text of [stream.head, stream.text, stream.view, ...seen]) assert.doesNotMatch(String(text), /\[|police|call-/i, JSON.stringify(text));
    }
  } finally { host.close(); await mock.close(); }
});

test('custom provider: rare means rare: no tag, a tag for a kind not offered, a tag that opens the reply, two tags and a bark each deliver nothing', async () => {
  const mock = await startOpenAiMock();
  const {host, delivered, logs} = await customHarness(mock);
  try {
    const cases = [
      ['Whatever, man. Move along.', 'no tag'],
      ['You will regret this. [attack]', 'attack was not offered to a civilian'],
      ['[leave] You will regret this.', 'a tag first'],
      ['Done with you. [leave] Done. [leave]', 'two tags'],
    ];
    for (const [reply] of cases) {
      mock.behave(said(reply));
      const result = await host.reply(turn('hey, nice jacket you got there', {companionAction: reactionConfig(['leave', 'call-police'])}));
      assert.doesNotMatch(result.text, /\[/, reply);
    }
    await settle();
    assert.deepEqual(delivered, []);
    assert.ok(logs.some(line => /NPC reaction tag in the reply was not used \(not-offered\)/.test(line)), logs.join('|'));
    assert.ok(logs.some(line => /not used \(not-at-end\)/.test(line)));
    // A turn that offers nothing: the instruction is not in the prompt and a stray tag does nothing.
    const before = mock.requests.length;
    mock.behave(said('Get lost. [leave]'));
    const plain = await host.reply(turn('hello there'));
    await settle();
    assert.equal(plain.text, 'Get lost.');
    assert.deepEqual(delivered, []);
    assert.doesNotMatch(mock.requests[before].body.messages.map(message => message.content).join('\n'), /GAME REACTION/);
    // A battle bark of an ordinary NPC is never a conversation: no instruction, no action.
    mock.behave(said('Run! [leave]'));
    await host.reply(turn('[EVENT] shots fired', {reaction: {kind: 'battle', phase: 'start'}, companionAction: reactionConfig(['leave'])}));
    await settle();
    assert.deepEqual(delivered, []);
  } finally { host.close(); await mock.close(); }
});

test('custom provider: a ganger offered leave and attack, a cop offered attack, a clerk offered the police: each can only do what it was offered', async () => {
  const mock = await startOpenAiMock();
  const {host, delivered} = await customHarness(mock);
  try {
    const rows = [
      [['leave', 'attack'], 'Last warning. [attack]', 'attack'],
      [['leave', 'attack'], 'I am out of here. [leave]', 'leave'],
      [['leave', 'attack'], 'I am calling it in. [call-police]', null],
      [['attack'], 'You will not talk to a cop like that. [attack]', 'attack'],
      [['attack'], 'Fine, I will leave. [leave]', null],
      [['call-police'], 'Sir, I am calling the NCPD. [call-police]', 'call-police'],
      [['call-police'], 'Sir, get out of my shop. [leave]', null],
    ];
    for (const [kinds, reply, expected] of rows) {
      delivered.length = 0;
      mock.behave(said(reply));
      await host.reply(turn('you are going to pay for that, I swear', {companionAction: reactionConfig(kinds)}));
      await settle();
      assert.deepEqual(delivered, expected ? [{version: 1, token: TOKEN, reaction: expected}] : [], `${kinds} ${reply}`);
    }
  } finally { host.close(); await mock.close(); }
});

// Mistral and the local AI go through the same host: a fake chat function replaces the network.
async function fakeChatHost(route, name, reply) {
  const delivered = [], seen = [];
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${KEY}\n`, writeText: async () => {}});
  await provider.load(); provider.setPreference(name === 'local' ? 'local' : 'mistral'); provider.apply();
  route.chat = async options => {
    seen.push(options.messages);
    options.onDelta?.(reply);
    return {text: reply, model: 'm', finishReason: 'stop', usage: {}, attempts: 1, failed: [], trace: {}};
  };
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, routes: {[name]: route},
    log: () => {}, deliverAction: async message => { delivered.push(message); return true; }});
  return {host, delivered, seen};
}

test('Mistral and the local AI: the same turn, the same rule, the same message to the game', async () => {
  const provider = {apiKey: KEY, noteSuccess() {}, noteLimit() {}, limit: null};
  const server = {ensure: async () => ({apiKey: KEY, endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'm', requestModel: 'm', trustedOrigin: 'http://127.0.0.1:1', contextSize: 0}),
    status: () => ({state: 'ready', model: 'm'}), begin: () => () => {}, touch() {}, preempt: () => false, noteSlot() {}};
  const routes = {
    mistral: () => mistralRoute({provider, gapMs: 0}),
    local: () => localRoute({server, provider: {noteLocalFailure() {}, noteLocalTurnFallback() {}}}),
  };
  for (const name of ['mistral', 'local']) {
    const tagged = await fakeChatHost(routes[name](), name, 'Stay away from me. [leave]');
    try {
      const result = await tagged.host.reply(turn('I will break your arm', {companionAction: reactionConfig(['leave', 'call-police'])}));
      await settle();
      assert.equal(result.text, 'Stay away from me.', name);
      assert.deepEqual(tagged.delivered, [{version: 1, token: TOKEN, reaction: 'leave'}], name);
      assert.equal(tagged.seen.length, 1, `${name}: one request, no decision`);
      assert.match(tagged.seen[0].map(message => message.content).join('\n'), /GAME REACTION \(rare\)/);
    } finally { tagged.host.close(); }
    const calm = await fakeChatHost(routes[name](), name, 'Sure, whatever you say.');
    try {
      await calm.host.reply(turn('nice weather', {companionAction: reactionConfig(['leave', 'call-police'])}));
      await settle();
      assert.deepEqual(calm.delivered, [], name);
    } finally { calm.host.close(); }
  }
});

test('companions are unaffected: their turns carry no instruction, and a tag a model writes for one is cut but never acted on', async () => {
  const mock = await startOpenAiMock();
  const {host, delivered} = await customHarness(mock);
  try {
    const judy = {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'};
    const companionOffer = {version: 1, token: TOKEN, source: 'private-text', expiresAt: 99999, drive: false, leave: {members: [{name: 'Judy Alvarez', self: true}]}};
    mock.behave(request => ({sse: [isDecision(request.body) ? 'NONE' : 'Fine, V. [leave]']}));
    const result = await host.reply({text: 'how are you', context: 'x', sessionId: 's', local: judy, companionAction: companionOffer,
      contextParts: {now: '', notes: '', world: '', volatile: ''}});
    await settle();
    assert.equal(result.text, 'Fine, V.');
    assert.deepEqual(delivered, [], 'a [leave] in a companion\'s reply never starts anything');
    for (const request of mock.requests) assert.doesNotMatch(request.body.messages.map(message => message.content).join('\n'), /GAME REACTION/);
    // A reaction offer on a profile that is a companion's still follows the offer, not the profile: the game never makes one (docs/NPC_REACTIONS.md).
    assert.equal(actionMenu(companionOffer).codes.includes('LEAVE'), true, 'the companion leave menu is as before');
  } finally { host.close(); await mock.close(); }
});
