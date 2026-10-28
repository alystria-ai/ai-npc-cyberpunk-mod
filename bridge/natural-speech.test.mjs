import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {NaturalSpeech, OMNI_TAGS, CJK_TAGS, PLACES, omniTagsFor, splitsWord, OFFER_RATE, OFFER_RATE_BY_PROFILE, MAX_VOICED_TAGS, naturalSpeechContext, stripSpeechTags, keepSpeechTags, displayText,
  hasSpeechTags, parseTagged, speechPhrases, devicesUsed, PITY_TURNS} from './natural-speech.mjs';
import {talkLine} from './natural-speech-talk.mjs';
import {splitSpeechText} from './speech-phrases.mjs';
import {createOmniPcmVoice, OMNI_RATE} from './omni-pcm.mjs';
import {encodePcmWav} from './convai-audio-stream.mjs';
import {RealtimeHost} from './realtime-host.mjs';
import {VoiceSelection} from './voice-selection.mjs';

// ---- the setting: off by default ---------------------------------------------------------------------------

test('Natural speech is off by default: no block is sent for any engine and nothing is recorded', () => {
  const speech = new NaturalSpeech();
  assert.equal(speech.enabled, false);
  for (const engine of ['omni', 'pocket', 'convai', undefined]) assert.equal(speech.contextFor({engine, spoken: true}), '');
  speech.record('session-1', 'Well... maybe.');
  assert.equal(speech.last.size, 0);
  // A reply passes through untouched except that a tag never reaches the display text.
  const plain = {text: 'Nothing special here.', sessionID: 'session-1'};
  assert.equal(speech.process(plain), plain);
  assert.equal(speech.update(undefined), false, 'a missing or unreadable settings file leaves it as it was');
  assert.equal(speech.update({voice: true}), false);
  assert.equal(speech.update({naturalSpeech: 'yes'}), false, 'only an explicit true turns it on');
  assert.equal(speech.enabled, false);
});

test('the setting follows runtime/settings.json and a change is reported once', () => {
  const speech = new NaturalSpeech();
  assert.equal(speech.update({naturalSpeech: true}), true);
  assert.equal(speech.update({naturalSpeech: true}), false);
  assert.equal(speech.enabled, true);
  speech.record('s', 'Well... maybe.');
  assert.equal(speech.update(undefined), false, 'a transient unreadable file does not switch it off');
  assert.equal(speech.enabled, true);
  assert.equal(speech.update({naturalSpeech: false}), true);
  assert.equal(speech.enabled, false);
  assert.equal(speech.last.size, 0, 'turning it off forgets what was used');
});

// ---- the dynamic context per engine ------------------------------------------------------------------------

test('the OmniVoice block lists its tags and pauses and tells the character to choose by personality, once at most, without a pattern', () => {
  const text = naturalSpeechContext({engine: 'omni'});
  for (const tag of OMNI_TAGS) assert.ok(text.includes(`[${tag}]`), `[${tag}] is offered`);
  for (const phrase of ['"..."', '" — "', 'hm', 'uh', 'I mean']) assert.ok(text.includes(phrase), phrase);
  // The model chooses: at most one, only if it fits, never a pattern, never repeated, by personality, even with no samples.
  for (const phrase of ['ONE human touch may fit', 'at most one in this reply', 'if not, use none', 'predictable pattern',
    'previous replies', 'where the feeling lands', 'do not make it a habit to open a reply with one',
    'vary where from reply to reply', 'at a natural break',
    'Never split a tight phrase', 'never more than one "..." in a reply',
    'who you are', 'personality', 'even if your sample dialogue contains no such sounds',
    'fluent, confident speaker rarely hesitates', 'cold, controlled or formal person rarely laughs',
    'When in doubt, use nothing', 'not a stage direction', 'removed from the subtitles']) assert.ok(text.includes(phrase), phrase);
  assert.ok(!text.includes('Pocket'));
});

test('the Pocket block offers punctuation only: no tags, no spelled sounds, and still rare, personal and never repeated', () => {
  const text = naturalSpeechContext({engine: 'pocket'});
  for (const tag of OMNI_TAGS) assert.ok(!text.includes(`[${tag}]`) || /never write tags such as \[laughter\] or \[sigh\]/.test(text), tag);
  // The only bracketed names are the two in the prohibition.
  assert.deepEqual([...text.matchAll(/\[([a-z-]+)\]/g)].map(match => match[1]), ['laughter', 'sigh']);
  for (const phrase of ['ONE natural pause may fit', 'Pocket TTS', 'never write tags', 'would read any bracketed tag',
    'ordinary punctuation', '("—")', '("...")', 'real pause', 'at most one in this reply', 'if not, speak plainly',
    'previous replies', 'predictable pattern', 'personality', 'not as a habit at the start', 'Choose by who you are',
    'When in doubt, use none']) assert.ok(text.includes(phrase), phrase);
  assert.ok(!text.includes('OmniVoice') && !text.includes('confirmation-en'));
});

