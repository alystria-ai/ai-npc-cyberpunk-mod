import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {NaturalSpeech, EMOTION_NAMES, parseTagged, stripSpeechTags, keepSpeechTags, displayText, hasSpeechTags,
  hasEmotionTags, speechPhrases, OMNI_TAGS} from './natural-speech.mjs';
import {ExpressiveEmotions, EXPRESSIVE_TEXT, EMOTION_FAMILY, MARK_WEIGHT, plannedMarks} from './expressive-emotions.mjs';
import {analyseReply, createPlanner, planRange, planSignal, phraseOffsets, FAMILIES} from './emotion-analysis.mjs';
import {attachExpressionTrack, sampleTrack, alignSegments, findPauses, speechActivity} from './expression-timeline.mjs';
import {splitSpeechText} from './speech-stream.mjs';

const RAW = '{interest} Hey V, [sigh] you made it. {sadness:strong} But Jackie is gone, and I miss him. {calm} Let us go {joy} and celebrate.';

// ---- the setting: on by default (2026-10-11) -----------------------------------------------------------------------------

test('Expressive emotions is on by default: a missing key counts as on, only a saved false turns it off (no block, and a reply keeps no emotion marks)', () => {
  const fresh = new ExpressiveEmotions();
  assert.equal(fresh.enabled, true, 'on before any settings file is read');
  for (const engine of ['omni', 'pocket']) assert.equal(fresh.contextFor({engine, spoken: true}), EXPRESSIVE_TEXT);
  for (const engine of ['convai', undefined]) assert.equal(fresh.contextFor({engine, spoken: true}), '', 'still only on a local voice');
  assert.equal(fresh.update(undefined), false, 'a missing or unreadable settings file leaves it as it was');
  assert.equal(fresh.update({voice: true}), false, 'a settings file without the key stays on');
  assert.equal(fresh.update({expressiveEmotions: 'yes'}), false, 'an odd value is the default (the Lua side resets it to on)');
  assert.equal(fresh.enabled, true);
  const emotions = new ExpressiveEmotions();
  assert.equal(emotions.update({expressiveEmotions: false}), true, 'an explicitly saved false is kept');
  assert.equal(emotions.enabled, false);
  for (const engine of ['omni', 'pocket', 'convai', undefined]) assert.equal(emotions.contextFor({engine, spoken: true}), '');
  const reply = {text: 'Hey V.', emotionMarks: [{at: 0, name: 'joy', strength: 'subtle'}], sessionID: 's'};
  const kept = emotions.process(reply);
  assert.equal(kept.emotionMarks, undefined, 'off: the text-based plan is used');
  assert.equal(kept.text, 'Hey V.');
  assert.ok(reply.emotionMarks, 'the original object is not changed');
  const plain = {text: 'Hey V.'};
  assert.equal(emotions.process(plain), plain);
});

test('the setting follows runtime/settings.json, is independent of Natural speech, and a change is reported once', () => {
  const emotions = new ExpressiveEmotions(), speech = new NaturalSpeech();
  assert.equal(emotions.update({expressiveEmotions: true}), false, 'already on by default');
  assert.equal(emotions.update({expressiveEmotions: false}), true);
  assert.equal(emotions.update({expressiveEmotions: false}), false);
  assert.equal(emotions.update(undefined), false);
  assert.equal(emotions.enabled, false);
  assert.equal(emotions.update({expressiveEmotions: true}), true);
  assert.equal(emotions.enabled, true);
  assert.equal(speech.update({expressiveEmotions: true}), false, 'Natural speech does not read this setting');
  assert.equal(speech.enabled, false);
  assert.equal(emotions.update({expressiveEmotions: false}), true);
  assert.equal(emotions.enabled, false);
});

// ---- the dynamic context --------------------------------------------------------------------------------------

