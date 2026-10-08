import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectLanguage, isNonEnglish} from './reply-language.mjs';
import {MultilingualConversations, multilingualTwins, planTurnVoice, replyVoice, twinMarkerKey} from './multilingual.mjs';
import {RelationshipRouting, relationshipRegistry, selectRelationshipProfile, parseRelationshipState,
  RELATIONSHIP_PROFILES} from './relationship-routing.mjs';
import {PlayerMemory} from './player-memory.mjs';
import {PlayerMemoryApi} from './player-memory-api.mjs';
import {PlayerMemoryControl} from './player-memory-control.mjs';
import {NaturalSpeech} from './natural-speech.mjs';
import {ExpressiveEmotions} from './expressive-emotions.mjs';

// ---- Reply-language detection --------------------------------------------------------------------------------

test('detects the language of conversation text by script and by function words', () => {
  const cases = {
    en: ['Hey V, meet me at the Afterlife tonight and we will talk it over.', 'What do you need, choom?'],
    es: ['¿Qué tal, Judy? ¿Vamos al bar esta noche?', 'Claro que sí, nos vemos en el bar de Lizzie.', 'Hola', 'Gracias',
      // A live reply of Judy's romantic twin (smoke test, 2026-10-07).
      'Nada especial, solo pelearme con un par de pistas de audio que no quieren sincronizar. ¿Y tú? ¿Vienes a ayudarme o solo a distraerme?'],
    de: ['Ich habe keine Ahnung, was du meinst, aber wir können es versuchen.', 'Danke', 'Was machst du heute Abend?'],
    fr: ['Je ne sais pas ce que tu veux dire, mais nous pouvons essayer.', 'Bonjour', 'Salut, ça va?'],
    it: ['Non so cosa vuoi dire, ma possiamo provare questa sera.', 'Cosa fai stasera?'],
    pt: ['Eu não sei o que você quer dizer, mas podemos tentar.', 'O que você vai fazer hoje à noite?'],
    pl: ['Nie wiem, co masz na myśli, ale możemy spróbować.'],
    cs: ['Nevím, co tím myslíš, ale můžeme to zkusit.'],
    hu: ['Nem tudom, mit akarsz mondani, de megpróbálhatjuk.'],
    tr: ['Ne demek istediğini bilmiyorum ama deneyebiliriz, değil mi?'],
    ja: ['こんにちは、ジュディ。今夜は何をしているの？', 'V、アラサカのことは忘れて。'],
    zh: ['你好，朱迪。今晚你在做什么？'],
    ko: ['안녕, 주디. 오늘 밤 뭐 해?'],
    ru: ['Привет, Джуди. Что ты делаешь сегодня вечером?'],
    uk: ['Привіт, Джуді. Що ти робиш сьогодні ввечері? Їжа є.'],
  };
  for (const [language, texts] of Object.entries(cases)) {
    for (const text of texts) assert.equal(detectLanguage(text).language, language, text);
  }
});

test('English with street Spanish, Japanese names or voice tags stays English; unclear text is unknown', () => {
  for (const text of ['Ay, chica, let\'s go get some tacos, ¿sabes? The hermano is waiting.',
    'Arasaka-sama wants the data, V. [sigh] Night City never changes.',
    '{joy} Preem work, choom. You did good.', 'Mama Welles says the food is ready, mijo.',
    'Órale, hermano. Mama Welles cooked enough for an army.', 'Sabes, I think you are right about that, choom.'])
    assert.equal(detectLanguage(text).language, 'en', text);
  for (const text of ['', '[Microphone]', '...', '42', 'V!', 'ok', '{calm}']) assert.equal(detectLanguage(text).language, null, text);
  assert.equal(isNonEnglish('Hola, ¿cómo estás?'), true);
  assert.equal(isNonEnglish('How are you?'), false);
  assert.equal(isNonEnglish('[Microphone]'), false);
});

// ---- The voice of a turn ---------------------------------------------------------------------------------------

const POCKET = {uses: true, provider: 'pocket'}, OMNI = {uses: true, provider: 'omni'}, CLOUD = {uses: false, provider: 'convai'};
test('turn voice: off keeps the chosen voice; on, a non-English turn uses OmniVoice or the cloud voice, never Pocket', () => {
  const plan = (enabled, language, local) => planTurnVoice({enabled, language, local}).engine;
  // Off: exactly the voice used before, whatever the language.
  assert.equal(plan(false, 'es', POCKET), 'pocket');
  assert.equal(plan(false, 'es', OMNI), 'omni');
  assert.equal(plan(false, 'es', CLOUD), 'convai');
  // On, English: the chosen voice.
  for (const local of [POCKET, OMNI, CLOUD]) assert.equal(plan(true, 'en', local), local.uses ? local.provider : 'convai');
  // On, another language: Omni speaks it; the cloud voice speaks it; Pocket (a fallback) hands it to the cloud voice.
  assert.equal(plan(true, 'ja', OMNI), 'omni');
  assert.equal(plan(true, 'ja', CLOUD), 'convai');
  assert.equal(plan(true, 'ja', POCKET), 'convai');
  assert.equal(planTurnVoice({enabled: true, language: 'ja', local: POCKET}).reason, 'english-only-voice');
});

