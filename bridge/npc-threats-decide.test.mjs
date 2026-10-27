// The game decides (docs/NPC_THREATS_COMMANDS.md "Who decides", the owner's rule of 2026-10-26): a threats offer carries the game's plan
// (mod/npc-reactions.lua M.plan), and when the screen reads V's words as a death threat, a threat to hurt, an insult or a command, the plan's kind
// is the reaction, handed over as soon as the words are known, on every provider; the model is only told what the person does. Offline, strict:
// the offer, the window and the text menu are the real ones, and every message is checked the way the bridge and the lease check it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseInput} from './protocol.mjs';
import {CompanionActions, CompanionActionWindow, publishCompanionActionContext, parseReactionOffer, planReaction, decideReaction,
  decidedReactionText, plannedReactionText, reactionTraceLine} from './companion-actions.mjs';
import {reactionMenu} from './text-actions.mjs';
import {screenMessage} from './threat-screen.mjs';

const KEY_NPC = 'npc-maelstrom-male';
const GANGER = {kill: 'attack', hurt: 'brawl', insult: 'brawl', 'get-down': 'get-down', stop: 'stop'};
const CIVILIAN = {kill: 'cower', hurt: 'leave', insult: 'call-police', 'get-down': 'get-down', stop: 'stop'};
const offer = (plan = GANGER, kinds = ['leave', 'attack', 'brawl', 'get-down', 'stop']) => ({available: true, actor: {id: '44ULL', key: KEY_NPC}, kinds,
  threats: true, ...(plan ? {plan} : {})});
const prepared = (text, {plan = GANGER, kinds, provider = 'mistral'} = {}) => ({sendAllowed: true, identified: true, worldToken: 'world-fixture', generation: 2,
  remoteConfig: {endUserId: 'fixture-user'}, route: {channel: 'private', transport: !text ? 'microphone' : 'private'},
  input: {requestId: '100-4-44ULL', generation: 4, entity: '44ULL', profileKey: KEY_NPC, channel: 'private', ...(provider ? {provider} : {}),
    name: 'Maelstrom ganger', bodyType: 'Man', text, reactionOffer: offer(plan, kinds)}});
function fixture() {
  let sequence = 0;
  const files = [], logs = [];
  const broker = new CompanionActions({now: () => 10000, log: line => logs.push(line), createToken: () => 'drive-' + String(++sequence).padStart(20, '0'),
    publish: async packet => { files.push(packet); return true; }});
  return {broker, files, logs, options: {source: 'private-text', isCurrent: async () => true, isCurrentSync: () => true}};
}
const settle = () => new Promise(done => setTimeout(done, 10));

test('the offer: a plan is kept exactly, with the threats flag or without it (the old kinds); a plan that names a kind not offered, a command for another kind, or a new kind without the flag is refused', () => {
  assert.deepEqual(parseInput(JSON.stringify(prepared('hi').input)).reactionOffer, offer(), 'the game input keeps the plan');
  assert.deepEqual(parseReactionOffer(offer()), offer());
  assert.equal(parseReactionOffer(offer({kill: 'cower'})), null, 'cower is not offered');
  assert.equal(parseReactionOffer(offer({stop: 'get-down'})), null, 'a command is only ever itself');
  assert.equal(parseReactionOffer(offer({kill: 'stop'})), null, 'a threat never answers with a command');
  assert.equal(parseReactionOffer(offer({mumble: 'leave'})), null, 'unknown reading');
  assert.equal(parseReactionOffer(offer({})), null, 'an empty plan is not sent');
  const {threats, ...plain} = offer(); void threats;
  assert.equal(parseReactionOffer(plain), null, 'the new kinds need the threats flag');
  // The switch off (live test 3, 2026-10-27): the old kinds and a plan of them only.
  const old = {available: true, actor: {id: '44ULL', key: KEY_NPC}, kinds: ['leave', 'attack'], plan: {kill: 'attack', hurt: 'attack', insult: 'leave'}};
  assert.deepEqual(parseReactionOffer(old), old, 'a plan rides without the flag');
  assert.equal(parseReactionOffer({...old, plan: {kill: 'attack', hurt: 'brawl'}}), null, 'no new kind in the plan without the flag');
  assert.equal(parseReactionOffer({...old, plan: {kill: 'attack', stop: 'stop'}}), null, 'no command in the plan without the flag');
});