test('the block offers the fixed tag set, several marks per reply, subtle by default, chosen by personality, never every sentence', () => {
  const emotions = new ExpressiveEmotions();
  emotions.update({expressiveEmotions: true});
  const text = emotions.contextFor({engine: 'omni'});
  assert.equal(text, EXPRESSIVE_TEXT);
  assert.equal(emotions.contextFor({engine: 'pocket'}), EXPRESSIVE_TEXT);
  for (const name of EMOTION_NAMES) assert.ok(text.includes(`{${name}}`), `{${name}} is offered`);
  assert.deepEqual([...EMOTION_NAMES], ['joy', 'warm', 'interest', 'surprise', 'sadness', 'fear', 'anger', 'disgust', 'calm']);
  // The October 9 wording (docs/EMOTION_TAGS.md): an opening tag, one or two tags a reply, calm only for a really plain line,
  // an outburst for :strong, the character's own manner, face only.
  for (const phrase of ['curly braces', 'right before the words they apply to', 'until the next one', 'Begin the reply with ONE tag',
    'one or two tags, three at most', '{calm} (a flat, plain, businesslike face)', ':strong', 'if you are guarded, dry or controlled, show less',
    'for the face only', 'square brackets are a different thing']) assert.ok(text.includes(phrase), phrase);
  // Spoken turns on a local voice only: not the cloud voice (it would read the tags aloud), not text-only turns.
  // The block speaks to the character ("you"), never about "characters" in the third person (docs/FIRST_PERSON_RULE.md).
  assert.ok(!/(?:the|this|an? \w+) character|characters|(?:she|he|her|his)/i.test(text), 'second person only');
  assert.equal(emotions.contextFor({engine: 'convai'}), '');
  assert.equal(emotions.contextFor({engine: 'omni', spoken: false}), '');
  assert.equal(emotions.contextFor({}), '');
});

test('every tag maps onto one of the mod\'s own emotion families, and calm onto the resting face', () => {
  assert.deepEqual(Object.keys(EMOTION_FAMILY), [...EMOTION_NAMES]);
  for (const [name, family] of Object.entries(EMOTION_FAMILY)) {
    assert.ok(family === null ? name === 'calm' : FAMILIES.includes(family), name);
  }
  assert.equal(EMOTION_FAMILY.interest, 'anticipation');
  assert.equal(EMOTION_FAMILY.warm, 'trust');
  assert.ok(MARK_WEIGHT.subtle < MARK_WEIGHT.strong && MARK_WEIGHT.subtle <= .6 && MARK_WEIGHT.strong <= 1);
});

// ---- parsing and stripping --------------------------------------------------------------------------------------

test('emotion tags and voice tags use different syntax and never collide', () => {
  const parsed = parseTagged(RAW);
  assert.equal(parsed.display, 'Hey V, you made it. But Jackie is gone, and I miss him. Let us go and celebrate.');
  assert.deepEqual(parsed.marks.map(mark => [mark.name, mark.strength]),
    [['interest', 'subtle'], ['sadness', 'strong'], ['calm', 'subtle'], ['joy', 'subtle']]);
  // Each mark sits at the first character of the word after it.
  for (const mark of parsed.marks) {
    assert.ok(mark.at === 0 || parsed.display[mark.at - 1] === ' ', `${mark.name} at ${mark.at}`);
  }
  assert.deepEqual(parsed.marks.map(mark => parsed.display.slice(mark.at).split(' ')[0]), ['Hey', 'But', 'Let', 'and']);
  // Voice tags are untouched by the emotion pass and vice versa.
  assert.deepEqual(parsed.words.flatMap(word => word.before), ['sigh']);
  assert.equal(keepSpeechTags(RAW, ['sigh']), 'Hey V, [sigh] you made it. But Jackie is gone, and I miss him. Let us go and celebrate.');
  assert.equal(hasEmotionTags('Nothing [sigh] here.'), false);
  assert.equal(hasEmotionTags('A {joy} here.'), true);
  assert.equal(hasSpeechTags('A {joy} here.'), true);
});

