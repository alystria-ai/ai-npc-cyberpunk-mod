import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {selectEmotion, SELECTOR_LABEL, LABEL_OF, EmotionSelection, waitLateEmotion, restingFor, mannerFor, conversationContext, PREVIOUS_MS, providerPrior}
  from './emotion-selector.mjs';
import {mixTarget} from './companion-expressions.mjs';
import {attachExpressionTrack, sampleTrack} from './expression-timeline.mjs';
import {baselineFromSignal} from './emotion-analysis.mjs';

const exchanges = name => JSON.parse(readFileSync(new URL(`../assets/emotion/exchanges-${name}.json`, import.meta.url), 'utf8'));
// The visible corner-up of a plan while speaking, through the real pose function and the character's rest/gain.
const peakSmile = (plan, profile) => Math.max(0, ...plan.segments.map(segment =>
  mixTarget({weights: segment.weights, phase: 'speaking', ...restingFor(profile)}).lips_l_corner_up));
const label = options => SELECTOR_LABEL(selectEmotion(options));
const SMILE_VISIBLE = .15;

test('Judy talking about Evelyn never smiles: every labelled Evelyn exchange reads sad (or the accepted feeling)', () => {
  const evelyn = [...exchanges('dev'), ...exchanges('holdout'), ...exchanges('blind'), ...exchanges('real')]
    .filter(item => item.profile === 'judy-alvarez' && /evelyn|evie|\bher\b/i.test(item.player + item.reply)
      && ['sadness', 'anger'].includes(item.label));
  assert.ok(evelyn.length >= 15, `Evelyn exchanges in the sets: ${evelyn.length}`);
  for (const item of evelyn) {
    const plan = selectEmotion({player: item.player, reply: item.reply, profile: item.profile});
    assert.ok(peakSmile(plan, item.profile) < SMILE_VISIBLE, `${item.id} smiles ${peakSmile(plan, item.profile)}`);
  }
  // The user's case: a sad question answered with thanks and fond words.
  const plan = selectEmotion({player: 'How are you holding up since Evelyn died?', profile: 'judy-alvarez',
    reply: "She was beautiful, V. I loved her so much. Thanks for asking, really, I'm glad you're here."});
  assert.equal(SELECTOR_LABEL(plan), 'sadness');
  assert.equal(peakSmile(plan, 'judy-alvarez'), 0);
});

test('the resting face is neutral and a smile needs a real cue', () => {
  for (const reply of ['Meet me at the Afterlife at nine.', 'Sure, sounds good.', 'Yeah, fine. The booth is upstairs.']) {
    const plan = selectEmotion({reply, profile: 'judy-alvarez'});
    assert.equal(SELECTOR_LABEL(plan), 'calm', reply);
    assert.equal(peakSmile(plan, 'judy-alvarez'), 0, reply);
    assert.deepEqual(plan.baseline, {});
  }
  // Forms of address are not smiles ("choom", "V").
  assert.equal(label({reply: 'Alright, choom. See you there, V.', profile: 'jackie-welles'}), 'calm');
  // Laughter, delight and celebration do smile.
  assert.equal(label({reply: "Haha, that's preem!", profile: 'judy-alvarez'}), 'joy');
  assert.equal(label({player: 'We pulled it off!', reply: 'Hell yeah! Best run of my life!', profile: 'kerry-eurodyne'}), 'joy');
  assert.ok(peakSmile(selectEmotion({reply: "Haha, that's preem!", profile: 'judy-alvarez'}), 'judy-alvarez') > .3);
  assert.deepEqual(restingFor('judy-alvarez'), {warmth: 0, gain: 1.6});
  assert.deepEqual(restingFor('anyone'), {warmth: 0, gain: 1});
});

