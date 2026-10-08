import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FollowUp, FOLLOW_UP_TEXT, OFFER_RATE, PITY_TURNS, endsWithQuestion, playerIsEnding, playerGivesOrder} from './follow-up.mjs';
import {MultilingualConversations} from './multilingual.mjs';

const ALWAYS = () => 0, NEVER = () => .999;
const on = () => { const followUp = new FollowUp(); followUp.update({followUpInterest: true}); return followUp; };
let serial = 0;
// One conversation turn: decide, then (as the bridge does after the reply) record whether the reply ended in a question.
const turn = (followUp, options = {}) => {
  const {reply = 'A plain reply.', ...rest} = options;
  const id = `t${++serial}`;
  const block = followUp.contextFor({sessionId: 's', turn: id, trait: 'warm', text: 'I fixed the car myself.', random: ALWAYS, ...rest});
  followUp.record(rest.sessionId ?? 's', reply);
  return {block, reason: followUp.reasonFor(id)};
};

// ---- the setting: off by default, and then nothing changes ---------------------------------------------------

test('Follow-up questions is off by default: no block, no state, and a missing or odd settings value leaves it off', () => {
  const followUp = new FollowUp();
  assert.equal(followUp.enabled, false);
  for (const trait of ['warm', 'neutral', 'dry', 'cold']) {
    assert.equal(followUp.contextFor({sessionId: 's', turn: 't', trait, text: 'hello', random: ALWAYS}), '');
  }
  assert.equal(followUp.record('s', 'How are you?'), true, 'the answer is still computed for a log line');
  assert.equal(followUp.state.size, 0);
  assert.equal(followUp.decisions.size, 0);
  assert.equal(followUp.update(undefined), false, 'a missing or unreadable settings file leaves it as it was');
  assert.equal(followUp.update({voice: true}), false);
  assert.equal(followUp.update({followUpInterest: 'yes'}), false, 'only an explicit true turns it on');
  assert.equal(followUp.update({followUpQuestions: true}), false, 'the retired followUpQuestions key means nothing');
  assert.equal(followUp.enabled, false);
});

test('the setting follows runtime/settings.json, a change is reported once, and turning it off forgets the conversations', () => {
  const followUp = new FollowUp();
  assert.equal(followUp.update({followUpInterest: true}), true);
  assert.equal(followUp.update({followUpInterest: true}), false);
  turn(followUp);
  assert.ok(followUp.state.size && followUp.decisions.size);
  assert.equal(followUp.update({followUpInterest: false}), true);
  assert.equal(followUp.enabled, false);
  assert.equal(followUp.state.size + followUp.decisions.size, 0);
  assert.equal(followUp.contextFor({sessionId: 's', turn: 'x', trait: 'warm', text: 'hi', random: ALWAYS}), '');
});

test('off, the context the bridge builds is byte-identical to the one without the feature', () => {
  const base = ['intrinsic', 'archetype', 'relationship', 'natural speech', 'expressive emotions'];
  const languageBlock = new MultilingualConversations();
  languageBlock.update({multilingualConversations: true});
  for (const language of [new MultilingualConversations(), languageBlock]) {
    const without = [...base, language.contextFor('hola, cómo estás')].filter(Boolean).join('\n\n');
    const withOff = [...base, new FollowUp().contextFor({sessionId: 's', turn: 't', trait: 'warm', text: 'hola', random: ALWAYS}),
      language.contextFor('hola, cómo estás')].filter(Boolean).join('\n\n');
    assert.equal(withOff, without);
  }
});

// ---- the block ----------------------------------------------------------------------------------------------