test('stripSpeechTags removes emotion tags everywhere text is shown, stored or sent to an engine', () => {
  assert.equal(stripSpeechTags('{joy} Great to see you! {anger:strong}Not him.'), 'Great to see you! Not him.');
  assert.equal(stripSpeechTags('Fine{calm}. Really.'), 'Fine. Really.');
  assert.equal(stripSpeechTags('{Joy} Mixed {SADNESS:Strong} case.'), 'Mixed case.');
  assert.equal(stripSpeechTags('{joy}[laughter]{sadness} Both kinds.'), 'Both kinds.');
  assert.equal(stripSpeechTags('Gone {fear}'), 'Gone');
  assert.equal(stripSpeechTags('{joy}'), '');
  assert.equal(keepSpeechTags('Yeah {joy} [laughter] ok.', OMNI_TAGS), 'Yeah [laughter] ok.', 'an engine never receives an emotion tag');
  assert.equal(keepSpeechTags('Yeah {joy} ok.', []), 'Yeah ok.');
  // Only emotion words are tags (the names, and the aliases a model might write instead); other braces are ordinary text
  // and stay exactly as written.
  const untouched = 'The {choomba} said {42} and {} and {I think}.';
  assert.equal(hasSpeechTags(untouched), false);
  assert.equal(stripSpeechTags(untouched), untouched);
  assert.equal(stripSpeechTags('Fine {joyful} and { Joy } and {angry:2} then.'), 'Fine and and then.');
  // A half-written tag is held back while the text streams.
  assert.equal(displayText('Well {sad', false), 'Well');
  assert.equal(displayText('Well {sadness} then {an', false), 'Well then');
  assert.equal(displayText('Well {sadness} then', true), 'Well then');
});

test('a reply from Convai: clean text for subtitles, memory and history, voice tags for Omni, marks for the face', () => {
  const speech = new NaturalSpeech();
  const result = speech.process({text: RAW, sessionID: 's1', timing: {}});
  assert.equal(result.text, 'Hey V, you made it. But Jackie is gone, and I miss him. Let us go and celebrate.');
  assert.equal(result.speechText, 'Hey V, [sigh] you made it. But Jackie is gone, and I miss him. Let us go and celebrate.');
  assert.equal(result.emotionMarks.length, 4);
  assert.ok(!/[{}]/.test(result.text) && !/[{}]/.test(result.speechText), 'no emotion tag reaches a voice');
  // Emotion tags alone: no speechText (nothing for a voice to add), marks kept.
  const only = speech.process({text: '{joy} Hello there, V.', sessionID: 's2'});
  assert.equal(only.text, 'Hello there, V.');
  assert.equal(only.speechText, undefined);
  assert.deepEqual(only.emotionMarks, [{at: 0, name: 'joy', strength: 'subtle'}]);
  // A reply that is only a tag is left whole rather than sent on empty.
  const alone = {text: '{joy}', sessionID: 's3'};
  assert.equal(speech.process(alone), alone);
  // The devices note counts voice tags and pauses, never an emotion tag.
  speech.update({naturalSpeech: true});
  speech.process({text: '{joy} [laughter] Well... fine.', sessionID: 's4'});
  assert.deepEqual(speech.last.get('s4').sort(), ['ellipsis', 'laughter']);
});

test('Omni phrases still line up with the voiced text when both kinds of tag are present', () => {
  const raw = '{interest} Hey V, [sigh] I have been thinking about what happened last night. {sadness} We could head down to the market together, pick up some food [laughter] and talk about the next job. That sounds good to me.';
  const display = stripSpeechTags(raw), phrases = splitSpeechText(display);
  const voiced = speechPhrases(phrases, raw, OMNI_TAGS);
  assert.equal(voiced.length, phrases.length);
  assert.equal(stripSpeechTags(voiced.join(' ')), display);
  assert.ok(!/[{}]/.test(voiced.join(' ')));
  assert.match(voiced[0], /\[sigh\]/);
  assert.equal(speechPhrases(phrases, '{joy} ' + display, OMNI_TAGS), undefined, 'emotion tags alone give Omni nothing to add');
});

// ---- the plan: marks become segment boundaries -----------------------------------------------------------------

