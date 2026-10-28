// Companions speak up together (docs/COMPANION_SPEAK_UP.md, "Group speak-up"), the bridge side: the strict parser of a party line (reaction kind 'speakup',
// event 'party'), its trigger, the right-now facts it gets, and the hold-and-claim of the next line prepared ahead. Pure.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseInput} from './protocol.mjs';
import {parseSpeakUpReaction, speakupTrigger, SPEAKUP_EVENTS, PARTY_WORDS, PARTY_LINES} from './speakup-context.mjs';
import {validateAhead, turnKey} from './group-lookahead.mjs';
import {describeTurnContext} from './turn-context.mjs';
import {isRemark} from './shared-key-guard.mjs';

const NOW = Date.now();
const turnContext = {version: 1, status: 'ready', hour: 2, minute: 10, district: 'Heywood', weather: 'rain',
  party: [{key: 'judy-alvarez', name: 'Judy'}, {key: 'panam-palmer', name: 'Panam'}]};
let serial = 500;
function line(n = 2, {of = 4, lines, others = ['River'], profile = ['panam-palmer', 'Panam'], partner = ['judy-alvarez', 'Judy'], extra = {}, reaction = {}} = {}) {
  const generation = ++serial, entity = `${2000 + serial}ULL`;
  return {requestId: `${NOW}-${generation}-${entity}`, generation, entity, name: profile[1], bodyType: 'WomanAverage', profileKey: profile[0],
    text: 'You are chatting with your fellow companions while out with V. Say your next line.', turnContext, journal: undefined,
    reaction: {kind: 'speakup', event: 'party', facts: {v: 1}, partner: partner[1], partnerKey: partner[0], others, n, of,
      lines: lines ?? (n > 1 ? [{speaker: 'Judy', text: 'Quiet night.'}] : []), expiresAt: NOW + 90_000, ...reaction}, ...extra};
}
const parse = raw => parseInput(JSON.stringify(raw));

test('the party event is one of the speak-up events and its lines are short', () => {
  assert.ok(SPEAKUP_EVENTS.includes('party'));
  assert.equal(PARTY_WORDS, 25);
  assert.equal(PARTY_LINES, 6);
});

test('a party line parses with who she answers, who else is in it, which line it is and what was said', () => {
  const input = parse(line(2));
  assert.ok(input, 'accepted');
  assert.deepEqual(input.reaction, {kind: 'speakup', event: 'party', facts: {}, partner: 'Judy', partnerKey: 'judy-alvarez', n: 2, of: 4,
    lines: [{speaker: 'Judy', text: 'Quiet night.'}], others: ['River'], expiresAt: NOW + 90_000, maxWords: 25});
  // A round of two has nobody else; CET writes an empty list as an empty object.
  assert.deepEqual(parse(line(1, {others: {}, lines: {}, of: 3})).reaction.lines, []);
  assert.equal(parse(line(1, {others: {}, lines: {}, of: 3})).reaction.others, undefined);
  assert.equal(parse(line(1, {others: [], lines: [], of: 3})).reaction.others, undefined);
});

test('a malformed or misplaced party line is refused as a whole', () => {
  const bad = (what, raw) => assert.equal(parse(raw), null, what);
  bad('line 0', line(0));
  bad('more lines than a round has', line(PARTY_LINES + 1, {of: PARTY_LINES}));
  bad('a chat of one line', line(1, {of: 1}));
  bad('a chat longer than a round', line(2, {of: PARTY_LINES + 1}));
  bad('a partner key that is not a profile key', line(2, {partner: ['Judy Alvarez!', 'Judy']}));
  bad('no partner', line(2, {reaction: {partner: ''}}));
  bad('three others', line(2, {others: ['A', 'B', 'C']}));
  bad('seven lines said', line(2, {lines: Array.from({length: 7}, () => ({speaker: 'Judy', text: 'x'}))}));
  bad('a line without text', line(2, {lines: [{speaker: 'Judy'}]}));
  bad('a line of more than 300 characters', line(2, {lines: [{speaker: 'Judy', text: 'x'.repeat(301)}]}));
  bad('no deadline', line(2, {reaction: {expiresAt: undefined}}));
  bad('facts that are no object', line(2, {reaction: {facts: 'x'}}));
  bad('a group turn', line(2, {extra: {group: {id: 'g', index: 1, count: 2}}}));
  bad('an ordinary NPC', line(2, {profile: ['resident-male', 'Passer-by']}));
  bad('an archetype', line(2, {profile: ['npc-ripperdoc-01', 'Ripperdoc']}));
  bad('Johnny', line(2, {profile: ['johnny-silverhand', 'Johnny']}));
  bad('a head field', line(2, {extra: {head: {version: 1, stage: 'friends', milestones: []}}}));
  bad('a battle field', line(2, {extra: {battle: {}}}));
});