test('the block asks for a pull inside this one reply, in the character\'s voice, and never for an interrogation', () => {
  for (const phrase of ['For this reply only', 'does not apply', 'interested in the player', 'Answer what they said first',
    'in the same breath', 'one short line', 'the one thing you actually want to know about what they just said or did',
    'earlier in your conversation', 'story of your own that invites a reply', 'one question at most',
    'never a choice between two alternatives', 'never a therapist', 'never a detail they did not give you',
    'part of this one reply, not an extra message', 'never feels tacked on', 'nothing in it needs a second message from you',
    'your own voice and manner', 'bluntly', 'warmly', 'Never interrogate', '"what about you?"', '"anything else?"',
    'not the same question handed back', 'does not have to be a question', 'just listening', 'wrapping up']) {
    assert.ok(FOLLOW_UP_TEXT.includes(phrase), phrase);
  }
  // No tags, no brackets, no mention of the setting, and no length limit (the user: longer replies are fine).
  assert.ok(!/[\[\]{}]/.test(FOLLOW_UP_TEXT));
  assert.ok(!/setting|words|seconds|sentences? (?:long|at most)/i.test(FOLLOW_UP_TEXT));
});

// ---- the rate, never two in a row, the pity rule ---------------------------------------------------------------

test('the rate follows the character\'s trait, and an offered turn is followed by an unoffered one', () => {
  assert.deepEqual(OFFER_RATE, {warm: .45, neutral: .35, dry: .20, cold: .15});
  const followUp = on();
  const ask = (trait, random, n) => followUp.contextFor({sessionId: `r-${trait}-${random()}`, turn: `r${++serial}`, trait, text: 'I fixed the car.', random});
  for (const trait of Object.keys(OFFER_RATE)) {
    assert.equal(ask(trait, ALWAYS), FOLLOW_UP_TEXT, `${trait}: the dice say yes`);
    assert.equal(ask(trait, NEVER), '', `${trait}: the dice say no`);
  }
  // Just under and just over each trait's rate.
  for (const [trait, rate] of Object.entries(OFFER_RATE)) {
    assert.ok(followUp.contextFor({sessionId: 'u' + trait, turn: 'u' + trait, trait, text: 'hi', random: () => rate - .001}));
    assert.equal(followUp.contextFor({sessionId: 'o' + trait, turn: 'o' + trait, trait, text: 'hi', random: () => rate + .001}), '');
  }
  // Never two in a row, whatever the dice say.
  const flags = [];
  for (let n = 0; n < 40; n++) flags.push(turn(followUp, {random: ALWAYS, trait: 'warm'}).block !== '');
  assert.ok(flags.every((flag, n) => !(flag && flags[n - 1])), 'never two in a row');
  assert.ok(flags.filter(Boolean).length >= 19, 'but every other turn when the dice always say yes');
});

test('the share of offered turns over a long chat is below the dice rate (never two in a row) and above zero', () => {
  let seed = 7;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const share = trait => {
    const followUp = on();
    let offered = 0;
    for (let n = 0; n < 4000; n++) offered += turn(followUp, {trait, random, reply: 'Plain reply.'}).block ? 1 : 0;
    return offered / 4000;
  };
  const shares = Object.fromEntries(Object.keys(OFFER_RATE).map(trait => [trait, share(trait)]));
  assert.ok(shares.warm > shares.neutral && shares.neutral > shares.dry && shares.dry > shares.cold, JSON.stringify(shares));
  for (const trait of Object.keys(OFFER_RATE)) assert.ok(shares[trait] > 0 && shares[trait] < OFFER_RATE[trait] + .09, `${trait} ${shares[trait]}`);
  assert.ok(shares.warm >= .30 && shares.warm <= .45, `a warm character pulls on roughly 30-40% of turns: ${shares.warm}`);
});

test('a warm or neutral character is offered a pull at least once in any five turns; a dry or cold one is not forced', () => {
  assert.equal(PITY_TURNS, 5);
  for (const trait of ['warm', 'neutral']) {
    const followUp = on(), flags = [], reasons = [];
    for (let n = 0; n < 40; n++) { const {block, reason} = turn(followUp, {trait, random: NEVER, sessionId: trait}); flags.push(block !== ''); reasons.push(reason); }
    for (let n = 0; n + PITY_TURNS <= flags.length; n++) assert.ok(flags.slice(n, n + PITY_TURNS).some(Boolean), `${trait}: window at ${n}`);
    assert.deepEqual(reasons.slice(0, 5), ['rate', 'rate', 'rate', 'rate', 'pity']);
  }
  for (const trait of ['dry', 'cold']) {
    const followUp = on();
    for (let n = 0; n < 40; n++) assert.equal(turn(followUp, {trait, random: NEVER, sessionId: trait}).block, '', trait);
  }
});