const PARSED = parseTagged(RAW);

test('marks are validated and a mark holds until the next one', () => {
  const marks = plannedMarks([{at: 20, name: 'sadness', strength: 'strong'}, {at: 0, name: 'interest', strength: 'subtle'},
    {at: 20, name: 'anger', strength: 'subtle'}, {at: -1, name: 'joy'}, {at: 999, name: 'joy'}, {at: 5, name: 'nonsense'}, null], 100);
  assert.deepEqual(marks.map(mark => [mark.at, mark.name, mark.family, mark.weight]),
    [[0, 'interest', 'anticipation', MARK_WEIGHT.subtle], [20, 'anger', 'anger', MARK_WEIGHT.subtle]]);
  assert.deepEqual(plannedMarks(undefined), []);
  assert.deepEqual(plannedMarks([{at: 50, name: 'joy'}], 10), [], 'a mark past the text is ignored (a growing prefix)');
});

test('the plan\'s segments start exactly at the marks and carry the marked feeling; unmarked text keeps the text reading', () => {
  const plan = analyseReply(PARSED.display, {profile: 'panam-palmer', marks: PARSED.marks});
  const starts = plan.segments.map(segment => segment.start);
  for (const mark of PARSED.marks) assert.ok(starts.includes(mark.at), `a segment starts at ${mark.at}`);
  const at = offset => plan.segments.find(segment => segment.start <= offset && offset < segment.end);
  assert.equal(at(0).dominant, 'anticipation');
  assert.equal(at(PARSED.marks[1].at).dominant, 'sadness');
  assert.ok(at(PARSED.marks[1].at).weights.sadness > at(0).weights.anticipation, 'strong shows more than subtle');
  assert.ok(at(0).weights.anticipation <= .7, 'a plain tag is a slight expression');
  assert.equal(at(PARSED.marks[2].at).dominant, null, 'calm is the resting face');
  assert.equal(at(PARSED.marks[3].at).dominant, 'joy');
  for (const segment of plan.segments) assert.ok(segment.tags.includes('llm-emotion'));
  // Before the first mark the text reading still applies.
  const late = parseTagged('Hey V, I miss him so much, I am sorry. {joy} But we are fine now.');
  const latePlan = analyseReply(late.display, {profile: 'panam-palmer', marks: late.marks});
  assert.equal(latePlan.segments[0].dominant, 'sadness');
  assert.ok(!latePlan.segments[0].tags.includes('llm-emotion'));
  assert.ok(latePlan.segments.at(-1).tags.includes('llm-emotion'));
  // Personality scales the strength: a cold character shows less of the same tag.
  const cold = analyseReply(PARSED.display, {profile: 'adam-smasher', marks: PARSED.marks});
  assert.ok(cold.segments.find(segment => segment.start === PARSED.marks[1].at).weights.sadness < at(PARSED.marks[1].at).weights.sadness);
  // The reply-level cue comes from the same plan.
  assert.ok(planSignal(plan).emotion);
});

test('fallback: a reply with no marks (or an empty list) is exactly the text-based plan', () => {
  const text = 'Hey V, you made it. But Jackie is gone, and I miss him. Let us go and celebrate.';
  const plain = analyseReply(text, {profile: 'judy-alvarez'});
  assert.deepEqual(analyseReply(text, {profile: 'judy-alvarez', marks: []}), plain);
  assert.deepEqual(analyseReply(text, {profile: 'judy-alvarez', marks: undefined}), plain);
  assert.deepEqual(analyseReply(text, {profile: 'judy-alvarez', marks: [{at: 500, name: 'joy', strength: 'subtle'}]}), plain);
  assert.ok(plain.segments.every(segment => !segment.tags.includes('llm-emotion')));
  const none = createPlanner({profile: 'judy-alvarez'}), empty = createPlanner({profile: 'judy-alvarez', marks: []});
  assert.deepEqual(none(text), plain);
  assert.deepEqual(empty(text), plain);
});

// ---- the timing map: the face changes when the part is SPOKEN --------------------------------------------------