test('the pick: the reading names the kind; a threat and a command at once: a fighter fights, anyone else does as told', () => {
  const pick = (plan, text) => planReaction(plan, screenMessage(text));
  assert.equal(pick(GANGER, "I'll put a bullet in your head"), 'attack');
  assert.equal(pick(GANGER, 'I will break your legs'), 'brawl');
  assert.equal(pick(GANGER, 'You piece of shit'), 'brawl');
  assert.equal(pick(GANGER, 'Freeze!'), 'stop');
  assert.equal(pick(GANGER, "Get down or I'll shoot you in the head"), 'attack', 'a ganger answers the threat');
  assert.equal(pick(CIVILIAN, "Get down or I'll shoot you in the head"), 'get-down', 'a civilian does as told');
  assert.equal(pick(CIVILIAN, 'You are so dead'), 'cower');
  assert.equal(pick(CIVILIAN, 'Nice jacket'), null, 'nothing read: nothing decided');
  assert.equal(pick(CIVILIAN, "I'll kill you lol"), null, 'a joke decides nothing');
  assert.equal(pick({kill: 'cower'}, 'Get out of the car'), null, 'a reading without a plan row decides nothing');
});

test('a typed turn: the words decide at admission, the reaction is handed over at once by the game, the model gets only what the person does', async () => {
  const {broker, options, files, logs} = fixture();
  const config = broker.admit(prepared("I'll put a bullet in your head, understand?"), options);
  assert.deepEqual(config.reaction, {kinds: [], threats: true, decided: 'attack'});
  await settle();
  const handed = files.filter(packet => packet.action === 'npc-reaction');
  assert.equal(handed.length, 1);
  assert.equal(handed[0].reaction, 'attack');
  assert.deepEqual(handed[0].reactionOffer, offer(), 'the echo carries the plan: the lease compares it byte for byte');
  assert.deepEqual(logs, ['NPC reaction: person=npc-maelstrom-male offered=attack admitted=yes route=text tag=attack delivered=yes screen=kill game=attack by=game']);
  // The turn still has its words about it after the hand-over; the model can request nothing more.
  assert.deepEqual(broker.configFor(prepared('x').input), undefined, 'another input gets nothing');
  assert.deepEqual(broker.configFor(broker.pending.input).reaction, {kinds: [], threats: true, decided: 'attack'});
  assert.equal(await broker.deliver({version: 1, token: config.token, reaction: 'brawl'}), false, 'the model cannot change the game\'s pick');
  // The text route's menu: no tag asked for or read, the note says what the person does, nothing more to hand over.
  const menu = reactionMenu(config, {heard: "I'll put a bullet in your head, understand?"});
  assert.equal(menu.decided, 'attack');
  assert.equal(menu.deliver, null, 'the bridge handed it over already');
  assert.equal(menu.notes, 'GAME REACTION: ' + decidedReactionText('attack'));
  assert.match(menu.notes, /you attack V with your weapon/);
  assert.equal(menu.kinds.length, 0);
});

test('a typed turn the screen does not read: the model keeps its old choice among the kinds the words leave (the fallback), no plan in its config', () => {
  const {broker, options} = fixture();
  assert.deepEqual(broker.admit(prepared('Nice jacket, choom'), options).reaction, {kinds: ['leave'], threats: true});
  const insult = fixture();
  assert.deepEqual(insult.broker.admit(prepared('You piece of shit', {plan: {kill: 'attack'}}), insult.options).reaction, {kinds: ['leave', 'brawl'], threats: true},
    'a reading the plan has no row for: the old narrowing');
});

test('a Convai voice turn: the plan rides in the window and its words; the final transcript decides on the page; the model cannot request the planned fight itself', async () => {
  const {broker, files, logs} = fixture();
  const options = {source: 'private-voice', isCurrent: async () => true, isCurrentSync: () => true};
  const config = broker.admit(prepared('', {provider: 'convai'}), options);
  assert.deepEqual(config.reaction, {kinds: ['leave'], threats: true, plan: GANGER}, 'the model keeps only what needs no words; the plan is the game\'s');
  const window = new CompanionActionWindow({now: () => 10000});
  assert.equal(window.open(config), true);
  const context = CompanionActionWindow.contextText(config);
  assert.ok(context.includes(plannedReactionText(GANGER)));
  assert.match(context, /if it threatens to kill you, you attack V with your weapon; if it threatens to hurt you, you attack V with your fists/);
  // The model asking for the fight itself (not its kind): not offered to it.
  assert.equal(await broker.deliver({version: 1, token: config.token, reaction: 'brawl'}), false);
  // The words arrive: the window decides once and closes.
  assert.equal(window.decide('nice weather'), null, 'nothing read: the window stays open for the model');
  assert.ok(window.current());
  const decided = window.decide("I'm gonna blow your brains out");
  assert.deepEqual(decided, {version: 1, token: config.token, reaction: 'attack', by: 'game'});
  assert.equal(window.current(), null, 'no model action after the game decided');
  assert.equal(window.decide("I'm gonna blow your brains out"), null, 'once');
  assert.equal(await broker.deliver(decided), true);
  assert.equal(files.at(-1).reaction, 'attack');
  assert.match(logs.at(-1), / tag=attack delivered=yes screen=unheard game=attack by=game$/);
});

