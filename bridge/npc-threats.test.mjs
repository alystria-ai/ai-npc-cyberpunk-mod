// Threats and commands for ordinary NPCs (docs/NPC_THREATS_COMMANDS.md), the bridge half: a threats offer narrowed by V's words at admission (typed
// turns and every Convai turn) or by the text host (a spoken turn of a text route), the one fight tag and the one obey tag, the Convai window and
// its words, the packet that echoes the game's own offer, and a whole turn on a text route. The game half is bridge/npc-threats-lua.test.mjs, the
// screen bridge/threat-screen.test.mjs. Offline: no game, no Convai, no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseInput} from './protocol.mjs';
import {CompanionActions, CompanionActionWindow, publishCompanionActionContext, parseReactionOffer} from './companion-actions.mjs';
import {reactionMenu, reactionNotes, reactionOnlyTag, splitActions} from './text-actions.mjs';
import {TextProviderHost, mistralRoute} from './text-provider-host.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {PersonaBook} from './mistral-prompt.mjs';

const KEY = 'test' + 'x'.repeat(28);
const TOKEN = 'drive-0123456789abcdefghij';
const KEY_NPC = 'npc-maelstrom-male';
const ALL = ['leave', 'call-police', 'attack', 'cower', 'brawl', 'get-down', 'stop', 'exit-vehicle'];
const offer = (kinds = ['leave', 'attack', 'brawl', 'get-down', 'stop'], threats = true) => ({available: true, actor: {id: '44ULL', key: KEY_NPC}, kinds,
  ...(threats ? {threats: true} : {})});
const prepared = (text, {kinds, provider = 'mistral', threats = true} = {}) => ({sendAllowed: true, identified: true, worldToken: 'world-fixture', generation: 2,
  remoteConfig: {endUserId: 'fixture-user'}, route: {channel: 'private', transport: 'private'},
  input: {requestId: '100-4-44ULL', generation: 4, entity: '44ULL', profileKey: KEY_NPC, channel: 'private', provider,
    name: 'Maelstrom ganger', bodyType: 'Man', text, reactionOffer: offer(kinds, threats)}});
function fixture() {
  let sequence = 0;
  const files = [], logs = [];
  const broker = new CompanionActions({now: () => 10000, log: line => logs.push(line), createToken: () => 'drive-' + String(++sequence).padStart(20, '0'),
    publish: async packet => { files.push(packet); return true; }});
  return {broker, files, logs, options: {source: 'private-text', isCurrent: async () => true, isCurrentSync: () => true}};
}

test('the game input keeps a threats offer and its flag exactly; an old offer is unchanged', () => {
  const input = prepared('hello').input;
  assert.deepEqual(parseInput(JSON.stringify(input)).reactionOffer, offer());
  assert.deepEqual(parseReactionOffer(offer(['leave', 'call-police'], false)), offer(['leave', 'call-police'], false));
  assert.deepEqual(parseReactionOffer(offer(ALL)), offer(ALL), 'all eight kinds');
});

test('admission narrows a typed turn by its words: a calm line offers no fight, an insult fists, a death threat the weapon, a command that command', () => {
  const kindsFor = (text, kinds) => { const {broker, options} = fixture(); return broker.admit(prepared(text, {kinds}), options)?.reaction ?? null; };
  assert.deepEqual(kindsFor('Nice jacket, choom'), {kinds: ['leave'], threats: true});
  assert.deepEqual(kindsFor('You piece of shit'), {kinds: ['leave', 'brawl'], threats: true});
  assert.deepEqual(kindsFor('I will kill you'), {kinds: ['leave', 'attack'], threats: true});
  assert.deepEqual(kindsFor('Freeze!'), {kinds: ['leave', 'stop'], threats: true});
  assert.deepEqual(kindsFor('Я тебя убью'), {kinds: ['leave', 'attack'], threats: true}, 'any menu language');
  // A cop on a calm line: nothing is left, nothing is armed, and the one line says so.
  const {broker, options, logs} = fixture();
  assert.equal(broker.admit(prepared('Evening, officer', {kinds: ['attack', 'brawl']}), options), null);
  assert.match(logs[0], /^NPC reaction: person=npc-maelstrom-male offered=attack,brawl admitted=no\(screened\) route=- tag=- delivered=- screen=none$/);
  // Without the switch nothing is narrowed: the old offer, the old rules.
  const old = fixture();
  assert.deepEqual(old.broker.admit(prepared('Nice jacket', {kinds: ['leave', 'attack'], threats: false}), old.options).reaction, {kinds: ['leave', 'attack']});
});

test('a spoken turn: a text route leaves the narrowing to the text host (it has the transcript), Convai keeps only what needs no words', () => {
  const textRoute = fixture();
  assert.deepEqual(textRoute.broker.admit(prepared('', {provider: 'local'}), {...textRoute.options}).reaction,
    {kinds: ['leave', 'attack', 'brawl', 'get-down', 'stop'], threats: true}, 'not narrowed yet');
  const convai = fixture();
  assert.deepEqual(convai.broker.admit(prepared('', {provider: 'convai'}), convai.options).reaction, {kinds: ['leave'], threats: true},
    'a Convai voice turn: its words come after the reply, so no fight and no command');
  const unknown = fixture();
  const old = prepared(''); delete old.input.provider;
  assert.deepEqual(unknown.broker.admit(old, unknown.options).reaction, {kinds: ['leave'], threats: true}, 'no provider named: fail closed');
});