test('no block for the Convai cloud voice or an unknown engine, and the previous reply\'s devices are not offered again', () => {
  assert.equal(naturalSpeechContext({engine: 'convai'}), '');
  assert.equal(naturalSpeechContext({engine: 'something'}), '');
  assert.equal(naturalSpeechContext({}), '');
  const omni = naturalSpeechContext({engine: 'omni', recent: ['laughter', 'ellipsis']});
  assert.ok(omni.endsWith('Your previous reply already used [laughter], an ellipsis ("..."): do not use those in this reply.'), omni);
  // A device the engine cannot render is never mentioned, even if an older reply happened to contain it.
  const pocket = naturalSpeechContext({engine: 'pocket', recent: ['laughter', 'filler', 'dash']});
  assert.ok(pocket.endsWith('Your previous reply already used a dash ("—"): do not use it in this reply.'), pocket);
  assert.equal(naturalSpeechContext({engine: 'pocket', recent: ['laughter']}), naturalSpeechContext({engine: 'pocket'}));
});

const ALWAYS = () => 0, NEVER = () => .999;

test('contextFor gates on the setting, spoken turns and the engine, and remembers each conversation\'s last reply', () => {
  const speech = new NaturalSpeech();
  speech.update({naturalSpeech: true});
  const ask = (options = {}) => speech.contextFor({engine: 'omni', spoken: true, random: ALWAYS, ...options});
  assert.equal(speech.contextFor({engine: 'omni', spoken: false, random: ALWAYS}), '', 'phone chat, reactions and silent playback');
  assert.equal(speech.contextFor({engine: 'convai', spoken: true, random: ALWAYS}), '');
  assert.equal(ask({sessionId: 'a'}), naturalSpeechContext({engine: 'omni', place: 'mid'}));
  // Pocket (punctuation only) is offered the same way; never straight after an OFFERED turn.
  assert.equal(speech.contextFor({engine: 'pocket', spoken: true, sessionId: 'q', random: ALWAYS}), naturalSpeechContext({engine: 'pocket'}));
  assert.equal(speech.contextFor({engine: 'pocket', spoken: true, sessionId: 'q', random: ALWAYS}), '', 'straight after an offered turn');
  assert.equal(speech.contextFor({engine: 'pocket', spoken: true, sessionId: 'q', random: NEVER}), '');
  // A voiced sound tag in the last reply blocks the next offer; so does the offer itself ('a' was just offered).
  speech.process({text: 'Heh [laughter] well... fine.', sessionID: 'a'});
  assert.equal(ask({sessionId: 'a'}), '');
  assert.equal(ask({sessionId: 'b'}), naturalSpeechContext({engine: 'omni', place: 'mid'}), 'another conversation is unaffected');
  speech.process({text: 'A plain reply.', sessionID: 'a'});
  assert.equal(ask({sessionId: 'a'}), naturalSpeechContext({engine: 'omni', place: 'mid'}));
  for (let n = 0; n < 100; n++) speech.record(`s${n}`, 'Hm.');
  assert.ok(speech.last.size <= 64, 'bounded');
  for (let n = 0; n < 100; n++) ask({sessionId: `t${n}`});
  assert.ok(speech.offerState.size <= 64, 'bounded');
});

test('only an offered turn or a voiced sound tag blocks the next offer: ordinary fillers, ellipses and dashes do not', () => {
  const speech = new NaturalSpeech();
  speech.update({naturalSpeech: true});
  let count = 0;
  const turn = (sessionId, random, trait = 'warm') => speech.contextFor({engine: 'omni', spoken: true, sessionId, trait, random, turn: `${sessionId}-${++count}`});
  for (const reply of ['Hm, okay.', 'Well... maybe.', 'It is blocked — both are watched.', 'Hm... well — I mean, yes.']) {
    const id = 'plain-' + reply;
    assert.ok(turn(id, ALWAYS), 'offered');
    speech.process({text: 'No device.', sessionID: id});
    assert.equal(turn(id, ALWAYS), '', 'straight after an offered turn');
    speech.process({text: reply, sessionID: id});    // an un-offered turn whose reply has its own filler / pause
    assert.ok(turn(id, ALWAYS), `not blocked by: ${reply}`);
  }
  // A voiced sound tag in the last reply does block (no sound tag twice in a row), whatever the dice say.
  speech.process({text: 'Hey [sigh] okay.', sessionID: 'tag'});
  assert.equal(turn('tag', ALWAYS), '');
  speech.process({text: 'Fine.', sessionID: 'tag'});
  assert.ok(turn('tag', ALWAYS));
  // Reasons are kept for the log line.
  speech.contextFor({engine: 'omni', spoken: true, sessionId: 'why', turn: 'w1', random: ALWAYS});
  speech.contextFor({engine: 'omni', spoken: true, sessionId: 'why', turn: 'w2', random: ALWAYS});
  speech.process({text: 'Plain.', sessionID: 'why'});
  speech.contextFor({engine: 'omni', spoken: true, sessionId: 'why', turn: 'w3', random: NEVER});
  assert.deepEqual(['w1', 'w2', 'w3'].map(id => speech.reasonFor(id)), ['rate', 'after-device', 'rate']);
  assert.equal(speech.reasonFor('never-asked'), undefined);
});

