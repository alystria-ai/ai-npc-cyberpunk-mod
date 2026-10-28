import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {OMNI_TAGS, CJK_TAGS, omniTagsFor, stripSpeechTags, keepSpeechTags, displayText, hasSpeechTags, parseTagged, processReply} from './speech-tags.mjs';
import {RealtimeHost} from './realtime-host.mjs';
import {VoiceSelection} from './voice-selection.mjs';

// ---- tag stripping: subtitles, display, unsupported engines --------------------------------------------------

test('stripSpeechTags removes tags from display text and leaves text without a tag exactly as it was', () => {
  assert.equal(stripSpeechTags('Yeah, [laughter] I get it. [sigh] Let\'s go.'), 'Yeah, I get it. Let\'s go.');
  assert.equal(stripSpeechTags('[sigh] Okay, so.'), 'Okay, so.');
  assert.equal(stripSpeechTags('Okay, so. [sigh]'), 'Okay, so.');
  assert.equal(stripSpeechTags('Well[laughter]. Fine.'), 'Well. Fine.');
  assert.equal(stripSpeechTags('Hm[sigh], fine.'), 'Hm, fine.');
  assert.equal(stripSpeechTags('[Laughter] Mixed [SURPRISE-OH] case.'), 'Mixed case.');
  assert.equal(stripSpeechTags('[laughter][sigh] Both.'), 'Both.');
  assert.equal(stripSpeechTags('[laughter]'), '');
  // Text without a tag is returned as the same string, whitespace and all.
  const untouched = 'Line one.\nLine  two — "quoted"... [B EY1 S] and [A1] stay.';
  assert.equal(hasSpeechTags(untouched), false);
  assert.equal(stripSpeechTags(untouched), untouched);
  assert.equal(stripSpeechTags(undefined), undefined);
});

test('Pocket view: tags go, fillers, ellipses and dashes stay, and no stray punctuation or double space is left', () => {
  // One clone serves both engines; Pocket (and the subtitles) get this text.
  const cases = {
    'Well. [sigh] Fine.': 'Well. Fine.',
    'Uh... [laughter] okay — fine.': 'Uh... okay — fine.',
    'Hold on — [dissatisfaction-hnn] that was not the deal.': 'Hold on — that was not the deal.',
    'Yeah... [sigh]': 'Yeah...',
    'Sure [laughter] .': 'Sure.',
    '  Well,  [sigh]  fine.': 'Well, fine.',
    'Well... [sigh]. Fine.': 'Well... Fine.',
    'No. [laughter]!': 'No.',
    '[sigh], fine.': 'fine.',
    '[sigh]... fine.': 'fine.',
    '[sigh] — and then.': 'and then.',
    'Okay — [laughter] — sure.': 'Okay — sure.',
    'Right [sigh]... okay.': 'Right... okay.',
    'Hm... [confirmation-en] yeah.': 'Hm... yeah.',
    // A tag OmniVoice knows but the bridge does not voice is still never read out.
    'Fine [question-oh]?': 'Fine?',
    'I mean, [surprise-wa] wow.': 'I mean, wow.',
  };
  for (const [raw, pocket] of Object.entries(cases)) {
    const out = stripSpeechTags(raw);
    assert.equal(out, pocket, raw);
    const odd = [/[[\]]/, /\s{2}/, /^[\s,.;:!?—–-]/, /\.{4}/, /[.!?…][,;:!?]/, /\.!|!\./, /[—–] [—–]/].find(pattern => pattern.test(out));
    assert.equal(odd, undefined, `odd punctuation in ${JSON.stringify(out)}`);
  }
  // The display text a reply leaves the transport with is the same text; the tagged original stays for OmniVoice.
  const reply = processReply({text: 'Well... [sigh] fine. [laughter]', sessionID: 'pocket-view'});
  assert.equal(reply.text, 'Well... fine.');
  assert.equal(reply.speechText, 'Well... [sigh] fine. [laughter]');
});