test('reply voice: a local turn follows the reply language; a cloud turn stays on Convai', () => {
  const local = (enabled, language, provider = 'pocket') => planTurnVoice({enabled, language, local: {uses: true, provider}});
  const reply = (plan, text, provider = 'pocket') => replyVoice({plan, text, local: {uses: true, provider}});
  const es = 'Claro que sí, V. Vamos al bar esta noche y hablamos con calma.';
  const en = 'Sure thing, V. Let us talk it over at the bar tonight.';
  assert.deepEqual(reply(local(true, 'en'), en), {engine: 'pocket', language: 'en'});
  assert.deepEqual(reply(local(true, 'en'), es), {engine: 'none', language: 'es', reason: 'english-only-voice'});
  assert.deepEqual(reply(local(true, 'en', 'omni'), es, 'omni'), {engine: 'omni', language: 'es'});
  assert.deepEqual(reply(local(true, 'es', 'omni'), en, 'omni'), {engine: 'omni', language: 'en'});
  // Unclear reply text keeps the turn's expected language.
  assert.deepEqual(reply(local(true, 'es', 'omni'), '...', 'omni'), {engine: 'omni', language: 'es'});
  // A cloud-voice turn is already being spoken by Convai.
  assert.equal(replyVoice({plan: planTurnVoice({enabled: true, language: 'es', local: CLOUD}), text: en}).engine, 'convai');
  assert.equal(replyVoice({plan: planTurnVoice({enabled: true, language: 'es', local: POCKET}), text: es}).engine, 'convai');
  // Off: the plan's own voice, no language.
  assert.deepEqual(reply(local(false, 'en'), es), {engine: 'pocket', language: null});
});

test('the turn plan gates Natural speech and Expressive emotions: the cloud voice never gets tag instructions', () => {
  const speech = new NaturalSpeech(), emotions = new ExpressiveEmotions();
  speech.update({naturalSpeech: true}); emotions.update({expressiveEmotions: true});
  // random 0: this turn is one where Natural speech offers its devices.
  const blocks = plan => [speech.contextFor({engine: plan.engine, random: () => 0}), emotions.contextFor({engine: plan.engine})];
  // A cloud-voice turn (chosen, or Pocket handing a Spanish turn over): no blocks at all.
  assert.deepEqual(blocks(planTurnVoice({enabled: true, language: 'es', local: CLOUD})), ['', '']);
  assert.deepEqual(blocks(planTurnVoice({enabled: true, language: 'es', local: POCKET})), ['', '']);
  // An Omni turn in any language keeps the Omni instructions.
  const omni = blocks(planTurnVoice({enabled: true, language: 'es', local: OMNI}));
  assert.match(omni[0], /OmniVoice/); assert.ok(omni[1]);
  assert.match(blocks(planTurnVoice({enabled: true, language: 'en', local: POCKET}))[0], /Pocket TTS/);
});

test('the setting holder remembers the conversation language only while on', () => {
  const value = new MultilingualConversations();
  assert.equal(value.observe('Hola, ¿cómo estás?'), false); assert.equal(value.lastLanguage, null);
  value.update({multilingualConversations: true});
  assert.equal(value.expected('[Microphone]'), 'en');
  assert.equal(value.observe('Hola, ¿cómo estás?'), true); assert.equal(value.lastLanguage, 'es');
  assert.equal(value.expected('[Microphone]'), 'es', 'a turn without text keeps the conversation language');
  assert.equal(value.expected('How are you doing tonight?'), 'en');
  assert.equal(value.observe('ok'), false, 'unclear text keeps the last language');
  value.update({}); assert.equal(value.enabled, false); assert.equal(value.lastLanguage, null);
  assert.equal(value.update(null), false); assert.equal(value.update(undefined), false);
});

// ---- Twin map and routing --------------------------------------------------------------------------------------

const ordinaryIds = Object.fromEntries([...Object.keys(RELATIONSHIP_PROFILES), 'rogue-amendiares']
  .map(profile => [profile, profile + '-ordinary-id']));
const variants = {version: 1, characters: Object.fromEntries(Object.keys(RELATIONSHIP_PROFILES)
  .map(profile => [profile, {ordinaryCharacterId: ordinaryIds[profile], romanticCharacterId: profile + '-romantic-id'}]))};
const twinRow = (original, twin, extra = {}) => ({phase: 'verified', originalCharacterId: original, multilingualCharacterId: twin,
  verified: true, languageBoxOff: true, ...extra});
