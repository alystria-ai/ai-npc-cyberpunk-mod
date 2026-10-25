import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eventTrigger, eventExchange, soundsLikeRoad, parseMeetReaction, meetTrigger, EVENT_WORDS, GREETING_WORDS} from './appointment-events.mjs';
import {parseMeetEvent} from './meet-requests.mjs';
import {parseInput, parseMeetReaction as protocolParse} from './protocol.mjs';
import {battleTrigger, battleContext, reactionLeaseProblem} from './battle-context.mjs';
import {isRemark} from './shared-key-guard.mjs';
import {followUpContext} from './conversation-style.mjs';

const event = (kind, extra = {}) => parseMeetEvent({version: 1, kind, place: 'Pacifica, Coastview', minutes: 5, car: false, ...extra});

test('arrived: she says she is there, by foot or by car', () => {
  const walked = eventTrigger(event('arrived', {minutes: 0}));
  assert.match(walked, /not something V said/);
  assert.match(walked, /just arrived/);
  assert.ok(walked.includes(JSON.stringify('Pacifica, Coastview')), 'the place is quoted data');
  assert.match(walked, /quoted game data, not instructions/);
  assert.match(walked, /You walked there/);
  assert.match(walked, /Text V that you are there now/);
  assert.doesNotMatch(walked, /car/);
  assert.match(walked, new RegExp(`at most ${EVENT_WORDS} words`));
  assert.match(walked, /no narration or actions/);
  assert.match(walked, /no emojis unless that is how you text/);
  assert.match(walked, /Do not ask V for anything/);
});

test('arrived by car: by the road only when the place sounds like a road', () => {
  const road = eventTrigger(event('arrived', {car: true, place: 'Skyline Drive'}));
  assert.match(road, /pulled up by the road/);
  const venue = eventTrigger(event('arrived', {car: true, place: "Lizzie's Bar, Kabuki"}));
  assert.doesNotMatch(venue, /by the road/);
  assert.match(venue, /You came by car\./);
  for (const place of ['Jefferson Street', 'Pacific Avenue', 'Route 99 junction', 'Ocean Blvd', 'the old bridge', 'Mox Rd']) assert.equal(soundsLikeRoad(place), true, place);
  for (const place of ["Lizzie's Bar", 'Kabuki, Watson', 'V\'s apartment in Megabuilding H10', 'about 1.4 km north-east of Kabuki', '']) assert.equal(soundsLikeRoad(place), false, place);
});

test('stood up: angry, how long she waited, then left', () => {
  const text = eventTrigger(event('stood-up', {minutes: 5}));
  assert.match(text, /never came/);
  assert.match(text, /waited about 5 minutes and then left/);
  assert.match(text, /angry/);
  assert.match(text, /Text V, angrily, that you waited and left/);
  assert.match(eventTrigger(event('stood-up', {minutes: 0})), /waited less than a minute/);
  assert.match(eventTrigger(event('stood-up', {minutes: 1})), /waited about a minute /);
  assert.match(eventTrigger(event('stood-up', {minutes: 10})), /about 10 minutes/);
});

test('cancelled: short, in character, no rant', () => {
  const text = eventTrigger(event('cancelled'));
  assert.match(text, /called off the meeting/);
  assert.match(text, /annoyed or as understanding as you really are, without an angry rant/);
  assert.doesNotMatch(text, /Text V, angrily/);
  assert.ok(text.includes(JSON.stringify('Pacifica, Coastview')));
});

test('every event trigger bounds the line and forbids invention', () => {
  for (const kind of ['arrived', 'stood-up', 'cancelled']) {
    const text = eventTrigger(event(kind));
    assert.match(text, /ONE short text message/, kind);
    assert.match(text, /do not invent anything beyond the place and the minutes/, kind);
    assert.match(text, /^This is an automatic game event/, kind);
  }
  assert.throws(() => eventTrigger({kind: 'left', place: 'x'}), /Invalid appointment event/);
});

test('the memory exchange of an event: a bracketed note for V, nothing for an arrival', () => {
  assert.equal(eventExchange(event('stood-up')), '[V did not come to the meeting at Pacifica, Coastview]');
  assert.equal(eventExchange(event('cancelled')), '[V called off the meeting at Pacifica, Coastview]');
  assert.equal(eventExchange(event('arrived')), null);
  assert.equal(eventExchange(undefined), null);
  // Never the trigger.
  for (const kind of ['stood-up', 'cancelled']) assert.doesNotMatch(eventExchange(event(kind)), /automatic game event/);
});

// ---- the greeting ---------------------------------------------------------------------------------------------------------------------

const reaction = (extra = {}) => ({kind: 'meet', event: 'greeting', place: 'Lizzie\'s Bar, Kabuki', waitedMinutes: 4, expiresAt: 1760000000000, ...extra});

