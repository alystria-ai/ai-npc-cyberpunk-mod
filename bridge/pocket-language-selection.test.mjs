// The Pocket voice in another language through the voice selection (bridge/voice-selection.mjs): what the Pocket client is asked for a reply in a language that has a
// Pocket model and a voice pack, the player's own clip, the voice the pack lacks, a model the worker refuses, the warm-up, and the English path untouched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {VoiceLanguagePacks} from './voice-language-packs.mjs';
import {PocketLanguageModels} from './pocket-language-models.mjs';
import {FAKE_VOICES, sha256, writePack} from './fixtures/voice-language-pack.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';
import {describeVoiceRoute, formatVoiceRoute} from './voice-routing-log.mjs';

const FRENCH = {...Object.fromEntries(Object.entries(FAKE_VOICES).map(([key, row]) => [key, {...row, text: `Texte de ${key}.`}]))};
async function setup(run, {modelLanguages = ['fr'], packLanguages = ['fr'], player = false} = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'pocket-language-selection-'));
  try {
    for (const language of packLanguages) await writePack(root, {language, languageTag: {fr: 'fr', de: 'de', 'es-es': 'es'}[language], voices: FRENCH, withHash: true});
    for (const language of modelLanguages) {
      const directory = resolve(root, 'multilingual-pocket', language);
      await mkdir(directory, {recursive: true});
      const sizes = {'model.safetensors': 40, 'tokenizer.json': 7, 'inference.yaml': 9, 'NOTICE.txt': 3};
      for (const [name, size] of Object.entries(sizes)) await writeFile(resolve(directory, name), Buffer.alloc(size, 2));
      await writeFile(resolve(directory, 'pocket-model.json'), JSON.stringify({version: 1, kind: 'pocket-language-model', language, languageTag: {fr: 'fr', de: 'de', 'es-es': 'es'}[language],
        pocketLanguage: 'x', built: '2026-10-22', pocketSource: '3.3.0', layers: 6,
        files: Object.fromEntries(Object.entries(sizes).map(([name, bytes]) => [name, {bytes, sha256: sha256(Buffer.from(name))}]))}));
    }
    const packs = new VoiceLanguagePacks({roots: [root]});
    await packs.scan();
    const models = new PocketLanguageModels({roots: [root], packs});
    await models.scan();
    const calls = [], warmed = [], englishWarmed = [];
    const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(key => [key, {reference: `runtime/voice-references/${key}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.'}]));
    voices['panam-palmer'] = player
      ? {reference: 'runtime/player-voices/panam-palmer.wav', sha256: 'e'.repeat(64), transcript: 'The player words.'}
      : {reference: 'runtime/voice-references/panam-palmer.wav', sha256: 'f'.repeat(64), transcript: 'English words.'};
    let refuse = null, resident = null;
    const unprepared = new Set();
    const factory = (config, {onState}) => {
      let loaded = false;
      return {get loaded() { return loaded; }, hasProfile: key => Object.hasOwn(config.voices, key), profileReady: key => loaded && Object.hasOwn(config.voices, key) && !unprepared.has(key),
        get residentLanguage() { return resident; },
        async prepareProfile(key, options) { englishWarmed.push({key, options}); return {provider: 'pocket', ready: true, profile: key}; },
        async prepareLanguage(profile, pocketLanguage, options) { warmed.push({profile, pocketLanguage, options}); return {provider: 'pocket', ready: true, profile}; },
        async start() { loaded = true; onState({state: 'ready', resident: true}); },
        async synthesizeStream(profile, text, options) {
          calls.push({profile, text, options});
          if (refuse && options.pocketLanguage) throw Object.assign(Error(refuse), {refused: true});
          return {audio: 'pcm'};
        },
        async close() { loaded = false; onState({state: 'stopped'}); }};
    };
    const settings = {version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
      runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
      model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64), inputIdentity: 'e'.repeat(64), selectedStep: 1500}};
    const voice = new VoiceSelection(settings, {languagePacks: packs, pocketLanguages: models, factory});
    voice.update({voiceProvider: 'pocket'}, null, false);
    await voice.start();
    await run({voice, calls, warmed, englishWarmed, models, packs, root, refuse: value => { refuse = value; }, resident: value => { resident = value; }, unprepared});
    await voice.close();
  } finally { await rm(root, {recursive: true, force: true}); }
}

test('a reply in a language with a Pocket model and a voice pack: the worker is given the model, its hashes and the pack clip of this character', async () => setup(async ({voice, calls, models, packs}) => {
  await voice.synthesizeStream('panam-palmer', 'Salut, ça fait longtemps.', {onPcm() {}, language: 'fr'});
  const {pocketLanguage} = calls.at(-1).options;
  assert.equal(pocketLanguage.tag, 'fr');
  assert.equal(pocketLanguage.folder, 'fr');
  assert.deepEqual(pocketLanguage.expected, models.model('fr').expected);
  const entry = packs.entry('fr', 'panam-palmer');
  assert.deepEqual(pocketLanguage.voices['panam-palmer'], {reference: 'runtime/voice-references/multilingual/fr/picked/panam-palmer.wav', sha256: sha256(await readFile(entry.path)), transcript: 'Texte de panam-palmer.'});
  assert.equal(calls.at(-1).text, 'Salut, ça fait longtemps.');
}));

test('English, and a language without a model, are exactly what they were: no language description reaches the worker', async () => setup(async ({voice, calls}) => {
  await voice.synthesizeStream('panam-palmer', 'Hello.', {onPcm() {}});
  await voice.synthesizeStream('panam-palmer', 'Hello.', {onPcm() {}, language: 'en'});
  await voice.synthesizeStream('panam-palmer', 'Hola.', {onPcm() {}, language: 'es'});
  assert.deepEqual(calls.map(call => call.options.pocketLanguage), [undefined, undefined, undefined]);
}));

test('the model is installed but this character has no clip in the pack: the English student never reads foreign text', async () => setup(async ({voice, calls}) => {
  await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Salut.', {onPcm() {}, language: 'fr'}), /no voice of this character/);
  assert.equal(calls.length, 0);
}));

test('the model is installed but the voice pack is not: nothing is asked of the worker for a reply in that language', async () => setup(async ({voice, calls, models}) => {
  assert.equal(models.packMissing('de'), true);
  await assert.rejects(voice.synthesizeStream('panam-palmer', 'Hallo.', {onPcm() {}, language: 'de'}), /no voice of this character/);
  assert.equal(calls.length, 0, 'the bridge plans such a reply as text; if one arrived, the English student does not read German');
}, {modelLanguages: ['de'], packLanguages: []}));

test('the player\'s own clip for the character is the voice, in any language', async () => setup(async ({voice, calls}) => {
  await voice.synthesizeStream('panam-palmer', 'Salut.', {onPcm() {}, language: 'fr'});
  assert.deepEqual(calls.at(-1).options.pocketLanguage.voices['panam-palmer'], {reference: 'runtime/player-voices/panam-palmer.wav', sha256: 'e'.repeat(64), transcript: 'The player words.'});
}, {player: true}));

test('a model the worker refuses is not asked for again until its files change', async () => setup(async ({voice, calls, models, refuse}) => {
  refuse('PocketTTS model could not be loaded (ValueError: asset differs)');
  await assert.rejects(voice.synthesizeStream('panam-palmer', 'Salut.', {onPcm() {}, language: 'fr'}), /could not be loaded/);
  assert.equal(models.speaks('fr'), false);
  assert.equal(models.report().models[0].usable, false);
  const before = calls.length;
  await voice.synthesizeStream('panam-palmer', 'Salut.', {onPcm() {}, language: 'fr'});
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).options.pocketLanguage, undefined, 'not offered the refused model');
}));

test('warming: the language model is swapped in ahead of the reply, only with a model, a pack and a clip, and never starts the worker', async () => setup(async ({voice, warmed}) => {
  assert.ok(await voice.warmPocketLanguage('panam-palmer', 'fr'));
  assert.equal(warmed.length, 1);
  assert.equal(warmed[0].pocketLanguage.folder, 'fr');
  assert.equal(warmed[0].options.urgent, true, 'a reply waits for the turn-start swap');
  assert.equal(await voice.warmPocketLanguage('judy-alvarez', 'fr'), null, 'no clip in the pack');
  assert.equal(await voice.warmPocketLanguage('panam-palmer', 'de'), null, 'no model');
  assert.equal(await voice.warmPocketLanguage('panam-palmer', 'en'), null);
  assert.equal(warmed.length, 1);
}));

test('a warm-up while a language is resident prepares the voice in that language, and a character with no clip in its pack falls back to the English warm-up', async () => setup(async ({voice, warmed, englishWarmed, resident, unprepared}) => {
  unprepared.add('panam-palmer'); unprepared.add('judy-alvarez');
  await voice.prepareProfile('panam-palmer');
  assert.equal(warmed.length, 0); assert.equal(englishWarmed.length, 1, 'no language resident: the English voice is warmed as before');
  resident('fr');
  const receipt = await voice.prepareProfile('panam-palmer', {required: true});
  assert.equal(warmed.length, 1); assert.equal(englishWarmed.length, 1, 'no English warm-up, so no model swapped out for it');
  assert.equal(warmed[0].pocketLanguage.tag, 'fr'); assert.equal(warmed[0].options.urgent, undefined, 'a warm-up ahead of time stays below normal');
  assert.equal(receipt.ready, true); assert.equal(receipt.profile, 'panam-palmer'); assert.equal(receipt.provider, 'pocket');
  await voice.prepareProfile('judy-alvarez', {required: true});
  assert.equal(warmed.length, 1); assert.equal(englishWarmed.length, 2); assert.equal(englishWarmed[1].options.required, true);
}));

test('the routing line names the PocketTTS model and the pack clip it cloned from', () => {
  const registry = {profiles: {'panam-palmer': {reference: 'runtime/voice-references/panam-palmer.wav'}}};
  const voice = {requestedProvider: 'pocket', provider: 'pocket', resolvedProvider: 'pocket', registries: {pocket: registry}, configuredByBackend: {pocket: true}, cloudActive: false};
  const record = describeVoiceRoute({voice, input: {profileKey: 'panam-palmer'}, profile: {key: 'panam-palmer', name: 'Panam'}, plan: {engine: 'pocket', language: 'fr'},
    reply: {engine: 'pocket', language: 'fr'}, voiceKey: 'panam-palmer', languageSet: 'multilingual/fr/picked/panam-palmer', pocketModel: {language: 'fr'}, now: () => 0});
  assert.equal(record.used, 'Pocket (PocketTTS model)');
  assert.deepEqual(record.reference, {set: 'multilingual/fr/picked/panam-palmer'});
  assert.equal(record.model, 'multilingual-pocket/fr');
  const line = formatVoiceRoute(record);
  assert.match(line, /used="Pocket \(PocketTTS model\)" ref="multilingual\/fr\/picked\/panam-palmer" model=multilingual-pocket\/fr/);
  assert.match(line, /lang=fr/);
  const english = formatVoiceRoute(describeVoiceRoute({voice, input: {profileKey: 'panam-palmer'}, profile: {key: 'panam-palmer', name: 'Panam'}, plan: {engine: 'pocket', language: 'en'},
    reply: {engine: 'pocket', language: 'en'}, voiceKey: 'panam-palmer', now: () => 0}));
  assert.equal(/model=/.test(english), false);
  assert.match(english, /used="Pocket"/);
  const none = describeVoiceRoute({voice, input: {profileKey: 'panam-palmer'}, profile: {key: 'panam-palmer'}, plan: {engine: 'pocket', language: 'de', reason: 'pocket-language-pack-missing'},
    reply: {engine: 'none', language: 'de', reason: 'pocket-language-pack-missing'}, now: () => 0});
  assert.match(none.fallback, /PocketTTS model for this language is installed but its multilingual pack is not/);
});

// ---- the bridge's wiring and the support report ------------------------------------------------------------------------------------------

import {readFileSync} from 'node:fs';
import {pocketLanguageModelsSection} from './support-report.mjs';
const bridgeSource = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');

test('the bridge finds the models in the folder the Pocket worker reads, looks again with the settings poll, and gives the selection and the plan the same facts', () => {
  assert.match(bridgeSource, /const pocketLanguages = new PocketLanguageModels\(\{roots: \[voiceConfig\.runtime\?\.referenceDirectory\], packs: languagePacks,/);
  assert.match(bridgeSource, /await pocketLanguages\.scan\(\)/);
  assert.match(bridgeSource, /void pocketLanguages\.refresh\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(bridgeSource, /voxtral:voxtralVoice,languagePacks,pocketLanguages,/);
  assert.match(bridgeSource, /pocket: \{speaks: language => pocketLanguages\.speaks\(language\), packMissing: language => pocketLanguages\.packMissing\(language\)\}/);
  assert.match(bridgeSource, /voiceLanguagePacks: languagePacks\.report\(\), pocketLanguageModels: pocketLanguages\.report\(\)/);
});

test('a reply written because the voice pack is missing says so once per language, with the language in the reply\'s notice fields; the generic notice is not used for it', () => {
  assert.match(bridgeSource, /const pocketLanguageNotice = new PocketLanguageNotice\(\);/);
  assert.match(bridgeSource, /\?\? \(pocketNotice = pocketLanguageNotice\.take\(\)\)\?\.keyNotice(?:;|\s)/);
  assert.match(bridgeSource, /keyNotice === 'pocket-language-pack' \? \{keyNoticeLanguage: pocketNotice\.keyNoticeLanguage\}/);
  assert.match(bridgeSource, /if \(voice\.reason === 'pocket-language-pack-missing'\) \{ if \(!input\.reaction\) pocketLanguageNotice\.note\(voice\.language\); \}\s+else if \(!unavailable && !input\.reaction\) voiceLanguageNotice\.note\(\);/);
});

test('the game maps the notice to a sentence in the menu language, with the language name translated, for each of the five languages', () => {
  const lua = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8'), notices = readFileSync(new URL('../mod/notices.lua', import.meta.url), 'utf8');
  assert.match(lua, /reply\.keyNotice == 'pocket-language-pack'/);
  assert.match(lua, /ui\.t\('\{language\} replies show as text: the \{language\} multilingual pack is missing\.', \{language = language\}\)/);
  for (const tag of ['fr', 'it', 'de', 'es', 'pt']) {
    assert.ok(lua.includes(`keyId == 'pocket-pack-${tag}' then convaiNotices.send(player, 'pocket-pack-${tag}', keyText)`), tag);
    assert.ok(notices.includes(`['pocket-pack-${tag}'] = {class = PLAYER, repeatS = 86400}`), tag);
  }
  for (const name of ['French', 'Italian', 'German', 'Spanish', 'Portuguese']) assert.ok(lua.includes(`ui.t('${name}')`), name);
});

test('the support report lists the models (language, size, whether the pack is installed, whether Pocket may speak it) and why an installed one is not used, with no path', () => {
  const section = pocketLanguageModelsSection({scannedAt: '2026-10-22T10:00:00.000Z',
    models: [{language: 'fr', tag: 'fr', version: '2026-10-22', megabytes: 219, packInstalled: true, usable: true, directory: 'C:/secret/place'},
      {language: 'de', tag: 'de', version: '2026-10-22', megabytes: 219, packInstalled: false, usable: false, refused: 'a file differs'}],
    problems: [{language: 'it', reason: 'model.safetensors: 3 bytes, expected 5'}]});
  assert.deepEqual(section.installed, [{language: 'fr', megabytes: 219, version: '2026-10-22', voicePackInstalled: true, usable: true},
    {language: 'de', megabytes: 219, version: '2026-10-22', voicePackInstalled: false, usable: false, refused: 'a file differs'}]);
  assert.deepEqual(section.problems, [{language: 'it', reason: 'model.safetensors: 3 bytes, expected 5'}]);
  assert.equal(JSON.stringify(section).includes('secret'), false);
  assert.equal(pocketLanguageModelsSection(undefined), null);
});

test('a reference kept only for a V voice mod is not sent to the Pocket worker as a language voice (it refuses paths outside the pack and the player folder); the player\'s own clip still is', async () => {
  await setup(async ({voice}) => {
    assert.ok((await voice.pocketLanguageFor('panam-palmer', 'fr'))?.voices['panam-palmer'].reference.includes('multilingual/fr/'), 'no mod: the pack clip');
    voice.keepsReference = key => key === 'panam-palmer';
    assert.equal(await voice.pocketLanguageFor('panam-palmer', 'fr'), null, 'a mod\'s reference: the English student speaks, no refused language command');
  });
  await setup(async ({voice}) => {
    voice.keepsReference = () => true;
    assert.equal((await voice.pocketLanguageFor('panam-palmer', 'fr')).voices['panam-palmer'].reference, 'runtime/player-voices/panam-palmer.wav');
  }, {player: true});
});