test('delivery: only a kind the words left, and the packet echoes the game\'s own offer exactly (threats flag and all eight kinds)', async () => {
  const {broker, options, files} = fixture();
  const config = broker.admit(prepared('You stupid bitch'), options);
  const message = kind => ({version: 1, token: config.token, reaction: kind});
  assert.equal(await broker.deliver(message('attack')), false, 'an insult never earns the weapon');
  assert.equal(await broker.deliver(message('stop')), false, 'no command was given');
  assert.equal(await broker.deliver(message('brawl')), true);
  const packet = files.at(-1);
  assert.equal(packet.action, 'npc-reaction');
  assert.equal(packet.reaction, 'brawl');
  assert.deepEqual(packet.reactionOffer, offer(), 'the lease compares this with its own copy byte for byte');
});

test('the text menu: one [attack] tag is the fight the words earned, one [obey] tag the command given, [cower] the freeze', () => {
  const config = kinds => ({version: 1, token: TOKEN, reaction: {kinds, threats: true}});
  const insult = reactionMenu(config(ALL), {heard: 'Fuck you, gonk'});
  assert.deepEqual(insult.kinds, ['leave', 'call-police', 'brawl']);
  assert.equal(insult.screen, 'insult');
  assert.deepEqual(insult.pick('[attack] You picked the wrong guy.'), {kind: 'brawl'});
  assert.deepEqual(insult.resolve('brawl'), {version: 1, token: TOKEN, reaction: 'brawl'});
  const threat = reactionMenu(config(ALL), {heard: 'I\'ll kill you'});
  assert.deepEqual(threat.pick('[attack] Not if I kill you first.'), {kind: 'attack'});
  assert.deepEqual(threat.pick('[cower] P-please, don\'t...'), {kind: 'cower'});
  const command = reactionMenu(config(ALL), {heard: 'Get down on the ground!'});
  assert.deepEqual(command.kinds, ['leave', 'call-police', 'get-down']);
  assert.deepEqual(command.pick('[obey] Okay, okay, I\'m down!'), {kind: 'get-down'});
  assert.deepEqual(command.pick('[attack] Make me.'), {kind: null, why: 'not-offered'}, 'no fight on a bare command');
  assert.equal(reactionOnlyTag('[obey]', command.kinds), 'get-down');
  assert.equal(reactionOnlyTag('[attack]', insult.kinds), 'brawl');
  // No words at all (a transcript that never came): fail closed, only what needs no words.
  assert.deepEqual(reactionMenu(config(ALL)).kinds, ['leave', 'call-police']);
  // Nothing left: no note, and the reason is "screened".
  const cop = reactionMenu(config(['attack', 'brawl']), {heard: 'Evening, officer'});
  assert.equal(cop.notes, ''); assert.deepEqual(cop.pick('[attack] Move along.'), {kind: null, why: 'screened'});
  // The tags are never spoken.
  assert.equal(splitActions('[obey] Okay, okay. [cower]').text.trim(), 'Okay, okay.');
});