test('one decision per request id: a rebuilt or repeated context agrees with the one already sent and counts once', () => {
  const followUp = on();
  const ask = (id, random) => followUp.contextFor({sessionId: 's', turn: id, trait: 'warm', text: 'I fixed the car.', random});
  assert.equal(ask('a', ALWAYS), FOLLOW_UP_TEXT);
  for (let n = 0; n < 5; n++) assert.equal(ask('a', NEVER), FOLLOW_UP_TEXT, 'the same turn, asked again');
  assert.equal(followUp.reasonFor('a'), 'rate');
  assert.equal(followUp.offeredFor('a'), true);
  assert.equal(ask('b', ALWAYS), '', 'the next turn follows an offered one');
  assert.equal(followUp.reasonFor('b'), 'after-offer');
  assert.equal(followUp.state.get('s').since, 1, 'the repeats of turn a did not count as turns');
  // A context rebuilt without a request id decides, but changes no state.
  const before = JSON.stringify([...followUp.state]);
  followUp.contextFor({sessionId: 's', trait: 'warm', text: 'hi', random: ALWAYS});
  assert.equal(JSON.stringify([...followUp.state]), before);
  assert.equal(followUp.reasonFor('never-asked'), undefined);
  assert.equal(followUp.offeredFor(undefined), false);
});

test('state is kept per conversation and bounded', () => {
  const followUp = on();
  followUp.contextFor({sessionId: 'a', turn: 'x1', trait: 'warm', text: 'hi', random: ALWAYS});
  assert.equal(followUp.contextFor({sessionId: 'b', turn: 'x2', trait: 'warm', text: 'hi', random: ALWAYS}), FOLLOW_UP_TEXT, 'another conversation is unaffected');
  assert.equal(followUp.contextFor({sessionId: 'a', turn: 'x3', trait: 'warm', text: 'hi', random: ALWAYS}), '');
  for (let n = 0; n < 200; n++) { followUp.contextFor({sessionId: `c${n}`, turn: `y${n}`, trait: 'warm', text: 'hi', random: ALWAYS}); followUp.record(`d${n}`, 'Why?'); }
  assert.ok(followUp.state.size <= 64 && followUp.decisions.size <= 64, 'bounded');
});

// ---- when a pull is never offered --------------------------------------------------------------------------------

test('never on an automatic reaction or bark, and a reaction does not count as a conversation turn', () => {
  const followUp = on();
  const reaction = {kind: 'battle', phase: 'start'};
  assert.equal(followUp.contextFor({sessionId: 's', turn: 'r1', trait: 'warm', text: 'The player has just entered combat.', reaction, random: ALWAYS}), '');
  assert.equal(followUp.reasonFor('r1'), 'reaction');
  assert.equal(followUp.contextFor({sessionId: 's', turn: 'r2', trait: 'warm', text: 'hi', reaction: true, random: ALWAYS}), '');
  assert.equal(followUp.state.size, 0, 'no state for a reaction');
  // The first real turn after reactions is still allowed (a reaction is not "the previous turn offered").
  assert.equal(followUp.contextFor({sessionId: 's', turn: 'r3', trait: 'warm', text: 'I fixed the car.', random: ALWAYS}), FOLLOW_UP_TEXT);
});