test('a warm or neutral character is offered the devices at least once in any four spoken turns; a dry or cold one is not forced', () => {
  assert.equal(PITY_TURNS, 4);
  const speech = new NaturalSpeech();
  speech.update({naturalSpeech: true});
  const run = (trait, count = 60) => {
    const flags = [];
    for (let n = 0; n < count; n++) {
      flags.push(speech.contextFor({engine: 'omni', spoken: true, sessionId: trait, trait, random: NEVER, turn: `${trait}-${n}`}) !== '');
      speech.process({text: 'A plain reply.', sessionID: trait});
    }
    return flags;
  };
  for (const trait of ['warm', 'neutral']) {
    const flags = run(trait);
    for (let n = 0; n + 4 <= flags.length; n++) assert.ok(flags.slice(n, n + 4).includes(true), `${trait} window at ${n}`);
    for (let n = 1; n < flags.length; n++) assert.ok(!(flags[n] && flags[n - 1]), 'never two offered turns in a row');
    assert.equal(speech.reasonFor(`${trait}-3`), 'pity', 'forced by the pity counter, not the dice');
  }
  for (const trait of ['dry', 'cold']) assert.ok(!run(trait).includes(true), `${trait} depends on the dice alone`);
  // Even when a sound tag was the last thing said, the pity counter still gets its offer.
  speech.process({text: 'Oh [laughter] fine.', sessionID: 'late'});
  let last;
  for (let n = 0; n < 4; n++) {
    last = speech.contextFor({engine: 'omni', spoken: true, sessionId: 'late', trait: 'warm', random: NEVER, turn: `late-${n}`});
    speech.process({text: 'Plain.', sessionID: 'late'});
  }
  assert.ok(last, 'pity outranks the tag block');
});

test('The devices are offered on a share of turns that follows how expressive the character is, decided once per turn', () => {
  assert.ok(OFFER_RATE.warm > OFFER_RATE.neutral && OFFER_RATE.neutral > OFFER_RATE.dry && OFFER_RATE.dry > OFFER_RATE.cold);
  assert.ok(OFFER_RATE.warm >= .55 && OFFER_RATE.cold <= .2, 'clearly audible for warm characters, still rare for cold ones');
  const speech = new NaturalSpeech();
  speech.update({naturalSpeech: true});
  // A seeded generator and a conversation of ordinary replies: the turn after an offered one never offers, so the share of
  // offered turns is rate / (1 + rate) from the dice alone (the pity counter raises it a little for warm and neutral).
  let state = 12345;
  const random = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const share = trait => {
    let offered = 0;
    for (let turn = 0; turn < 2000; turn++) {
      if (speech.contextFor({engine: 'omni', spoken: true, sessionId: trait, turn: `${trait}-${turn}`, trait, random})) offered++;
      speech.process({text: 'Well... hm, a plain reply — yes.', sessionID: trait});   // its own pauses and fillers block nothing
    }
    return offered / 2000;
  };
  const expected = {warm: .6 / 1.6, neutral: .5 / 1.5, dry: .35 / 1.35, cold: .15 / 1.15};
  const shares = {};
  for (const trait of Object.keys(OFFER_RATE)) {
    shares[trait] = share(trait);
    assert.ok(Math.abs(shares[trait] - expected[trait]) < .05, `${trait} ${shares[trait]}`);
  }
  assert.ok(shares.warm > .33 && shares.neutral > .3 && shares.cold < .16, JSON.stringify(shares));
  // One decision per turn: a context rebuilt for the same request agrees with the one already sent.
  const first = speech.contextFor({engine: 'omni', spoken: true, turn: 'same', trait: 'warm', random: ALWAYS});
  assert.ok(first);
  assert.equal(speech.contextFor({engine: 'omni', spoken: true, turn: 'same', trait: 'warm', random: NEVER}), first);
  assert.equal(speech.contextFor({engine: 'omni', spoken: true, turn: 'other', trait: 'warm', random: NEVER}), '');
  // An unknown trait is treated as neutral; Pocket follows the same shares.
  assert.ok(speech.contextFor({engine: 'omni', spoken: true, trait: 'mystery', random: () => OFFER_RATE.neutral - .01}));
  assert.equal(speech.contextFor({engine: 'omni', spoken: true, trait: 'mystery', random: () => OFFER_RATE.neutral + .01}), '');
  assert.ok(speech.contextFor({engine: 'pocket', spoken: true, trait: 'warm', random: () => OFFER_RATE.warm - .01}));
  assert.equal(speech.contextFor({engine: 'pocket', spoken: true, trait: 'cold', random: () => OFFER_RATE.cold + .01}), '');
  assert.equal(speech.decisions.size <= 64, true, 'bounded');
});