test('the player\'s message sets the frame: the same reply is sad after a sad question', () => {
  const reply = 'Some days are easier than others. Thanks for asking.';
  assert.equal(label({player: 'How are you holding up since Evelyn died?', reply, profile: 'judy-alvarez'}), 'sadness');
  assert.notEqual(label({player: 'How was work today?', reply, profile: 'judy-alvarez'}), 'sadness');
  assert.ok(conversationContext({player: 'Do you regret what happened with Alt?'}).evidence.includes('sore-question'));
  assert.equal(conversationContext({player: "I'm sorry about Mitch."}).grief, true, 'condolence for a named person');
  // Death idioms are not a loss.
  assert.equal(conversationContext({reply: 'Over my dead body.'}).grief, false);
  assert.equal(label({reply: 'Over my dead body. Find someone else.', profile: 'kerry-eurodyne'}), 'anger');
  assert.equal(conversationContext({player: 'That braindance was insane, I almost died laughing.'}).grief, false);
});

test('empathy, regret, concern, negation and sarcasm', () => {
  assert.equal(label({reply: 'I am sorry, V. That must have been hard.', profile: 'takemura'}), 'sadness', '"I am" = "I\'m"');
  assert.equal(label({reply: "If I'd just picked up when she called, she'd still be here.", profile: 'judy-alvarez'}), 'sadness');
  assert.equal(label({reply: 'Are you okay? You look pale. Talk to me.', profile: 'panam-palmer'}), 'fear');
  assert.notEqual(label({reply: "I'm not happy about this.", profile: 'judy-alvarez'}), 'joy');
  const sarcasm = selectEmotion({reply: 'Oh sure, because that always works. Brilliant plan.', profile: 'rogue-amendiares'});
  assert.equal(SELECTOR_LABEL(sarcasm), 'disgust');
  assert.equal(peakSmile(sarcasm, 'rogue-amendiares'), 0);
  assert.equal(label({reply: "Wait, what? It was you? I never would have guessed.", profile: 'panam-palmer'}), 'surprise');
  assert.equal(label({reply: "I've got your back, always. You're not alone in this.", profile: 'jackie-welles'}), 'warm');
});

test('priority: a specific tag names the feeling; {calm} and {interest} are not evidence; then Convai\'s label and the text', () => {
  const reply = 'Haha, nice one. Anyway, the job is tomorrow.';
  // A {sadness} tag at the second sentence: that segment follows the tag, the first keeps the text reading.
  const at = reply.indexOf('Anyway');
  const tagged = selectEmotion({reply, profile: 'judy-alvarez', marks: [{at, name: 'sadness'}]});
  const marked = tagged.segments.find(segment => segment.start >= at);
  assert.deepEqual(Object.keys(marked.weights), ['sadness']);
  assert.ok(marked.tags.includes('llm-emotion'));
  assert.ok(tagged.segments[0].weights.joy > 0);
  // {calm} is the character's habitual opener (52 % of real replies): it no longer silences a clear Convai label or
  // the text, and on a line with nothing to show it stays neutral.
  const calm = selectEmotion({reply, profile: 'judy-alvarez', marks: [{at: 0, name: 'calm'}],
    convai: {emotion: 'Joy', scale: 3, basis: 'ordered'}});
  assert.ok(calm.segments[0].weights.joy > .3, 'a calm tag does not wipe Convai Joy/3');
  assert.ok(calm.segments[0].tags.includes('llm-calm'));
  const flat = selectEmotion({reply: 'Meet me at the Afterlife at nine.', profile: 'judy-alvarez', marks: [{at: 0, name: 'calm'}]});
  for (const segment of flat.segments) assert.deepEqual(segment.weights, {});
  // {interest} is not a flat anticipation .6 on every question either.
  const interest = selectEmotion({reply: 'Meet me at the Afterlife at nine.', profile: 'judy-alvarez', marks: [{at: 0, name: 'interest', strength: 'subtle'}]});
  assert.equal(SELECTOR_LABEL(interest), 'calm');
  assert.ok(interest.segments[0].tags.includes('llm-interest'));
  // A specific tag still names the feeling, strong ones more than subtle ones.
  const subtle = selectEmotion({reply: 'Meet me at the Afterlife at nine.', profile: 'judy-alvarez', marks: [{at: 0, name: 'fear'}]});
  const strong = selectEmotion({reply: 'Meet me at the Afterlife at nine.', profile: 'judy-alvarez', marks: [{at: 0, name: 'fear', strength: 'strong'}]});
  assert.equal(SELECTOR_LABEL(subtle), 'fear');
  assert.ok(strong.segments[0].weights.fear > subtle.segments[0].weights.fear);
  // Convai's label fills a reply the text cannot read, and damps a contradicting smile.
  const plain = selectEmotion({reply: 'Meet me at the Afterlife at nine.', profile: 'judy-alvarez',
    convai: {emotion: 'Sadness', scale: 2, basis: 'ordered'}});
  assert.equal(SELECTOR_LABEL(plain), 'sadness');
  assert.ok(plain.evidence.includes('convai:sadness'));
  const damped = selectEmotion({reply: 'Nice. Good to see you.', profile: 'judy-alvarez', convai: {emotion: 'Grief', scale: 3, basis: 'ordered'}});
  assert.ok(peakSmile(damped, 'judy-alvarez') < SMILE_VISIBLE);
  // Our own text cue is never treated as Convai's (basis text/calm is ignored).
  assert.equal(baselineFromSignal({emotion: 'Joy', scale: 3, basis: 'text'}), undefined);
  assert.equal(SELECTOR_LABEL(selectEmotion({reply: 'Meet me at nine.', profile: 'judy-alvarez',
    convai: {emotion: 'Joy', scale: 3, basis: 'text'}})), 'calm');
});