test('never on a battle turn, in a group round, or when the fight is over', () => {
  const followUp = on();
  const ask = (extra, id) => followUp.contextFor({sessionId: id, turn: id, trait: 'warm', text: 'I fixed the car.', random: ALWAYS, ...extra});
  assert.equal(ask({battle: {version: 1, status: 'fighting'}}, 'b1'), '');
  assert.equal(followUp.reasonFor('b1'), 'battle');
  assert.equal(ask({group: true}, 'g1'), '');
  assert.equal(followUp.reasonFor('g1'), 'group');
  for (const status of ['none', 'unavailable', 'ended']) assert.equal(ask({battle: {version: 1, status}}, `b-${status}`), FOLLOW_UP_TEXT, status);
});

test('never when the player is saying goodbye, in any of the supported languages', () => {
  const goodbyes = ['Alright, I am heading out. Good night, see you tomorrow.', 'Bye!', 'goodbye', 'Gotta go, talk later.', 'See you later, Judy.',
    "I'm off.", 'Take care.', 'Hasta luego.', 'Buenas noches, nos vemos mañana.', 'Tchau, até amanhã!', 'Au revoir, à demain.',
    'Tschüss!', 'Gute Nacht.', 'Ciao, ci vediamo!', 'おやすみ。', 'じゃあね', '안녕히 가세요.', '再见，晚安。', 'Пока!', 'До свидания.', 'Спокойной ночи.'];
  for (const text of goodbyes) assert.equal(playerIsEnding(text), true, text);
  const followUp = on();
  assert.equal(followUp.contextFor({sessionId: 's', turn: 'e1', trait: 'warm', text: goodbyes[0], random: ALWAYS}), '');
  assert.equal(followUp.reasonFor('e1'), 'ending');
  // Ordinary talk that merely contains similar letters or words is not an ending.
  for (const text of ['I made it out of that fight with one bullet left.', 'That was the worst noodle stand in the whole district.',
    'Tell me the truth. Am I making things worse?', 'Tonight I want to hear about the Afterlife.', 'Bypass the checkpoint',
    'What do you think of the new subway?', 'Hey, how are you holding up today?']) assert.equal(playerIsEnding(text), false, text);
  assert.equal(playerIsEnding(undefined), false);
});

test('never when the player gives an order or makes a request, in any of the supported languages; questions are not orders', () => {
  const orders = ['Follow me, we are going to the car.', 'Wait here a second, I need to check something.', 'Stay here.', 'Go home.', 'Can you wait here?',
    'Could you take me to the clinic?', 'I need you to open the door.', 'Please come with me.', 'You can go now.', "Let's go home.", 'Get in the car.',
    'Sígueme.', 'Espérame aquí.', 'Fica aqui.', 'Suis-moi.', 'Attends ici.', 'Folge mir.', 'Warte hier.', 'Seguimi.', 'ついてきて', '待って', '따라와', '跟我来',
    'Иди за мной.', 'Подожди.'];
  for (const text of orders) assert.equal(playerGivesOrder(text), true, text);
  const followUp = on();
  assert.equal(followUp.contextFor({sessionId: 's', turn: 'o1', trait: 'warm', text: orders[0], random: ALWAYS}), '');
  assert.equal(followUp.reasonFor('o1'), 'order');
  for (const text of ['Can you explain how a braindance editor works?', 'Do you miss anyone?', 'Waiting for the rain to stop is the worst.',
    'The waitress said hi.', 'Come on, tell me more.', 'Stay safe out there.', 'Run me through the plan.', 'Go ahead and tell me.',
    'Stop being so cryptic.', 'I stayed up all night reading about old music.', 'What is for dinner?']) assert.equal(playerGivesOrder(text), false, text);
  assert.equal(playerGivesOrder(null), false);
});

