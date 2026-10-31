// Settings > Dynamic info (docs/DYNAMIC_INFO.md): one switch per kind of live game info a turn's context carries. An off kind is absent from the prompt of
// every provider (Convai's dynamic info, and the Mistral, Local AI and Custom prompts), is no longer read from the game, is saved and applied like the
// other settings, and is part of the support report. Also pinned here: the location wording a player reported (2026-10-22: "standing in the middle of
// Little China" while V was in the H10 apartment).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {DynamicInfo, KINDS, NO_KINDS, dynamicInfo, offKinds, phoneTurn, stripSnapshot} from './dynamic-info.mjs';
import {parseInput, archetypeContext} from './protocol.mjs';
import {conversationContext, conversationContextBlocks, voiceConversationBlocks} from './quest-context.mjs';
import {describeTurnContext, parseTurnContext, turnContext} from './turn-context.mjs';
import {describePlace} from './place-names.mjs';
import {PersonaBook, buildMessages, joinBlocks, worldBlocksInCacheOrder} from './mistral-prompt.mjs';
import {TextProviderHost, mistralRoute, localRoute, customRoute} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {CustomEndpoint, parseEndpointUrl} from './custom-endpoint.mjs';
import {vGenderOf} from './v-voice.mjs';
import {lastTalk} from './last-talk.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';   // the safe constant the other provider tests use
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);

// ---- a turn that carries every kind of live info ----------------------------------------------------------------------------------------------
const MARKERS = {
  location: /Embers|Heywood/, time: /late night|2 AM|raining/, company: /Also with V|Panam|in a vehicle/,
  condition: /badly hurt|police chase|Maelstrom/, money: /nearly broke/, gear: /Samurai Jacket|Kyubi/, about: /Street Kid|woman \(she\/her\)/,
  quest: /The Heist|Reach the vault door|broader current-save journal history/, dialogue: /Meet me at the Afterlife tonight/, lastTalk: /You last talked with V/,
  media: /car radio|pocket radio|TV nearby/, mods: /exhausted|parched|dehydrated|starving|on edge/};
// Time since the last talk: the turns below are Judy's, with the game clock at 02:10 of day 40 and the real clock fixed. Every turn is built with a distinct id, and
// the shared store decides once per id, so each one is parsed after Judy's last talk is put back three days (game) and four days (real) before it.
const GAME_NOW = 40 * 86400 + 2 * 3600 + 10 * 60, REAL_NOW = 1_800_000_000_000;
await lastTalk.configure({path: null, now: () => REAL_NOW, keyFor: key => key});
const seedLastTalk = () => lastTalk.record('judy-alvarez', GAME_NOW - 3 * 86400, REAL_NOW - 4 * 86400_000);
let serial = 100;
function rawTurn(extra = {}, entity = `${++serial}ULL`) {
  return {requestId: `${serial}-1-${entity}`, generation: 1, entity, profileKey: 'judy-alvarez', name: 'Judy', bodyType: 'WomanAverage', text: 'So what now? Can we afford it, and does this jacket still look good on me?',
    journal: {version: 1, status: 'active', quest: {id: '123', title: 'The Heist', objectives: [{id: '1', text: 'Reach the vault door', tracked: true}]}},
    journalHistory: {version: 1, status: 'unavailable'}, worldKnowledge: {version: 1, status: 'unavailable'},
    gear: {version: 1, status: 'ready', clothing: [{slot: 'outerTorso', name: 'Samurai Jacket'}], weapons: [{slot: 'hand', name: 'Kyubi'}]},
    gameDialogue: {version: 1, status: 'ready', lines: [{id: 'g-1', age: 20, kind: 'line', channel: 'scene', speaker: 'npc', entity, profileKey: 'judy-alvarez',
      name: 'Judy', text: 'Meet me at the Afterlife tonight.'}]},
    battle: {version: 1, status: 'fighting', encounter: 'battle-12', ageSeconds: 5, durationSeconds: 20, opponents: [{name: 'Maelstrom Thug', count: 2}], witnesses: ['judy-alvarez']},
    turnContext: {version: 1, status: 'ready', gameTime: GAME_NOW, hour: 2, minute: 10, district: 'Heywood', area: 'Glen_Embers', indoors: true, gender: 'female', voice: 'female',
      lifepath: 'streetkid', weather: 'rain', health: 'badly-hurt', heat: 3, money: 'broke', vehicle: true, driving: false,
      media: {radio: {source: 'car', station: 'Growl FM', track: 'Rebel Path'}},
      mods: {darkFuture: {energy: 4, hydration: 3}},
      party: [{key: 'judy-alvarez', name: 'Judy', activity: 'passenger'}, {key: 'panam-palmer', name: 'Panam'}]},
    ...extra};
}
const parsed = (extra, entity) => { seedLastTalk(); return parseInput(JSON.stringify(rawTurn(extra, entity))); };
const withOff = (...kinds) => { const info = new DynamicInfo(); info.update({dynamicInfo: {mods: true, ...Object.fromEntries(kinds.map(kind => [kind, false]))}}); return info; };