test('the previous turn\'s mood carries into a short follow-up, and the character\'s manner scales the face', () => {
  const follow = {player: 'What else do you remember?', reply: 'She used to sing in the kitchen at night.', profile: 'judy-alvarez'};
  assert.equal(label(follow), 'calm');
  assert.equal(label({...follow, previous: {family: 'sadness', weight: .5, ageMs: 30000}}), 'sadness');
  assert.equal(label({...follow, previous: {family: 'sadness', weight: .5, ageMs: PREVIOUS_MS + 1}}), 'calm');
  assert.equal(mannerFor('kerry-eurodyne'), 'expressive');
  assert.equal(mannerFor('takemura'), 'reserved');
  assert.equal(mannerFor('adam-smasher'), 'cold');
  assert.equal(mannerFor('some-vendor'), 'open');
  const loud = selectEmotion({reply: 'I am furious. Those bastards will pay.', profile: 'kerry-eurodyne'});
  const quiet = selectEmotion({reply: 'I am furious. Those bastards will pay.', profile: 'takemura'});
  assert.ok(loud.summary.weight > quiet.summary.weight);
});

test('the plan has the timeline shape: it aligns to audio and samples per family', () => {
  const plan = selectEmotion({player: 'How are you holding up?', reply: "I'm okay. It still hurts some days, though.", profile: 'judy-alvarez'});
  const face = attachExpressionTrack({duration: 3, complete: true, tracks: ['jaw_mid_open'], frames: [[0, .2], [1.5, 0], [1.9, 0], [3, .2]]}, plan);
  assert.equal(face.expressionTrack.format, 'emotion-mix-v1');
  const sad = sampleTrack(face.expressionTrack, 2.5)[2];
  assert.ok(sad > .2, `sadness at 2.5 s: ${sad}`);
  for (const nothing of ['', '   ', null, undefined, 'x'.repeat(12001)]) assert.equal(selectEmotion({reply: nothing}), undefined);
});

