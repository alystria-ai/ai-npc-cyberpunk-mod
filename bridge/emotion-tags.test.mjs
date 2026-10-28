import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EMOTION_NAMES, EMOTION_TAG_BLOCK, EmotionTagStream, emotionSpans, emotionTagsContext, heldFrom, hasEmotionTag,
  normaliseEmotion, parseEmotionText, replaceEmotionTags} from './emotion-tags.mjs';
import {OMNI_TAGS, displayText, keepSpeechTags, parseTagged, processReply, stripSpeechTags,
  hasSpeechTags} from './speech-tags.mjs';
import {ExpressiveEmotions, EXPRESSIVE_TEXT} from './expressive-emotions.mjs';

// ---- the grammar ------------------------------------------------------------------------------------------------------

test('the nine names are the tags, with a strength; the aliases a model might write instead are understood', () => {
  assert.deepEqual([...EMOTION_NAMES], ['joy', 'warm', 'interest', 'surprise', 'sadness', 'fear', 'anger', 'disgust', 'calm']);
  assert.deepEqual(normaliseEmotion('joy'), {name: 'joy', strength: 'subtle'});
  assert.deepEqual(normaliseEmotion('Anger', 'STRONG'), {name: 'anger', strength: 'strong'});
  assert.deepEqual(normaliseEmotion('angry', '2'), {name: 'anger', strength: 'strong'});
  assert.deepEqual(normaliseEmotion('worried', '1'), {name: 'fear', strength: 'subtle'});
  assert.deepEqual(normaliseEmotion('trust'), {name: 'warm', strength: 'subtle'});
  assert.deepEqual(normaliseEmotion('neutral'), {name: 'calm', strength: 'subtle'});
  assert.deepEqual(normaliseEmotion('joy', 'whatever'), {name: 'joy', strength: 'subtle'}, 'an unknown strength is the default one');
  for (const word of ['choomba', 'V', '42', '', 'the end']) assert.equal(normaliseEmotion(word), null, word);
});

test('only emotion words are tags: other braces, brackets and plain words stay exactly as written', () => {
  const plain = 'The {choomba} said {42} and {} and {I think} so, [laughter] and {joy is a word}.';
  assert.equal(hasEmotionTag(plain), false);
  assert.equal(replaceEmotionTags(plain, () => 'X'), plain);
  assert.equal(replaceEmotionTags('A {joy} b { Anger : Strong } c {sad} d {joy:}', tag => `<${tag.name}/${tag.strength}>`),
    'A <joy/subtle> b <anger/strong> c <sadness/subtle> d {joy:}');
  assert.equal(hasEmotionTag('so {warm}'), true);
  assert.equal(hasEmotionTag(undefined), false);
});

test('a bracketed emotion word is a feeling, never a voice sound: [surprise] moves the face, [surprise-ah] stays a sound', () => {
  assert.equal(hasEmotionTag('[surprise] Oh.'), true);
  assert.equal(hasEmotionTag('[surprise-ah] Oh.'), false);
  assert.equal(hasEmotionTag('[laughter] [sigh] [question-oh] [dissatisfaction-hnn] [confirmation-en]'), false);
  assert.equal(replaceEmotionTags('[Anger:strong] No. {joy} Ha.', tag => `<${tag.name}/${tag.strength}>`), '<anger/strong> No. <joy/subtle> Ha.');
  const both = parseTagged('[surprise] You did? [sigh] [angry:2] Why. [laughter] Fine.');
  assert.equal(both.display, 'You did? Why. Fine.');
  assert.deepEqual(both.marks, [{at: 0, name: 'surprise', strength: 'subtle'}, {at: 9, name: 'anger', strength: 'strong'}]);
  assert.deepEqual(both.words.flatMap(word => word.before), ['sigh', 'laughter']);
  assert.equal(keepSpeechTags('[surprise] You did? [sigh] Why.', OMNI_TAGS), 'You did? [sigh] Why.');
  assert.equal(stripSpeechTags('[joy][warm]Hi.'), 'Hi.');
});

// ---- parsing ----------------------------------------------------------------------------------------------------------

const RAW = '{interest}Hey V, you made it. {sadness:strong} But Jackie is gone, and I miss him.{calm} Let us go {joy} and celebrate.';

