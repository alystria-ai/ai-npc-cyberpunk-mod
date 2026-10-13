import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {NaturalSpeech, naturalSpeechContext, parseTagged, stripSpeechTags} from './natural-speech.mjs';
import {ExpressiveEmotions, EXPRESSIVE_TEXT} from './expressive-emotions.mjs';
import {ReplyStream} from './reply-stream.mjs';
import {buildMessages} from './mistral-prompt.mjs';
import {steerText} from './inworld-steering.mjs';

// ---- Emotion on every path: the Inworld voice makes the marks wanted whatever the setting says -----------------------------------

test('the Inworld voice asks for the emotion block and keeps the marks even when Expressive emotions is off', () => {
  const emotions = new ExpressiveEmotions();
  emotions.update({expressiveEmotions: false});
  assert.equal(emotions.enabled, false); assert.equal(emotions.active, false);
  assert.equal(emotions.contextFor({engine: 'pocket'}), '', 'off, and no Inworld voice: nothing, as before');
  const marked = {text: 'Hello there.', emotionMarks: [{at: 0, name: 'joy', strength: 'subtle'}]};
  assert.equal(emotions.process(marked).emotionMarks, undefined, 'off: the marks are dropped, as before');
  let inworld = false;
  emotions.forcedBy = () => inworld;
  inworld = true;
  assert.equal(emotions.active, true); assert.equal(emotions.enabled, false, 'the player\'s setting itself is not changed');
  for (const engine of ['pocket', 'inworld', 'omni']) assert.equal(emotions.contextFor({engine}), EXPRESSIVE_TEXT, engine);
  assert.equal(emotions.contextFor({engine: 'convai'}), '', 'the Convai cloud voice would read braces aloud');
  assert.equal(emotions.contextFor({engine: 'pocket', spoken: false}), '', 'text-only turns carry no block');
  assert.deepEqual(emotions.process(marked).emotionMarks, marked.emotionMarks);
  inworld = false;
  assert.equal(emotions.active, false); assert.equal(emotions.contextFor({engine: 'pocket'}), '');
  // On by default: nothing changes for a player who has the setting on.
  const on = new ExpressiveEmotions();
  assert.equal(on.active, true); assert.equal(on.contextFor({engine: 'pocket'}), EXPRESSIVE_TEXT);
});