test('EmotionSelection: settings fallback, previous mood memory and the stream planner\'s late Convai label', () => {
  let now = 1000;
  const selection = new EmotionSelection({now: () => now});
  assert.equal(selection.mode, 'context');
  assert.equal(selection.update({emotionSelector: 'legacy'}), true);
  const legacy = selection.plan({reply: 'Meet me at the Afterlife at nine.', profile: 'judy-alvarez'});
  assert.equal(legacy.selector, undefined, 'the previous planner');
  assert.deepEqual(legacy.baseline, {trust: .67}, 'with its warm resting smile');
  assert.equal(selection.update({}), true);
  assert.equal(selection.mode, 'context');
  assert.equal(selection.update(null), false);
  // Previous mood: kept per character for three minutes; a calm reply clears it.
  selection.remember('judy-alvarez', selection.plan({player: 'Do you miss Evelyn?', reply: 'Every day. It still hurts.', profile: 'judy-alvarez'}));
  assert.equal(selection.previous('judy-alvarez').family, 'sadness');
  now += PREVIOUS_MS;
  assert.equal(selection.previous('judy-alvarez'), undefined);
  selection.remember('judy-alvarez', selection.plan({reply: 'Every day. It still hurts.', profile: 'judy-alvarez'}));
  const first = selection.previous('judy-alvarez');
  // A carried mood fades instead of renewing itself: weaker each plain reply, never a newer time, then gone.
  now += 1000;
  selection.remember('judy-alvarez', selection.plan({reply: 'Meet me at nine.', profile: 'judy-alvarez'}));
  const carried = selection.previous('judy-alvarez');
  assert.ok(!carried || (carried.weight < first.weight && carried.ageMs === first.ageMs + 1000));
  for (let turn = 0; turn < 3; turn++) selection.remember('judy-alvarez', selection.plan({reply: 'Meet me at nine.', profile: 'judy-alvarez'}));
  assert.equal(selection.previous('judy-alvarez'), undefined);
  // The stream planner re-plans when Convai's late label is set on the shared holder.
  const late = {signal: undefined};
  const planner = selection.planner({player: 'Meet me later?', profile: 'judy-alvarez', late});
  const before = planner('Meet me at the Afterlife at nine.');
  assert.equal(SELECTOR_LABEL(before), 'calm');
  assert.equal(planner('Meet me at the Afterlife at nine.'), before, 'cached while nothing changed');
  late.signal = {version: 1, correlated: true, sequence: 0, emotion: 'Sadness', scale: 2, basis: 'ordered'};
  assert.equal(SELECTOR_LABEL(planner('Meet me at the Afterlife at nine.')), 'sadness');
  // The stream's own provider signal (a Convai-voiced turn) wins over the holder.
  assert.equal(SELECTOR_LABEL(planner('Meet me at the Afterlife at nine.', {emotion: 'Joy', scale: 3, basis: 'ordered'})), 'joy');
});

test('waitLateEmotion polls until the label, stops when it cannot arrive, and never rejects', async () => {
  const wait = async () => {};
  const states = [{pending: true}, {pending: true}, {signal: {emotion: 'Sadness', scale: 2}}];
  assert.deepEqual(await waitLateEmotion(async () => states.shift(), {wait}), {emotion: 'Sadness', scale: 2});
  let reads = 0;
  assert.equal(await waitLateEmotion(async () => { reads++; return {}; }, {wait}), undefined);
  assert.equal(reads, 1);
  assert.equal(await waitLateEmotion(async () => { throw Error('page gone'); }, {wait}), undefined);
  assert.equal(await waitLateEmotion(async () => ({pending: true}), {deadlineMs: 0, wait}), undefined);
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await waitLateEmotion(async () => ({pending: true}), {signal: aborted.signal, wait}), undefined);
});

// Regression floors on the labelled sets (scripts/Evaluate-EmotionSelector.mjs prints the full report).
test('labelled sets: accuracy floors, false smiles on sad/afraid/angry/disgusted replies, and cost', () => {
  for (const [name, floor] of [['dev', .85], ['holdout', .85], ['blind', .85], ['real', .65]]) {
    const items = exchanges(name);
    let acceptable = 0, falseSmiles = 0;
    const started = performance.now();
    for (const item of items) {
      const plan = selectEmotion({player: item.player, reply: item.reply, profile: item.profile});
      const chosen = SELECTOR_LABEL(plan);
      if (chosen === item.label || item.accept.includes(chosen)) acceptable++;
      if (['sadness', 'fear', 'anger', 'disgust', 'calm'].includes(item.label) && peakSmile(plan, item.profile) >= SMILE_VISIBLE) falseSmiles++;
    }
    const ms = (performance.now() - started) / items.length;
    assert.ok(acceptable / items.length >= floor, `${name}: ${acceptable}/${items.length} acceptable`);
    assert.ok(falseSmiles <= 3, `${name}: ${falseSmiles} false smiles`);
    assert.ok(ms < 10, `${name}: ${ms.toFixed(2)} ms per reply`);
  }
  // Real replies with Convai's own late label as the prior.
  const real = exchanges('real');
  let acceptable = 0;
  for (const item of real) {
    const chosen = SELECTOR_LABEL(selectEmotion({player: item.player, reply: item.reply, profile: item.profile,
      convai: item.convai ? {...item.convai, basis: 'ordered'} : undefined}));
    if (chosen === item.label || item.accept.includes(chosen)) acceptable++;
  }
  assert.ok(acceptable / real.length >= .85, `real + Convai: ${acceptable}/${real.length}`);
});