// What the bridge hands a text provider for one turn (bridge/convai-bridge.mjs contextPartsOf): the same blocks, laid out by how often they change.
function partsOf(blocks) {
  const world = worldBlocksInCacheOrder(blocks.filter(item => item.tier === 'world'));
  return {...Object.fromEntries(['now', 'notes', 'volatile'].map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))])),
    world: joinBlocks(world.map(item => item.text)), worldBlocks: world.filter(item => item.text).map(item => ({key: item.key, text: item.text}))};
}
const flat = messages => messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n\n');

// ---- the four provider paths ------------------------------------------------------------------------------------------------------------------
async function route(name) {
  const seen = [];
  const chat = async options => { seen.push(flat(options.messages)); return {text: 'Sure, V.', model: 'm', finishReason: 'stop', usage: {}}; };
  const memory = await MistralMemory.open({path: null});
  let provider, routes;
  if (name === 'mistral') {
    provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${KEY}\n`, writeText: async () => {}});
    await provider.load(); provider.setPreference('mistral'); provider.apply();
    routes = {mistral: mistralRoute({provider, chat, gapMs: 0})};
  } else if (name === 'local') {
    provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
    await provider.load(); provider.setPreference('local'); provider.apply();
    const server = {status: () => ({state: 'ready'}), touch() {}, prewarm: async () => {},
      ensure: async () => ({endpoint: 'http://127.0.0.1:9/v1/chat/completions', apiKey: 'session-key-abcdef123456', model: 'qwen-test', tier: 'standard'})};
    routes = {local: localRoute({server, provider, chat})};
  } else {
    const custom = new CustomEndpoint({path: null});
    await custom.setUrl(parseEndpointUrl('http://127.0.0.1:11434')); await custom.setModel('local-model');
    provider = new MistralProvider({keyPath: 'k.txt', readText: async () => { throw Error('none'); }, writeText: async () => {}, custom});
    await provider.load(); provider.setPreference('custom'); provider.apply();
    routes = {custom: customRoute({provider, custom, chat})};
  }
  const host = new TextProviderHost({provider, memory, personas: book, routes});
  return {seen, close: () => host.close(),
    // The prompt this route sent for one turn.
    async prompt(input, info) {
      const blocks = withInfo(info, () => conversationContextBlocks(input));
      const config = {text: input.text, context: joinBlocks(blocks.map(item => item.text)), contextParts: partsOf(blocks), sessionId: `s-${input.requestId}`,
        local: {profileKey: input.profileKey, name: 'Judy Alvarez', channel: 'private'}};
      await host.reply(config);
      return seen.at(-1);
    }};
}
// The context builders ask the shared instance; a test sets it for the length of one build and puts it back.
// `phoneInfo` is the phone set (holocalls and Phone Chat); without it the phone set is the same as the in-person one.
function withInfo(info, build, phoneInfo = info) {
  const before = [dynamicInfo.off, dynamicInfo.offPhone];
  dynamicInfo.off = info ? info.off : NO_KINDS;
  dynamicInfo.offPhone = phoneInfo ? phoneInfo.off : NO_KINDS;
  try { return build(); } finally { [dynamicInfo.off, dynamicInfo.offPhone] = before; }
}

test('the kinds are the twelve of the page, in page order, and every kind has a marker in this test turn', () => {
  assert.deepEqual([...KINDS], ['location', 'time', 'company', 'condition', 'money', 'gear', 'about', 'quest', 'dialogue', 'lastTalk', 'media', 'mods']);
  assert.deepEqual(Object.keys(MARKERS), [...KINDS]);
  const luaKinds = /local dynamicInfoKinds = \{([^}]*)\}/.exec(readFileSync(new URL('../mod/manager.lua', import.meta.url), 'utf8'))[1].match(/'([A-Za-z]+)'/g).map(text => text.slice(1, -1));
  assert.deepEqual(luaKinds, [...KINDS], 'the game side and the bridge name the same kinds in the same order');
});

test('the setting follows settings.json: all on by default except mods, only a saved false turns a kind off, anything unreadable changes nothing', () => {
  const info = new DynamicInfo();
  assert.equal(info.describe(), 'off: mods');
  assert.equal(info.update({dynamicInfo: {mods: true}}), true); assert.equal(info.describe(), 'all on');
  assert.equal(info.update(undefined), false); assert.equal(info.update(null), false); assert.equal(info.update('x'), false);
  assert.equal(info.update({dynamicInfo: {mods: true}}), false);
  assert.equal(info.update({dynamicInfo: 'off'}), true, 'a malformed table takes the defaults: mods is off again'); assert.equal(info.update({dynamicInfo: {mods: true}}), true);
  assert.equal(info.update({dynamicInfo: ['location']}), true); assert.equal(info.update({dynamicInfo: {mods: true}}), true);
  assert.equal(info.update({dynamicInfo: {mods: true, location: 'no', time: 0, gear: null, bogus: false}}), false, 'only the boolean false counts, and unknown kinds are ignored');
  assert.equal(info.update({dynamicInfo: {mods: true, location: false, gear: false, quest: true}}), true);
  assert.deepEqual([...info.off], ['location', 'gear']);
  assert.equal(info.on('location'), false); assert.equal(info.on('time'), true); assert.equal(info.describe(), 'off: location, gear');
  assert.equal(info.update({dynamicInfo: {mods: true, location: false, gear: false}}), false, 'the same set is no change');
  assert.equal(info.update({version: 2}), true, 'a file without the key takes the defaults: only mods is off');
  assert.deepEqual([...info.off], ['mods']);
  assert.deepEqual(offKinds({dynamicInfo: {mods: true, money: false}}), ['money']);
  assert.deepEqual(offKinds({dynamicInfo: {money: false}}), ['money', 'mods']);
  assert.deepEqual(offKinds({}), ['mods']);
  assert.deepEqual(offKinds({dynamicInfo: {mods: 'yes'}}), ['mods'], 'only the boolean true turns Other mods state on');
});

test('stripSnapshot removes only what the off kinds own, and always keeps V\'s voice gender and the dialogue volume', () => {
  const snapshot = parseTurnContext({...rawTurn().turnContext, dialogueVolume: 0.7});
  assert.equal(stripSnapshot(snapshot), snapshot, 'nothing off: the same object');
  const bare = stripSnapshot(snapshot, withOff(...KINDS).off);
  assert.deepEqual(bare, {version: 1, status: 'ready', voice: 'female', dialogueVolume: 0.7});
  assert.equal(vGenderOf(bare), 'female');
  assert.deepEqual(Object.keys(stripSnapshot(snapshot, withOff('location').off)).filter(key => ['district', 'area', 'indoors'].includes(key)), []);
  assert.equal(stripSnapshot({version: 1, status: 'unavailable'}, withOff('time').off).status, 'unavailable');
  // The volume alone is kept when nothing else was read (every kind off).
  assert.deepEqual(parseTurnContext({version: 1, status: 'ready', dialogueVolume: 0.4}), {version: 1, status: 'unavailable', dialogueVolume: 0.4});
  assert.deepEqual(parseTurnContext({version: 1, status: 'ready'}), {version: 1, status: 'unavailable'});
});

// ---- an off kind is absent from every provider's prompt ----------------------------------------------------------------------------------------
test('with every kind on, each marker is in the Convai context and in the prompt of Mistral, Local AI and Custom (the control)', async () => {
  const input = parsed();
  const convai = withInfo(null, () => conversationContext(input));
  for (const [kind, marker] of Object.entries(MARKERS)) assert.match(convai, marker, `${kind} is in the Convai context`);
  for (const name of ['mistral', 'local', 'custom']) {
    const provider = await route(name);
    try {
      const prompt = await provider.prompt(parsed(), null);
      for (const [kind, marker] of Object.entries(MARKERS)) assert.match(prompt, marker, `${kind} is in the ${name} prompt`);
    } finally { provider.close(); }
  }
});

test('a settings file without mods: the turn carries no mod-state block, and with mods saved as true it does', () => {
  const info = new DynamicInfo(); info.update({version: 2, dynamicInfo: {location: true}});
  assert.deepEqual([...info.off], ['mods']);
  const without = withInfo(info, () => conversationContext(parsed()));
  assert.doesNotMatch(without, MARKERS.mods);
  for (const [kind, marker] of Object.entries(MARKERS)) if (kind !== 'mods') assert.match(without, marker, `${kind} stays`);
  const on = new DynamicInfo(); on.update({dynamicInfo: {mods: true}});
  assert.match(withInfo(on, () => conversationContext(parsed())), MARKERS.mods);
});

for (const kind of KINDS) {
  test(`${kind} off: it is absent from Convai, Mistral, Local AI and Custom, and every other kind is still there`, async () => {
    const info = withOff(kind);
    const convai = withInfo(info, () => conversationContext(parsed()));
    const checks = [['convai', convai]];
    for (const name of ['mistral', 'local', 'custom']) {
      const provider = await route(name);
      try { checks.push([name, await provider.prompt(parsed(), info)]); } finally { provider.close(); }
    }
    for (const [name, prompt] of checks) {
      assert.doesNotMatch(prompt, MARKERS[kind], `${kind} left the ${name} prompt`);
      for (const [other, marker] of Object.entries(MARKERS)) if (other !== kind) assert.match(prompt, marker, `${other} stays in the ${name} prompt`);
    }
  });
}

test('every kind off at once: the character is still told it is with V, and none of the twelve is anywhere in the prompt', async () => {
  const info = withOff(...KINDS);
  const convai = withInfo(info, () => conversationContext(parsed()));
  assert.match(convai, /You are with V in person/);
  for (const [kind, marker] of Object.entries(MARKERS)) assert.doesNotMatch(convai, marker, kind);
  const provider = await route('mistral');
  try {
    const prompt = await provider.prompt(parsed(), info);
    for (const [kind, marker] of Object.entries(MARKERS)) assert.doesNotMatch(prompt, marker, kind);
  } finally { provider.close(); }
});

test('Quest and journal off drops the journal, the jobs and the history, not even the line that says the history is unavailable; the story knowledge stays', () => {
  const on = withInfo(null, () => conversationContext(parsed()));
  assert.match(on, /broader current-save journal history is unavailable/);
  const off = withInfo(withOff('quest'), () => conversationContext(parsed()));
  assert.doesNotMatch(off, /journal history|verified current-save journal|The Heist/);
  assert.match(off, /Current-save world knowledge is unavailable/, 'what the character knows about the story is not a Dynamic info kind');
});

test('a fight reaction keeps its own subject: Health, heat and fights off drops the battle of a manual turn only', () => {
  const reaction = parsed({reaction: {kind: 'battle', encounter: 'battle-12', phase: 'start', expiresAt: Date.now() + 60_000}, turnContext: undefined});
  const manual = parsed();
  assert.ok(reaction.reaction, 'the reaction parsed');
  assert.match(withInfo(withOff('condition'), () => conversationContext(reaction)), /Verified combat observations/);
  assert.doesNotMatch(withInfo(withOff('condition'), () => conversationContext(manual)), /Verified combat observations|Maelstrom/);
});

test('an ordinary NPC: Location off removes where it stands (its own block and the right-now block), Time off the clock', () => {
  const stranger = extra => parsed({profileKey: 'resident-male', name: 'Pedestrian', bodyType: 'MaleAverage', archetype: {category: 'resident', district: 'Heywood', area: 'Glen_Embers'}, ...extra});
  const archetype = (input, info) => archetypeContext(input, {place: info ? info.on('location') : true});
  assert.match(archetype(stranger(), null), /Where you are now: .*Heywood/);
  assert.doesNotMatch(archetype(stranger(), withOff('location')), /Where you are now|Heywood|Embers/);
  assert.match(archetype(stranger(), null), /only when it matters to what V says/);
  assert.doesNotMatch(archetype(stranger(), null), /flavor/);
  // Without its own district block the right-now block says where it stands.
  const bare = () => parsed({profileKey: 'resident-male', name: 'Pedestrian', bodyType: 'MaleAverage'});
  const on = withInfo(null, () => conversationContext(bare()));
  assert.match(on, /Embers|Heywood/); assert.match(on, /late night|2 AM/);
  const off = withInfo(withOff('location', 'time'), () => conversationContext(bare()));
  assert.doesNotMatch(off, /Embers|Heywood|late night|2 AM|raining/);
});

test('a phone chat and an add-on voice honour the switches too', () => {
  const phone = {...parsed(), channel: 'phone'};
  assert.match(withInfo(null, () => conversationContext(phone)), /V is inside Embers|Heywood/);
  assert.doesNotMatch(withInfo(withOff('location', 'time', 'dialogue'), () => conversationContext(phone)), /Embers|Heywood|Meet me at the Afterlife|late night|2 AM/);
  const voice = {...parsed(), group: {index: 1, total: 2, audience: ['judy-alvarez', 'panam-palmer'], heard: []}};
  const voiceText = info => withInfo(info, () => voiceConversationBlocks(voice).map(block => block.text).join('\n'));
  assert.match(voiceText(null), /Also with V: Panam/); assert.match(voiceText(null), /Meet me at the Afterlife tonight/);
  assert.doesNotMatch(voiceText(withOff('company', 'dialogue')), /Panam|Meet me at the Afterlife/);
});

// ---- two sets of switches: in person, and holocalls and Phone Chat texts -----------------------------------------------------------------------------
test('the phone set is saved beside the in-person set: a file without it (before the phone set existed) follows the in-person choices, kind by kind', () => {
  assert.deepEqual(offKinds({dynamicInfo: {location: false, gear: false, mods: true}}, true), ['location', 'gear'], 'no phone set: a copy of the in-person set');
  assert.deepEqual(offKinds({dynamicInfo: {money: false}}, true), ['money', 'mods'], 'the default of a fresh file is the in-person default (Other mods state off)');
  assert.deepEqual(offKinds({}, true), ['mods']);
  assert.deepEqual(offKinds({dynamicInfo: {location: false}, dynamicInfoPhone: 'x'}, true), ['location', 'mods'], 'a malformed phone set is ignored');
  assert.deepEqual(offKinds({dynamicInfo: {location: false, mods: true}, dynamicInfoPhone: {location: true, time: false, gear: 'no'}}, true), ['time'],
    'a saved boolean wins over the in-person choice, anything else follows it');
  assert.deepEqual(offKinds({dynamicInfo: {mods: true}, dynamicInfoPhone: {mods: false}}, true), ['mods']);
  assert.deepEqual(offKinds({dynamicInfo: {location: false}, dynamicInfoPhone: {location: true, mods: true}}), ['location', 'mods'], 'the in-person set never reads the phone set');
  const info = new DynamicInfo();
  assert.equal(info.update({dynamicInfo: {mods: true}, dynamicInfoPhone: {mods: true, gear: false}}), true);
  assert.deepEqual([...info.off], []); assert.deepEqual([...info.offPhone], ['gear']);
  assert.equal(info.on('gear'), true); assert.equal(info.on('gear', true), false); assert.equal(info.offFor(true), info.offPhone); assert.equal(info.offFor(false), info.off);
  assert.equal(info.onAny('gear'), true, 'the game is read for a kind that either set wants');
  assert.equal(info.describe(), 'in person all on, phone off: gear');
  assert.equal(info.update({dynamicInfo: {mods: true}, dynamicInfoPhone: {mods: true, gear: false}}), false);
  assert.equal(info.update({dynamicInfo: {mods: true}, dynamicInfoPhone: {mods: true, gear: false, money: false}}), true, 'a change of only the phone set is a change');
  assert.equal(info.update({dynamicInfo: {mods: true, money: false}, dynamicInfoPhone: {mods: true, gear: false, money: false}}), true, 'and so is a change of only the in-person set');
  assert.equal(info.update({dynamicInfo: {mods: true, location: false, time: false}, dynamicInfoPhone: {mods: true, location: false, time: false}}), true);
  assert.equal(info.onAny('time'), false); assert.equal(info.describe(), 'off: location, time');
  assert.equal(info.update({dynamicInfo: {mods: true, location: false, time: false}}), false, 'a phone set that vanished follows the in-person set (here the same)');
  assert.equal(info.update({dynamicInfo: {mods: true, location: false}}), true); assert.deepEqual([...info.offPhone], ['location']);
  assert.equal(new DynamicInfo().update({dynamicInfo: {mods: true, money: false}}), true);
});

test('a phone turn is a Phone Chat text or a one-to-one holocall, in either mode, never a group round', () => {
  assert.equal(phoneTurn({channel: 'phone'}), true);
  assert.equal(phoneTurn({holocall: {version: 1, contact: 'Judy', mode: 'audio'}}), true);
  assert.equal(phoneTurn({holocall: {version: 1, contact: 'Judy', mode: 'holo'}}), true);
  assert.equal(phoneTurn({holocall: {mode: 'audio'}, group: {index: 1, total: 2}}), false);
  assert.equal(phoneTurn({holocall: {mode: 'video'}}), false); assert.equal(phoneTurn({holocall: 'audio'}), false);
  assert.equal(phoneTurn({}), false); assert.equal(phoneTurn(null), false); assert.equal(phoneTurn(undefined), false);
});

test('a holocall and a Phone Chat text use the phone set, every other turn the in-person set, whatever the other set says', () => {
  const personOff = withOff('location', 'gear'), phoneOff = withOff('time', 'quest');
  const call = extra => parsed({holocall: {version: 1, contact: 'Judy', mode: 'audio'}, ...extra});
  const text = () => ({...parsed(), channel: 'phone'});
  const marked = (input, kind, info, phoneInfo) => MARKERS[kind].test(withInfo(info, () => conversationContext(input), phoneInfo));
  const turns = {person: () => parsed(), call, text};
  // In person: the in-person set applies and the phone set does not.
  assert.equal(marked(turns.person(), 'location', personOff, phoneOff), false); assert.equal(marked(turns.person(), 'time', personOff, phoneOff), true);
  assert.equal(marked(turns.person(), 'quest', personOff, phoneOff), true);
  // A holocall and a text: the phone set applies and the in-person set does not.
  for (const [name, make] of [['call', turns.call], ['text', turns.text]]) {
    assert.equal(marked(make(), 'location', personOff, phoneOff), true, `${name}: Location is only off in person`);
    assert.equal(marked(make(), 'time', personOff, phoneOff), false, `${name}: Time and weather is off for the phone`);
    assert.equal(marked(make(), 'quest', personOff, phoneOff), false, `${name}: Quest and journal is off for the phone`);
  }
  // A player who never touched the phone set: the two sets are the same, so a phone turn keeps what the in-person set turned off.
  for (const make of [turns.call, turns.text]) assert.equal(marked(make(), 'location', personOff), false);
  // A character standing beside V is talked to in person even on the phone (the party row says near).
  const near = make => make({turnContext: {...rawTurn().turnContext, party: [{key: 'judy-alvarez', name: 'Judy', near: true}, {key: 'panam-palmer', name: 'Panam'}]}});
  assert.equal(marked(near(turns.call), 'location', personOff, phoneOff), false, 'a call to a companion beside V uses the in-person set');
  assert.equal(marked(near(turns.call), 'time', personOff, phoneOff), true);
  assert.equal(marked(near(() => ({...parsed({turnContext: {...rawTurn().turnContext, party: [{key: 'judy-alvarez', name: 'Judy', near: true}]}}), channel: 'phone'})), 'location', personOff, phoneOff), false);
});

// ---- where V is: modest and precise -------------------------------------------------------------------------------------------------------------
const place = (district, area, indoors) => ({version: 1, status: 'ready', hour: 14, minute: 5, district, area, ...(indoors === undefined ? {} : {indoors})});
const companion = turnContextValue => describeTurnContext(parsed({turnContext: turnContextValue}), {split: true}).text;
const HERE_FIRST = /^Right now \(from the game, this turn only\): (You are with V in person[^.]*\.)/;

test('V in the H10 apartment: "inside V\'s apartment in Megabuilding H10", never "standing in the middle of" the district', () => {
  const text = companion(place('Watson', 'LittleChina_VApartment', true));
  assert.match(text, /You are inside V's apartment in Megabuilding H10\./);
  assert.doesNotMatch(text, /middle of|standing in|in Little China/);
  assert.equal(describePlace({district: 'Watson', area: 'LittleChina_VApartment'}).kind, 'home');
});

test('the first sentence, which a text provider repeats right before V\'s words, never carries the place', () => {
  for (const [state, indoors] of [['standing', true], ['following', false], ['seated', undefined]]) {
    const input = parsed({turnContext: {...place('Watson', 'LittleChina', indoors), party: [{key: 'judy-alvarez', name: 'Judy', activity: state}], vehicle: false}});
    const text = describeTurnContext(input, {split: true}).text;
    assert.doesNotMatch(HERE_FIRST.exec(text)[1], /Little China|Watson/, state);
    const messages = buildMessages({persona: book.persona('judy-alvarez'), contextParts: {now: text, notes: '', world: '', volatile: ''}, text: 'hey'});
    const here = /\[YOU, RIGHT NOW: ([^\]]*)\]/.exec(messages.at(-1).content)[1];
    assert.doesNotMatch(here, /Little China|Watson|district/, `${state}: the line before V's words has no place`);
  }
});