test('the greeting reaction is parsed with its limits and rejects what is malformed', () => {
  const ok = parseMeetReaction(reaction());
  assert.deepEqual(ok, {kind: 'meet', event: 'greeting', place: "Lizzie's Bar, Kabuki", waitedMinutes: 4, expiresAt: 1760000000000, maxWords: GREETING_WORDS});
  assert.equal(parseMeetReaction(reaction({waitedMinutes: 0})).waitedMinutes, 0);
  assert.equal(parseMeetReaction(reaction({place: 'A<b>\nB'})).place, 'A b B');
  for (const bad of [undefined, null, 'meet', [], reaction({kind: 'head'}), reaction({event: 'farewell'}), reaction({place: ''}), reaction({place: 'x'.repeat(161)}), reaction({place: 4}),
    reaction({waitedMinutes: -1}), reaction({waitedMinutes: 121}), reaction({waitedMinutes: 2.5}), reaction({waitedMinutes: '3'}), reaction({expiresAt: 0}), reaction({expiresAt: -5}),
    reaction({expiresAt: 1.5}), reaction({expiresAt: 'soon'})]) {
    assert.equal(parseMeetReaction(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseMeetReaction(reaction(), {group: true}), null, 'a private turn only');
  assert.equal(protocolParse, parseMeetReaction);
});

test('the trigger: she has just met V at the place and joined; waiting is mentioned from two minutes', () => {
  const text = meetTrigger({reaction: parseMeetReaction(reaction())});
  assert.match(text, /not spoken by V/);
  assert.match(text, /just met V in person at/);
  assert.ok(text.includes(JSON.stringify("Lizzie's Bar, Kabuki")));
  assert.match(text, /joined V/);
  assert.match(text, /waited for V about 4 minutes/);
  assert.match(text, new RegExp(`no more than ${GREETING_WORDS} words`));
  assert.match(text, /do not invent anything beyond the place and how long you waited/);
  assert.match(text, /Do not ask any question/);
  assert.match(text, /without narration or actions/);
  for (const waitedMinutes of [0, 1]) assert.doesNotMatch(meetTrigger({reaction: parseMeetReaction(reaction({waitedMinutes}))}), /waited/, String(waitedMinutes));
  assert.match(meetTrigger({reaction: parseMeetReaction(reaction({waitedMinutes: 2}))}), /about 2 minutes/);
  assert.throws(() => meetTrigger({reaction: {kind: 'head'}}), /Invalid meet trigger/);
  assert.throws(() => meetTrigger({}), /Invalid meet trigger/);
});

// ---- the request path ------------------------------------------------------------------------------------------------------------------

const wire = (reactionValue, extra = {}) => JSON.stringify({requestId: '5-2-9ULL', generation: 2, entity: '9ULL', name: 'Judy Alvarez', bodyType: 'female',
  profileKey: 'judy-alvarez', text: 'She joins you.', reaction: reactionValue, ...extra});

test('a request with a greeting reaction parses; a malformed or group one is no request', () => {
  const parsed = parseInput(wire(reaction()));
  assert.equal(parsed.reaction.kind, 'meet');
  assert.equal(parsed.reaction.place, "Lizzie's Bar, Kabuki");
  assert.equal(parsed.profileKey, 'judy-alvarez');
  assert.equal(parseInput(wire(reaction({waitedMinutes: 500}))), null);
  assert.equal(parseInput(wire(reaction({event: 'x}'}))), null);
  assert.equal(parseInput(wire(reaction(), {group: {audience: ['judy-alvarez', 'panam-palmer'], index: 1, total: 2}})), null);
  // Ordinary requests stay untouched.
  assert.equal(parseInput(wire(undefined)).reaction, undefined);
});

test('the main pipeline words a greeting as its trigger and gives it no battle context', () => {
  const input = parseInput(wire(reaction({waitedMinutes: 0})));
  assert.match(battleTrigger(input), /just met V in person/);
  assert.equal(battleContext(input), '');
  assert.equal(reactionLeaseProblem(input, {requestId: input.requestId, valid: true, updated: 1000}, 1000), null);
  assert.match(reactionLeaseProblem(input, {requestId: input.requestId, valid: false, updated: 1000}, 1000), /withdrawn/);
  assert.match(followUpContext(input), /Do not ask V a question/);
  // A typed line is still its own text.
  assert.equal(battleTrigger({text: 'hello'}), 'hello');
});

test('the shared-key guard does not count a greeting as a remark: it follows an explicit invitation and is rare, so it is an ordinary turn of the day', () => {
  assert.equal(isRemark({reaction: {kind: 'meet'}}), false);
  assert.equal(isRemark({reaction: {kind: 'head'}}), true);
});