test('the trigger: the first line opens, a middle line answers the one before, the last one settles and nobody leaves; V is neither addressed nor asked', () => {
  const first = speakupTrigger(parse(line(1, {of: 4, lines: []})));
  assert.match(first, /You speak first/);
  assert.match(first, /line 1 of a short chat of 4 lines/);
  assert.match(first, /"Judy" and "River"/);
  assert.match(first, /do not address V and do not ask V anything/);
  assert.match(first, /no more than 25 words/);
  const middle = speakupTrigger(parse(line(2, {of: 4})));
  assert.match(middle, /Answer Judy's last line and keep the exchange going/);
  assert.match(middle, /"Judy": "Quiet night\."/, 'what was said is quoted game data');
  assert.doesNotMatch(middle, /nobody is leaving/);
  const last = speakupTrigger(parse(line(4, {of: 4})));
  assert.match(last, /let the topic settle/);
  assert.match(last, /nobody is leaving/);
  assert.match(last, /Do not ask a question/);
  const pair = speakupTrigger(parse(line(2, {others: [], of: 3})));
  assert.match(pair, /you and Judy speak in turn/);
  assert.doesNotMatch(pair, /River/);
  // It is the companions' own chat out with V, not the housemates' one at home.
  for (const text of [first, middle, last, pair]) assert.doesNotMatch(text, /at home|live there|flat|apartment/i);
});

test('a party line gets the right-now facts like any speak-up, and counts as an unprompted line on the shared key', () => {
  const input = parse(line(2));
  const block = describeTurnContext(input, {split: true});
  assert.match(block.text, /You are with V in person/);
  assert.equal(isRemark({reaction: input.reaction}), true);
});

test('a party line is prepared ahead like the next line of a housemates chat: accepted while alive and private, refused otherwise', () => {
  const wire = (n, change = {}) => ({...line(n), ...change, reaction: {...line(n).reaction, ...(change.reaction ?? {})}});
  assert.ok(validateAhead({kind: 'ahead', input: wire(2)}));
  assert.equal(validateAhead({kind: 'ahead', input: wire(2), sourceRequestId: 'x'}), null, 'no source turn');
  assert.equal(validateAhead({kind: 'ahead', input: wire(2, {reaction: {expiresAt: Date.now() - 1000}})}), null, 'expired');
  assert.equal(validateAhead({kind: 'ahead', input: wire(2, {group: {id: 'g', index: 2, count: 3}})}), null, 'a group turn');
  assert.equal(validateAhead({kind: 'ahead', input: wire(2, {reaction: {n: 9}})}), null);
  assert.equal(validateAhead({kind: 'ahead', input: wire(2, {reaction: {event: 'calm'}})}), null, 'a calm line is not prepared ahead');
});

test('the held turn is the identical turn: any change to the chat so far makes it another turn', () => {
  const a = parse(line(2)), b = parse({...line(2), requestId: a.requestId, generation: a.generation, entity: a.entity});
  assert.equal(turnKey(a), turnKey(b));
  const c = parse({...line(2, {lines: [{speaker: 'Judy', text: 'Something else.'}]}), requestId: a.requestId, generation: a.generation, entity: a.entity});
  assert.notEqual(turnKey(a), turnKey(c));
  // The right-now facts are not identity: the game recaptures them when it sends the line.
  const d = parse({...line(2), requestId: a.requestId, generation: a.generation, entity: a.entity, turnContext: {...turnContext, hour: 3}});
  assert.equal(turnKey(a), turnKey(d));
});

test('the other speak-up events are unchanged by the party fields', () => {
  assert.deepEqual(parseSpeakUpReaction({kind: 'speakup', event: 'calm', facts: {}, expiresAt: NOW, partner: 'x', n: 3}, 'judy-alvarez'),
    {kind: 'speakup', event: 'calm', facts: {}, expiresAt: NOW, maxWords: 25});
  assert.equal(parseSpeakUpReaction({kind: 'speakup', event: 'party', facts: {}, expiresAt: NOW}, 'judy-alvarez'), null, 'a party line needs its chat fields');
});