test('a plain district says what the game says and no more: indoors, outdoors, or only that it is somewhere in the area', () => {
  assert.match(companion(place('Watson', 'LittleChina', true)), /You are indoors, in a building in Little China, Watson; which building is not given\./);
  assert.match(companion(place('Watson', 'LittleChina', false)), /You are outdoors in Little China, Watson, in the open air, not inside a building\./);
  assert.match(companion(place('Watson', 'LittleChina')), /You are somewhere in Little China, Watson; exactly where is not given\./);
  assert.match(companion(place('Badlands', 'Badlands_Hills')), /You are outdoors in .*, out in open country\./);
  assert.match(companion(place('Watson', 'Kabuki_LizziesBar')), /You are inside Lizzie's Bar, Watson\./);
  for (const text of [place('Watson', 'LittleChina', true), place('Watson', 'LittleChina'), place('LittleChina', 'LittleChina_VApartment')].map(companion)) {
    assert.doesNotMatch(text, /standing in|in the middle|right in/);
  }
});

test('a companion in a vehicle is never "in the open air", whatever the interior flag says; on foot it still is', () => {
  const ride = indoors => companion({...place('Watson', 'LittleChina', indoors), vehicle: true, driving: false});
  const text = ride(false);
  assert.doesNotMatch(text, /open air|not inside a building/);
  assert.match(text, /You are somewhere in Little China, Watson; exactly where is not given\./);
  assert.match(ride(true), /You are indoors, in a building in Little China, Watson/);
  assert.match(companion({...place('Watson', 'LittleChina', false), vehicle: false}), /in the open air, not inside a building/);
});

test('changing a Dynamic info switch drops the replies the bridge prepared ahead, like the other prompt settings', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /const dynamicInfoChanged = dynamicInfo\.update\(settings\);/);
  assert.match(bridge, /if \(speechChanged \|\| emotionsChanged \|\| dynamicInfoChanged\) \{ dropPrefetch\(\); prefetchObserved = ''; \}/);
  assert.match(bridge, /\{ambient: isAmbientProfile\(input\.profileKey\), voice, off: dynamicOff\(input\)\}/, 'the add-on voice log line follows the switches');
});