test('never right after a reply that ended in a question, and the next turn after that is free again', () => {
  const followUp = on();
  const first = turn(followUp, {random: NEVER, trait: 'cold', reply: 'Fine. And you, what happened to your arm?'});
  assert.equal(first.block, '');
  const second = turn(followUp, {random: ALWAYS, trait: 'warm', reply: 'Okay.'});
  assert.equal(second.block, '');
  assert.equal(second.reason, 'after-question');
  const third = turn(followUp, {random: ALWAYS, trait: 'warm', reply: 'Mm.'});
  assert.equal(third.block, FOLLOW_UP_TEXT);
  // The pity rule does not override it: a due character still waits one turn.
  const due = on();
  for (let n = 0; n < 4; n++) turn(due, {random: NEVER, trait: 'warm', reply: 'Okay.'});
  turn(due, {random: NEVER, trait: 'warm', reply: 'And what about you?'});
  const after = turn(due, {random: NEVER, trait: 'warm', reply: 'Okay.'});
  assert.ok(after.block === '' || after.reason === 'pity');
});

test('the order of the checks: reaction, battle, group, ending, order, after-offer, after-question, then pity and rate', () => {
  const followUp = on();
  followUp.record('s', 'Why?');
  const reason = (extra, id) => { followUp.contextFor({sessionId: 's', turn: id, trait: 'warm', text: 'hi', random: ALWAYS, ...extra}); return followUp.reasonFor(id); };
  assert.equal(reason({reaction: true, battle: {status: 'fighting'}, text: 'bye'}, 'k1'), 'reaction');
  assert.equal(reason({battle: {status: 'fighting'}, group: true, text: 'bye'}, 'k2'), 'battle');
  assert.equal(reason({group: true, text: 'bye'}, 'k3'), 'group');
  assert.equal(reason({text: 'bye, follow me'}, 'k4'), 'ending');
  assert.equal(reason({text: 'follow me'}, 'k5'), 'order');
  assert.equal(reason({text: 'I fixed the car'}, 'k6'), 'after-question');
});

// ---- the end of a reply ---------------------------------------------------------------------------------------------

test('a reply "ends with a question" when its last mark is a question mark, in any script, and ignores tags and closing quotes', () => {
  for (const text of ['What about you?', 'Really?!', 'You sure?...', '"Why?"', 'Hm, okay? [sigh]', 'Ah {joy}?{calm}', '本当ですか？', 'هل أنت بخير؟', 'Wait... what?? ']) {
    assert.equal(endsWithQuestion(text), true, text);
  }
  for (const text of ['Fine.', 'Why would I tell you? Because I like you.', 'Sure! [laughter]', 'Okay...', '', '   ', undefined, null, 42]) {
    assert.equal(endsWithQuestion(text), false, String(text));
  }
});

test('record returns whether the reply ended in a question, and keeps that only while the setting is on', () => {
  const followUp = new FollowUp();
  assert.equal(followUp.record('s', 'Why?'), true);
  assert.equal(followUp.state.size, 0);
  followUp.update({followUpInterest: true});
  assert.equal(followUp.record('s', 'Why?'), true);
  assert.equal(followUp.state.get('s').endedWithQuestion, true);
  assert.equal(followUp.record('s', 'Because.'), false);
  assert.equal(followUp.state.get('s').endedWithQuestion, false);
  assert.equal(followUp.record(undefined, 'Why?'), true, 'no conversation key: nothing kept');
});

// ---- it never creates a request, a turn or a delayed line ------------------------------------------------------------

test('the setting never creates an extra request or turn: one reply per player turn, with the setting off or on', () => {
  // A stand-in for the Convai host: one call per player turn is the only thing that can produce a spoken line.
  const run = enabled => {
    const followUp = new FollowUp();
    followUp.update({followUpInterest: enabled});
    const requests = [], spoken = [];
    for (let n = 0; n < 60; n++) {
      const text = n % 7 === 6 ? 'Good night.' : 'I fixed the car myself.';
      const context = ['base', followUp.contextFor({sessionId: 's', turn: `q${n}`, trait: 'warm', text, random: ALWAYS})].filter(Boolean).join('\n\n');
      requests.push({text, context});
      const reply = enabled ? 'Nice. Was it hard?' : 'Nice.';
      spoken.push(reply);
      followUp.record('s', reply);
    }
    return {requests, spoken, pending: followUp.decisions.size};
  };
  const off = run(false), onRun = run(true);
  assert.equal(onRun.requests.length, 60);
  assert.equal(onRun.requests.length, off.requests.length, 'the same number of requests');
  assert.equal(onRun.spoken.length, off.spoken.length, 'the same number of spoken lines');
  assert.ok(onRun.requests.some(r => r.context.includes(FOLLOW_UP_TEXT)));
  assert.deepEqual(off.requests.map(r => r.context), off.requests.map(() => 'base'), 'off: the context never changes');
});