test('tags become offsets into the clean text, spans cut it, and the strength becomes an intensity', () => {
  const parsed = parseEmotionText(RAW);
  assert.equal(parsed.text, 'Hey V, you made it. But Jackie is gone, and I miss him. Let us go and celebrate.');
  assert.deepEqual(parsed.tags.map(tag => [tag.name, tag.strength, tag.intensity, parsed.text.slice(tag.at).split(' ')[0]]),
    [['interest', 'subtle', 1, 'Hey'], ['sadness', 'strong', 2, 'But'], ['calm', 'subtle', 1, 'Let'], ['joy', 'subtle', 1, 'and']]);
  assert.deepEqual(parsed.spans.map(span => [span.emotion, span.intensity, parsed.text.slice(span.start, span.end)]), [
    ['interest', 1, 'Hey V, you made it. '], ['sadness', 2, 'But Jackie is gone, and I miss him. '],
    ['calm', 1, 'Let us go '], ['joy', 1, 'and celebrate.']]);
  // The spans tile the text.
  assert.equal(parsed.spans[0].start, 0);
  assert.equal(parsed.spans.at(-1).end, parsed.text.length);
  parsed.spans.slice(1).forEach((span, index) => assert.equal(span.start, parsed.spans[index].end));
});

test('a stretch before the first tag is a span with no emotion; {calm} is the explicit resting face; no tag, no spans of feeling', () => {
  const parsed = parseEmotionText('Well. {anger}Not that.');
  assert.deepEqual(parsed.spans, [{start: 0, end: 6, emotion: null, intensity: 0}, {start: 6, end: 15, emotion: 'anger', intensity: 1}]);
  assert.deepEqual(parseEmotionText('{calm}Plain.').spans, [{start: 0, end: 6, emotion: 'calm', intensity: 1}]);
  assert.deepEqual(parseEmotionText('Nothing marked here.').spans, [{start: 0, end: 20, emotion: null, intensity: 0}]);
  assert.deepEqual(parseEmotionText('').spans, []);
  assert.deepEqual(emotionSpans([], 0), []);
  assert.deepEqual(emotionSpans(null, 10), []);
});

test('malformed tags: two before one word (the later wins), a tag with nothing after it, empty braces, stray punctuation', () => {
  assert.deepEqual(parseEmotionText('{joy}{anger} Fine.').spans.map(span => span.emotion), ['anger']);
  assert.deepEqual(parseEmotionText('{joy} Fine. {anger}').tags.map(tag => tag.name), ['joy'], 'a trailing tag marks nothing');
  assert.equal(parseEmotionText('{joy}').text, '');
  assert.deepEqual(parseEmotionText('{joy}').spans, []);
  // Punctuation the model wrote right after a tag belongs to the word before it; a doubled mark is dropped.
  assert.equal(parseEmotionText('Sure {joy}. Okay.').text, 'Sure. Okay.');
  assert.equal(parseEmotionText('No. {joy}! Fine.').text, 'No. Fine.');
  assert.equal(parseEmotionText('Okay {sadness} — {calm} — sure.').text, 'Okay — sure.');
  // A tag inside a word splits it (it is always a violation of the block, and never shows a brace).
  assert.equal(parseEmotionText('Wel{joy}l then').text, 'Wel l then');
  // Nested or doubled braces are not tags; they are ordinary text.
  assert.equal(parseEmotionText('{joy:{strong}} hi').text, '{joy:{strong}} hi');
  assert.deepEqual(parseEmotionText('{joy:{strong}} hi').tags, []);
  assert.equal(parseEmotionText('a } b { x').text, 'a } b { x');
  // A dangling half tag at the very end is dropped; a word-like half tag that cannot be one is kept.
  assert.equal(parseEmotionText('Well {ang').text, 'Well');
  assert.equal(parseEmotionText('Well {I think').text, 'Well {I think');
  assert.equal(parseEmotionText('Well [laug').text, 'Well [laug', 'voice-tag fragments are the voice code\'s business');
  // Control characters from the model cannot forge the internal marker.
  assert.equal(parseEmotionText('A \u0001joy:strong\u0001 B').text, 'A joy:strong B');
});