const twinDocument = () => ({version: 1, characters: {
  ...Object.fromEntries(Object.keys(ordinaryIds).map(profile => [profile, twinRow(ordinaryIds[profile], profile + '-twin-id')])),
  ...Object.fromEntries(Object.keys(RELATIONSHIP_PROFILES).map(profile => [profile + '-romantic',
    twinRow(profile + '-romantic-id', profile + '-romantic-twin-id', {variant: 'romantic', baseKey: profile})])),
}});

test('only verified twins with the language box off that still clone the current profile are used', () => {
  const document = twinDocument();
  document.characters['rogue-amendiares'].languageBoxOff = false;
  document.characters['river-ward'].originalCharacterId = 'an-older-river-id';
  document.characters['kerry-eurodyne-romantic'].verified = false;
  document.characters['unknown-character'] = twinRow('x', 'y');
  document.characters['panam-palmer'].multilingualCharacterId = ordinaryIds['judy-alvarez'];
  const {twins, skipped} = multilingualTwins(document, {ordinaryIds, variants});
  assert.deepEqual(skipped.sort(), ['kerry-eurodyne-romantic', 'panam-palmer', 'river-ward', 'rogue-amendiares', 'unknown-character']);
  assert.equal(twins['judy-alvarez'], 'judy-alvarez-twin-id');
  assert.equal(twins['judy-alvarez-romantic'], 'judy-alvarez-romantic-twin-id');
  assert.deepEqual(multilingualTwins(null, {ordinaryIds, variants}), {twins: {}, skipped: []});
  assert.deepEqual(multilingualTwins({version: 2}, {ordinaryIds, variants}).skipped, ['invalid-document']);
});

const twins = multilingualTwins(twinDocument(), {ordinaryIds, variants}).twins;
const registry = relationshipRegistry(ordinaryIds, variants, twins);
const NOW = Date.parse('2026-10-01T12:00:00Z'), boundary = {worldToken: 'world-a', generation: 4};
const fact = value => ({status: 'known', value, present: true, sourceId: 'native-quests-system', evidenceRefs: ['core-arcs.judy.committed']});
const snapshot = facts => parseRelationshipState({version: 1, status: 'ready', gameVersion: '2.31', ...boundary, capturedAt: NOW,
  facts: Object.fromEntries(Object.entries(facts).map(([name, value]) => [name, fact(value)]))});

test('the registry adds each twin as "<providerKey>-multilingual" in the original family with its own marker', () => {
  assert.equal(registry.providerIds['judy-alvarez-multilingual'], 'judy-alvarez-twin-id');
  assert.equal(registry.providerIds['judy-alvarez-romantic-multilingual'], 'judy-alvarez-romantic-twin-id');
  for (const key of ['judy-alvarez', 'judy-alvarez-romantic', 'judy-alvarez-multilingual', 'judy-alvarez-romantic-multilingual'])
    assert.equal(registry.providerFamilies[key], 'judy-alvarez', key);
  assert.equal(registry.markerKeys['judy-alvarez-multilingual'], 'judy-alvarez:multilingual');
  assert.equal(registry.markerKeys['judy-alvarez-romantic-multilingual'], 'judy-alvarez-romantic:multilingual');
  assert.equal(twinMarkerKey('rogue-amendiares'), 'rogue-amendiares:multilingual');
  assert.equal(registry.markerKeys['judy-alvarez'], undefined, 'originals keep their own marker');
  // Invalid maps fail loudly instead of routing to a wrong character.
  assert.throws(() => relationshipRegistry(ordinaryIds, variants, {nobody: 'x'}), {code: 'INVALID_MULTILINGUAL_PROFILE'});
  assert.throws(() => relationshipRegistry(ordinaryIds, variants, {'judy-alvarez': ordinaryIds['panam-palmer']}), {code: 'DUPLICATE_PROVIDER_ID'});
  assert.throws(() => relationshipRegistry(ordinaryIds, variants, {'judy-alvarez-multilingual': 'z'}), {code: 'INVALID_MULTILINGUAL_PROFILE'});
  // No twin map: identical to the English-only registry.
  assert.deepEqual(relationshipRegistry(ordinaryIds, variants).providerIds, relationshipRegistry(ordinaryIds, variants, {}).providerIds);
});

