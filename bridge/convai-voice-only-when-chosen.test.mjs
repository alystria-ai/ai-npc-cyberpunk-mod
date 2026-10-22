// Owner rule 2026-10-21: the Convai cloud voice speaks ONLY when the player chose it as their voice. Nothing switches to it on its own: not a local
// voice that failed (bridge/voice-selection.mjs, 2026-10-21 morning), and not the Voxtral cloud voice when it fails, has no key, is cooling down
// from a refused key or a limit, or is handed a reply in a language it does not speak (this file). Those replies are written, the game says so once,
// and the voice comes back by itself. The Convai TEXT turn of such a player carries ttsEnabled false.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {TEXT_ROUTE, VoiceSelection} from './voice-selection.mjs';
import {planTurnVoice, replyVoice} from './multilingual.mjs';
import {voxtralSpeaks} from './voxtral-languages.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';

const bridgeSource = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const selectionSource = readFileSync(new URL('./voice-selection.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const PROFILE = 'judy-alvarez';
const pocketSettings = () => ({version: 1, provider: 'pocket', engine: 'pocket-tts',
  voices: Object.fromEntries(LOCAL_VOICE_KEYS.map(name => [name, {reference: `runtime/voice-references/${name}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.'}])),
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64), inputIdentity: 'e'.repeat(64), selectedStep: 1500}});

// The part of VoxtralVoice the voice selection reads, with the key, the readiness and the languages as a test sets them.
function cloudStub({key = true, ready = true} = {}) {
  const cloud = {hasKey: key, degraded: null, spoke: 0, fellBack: 0, onChange() {}, setReferences() {}, replaceReferences() {},
    speaks: language => voxtralSpeaks(language), hasReference: () => true, reference: async () => ({}), log() {}};
  Object.defineProperty(cloud, 'ready', {get: () => ready && cloud.hasKey, enumerable: true});
  return cloud;
}
// A Pocket worker that is never asked to start in these tests (the routing is what is under test), unless a test starts it.
function selectionOf({cloud = cloudStub(), extra = {}} = {}) {
  return new VoiceSelection(pocketSettings(), {voxtral: cloud, ...extra,
    factory: (config, {onState}) => { let loaded = false; return {get loaded() { return loaded; }, hasProfile: name => Object.hasOwn(config.voices, name), profileReady: name => loaded,
      async prepareProfile(name) { return {provider: 'pocket', ready: true, profile: name}; }, async start() { loaded = true; onState({state: 'ready', resident: true}); },
      async synthesizeStream() { return {audio: 'pocket'}; }, async close() { loaded = false; onState({state: 'stopped'}); }}; }});
}

// The bridge's own composition (bridge/convai-bridge.mjs localChoice), pinned to the source below so this test cannot drift from it.
const localChoice = (voice, profile) => ({uses: voice.usesProfile(profile) && !voice.cloudKeyless, provider: voice.provider, convai: voice.convaiVoiceAllowed,
  cloud: voice.cloudActive ? voice.cloud : null, speaks: language => voxtralSpeaks(language)});
test('the bridge composes the turn voice from the voice selection exactly as this file does, and Convai TTS follows the Convai voice only', () => {
  assert.ok(bridgeSource.includes("const localChoice = profile => ({uses: localVoice.usesProfile(profile) && !localVoice.cloudKeyless, provider: localVoice.provider, convai: localVoice.convaiVoiceAllowed,\n  cloud: localVoice.cloudActive ? localVoice.cloud : null, speaks: language => voxtralVoice.speaks(language),\n  pocket: {speaks: language => pocketLanguages.speaks(language), packMissing: language => pocketLanguages.packMissing(language)}});"));
  assert.ok(bridgeSource.includes('const convaiSpeaks = input => localVoice.playbackEnabled !== false && localVoice.convaiVoiceAllowed && !turnUsesLocal(input);'));
  // Every Convai text turn: the live turn, the first connection of a character and the warm connections ask the same question.
  assert.ok(bridgeSource.includes('ttsEnabled: convaiSpeaks(input),'));
  assert.ok(bridgeSource.includes('? false : convaiSpeaks(prepared.input)};'));
  assert.ok(bridgeSource.includes('const warmUsesConvaiVoice = profile => localVoice.playbackEnabled !== false && localVoice.convaiVoiceAllowed && planTurnVoice({textProvider: true,'));
  // The turn is Convai-spoken only when the plan says so; a settings file that is missing or has no voice is Pocket (the shipped default), never Convai.
  assert.ok(bridgeSource.includes("const turnUsesLocal = input => turnVoice(input).engine !== 'convai';"));
  assert.ok(selectionSource.includes("this.provider = this.requestedProvider = 'pocket';"));
  assert.ok(selectionSource.includes('get convaiVoiceAllowed(){return this.provider===\'convai\';}'));
  assert.ok(selectionSource.includes('return found||TEXT_ROUTE;'));
  assert.doesNotMatch(selectionSource, /cloudWanted\?'convai'/);
});

// ---- every state a chosen non-Convai voice can be in; the Convai voice never speaks in any of them -----------------------------------------------
const SCENARIOS = {
  'Pocket chosen, healthy': () => { const v = selectionOf(); v.update({voiceProvider: 'pocket'}, null, false); return v; },
  'Pocket chosen, failed': () => { const v = selectionOf(); v.update({voiceProvider: 'pocket'}, null, false); v.failedBackends.add('pocket'); v.update({voiceProvider: 'pocket'}, null, false); return v; },
  'OmniVoice chosen, cannot run': () => { const v = selectionOf(); v.update({voiceProvider: 'omni'}, null, false); return v; },
  'OmniVoice chosen, failed': () => { const v = selectionOf(); v.update({voiceProvider: 'omni'}, null, false); v.failedBackends.add('omni'); v.update({voiceProvider: 'omni'}, null, false); return v; },
  'no voice setting at all': () => { const v = selectionOf(); v.update({}, null, false); return v; },
  'a settings file that is not an object': () => { const v = selectionOf(); v.update(undefined, null, false); return v; },
  'an unknown voice name': () => { const v = selectionOf(); v.update({voiceProvider: 'not-a-voice'}, null, false); return v; },
  'an installation with no voice configuration, Pocket chosen': () => { const v = new VoiceSelection({}); v.update({voiceProvider: 'pocket'}, null, false); return v; },
  'Voxtral chosen, healthy': () => { const v = selectionOf(); v.update({voiceProvider: 'voxtral'}, null, false); return v; },
  'Voxtral chosen, no key': () => { const v = selectionOf({cloud: cloudStub({key: false})}); v.update({voiceProvider: 'voxtral'}, null, false); return v; },
  'Voxtral chosen, a limit or a refused key cooling down': () => { const v = selectionOf({cloud: cloudStub({ready: false})}); v.update({voiceProvider: 'voxtral'}, null, false); return v; },
  'Voxtral chosen, Pocket failed earlier': () => { const v = selectionOf(); v.failedBackends.add('pocket'); v.update({voiceProvider: 'voxtral'}, null, false); return v; },
  'Voxtral chosen, no voice route to ride on': () => { const v = new VoiceSelection({}, {voxtral: cloudStub()}); v.update({voiceProvider: 'voxtral'}, null, false); return v; },
  'Voxtral chosen, barred by Mature content': () => { const v = selectionOf({extra: {cloudBarred: () => true}}); v.update({voiceProvider: 'voxtral'}, null, false); return v; },
};
const LANGUAGES = ['en', 'es', 'fr', 'ja', 'cs', 'ar'];
const TEXTS = {en: 'Sure thing, V. Let us talk it over.', es: 'Claro que sí, V. Vamos al bar esta noche y hablamos con calma.', cs: 'Dobrý den, jak se máte? Dnes večer nemám co říct, kamaráde.'};

test('with any chosen voice other than Convai, no turn uses the Convai voice: not when Voxtral fails, has no key, is cooling down or gets a language it does not speak, and whatever the provider or language', async () => {
  for (const [name, make] of Object.entries(SCENARIOS)) {
    const voice = make();
    assert.notEqual(voice.provider, 'convai', name);
    assert.notEqual(voice.resolvedProvider, 'convai', name);
    assert.equal(voice.convaiVoiceAllowed, false, name);
    assert.notEqual(voice.requestedProvider, 'convai', name);
    const local = localChoice(voice, PROFILE);
    for (const language of LANGUAGES) {
      // textProvider: Mistral, Local AI and Custom turns. enabled: the Convai twin planning. Neither: the plain plan.
      for (const options of [{textProvider: true}, {enabled: true}, {enabled: true, textProvider: true}, {}]) {
        const plan = planTurnVoice({...options, language, local});
        assert.notEqual(plan.engine, 'convai', `${name} / ${language} / ${JSON.stringify(options)}`);
        for (const text of Object.values(TEXTS)) {
          const spoken = replyVoice({plan, text, local});
          assert.notEqual(spoken.engine, 'convai', `${name} / ${language} / ${JSON.stringify(options)} / reply`);
        }
        // The Convai text turn of this player asks for no Convai audio (convaiSpeaks in the bridge).
        const convaiSpeaks = voice.playbackEnabled !== false && voice.convaiVoiceAllowed && plan.engine === 'convai';
        assert.equal(convaiSpeaks, false, `${name} / ${language}: ttsEnabled must be false`);
      }
    }
    // A character the installation has no voice for, or no clip for, is written: the receipt says text, never convai.
    const receipt = await voice.prepareProfile('a-character-without-a-clip');
    assert.equal(receipt.ready, true, name);
    assert.equal(receipt.provider, TEXT_ROUTE, name);
    await voice.close();
  }
});

test('a Voxtral voice that cannot be asked, or is given a language it does not speak, writes the reply (reason and notice kept); it never reaches Convai', () => {
  const healthy = SCENARIOS['Voxtral chosen, healthy']();
  const speaking = localChoice(healthy, PROFILE);
  assert.equal(speaking.uses, true); assert.equal(speaking.cloud, 'voxtral');
  // A listed language is spoken by Voxtral; an unlisted one is written with the voice-language reason (the one-time voice-language notice); English stays.
  assert.deepEqual(planTurnVoice({textProvider: true, language: 'es', local: speaking}).engine, 'pocket');
  const unlisted = planTurnVoice({enabled: true, language: 'cs', local: speaking});
  assert.deepEqual([unlisted.engine, unlisted.reason], ['none', 'voice-language-unsupported']);
  assert.deepEqual(replyVoice({plan: unlisted, text: TEXTS.cs, local: speaking}), {engine: 'none', language: 'cs', reason: 'voice-language-unsupported'});
  const textTurn = planTurnVoice({textProvider: true, language: 'cs', local: speaking});
  assert.deepEqual(replyVoice({plan: textTurn, text: TEXTS.cs, local: speaking}), {engine: 'none', language: 'cs', reason: 'voice-language-unsupported'});
  assert.equal(planTurnVoice({enabled: true, language: 'en', local: speaking}).engine, 'pocket');
  // No key: the turn is written (the local-voice-unavailable reason), and the game is told once ("... is unavailable right now. Replies show as text until it is back.").
  const keyless = SCENARIOS['Voxtral chosen, no key']();
  assert.equal(keyless.cloudKeyless, true);
  assert.deepEqual(keyless.cloudFallback, {from: 'voxtral', to: TEXT_ROUTE, temporary: false, reason: 'no-key'});
  const plan = planTurnVoice({textProvider: true, language: 'en', local: localChoice(keyless, PROFILE)});
  assert.deepEqual([plan.engine, plan.reason], ['none', 'local-voice-unavailable']);
  // A limit cooling down is the same, and comes back by itself.
  const cooling = SCENARIOS['Voxtral chosen, a limit or a refused key cooling down']();
  assert.equal(planTurnVoice({textProvider: true, language: 'en', local: localChoice(cooling, PROFILE)}).engine, 'none');
  // The old hand-over is gone in the plan itself: even a caller that says "the Convai voice is allowed" for a character no voice speaks (a Voxtral voice that is
  // not usable) cannot get it unless it is the chosen voice, because convai is what the voice selection reports, and that is only the chosen Convai voice.
  assert.equal(planTurnVoice({enabled: true, language: 'cs', local: {uses: true, provider: 'pocket', cloud: 'voxtral', convai: false, speaks: voxtralSpeaks}}).engine, 'none');
});

test('the Convai voice speaks exactly when the player chose it, with or without a voice setting being rewritten', async () => {
  const chosen = selectionOf();
  chosen.update({voiceProvider: 'convai'}, null, false);
  assert.equal(chosen.provider, 'convai'); assert.equal(chosen.convaiVoiceAllowed, true);
  const local = localChoice(chosen, PROFILE);
  for (const language of ['en', 'es', 'ja']) {
    for (const options of [{textProvider: true}, {enabled: true}, {}]) assert.equal(planTurnVoice({...options, language, local}).engine, 'convai', `${language} ${JSON.stringify(options)}`);
  }
  assert.equal(replyVoice({plan: planTurnVoice({textProvider: true, language: 'en', local}), text: TEXTS.en, local}).engine, 'convai');
  assert.equal((await chosen.prepareProfile(PROFILE)).provider, 'convai');
  // Leaving the Convai voice leaves nothing of it behind.
  chosen.update({voiceProvider: 'voxtral'}, null, false);
  assert.equal(chosen.convaiVoiceAllowed, false); assert.notEqual(chosen.provider, 'convai');
  await chosen.close();
  // No plan is no voice.
  assert.equal(replyVoice({text: TEXTS.en, local}).engine, 'none');
});

test('the shipped default is Pocket TTS, with or without a saved voice, whatever the conversation provider', () => {
  const lua = readFileSync(new URL('../mod/manager.lua', import.meta.url), 'utf8');
  assert.match(lua, /local DEFAULT_VOICE_PROVIDER, DEFAULT_OMNI_STEPS, DEFAULT_OMNI_REFERENCE = 'pocket', 16, 'long'/);
  const fresh = selectionOf();
  assert.equal(fresh.requestedProvider, 'pocket'); assert.equal(fresh.provider, 'pocket'); assert.equal(fresh.convaiVoiceAllowed, false);
  fresh.update({conversationProvider: 'convai'}, null, false);
  assert.equal(fresh.provider, 'pocket', 'Convai as the text provider does not make its voice the default');
  return fresh.close();
});
