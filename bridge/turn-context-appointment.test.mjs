// The appointment note of the turn context (docs/IMMERSIVE_INVITATIONS.md): one sentence in the character's "right now" notes, on every channel that has them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTurnContext, parseAppointment, describeTurnContext, turnContext, MAX_CHARS} from './turn-context.mjs';
import {parseInput} from './protocol.mjs';

const scene = (extra = {}) => ({version: 1, status: 'ready', hour: 2, minute: 10, district: 'Watson', area: 'Kabuki',
  gender: 'female', lifepath: 'streetkid', vehicle: false, party: [{key: 'judy-alvarez', name: 'Judy'}, {key: 'panam-palmer', name: 'Panam'}], ...extra});
const turn = (extra = {}) => ({requestId: '100-1-11ULL', generation: 1, entity: '11ULL', profileKey: 'judy-alvarez', name: 'Judy', bodyType: 'WomanAverage', text: 'So what now?', ...extra});
const appointment = (kind, extra = {}) => ({kind, place: "Lizzie's Bar, Kabuki, Watson", minutes: 5, ...extra});

test('an appointment is parsed with its kind, place and minutes, and dropped when malformed', () => {
  assert.deepEqual(parseAppointment(appointment('waiting')), {kind: 'waiting', place: "Lizzie's Bar, Kabuki, Watson", minutes: 5});
  assert.deepEqual(parseAppointment(appointment('on-the-way', {minutes: 0})), {kind: 'on-the-way', place: "Lizzie's Bar, Kabuki, Watson", minutes: 0});
  assert.equal(parseAppointment(appointment('stood-up', {minutes: 240})).minutes, 240);
  for (const bad of [undefined, null, 'x', [], appointment('left'), appointment('waiting', {minutes: -1}), appointment('waiting', {minutes: 241}), appointment('waiting', {minutes: 2.5}),
    appointment('waiting', {minutes: '5'}), appointment('waiting', {place: ''}), appointment('waiting', {place: 'x'.repeat(121)}), appointment('waiting', {place: 7}), {kind: 'waiting'}]) {
    assert.equal(parseAppointment(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseAppointment(appointment('waiting', {place: 'A <b>bar</b>\n now'})).place, 'A bar now');
  assert.equal(parseTurnContext(scene({appointment: appointment('waiting', {minutes: 999})})).appointment, undefined, 'a bad appointment is dropped and the rest stays');
  assert.equal(parseTurnContext(scene({appointment: appointment('waiting', {minutes: 999})})).district, 'Watson');
  assert.equal(parseTurnContext(scene()).appointment, undefined);
  assert.equal(parseTurnContext(scene({appointment: appointment('waiting')})).appointment.kind, 'waiting');
});

test('the four notes, in a character\'s own words, one sentence each', () => {
  const sentences = {
    'on-the-way': 'You told V you would meet at "Lizzie\'s Bar, Kabuki, Watson" and you are on your way there.',
    waiting: 'You are waiting for V at "Lizzie\'s Bar, Kabuki, Watson", you agreed to meet there.',
    'stood-up': 'V arranged to meet you at "Lizzie\'s Bar, Kabuki, Watson" and never came; you waited about 5 minutes and left angry. Bring it up in your own way only if it fits, do not recite it.',
    cancelled: 'V called off your meeting at "Lizzie\'s Bar, Kabuki, Watson"; you were a little put out. Mention it only if it fits.',
  };
  for (const [kind, sentence] of Object.entries(sentences)) {
    const text = turnContext(parseInput(JSON.stringify(turn({turnContext: scene({appointment: appointment(kind)})}))));
    assert.ok(text.includes(sentence), `${kind}: ${text}`);
  }
});

test('the note sits right after who she is and where, in person', () => {
  const text = turnContext(parseInput(JSON.stringify(turn({turnContext: scene({appointment: appointment('waiting')})}))));
  assert.match(text, /^Right now \(from the game, this turn only\): You are with V in person\. You are somewhere in Kabuki, Watson; exactly where is not given\. You are waiting for V at /);
  assert.match(text, /It is late night, about 2 AM\./);
  assert.ok(text.indexOf('You are waiting for V') < text.indexOf('It is late night'));
});

test('every channel with a block gets it: private, group, phone and holocall', () => {
  const ctx = scene({appointment: appointment('stood-up')});
  const channels = {
    private: turn({turnContext: ctx}),
    group: turn({turnContext: ctx, group: {version: 1, index: 1, total: 2, audience: ['judy-alvarez', 'panam-palmer'], round: 1}}),
    phone: turn({channel: 'phone', turnContext: ctx}),
    holocall: turn({turnContext: ctx, holocall: {version: 1, contact: 'Judy', mode: 'audio'}}),
  };
  for (const [name, input] of Object.entries(channels)) {
    const parsed = parseInput(JSON.stringify(input)) ?? input;
    const text = describeTurnContext(parsed).text;
    assert.match(text, /V arranged to meet you at "Lizzie's Bar, Kabuki, Watson" and never came/, name);
  }
  // The phone and holocall forms keep their own rules.
  assert.match(turnContext(channels.phone), /You are messaging V by text on the phone/);
  assert.match(turnContext(parseInput(JSON.stringify(channels.holocall))), /voice call/);
});

test('a phone contact on her way or waiting may name that one place, and stood-up or cancelled change no rule', () => {
  const exception = /The one exception is the meeting you arranged with V: you may say you are on your way to that place or waiting there\./;
  for (const kind of ['on-the-way', 'waiting']) {
    const phone = turnContext(turn({channel: 'phone', turnContext: scene({appointment: appointment(kind)})}));
    assert.match(phone, exception, kind);
    assert.ok(phone.endsWith('Do not recite it, and mention a place or the time only if it matters to what V says.'), 'the closing rule stays last');
    assert.match(turnContext(parseInput(JSON.stringify(turn({turnContext: scene({appointment: appointment(kind)}), holocall: {version: 1, contact: 'Judy', mode: 'holo'}})))), exception, `call ${kind}`);
    // In person she is with V: nothing to lift.
    assert.doesNotMatch(turnContext(turn({turnContext: scene({appointment: appointment(kind)})})), exception, `person ${kind}`);
  }
  for (const kind of ['stood-up', 'cancelled']) assert.doesNotMatch(turnContext(turn({channel: 'phone', turnContext: scene({appointment: appointment(kind)})})), exception, kind);
});

test('the facts keep the budget they had; only the appointment sentence (and the one exception) is extra', () => {
  const crowded = scene({party: [], weather: 'rain', health: 'hurt', heat: 3, money: 'broke', motion: 'walking', vehicle: false});
  for (const channel of [undefined, 'phone']) {
    const without = turnContext(turn({...(channel ? {channel} : {}), turnContext: crowded}));
    const withMeeting = describeTurnContext(turn({...(channel ? {channel} : {}), turnContext: {...crowded, appointment: appointment('waiting')}})).text;
    assert.ok(without.length <= MAX_CHARS);
    // Every sentence of the block without the meeting is still there with it.
    const bodyOf = text => text.slice('Right now (from the game, this turn only): '.length);
    for (const piece of bodyOf(without).split(/(?<=\.) /).filter(part => !part.startsWith('Treat this') && !part.startsWith('Your usual') && !part.startsWith('Do not recite'))) {
      assert.ok(withMeeting.includes(piece), `${channel ?? 'person'}: ${piece}`);
    }
    assert.ok(withMeeting.length <= MAX_CHARS + 240, `${withMeeting.length} characters`);
  }
});

test('a name that is no one\'s but a stranger or Johnny in V\'s head gets no appointment note', () => {
  const ctx = scene({appointment: appointment('waiting')});
  const stranger = turn({profileKey: 'npc-vendor-clothing', name: 'Vendor', turnContext: ctx});
  assert.doesNotMatch(describeTurnContext(stranger, {ambient: true}).text, /waiting for V/);
  const voice = describeTurnContext(turn({turnContext: ctx}), {voice: true});
  assert.doesNotMatch(voice.text, /waiting for V/);
});

test('an automatic reaction (a battle bark, the greeting) carries no block at all', () => {
  const input = {...turn({turnContext: scene({appointment: appointment('waiting')})}), reaction: {kind: 'meet', event: 'greeting', place: 'x', waitedMinutes: 0, expiresAt: 1}};
  assert.equal(describeTurnContext(input).text, '');
});

test('an appointment alone makes a ready snapshot with just that sentence', () => {
  const only = parseTurnContext({version: 1, status: 'ready', appointment: appointment('cancelled')});
  assert.equal(only.status, 'ready');
  const text = turnContext(turn({channel: 'phone', turnContext: only}));
  assert.match(text, /called off your meeting/);
  // Without it the same snapshot would be unavailable, as before.
  assert.equal(parseTurnContext({version: 1, status: 'ready', appointment: {kind: 'nope'}}).status, 'unavailable');
});

test('no appointment: the block is exactly what it was', () => {
  const text = turnContext(parseInput(JSON.stringify(turn({turnContext: scene()}))));
  assert.doesNotMatch(text, /meet|waiting for V|never came|called off/i);
  assert.ok(text.length <= MAX_CHARS);
});