test('tags next to OmniVoice sound tags: the two kinds are independent in both directions', () => {
  const raw = '{joy}[laughter] Ha! {anger:strong}[sigh]{sadness}Fine, [question-oh] {calm}whatever.';
  const emotion = parseEmotionText(raw), both = parseTagged(raw);
  assert.equal(both.display, 'Ha! Fine, whatever.');
  // Two tags before one word are both reported (the planner keeps the later one); each sits at the word after it.
  const found = (tags, text) => tags.map(tag => [tag.name, tag.strength, text.slice(tag.at).split(' ')[0]]);
  const expected = [['joy', 'subtle', 'Ha!'], ['anger', 'strong', 'Fine,'], ['sadness', 'subtle', 'Fine,'], ['calm', 'subtle', 'whatever.']];
  assert.deepEqual(found(both.marks, both.display), expected);
  // The emotion-only parser leaves the square-bracket sounds in its text (the voice code owns them), so its offsets are into that text.
  assert.equal(emotion.text, '[laughter] Ha! [sigh] Fine, [question-oh] whatever.');
  assert.deepEqual(found(emotion.tags, emotion.text), [['joy', 'subtle', '[laughter]'], ['anger', 'strong', '[sigh]'],
    ['sadness', 'subtle', 'Fine,'], ['calm', 'subtle', 'whatever.']]);
  assert.deepEqual(emotion.spans.map(span => span.emotion), ['joy', 'anger', 'sadness', 'calm']);
  assert.deepEqual(both.words.flatMap(word => word.before), ['laughter', 'sigh', 'question-oh']);
  assert.equal(keepSpeechTags(raw, OMNI_TAGS), '[laughter] Ha! [sigh] Fine, [question-oh] whatever.');
  assert.equal(stripSpeechTags(raw), 'Ha! Fine, whatever.');
});

test('the combined pass of speech-tags.mjs and the emotion parser agree on tags, offsets and clean text', () => {
  const corpus = [RAW, '{joy}Hello there.', 'No tags at all.', '{warm} A. {fear} B? {anger:strong}C! {calm}D', 'Sure {joy}. Okay {sad}, fine.',
    '{ Joy }Spaces and {ANGRY:Strong}caps.', 'Well... {sadness}it hurts — {calm} — a bit.', '{joy}{warm}Two before one. {calm}', '{surprise}Three million? {joy}Holy! {interest}Tell me.'];
  for (const raw of corpus) {
    const a = parseEmotionText(raw), b = parseTagged(raw);
    assert.equal(a.text, b.display, raw);
    assert.deepEqual(a.tags.map(({at, name, strength}) => ({at, name, strength})), b.marks, raw);
  }
});

// ---- streaming --------------------------------------------------------------------------------------------------------

const streamCorpus = [RAW, '{surprise}Three million? {joy}Holy shit, V! {interest}Tell me.', '{anger:strong}No! {calm}Fine. {sadness}It hurts{warm}.',
  'Plain reply, no tag.', '{ Joy }Spaced {angry:2}and aliased.', 'A {think} B {joy} C {fear', 'Say {angr'];

function streamed(raw, cuts) {
  const stream = new EmotionTagStream();
  const points = [0, ...cuts, raw.length], seen = [];
  let text = '';
  for (let i = 1; i < points.length; i++) {
    const state = stream.push(raw.slice(points[i - 1], points[i]));
    assert.ok(state.text.startsWith(text), 'the text only ever grows');
    assert.equal(text + state.added, state.text, 'added is exactly the growth');
    text = state.text; seen.push(state);
  }
  return {last: stream.end(), seen};
}

test('a reply streamed in two chunks, split at every possible character, ends exactly as the whole reply parses', () => {
  for (const raw of streamCorpus) {
    const whole = parseEmotionText(raw);
    for (let cut = 0; cut <= raw.length; cut++) {
      const {last, seen} = streamed(raw, [cut]);
      assert.equal(last.text, whole.text, `${raw} @ ${cut}`);
      assert.deepEqual(last.tags, whole.tags, `${raw} @ ${cut}`);
      assert.deepEqual(last.spans, whole.spans, `${raw} @ ${cut}`);
      // While streaming, a tag still being written is never shown.
      for (const state of seen) if (!/[{}]/.test(whole.text)) assert.ok(!/[{}]/.test(state.text), `${raw} @ ${cut}: ${state.text}`);
    }
  }
});