test('streaming subtitles never show a half-written tag', () => {
  assert.equal(displayText('Yeah, [laugh', false), 'Yeah,');
  assert.equal(displayText('Yeah, [laughter] okay [si', false), 'Yeah, okay');
  assert.equal(displayText('Yeah, [laughter] okay', false), 'Yeah, okay');
  assert.equal(displayText('Yeah, [laughter] okay', true), 'Yeah, okay');
  assert.equal(displayText('Plain text, no tag.', false), 'Plain text, no tag.');
  assert.equal(displayText('Hm [', false), 'Hm');
});

test('keepSpeechTags lets an engine keep only the tags it renders', () => {
  assert.equal(keepSpeechTags('Yeah, [laughter] ok [question-ei] then [sigh].', OMNI_TAGS), 'Yeah, [laughter] ok then. [sigh]');
  assert.equal(keepSpeechTags('Yeah, [laughter] ok.', []), 'Yeah, ok.');
  assert.equal(keepSpeechTags('No tag here.', OMNI_TAGS), 'No tag here.');
  assert.equal(keepSpeechTags('[laughter] Hi.', ['laughter']), '[laughter] Hi.');
});

test('a plain reply passes through untouched, and a missing or tag-only one is left whole', () => {
  const plain = {text: 'Nothing special here.', sessionID: 'session-1'};
  assert.equal(processReply(plain), plain);
  assert.equal(parseTagged('a [x-y] b').display, 'a b');
});

// ---- where tags are removed in the bridge --------------------------------------------------------------------

test('a reply from Convai keeps its tags only in speechText: subtitles, memory and history see the clean text', () => {
  const result = processReply({text: 'Heh. [laughter] You really did that? [sigh] Okay.', sessionID: 's1', timing: {}});
  assert.equal(result.text, 'Heh. You really did that? Okay.');
  assert.equal(result.speechText, 'Heh. [laughter] You really did that? [sigh] Okay.');
  assert.equal(result.sessionID, 's1');
  // A reply that is only a tag has nothing to show: it is left whole rather than sent on empty.
  const alone = {text: '[laughter]', sessionID: 's2'};
  assert.equal(processReply(alone), alone);
  assert.equal(processReply({sessionID: 's3'}).text, undefined);
  assert.equal(processReply(undefined), undefined);
});

test('RealtimeHost hands every finished reply, text or microphone, to its transformReply', async () => {
  const seen = [];
  const host = new RealtimeHost({transformReply: result => { seen.push(result.text); return processReply(result); }});
  const lease = {value: {}, reused: true, release: async () => {}};
  Object.assign(host, {start: async () => {}, pool: {acquire: async () => lease, entries: new Map()},
    evaluateSpeech: async () => ({text: 'Okay [sigh] then.', sessionID: 'convai-session', timing: {}})});
  const reply = await host.reply({characterId: 'judy', scope: 'private', ttsEnabled: false});
  assert.equal(reply.text, 'Okay then.');
  assert.equal(reply.speechText, 'Okay [sigh] then.');
  assert.deepEqual(seen, ['Okay [sigh] then.']);
  // Without a transform the reply is exactly what the page returned.
  const plain = new RealtimeHost();
  Object.assign(plain, {start: async () => {}, pool: {acquire: async () => lease, entries: new Map()},
    evaluateSpeech: async () => ({text: 'Okay [sigh] then.', sessionID: 'x', timing: {}})});
  assert.equal((await plain.reply({characterId: 'judy', scope: 'private', ttsEnabled: false})).text, 'Okay [sigh] then.');
});

// ---- engines that cannot render a tag never receive it -------------------------------------------------------

function engines() {
  const calls = [];
  const voices = {'johnny-silverhand': {reference: 'runtime/voice-references/johnny.wav', sha256: 'a'.repeat(64), transcript: 'Original line.'}};
  const worker = backend => (config, {onState}) => {
    let loaded = false;
    return {backend, steps: 32, get loaded() { return loaded; },
      hasProfile: key => Object.hasOwn(config.voices, key), profileReady(key) { return loaded && this.hasProfile(key); },
      setSteps() {}, async start() { loaded = true; onState({state: 'ready', resident: true}); },
      async prepareProfile(profile) { return {provider: backend, ready: true, profile}; },
      async synthesize(profile, text) { calls.push([backend, text]); return {}; },
      async synthesizeStream(profile, text) { calls.push([backend, text]); return {}; },
      async close() { loaded = false; onState({state: 'stopped', resident: false}); }};
  };
  const runtime = Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)]));
  const settings = {version: 1, provider: 'pocket', engine: 'pocket-tts', voices, runtime,
    model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
      inputIdentity: 'e'.repeat(64), selectedStep: 1500}};
  const voice = new VoiceSelection(settings, {factory: worker('pocket'), omniFactory: worker('omni'),
    omniConfig: {version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 32, voices}});
  return {voice, calls};
}