// A mouth timeline: [t, jaw] rows at 50 Hz, speaking except for the given silences.
function mouth(duration, silences) {
  const frames = [];
  for (let t = 0; t <= duration + 1e-9; t += .02) {
    const quiet = silences.some(([from, to]) => t >= from && t < to);
    frames.push([Math.round(t * 1000) / 1000, quiet ? 0 : .3]);
  }
  return {tracks: ['jaw_mid_open'], frames, duration, complete: true};
}
const TEXT = 'Hey V, you made it. But Jackie is gone.';

test('a mark at a sentence start is anchored to the real pause in the audio, wherever the text would put it', () => {
  const parsed = parseTagged('{interest} Hey V, you made it. {sadness:strong} But Jackie is gone.');
  assert.equal(parsed.display, TEXT);
  const plan = analyseReply(parsed.display, {profile: 'judy-alvarez', marks: parsed.marks});
  assert.equal(plan.segments.length, 2);
  // Two voices read the same text: the first sentence takes 1.2 s then a pause, or 2.4 s then a pause.
  for (const [pauseFrom, pauseTo, total] of [[1.2, 1.6, 3.0], [2.4, 2.9, 4.4]]) {
    const face = mouth(total, [[pauseFrom, pauseTo]]);
    const {starts, resolved} = alignSegments(plan.segments, {duration: total, complete: true, activity: speechActivity(face)});
    assert.deepEqual(resolved, [true, true], 'the boundary found its pause');
    assert.ok(Math.abs(starts[1] - pauseTo) < .06, `starts at ${starts[1]}, the pause ends at ${pauseTo}`);
    const track = attachExpressionTrack(face, plan).expressionTrack;
    const family = index => FAMILIES.indexOf(index);
    const before = sampleTrack(track, pauseFrom - .5), after = sampleTrack(track, pauseTo + .5);
    assert.ok(before[family('anticipation')] > before[family('sadness')], 'interest while the first sentence is spoken');
    assert.ok(after[family('sadness')] > .6 && after[family('anticipation')] < .05, 'sadness once the second sentence is spoken');
    // The change begins just ahead of the word (the face anticipates), inside the silence before it, never earlier.
    const arrival = track.keys.findIndex(key => key[1 + family('sadness')] > 0);
    const begin = track.keys[arrival - 1][0];
    assert.ok(begin >= pauseFrom && begin <= pauseTo, `the face starts to change at ${begin}`);
    assert.ok(Math.abs(track.keys[arrival][0] - (pauseTo + .1)) < .08, 'and has fully arrived just after the first word starts');
    assert.ok(track.segments[1].anchored);
  }
});

test('a mark in the middle of a sentence is placed by spoken length inside its sentence, in order and within the audio', () => {
  const parsed = parseTagged('Hey V, you made it, and {joy} I am so glad you came {sadness} but Jackie is gone.');
  const plan = analyseReply(parsed.display, {profile: 'judy-alvarez', marks: parsed.marks});
  assert.equal(plan.segments.length, 3);
  const face = mouth(5, []);
  const {starts, resolved} = alignSegments(plan.segments, {duration: 5, complete: true, activity: speechActivity(face)});
  assert.deepEqual(resolved, [true, false, false], 'no pause to snap to: estimated');
  assert.ok(starts[0] < starts[1] && starts[1] < starts[2] && starts[2] < 5, JSON.stringify(starts));
  // Proportional to the words before it: "joy" starts after about 5 of 15 words, "sadness" after about 11.
  assert.ok(starts[1] > 1 && starts[1] < 2.2, `joy at ${starts[1]}`);
  assert.ok(starts[2] > 3 && starts[2] < 4.3, `sadness at ${starts[2]}`);
});