test('a reply streamed one character at a time, or in random chunks, ends exactly as the whole reply parses', () => {
  let seed = 7;
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (const raw of streamCorpus) {
    const whole = parseEmotionText(raw);
    const everyCharacter = Array.from({length: raw.length - 1}, (_, index) => index + 1);
    assert.deepEqual(streamed(raw, everyCharacter).last.tags, whole.tags, raw);
    assert.equal(streamed(raw, everyCharacter).last.text, whole.text, raw);
    for (let round = 0; round < 40; round++) {
      const cuts = [...new Set(Array.from({length: 1 + Math.floor(random() * 6)}, () => Math.floor(random() * raw.length)))].sort((a, b) => a - b);
      const {last} = streamed(raw, cuts);
      assert.equal(last.text, whole.text, `${raw} @ ${cuts}`);
      assert.deepEqual(last.tags, whole.tags, `${raw} @ ${cuts}`);
    }
  }
});

test('the stream reports a tag as found only once its word has arrived, and what it is holding back', () => {
  const stream = new EmotionTagStream();
  assert.deepEqual(stream.push('{joy}').tags, []);
  const state = stream.push('Hel');
  assert.deepEqual(state.tags.map(tag => [tag.name, tag.at]), [['joy', 0]]);
  assert.equal(state.text, 'Hel');
  assert.equal(stream.push(' there {sad').held, '{sad');
  assert.equal(stream.push('ness}').held, '');
  assert.equal(stream.push(' ok').text, 'Hel there ok');
  const end = stream.end();
  assert.equal(end.complete, true);
  assert.deepEqual(end.tags.map(tag => tag.name), ['joy', 'sadness']);
  // A half tag at the very end is dropped when the reply ends.
  const cut = new EmotionTagStream();
  cut.push('Gone {ang');
  assert.equal(cut.end().text, 'Gone');
});

test('heldFrom: only something that can still become a tag is held back', () => {
  assert.equal(heldFrom('Well {'), 5);
  assert.equal(heldFrom('Well {ang'), 5);
  assert.equal(heldFrom('Well { Anger : stro'), 5);
  assert.equal(heldFrom('Well [laug'), 5);
  assert.equal(heldFrom('Well {think'), -1);
  assert.equal(heldFrom('Well {joy} then'), -1);
  assert.equal(heldFrom('Well [laughter] then'), -1);
  assert.equal(heldFrom('No brackets'), -1);
  assert.equal(heldFrom('A {' + 'x'.repeat(60)), -1, 'a long run cannot be a tag');
  assert.equal(displayText('Well {sad', false), 'Well');
  assert.equal(displayText('Well {think', false), 'Well {think');
  assert.equal(displayText('Yeah, [laugh', false), 'Yeah,');
});

// ---- stripping everywhere text is shown, stored or spoken -----------------------------------------------------------------

test('every reply path removes emotion tags: display, history, voice text, Omni phrases, the engine\'s last defence', () => {
  const raw = '{interest}Hey V, [sigh] you made it. {sadness:strong}But Jackie is gone, and I miss him. {calm}Let us go {joy}and celebrate.';
  const result = processReply({text: raw, sessionID: 's'});
  for (const text of [result.text, result.speechText]) assert.ok(!/[{}]/.test(text), text);
  assert.equal(result.text, 'Hey V, you made it. But Jackie is gone, and I miss him. Let us go and celebrate.');
  assert.deepEqual(result.emotionMarks.map(mark => mark.name), ['interest', 'sadness', 'calm', 'joy']);
  // A cloud-voice reply with a tag left over is cleaned the same way.
  assert.equal(processReply({text: '{warm}Hi.', sessionID: 'x'}).text, 'Hi.');
  // The strongest check: the display text is the voiced text with every kind of tag removed.
  const voiced = keepSpeechTags(raw, OMNI_TAGS);
  assert.ok(!/[{}]/.test(voiced));
  assert.equal(stripSpeechTags(voiced), result.text);
  assert.equal(keepSpeechTags(raw, []), 'Hey V, you made it. But Jackie is gone, and I miss him. Let us go and celebrate.');
  assert.equal(hasSpeechTags('only {anger:strong} here'), true);
  // A reply that only carries tags is returned whole, never empty on the way to a subtitle.
  const empty = {text: '{joy}{calm}', sessionID: 'e'};
  assert.equal(processReply(empty), empty);
});