test('the guidance tells every form to mention a place or the time only when it matters, in one short sentence', () => {
  const GUIDANCE = 'Do not recite it, and mention a place or the time only if it matters to what V says.';
  const form = (extra, channel) => describeTurnContext({...parsed({turnContext: place('Watson', 'LittleChina', true), ...extra}), ...(channel ? {channel} : {})}, {split: true}).text;
  assert.ok(form({}).includes(GUIDANCE), 'in person');
  assert.ok(form({}, 'phone').includes(GUIDANCE), 'phone');
  assert.ok(form({holocall: {version: 1, contact: 'Judy', mode: 'audio'}}).includes(GUIDANCE), 'a call');
  assert.match(describeTurnContext(parsed({profileKey: 'resident-male', turnContext: place('Watson', 'LittleChina', true)}), {ambient: true, split: true}).text,
    /bring it up only when it matters to what V says\.$/);
  assert.ok(GUIDANCE.length < 90, 'prompts stay short');
  assert.match(archetypeContext({profileKey: 'resident-male', archetype: {district: 'Kabuki'}}), /Mention it only when it matters to what V says/);
});

// ---- the game side: nothing is read for an off kind ---------------------------------------------------------------------------------------------
function runLua(code) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const status = lauxlib.luaL_dostring(vm, to_luastring(code));
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    assert.equal(status, lua.LUA_OK, error);
  } finally { lua.lua_close(vm); }
}
const turnContextSource = readFileSync(new URL('../mod/turn-context.lua', import.meta.url), 'utf8');
const adapter = `
local api = (function() ${turnContextSource} end)()
local now, reads, off = 100, {}, {}
local player = {id = 'v'}
local function tick(name) reads[name] = (reads[name] or 0) + 1 end
local N = {
  player = function() return player end, ready = function() return true end,
  clock = function() tick('clock'); return 2, 10, 'native' end,
  gender = function() tick('gender'); return 'Female' end, voice = function() tick('voice'); return 'Female' end,
  lifepath = function() tick('lifepath'); return 'streetkid' end, vehicle = function() tick('vehicle'); return true end,
  driving = function() tick('driving'); return false end,
  weather = function() tick('weather'); return '24h_weather_light_rain', nil, 'test' end,
  health = function() tick('health'); return 20, 'test' end, heat = function() tick('heat'); return 3, 'test' end,
  money = function() tick('money'); return 50, 'test' end, interior = function() tick('interior'); return true, 'test' end}
local function make(extra) local o = {native = N, now = function() return now end,
  place = function() tick('place'); return {district = 'Watson', area = 'Kabuki'} end,
  party = function() tick('party'); return {{profileKey = 'panam-palmer', name = 'Panam'}} end,
  activity = function() tick('activity'); return {rows = {}, motion = 'walking'} end,
  enabled = function(kind) return not off[kind] end}
  for key, value in pairs(extra or {}) do o[key] = value end
  return api.new(o) end
local function fresh() reads = {}; now = now + 100 end
`;
test('the game side reads nothing for an off kind: its native calls, its place lookup and its party read are never made', () => runLua(`${adapter}
  local ctx = make()
  local snap = ctx:capture()
  for _, name in ipairs({'clock', 'gender', 'lifepath', 'vehicle', 'weather', 'health', 'heat', 'money', 'interior', 'place', 'party'}) do assert(reads[name] == 1, name .. ' is read when it is on') end
  assert(snap.hour == 2 and snap.district == 'Watson' and snap.gender == 'female' and snap.weather == 'rain' and snap.health and snap.heat == 3 and snap.money and snap.vehicle == true and snap.party)
  local groups = {location = {'place', 'interior'}, time = {'clock', 'weather'}, company = {'vehicle', 'party', 'activity'}, condition = {'health', 'heat'},
    money = {'money'}, about = {'gender', 'lifepath'}}
  for kind, names in pairs(groups) do
    ctx = make(); off = {[kind] = true}; fresh()
    ctx:capture()
    for _, name in ipairs(names) do assert(reads[name] == nil, kind .. ' off, but ' .. name .. ' was still read') end
    for other, others in pairs(groups) do if other ~= kind then for _, name in ipairs(others) do
      if name ~= 'activity' and name ~= 'interior' then assert(reads[name] == 1, kind .. ' off must not stop ' .. name) end end end end
  end
  -- Every kind off: V's voice for typed lines still gets its gender, and nothing else is read.
  off = {location = true, time = true, company = true, condition = true, money = true, about = true}
  fresh(); ctx = make(); snap = ctx:capture()
  assert(snap ~= nil and snap.voice == 'female' and snap.hour == nil and snap.district == nil and snap.party == nil and snap.gender == nil and snap.health == nil and snap.money == nil)
  for name, count in pairs(reads) do assert(name == 'voice', name .. ' was read with every kind off') end
`));

