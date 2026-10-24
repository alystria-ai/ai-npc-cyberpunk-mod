import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectLanguage, isNonEnglish} from './reply-language.mjs';
import {VOXTRAL_TTS_MODEL, VOXTRAL_TTS_FALLBACK_MODEL, voxtralSpeaks} from './voxtral-languages.mjs';
import {MultilingualConversations, VoiceLanguageNotice, multilingualTwins, planTurnVoice, replyVoice, textProviderLanguageContext, twinMarkerKey,
  wantsTwin} from './multilingual.mjs';
import {CAST_EXPANSION_KEYS} from './cast-expansion-keys.mjs';
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
      // A live reply of Judy's multilingual twin (smoke test, 2026-10-07).
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

// CLOUD: the player chose the Convai voice (`convai` is what the bridge says when the Convai voice may speak). FAILED: a local voice was chosen and cannot
// run right now (its provider is the route 'text'): no voice speaks, and above all not the Convai voice.
const POCKET = {uses: true, provider: 'pocket'}, OMNI = {uses: true, provider: 'omni'}, CLOUD = {uses: false, provider: 'convai', convai: true};
const FAILED = {uses: false, provider: 'text', convai: false};
test('turn voice: off keeps the chosen voice; on, a non-English turn uses OmniVoice or the cloud voice, never Pocket', () => {
  const plan = (enabled, language, local) => planTurnVoice({enabled, language, local}).engine;
  // Off: exactly the voice used before, whatever the language.
  assert.equal(plan(false, 'es', POCKET), 'pocket');
  assert.equal(plan(false, 'es', OMNI), 'omni');
  assert.equal(plan(false, 'es', CLOUD), 'convai');
  // On, English: the chosen voice.
  for (const local of [POCKET, OMNI, CLOUD]) assert.equal(plan(true, 'en', local), local.uses ? local.provider : 'convai');
  // On, another language: Omni speaks it; the cloud voice speaks it; Pocket (a fallback) cannot, and does NOT hand it to the cloud voice: it is written.
  assert.equal(plan(true, 'ja', OMNI), 'omni');
  assert.equal(plan(true, 'ja', CLOUD), 'convai');
  assert.equal(plan(true, 'ja', POCKET), 'none');
  assert.equal(planTurnVoice({enabled: true, language: 'ja', local: POCKET}).reason, 'english-only-voice');
});