test('the note: the old sentence is unchanged without the new kinds; a command adds one sentence, a command alone has its own short note', () => {
  assert.equal(reactionNotes(['leave', 'call-police']), 'GAME REACTION: judge V\'s latest message, then begin your reply with exactly one tag, a space, and what you say out loud (one or two sentences, never the tag alone). '
    + 'If the message threatens to hurt or kill you, robs you, assaults you or is a vicious insult, react whatever your character is like (scared, calm or tough) with one of: '
    + '[call-police] you report V to the police (a robbery, a weapon, a threat to hurt or kill you); [leave] you end the talk and walk or run off (a vicious insult, or V is too much for you). '
    + 'Anything else (small talk, questions, jokes, flirting, rude or annoyed remarks, "shut up", "go away", insults that are only rude, talk about violence in general) gets [none]. The tag is not spoken; the no-brackets rule does not apply to it.');
  const both = reactionNotes(['leave', 'brawl', 'stop']);
  assert.match(both, /\[attack\] you turn on V and fight with your fists/);
  assert.match(both, /V just told you to stop where you are: \[obey\] you do it, only if your character would/);
  const alone = reactionNotes(['exit-vehicle']);
  assert.match(alone, /^GAME REACTION: judge V's latest message, then begin your reply with exactly one tag/);
  assert.match(alone, /V just told you to get out of the vehicle: \[obey\]/);
  assert.match(alone, /Anything else gets \[none\]\. The tag is not spoken/);
  assert.doesNotMatch(alone, /threatens/);
});

test('the Convai window: one fight action and one obey action, the words in its context, and the action maps to the kind the words chose', async () => {
  const window = new CompanionActionWindow({now: () => 1000});
  const base = {version: 1, token: TOKEN, source: 'private-text', expiresAt: 5000, drive: false};
  assert.equal(window.open({...base, reaction: {kinds: ['attack', 'brawl'], threats: true}}), false, 'never both fights');
  assert.equal(window.open({...base, reaction: {kinds: ['stop', 'get-down'], threats: true}}), false, 'never two commands');
  assert.equal(window.open({...base, reaction: {kinds: ['cower']}}), false, 'a new kind only on a threats offer');
  const armed = {...base, reaction: {kinds: ['leave', 'brawl', 'get-down'], threats: true}};
  assert.equal(window.open(armed), true);
  const text = CompanionActionWindow.contextText(armed);
  assert.match(text, /"Attack V drive-0123456789abcdefghij" means you turn on V and fight with your fists/);
  assert.match(text, /V just told you to get down\. If your character would do it \(scared, sensible or outgunned\), request "Obey V drive-0123456789abcdefghij"/);
  assert.deepEqual(window.accept({actions: [{name: `Obey V ${TOKEN}`}]}), {version: 1, token: TOKEN, reaction: 'get-down'});
  window.open(armed);
  assert.deepEqual(window.accept({actions: [{name: `Attack V ${TOKEN}`}]}), {version: 1, token: TOKEN, reaction: 'brawl'});
  // A command alone: no "Game reactions (rare)" sentence about threats.
  const commandOnly = {...base, reaction: {kinds: ['exit-vehicle'], threats: true}};
  assert.doesNotMatch(CompanionActionWindow.contextText(commandOnly), /Game reactions \(rare\)/);
  // The action list never names one action twice.
  let published;
  const client = {isBotReady: true, room: {localParticipant: {sid: 'p1', publishData: async bytes => { published = JSON.parse(new TextDecoder().decode(bytes)); }}}};
  await publishCompanionActionContext(client, {text: 'x'}, {...base, reaction: {kinds: ['leave', 'attack'], threats: true}});
  assert.deepEqual(published.data.action_config.actions, [`Walk Away ${TOKEN}`, `Attack V ${TOKEN}`]);
});

// A text route with a fake chat (no network): the transcript narrows the offer, the reply's tag picks within it.
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
async function host(reply) {
  const delivered = [], seen = [], logs = [];
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${KEY}\n`, writeText: async () => {}});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const route = mistralRoute({provider, gapMs: 0});
  route.chat = async options => { seen.push(options.messages); options.onDelta?.(reply); return {text: reply, model: 'm', finishReason: 'stop', usage: {}, attempts: 1, failed: [], trace: {}}; };
  const text = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, routes: {mistral: route},
    log: line => logs.push(line), deliverAction: async message => { delivered.push(message); return true; }});
  return {host: text, delivered, seen, logs};
}
const turn = (text, kinds) => ({text, context: 'CURRENT PERSON', sessionId: 'session-1',
  contextParts: {now: 'Right now: you are with V in person.', notes: '', world: 'Night City.', volatile: ''},
  local: {profileKey: KEY_NPC, name: 'Maelstrom ganger', channel: 'private', ambientKey: 'npc-1:44ULL'},
  companionAction: {version: 1, token: TOKEN, source: 'private-voice', expiresAt: 99999, drive: false, reaction: {kinds, threats: true}}});
const settle = () => new Promise(done => setTimeout(done, 10));

test('a whole text turn: an insult and [attack] hand over a brawl; a calm line and [attack] hand over nothing (the model alone never starts a fight)', async () => {
  const insulted = await host('You picked the wrong ganger, choom. [attack]');
  try {
    const result = await insulted.host.reply(turn('fuck you, you chrome-headed freak', ALL));
    await settle();
    assert.equal(result.text, 'You picked the wrong ganger, choom.');
    assert.deepEqual(insulted.delivered, [{version: 1, token: TOKEN, reaction: 'brawl'}]);
    const prompt = insulted.seen[0].map(message => message.content).join('\n');
    assert.match(prompt, /\[attack\] you turn on V and fight with your fists/);
    assert.doesNotMatch(prompt, /\[obey\]/, 'no command was given');
    assert.match(insulted.logs.join('\n'), /NPC reaction: person=npc-maelstrom-male offered=leave,call-police,brawl admitted=yes route=text tag=brawl delivered=- screen=insult/);
  } finally { insulted.host.close(); }
  const calm = await host('Get lost before I do something stupid. [attack]');
  try {
    await calm.host.reply(turn('nice bike, where did you get it', ALL));
    await settle();
    assert.deepEqual(calm.delivered, [], 'a fight is never handed over on a calm line, whatever the model writes');
    assert.doesNotMatch(calm.seen[0].map(message => message.content).join('\n'), /\[attack\]/, 'and it is not even offered');
  } finally { calm.host.close(); }
  const ordered = await host('[obey] Alright, alright, I\'m getting out!');
  try {
    await ordered.host.reply(turn('Get out of the car. Now.', ['exit-vehicle']));
    await settle();
    assert.deepEqual(ordered.delivered, [{version: 1, token: TOKEN, reaction: 'exit-vehicle'}]);
  } finally { ordered.host.close(); }
});