test('a snapshot read under other switches is not reused: a kind turned off a moment ago does not ride along for the cache window', () => runLua(`${adapter}
  local ctx = make()
  local first = ctx:capture()
  assert(first.district == 'Watson')
  off = {location = true}
  local second = ctx:capture()
  assert(second.district == nil and second.hour == 2, 'read again at once, without the place')
  off = {}
  assert(ctx:capture().district == 'Watson', 'and again when it is turned back on')
  local calls = reads.place
  ctx:capture(); ctx:capture()
  assert(reads.place == calls, 'unchanged switches reuse the cache')
`));

test('a lone dialogue volume is a snapshot only while a switch is off (so V\'s voice keeps its level), never with everything on', () => runLua(`${adapter}
  local function lone(offKinds)
    off = offKinds
    local ctx = make({native = setmetatable({clock = function() error('x') end, gender = function() error('x') end, lifepath = function() error('x') end,
      vehicle = function() error('x') end, weather = function() error('x') end, health = function() error('x') end, heat = function() error('x') end,
      money = function() error('x') end, interior = function() error('x') end, voice = function() return nil end, volume = function() return 0.5 end}, {__index = N}),
      place = function() error('x') end, party = function() error('x') end, wantVolume = function() return true end})
    return ctx:capture()
  end
  assert(lone({}) == nil)
  local snap = lone({location = true})
  assert(snap and snap.dialogueVolume == 0.5)
`));