test('multilingual selection picks the twin of exactly the profile relationship routing chose, romantic included', () => {
  const select = (profileKey, mode, facts, multilingual) => selectRelationshipProfile({profileKey, mode, registry, boundary, now: NOW,
    snapshot: snapshot(facts), multilingual});
  const committed = {sq030_judy_lover: 1, sq030_11_romance: 1, sq030_romance: 1};
  // Romantic by verified save facts.
  let chosen = select('judy-alvarez', 'auto', committed, true);
  assert.equal(chosen.providerProfileKey, 'judy-alvarez-romantic-multilingual'); assert.equal(chosen.variant, 'romantic');
  assert.equal(chosen.characterId, 'judy-alvarez-romantic-twin-id'); assert.equal(chosen.multilingual, true);
  // Ordinary when unconfirmed, explicit Off, or Off with confirmed facts.
  assert.equal(select('judy-alvarez', 'auto', {}, true).providerProfileKey, 'judy-alvarez-multilingual');
  assert.equal(select('judy-alvarez', 'off', committed, true).providerProfileKey, 'judy-alvarez-multilingual');
  // Explicit On picks the romantic twin.
  assert.equal(select('panam-palmer', 'on', {}, true).providerProfileKey, 'panam-palmer-romantic-multilingual');
  // A character without relationships.
  assert.equal(select('rogue-amendiares', 'auto', {}, true).characterId, 'rogue-amendiares-twin-id');
  // Off: the originals, unchanged.
  chosen = select('judy-alvarez', 'auto', committed, false);
  assert.equal(chosen.providerProfileKey, 'judy-alvarez-romantic'); assert.equal(chosen.multilingual, false);
  assert.equal(select('rogue-amendiares', 'auto', {}, false).providerProfileKey, 'rogue-amendiares');
  // A profile whose twin is missing keeps its original.
  const partial = relationshipRegistry(ordinaryIds, variants, {'judy-alvarez': 'judy-alvarez-twin-id'});
  const romantic = selectRelationshipProfile({profileKey: 'judy-alvarez', mode: 'on', registry: partial, boundary, now: NOW,
    snapshot: snapshot({}), multilingual: true});
  assert.equal(romantic.providerProfileKey, 'judy-alvarez-romantic'); assert.equal(romantic.multilingual, false);
});

test('the setting commits at an idle boundary, retires every twinned character once and guards accept twin IDs', () => {
  let now = NOW;
  const routes = new RelationshipRouting({ordinaryIds, variants, multilingual: twins, now: () => now});
  const state = {version: 1, status: 'ready', gameVersion: '2.31', ...boundary, capturedAt: NOW, facts: {}};
  routes.update({}, state, {boundary});
  assert.equal(routes.select('rogue-amendiares', boundary).providerProfileKey, 'rogue-amendiares');
  // Busy: staged, not applied.
  assert.equal(routes.update({multilingualConversations: true}, state, {boundary, busy: true}), false);
  assert.equal(routes.select('rogue-amendiares', boundary).providerProfileKey, 'rogue-amendiares');
  assert.equal(routes.update(undefined, undefined, {boundary}), true);
  assert.equal(routes.select('rogue-amendiares', boundary).providerProfileKey, 'rogue-amendiares-multilingual');
  assert.deepEqual(routes.consumeRouteChanges().sort(), Object.keys(ordinaryIds).sort());
  // Guards: a twin ID belongs to the canonical character and is the selected route.
  const guard = {characterId: 'rogue-amendiares-twin-id'};
  assert.equal(routes.providerKeyForGuard('rogue-amendiares', guard), 'rogue-amendiares-multilingual');
  assert.equal(routes.guardSelected('rogue-amendiares', guard, boundary), true);
  assert.equal(routes.guardSelected('rogue-amendiares', {characterId: 'rogue-amendiares-ordinary-id'}, boundary), false);
  assert.throws(() => routes.providerKeyForGuard('judy-alvarez', guard), {code: 'CHARACTER_MISMATCH'});
  // Unchanged settings: no route churn.
  assert.equal(routes.update({multilingualConversations: true}, state, {boundary}), false);
  assert.equal(routes.describe(boundary).find(row => row.profileKey === 'judy-alvarez').multilingual, true);
  assert.equal(routes.markerKeys['judy-alvarez-romantic-multilingual'], 'judy-alvarez-romantic:multilingual');
});

// ---- Memory: a twin is its own character, and Forget clears both ------------------------------------------------

async function memoryFixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'multilingual-memory-'));
  const calls = [];
  const provider = {
    async enableMemory(value) { calls.push({kind: 'enable', ...value}); return {enabled: true, changed: false}; },
    async clearMemory(value) { calls.push({kind: 'clear', ...value}); return {accepted: true, providerEmptyObserved: true}; },
    async inspectMemory() { return {providerEmptyObserved: true}; },
  };
  const memory = await PlayerMemory.open({path: join(directory, 'player-memory.json'), characterIds: registry.providerIds,
    characterFamilies: registry.providerFamilies, provider, quiesce: async () => ({quiesced: true})});
  t.after(async () => { await memory.close().catch(() => {}); await fs.rm(directory, {recursive: true, force: true}); });
  return {memory, calls};
}
const talk = (memory, profileKey) => memory.beginConversation({profileKey, guard: memory.route(profileKey).guard,
  source: 'player', channel: 'private', requestId: 'r-' + profileKey});