test('Pocket never receives a tag, even one that slipped through, and OmniVoice receives only the tags it renders', async () => {
  const {voice, calls} = engines();
  await voice.start();
  assert.equal(voice.provider, 'pocket');
  await voice.synthesizeStream('johnny-silverhand', 'Heh. [laughter] Fine. [sigh]', {onPcm() {}});
  await voice.synthesizeStream('johnny-silverhand', 'Nothing to strip, really.', {onPcm() {}});
  assert.deepEqual(calls, [['pocket', 'Heh. Fine.'], ['pocket', 'Nothing to strip, really.']]);
  calls.length = 0;
  voice.request({voiceProvider: 'omni', omniSteps: 16}); voice.applyWhenIdle(false); await voice.start();
  assert.equal(voice.provider, 'omni');
  await voice.synthesize('johnny-silverhand', 'Heh. [laughter] Fine [question-ei] [sigh].');
  assert.deepEqual(calls, [['omni', 'Heh. [laughter] Fine. [sigh]']]);
  await voice.close();
});

// ---- the bridge and the subtitles use these in the right places ----------------------------------------------

test('the bridge cleans every finished reply with processReply, and the subtitles strip stray tags', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /import \{processReply\} from '\.\/speech-tags\.mjs'/);
  assert.match(bridge, /const cleanReply = result => expressiveEmotions\.process\(processReply\(result\)\)/);
  assert.equal(bridge.match(/transformReply: cleanReply/g).length, 4, 'text hosts: conversation, phone, Mistral and add-on speakers');
  const subtitles = readFileSync(new URL('../mod/subtitles.lua', import.meta.url), 'utf8');
  assert.match(subtitles, /text:gsub\('%s\*%\[%a\[%a%-\]\*%\]', ''\)/);
});


test('the OmniVoice list has the two new English question sounds, and the Chinese/Japanese ones are separate', () => {
  assert.ok(OMNI_TAGS.includes('question-ah') && OMNI_TAGS.includes('question-oh'));
  assert.deepEqual([...CJK_TAGS].sort(), ['question-ei', 'question-yi', 'surprise-wa', 'surprise-yo']);
  for (const tag of CJK_TAGS) assert.ok(!OMNI_TAGS.includes(tag), `${tag} is not an English tag`);
  assert.equal(omniTagsFor(undefined), OMNI_TAGS);
  assert.equal(omniTagsFor('en'), OMNI_TAGS);
  assert.equal(omniTagsFor('es'), OMNI_TAGS);
  for (const language of ['zh', 'ja']) assert.deepEqual(omniTagsFor(language), [...OMNI_TAGS, ...CJK_TAGS]);
});

test('a Chinese or Japanese sound is kept only on a Chinese or Japanese reply and is otherwise treated like an unknown tag', () => {
  const raw = 'Yeah. [surprise-wa] Okay then, [question-ei] fine. [laughter]';
  assert.equal(stripSpeechTags(raw), 'Yeah. Okay then, fine.', 'every display text drops them all');
  assert.equal(keepSpeechTags(raw, omniTagsFor('en')), 'Yeah. Okay then, fine. [laughter]');
  assert.equal(keepSpeechTags(raw, omniTagsFor('ja')), raw);
  assert.ok(!/surprise-wa|question-ei/.test(keepSpeechTags(raw, omniTagsFor('es'))));
  assert.match(keepSpeechTags(raw, omniTagsFor('zh')), /\[surprise-wa\]/);
});

test('a tag is always its own word and never splits one', () => {
  // However the model glued a tag to a word, the display text keeps the words on both sides whole.
  assert.equal(stripSpeechTags('Wel[sigh]l fine.'), 'Wel l fine.');
  assert.equal(stripSpeechTags('Well [sigh]fine.'), 'Well fine.');
});