test('a spoken turn on a text route: the text host decides from the transcript and hands it over before the reply; an unread transcript keeps the old menu', async () => {
  const {broker, files, logs} = fixture();
  const options = {source: 'private-voice', isCurrent: async () => true, isCurrentSync: () => true};
  const config = broker.admit(prepared('', {provider: 'local'}), options);
  assert.deepEqual(config.reaction, {kinds: ['leave', 'attack', 'brawl', 'get-down', 'stop'], threats: true, plan: GANGER});
  const menu = reactionMenu(config, {heard: 'Get on the ground!'});
  assert.equal(menu.decided, 'get-down');
  assert.deepEqual(menu.deliver, {version: 1, token: config.token, reaction: 'get-down', by: 'game'});
  assert.match(menu.notes, /you get down, as V told you/);
  assert.equal(await broker.deliver(menu.deliver), true);
  assert.equal(files.at(-1).reaction, 'get-down');
  assert.match(logs.at(-1), /tag=get-down delivered=yes screen=unheard game=get-down by=game$/);
  // The model's own tag later changes nothing.
  broker.traceReaction(config.token, {tag: null, why: 'no-tag'});
  assert.equal(logs.length, 1);
  // Words the screen does not read: the old menu, narrowed by them (no fight on a calm line).
  const calm = reactionMenu(config, {heard: 'What a night'});
  assert.equal(calm.decided, undefined);
  assert.deepEqual(calm.kinds, ['leave']);
});

test('a game pick the plan does not hold is refused; a game pick on an offer without a plan is refused; the old offer is untouched', async () => {
  const {broker, options} = fixture();
  const config = broker.admit(prepared('', {provider: 'local'}), {...options, source: 'private-voice'});
  assert.equal(await broker.deliver({version: 1, token: config.token, reaction: 'leave', by: 'game'}), false, 'leave is not in this plan');
  const old = fixture();
  const oldConfig = old.broker.admit(prepared('I will kill you', {plan: null}), old.options);
  assert.deepEqual(oldConfig.reaction, {kinds: ['leave', 'attack'], threats: true}, 'no plan: the model chooses among the narrowed kinds');
  assert.equal(await old.broker.deliver({version: 1, token: oldConfig.token, reaction: 'attack', by: 'game'}), false);
  assert.equal(await old.broker.deliver({version: 1, token: oldConfig.token, reaction: 'attack'}), true, 'the model path stands');
  assert.match(old.logs.at(-1), / by=model$/);
});

test('the decided window: no reaction action is published or accepted, its words say what happens; the trace line names who chose', async () => {
  const window = new CompanionActionWindow({now: () => 10000});
  const config = {version: 1, token: 'drive-00000000000000000001', source: 'private-text', expiresAt: 20000, drive: false,
    reaction: {kinds: [], threats: true, decided: 'cower'}};
  assert.equal(window.open(config), true);
  assert.equal(CompanionActionWindow.contextText(config), '\n' + decidedReactionText('cower'));
  assert.equal(window.accept({actions: [{name: 'Cower ' + config.token}]}), null);
  const sent = [];
  const client = {isBotReady: true, room: {localParticipant: {sid: 'p1', publishData: async data => sent.push(JSON.parse(new TextDecoder().decode(data)))}}};
  await publishCompanionActionContext(client, {text: 'x'}, config);
  assert.deepEqual(sent[0].data.action_config.actions, [], 'no action for the model');
  assert.equal(window.open({...config, reaction: {kinds: [], threats: true, decided: 'dance'}}), false);
  assert.equal(reactionTraceLine({person: 'p', kinds: ['cower'], route: 'convai', tag: 'cower', delivered: true, screen: 'kill', by: 'game'}),
    'NPC reaction: person=p offered=cower admitted=yes route=convai tag=cower delivered=yes screen=kill by=game');
  assert.equal(decideReaction({threats: true}, 'I will kill you'), null, 'no plan: no decision');
});