test('the module cannot start a request, a timer or a turn: no timers, no network, no host, no file access, no callbacks', () => {
  const source = readFileSync(new URL('./follow-up.mjs', import.meta.url), 'utf8');
  const code = source.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  assert.deepEqual([...code.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1]), ['./emotion-analysis.mjs']);
  assert.doesNotMatch(code, /setTimeout|setInterval|setImmediate|queueMicrotask|process\.nextTick|fetch\(|await |async |Promise|node:|\.reply\(|\.send\(|publish|WebSocket/);
});

test('the bridge wires it in as context only: before the reply-language line, no extra request, off adds nothing', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(bridge, /import \{FollowUp\} from '\.\/follow-up\.mjs'/);
  assert.match(bridge, /followUpContext\(input\), naturalSpeechContext\(input\), expressiveEmotionsContext\(input\),\n\s*\/\/ Multilingual conversations: the reply language, last/);
  assert.match(bridge, /const followUpContext = input => \{\n\s*if \(!followUp\.enabled\) return '';/);
  assert.match(bridge, /const followUpChanged = followUp\.update\(settings\);/);
  assert.match(bridge, /speechChanged \|\| emotionsChanged \|\| multilingualChanged \|\| followUpChanged\) \{ dropPrefetch\(\)/);
  assert.match(bridge, /logFollowUp\(input, result\);/);
  // The only things the bridge does with the object: the setting, the context, the record and the log reads.
  const uses = [...bridge.matchAll(/\bfollowUp\.(\w+)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(uses)].sort(), ['contextFor', 'enabled', 'offeredFor', 'reasonFor', 'record', 'update']);
  // None of it sits inside a request path: no use of the object within sight of a reply call or a send.
  for (const match of bridge.matchAll(/\bfollowUp\./g)) {
    const around = bridge.slice(Math.max(0, match.index - 160), match.index + 160);
    assert.doesNotMatch(around, /realtime\.reply|\.sendText|setTimeout|setInterval|submit\(/, around);
  }
  // The log line has the documented fields.
  assert.match(bridge, /\[FollowUp\] profile=\$\{input\.profileKey\} setting=.*offered=.*reason=.*ended-with-question=/s);
});

test('on, the block sits before the voice notes (they dilute it when they come first) and before the reply-language line, which stays last', () => {
  const language = new MultilingualConversations();
  language.update({multilingualConversations: true});
  const followUp = on();
  const join = text => ['intrinsic', followUp.contextFor({sessionId: 's' + text, turn: 'o' + text, trait: 'warm', text, random: ALWAYS}),
    'natural speech block', 'expressive emotions block', language.contextFor(text)].filter(Boolean).join('\n\n');
  const context = join('hola, cómo estás');
  assert.ok(context.includes(FOLLOW_UP_TEXT));
  assert.ok(context.indexOf('intrinsic') < context.indexOf(FOLLOW_UP_TEXT) && context.indexOf(FOLLOW_UP_TEXT) < context.indexOf('natural speech block'));
  assert.ok(context.indexOf(FOLLOW_UP_TEXT) < context.indexOf('Spanish'), 'the reply-language line comes after');
  assert.ok(context.endsWith(language.contextFor('hola, cómo estás')), 'and is last');
  // The block adds exactly one paragraph and changes nothing else.
  const withoutBlock = ['intrinsic', 'natural speech block', 'expressive emotions block', language.contextFor('hola, cómo estás')].join('\n\n');
  assert.equal(context.replace(`${FOLLOW_UP_TEXT}\n\n`, ''), withoutBlock);
});