test('a twin keeps a separate memory identity but shares the player and the canonical family', async t => {
  const {memory} = await memoryFixture(t);
  const original = memory.route('judy-alvarez'), twin = memory.route('judy-alvarez-multilingual');
  assert.equal(original.endUserId, twin.endUserId, 'one player');
  assert.notEqual(original.guard.characterId, twin.guard.characterId, 'separate Convai memory (character ID + player)');
  await talk(memory, 'judy-alvarez-multilingual'); await talk(memory, 'judy-alvarez-romantic-multilingual');
  await talk(memory, 'rogue-amendiares-multilingual');
  assert.deepEqual(memory.status().characters.map(row => row.profileKey).sort(), ['judy-alvarez', 'rogue-amendiares']);
  assert.ok(!JSON.stringify(memory.status()).includes('multilingual'), 'status shows canonical characters only');
});

test('Forget for one character clears the original, romantic and both twins; Forget all clears every twin', async t => {
  const {memory, calls} = await memoryFixture(t);
  for (const key of ['judy-alvarez', 'judy-alvarez-romantic', 'judy-alvarez-multilingual', 'judy-alvarez-romantic-multilingual',
    'rogue-amendiares-multilingual']) await talk(memory, key);
  // A command naming a twin's provider key is still the canonical family.
  const result = await memory.clearCharacter({profileKey: 'judy-alvarez-multilingual', actionId: 'forget-judy'});
  assert.equal(result.state, 'succeeded'); assert.equal(result.profileKey, 'judy-alvarez');
  const cleared = calls.filter(call => call.kind === 'clear').map(call => call.profileKey).sort();
  assert.deepEqual(cleared, ['judy-alvarez', 'judy-alvarez-multilingual', 'judy-alvarez-romantic', 'judy-alvarez-romantic-multilingual']);
  calls.length = 0;
  assert.equal((await memory.clearAll({actionId: 'forget-all'})).state, 'succeeded');
  assert.ok(calls.some(call => call.kind === 'clear' && call.profileKey === 'rogue-amendiares-multilingual'
    && call.characterId === 'rogue-amendiares-twin-id'));
});

test('the Forget menu command for a character reaches the twins through the bridge family map', async t => {
  const {memory, calls} = await memoryFixture(t);
  await talk(memory, 'panam-palmer-romantic-multilingual');
  const directory = await fs.mkdtemp(join(tmpdir(), 'multilingual-control-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const commandPath = join(directory, 'memory-command.json');
  const control = await PlayerMemoryControl.open({memory, commandPath, publish: async () => {},
    chatResetFamilies: registry.providerFamilies});
  await fs.writeFile(commandPath, JSON.stringify({version: 1, id: 'forget-panam', action: 'clear', scope: 'character',
    profileKey: 'panam-palmer', issuedAt: Date.now()}));
  await control.poll(); await control.work;
  assert.deepEqual(calls.filter(call => call.kind === 'clear').map(call => call.characterId), ['panam-palmer-romantic-twin-id']);
  await control.close();
});

test('the provider adapter accepts a twin only with its own exact marker', async () => {
  const backstory = {};
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(request.body), endpoint = new URL(url).pathname;
    let value;
    if (endpoint === '/character/list') value = {characters: Object.values(registry.providerIds).map(character_id => ({character_id}))};
    else if (endpoint === '/character/get') value = {character_id: body.charID, backstory: backstory[body.charID], memory_settings: {enabled: true}};
    else if (endpoint === '/memory/delete-all') value = {message: 'deleted'};
    else if (endpoint === '/memory/list') value = {memories: [], total_count: 0, has_more: false, page: 1, page_size: 1};
    return new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}});
  };
  const api = new PlayerMemoryApi({key: 'test', characterIds: registry.providerIds, markerKeys: registry.markerKeys, fetchImpl});
  const endUserId = '00000000-0000-4000-8000-000000000000';
  const clear = profileKey => api.clearMemory({profileKey, characterId: registry.providerIds[profileKey], endUserId});
  backstory['judy-alvarez-twin-id'] = 'Bio\n[CyberpunkConvai profile v2:judy-alvarez:multilingual]';
  backstory['judy-alvarez-romantic-twin-id'] = 'Bio\n[CyberpunkConvai profile v2:judy-alvarez-romantic:multilingual]';
  backstory['judy-alvarez-ordinary-id'] = 'Bio\n[CyberpunkConvai profile v2:judy-alvarez]';
  assert.equal((await clear('judy-alvarez-multilingual')).accepted, true);
  assert.equal((await clear('judy-alvarez-romantic-multilingual')).accepted, true);
  assert.equal((await clear('judy-alvarez')).accepted, true);
  // An original marker on a twin ID, or a twin marker on an original, is not ours to clear.
  backstory['judy-alvarez-twin-id'] = 'Bio\n[CyberpunkConvai profile v2:judy-alvarez]';
  await assert.rejects(clear('judy-alvarez-multilingual'), {code: 'NOT_MOD_OWNED'});
  backstory['judy-alvarez-ordinary-id'] = 'Bio\n[CyberpunkConvai profile v2:judy-alvarez:multilingual]';
  await assert.rejects(clear('judy-alvarez'), {code: 'NOT_MOD_OWNED'});
  assert.throws(() => new PlayerMemoryApi({key: 'k', markerKeys: {'bad key!': 'x'}}), {code: 'INVALID_CONFIGURATION'});
});