test('the Convai label is a reply-level prior whose strength follows how informative it is', () => {
  assert.equal(providerPrior({emotion: 'Neutral', scale: 1, basis: 'ordered'}), undefined);
  assert.equal(providerPrior({emotion: 'Joy', scale: 3, basis: 'text'}), undefined, 'our own text cue is never Convai');
  const joy = providerPrior({emotion: 'Joy', scale: 3, basis: 'ordered'});
  assert.equal(joy.family, 'joy');
  assert.ok(joy.weight >= .4);
  assert.ok(providerPrior({emotion: 'Interest', scale: 1, basis: 'ordered'}).weight < .2, 'a gentle label alone stays under the visible threshold');
  assert.equal(providerPrior({emotion: 'Annoyance', scale: 1, basis: 'ordered'}).family, 'anger');
});

test('guarded denials read wary, a stern one-word warning frowns, and plain logistics stay neutral', () => {
  const question = "Evelyn Parker was captured by Maelstrom, wasn't she? What do you know?";
  const denial = selectEmotion({player: question, profile: 'evelyn-parker', marks: [{at: 0, name: 'calm'}],
    reply: 'I have no idea what you are talking about. Who told you I was captured?'});
  assert.ok(denial.segments.every(segment => (segment.weights.fear || 0) >= .3), 'wary, not blank');
  assert.ok(denial.segments.every(segment => !segment.weights.joy && !segment.weights.trust));
  const careful = selectEmotion({player: 'You look like trouble.', reply: 'Careful.', profile: 'alex', convai: {emotion: 'Annoyance', scale: 1, basis: 'ordered'}});
  assert.equal(SELECTOR_LABEL(careful), 'anger');
  assert.ok(careful.segments[0].weights.anger >= .35, 'visible, not under the threshold');
  for (const reply of ['The garage on Jig-Jig street. Nine sharp. Bring the cash.', 'It is on the third floor.']) {
    assert.equal(label({player: 'Where do we meet?', reply, profile: 'alex', marks: [{at: 0, name: 'calm'}]}), 'calm', reply);
  }
});

test('abstract trust and denied feelings are not the speaker feeling', () => {
  assert.equal(label({player: 'Can I trust you?', reply: 'Trust is earned, not given. Keep that in mind.', profile: 'alex'}), 'calm');
  assert.notEqual(label({reply: "I don't get paid to be scared.", profile: 'alex'}), 'fear');
});

test('the speaker own name is not a loss cue', () => {
  const asked = selectEmotion({player: 'Tell me about Evelyn.', reply: 'It is a long story.', profile: 'evelyn-parker'});
  assert.ok(!asked.evidence.some(item => item.startsWith('grief')));
  const judy = selectEmotion({player: 'Tell me about Evelyn.', reply: 'She was kind, and she was mine.', profile: 'judy-alvarez'});
  assert.ok(judy.evidence.some(item => item.startsWith('grief')));
});

