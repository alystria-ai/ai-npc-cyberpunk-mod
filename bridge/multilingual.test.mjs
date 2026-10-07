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
test('turn voice: off keeps the chosen voice; on, a non-English turn needs Omni or the cloud voice', () => {
  const plan = (enabled, language, local, omni = {}) => planTurnVoice({enabled, language, local, omni}).engine;
  // Off: exactly the voice used before, whatever the language.
  assert.equal(plan(false, 'es', POCKET, {usable: true, ready: true}), 'pocket');
  assert.equal(plan(false, 'es', OMNI), 'omni');
  assert.equal(plan(false, 'es', CLOUD), 'convai');
  // On, English: the chosen voice.
  for (const local of [POCKET, OMNI, CLOUD]) assert.equal(plan(true, 'en', local), local.uses ? local.provider : 'convai');
  // On, another language.
  assert.equal(plan(true, 'ja', OMNI), 'omni');
  assert.equal(plan(true, 'ja', CLOUD), 'convai');
  assert.equal(plan(true, 'ja', POCKET, {usable: true, ready: true}), 'omni');
  assert.equal(planTurnVoice({enabled: true, language: 'ja', local: POCKET, omni: {usable: true, ready: false}}).reason, 'omni-loading');
  assert.equal(planTurnVoice({enabled: true, language: 'ja', local: POCKET, omni: {usable: false}}).reason, 'no-omni');
  assert.equal(plan(true, 'ja', POCKET, {usable: true, ready: false}), 'convai');
  assert.equal(plan(true, 'ja', POCKET, {usable: false}), 'convai');
});

test('reply voice: a local turn follows the reply language; a cloud turn stays on Convai', () => {
  const local = (enabled, language, provider = 'pocket', omni = {}) => planTurnVoice({enabled, language,
    local: {uses: true, provider}, omni});
  const reply = (plan, text, provider = 'pocket', omni = {}) => replyVoice({plan, text, local: {uses: true, provider}, omni});
  const es = 'Claro que sí, V. Vamos al bar esta noche y hablamos con calma.';
  const en = 'Sure thing, V. Let us talk it over at the bar tonight.';
  assert.deepEqual(reply(local(true, 'en'), en), {engine: 'pocket', language: 'en'});
  assert.deepEqual(reply(local(true, 'en'), es), {engine: 'none', language: 'es', reason: 'no-omni'});
  assert.deepEqual(reply(local(true, 'en'), es, 'pocket', {usable: true, ready: false}), {engine: 'none', language: 'es', reason: 'omni-loading'});
  assert.deepEqual(reply(local(true, 'en'), es, 'pocket', {usable: true, ready: true}), {engine: 'omni', language: 'es'});
  assert.deepEqual(reply(local(true, 'es', 'pocket', {usable: true, ready: true}), en, 'pocket', {usable: true, ready: true}),
    {engine: 'pocket', language: 'en'}, 'an English reply keeps the chosen voice');
  assert.deepEqual(reply(local(true, 'en', 'omni'), es, 'omni'), {engine: 'omni', language: 'es'});
  // Unclear reply text keeps the turn's expected language.
  assert.deepEqual(reply(local(true, 'es', 'pocket', {usable: true, ready: true}), '...', 'pocket', {usable: true, ready: true}),
    {engine: 'omni', language: 'es'});
  // A cloud-voice turn is already being spoken by Convai.
  assert.equal(replyVoice({plan: planTurnVoice({enabled: true, language: 'es', local: CLOUD}), text: en}).engine, 'convai');
  // Off: the plan's own voice, no language.
  assert.deepEqual(reply(local(false, 'en'), es), {engine: 'pocket', language: null});
});

test('the turn plan gates Natural speech and Expressive emotions: the cloud voice never gets tag instructions', () => {
  const speech = new NaturalSpeech(), emotions = new ExpressiveEmotions();
  speech.update({naturalSpeech: true}); emotions.update({expressiveEmotions: true});
  const blocks = plan => [speech.contextFor({engine: plan.engine}), emotions.contextFor({engine: plan.engine})];
  // Without the Omni pack a Spanish turn is a cloud-voice turn: no blocks at all.
  const cloud = planTurnVoice({enabled: true, language: 'es', local: POCKET, omni: {usable: false}});
  assert.deepEqual(blocks(cloud), ['', '']);
  // The English turn of the same player keeps both.
  const english = planTurnVoice({enabled: true, language: 'en', local: POCKET, omni: {usable: false}});
  assert.ok(blocks(english).every(Boolean));
  assert.match(blocks(english)[0], /Pocket TTS/);
  // With the pack ready the Spanish turn is an Omni turn and gets the Omni instructions.
  const omni = planTurnVoice({enabled: true, language: 'es', local: POCKET, omni: {usable: true, ready: true}});
  assert.match(blocks(omni)[0], /OmniVoice/); assert.ok(blocks(omni)[1]);
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
  assert.deepEqual(skipped, []);
  for (const key of Object.keys(ids)) assert.ok(loaded[key], key);
  for (const key of Object.keys(relationship.characters)) assert.ok(loaded[key + '-romantic'], key + '-romantic');
  const routes = new RelationshipRouting({ordinaryIds: ids, variants: relationship, multilingual: loaded});
  for (const key of Object.keys(ids)) assert.equal(routes.providerFamilies[key + '-multilingual'], key);
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
  assert.match(bridge, /const multilingualChanged = multilingual\.update\(settings\);\s*localVoice\.setMultilingual\(multilingual\.enabled\);/);
  // Every per-turn voice check goes through the plan; only invitation readiness asks about the profile.
  const perTurn = bridge.slice(bridge.indexOf('async function synthesizeReply('), bridge.indexOf('async function pollMicrophone('));
  assert.doesNotMatch(perTurn, /usesProfile\(input\.profileKey\)|localVoice\.provider\s*===\s*'omni'\s*\)/);
});