// ---- The installed map (skipped where the ignored runtime file is absent) ----------------------------------------

const runtime = new URL('../runtime/', import.meta.url);
const installed = ['multilingual-profiles.json', 'characters.json', 'relationship-profiles.json']
  .every(name => existsSync(new URL(name, runtime)));
test('the installed twin map covers every profiled character and romantic profile', {skip: !installed && 'runtime map absent'}, () => {
  const read = name => JSON.parse(readFileSync(new URL(name, runtime), 'utf8'));
  const ids = read('characters.json'), relationship = read('relationship-profiles.json');
  const {twins: loaded, skipped} = multilingualTwins(read('multilingual-profiles.json'), {ordinaryIds: ids, variants: relationship});
  const document = read('multilingual-profiles.json');
  // Every profile has a verified twin, the generic NPC archetypes (npc-*) included (docs/NPC_ARCHETYPES.md). A twin is
  // routed once its language box is marked off; a new batch may be waiting for that web-session step, and nothing else.
  for (const key of skipped) assert.equal(document.characters[key]?.verified === true && document.characters[key].languageBoxOff !== true, true, key + ' is skipped');
  const twinned = Object.keys(ids);
  for (const key of twinned) {
    assert.equal(document.characters[key]?.verified, true, key + ' has no verified twin');
    assert.ok(loaded[key] || skipped.includes(key), key);
  }
  const unrouted = twinned.filter(key => !loaded[key]);
  assert.ok(unrouted.every(key => key.startsWith('npc-')), 'only a new archetype batch may wait for the language box');
  for (const key of Object.keys(relationship.characters)) assert.ok(loaded[key + '-romantic'], key + '-romantic');
  const routes = new RelationshipRouting({ordinaryIds: ids, variants: relationship, multilingual: loaded});
  for (const key of twinned.filter(key => loaded[key])) assert.equal(routes.providerFamilies[key + '-multilingual'], key);
});

// ---- Archetypes (npc-*) route to their twins like named characters -----------------------------------------------