test('spans from a tagger win, and the picker fills only the untagged stretches', () => {
  const reply = 'Haha, nice one. Anyway, I do not like this. Meet me at nine.';
  const from = reply.indexOf('Anyway'), to = reply.indexOf('Meet');
  const plan = selectEmotion({reply, profile: 'judy-alvarez', spans: [{start: from, end: to, emotion: 'sadness', intensity: .7}]});
  const inside = plan.segments.filter(segment => segment.start >= from && segment.end <= to);
  assert.ok(inside.length >= 1);
  for (const segment of inside) { assert.deepEqual(segment.weights, {sadness: .7}); assert.deepEqual(segment.tags, ['tagged-span']); }
  // Outside the span the picker still reads the words (the laugh) and the closing line carries no sadness.
  assert.ok(plan.segments[0].weights.joy > 0);
  assert.ok(!plan.segments.at(-1).weights.sadness, 'the tagged sadness stops at the span');
  // The span edges are segment edges even inside one sentence.
  const edge = selectEmotion({reply: 'I really do not know what to say to that.', profile: 'judy-alvarez', spans: [{start: 0, end: 15, emotion: 'fear', intensity: 2}]});
  assert.ok(edge.segments.length >= 2 && edge.segments[0].end <= 16);
  // calm is an explicit neutral face that beats a Convai label; unknown names and bad spans are ignored.
  const calm = selectEmotion({reply: 'Nice. Good to see you.', profile: 'judy-alvarez', spans: [{start: 0, end: 22, emotion: 'calm', intensity: 0}],
    convai: {emotion: 'Joy', scale: 3, basis: 'ordered'}});
  for (const segment of calm.segments) assert.deepEqual(segment.weights, {});
  const ignored = selectEmotion({reply: 'Nice. Good to see you.', profile: 'judy-alvarez', spans: [{start: 5, end: 2, emotion: 'joy'}, {start: 0, end: 5, emotion: 'bogus'}, null]});
  assert.ok(ignored.segments.every(segment => !segment.tags.includes('tagged-span')));
});

test('the labelled per-segment set (assets/emotion/segments-gold.json) holds the picker above its floors', () => {
  const file = JSON.parse(readFileSync(new URL('../assets/emotion/segments-gold.json', import.meta.url), 'utf8'));
  assert.ok(file.units.length >= 1500, 'a few thousand real labelled segments');
  const rows = new Map();
  for (const unit of file.units) { if (!rows.has(unit.reply)) rows.set(unit.reply, []); rows.get(unit.reply).push(unit); }
  const run = withTags => {
    let n = 0, ok = 0, emote = 0, deadEmote = 0;
    const started = performance.now();
    for (const [id, group] of rows) {
      const reply = file.replies[id];
      const plan = selectEmotion({player: reply.player, reply: reply.text, profile: reply.profile, marks: withTags ? reply.marks : undefined,
        convai: withTags && reply.convai ? {...reply.convai, basis: 'ordered'} : undefined, breaks: group.slice(1).map(unit => unit.from)});
      for (const unit of group) {
        const middle = (unit.from + unit.to) / 2;
        const segment = plan.segments.find(item => item.start <= middle && middle < item.end + 1) ?? plan.segments.at(-1);
        const [family, weight] = Object.entries(segment.weights).sort((a, b) => b[1] - a[1])[0] ?? [];
        const shown = family && weight >= .2 ? LABEL_OF[family] : 'calm';
        n++;
        if (shown === unit.label || unit.accept.includes(shown)) ok++;
        if (unit.label !== 'calm') { emote++; if (shown === 'calm') deadEmote++; }
      }
    }
    return {accuracy: ok / n, deadGivenEmoting: deadEmote / emote, ms: (performance.now() - started) / rows.size};
  };
  const game = run(true), text = run(false);
  assert.ok(game.accuracy >= .66, 'tags + Convai: ' + game.accuracy);
  assert.ok(game.deadGivenEmoting <= .36, 'dead on lines that should show a feeling: ' + game.deadGivenEmoting);
  assert.ok(text.accuracy >= .55, 'text only: ' + text.accuracy);
  assert.ok(game.ms < 10, game.ms + ' ms per reply');
});

test("spans in the tag parser's shape: intensity 1/2, a null emotion leaves the stretch to the picker", () => {
  const text = "Nice one. Careful with that. Meet me at nine.";
  const spans = [{start: 0, end: 10, emotion: null, intensity: 0}, {start: 10, end: 29, emotion: "anger", intensity: 2}, {start: 29, end: text.length, emotion: "calm", intensity: 1}];
  const plan = selectEmotion({reply: text, profile: "judy-alvarez", spans});
  const careful = plan.segments.find(segment => text.slice(segment.start, segment.end).includes("Careful"));
  assert.deepEqual(careful.weights, {anger: 1});
  const open = selectEmotion({reply: "Haha, nice one. Meet me at nine.", profile: "judy-alvarez", spans: [{start: 0, end: 32, emotion: null, intensity: 0}]});
  assert.ok(open.segments[0].weights.joy > 0, "a null span is untagged: the picker reads the laugh");
});