test('a reply carries the devices it used for the per-turn log line, only while the setting is on', () => {
  const speech = new NaturalSpeech();
  assert.equal(speech.process({text: 'Well... [sigh] fine.', sessionID: 'x'}).naturalDevices, undefined);
  speech.update({naturalSpeech: true});
  assert.deepEqual(speech.process({text: 'Well... [sigh] fine.', sessionID: 'x'}).naturalDevices.sort(), ['ellipsis', 'sigh']);
  assert.deepEqual(speech.process({text: 'A plain reply.', sessionID: 'x'}).naturalDevices, []);
  assert.deepEqual(speech.process({text: '{joy} Hello. [laughter]', sessionID: 'x'}).naturalDevices, ['laughter']);
});

test('devicesUsed names the tags, pauses and fillers a reply contained', () => {
  assert.deepEqual(devicesUsed('Hm, okay [sigh] so... that — is it. [Laughter]').sort(), ['dash', 'ellipsis', 'filler', 'laughter', 'sigh']);
  assert.deepEqual(devicesUsed('A perfectly plain sentence, with commas.'), []);
  assert.deepEqual(devicesUsed('Wait… what?'), ['ellipsis']);
  assert.deepEqual(devicesUsed('I mean, sure.'), ['filler']);
  assert.deepEqual(devicesUsed('Mum made the humming thing.'), [], 'words that merely contain a filler are not fillers');
  assert.deepEqual(devicesUsed(undefined), []);
});

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
  // One clone serves both engines; Pocket (and the subtitles) get this text (docs/NATURAL_SPEECH_CLONES.md).
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
  const speech = new NaturalSpeech();
  speech.update({naturalSpeech: true});
  const reply = speech.process({text: 'Well... [sigh] fine. [laughter]', sessionID: 'pocket-view'});
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

test('speechPhrases puts the allowed tags back where the model wrote them, phrase by phrase, and nothing else', () => {
  const raw = 'Hey V, [sigh] I have been thinking about what happened last night. We could head down to the market together, pick up some food [laughter] and talk about the next job. That sounds good to me. [confirmation-en]';
  const display = stripSpeechTags(raw), phrases = splitSpeechText(display);
  assert.ok(phrases.length >= 2);
  const voiced = speechPhrases(phrases, raw, OMNI_TAGS);
  assert.equal(voiced.length, phrases.length);
  // The display phrases carry no tag; the voiced ones carry the (at most two) tags in their original place.
  assert.ok(phrases.every(phrase => !hasSpeechTags(phrase)));
  assert.equal(stripSpeechTags(voiced.join(' ')), display);
  assert.match(voiced[0], /^Hey V, \[sigh\] I have/);
  assert.equal(voiced.join(' ').match(/\[[a-z-]+\]/g).length, MAX_VOICED_TAGS);
  assert.ok(!voiced.join(' ').includes('[confirmation-en]'), 'the third tag is a runaway and is not voiced');
  // An engine that renders none of them (or nothing to put back) gets the display phrases.
  assert.equal(speechPhrases(phrases, raw, []), undefined);
  assert.equal(speechPhrases(phrases, display, OMNI_TAGS), undefined);
  assert.equal(speechPhrases(phrases, 'Different words [sigh] entirely.', OMNI_TAGS), undefined);
  // Unsupported tags and adjacent repeats are dropped; a trailing tag belongs to the last phrase.
  assert.deepEqual(speechPhrases(['Yeah, fine.'], 'Yeah, [question-ei] [laughter] [laughter] fine. [sigh]', OMNI_TAGS),
    ['Yeah, [laughter] fine. [sigh]']);
  assert.deepEqual(speechPhrases(['Fine.'], '[laughter] Fine.', OMNI_TAGS, 0), undefined);
  assert.equal(parseTagged('a [x-y] b').display, 'a b');
});

// ---- where tags are removed in the bridge --------------------------------------------------------------------

test('a reply from Convai keeps its tags only in speechText: subtitles, memory and history see the clean text', () => {
  const speech = new NaturalSpeech();
  const result = speech.process({text: 'Heh. [laughter] You really did that? [sigh] Okay.', sessionID: 's1', timing: {}});
  assert.equal(result.text, 'Heh. You really did that? Okay.');
  assert.equal(result.speechText, 'Heh. [laughter] You really did that? [sigh] Okay.');
  assert.equal(result.sessionID, 's1');
  // A reply that is only a tag has nothing to show: it is left whole rather than sent on empty.
  const alone = {text: '[laughter]', sessionID: 's2'};
  assert.equal(speech.process(alone), alone);
  assert.equal(speech.process({sessionID: 's3'}).text, undefined);
  assert.equal(speech.process(undefined), undefined);
});