test('the bridge passes every reply through the cleaner, and the game\'s subtitle code strips the same names', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.equal(bridge.match(/transformReply: cleanReply/g).length, 4, 'the conversation host, the phone host, the Mistral route and the add-on speakers\' text host');
  assert.match(bridge, /const cleanReply = result => expressiveEmotions\.process\(processReply\(result\)\)/);
  const subtitles = readFileSync(new URL('../mod/subtitles.lua', import.meta.url), 'utf8');
  for (const name of EMOTION_NAMES) assert.ok(subtitles.includes(`'${name}'`), `mod/subtitles.lua strips {${name}}`);
  // The continuous (cloud voice) path shows the text through displayText.
  const continuous = readFileSync(new URL('./convai-continuous-speech.mjs', import.meta.url), 'utf8');
  assert.match(continuous, /displayText\(snapshot\.text, snapshot\.textComplete\)/);
});

// ---- the block and its gating -----------------------------------------------------------------------------------------------

test('the block: every tag, the rules the measurements called for, compact enough to share a turn with the other blocks', () => {
  assert.ok(EMOTION_TAG_BLOCK.length > 0);
  for (const name of EMOTION_NAMES) assert.ok(EMOTION_TAG_BLOCK.includes(`{${name}}`), `{${name}} is offered`);
  for (const phrase of ['curly braces', 'until the next one', ':strong', 'for the face only', 'square brackets']) {
    assert.ok(EMOTION_TAG_BLOCK.includes(phrase), phrase);
  }
  assert.ok(EMOTION_TAG_BLOCK.length <= 2200, `${EMOTION_TAG_BLOCK.length} characters`);
  assert.equal(emotionTagsContext({trait: 'warm'}), EMOTION_TAG_BLOCK);
  // It never tells the model to write a bracketed sound tag, so it cannot collide with a voice sound tag.
  assert.ok(!/\[(?:laughter|sigh)\]/.test(EMOTION_TAG_BLOCK));
  // The examples inside it are themselves clean and valid.
  for (const example of EMOTION_TAG_BLOCK.match(/"\{[^"]+"/g) ?? []) {
    const parsed = parseEmotionText(example.slice(1, -1));
    assert.ok(parsed.tags.length >= 1 && !/[{}]/.test(parsed.text), example);
  }
});

test('gating: the block goes out (Expressive emotions is always on) only when a local voice speaks the turn', () => {
  const on = new ExpressiveEmotions();
  on.update({expressiveEmotions: false});   // an older settings file: ignored
  assert.notEqual(on.contextFor({engine: 'omni', spoken: true}), '');
  assert.notEqual(on.contextFor({engine: 'pocket', spoken: true}), '');
  assert.equal(on.contextFor({engine: 'convai', spoken: true}), '', 'the Convai voice would read the braces aloud');
  assert.equal(on.contextFor({engine: 'omni', spoken: false}), '', 'text-only turns (phone chat, silent playback)');
  // The measured text IS the block the setting sends (one source of words), and the bridge asks only the gate.
  assert.equal(on.contextFor({engine: 'omni', spoken: true}), EMOTION_TAG_BLOCK);
  assert.equal(EXPRESSIVE_TEXT, EMOTION_TAG_BLOCK);
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /expressiveEmotions\.contextFor\(\{engine, spoken: !phone && localVoice\.playbackEnabled !== false\}\)/);
});

test('it coexists with voice sound tags: the block names no bracket tag, and one reply with both kinds of tag is split correctly', () => {
  const emotion = emotionTagsContext({trait: 'warm'});
  // Voice sounds are square brackets, feelings are braces: the two lists never share a token.
  assert.ok(!/\[[a-z-]+\]/.test(emotion));
  // Both kinds of tag written by one reply are both stripped, and each reaches only its own consumer.
  const reply = processReply({text: '{warm}Sure. [laughter] {joy}Why not?', sessionID: 's'});
  assert.equal(reply.text, 'Sure. Why not?');
  assert.equal(reply.speechText, 'Sure. [laughter] Why not?');
  assert.deepEqual(reply.emotionMarks.map(mark => mark.name), ['warm', 'joy']);
});