test('OmniVoice: each phrase is its own audio, so a mark at a phrase start changes the face at that phrase\'s first sound', () => {
  const raw = '{interest} Hey V, I have been thinking about what happened last night. {sadness:strong} We could head down to the market together, pick up some food and talk about the next job. That sounds good to me.';
  const parsed = parseTagged(raw), phrases = splitSpeechText(parsed.display);
  assert.ok(phrases.length >= 2);
  const spans = phraseOffsets(parsed.display, phrases);
  const plan = analyseReply(parsed.display, {profile: 'judy-alvarez', marks: parsed.marks,
    breaks: spans.slice(1).map(span => span[0])});
  const second = parsed.marks[1].at;
  assert.equal(spans[1][0], second, 'the sadness mark opens the second phrase');
  const phrasePlan = planRange(plan, spans[1][0], spans[1][1]);
  assert.equal(phrasePlan.segments[0].start, 0);
  assert.equal(phrasePlan.segments[0].dominant, 'sadness');
  const face = attachExpressionTrack(mouth(4, []), phrasePlan);
  const first = sampleTrack(face.expressionTrack, 0);
  assert.ok(first[FAMILIES.indexOf('sadness')] > .5, 'the phrase\'s audio starts already sad (its own timeline begins at 0)');
  const firstPhrase = planRange(plan, spans[0][0], spans[0][1]);
  assert.equal(firstPhrase.segments[0].dominant, 'anticipation');
});

test('Pocket: the planner reads the marks the growing stream has reached and aligns them as the audio arrives', () => {
  const planner = createPlanner({profile: 'judy-alvarez', marks: PARSED.marks});
  const full = PARSED.display, cut = PARSED.marks[1].at + 4;
  const early = planner(full.slice(0, cut - 8));
  assert.ok(early.segments.some(segment => segment.tags.includes('llm-emotion')));
  assert.ok(!early.segments.some(segment => segment.dominant === 'sadness' && segment.tags.includes('llm-emotion')), 'the sad part is not spoken yet');
  const complete = planner(full);
  assert.ok(complete.segments.some(segment => segment.dominant === 'sadness' && segment.tags.includes('llm-emotion')));
  // While streaming, the unfinished audio places later segments from the pause it has already heard.
  const pause = [[1.2, 1.6]];
  const partial = mouth(2.4, pause); partial.complete = false;
  const track = attachExpressionTrack(partial, analyseReply(full, {profile: 'judy-alvarez', marks: PARSED.marks}), {complete: false}).expressionTrack;
  assert.ok(track.keys.length >= 2);
  assert.equal(track.segments[0].from, 0);
});

// ---- the bridge wires it in the right places -----------------------------------------------------------------------

test('the bridge cleans every reply, adds the block after Natural speech, and hands the marks to the planners', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /import \{ExpressiveEmotions\} from '\.\/expressive-emotions\.mjs'/);
  assert.match(bridge, /const cleanReply = result => expressiveEmotions\.process\(naturalSpeech\.process\(result\)\)/);
  assert.equal(bridge.match(/transformReply: cleanReply/g).length, 2, 'conversation and phone hosts');
  assert.match(bridge, /naturalSpeechContext\(input\), expressiveEmotionsContext\(input\),/);
  assert.match(bridge, /expressiveEmotions\.contextFor\(\{engine, spoken: !phone && localVoice\.playbackEnabled !== false\}\)/);
  // One plan function serves Omni and Pocket's first plan (bridge/emotion-selector.mjs); Pocket's stream planner gets the marks too.
  assert.equal(bridge.match(/marks: result\.emotionMarks/g).length, 1, 'the reply plan');
  assert.match(bridge, /continuousSpeech\(input, profile, current, signal, receiptPrepared, true, result\.emotionMarks, \{player, late\}\)/);
  assert.match(bridge, /emotionSelection\.planner\(\{player, profile: input\.profileKey, marks, late\}\)/);
  assert.match(bridge, /expressiveEmotions\.update\(settings\)/);
  const subtitles = readFileSync(new URL('../mod/subtitles.lua', import.meta.url), 'utf8');
  for (const name of EMOTION_NAMES) assert.ok(subtitles.includes(`'${name}'`), name);
  assert.match(subtitles, /gsub\('%s\*\{' \.\. name \.\. '\}', ''\)/);
});