test('Health, heat and fights off drops the fight from a manual turn only: a battle reaction still carries its own fight', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  const reactions = readFileSync(new URL('../mod/battle-reactions.lua', import.meta.url), 'utf8');
  assert.doesNotMatch(init, /convaiGateCapture\(battles/, 'the battle module\'s own capture is not wrapped');
  for (const reader of ['groupChat', 'phoneChat', 'microphone']) assert.ok(init.includes(`${reader}.captureBattle = battles.captureManual`), reader);
  assert.match(init, /else context\.battle = context\.battle or \(battles\.captureManual or battles\.capture\)\(\) end/, 'sendRequest: a manual turn reads its fight through the gated reader');
  const gate = (/function battles\.captureManual[\s\S]*?\r?\nend\r?\n/.exec(init) ?? [''])[0];
  assert.ok(gate.includes("ask('condition')"));
  runLua(`
    local policy = (function() ${reactions} end)().new()
    local manager = {}
    local battles = policy
    ${gate}
    local now = 1000
    local people = {{entity = '1ULL', profileKey = 'judy-alvarez', distance = 2, available = true}}
    local sample = {available = true, blocked = false, combat = false, opponents = {}}
    local function tick(dt, combat) now = now + dt; sample.combat = combat; policy.update(sample, dt, now, true, people) end
    tick(0, false); tick(.5, true); tick(1, true); tick(1, true)
    manager.dynamicInfo = function(kind) return kind ~= 'condition' end   -- Health, heat and fights is off
    assert(battles.captureManual() == nil, 'a manual turn does not read the fight')
    local event = assert(policy.offer(false, people, now), 'the reaction is offered')
    assert(event.phase == 'start' and event.battle and event.battle.status == 'fighting', 'the reaction still carries its fight with the switch off')
    manager.dynamicInfo = function() return true end
    assert(battles.captureManual().status == 'fighting', 'on: a manual turn reads it')
  `);
});