test('RealtimeHost hands every finished reply, text or microphone, to its transformReply', async () => {
  const seen = [];
  const speech = new NaturalSpeech();
  const host = new RealtimeHost({transformReply: result => { seen.push(result.text); return speech.process(result); }});
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

// What the bridge's omniVoiceFor (convai-bridge.mjs) gives createOmniPcmVoice as `voicedPhrases`, with the same head/tail rule.
function bridgeVoicedPhrases({result, streamed, language = 'en'}) {
  const tagged = (phrases, raw) => typeof raw === 'string' ? speechPhrases(phrases, raw, omniTagsFor(language)) : undefined;
  let headPhrases = [];
  return (phrases, {role}) => {
    if (role === 'tail') {
      const all = tagged([...headPhrases, ...phrases], streamed?.stream?.meta?.speechText);
      return all?.slice(headPhrases.length);
    }
    headPhrases = phrases;
    return streamed ? undefined : tagged(phrases, result.speechText);
  };
}
function taggedWorker() {
  const texts = [];
  const synthesize = async (profile, text) => { texts.push(text); return {audio: encodePcmWav(new Float32Array(OMNI_RATE / 4).fill(.1), OMNI_RATE), timing: {}}; };
  return {texts, synthesize};
}
const TAGGED_REPLY = 'Hey V, [sigh] I have been thinking about what happened last night. We could head down to the market together, pick up some food and talk about the next job. That sounds good to me.';

test('Omni phrases carry the tags to the worker while the text the voice is given, which subtitles read, stays clean', async () => {
  const raw = TAGGED_REPLY;
  const display = stripSpeechTags(raw), phrases = splitSpeechText(display), tagged = speechPhrases(phrases, raw, OMNI_TAGS);
  assert.ok(phrases.length >= 2 && tagged[0].includes('[sigh]'));
  const worker = taggedWorker(), packets = [];
  const voice = createOmniPcmVoice({synthesize: worker.synthesize, voicedPhrases: bridgeVoicedPhrases({result: {text: display, speechText: raw}})});
  // The bridge hands the voice the clean display text (result.text), never the tagged one.
  const response = await voice.synthesizeStream('judy', display, {role: 'head', onPcm: packet => packets.push(packet)});
  assert.deepEqual(worker.texts, tagged, 'every phrase, the first included, is synthesized with its tags');
  assert.equal(stripSpeechTags(worker.texts.join(' ')), display);
  assert.ok(packets.every(packet => !Object.values(packet).some(value => typeof value === 'string' && hasSpeechTags(value))), 'nothing a tag could ride on reaches a packet');
  assert.equal(response.timing.voicePhrases, phrases.length);
  assert.ok(!JSON.stringify(response.timing).includes('[sigh]'), 'nor the timing that is logged');
});

test('Natural speech off, or a reply with no tag, sends OmniVoice the plain phrases', async () => {
  const display = stripSpeechTags(TAGGED_REPLY), phrases = splitSpeechText(display);
  for (const result of [{text: display, speechText: undefined}, {text: display, speechText: display}]) {
    const worker = taggedWorker();
    const voice = createOmniPcmVoice({synthesize: worker.synthesize, voicedPhrases: bridgeVoicedPhrases({result})});
    await voice.synthesizeStream('judy', display, {role: 'head', onPcm() {}});
    assert.deepEqual(worker.texts, phrases);
  }
  // A Chinese or Japanese sound is voiced only on a reply in that language.
  const cjk = 'Hey V, [question-ei] I have been thinking about what happened last night. We could head down to the market together.';
  const clean = stripSpeechTags(cjk), spoken = splitSpeechText(clean);
  for (const [language, kept] of [['en', false], ['zh', true]]) {
    const worker = taggedWorker();
    const voice = createOmniPcmVoice({synthesize: worker.synthesize, voicedPhrases: bridgeVoicedPhrases({result: {text: clean, speechText: cjk}, language})});
    await voice.synthesizeStream('judy', clean, {role: 'head', onPcm() {}});
    assert.equal(worker.texts.join(' ').includes('[question-ei]'), kept, language);
    assert.equal(stripSpeechTags(worker.texts.join(' ')), spoken.join(' '));
  }
});

test('a reply voiced while it is still written has tags for its rest only: the first sentence is plain, the tail carries the tags where the model wrote them', async () => {
  const raw = TAGGED_REPLY, display = stripSpeechTags(raw), phrases = splitSpeechText(display);
  // The first phrase is spoken as soon as it is written; the rest follows once the model has finished.
  const head = phrases[0], tail = phrases.slice(1).join(' ');
  const streamed = {stream: {meta: {speechText: raw}}};
  const voiced = bridgeVoicedPhrases({result: {text: display}, streamed});
  const worker = taggedWorker(), headWorker = taggedWorker();
  const headVoice = createOmniPcmVoice({synthesize: headWorker.synthesize, voicedPhrases: voiced});
  await headVoice.synthesizeStream('judy', head, {role: 'head', onPcm() {}});
  assert.deepEqual(headWorker.texts, splitSpeechText(head), 'the head never carries a tag');
  const tailVoice = createOmniPcmVoice({synthesize: worker.synthesize, voicedPhrases: voiced});
  await tailVoice.synthesizeStream('judy', tail, {role: 'tail', onPcm() {}});
  assert.equal(stripSpeechTags(worker.texts.join(' ')), tail);
  const whole = speechPhrases([...splitSpeechText(head), ...splitSpeechText(tail)], raw, OMNI_TAGS) ?? [];
  assert.deepEqual(worker.texts, whole.slice(splitSpeechText(head).length));
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

test('the bridge wires Natural speech through the context, the reply transform, Omni synthesis and the settings poll', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /import \{NaturalSpeech, OMNI_TAGS, omniTagsFor, speechPhrases\} from '\.\/natural-speech\.mjs'/);
  assert.match(bridge, /const cleanReply = result => expressiveEmotions\.process\(naturalSpeech\.process\(result\)\)/);
  assert.equal(bridge.match(/transformReply: cleanReply/g).length, 4, 'text hosts: conversation, phone, Mistral and add-on speakers');
  // The block is the last piece of the conversation context and is gated on the committed voice, never on Convai.
  assert.match(bridge, /naturalSpeechContext\(input\)\), block\('notes', expressiveEmotionsContext\(input\)\),/);
  assert.match(bridge, /turn: input\?\.requestId \|\| input\?\.id, trait: traitFor\(input\.profileKey\), profile: input\.profileKey,/);
  assert.match(bridge, /language: turnVoice\(input\)\.language\}\);/);
  assert.match(bridge, /logNaturalSpeech\(input, result\);/);
  assert.match(bridge, /\[NaturalSpeech\] profile=\$\{input\.profileKey\} engine=\$\{turnVoice\(input\)\.engine\} setting=/);
  // The engine is the turn's planned voice (bridge/multilingual.mjs): with Multilingual conversations off it is the
  // committed choice (local provider, else Convai); a turn the cloud voice speaks never gets the block.
  assert.match(bridge, /const engine = turnVoice\(input\)\.engine;/);
  assert.match(bridge, /const localChoice = profile => \(\{uses: localVoice\.usesProfile\(profile\) && !localVoice\.cloudKeyless, provider: localVoice\.provider,/);
  assert.match(bridge, /input\.channel === 'phone' \|\| prepared\?\.route\?\.channel === 'phone'/);
  assert.match(bridge, /naturalSpeech\.enabled && typeof raw === 'string' \? speechPhrases\(phrases, raw, omniTagsFor\(language\)\) : undefined/);
  assert.match(bridge, /voicedPhrases: \(phrases, \{role\}\) =>/, 'the tags reach OmniVoice through its voicedPhrases only');
  assert.match(bridge, /return streamed \? undefined : tagged\(phrases, result\.speechText\)/);
  assert.match(bridge, /naturalSpeech\.update\(settings\), emotionsChanged/);
  const subtitles = readFileSync(new URL('../mod/subtitles.lua', import.meta.url), 'utf8');
  assert.match(subtitles, /text:gsub\('%s\*%\[%a\[%a%-\]\*%\]', ''\)/);
});


// ---- block v3: the character's own habits, new tags, placement wording (docs/NATURAL_SPEECH_BLOCK_V3.md) -----------------

test('the OmniVoice list has the two new English question sounds, and the Chinese/Japanese ones are separate', () => {
  assert.ok(OMNI_TAGS.includes('question-ah') && OMNI_TAGS.includes('question-oh'));
  assert.deepEqual([...CJK_TAGS].sort(), ['question-ei', 'question-yi', 'surprise-wa', 'surprise-yo']);
  for (const tag of CJK_TAGS) assert.ok(!OMNI_TAGS.includes(tag), `${tag} is not an English tag`);
  assert.equal(omniTagsFor(undefined), OMNI_TAGS);
  assert.equal(omniTagsFor('en'), OMNI_TAGS);
  assert.equal(omniTagsFor('es'), OMNI_TAGS);
  for (const language of ['zh', 'ja']) assert.deepEqual(omniTagsFor(language), [...OMNI_TAGS, ...CJK_TAGS]);
});

test('the block names the Chinese and Japanese sounds only on a Chinese or Japanese turn, and Pocket never gets any tag', () => {
  for (const language of [undefined, 'en', 'es', 'ko', 'fr']) {
    const text = naturalSpeechContext({engine: 'omni', language});
    for (const tag of CJK_TAGS) assert.ok(!text.includes(`[${tag}]`), `${language}: ${tag}`);
    assert.ok(text.includes('[question-ah]') && text.includes('[question-oh]'), 'the English question sounds are always described');
  }
  for (const language of ['zh', 'ja']) {
    const text = naturalSpeechContext({engine: 'omni', language});
    for (const tag of [...OMNI_TAGS, ...CJK_TAGS]) assert.ok(text.includes(`[${tag}]`), `${language}: ${tag}`);
    // The previous reply's CJK sound is remembered on those turns only.
    assert.match(naturalSpeechContext({engine: 'omni', language, recent: ['surprise-wa']}), /already used \[surprise-wa\]/);
  }
  assert.ok(!/already used/.test(naturalSpeechContext({engine: 'omni', language: 'en', recent: ['surprise-wa']})));
  for (const language of ['zh', 'ja', undefined]) {
    const pocket = naturalSpeechContext({engine: 'pocket', language, profile: 'judy-alvarez', trait: 'warm'});
    assert.deepEqual([...pocket.matchAll(/\[([a-z-]+)\]/g)].map(match => match[1]), ['laughter', 'sigh']);
    assert.ok(!pocket.includes('How you talk'), 'the per-character line is OmniVoice only');
  }
});

test('a Chinese or Japanese sound is voiced only on a Chinese or Japanese reply and is otherwise treated like an unknown tag', () => {
  const raw = 'Yeah. [surprise-wa] Okay then, [question-ei] fine. [laughter]';
  const display = stripSpeechTags(raw), phrases = splitSpeechText(display);
  assert.equal(display, 'Yeah. Okay then, fine.', 'every display text drops them all');
  assert.equal(keepSpeechTags(raw, omniTagsFor('en')), 'Yeah. Okay then, fine. [laughter]');
  assert.equal(keepSpeechTags(raw, omniTagsFor('ja')), raw);
  const voiced = language => speechPhrases(phrases, raw, omniTagsFor(language))?.join(' ');
  assert.ok(!/surprise-wa|question-ei/.test(voiced('en')) && voiced('en').includes('[laughter]'));
  assert.ok(!/surprise-wa|question-ei/.test(voiced('es')));
  assert.match(voiced('ja'), /\[surprise-wa\]/);
  assert.match(voiced('zh'), /\[surprise-wa\]/);
  assert.equal(voiced('zh').match(/\[[a-z-]+\]/g).length, MAX_VOICED_TAGS, 'the runaway limit still applies');
  // They count as voiced sounds: a reply with one blocks the next offer, like any other sound.
  const speech = new NaturalSpeech();
  speech.update({naturalSpeech: true});
  speech.process({text: 'Wa! [surprise-wa] Really?', sessionID: 'cjk'});
  assert.equal(speech.contextFor({engine: 'omni', spoken: true, sessionId: 'cjk', trait: 'dry', random: ALWAYS, language: 'ja'}), '');
});

test('the placement wording lets a sound sit wherever a real person would make it, varied, but never inside a tight phrase', () => {
  const text = naturalSpeechContext({engine: 'omni'});
  for (const phrase of ['vary where from reply to reply', 'sometimes before a sentence, sometimes right after one ends',
    'in the middle of a sentence at a natural break (after a comma, between two clauses, before "but" or "and")',
    'Do not always put it between two sentences', 'Never split a tight phrase',
    'between an adjective and its noun, inside a name, or between a verb and its object']) assert.ok(text.includes(phrase), phrase);
  // Variety instead of a trailing "...": at most one per reply.
  assert.ok(text.includes('not every touch is a trailing "..."') && text.includes('never more than one "..." in a reply'));
});

test('a tag is always its own word and never splits one', () => {
  assert.equal(splitsWord('Well, [sigh] fine.'), false);
  assert.equal(splitsWord('quit on me [laughter]. How about you?'), false);
  assert.equal(splitsWord('Fine,[laughter] okay'), false);
  assert.equal(splitsWord('Wel[sigh]l, fine.'), true);
  assert.equal(splitsWord(undefined), false);
  // However the model glued a tag to a word, the display text keeps the words on both sides whole.
  assert.equal(stripSpeechTags('Wel[sigh]l fine.'), 'Wel l fine.');
  assert.equal(stripSpeechTags('Well [sigh]fine.'), 'Well fine.');
});

test('each character gets a "how they talk" line on offered turns only; the setting off and un-offered turns are untouched', () => {
  const line = (profile, trait = 'neutral', name = profile) => talkLine({profile, name, trait});
  assert.match(line('judy-alvarez'), /^How you talk: soft sighs.*nervous laugh.*"uh"/);
  assert.match(line('panam-palmer'), /^How you talk: a short laugh when someone says something stupid.*sigh.*almost never an "uh"/);
  assert.match(line('johnny-silverhand'), /^How you talk: .*never an "uh".*never giggly.*dry scoff/);
  assert.match(line('npc-street-resident-female'), /^How you talk: a tired local/);
  // Everyone else: from the trait. Every line is addressed to the character ("you"): never "How Jackie Welles talks:", a narrator's
  // description of the speaker by name (docs/FIRST_PERSON_RULE.md).
  for (const [trait, expected] of [['warm', /warm, easy laugh/], ['neutral', /short laugh when something is funny/],
    ['dry', /flat scoff or grunt.*never giggly/], ['cold', /almost never a sound/], ['mystery', /short laugh when something is funny/]]) {
    assert.match(line('jackie-welles', trait, 'Jackie Welles'), /^How you talk: /, trait);
    assert.match(line('jackie-welles', trait, 'Jackie Welles'), expected, trait);
    assert.ok(!/Jackie|Welles|talks:/.test(line('jackie-welles', trait, 'Jackie Welles')), `${trait}: the character is never named`);
    assert.match(line('npc-maelstrom-male', trait, 'Maelstrom Ganger Male'), /^How you talk: /, trait);
  }
  assert.equal(talkLine({}), '');
  assert.equal(talkLine({profile: ''}), '');
  for (const trait of ['warm', 'neutral', 'dry', 'cold']) {
    assert.ok(!/\b(she|he|her|his|him)\b/i.test(line('someone', trait, 'Someone')), `${trait}: generic lines fit any gender`);
  }

  const speech = new NaturalSpeech();
  const ask = (options = {}) => speech.contextFor({engine: 'omni', spoken: true, trait: 'warm', random: ALWAYS, ...options});
  assert.equal(ask({profile: 'judy-alvarez', name: 'Judy Alvarez', sessionId: 'a'}), '', 'setting off: nothing at all');
  speech.update({naturalSpeech: true});
  const offered = ask({profile: 'judy-alvarez', name: 'Judy Alvarez', sessionId: 'b'});
  assert.ok(offered.includes(line('judy-alvarez')));
  assert.equal(offered, naturalSpeechContext({engine: 'omni', profile: 'judy-alvarez', name: 'Judy Alvarez', trait: 'warm', place: 'mid'}));
  // The line sits after the tags and before the rules.
  assert.ok(offered.indexOf('How you talk') > offered.indexOf('[dissatisfaction-hnn]') && offered.indexOf('How you talk') < offered.indexOf('Use at most one'));
  assert.ok(!/(she|he|her|his|Judy)/.test(offered), 'the whole block speaks to the character, never about her');
  // Not offered: still nothing, whoever it is.
  assert.equal(ask({profile: 'judy-alvarez', sessionId: 'c', random: NEVER}), '');
  // No profile known: the plain block, no line.
  assert.ok(!ask({sessionId: 'd'}).includes('talks:') && !ask({sessionId: 'e'}).includes('How you talk'));
});

test('a profile rate overrides its trait\'s rate only for that profile', () => {
  const speech = new NaturalSpeech();
  speech.update({naturalSpeech: true});
  for (const [profile, rate] of Object.entries(OFFER_RATE_BY_PROFILE)) {
    assert.ok(rate > 0 && rate < 1, profile);
    assert.ok(speech.contextFor({engine: 'omni', spoken: true, trait: 'cold', profile, sessionId: 'p' + profile, random: () => rate - .01}), profile);
    assert.equal(speech.contextFor({engine: 'omni', spoken: true, trait: 'cold', profile, sessionId: 'q' + profile, random: () => rate + .01}), '', profile);
  }
  assert.equal(speech.contextFor({engine: 'omni', spoken: true, trait: 'dry', profile: 'someone-else', sessionId: 'r', random: () => OFFER_RATE.dry + .01}), '');
});

test('the spot for a sound is picked per offered turn by the dice, varied, and stays the same if the context is rebuilt', () => {
  assert.deepEqual(Object.keys(PLACES).sort(), ['between', 'end', 'mid', 'start']);
  const speech = new NaturalSpeech();
  speech.update({naturalSpeech: true});
  // A seeded generator: all four spots turn up, the middle of a sentence most often, the start of the reply least often.
  let state = 777;
  const random = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const seen = {};
  for (let turn = 0; turn < 600; turn++) {
    const text = speech.contextFor({engine: 'omni', spoken: true, sessionId: `s${turn}`, turn: `t${turn}`, trait: 'warm', random});
    if (!text) continue;
    const place = Object.keys(PLACES).find(key => text.includes(`place it exactly here: ${PLACES[key]}.`));
    assert.ok(place, 'every offered block names one spot');
    seen[place] = (seen[place] ?? 0) + 1;
  }
  assert.deepEqual(Object.keys(seen).sort(), ['between', 'end', 'mid', 'start']);
  assert.ok(seen.mid > seen.between && seen.between > seen.end && seen.end > seen.start, JSON.stringify(seen));
  // Decided once per turn.
  const first = speech.contextFor({engine: 'omni', spoken: true, sessionId: 'same', turn: 'same-1', trait: 'warm', random: () => 0});
  assert.equal(speech.contextFor({engine: 'omni', spoken: true, sessionId: 'same', turn: 'same-1', trait: 'warm', random: () => .99}), first);
  assert.ok(first.includes(PLACES.mid));
  assert.ok(!naturalSpeechContext({engine: 'omni'}).includes('place it exactly here'), 'no spot unless one was picked');
  assert.ok(!naturalSpeechContext({engine: 'pocket', place: 'mid'}).includes('place it exactly here'), 'Pocket is punctuation only');
});