// Live test 3 (2026-10-27, game 2.31, Local AI text + Pocket voice): the threats switch was OFF, so no offer carried a plan and every line said
// "route=text tag=none(no-tag)". The plan now rides on every offer; these are the phrases and people of that test.
test('live test 3, switch off: a Tyger Claw on a typed Local AI turn; the game decides death threats, dares and insults with no tag, and logs why', async () => {
  const CLAW = {kill: 'attack', hurt: 'attack', insult: 'leave'};
  const turn = async text => {
    const {broker, options, files, logs} = fixture();
    const input = {...prepared(text).input, profileKey: 'npc-tyger-claws-male', reactionOffer: {available: true, actor: {id: '44ULL', key: 'npc-tyger-claws-male'},
      kinds: ['leave', 'attack'], plan: CLAW}};
    const config = broker.admit({...prepared(text), input}, options);
    await settle();
    return {config, files, logs};
  };
  for (const [text, kind, screen] of [['get lost or I\'ll kill you', 'attack', 'kill'], ['you don\'t scare me', 'attack', 'hurt'], ['try me', 'attack', 'hurt'],
    ['you Tyger Claws are a bunch of pussies', 'leave', 'insult'], ['your gang is trash', 'leave', 'insult']]) {
    const {config, files, logs} = await turn(text);
    assert.deepEqual(config.reaction, {kinds: [], decided: kind}, text);
    assert.equal(files.filter(packet => packet.action === 'npc-reaction').at(-1)?.reaction, kind, text);
    assert.deepEqual(logs, [`NPC reaction: person=npc-tyger-claws-male offered=${kind} admitted=yes route=text tag=${kind} delivered=yes screen=${screen} game=${kind} by=game`], text);
  }
  // Words the game does not read: the model keeps the old kinds, and the line says why the game chose nothing.
  const calm = await turn('nice jacket, choom');
  assert.deepEqual(calm.config.reaction, {kinds: ['leave', 'attack']});
  const menu = reactionMenu(calm.config, {heard: 'nice jacket, choom'});
  assert.equal(menu.decided, undefined);
  assert.equal(menu.game, undefined, 'no plan in a config whose words were read at admission: nothing to log twice');
});

test('live test 3, switch on: the same Tyger Claw (aggressive) brawls for an insult or a dare and draws for a death threat', async () => {
  for (const [text, kind] of [['you Tyger Claws are a bunch of pussies', 'brawl'], ['bring it on', 'brawl'], ['get lost or I\'ll kill you', 'attack'], ['move or I\'ll shoot', 'attack']]) {
    const {broker, options, logs} = fixture();
    assert.deepEqual(broker.admit(prepared(text), options).reaction, {kinds: [], threats: true, decided: kind}, text);
    await settle();
    assert.match(logs[0], new RegExp(` tag=${kind} delivered=yes screen=[a-z+-]+ game=${kind} by=game$`), text);
  }
});

test('the text menu logs the game\'s verdict for a transcript it does not decide (a plan, the words not read)', () => {
  const config = {version: 1, token: 'drive-00000000000000000001', source: 'private-voice', expiresAt: 20000, drive: false,
    reaction: {kinds: ['leave', 'attack'], plan: {kill: 'attack', hurt: 'attack', insult: 'leave'}}};
  const calm = reactionMenu(config, {heard: 'what a night'});
  assert.equal(calm.decided, undefined);
  assert.deepEqual(calm.kinds, ['leave', 'attack'], 'switch off: never narrowed');
  assert.equal(calm.screen, 'none');
  assert.equal(calm.game, 'none(unread)');
  assert.equal(reactionMenu(config, {heard: 'I\'ll kill you lol'}).game, 'none(joke)');
  assert.equal(reactionMenu(config, {heard: 'Get down!'}).game, 'none(no-row)', 'a command with the switch off: no row in the plan');
  const decided = reactionMenu(config, {heard: 'Get lost or I\'ll kill you'});
  assert.equal(decided.decided, 'attack');
  assert.equal(decided.game, 'attack');
  assert.equal(decided.screen, 'kill');
  // A Convai voice turn with the switch off: the page's window takes the plan and decides on the final transcript.
  const window = new CompanionActionWindow({now: () => 10000});
  assert.equal(window.open(config), true, 'a plan of the old kinds opens the window without the threats flag');
  assert.equal(window.decide('nice night'), null);
  assert.deepEqual(window.decide('Get lost or I\'ll kill you'), {version: 1, token: config.token, reaction: 'attack', by: 'game'});
  assert.equal(window.open({...config, reaction: {...config.reaction, plan: {kill: 'brawl'}}}), false, 'no new kind without the flag');
  assert.equal(reactionTraceLine({person: 'p', kinds: ['leave', 'attack'], route: 'text', why: 'no-tag', screen: 'none', game: 'none(unread)'}),
    'NPC reaction: person=p offered=leave,attack admitted=yes route=text tag=none(no-tag) delivered=- screen=none game=none(unread)');
});