test('the init module gates each capture where the collector is made, and a manager that has no such setting counts as everything on', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  for (const gate of [`convaiGateCapture(questContext, 'capture', 'quest')`,
    `convaiGateCapture(gameDialogue, 'capture', 'dialogue')`, `convaiGateCapture(playerGear, 'capture', 'gear')`, `enabled = function(kind) return manager.dynamicInfo == nil or manager.dynamicInfo(kind) end`,
    `manager.dynamicInfo('location')`]) assert.ok(init.includes(gate), gate);
  // The journal scan is not stepped, asked for or sent while Quest and journal is off (unless Johnny's remarks need it): nothing per frame beyond one table read.
  assert.match(init, /function convaiHistoryWanted\(\)\s+local flags = convaiDynamicInfo\s+if flags == nil or flags\.quest ~= false then return true end/);
  assert.match(init, /local flags = convaiDynamicInfo\s+if flags == nil or flags\.quest ~= false or convaiHistoryWanted\(\) then[\s\S]{0,260}journalHistory:update\(context\)/);
  const gate = (/function convaiGateCapture[\s\S]*?\r?\nend\r?\n/.exec(init) ?? [''])[0];
  runLua(`
    local manager = {}
    ${gate}
    local calls = 0
    local owner = {capture = function(self, a) calls = calls + 1; return a or self end}
    convaiGateCapture(owner, 'capture', 'gear')
    assert(owner:capture() == owner and calls == 1, 'a manager without the setting is on, and the method keeps its self')
    manager.dynamicInfo = function(kind) return kind ~= 'gear' end
    assert(owner:capture() == nil and calls == 1, 'off: the collector is not called')
    manager.dynamicInfo = function(kind) return true end
    assert(owner:capture(7) == 7 and calls == 2)
    convaiGateCapture(nil, 'capture', 'gear'); convaiGateCapture({}, 'capture', 'gear')
  `);
});