const archetypeKeys = JSON.parse(readFileSync(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8')).map(row => row.key);
const archetypeIds = Object.fromEntries(archetypeKeys.map(profile => [profile, profile + '-original-id']));
const archetypeTwinDocument = () => ({version: 1, characters: Object.fromEntries(archetypeKeys
  .map(profile => [profile, twinRow(archetypeIds[profile], profile + '-twin-id')]))});

test('every archetype key and its twin key stay inside the profile-key limit used across the bridge', () => {
  assert.equal(archetypeKeys.length, 74);
  for (const profile of archetypeKeys) assert.match(profile + '-multilingual', /^[a-z0-9][a-z0-9-]{0,79}$/, profile);
});

test('archetype twins are loaded under the same rules as named twins', () => {
  const ids = {...ordinaryIds, ...archetypeIds};
  const document = {version: 1, characters: {...twinDocument().characters, ...archetypeTwinDocument().characters}};
  const loaded = multilingualTwins(document, {ordinaryIds: ids, variants});
  assert.deepEqual(loaded.skipped, []);
  for (const profile of archetypeKeys) assert.equal(loaded.twins[profile], profile + '-twin-id', profile);
  // Not routed until the language box is off, still verified, and only while it clones today's original.
  document.characters['npc-ncpd-male'].languageBoxOff = false;
  document.characters['npc-mox-female'].verified = false;
  document.characters['npc-homeless-male'].originalCharacterId = 'an-older-id';
  assert.deepEqual(multilingualTwins(document, {ordinaryIds: ids, variants}).skipped.sort(), ['npc-homeless-male', 'npc-mox-female', 'npc-ncpd-male']);
  // An archetype missing from the ID file has nothing to clone.
  const partial = {...ids}; delete partial['npc-ripperdoc-male'];
  assert.deepEqual(multilingualTwins(document, {ordinaryIds: partial, variants}).skipped.includes('npc-ripperdoc-male'), true);
});

test('with Multilingual on, an archetype goes to its twin; off, to the original; the twin keeps the archetype family and marker', () => {
  const ids = {...ordinaryIds, ...archetypeIds};
  const archetypeTwins = multilingualTwins({version: 1, characters: {...twinDocument().characters, ...archetypeTwinDocument().characters}},
    {ordinaryIds: ids, variants}).twins;
  const archetypeRegistry = relationshipRegistry(ids, variants, archetypeTwins);
  const choose = (profileKey, multilingual) => selectRelationshipProfile({profileKey, mode: 'auto', registry: archetypeRegistry, boundary, now: NOW,
    snapshot: snapshot({}), multilingual});
  for (const profile of archetypeKeys) {
    const on = choose(profile, true), off = choose(profile, false);
    assert.equal(on.status, 'ready'); assert.equal(on.multilingual, true);
    assert.equal(on.providerProfileKey, profile + '-multilingual', profile);
    assert.equal(on.characterId, profile + '-twin-id'); assert.equal(on.variant, 'ordinary');
    assert.equal(off.providerProfileKey, profile); assert.equal(off.characterId, archetypeIds[profile]); assert.equal(off.multilingual, false);
    assert.equal(archetypeRegistry.providerFamilies[profile + '-multilingual'], profile);
    assert.equal(archetypeRegistry.markerKeys[profile + '-multilingual'], profile + ':multilingual');
    assert.equal(archetypeRegistry.markerKeys[profile], undefined);
  }
  // A single missing twin keeps that archetype on its English original; the others still switch.
  const gap = {...archetypeTwins}; delete gap['npc-bartender-female'];
  const gapRegistry = relationshipRegistry(ids, variants, gap);
  const route = (profileKey) => selectRelationshipProfile({profileKey, mode: 'auto', registry: gapRegistry, boundary, now: NOW, snapshot: snapshot({}), multilingual: true});
  assert.equal(route('npc-bartender-female').providerProfileKey, 'npc-bartender-female');
  assert.equal(route('npc-bartender-male').providerProfileKey, 'npc-bartender-male-multilingual');
});

test('the setting retires every archetype route at the idle boundary, and guards accept an archetype twin ID', () => {
  const ids = {...ordinaryIds, ...archetypeIds};
  const archetypeTwins = multilingualTwins({version: 1, characters: {...twinDocument().characters, ...archetypeTwinDocument().characters}},
    {ordinaryIds: ids, variants}).twins;
  const routes = new RelationshipRouting({ordinaryIds: ids, variants, multilingual: archetypeTwins, now: () => NOW});
  const state = {version: 1, status: 'ready', gameVersion: '2.31', ...boundary, capturedAt: NOW, facts: {}};
  routes.update({}, state, {boundary});
  assert.equal(routes.select('npc-maelstrom-male', boundary).providerProfileKey, 'npc-maelstrom-male');
  assert.equal(routes.update({multilingualConversations: true}, state, {boundary}), true);
  assert.equal(routes.select('npc-maelstrom-male', boundary).providerProfileKey, 'npc-maelstrom-male-multilingual');
  const changed = routes.consumeRouteChanges();
  for (const profile of archetypeKeys) assert.ok(changed.includes(profile), profile + ' not retired');
  const guard = {characterId: 'npc-maelstrom-male-twin-id'};
  assert.equal(routes.providerKeyForGuard('npc-maelstrom-male', guard), 'npc-maelstrom-male-multilingual');
  assert.equal(routes.guardSelected('npc-maelstrom-male', guard, boundary), true);
  assert.equal(routes.guardSelected('npc-maelstrom-male', {characterId: 'npc-maelstrom-male-original-id'}, boundary), false);
  assert.throws(() => routes.providerKeyForGuard('npc-ncpd-male', guard), {code: 'CHARACTER_MISMATCH'});
  // Turning it off sends them back.
  assert.equal(routes.update({multilingualConversations: false}, state, {boundary}), true);
  assert.equal(routes.select('npc-maelstrom-male', boundary).providerProfileKey, 'npc-maelstrom-male');
});

test('an archetype twin has its own memory identity in the archetype family, and the provider adapter accepts only its marker', async t => {
  const ids = {...ordinaryIds, ...archetypeIds};
  const archetypeTwins = multilingualTwins({version: 1, characters: archetypeTwinDocument().characters}, {ordinaryIds: ids, variants}).twins;
  const archetypeRegistry = relationshipRegistry(ids, variants, archetypeTwins);
  const directory = await fs.mkdtemp(join(tmpdir(), 'multilingual-archetype-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const calls = [];
  const provider = {
    async enableMemory(value) { calls.push({kind: 'enable', ...value}); return {enabled: true, changed: false}; },
    async clearMemory(value) { calls.push({kind: 'clear', ...value}); return {accepted: true, providerEmptyObserved: true}; },
    async inspectMemory() { return {providerEmptyObserved: true}; },
  };
  const memory = await PlayerMemory.open({path: join(directory, 'player-memory.json'), characterIds: archetypeRegistry.providerIds,
    characterFamilies: archetypeRegistry.providerFamilies, provider, quiesce: async () => ({quiesced: true})});
  t.after(() => memory.close().catch(() => {}));
  const original = memory.route('npc-ncpd-male'), twin = memory.route('npc-ncpd-male-multilingual');
  assert.equal(original.endUserId, twin.endUserId);
  assert.notEqual(original.guard.characterId, twin.guard.characterId);
  await memory.beginConversation({profileKey: 'npc-ncpd-male-multilingual', guard: twin.guard, source: 'player', channel: 'private', requestId: 'r-npc'});
  assert.deepEqual(memory.status().characters.map(row => row.profileKey), ['npc-ncpd-male']);
  assert.equal((await memory.clearCharacter({profileKey: 'npc-ncpd-male-multilingual', actionId: 'forget-npc'})).profileKey, 'npc-ncpd-male');
  assert.ok(calls.some(call => call.kind === 'clear' && call.characterId === 'npc-ncpd-male-twin-id'));
  // The adapter: the twin marker clears a twin, an original marker on a twin ID does not.
  const backstory = {'npc-ncpd-male-twin-id': 'Bio\n[CyberpunkConvai profile v2:npc-ncpd-male:multilingual]'};
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(request.body), endpoint = new URL(url).pathname;
    let value;
    if (endpoint === '/character/list') value = {characters: Object.values(archetypeRegistry.providerIds).map(character_id => ({character_id}))};
    else if (endpoint === '/character/get') value = {character_id: body.charID, backstory: backstory[body.charID], memory_settings: {enabled: false}};
    else if (endpoint === '/memory/delete-all') value = {message: 'deleted'};
    else if (endpoint === '/memory/list') value = {memories: [], total_count: 0, has_more: false, page: 1, page_size: 1};
    return new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}});
  };
  const api = new PlayerMemoryApi({key: 'test', characterIds: archetypeRegistry.providerIds, markerKeys: archetypeRegistry.markerKeys, fetchImpl});
  const clear = () => api.clearMemory({profileKey: 'npc-ncpd-male-multilingual', characterId: 'npc-ncpd-male-twin-id', endUserId: '00000000-0000-4000-8000-000000000000'});
  assert.equal((await clear()).accepted, true);
  backstory['npc-ncpd-male-twin-id'] = 'Bio\n[CyberpunkConvai profile v2:npc-ncpd-male]';
  await assert.rejects(clear(), {code: 'NOT_MOD_OWNED'});
});