test('every conversation provider gets the block through the same context: Convai as one text, Mistral, Groq and Local in the notes layer', () => {
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /expressiveEmotions\.forcedBy = \(\) => localVoice\.cloud === 'inworld';/);
  assert.match(source, /block\('notes', expressiveEmotionsContext\(input\)\)/);
  assert.match(source, /const joinedContext = blocks => blocks\.map\(item => item\.text\)/);
  assert.match(source, /\.map\(tier => \[tier, joinBlocks\(blocks\.filter\(item => item\.tier === tier\)/);
  assert.match(source, /expressiveEmotions\.contextFor\(\{engine, spoken: !phone && localVoice\.playbackEnabled !== false\}\)/);
  assert.match(source, /const headMarks = expressiveEmotions\.active \? stream\.headMarks : \[\];/);
  // The text providers lay the notes layer into the system message (Mistral, Groq and Local share this builder).
  const messages = buildMessages({persona: {name: 'Judy', backstory: 'A braindance editor.', samples: []}, text: 'Hi', contextParts: {now: '', notes: EXPRESSIVE_TEXT, world: '', volatile: ''}});
  assert.ok(messages[0].content.includes(EXPRESSIVE_TEXT.slice(0, 60)), 'the block reaches the system message');
});

test('the reply is cleaned the same way on every provider: no tag ever reaches the display text, and the marks stay behind', () => {
  const speech = new NaturalSpeech();
  const raw = {text: '{sadness:strong} I am so sorry, V. {warm} But you are not alone.', sessionID: 's'};
  const out = speech.process(raw);
  assert.equal(out.text, 'I am so sorry, V. But you are not alone.');
  assert.deepEqual(out.emotionMarks.map(mark => [mark.name, mark.strength]), [['sadness', 'strong'], ['warm', 'subtle']]);
  assert.equal(out.emotionMarks[1].at, out.text.indexOf('But'));
  // A reply without tags (a model that forgot, or a provider that could not be asked) comes through untouched.
  assert.deepEqual(speech.process({text: 'Fine.', sessionID: 's'}), {text: 'Fine.', sessionID: 's'});
});

// ---- Non-verbal sounds --------------------------------------------------------------------------------------------------------

test('voice tags are located in the display text, including a trailing one, and are always stripped from what is shown', () => {
  const parsed = parseTagged('Well [sigh] I told him no, [laughter] and he came. [breathe]');
  assert.equal(parsed.display, 'Well I told him no, and he came.');
  assert.deepEqual(parsed.sounds, [{at: 5, name: 'sigh'}, {at: parsed.display.indexOf('and'), name: 'laughter'}, {at: parsed.display.length, name: 'breathe'}]);
  assert.equal(stripSpeechTags('A [question-oh] B'), 'A B');
  assert.deepEqual(parseTagged('No tags here.').sounds, []);
});

test('the sounds travel with the reply only while Natural speech is on, and the display text never has a tag either way', () => {
  const speech = new NaturalSpeech();
  const raw = '{warm} Oh, [laughter] you are something, V.';
  const off = speech.process({text: raw, sessionID: 'a'});
  assert.equal(off.text, 'Oh, you are something, V.'); assert.equal(off.voiceMarks, undefined);
  speech.update({naturalSpeech: true});
  const on = speech.process({text: raw, sessionID: 'a'});
  assert.equal(on.text, 'Oh, you are something, V.');
  assert.deepEqual(on.voiceMarks, [{at: 4, name: 'laughter'}]);
  assert.match(on.speechText, /\[laughter\]/);
});

test('sounds from OmniVoice\'s list map onto Inworld\'s where one matches; the others are removed and never spoken as words', () => {
  const raw = 'Hm [question-oh] really, [laughter] I did not know. [dissatisfaction-hnn] Fine [sigh]';
  const parsed = parseTagged(raw);
  const steered = steerText(parsed.display, [], {sounds: parsed.sounds});
  assert.equal(steered.text, 'Hm really, [laugh] I did not know. Fine [sigh]');
  assert.equal(steered.sounds, 2);
  assert.doesNotMatch(steered.text, /question|dissatisfaction|laughter/);
});

test('with Inworld speaking, Natural speech offers Inworld\'s own sounds and no OmniVoice tag', () => {
  const block = naturalSpeechContext({engine: 'inworld', trait: 'warm', profile: 'judy-alvarez', name: 'Judy', place: 'mid'});
  for (const tag of ['[laugh]', '[sigh]', '[breathe]']) assert.ok(block.includes(tag), tag);
  assert.doesNotMatch(block, /\[laughter\]|OmniVoice|confirmation-en|question-oh|surprise-ah/);
  assert.match(block, /Inworld/);
  assert.equal(block.includes('Pocket TTS'), false);
  const speech = new NaturalSpeech();
  speech.update({naturalSpeech: true});
  const offered = speech.contextFor({engine: 'inworld', sessionId: 's', turn: 't1', trait: 'warm', random: () => 0});
  assert.ok(offered.includes('[laugh]'));
  assert.equal(speech.contextFor({engine: 'inworld', spoken: false, turn: 't2'}), '');
  // A laugh in the last reply blocks the next offer, like OmniVoice's tags.
  speech.record('s', 'Ha [laugh] yes.');
  assert.equal(speech.offers('t3', 'warm', 's', () => 0).offered, false);
});

test('the sounds written inside the streamed head are kept for the voice, with the emotion marks', () => {
  const stream = new ReplyStream({name: 'Judy', isTag: text => /^\{/.test(text)});
  stream.update('{warm} Oh, [laugh] you are something, V, and I mean that. And then');
  assert.ok(stream.head, 'a head was committed');
  assert.ok(Array.isArray(stream.headSounds));
  assert.ok(stream.headSounds.every(sound => sound.at < stream.head.length && typeof sound.name === 'string'));
});