test('a chosen local voice that cannot run is never replaced by the Convai voice, in any language, with Multilingual on or off, on a text provider or not', () => {
  for (const language of ['en', 'es', 'ja']) {
    for (const options of [{enabled: false}, {enabled: true}, {enabled: false, textProvider: true}]) {
      // Nothing speaks: not Pocket, not OmniVoice, above all not Convai.
      for (const local of [FAILED, {uses: false, provider: 'pocket'}, {uses: false}, {}]) {
        const plan = planTurnVoice({...options, language, local});
        assert.equal(plan.engine, 'none', JSON.stringify([language, options, local]));
        assert.equal(plan.reason, 'local-voice-unavailable');
        assert.deepEqual(replyVoice({plan, text: 'Claro que sí, V. Vamos al bar esta noche.', local}), {engine: 'none', language: plan.language, reason: 'local-voice-unavailable'});
      }
      // The Convai voice was chosen on purpose: it speaks.
      assert.equal(planTurnVoice({...options, language, local: CLOUD}).engine, 'convai');
    }
  }
  // A written turn gets neither Natural speech nor Expressive emotions instructions (no voice would render the tags).
  const speech = new NaturalSpeech(), emotions = new ExpressiveEmotions();
  speech.update({naturalSpeech: true}); emotions.update({expressiveEmotions: true});
  const plan = planTurnVoice({enabled: false, language: 'en', local: FAILED});
  assert.deepEqual([speech.contextFor({engine: plan.engine, random: () => 0}), emotions.contextFor({engine: plan.engine})], ['', '']);
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
  assert.equal(replyVoice({plan: planTurnVoice({enabled: true, language: 'es', local: POCKET}), text: es}).engine, 'none', 'Pocket cannot speak Spanish and does not hand it to the Convai voice');
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

test('the holder remembers the language the conversation was last in, on every route', () => {
  const value = new MultilingualConversations();
  assert.equal(value.expected('[Microphone]'), 'en');
  // Hysteresis: a short line leaves English only as the second solid detection in a row (or as one long line).
  assert.equal(value.observe('Hola, ¿cómo estás?'), false, 'the first short line is only noted'); assert.equal(value.lastLanguage, null);
  assert.equal(value.observe('Hola, ¿cómo estás?'), true); assert.equal(value.lastLanguage, 'es');
  assert.equal(value.expected('[Microphone]'), 'es', 'a turn without text keeps the conversation language');
  assert.equal(value.expected('How are you doing tonight?'), 'es', 'one English line does not move a Spanish conversation back');
  assert.equal(value.expected('hows biz'), 'es');
  assert.equal(value.observe('ok'), false, 'unclear text keeps the last language');
  assert.equal(value.lastLanguage, 'es');
  // There is no setting to switch it off or on: an old settings object is not read.
  assert.equal(typeof value.update, 'undefined'); assert.equal(typeof value.setTextProvider, 'undefined');
});

test('wantsTwin: a clear non-English message goes to the twin, a clear English one back to the original, anything unclear stays where the conversation is', () => {
  // Clearly another language: the twin, whatever came before.
  for (const text of ['Combien de temps encore ?', 'Siamo quasi arrivati?', '¿Qué pasa, choom?', 'Wie lange noch?', 'こんにちは'])
    assert.equal(wantsTwin({text}), true, text);
  // English, three words or more: the original, even from the middle of a French conversation.
  assert.equal(wantsTwin({text: 'how long until we get there', lastLanguage: 'fr'}), false);
  assert.equal(wantsTwin({text: 'Hey V, what do you need?', lastLanguage: 'ja'}), false);
  // Unclear: stays. One English word or "ok" does not switch a French conversation back (a switch is a new session and another memory).
  for (const text of ['ok', 'yes', 'lol', '', '[Microphone]', '42', undefined]) {
    assert.equal(wantsTwin({text, lastLanguage: 'fr'}), true, JSON.stringify(text));
    assert.equal(wantsTwin({text, lastLanguage: 'en'}), false, JSON.stringify(text));
    assert.equal(wantsTwin({text, lastLanguage: null}), false, JSON.stringify(text));
  }
  // A reaction (a bark, an add-on remark) follows the conversation and never starts a twin conversation by its own text.
  assert.equal(wantsTwin({text: 'Combien de temps encore ?', reaction: true}), false);
  assert.equal(wantsTwin({text: 'watch out', reaction: true, lastLanguage: 'de'}), true);
  // The holder asks with its own last language and a hint (the microphone's) for a turn that has neither.
  const value = new MultilingualConversations();
  assert.equal(value.wantsTwin({text: '[Microphone]'}), false);
  assert.equal(value.wantsTwin({text: '[Microphone]', hint: 'fr'}), true);
  value.observe('Hola, ¿cómo estás?'); value.observe('Hola, ¿cómo estás?');
  assert.equal(value.wantsTwin({text: 'ok', hint: 'en'}), true, 'the conversation\'s language wins over the hint');
});

// ---- Twin map and routing --------------------------------------------------------------------------------------

const ordinaryIds = Object.fromEntries([...Object.keys(RELATIONSHIP_PROFILES), 'rogue-amendiares']
  .map(profile => [profile, profile + '-ordinary-id']));
const twinRow = (original, twin, extra = {}) => ({phase: 'verified', originalCharacterId: original, multilingualCharacterId: twin,
  verified: true, languageBoxOff: true, ...extra});
// What an old runtime/multilingual-profiles.json still holds: rows of the retired affectionate profiles. Nothing routes to them.
const romanticRows = () => Object.fromEntries(Object.keys(RELATIONSHIP_PROFILES).map(profile => [profile + '-romantic',
  twinRow(profile + '-romantic-id', profile + '-romantic-twin-id', {variant: 'romantic', baseKey: profile})]));
const twinDocument = () => ({version: 1, characters: {
  ...Object.fromEntries(Object.keys(ordinaryIds).map(profile => [profile, twinRow(ordinaryIds[profile], profile + '-twin-id')])),
  ...romanticRows(),
}});

test('only verified twins with the language box off that still clone the current profile are used', () => {
  const document = twinDocument();
  document.characters['rogue-amendiares'].languageBoxOff = false;
  document.characters['river-ward'].originalCharacterId = 'an-older-river-id';
  document.characters['unknown-character'] = twinRow('x', 'y');
  document.characters['panam-palmer'].multilingualCharacterId = ordinaryIds['judy-alvarez'];
  const {twins, skipped} = multilingualTwins(document, {ordinaryIds});
  assert.deepEqual(skipped.sort(), ['panam-palmer', 'river-ward', 'rogue-amendiares', 'unknown-character']);
  assert.deepEqual(Object.keys(twins).sort(), ['judy-alvarez', 'kerry-eurodyne', 'meredith-stout']);
  assert.equal(twins['judy-alvarez'], 'judy-alvarez-twin-id');
  assert.deepEqual(multilingualTwins(null, {ordinaryIds}), {twins: {}, skipped: []});
  assert.deepEqual(multilingualTwins({version: 2}, {ordinaryIds}).skipped, ['invalid-document']);
});

test('twin rows of the retired romantic profiles are ignored silently, and an old relationship-profiles.json cannot matter', () => {
  const rows = romanticRows();
  assert.deepEqual(Object.keys(rows).sort(), ['judy-alvarez-romantic', 'kerry-eurodyne-romantic', 'meredith-stout-romantic',
    'panam-palmer-romantic', 'river-ward-romantic']);
  // Whatever state the row is in (verified, unverified, box on, a former original ID, even a twin row of the twin), it is not used
  // and not reported as skipped: it is not a current profile at all.
  const document = {version: 1, characters: {...twinDocument().characters, 'judy-alvarez-romantic-multilingual': twinRow('a', 'b')}};
  document.characters['kerry-eurodyne-romantic'].verified = false;
  document.characters['river-ward-romantic'].languageBoxOff = false;
  document.characters['meredith-stout-romantic'].originalCharacterId = 'an-older-id';
  const {twins, skipped} = multilingualTwins(document, {ordinaryIds});
  assert.deepEqual(skipped, []);
  assert.deepEqual(Object.keys(twins).sort(), Object.keys(ordinaryIds).sort());
  for (const key of [...Object.keys(rows), 'judy-alvarez-romantic-multilingual']) assert.equal(Object.hasOwn(twins, key), false, key);
  for (const twinId of Object.values(twins)) assert.doesNotMatch(twinId, /romantic/);
  // Even with a legacy ordinaryIds map that still lists a romantic key (an old relationship-profiles.json merged in), the row is ignored.
  const legacyIds = {...ordinaryIds, 'judy-alvarez-romantic': 'judy-alvarez-romantic-id'};
  assert.deepEqual(multilingualTwins(document, {ordinaryIds: legacyIds}), {twins, skipped: []});
  // An unrelated argument (the old "variants" option) is not read: the result is identical.
  const oldVariants = {version: 1, characters: {'judy-alvarez': {ordinaryCharacterId: ordinaryIds['judy-alvarez'], romanticCharacterId: 'judy-alvarez-romantic-id'}}};
  assert.deepEqual(multilingualTwins(document, {ordinaryIds, variants: oldVariants}), {twins, skipped: []});
  // A document holding only retired rows yields nothing and complains about nothing.
  assert.deepEqual(multilingualTwins({version: 1, characters: rows}, {ordinaryIds}), {twins: {}, skipped: []});
  // The registry has no romantic provider keys either, and refuses a map that names one.
  const built = relationshipRegistry(ordinaryIds, twins);
  assert.deepEqual(Object.keys(built.providerIds).filter(key => /romantic/.test(key)), []);
  assert.throws(() => relationshipRegistry(ordinaryIds, {'judy-alvarez-romantic': 'judy-alvarez-romantic-twin-id'}), {code: 'INVALID_MULTILINGUAL_PROFILE'});
});

const twins = multilingualTwins(twinDocument(), {ordinaryIds}).twins;
const registry = relationshipRegistry(ordinaryIds, twins);
const NOW = Date.parse('2026-10-01T12:00:00Z'), boundary = {worldToken: 'world-a', generation: 4};
const fact = value => ({status: 'known', value, present: true, sourceId: 'native-quests-system', evidenceRefs: ['core-arcs.judy.committed']});
const snapshot = facts => parseRelationshipState({version: 1, status: 'ready', gameVersion: '2.31', ...boundary, capturedAt: NOW,
  facts: Object.fromEntries(Object.entries(facts).map(([name, value]) => [name, fact(value)]))});

test('the registry adds each twin as "<providerKey>-multilingual" in the original family with its own marker', () => {
  assert.equal(registry.providerIds['judy-alvarez-multilingual'], 'judy-alvarez-twin-id');
  for (const key of ['judy-alvarez', 'judy-alvarez-multilingual']) assert.equal(registry.providerFamilies[key], 'judy-alvarez', key);
  assert.equal(registry.markerKeys['judy-alvarez-multilingual'], 'judy-alvarez:multilingual');
  assert.equal(twinMarkerKey('rogue-amendiares'), 'rogue-amendiares:multilingual');
  assert.equal(registry.markerKeys['judy-alvarez'], undefined, 'originals keep their own marker');
  // One provider per character plus one twin: nothing else.
  assert.deepEqual(Object.keys(registry.providerIds).sort(), [...Object.keys(ordinaryIds), ...Object.keys(twins).map(key => key + '-multilingual')].sort());
  // Invalid maps fail loudly instead of routing to a wrong character.
  assert.throws(() => relationshipRegistry(ordinaryIds, {nobody: 'x'}), {code: 'INVALID_MULTILINGUAL_PROFILE'});
  assert.throws(() => relationshipRegistry(ordinaryIds, {'judy-alvarez': ordinaryIds['panam-palmer']}), {code: 'DUPLICATE_PROVIDER_ID'});
  assert.throws(() => relationshipRegistry(ordinaryIds, {'judy-alvarez-multilingual': 'z'}), {code: 'INVALID_MULTILINGUAL_PROFILE'});
  // No twin map: identical to the English-only registry.
  assert.deepEqual(relationshipRegistry(ordinaryIds).providerIds, relationshipRegistry(ordinaryIds, {}).providerIds);
  assert.deepEqual(relationshipRegistry(ordinaryIds).providerIds, ordinaryIds);
});

test('multilingual selection picks the twin of exactly the profile chosen; On, Off and Auto styles all use the same twin', () => {
  const select = (profileKey, mode, facts, multilingual) => selectRelationshipProfile({profileKey, mode, registry, boundary, now: NOW,
    snapshot: snapshot(facts), multilingual});
  const committed = {sq030_judy_lover: 1, sq030_11_romance: 1, sq030_romance: 1};
  // Romantic style by verified save facts: still the one twin.
  let chosen = select('judy-alvarez', 'auto', committed, true);
  assert.equal(chosen.providerProfileKey, 'judy-alvarez-multilingual'); assert.equal(chosen.style, 'romantic');
  assert.equal(chosen.characterId, 'judy-alvarez-twin-id'); assert.equal(chosen.multilingual, true);
  assert.equal(chosen.reason, 'verified-current-save');
  // Ordinary style when unconfirmed, explicit Off, or Off with confirmed facts: the same twin.
  chosen = select('judy-alvarez', 'auto', {}, true);
  assert.equal(chosen.providerProfileKey, 'judy-alvarez-multilingual'); assert.equal(chosen.style, 'ordinary');
  chosen = select('judy-alvarez', 'off', committed, true);
  assert.equal(chosen.providerProfileKey, 'judy-alvarez-multilingual'); assert.equal(chosen.style, 'ordinary');
  // Explicit On: romantic style, still the same twin (no romantic profile exists).
  chosen = select('panam-palmer', 'on', {}, true);
  assert.equal(chosen.providerProfileKey, 'panam-palmer-multilingual'); assert.equal(chosen.style, 'romantic');
  assert.equal(chosen.characterId, 'panam-palmer-twin-id');
  // Style never changes the provider: every mode and fact combination picks the same twin and the same original.
  for (const profile of Object.keys(RELATIONSHIP_PROFILES)) {
    for (const [mode, facts] of [['auto', {}], ['on', {}], ['off', {}], ['off', committed], ['auto', committed]]) {
      assert.equal(select(profile, mode, facts, true).providerProfileKey, profile + '-multilingual', profile + ' ' + mode);
      assert.equal(select(profile, mode, facts, true).characterId, profile + '-twin-id', profile + ' ' + mode);
      assert.equal(select(profile, mode, facts, false).providerProfileKey, profile, profile + ' ' + mode);
      assert.equal(select(profile, mode, facts, false).characterId, ordinaryIds[profile], profile + ' ' + mode);
    }
  }
  // Auto without any fresh capture is still ready (never blocked), ordinary style, on the twin.
  const unknown = selectRelationshipProfile({profileKey: 'judy-alvarez', mode: 'auto', registry, boundary, now: NOW, snapshot: null, multilingual: true});
  assert.equal(unknown.status, 'ready'); assert.equal(unknown.style, 'ordinary'); assert.equal(unknown.reason, 'relationship-state-unavailable');
  assert.equal(unknown.providerProfileKey, 'judy-alvarez-multilingual');
  // A character without relationships.
  chosen = select('rogue-amendiares', 'auto', {}, true);
  assert.equal(chosen.characterId, 'rogue-amendiares-twin-id'); assert.equal(chosen.style, 'ordinary');
  // Off: the originals, unchanged.
  chosen = select('judy-alvarez', 'auto', committed, false);
  assert.equal(chosen.providerProfileKey, 'judy-alvarez'); assert.equal(chosen.multilingual, false); assert.equal(chosen.style, 'romantic');
  assert.equal(chosen.characterId, 'judy-alvarez-ordinary-id');
  assert.equal(select('rogue-amendiares', 'auto', {}, false).providerProfileKey, 'rogue-amendiares');
  // A profile whose twin is missing keeps its original, whatever the style.
  const partial = relationshipRegistry(ordinaryIds, {'judy-alvarez': 'judy-alvarez-twin-id'});
  for (const profile of ['judy-alvarez', 'panam-palmer']) {
    const kept = selectRelationshipProfile({profileKey: profile, mode: 'on', registry: partial, boundary, now: NOW,
      snapshot: snapshot({}), multilingual: true});
    assert.equal(kept.providerProfileKey, profile === 'judy-alvarez' ? 'judy-alvarez-multilingual' : 'panam-palmer');
    assert.equal(kept.multilingual, profile === 'judy-alvarez'); assert.equal(kept.style, 'romantic');
  }
});

test('the twin is chosen per turn: a turn option picks it, no setting is read, nothing is retired, and guards accept both IDs', () => {
  const routes = new RelationshipRouting({ordinaryIds, multilingual: twins, now: () => NOW});
  const state = {version: 1, status: 'ready', gameVersion: '2.31', ...boundary, capturedAt: NOW, facts: {}};
  routes.update({}, state, {boundary});
  assert.equal(routes.select('rogue-amendiares', boundary).providerProfileKey, 'rogue-amendiares');
  assert.equal(routes.select('rogue-amendiares', boundary, {multilingual: false}).providerProfileKey, 'rogue-amendiares');
  const twin = routes.select('rogue-amendiares', boundary, {multilingual: true});
  assert.equal(twin.providerProfileKey, 'rogue-amendiares-multilingual'); assert.equal(twin.characterId, 'rogue-amendiares-twin-id');
  assert.equal(twin.multilingual, true);
  // The language of a turn never churns the routes: no change to publish, no connection to retire.
  assert.deepEqual(routes.consumeRouteChanges(), []);
  // A saved multilingualConversations from an old settings file is not read.
  assert.equal(routes.update({multilingualConversations: true}, state, {boundary}), false);
  assert.equal(routes.select('rogue-amendiares', boundary).providerProfileKey, 'rogue-amendiares');
  assert.deepEqual(routes.consumeRouteChanges(), []);
  // Guards: a twin ID belongs to the canonical character, and so does the original's; a guard on either is current.
  const guard = {characterId: 'rogue-amendiares-twin-id'};
  assert.equal(routes.providerKeyForGuard('rogue-amendiares', guard), 'rogue-amendiares-multilingual');
  assert.equal(routes.guardSelected('rogue-amendiares', guard, boundary), true);
  assert.equal(routes.guardSelected('rogue-amendiares', {characterId: 'rogue-amendiares-ordinary-id'}, boundary), true);
  assert.equal(routes.guardSelected('rogue-amendiares', {characterId: 'judy-alvarez-twin-id'}, boundary), false);
  assert.equal(routes.guardSelected('rogue-amendiares', {characterId: 'something-else'}, boundary), false);
  assert.throws(() => routes.providerKeyForGuard('judy-alvarez', guard), {code: 'CHARACTER_MISMATCH'});
  assert.equal(routes.describe(boundary).find(row => row.profileKey === 'judy-alvarez').multilingual, false);
  assert.equal(routes.markerKeys['judy-alvarez-multilingual'], 'judy-alvarez:multilingual');
  assert.equal(routes.providerIds['judy-alvarez-romantic'], undefined);
});

test('a relationship style change never changes the provider: no route change, no connection retirement; only the turn\'s own language picks the twin', () => {
  const routes = new RelationshipRouting({ordinaryIds, multilingual: twins, now: () => NOW});
  const state = {version: 1, status: 'ready', gameVersion: '2.31', ...boundary, capturedAt: NOW,
    facts: {sq030_judy_lover: fact(1), sq030_11_romance: fact(1), sq030_romance: fact(1)}};
  const modes = relationshipModes => ({relationshipModes});
  routes.update({}, {...state, facts: {}}, {boundary});
  routes.consumeRouteChanges();
  for (const multilingual of [false, true]) {
    routes.update({}, {...state, facts: {}}, {boundary});   // every character back to Auto
    routes.consumeRouteChanges();
    const providerOf = profile => routes.select(profile, boundary, {multilingual}).providerProfileKey;
    const before = providerOf('judy-alvarez');
    assert.equal(before, multilingual ? 'judy-alvarez-multilingual' : 'judy-alvarez');
    // Auto with no confirmed facts: ordinary. Auto with confirmed facts, On, Off: styles change, the route does not.
    assert.equal(routes.select('judy-alvarez', boundary, {multilingual}).style, 'ordinary');
    for (const [settings, snapshotState, style] of [
      [modes({'judy-alvarez': 'on'}), undefined, 'romantic'],
      [modes({'judy-alvarez': 'off'}), undefined, 'ordinary'],
      [modes({'judy-alvarez': 'auto'}), state, 'romantic'],
      [modes({'judy-alvarez': 'off'}), state, 'ordinary'],
      [modes({'judy-alvarez': 'auto'}), {...state, facts: {}}, 'ordinary'],
      [modes({'judy-alvarez': 'on', 'panam-palmer': 'on', 'river-ward': 'off'}), undefined, 'romantic'],
    ]) {
      assert.equal(routes.update(settings, snapshotState, {boundary}), false);
      assert.deepEqual(routes.consumeRouteChanges(), []);
      assert.equal(routes.select('judy-alvarez', boundary, {multilingual}).style, style);
      assert.equal(providerOf('judy-alvarez'), before);
    }
  }
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
  await talk(memory, 'judy-alvarez-multilingual');
  await talk(memory, 'rogue-amendiares-multilingual');
  assert.deepEqual(memory.status().characters.map(row => row.profileKey).sort(), ['judy-alvarez', 'rogue-amendiares']);
  assert.ok(!JSON.stringify(memory.status()).includes('multilingual'), 'status shows canonical characters only');
});

test('Forget for one character clears the original and its twin only; Forget all clears every twin', async t => {
  const {memory, calls} = await memoryFixture(t);
  const talked = ['judy-alvarez', 'judy-alvarez-multilingual', 'panam-palmer', 'panam-palmer-multilingual', 'rogue-amendiares-multilingual'];
  for (const key of talked) await talk(memory, key);
  // No romantic provider exists to talk to or to clear.
  assert.throws(() => memory.route('judy-alvarez-romantic'));
  // A command naming a twin's provider key is still the canonical family.
  const result = await memory.clearCharacter({profileKey: 'judy-alvarez-multilingual', actionId: 'forget-judy'});
  assert.equal(result.state, 'succeeded'); assert.equal(result.profileKey, 'judy-alvarez');
  const cleared = calls.filter(call => call.kind === 'clear').map(call => call.profileKey).sort();
  assert.deepEqual(cleared, ['judy-alvarez', 'judy-alvarez-multilingual'], 'another character and its twin are untouched');
  calls.length = 0;
  assert.equal((await memory.clearAll({actionId: 'forget-all'})).state, 'succeeded');
  const clearedAll = new Map(calls.filter(call => call.kind === 'clear').map(call => [call.profileKey, call.characterId]));
  for (const key of ['panam-palmer', 'panam-palmer-multilingual', 'rogue-amendiares-multilingual'])
    assert.equal(clearedAll.get(key), registry.providerIds[key], key);
  assert.equal(clearedAll.get('rogue-amendiares-multilingual'), 'rogue-amendiares-twin-id');
  assert.deepEqual([...clearedAll.keys()].filter(key => /romantic/.test(key)), []);
});

test('the Forget menu command for a character reaches its twin through the bridge family map', async t => {
  const {memory, calls} = await memoryFixture(t);
  await talk(memory, 'panam-palmer-multilingual');
  const directory = await fs.mkdtemp(join(tmpdir(), 'multilingual-control-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const commandPath = join(directory, 'memory-command.json');
  const control = await PlayerMemoryControl.open({memory, commandPath, publish: async () => {},
    chatResetFamilies: registry.providerFamilies});
  await fs.writeFile(commandPath, JSON.stringify({version: 1, id: 'forget-panam', action: 'clear', scope: 'character',
    profileKey: 'panam-palmer', issuedAt: Date.now()}));
  await control.poll(); await control.work;
  assert.deepEqual(calls.filter(call => call.kind === 'clear').map(call => call.characterId), ['panam-palmer-twin-id']);
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
  backstory['judy-alvarez-ordinary-id'] = 'Bio\n[CyberpunkConvai profile v2:judy-alvarez]';
  assert.equal((await clear('judy-alvarez-multilingual')).accepted, true);
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
const installed = ['multilingual-profiles.json', 'characters.json'].every(name => existsSync(new URL(name, runtime)));
test('the installed twin map covers every profiled character; old romantic rows are retired and ignored', {skip: !installed && 'runtime map absent'}, () => {
  const read = name => JSON.parse(readFileSync(new URL(name, runtime), 'utf8'));
  const ids = read('characters.json');
  const document = read('multilingual-profiles.json');
  // runtime/relationship-profiles.json (if still present) is no longer read: only the two files above feed the twin map.
  const {twins: loaded, skipped} = multilingualTwins(document, {ordinaryIds: ids});
  // Every profile has a verified twin, the generic NPC archetypes (npc-*) included (docs/NPC_ARCHETYPES.md). A twin is
  // routed once its language box is marked off; only a new archetype batch (npc-*) may still be waiting for that
  // web-session step. The 2026-10-18 cast expansion's boxes are all set, so none of those keys may be skipped.
  for (const key of skipped) assert.equal(document.characters[key]?.verified === true && document.characters[key].languageBoxOff !== true, true, key + ' is skipped');
  const twinned = Object.keys(ids);
  for (const key of twinned) {
    assert.equal(document.characters[key]?.verified, true, key + ' has no verified twin');
    assert.ok(loaded[key] || skipped.includes(key), key);
  }
  const unrouted = twinned.filter(key => !loaded[key]);
  assert.ok(unrouted.every(key => key.startsWith('npc-')), 'only a new archetype batch (npc-*) may wait for the language box: ' + unrouted.filter(key => !key.startsWith('npc-')));
  for (const key of CAST_EXPANSION_KEYS) assert.equal(document.characters[key]?.languageBoxOff, true, key + ' language box must be off');
  // Every profiled (relationship) character has its one twin routed.
  for (const key of Object.keys(RELATIONSHIP_PROFILES)) {
    assert.ok(Object.hasOwn(ids, key), key + ' is not in characters.json');
    assert.ok(loaded[key], key + ' twin');
  }
  // Old "<key>-romantic" rows may remain in the file; they are retired: not used, not reported, and the ID file has none.
  const retired = Object.keys(document.characters).filter(key => /-romantic(?:-multilingual)?$/.test(key));
  for (const key of retired) { assert.equal(Object.hasOwn(loaded, key), false, key); assert.equal(skipped.includes(key), false, key); }
  assert.deepEqual(Object.keys(ids).filter(key => /-romantic(?:-multilingual)?$/.test(key)), []);
  assert.deepEqual(Object.keys(loaded).sort(), Object.keys(loaded).filter(key => Object.hasOwn(ids, key)).sort());
  const routes = new RelationshipRouting({ordinaryIds: ids, multilingual: loaded});
  for (const key of twinned.filter(key => loaded[key])) assert.equal(routes.providerFamilies[key + '-multilingual'], key);
  assert.deepEqual(Object.keys(routes.providerIds).filter(key => /romantic/.test(key)), []);
});

// ---- Archetypes (npc-*) route to their twins like named characters -----------------------------------------------

const archetypeKeys = JSON.parse(readFileSync(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8')).map(row => row.key);
const archetypeIds = Object.fromEntries(archetypeKeys.map(profile => [profile, profile + '-original-id']));
const archetypeTwinDocument = () => ({version: 1, characters: Object.fromEntries(archetypeKeys
  .map(profile => [profile, twinRow(archetypeIds[profile], profile + '-twin-id')]))});

test('every archetype key and its twin key stay inside the profile-key limit used across the bridge', () => {
  assert.equal(archetypeKeys.length, 80);
  for (const profile of archetypeKeys) assert.match(profile + '-multilingual', /^[a-z0-9][a-z0-9-]{0,79}$/, profile);
});

test('archetype twins are loaded under the same rules as named twins', () => {
  const ids = {...ordinaryIds, ...archetypeIds};
  const document = {version: 1, characters: {...twinDocument().characters, ...archetypeTwinDocument().characters}};
  const loaded = multilingualTwins(document, {ordinaryIds: ids});
  assert.deepEqual(loaded.skipped, []);
  for (const profile of archetypeKeys) assert.equal(loaded.twins[profile], profile + '-twin-id', profile);
  // Not routed until the language box is off, still verified, and only while it clones today's original.
  document.characters['npc-ncpd-male'].languageBoxOff = false;
  document.characters['npc-mox-female'].verified = false;
  document.characters['npc-homeless-male'].originalCharacterId = 'an-older-id';
  assert.deepEqual(multilingualTwins(document, {ordinaryIds: ids}).skipped.sort(), ['npc-homeless-male', 'npc-mox-female', 'npc-ncpd-male']);
  // An archetype missing from the ID file has nothing to clone.
  const partial = {...ids}; delete partial['npc-ripperdoc-male'];
  assert.deepEqual(multilingualTwins(document, {ordinaryIds: partial}).skipped.includes('npc-ripperdoc-male'), true);
});

test('for a twin turn an archetype goes to its twin; otherwise to the original; the twin keeps the archetype family and marker', () => {
  const ids = {...ordinaryIds, ...archetypeIds};
  const archetypeTwins = multilingualTwins({version: 1, characters: {...twinDocument().characters, ...archetypeTwinDocument().characters}},
    {ordinaryIds: ids}).twins;
  const archetypeRegistry = relationshipRegistry(ids, archetypeTwins);
  const choose = (profileKey, multilingual) => selectRelationshipProfile({profileKey, mode: 'auto', registry: archetypeRegistry, boundary, now: NOW,
    snapshot: snapshot({}), multilingual});
  for (const profile of archetypeKeys) {
    const on = choose(profile, true), off = choose(profile, false);
    assert.equal(on.status, 'ready'); assert.equal(on.multilingual, true);
    assert.equal(on.providerProfileKey, profile + '-multilingual', profile);
    assert.equal(on.characterId, profile + '-twin-id'); assert.equal(on.style, 'ordinary');
    assert.equal(off.providerProfileKey, profile); assert.equal(off.characterId, archetypeIds[profile]); assert.equal(off.multilingual, false);
    assert.equal(archetypeRegistry.providerFamilies[profile + '-multilingual'], profile);
    assert.equal(archetypeRegistry.markerKeys[profile + '-multilingual'], profile + ':multilingual');
    assert.equal(archetypeRegistry.markerKeys[profile], undefined);
  }
  // A single missing twin keeps that archetype on its English original; the others still switch.
  const gap = {...archetypeTwins}; delete gap['npc-bartender-female'];
  const gapRegistry = relationshipRegistry(ids, gap);
  const route = (profileKey) => selectRelationshipProfile({profileKey, mode: 'auto', registry: gapRegistry, boundary, now: NOW, snapshot: snapshot({}), multilingual: true});
  assert.equal(route('npc-bartender-female').providerProfileKey, 'npc-bartender-female');
  assert.equal(route('npc-bartender-male').providerProfileKey, 'npc-bartender-male-multilingual');
});

test('a turn in another language reaches an archetype twin without retiring any route, and guards accept an archetype twin ID', () => {
  const ids = {...ordinaryIds, ...archetypeIds};
  const archetypeTwins = multilingualTwins({version: 1, characters: {...twinDocument().characters, ...archetypeTwinDocument().characters}},
    {ordinaryIds: ids}).twins;
  const routes = new RelationshipRouting({ordinaryIds: ids, multilingual: archetypeTwins, now: () => NOW});
  const state = {version: 1, status: 'ready', gameVersion: '2.31', ...boundary, capturedAt: NOW, facts: {}};
  routes.update({}, state, {boundary});
  assert.equal(routes.select('npc-maelstrom-male', boundary).providerProfileKey, 'npc-maelstrom-male');
  assert.equal(routes.select('npc-maelstrom-male', boundary, {multilingual: true}).providerProfileKey, 'npc-maelstrom-male-multilingual');
  assert.deepEqual(routes.consumeRouteChanges(), []);
  const guard = {characterId: 'npc-maelstrom-male-twin-id'};
  assert.equal(routes.providerKeyForGuard('npc-maelstrom-male', guard), 'npc-maelstrom-male-multilingual');
  assert.equal(routes.guardSelected('npc-maelstrom-male', guard, boundary), true);
  assert.equal(routes.guardSelected('npc-maelstrom-male', {characterId: 'npc-maelstrom-male-original-id'}, boundary), true);
  assert.throws(() => routes.providerKeyForGuard('npc-ncpd-male', guard), {code: 'CHARACTER_MISMATCH'});
});

test('an archetype twin has its own memory identity in the archetype family, and the provider adapter accepts only its marker', async t => {
  const ids = {...ordinaryIds, ...archetypeIds};
  const archetypeTwins = multilingualTwins({version: 1, characters: archetypeTwinDocument().characters}, {ordinaryIds: ids}).twins;
  const archetypeRegistry = relationshipRegistry(ids, archetypeTwins);
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
  assert.match(bridge, /new RelationshipRouting\(\{ordinaryIds: ids, multilingual: multilingualProfiles\.twins,\s*packTwins: addonContent\.convaiTwins\(/);
  // The retired alternate profiles are gone from the wiring: nothing reads relationship-profiles.json or passes variants.
  const code = bridge.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  assert.doesNotMatch(code, /relationship-profiles\.json|relationshipVariants|variants:/);
  assert.match(bridge, /markerKeys: relationshipRoutes\.markerKeys/);
  assert.match(bridge, /characterFamilies: relationshipRoutes\.providerFamilies/);
  assert.match(bridge, /chatResetFamilies: relationshipRoutes\.providerFamilies/);
  assert.match(bridge, /ttsEnabled: convaiSpeaks\(input\)/);
  assert.match(bridge, /const convaiSpeaks = input => localVoice\.playbackEnabled !== false && localVoice\.convaiVoiceAllowed && !turnUsesLocal\(input\)/);
  // No setting: the poll neither reads one nor forces one off, and the twin is chosen per turn from the message.
  assert.doesNotMatch(bridge, /multilingualConversations|multilingual\.update\(|setTextProvider/);
  assert.match(bridge, /selectProfile: \(profile, boundary, turn\) => relationshipRoutes\.select\(profile, boundary, \{multilingual: twinForTurn\(turn\)\}\)/);
  assert.match(bridge, /const twinForTurn = turn => !!turn && !keys\.singleSession && !mistral\.active && multilingual\.wantsTwin\(/);
  // Every per-turn voice check goes through the plan; only invitation readiness asks about the profile.
  const perTurn = bridge.slice(bridge.indexOf('async function synthesizeReply('), bridge.indexOf('async function pollMicrophone('));
  assert.doesNotMatch(perTurn, /usesProfile\(input\.profileKey\)|localVoice\.provider\s*===\s*'omni'\s*\)/);
});

test('the reply-language block names the player\'s language, last in the context, and says nothing in an English conversation', async () => {
  const {languageContext} = await import('./multilingual.mjs');
  // The in-game failure: a short Spanish greeting answered in English under the English context notes.
  assert.match(languageContext({text: 'hola, cómo estás'}), /latest message, which is Spanish\..*whole reply in Spanish/);
  assert.match(languageContext({text: 'こんにちは、ジュディ'}), /which is Japanese/);
  assert.match(languageContext({text: 'How are you?'}), /which is English/);
  // No player text (a reaction, the microphone placeholder): the language the player is using, with the last one.
  assert.match(languageContext({text: '[Microphone]', lastLanguage: 'de'}), /language the player is using with you \(so far German\)/);
  assert.match(languageContext({text: ''}), /language the player is using with you\. Everything else/);
  const setting = new MultilingualConversations();
  assert.equal(setting.contextFor('How are you?'), '', 'an English conversation sends the context it always did');
  assert.equal(setting.contextFor('hola, cómo estás'), '', 'a short line alone does not leave English');
  setting.observe('hola, cómo estás');
  assert.match(setting.contextFor('hola, cómo estás'), /which is Spanish/, 'the second in a row does');
  assert.match(new MultilingualConversations().contextFor('hola, cómo estás? vamos a la tienda, que tengo mucho que hacer'), /which is Spanish/, 'a long line at once');
  setting.observe('Hola, ¿cómo estás?');
  assert.match(setting.contextFor('[Microphone]'), /so far Spanish/);
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /block\('volatile', firstPersonReminder\(input\)\),(?:\s*\/\/[^\n]*\n)+\s*block\('volatile', multilingual\.contextFor\(input\.reaction \? '' : input\.text, input\.reaction \? null : speechLanguage\.evidence\?\.language\)\)\]/);
});

// ---- Text providers (Mistral, Local AI, Custom): the player's language, with no twins ---------------------------------------

test('a French message gets the French note on every route, with the same wording as the full language block', () => {
  const setting = new MultilingualConversations();
  const french = "Salut, ça va? Qu'est-ce que tu fais ce soir?";
  const note = setting.contextFor(french);
  assert.match(note, /latest message, which is French\..*whole reply in French/);
  assert.equal(note, textProviderLanguageContext({text: french}));
});

test('an English conversation adds nothing: the context stays what it always was', () => {
  const setting = new MultilingualConversations();
  for (const text of ['What do you need, choom?', 'Hey V, meet me at the Afterlife tonight.', '', '[Microphone]', 'ok', "Ay, chica, let's go"])
    assert.equal(setting.contextFor(text), '', JSON.stringify(text));
  setting.observe('Hey V, meet me at the Afterlife tonight.'); setting.observe('Nothing much, V. You?');
  assert.equal(setting.lastLanguage, 'en');
  assert.equal(setting.contextFor('[Microphone]'), '');
  assert.equal(setting.contextFor('Thanks, that helps.'), '');
});

test('the note follows the conversation: kept for a turn with no text, and English named again when the player switches back', () => {
  const setting = new MultilingualConversations();
  assert.equal(setting.observe('Hola, ¿cómo estás? Vamos a la tienda, que tengo mucho que hacer.'), true);
  assert.match(setting.contextFor('[Microphone]'), /language the player is using with you \(so far Spanish\)/);
  assert.match(setting.contextFor(''), /so far Spanish/, 'a reaction bark follows the conversation');
  assert.match(setting.contextFor('Thanks, that helps a lot.'), /so far Spanish/, 'a short English line does not move the conversation');
  assert.match(setting.contextFor('Thanks, that really helps me a lot today.'), /which is English/, 'back to English with a long line: said once, so the reply follows');
});

test('a short line in a supported language is called by the context block (the live finding of 2026-10-21: "Combien de temps encore ?" was answered in English)', () => {
  for (const [text, name] of [['Combien de temps encore ?', 'French'], ['Siamo quasi arrivati?', 'Italian'], ['No entiendo nada', 'Spanish'],
    ['Wie lange noch?', 'German'], ['Quanto custa isso?', 'Portuguese']])
    assert.match(textProviderLanguageContext({text}), new RegExp('which is ' + name), text);
  // Night City words and nicknames inside an English line do not change its language.
  for (const text of ['preem gig choom', 'hey hermano what\'s up', 'Afterlife tonight?', 'nova ride Delamain']) assert.equal(textProviderLanguageContext({text}), '', text);
});

test('a language known from an earlier launch (or the last recording) is the fallback for a recording', () => {
  const setting = new MultilingualConversations();
  assert.match(setting.contextFor('[Microphone]', 'fr'), /so far French/);
  assert.equal(setting.contextFor('[Microphone]', 'en'), '');
  assert.equal(setting.contextFor('[Microphone]', null), '');
  // The conversation's own language wins over the hint.
  setting.observe('Hola, ¿cómo estás? Vamos a la tienda, que tengo mucho que hacer.');
  assert.match(setting.contextFor('[Microphone]', 'fr'), /so far Spanish/);
});

test('textProviderLanguageContext is empty exactly where the conversation is English', () => {
  assert.equal(textProviderLanguageContext({text: 'How are you?'}), '');
  assert.equal(textProviderLanguageContext({text: 'How are you?', lastLanguage: 'en'}), '');
  assert.equal(textProviderLanguageContext({text: '[Microphone]', lastLanguage: 'en'}), '');
  assert.match(textProviderLanguageContext({text: 'Hallo, wie geht es dir heute Abend?'}), /which is German/);
  assert.match(textProviderLanguageContext({text: 'How are you?', lastLanguage: 'de'}), /which is English/);
});

test('a text provider speaks another language with OmniVoice, and shows it as text with Pocket or Voxtral (never loading another voice)', () => {
  const french = "Salut, ça va? Je n'ai rien à te dire ce soir.";
  const omniLocal = {uses: true, provider: 'omni'}, pocketLocal = {uses: true, provider: 'pocket'};
  // OmniVoice: spoken, with the reply's language.
  const omni = planTurnVoice({enabled: false, textProvider: true, language: 'fr', local: omniLocal});
  assert.deepEqual([omni.engine, omni.language], ['omni', 'fr']);
  assert.deepEqual(replyVoice({plan: omni, text: french, local: omniLocal}), {engine: 'omni', language: 'fr'});
  // Even when the player typed English and the reply came in French, OmniVoice is told.
  const english = planTurnVoice({enabled: false, textProvider: true, language: 'en', local: omniLocal});
  assert.deepEqual(replyVoice({plan: english, text: french, local: omniLocal}), {engine: 'omni', language: 'fr'});
  assert.deepEqual(replyVoice({plan: english, text: 'Nothing much, V. You?', local: omniLocal}), {engine: 'omni', language: 'en'});
  // Pocket (and Voxtral, which is Pocket's route): the plan keeps Pocket, the French reply has no voice, an English one is spoken as before.
  const pocket = planTurnVoice({enabled: false, textProvider: true, language: 'fr', local: pocketLocal});
  assert.equal(pocket.engine, 'pocket', 'no Convai cloud voice and no other model is chosen for it');
  assert.equal(replyVoice({plan: pocket, text: french, local: pocketLocal}).engine, 'none');
  assert.deepEqual(replyVoice({plan: pocket, text: 'Nothing much, V. You?', local: pocketLocal}), {engine: 'pocket', language: 'en'});
  const pocketEnglish = planTurnVoice({enabled: false, textProvider: true, language: 'en', local: pocketLocal});
  // An English conversation keeps the chosen voice whatever the reply looks like: the characters' Spanish slang is never muted, and a Voxtral
  // player is never moved to another voice.
  assert.deepEqual(replyVoice({plan: pocketEnglish, text: french, local: pocketLocal}), {engine: 'pocket', language: 'en'});
  assert.deepEqual(replyVoice({plan: pocketEnglish, text: 'Ay, chica, vámonos, hermano. Claro que sí.', local: pocketLocal}), {engine: 'pocket', language: 'en'});
  const voxtralLocal = {uses: true, provider: 'voxtral'};
  const voxtralEnglish = planTurnVoice({enabled: false, textProvider: true, language: 'en', local: voxtralLocal});
  assert.deepEqual(replyVoice({plan: voxtralEnglish, text: 'Nothing much, V. You?', local: voxtralLocal}), {engine: 'voxtral', language: 'en'});
  const voxtralFrench = planTurnVoice({enabled: false, textProvider: true, language: 'fr', local: voxtralLocal});
  assert.equal(replyVoice({plan: voxtralFrench, text: french, local: voxtralLocal}).engine, 'none');
  assert.deepEqual(replyVoice({plan: voxtralFrench, text: 'Nothing much, V. You?', local: voxtralLocal}), {engine: 'voxtral', language: 'en'});
  // A cloud voice that cannot speak (no key) stays the written reply it always was.
  assert.equal(planTurnVoice({enabled: false, textProvider: true, language: 'fr', local: {uses: false, provider: 'pocket', convai: true}}).engine, 'convai');
  assert.equal(planTurnVoice({enabled: false, textProvider: true, language: 'fr', local: {uses: false, provider: 'pocket'}}).engine, 'none', 'a local voice that cannot run is not the Convai voice');
  // Off and not a text provider: exactly the voice used before.
  assert.equal(planTurnVoice({enabled: false, language: 'fr', local: pocketLocal}).reason, 'multilingual-off');
});

test('Voxtral 3 speaks other languages: a text provider reply in a listed language is spoken by it, in an unlisted one shown as text, and English keeps the chosen voice untouched', () => {
  const french = "Salut, ça va? Je n'ai rien à te dire ce soir.";
  const czech = 'Dobrý den, jak se máte? Dnes večer nemám co říct, kamaráde.';
  // The bridge's shape: Voxtral runs on Pocket's route (provider 'pocket') and says so with cloud: 'voxtral'.
  const voxtral = (model = VOXTRAL_TTS_MODEL) => ({uses: true, provider: 'pocket', cloud: 'voxtral', speaks: language => voxtralSpeaks(language, model)});
  const local = voxtral();
  const fr = planTurnVoice({enabled: false, textProvider: true, language: 'fr', local});
  assert.deepEqual([fr.engine, fr.language, fr.reason], ['pocket', 'fr', 'voxtral']);
  assert.deepEqual(replyVoice({plan: fr, text: french, local}), {engine: 'pocket', language: 'fr'}, 'spoken, not shown as text');
  // The player wrote French and the reply came back in English: English keeps the voice.
  assert.deepEqual(replyVoice({plan: fr, text: 'Nothing much, V. You?', local}), {engine: 'pocket', language: 'en'});
  // The player wrote English: the chosen voice is untouched whatever the reply looks like (a Voxtral player is never moved).
  const en = planTurnVoice({enabled: false, textProvider: true, language: 'en', local});
  assert.deepEqual([en.engine, en.reason], ['pocket', 'english']);
  assert.deepEqual(replyVoice({plan: en, text: french, local}), {engine: 'pocket', language: 'en'});
  assert.deepEqual(replyVoice({plan: en, text: 'Nothing much, V. You?', local}), {engine: 'pocket', language: 'en'});
  // Czech is not one of the languages Mistral names: the plan keeps the voice and the finished reply is shown as text, for its own reason.
  const cs = planTurnVoice({enabled: false, textProvider: true, language: 'cs', local});
  assert.deepEqual([cs.engine, cs.reason], ['pocket', 'voice-language-unsupported']);
  assert.deepEqual(replyVoice({plan: cs, text: czech, local}), {engine: 'none', language: 'cs', reason: 'voice-language-unsupported'});
  // A reply in a listed language that the older model does not speak (Polish) is shown as text once the alias is the model.
  const polish = 'Cześć, jak się masz? Nie mam dziś wieczorem nic do powiedzenia, stary.';
  const alias = voxtral(VOXTRAL_TTS_FALLBACK_MODEL);
  assert.equal(planTurnVoice({enabled: false, textProvider: true, language: 'pl', local}).reason, 'voxtral');
  assert.equal(planTurnVoice({enabled: false, textProvider: true, language: 'pl', local: alias}).reason, 'voice-language-unsupported');
  assert.equal(replyVoice({plan: planTurnVoice({enabled: false, textProvider: true, language: 'pl', local}), text: polish, local: alias}).engine, 'none');
  // Pocket is unchanged: English only, the reply in another language is text, for the old reason.
  const pocket = {uses: true, provider: 'pocket', cloud: null, speaks: () => false};
  const pk = planTurnVoice({enabled: false, textProvider: true, language: 'fr', local: pocket});
  assert.deepEqual([pk.engine, pk.reason], ['pocket', 'english-only-voice']);
  assert.deepEqual(replyVoice({plan: pk, text: french, local: pocket}), {engine: 'none', language: 'fr', reason: 'english-only-voice'});
  // OmniVoice still wins where it is the voice; a key-less cloud voice (uses: false, and the Convai voice not chosen) is written, never the Convai voice.
  assert.equal(planTurnVoice({enabled: false, textProvider: true, language: 'fr', local: {uses: false, provider: 'pocket', cloud: 'voxtral', convai: false, speaks: () => true}}).engine, 'none');
  // Off and not a text provider: exactly the voice used before.
  assert.equal(planTurnVoice({enabled: false, language: 'fr', local}).reason, 'multilingual-off');
});

test('Multilingual conversations (the Convai twins) with the Voxtral voice: a listed language is spoken by it on Pocket\'s route, an unlisted one is written (never the Convai voice), Pocket still never speaks another language', () => {
  const french = "Salut, ça va? Je n'ai rien à te dire ce soir.";
  const czech = 'Dobrý den, jak se máte? Dnes večer nemám co říct, kamaráde.';
  const local = {uses: true, provider: 'pocket', cloud: 'voxtral', speaks: language => voxtralSpeaks(language)};
  const fr = planTurnVoice({enabled: true, language: 'fr', local});
  assert.deepEqual([fr.engine, fr.language, fr.reason], ['pocket', 'fr', 'voxtral']);
  assert.deepEqual(replyVoice({plan: fr, text: french, local}), {engine: 'pocket', language: 'fr'});
  assert.deepEqual(replyVoice({plan: fr, text: 'Nothing much, V. You?', local}), {engine: 'pocket', language: 'en'});
  const cs = planTurnVoice({enabled: true, language: 'cs', local});
  assert.deepEqual([cs.engine, cs.reason], ['none', 'voice-language-unsupported'], 'what Voxtral does not list is written, not given to the Convai voice');
  assert.deepEqual(replyVoice({plan: cs, text: czech, local}), {engine: 'none', language: 'cs', reason: 'voice-language-unsupported'});
  // A reply in an unlisted language that the turn did not expect is shown as text, never read by a voice that would garble it.
  assert.deepEqual(replyVoice({plan: fr, text: czech, local}), {engine: 'none', language: 'cs', reason: 'voice-language-unsupported'});
  const pocket = {uses: true, provider: 'pocket', cloud: null, speaks: () => false};
  assert.deepEqual(planTurnVoice({enabled: true, language: 'fr', local: pocket}), {engine: 'none', language: 'fr', reason: 'english-only-voice'}, 'Pocket never hands a turn to a cloud voice');
  assert.deepEqual(planTurnVoice({enabled: true, language: 'es', local: {uses: false, provider: 'pocket', cloud: 'voxtral', convai: false, speaks: () => true}}), {engine: 'none', language: 'es', reason: 'local-voice-unavailable'}, 'a Voxtral voice that cannot be asked is written');
  assert.deepEqual(planTurnVoice({enabled: true, language: 'en', local}), {engine: 'pocket', language: 'en', reason: 'english'});
  // A cloud voice is told no language (the API has none): the plan only decides who speaks.
  assert.equal(Object.hasOwn(fr, 'tag'), false);
});

test('the bridge tells the plan which cloud voice is chosen and which languages its model speaks, and V\'s voice asks the same', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /cloud: localVoice\.cloudActive \? localVoice\.cloud : null, speaks: language => voxtralVoice\.speaks\(language\)/);
  assert.match(bridge, /speaks: language => voxtralVoice\.speaks\(language\),/);
  const selection = readFileSync(new URL('./voice-selection.mjs', import.meta.url), 'utf8');
  // The voice selection no longer reads a Multilingual setting: Pocket stays in the fallback order, and a reply it cannot speak is shown as text.
  assert.doesNotMatch(selection, /multilingual/i);
});

test('one notice per game session says OmniVoice has voices in other languages', () => {
  const notice = new VoiceLanguageNotice();
  assert.equal(notice.take(), undefined, 'nothing to say before a reply was shown as text');
  notice.note(); notice.note();
  assert.equal(notice.take(), 'voice-language');
  assert.equal(notice.take(), undefined);
  notice.note();
  assert.equal(notice.take(), undefined, 'not again in the same session');
});

test('the bridge wires the text-provider language: note, voice plan, notice and the V line', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /planTurnVoice\(\{textProvider: true, fixed: multilingual\.fixed !== null, language: multilingual\.expected\(input\.reaction \? '' : input\.text\),/);
  assert.match(bridge, /\?\? voiceLanguageNotice\.take\(\)/);
  assert.match(bridge, /if \(!unavailable && !input\.reaction\) voiceLanguageNotice\.note\(\);/);
  assert.match(bridge, /planFor: \(input, key\) => \(\{engine: vVoice\.engine, language: multilingual\.lineLanguage\(input\.text\)\}\)/);
  // An add-on speaker's own remarks follow the conversation's last detected language (the player's, on any route).
  assert.match(bridge, /const language = multilingual\.contextFor\(input\.reaction \? '' : input\.text, speechLanguage\.evidence\?\.language \?\? null\);/);
  // A reply to a reaction (a bark) does not set the conversation's language.
  assert.match(bridge, /if \(!input\.reaction\) multilingual\.observeTurn\(input\.text, result\.text, speechLanguage\.evidence\?\.language \?\? null\);/);
  // The game side shows the notice.
  const game = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  assert.match(game, /reply\.keyNotice == 'voice-language'/);
});