// ---- The bridge wiring ---------------------------------------------------------------------------------------

test('the bridge loads the twins, gives memory their markers and decides the voice per turn', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /multilingualTwins\(JSON\.parse\(await readFile\(resolve\(stateDirectory, 'multilingual-profiles\.json'\)/);
  assert.match(bridge, /new RelationshipRouting\(\{ordinaryIds: ids, variants: relationshipVariants,\s*multilingual: multilingualProfiles\.twins\}\)/);
  assert.match(bridge, /markerKeys: relationshipRoutes\.markerKeys/);
  assert.match(bridge, /characterFamilies: relationshipRoutes\.providerFamilies/);
  assert.match(bridge, /chatResetFamilies: relationshipRoutes\.providerFamilies/);
  assert.match(bridge, /ttsEnabled: localVoice\.playbackEnabled!==false&&!turnUsesLocal\(input\)/);
  assert.match(bridge, /const multilingualChanged = multilingual\.update\(settings\);/);
  // Every per-turn voice check goes through the plan; only invitation readiness asks about the profile.
  const perTurn = bridge.slice(bridge.indexOf('async function synthesizeReply('), bridge.indexOf('async function pollMicrophone('));
  assert.doesNotMatch(perTurn, /usesProfile\(input\.profileKey\)|localVoice\.provider\s*===\s*'omni'\s*\)/);
});

test('the reply-language block names the player\'s language, last in the context, only while the setting is on', async () => {
  const {languageContext} = await import('./multilingual.mjs');
  assert.equal(languageContext({enabled: false, text: 'hola, cómo estás'}), '');
  // The in-game failure: a short Spanish greeting answered in English under the English context notes.
  assert.match(languageContext({enabled: true, text: 'hola, cómo estás'}), /latest message, which is Spanish\..*whole reply in Spanish/);
  assert.match(languageContext({enabled: true, text: 'こんにちは、ジュディ'}), /which is Japanese/);
  assert.match(languageContext({enabled: true, text: 'How are you?'}), /which is English/);
  // No player text (a reaction, the microphone placeholder): the language the player is using, with the last one.
  assert.match(languageContext({enabled: true, text: '[Microphone]', lastLanguage: 'de'}), /language the player is using with you \(so far German\)/);
  assert.match(languageContext({enabled: true, text: ''}), /language the player is using with you\. Everything else/);
  const setting = new MultilingualConversations();
  assert.equal(setting.contextFor('hola'), '');
  setting.update({multilingualConversations: true}); setting.observe('Hola, ¿cómo estás?');
  assert.match(setting.contextFor('[Microphone]'), /so far Spanish/);
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /expressiveEmotionsContext\(input\),\s*\/\/[^\n]*\n\s*multilingual\.contextFor\(input\.reaction \? '' : input\.text\)\]\s*\.filter\(Boolean\)/);
});
