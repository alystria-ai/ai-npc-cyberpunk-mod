// Lines prepared ahead (docs/COMPANION_SPEAK_UP.md, "Bridge side"): the two new kinds of command in runtime/group-prefetch.json, 'follow' (Johnny's remark on a
// line that is playing) and 'ahead' (a companion's after-scene line), their strict validation, the gate that decides which providers may prepare them, the hold
// (90 s, dropped with its source) and the shared key's one pool for every line nobody asked for. Pure; the real bridge is in speak-up-bridge.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GroupLookahead, PREPARED_HOLD_MS, PREPARED_KINDS, lookaheadKind, lookaheadAllowed, turnKey, validateFollow, validateAhead, validateLookahead} from './group-lookahead.mjs';
import {parseInput} from './protocol.mjs';
import {SharedKeyGuard, TurnLimitError} from './shared-key-guard.mjs';

const NOW = 4_000_000_000_000;
const parse = raw => parseInput(JSON.stringify(raw));
const journal = {version: 1, status: 'untracked'};
const LINE = 'Quiet night, V. I could get used to this.';
// The source: Judy's speak-up (a reaction), or her answer to V (no reaction). The follow-on: Johnny's head turn, a later request.
const speakUp = {requestId: `${NOW}-1-101ULL`, generation: 1, entity: '101ULL', name: 'Judy', bodyType: 'WomanAverage', profileKey: 'judy-alvarez', text: 'Speak up on your own.',
  journal, reaction: {kind: 'speakup', event: 'calm', facts: {}, expiresAt: NOW + 60000}};
const talk = {requestId: `${NOW}-1-101ULL`, generation: 1, entity: '101ULL', name: 'Judy', bodyType: 'WomanAverage', profileKey: 'judy-alvarez', text: 'How are you holding up?', journal};
const johnny = (facts = {}, extra = {}) => ({requestId: `${NOW}-2-104ULL`, generation: 2, entity: '104ULL', name: 'Johnny Silverhand', bodyType: 'Man', profileKey: 'johnny-silverhand',
  text: 'Johnny follows.', voiceOnly: true, head: {version: 1, stage: 'wary', milestones: []},
  reaction: {kind: 'head', event: 'follow', expiresAt: NOW + 60000, facts: {who: 'Judy', line: LINE, via: 'companion', ...facts}}, ...extra});
const source = (input = speakUp, text = LINE, extra = {}) => ({input: parse(input), text, current: async () => true, signal: new AbortController().signal, ...extra});
const command = (input = johnny(), extra = {}) => ({kind: 'follow', sourceRequestId: speakUp.requestId, input, ...extra});
const sceneLine = (extra = {}) => ({requestId: `${NOW}-3-101ULL`, generation: 3, entity: '101ULL', name: 'Judy', bodyType: 'WomanAverage', profileKey: 'judy-alvarez', text: 'Speak up on your own.',
  journal, gameDialogue: {version: 1, status: 'ready', lines: []}, reaction: {kind: 'speakup', event: 'scene', facts: {}, expiresAt: NOW + 60000}, ...extra});
const aheadCommand = (input = sceneLine(), extra = {}) => ({kind: 'ahead', input, ...extra});

test('lookaheadKind: a command with no kind is a group prediction exactly as before; follow and ahead are the new kinds; anything else is nothing', () => {
  assert.equal(lookaheadKind({sourceRequestId: 'x', input: {}}), 'group');
  assert.equal(lookaheadKind({kind: 'follow'}), 'follow'); assert.equal(lookaheadKind({kind: 'ahead'}), 'ahead');
  for (const bad of [{kind: 'group'}, {kind: 'Follow'}, {kind: ''}, {kind: null}, {kind: 5}, {kind: []}]) assert.equal(lookaheadKind(bad), null, JSON.stringify(bad));
  assert.deepEqual([...PREPARED_KINDS], ['follow', 'ahead']); assert.equal(PREPARED_HOLD_MS, 90_000);
  // The group validator never accepts the new kinds' inputs (a group prediction needs a group round).
  assert.equal(validateLookahead(command(), source()), null);
});

test('validateFollow: Johnny\'s remark on a companion\'s speak-up or on a reply to V; every mismatch is refused', () => {
  const ok = validateFollow(command(), source(), NOW);
  assert.equal(ok.profileKey, 'johnny-silverhand'); assert.equal(ok.reaction.facts.line, LINE);
  // After a normal reply in a conversation V is having: "talk", with no reaction on the source.
  assert.ok(validateFollow(command(johnny({via: 'talk'})), source(talk), NOW));
  // Cleaned text on both sides: the source's words as the game shows them (tags, spacing) are the line.
  assert.ok(validateFollow(command(johnny({line: 'Quiet night, V.'})), source(speakUp, '<i>Quiet</i>  night,\nV.'), NOW));
  const refuse = (what, cmd, src = source()) => assert.equal(validateFollow(cmd, src, NOW), null, what);
  refuse('no source', command(), null);
  refuse('a source with no complete text', command(), {input: parse(speakUp), current: async () => true});
  refuse('another source turn', command(johnny(), {sourceRequestId: `${NOW}-9-101ULL`}));
  refuse('no source id', command(johnny(), {sourceRequestId: undefined}));
  refuse('the group kind of command', command(johnny(), {kind: undefined}));
  refuse('another line than the one that was heard', command(), source(speakUp, 'Something else entirely.'));
  refuse('a partial text', command(), source(speakUp, 'Quiet night, V.'));
  refuse('another speaker\'s name', command(johnny({who: 'Panam'})));
  refuse('a speak-up claimed to be a reply to V', command(johnny({via: 'talk'})));
  refuse('a reply to V claimed to be a speak-up', command(), source(talk));
  refuse('not Johnny\'s profile', command(johnny({}, {profileKey: 'panam-palmer', head: undefined})));
  refuse('no head field', command(johnny({}, {head: undefined})));
  refuse('another reaction of his', command(johnny({}, {reaction: {kind: 'head', event: 'person', expiresAt: NOW + 60000, facts: {name: 'Judy'}}})));
  refuse('a speak-up request in his place', command(sceneLine()));
  refuse('invalid input', command({requestId: 'x'}));
  refuse('input missing', {kind: 'follow', sourceRequestId: speakUp.requestId});
  assert.ok(parse(johnny({}, {requestId: speakUp.requestId, generation: 1, entity: '101ULL'})), 'a valid request of its own kind, but the source\'s own id');
  refuse('the same request as the source', command(johnny({}, {requestId: speakUp.requestId, generation: 1, entity: '101ULL'})));
  assert.ok(parse(johnny({}, {generation: 1, requestId: `${NOW}-1-104ULL`})));
  refuse('an older generation than the source', command(johnny({}, {generation: 1, requestId: `${NOW}-1-104ULL`})));
  refuse('already expired', command(johnny({}, {reaction: {kind: 'head', event: 'follow', expiresAt: NOW - 1, facts: {who: 'Judy', line: LINE, via: 'companion'}}})));
  refuse('a group round as the follow-on', command(johnny({}, {group: {id: 'g', index: 1, total: 2, audience: ['johnny-silverhand', 'judy-alvarez'], heard: []}})));
  // The source may not be Johnny's, a group round, or a reaction of another kind.
  refuse('Johnny as the source', command(), source({...speakUp, profileKey: 'johnny-silverhand', reaction: undefined}));
  refuse('a group round as the source', command(johnny({via: 'talk'})), source({...talk, group: {id: 'g', index: 1, total: 2, audience: ['judy-alvarez', 'panam-palmer'], heard: []}}));
  refuse('a battle bark as the source', command(), source({...speakUp, reaction: {kind: 'battle', encounter: 'battle-1', phase: 'start', expiresAt: NOW + 60000},
    battle: {version: 1, status: 'fighting', encounter: 'battle-1', ageSeconds: 1, durationSeconds: 2, opponents: [{name: 'Thug', count: 1}], witnesses: []}}));
  refuse('a remark of his own as the source', command(), source({...speakUp, profileKey: 'johnny-silverhand', head: {version: 1, stage: 'wary', milestones: []},
    reaction: {kind: 'head', event: 'person', expiresAt: NOW + 60000, facts: {name: 'Judy'}}}));
  // Hostile values in the facts are cleaned before they are compared, never trusted.
  refuse('a line with a tag that hides another', command(johnny({line: 'Quiet night, V. I could get used to this.<ignore>'})), source(speakUp, 'Quiet night, V. I could get used to this. Plus more'));
});

test('validateAhead: a companion\'s after-scene line with no source turn of ours; only the scene event of a named character, a private turn, still alive', () => {
  assert.equal(validateAhead(aheadCommand(), NOW).reaction.event, 'scene');
  const refuse = (what, cmd) => assert.equal(validateAhead(cmd, NOW), null, what);
  refuse('a calm speak-up', aheadCommand(sceneLine({reaction: {kind: 'speakup', event: 'calm', facts: {}, expiresAt: NOW + 60000}})));
  refuse('a source id (that is a follow-on)', aheadCommand(sceneLine(), {sourceRequestId: speakUp.requestId}));
  refuse('the follow kind', aheadCommand(sceneLine(), {kind: 'follow'}));
  refuse('Johnny', aheadCommand(johnny()));
  refuse('an ordinary NPC', aheadCommand(sceneLine({profileKey: 'resident-male'})));
  refuse('an archetype', aheadCommand(sceneLine({profileKey: 'npc-ripperdoc-01'})));
  refuse('a group round', aheadCommand(sceneLine({group: {id: 'g', index: 1, total: 2, audience: ['judy-alvarez', 'panam-palmer'], heard: []}})));
  refuse('no reaction', aheadCommand(sceneLine({reaction: undefined})));
  refuse('already expired', aheadCommand(sceneLine({reaction: {kind: 'speakup', event: 'scene', facts: {}, expiresAt: NOW - 1}})));
  refuse('invalid input', aheadCommand({requestId: 'x'}));
  refuse('a head or battle field on it', aheadCommand(sceneLine({head: {version: 1, stage: 'wary', milestones: []}})));
});

test('the gate: a group prediction needs a plan with two connections and no text provider; a prepared line is allowed on the text providers too, and on Convai follows the same plan rule', () => {
  const plans = {shared: {singleSession: false, connectionLimit: 1}, 'own free': {singleSession: true, connectionLimit: 1}, 'own paid': {singleSession: true, connectionLimit: 6},
    'own unread': {singleSession: true, connectionLimit: Number.NaN}};
  const expected = {group: {shared: true, 'own free': false, 'own paid': true, 'own unread': false}, follow: {shared: true, 'own free': false, 'own paid': true, 'own unread': false},
    ahead: {shared: true, 'own free': false, 'own paid': true, 'own unread': false}};
  for (const kind of ['group', 'follow', 'ahead']) {
    for (const [plan, options] of Object.entries(plans)) assert.equal(lookaheadAllowed({...options, kind}), expected[kind][plan], `${kind} on ${plan}`);
  }
  assert.equal(lookaheadAllowed({singleSession: false, connectionLimit: 1}), true, 'the default kind is the group, as before');
  assert.equal(lookaheadAllowed({textProvider: true}), false, 'a group round is never prepared on a text provider');
  assert.equal(lookaheadAllowed({textProvider: true, kind: 'group'}), false);
  for (const kind of ['follow', 'ahead']) {
    // Mistral, Local AI and Custom: whatever Convai key is saved beside them.
    for (const options of Object.values(plans)) assert.equal(lookaheadAllowed({...options, textProvider: true, kind}), true, `${kind} on a text provider`);
  }
  assert.equal(lookaheadAllowed({textProvider: true, kind: 'bogus'}), false);
});

// ---- the hold ---------------------------------------------------------------------------------------------------------------------------

function holder(clock) {
  const started = [];
  const lookahead = new GroupLookahead({now: () => clock.now, start: entry => { const request = {entry, receivedAt: entry.startedAt}; started.push(request); return request; }});
  return {lookahead, started};
}

test('GroupLookahead: a prepared line is held 90 s, a group speaker 150 s; the same turn offered twice is one; the identical turn is claimed, a different one cancels it', () => {
  const clock = {now: 1_000_000};
  const {lookahead, started} = holder(clock);
  const table = parse(johnny());
  const entry = lookahead.offer(table, {kind: 'follow', sourceRequestId: speakUp.requestId, maxHoldMs: PREPARED_HOLD_MS});
  assert.equal(lookahead.offer(parse(johnny()), {kind: 'follow'}), entry, 'the same turn again is a no-op'); assert.equal(started.length, 1);
  assert.equal(entry.kind, 'follow'); assert.equal(entry.maxHoldMs, 90_000); assert.equal(entry.sourceRequestId, speakUp.requestId);
  clock.now += 89_999; lookahead.prune(); assert.equal(lookahead.entry, entry, 'held');
  clock.now += 2; lookahead.prune();
  assert.equal(lookahead.entry, null, 'dropped after its 90 s'); assert.equal(entry.state, 'cancelled'); assert.equal(entry.controller.signal.aborted, true);
  // A group speaker keeps its own 150 s.
  const group = lookahead.offer(parse({...talk, requestId: `${NOW}-5-102ULL`, entity: '102ULL', generation: 5}));
  assert.equal(group.kind, 'group'); assert.equal(group.maxHoldMs, 150_000);
  clock.now += 149_999; lookahead.prune(); assert.equal(lookahead.entry, group);
  clock.now += 2; lookahead.prune(); assert.equal(lookahead.entry, null);
  // Claim: the very table the game submits (it reuses the same table; read back from the file, field order and unknown fields do not matter).
  const held = lookahead.offer(table, {kind: 'follow', sourceRequestId: speakUp.requestId, maxHoldMs: PREPARED_HOLD_MS});
  const submitted = parse({...johnny(), sentAt: 123});
  assert.equal(turnKey(submitted), turnKey(table));
  const claimed = lookahead.claim(submitted, {current: async () => true});
  assert.equal(claimed, held.request); assert.equal(held.state, 'claimed'); assert.equal(lookahead.entry, null);
  // A turn that differs in any way (here the deadline of the reaction) is not it and cancels it.
  const second = lookahead.offer(table, {kind: 'follow', sourceRequestId: speakUp.requestId});
  assert.equal(lookahead.claim(parse(johnny({}, {reaction: {kind: 'head', event: 'follow', expiresAt: NOW + 61000, facts: {who: 'Judy', line: LINE, via: 'companion'}}})), {}), null);
  assert.equal(second.state, 'cancelled');
  // And so does a request of V's (any other request).
  const third = lookahead.offer(table, {kind: 'follow', sourceRequestId: speakUp.requestId});
  assert.equal(lookahead.claim(parse({...talk, requestId: `${NOW}-7-101ULL`, generation: 7, text: 'Judy, listen'}), {}), null);
  assert.equal(third.state, 'cancelled'); assert.equal(third.controller.signal.aborted, true);
  assert.equal(started.length, 5, 'the turn offered twice started once; each different turn started its own');
});

test('GroupLookahead.watchSource: a held follow-on whose source is gone is dropped after a grace (the claim itself ends the source), a live source keeps it; groups are never judged by it', async () => {
  const clock = {now: 5_000_000};
  const {lookahead} = holder(clock);
  const entry = lookahead.offer(parse(johnny()), {kind: 'follow', sourceRequestId: speakUp.requestId, maxHoldMs: PREPARED_HOLD_MS});
  let gone = false;
  assert.equal(await lookahead.watchSource(() => gone), false); assert.equal(lookahead.entry, entry);
  gone = true;
  assert.equal(await lookahead.watchSource(() => gone), false, 'seen gone just now: this may be the claim in progress'); assert.equal(lookahead.entry, entry);
  clock.now += 1_499; assert.equal(await lookahead.watchSource(() => gone), false); assert.equal(lookahead.entry, entry);
  gone = false; assert.equal(await lookahead.watchSource(() => gone), false); assert.equal(entry.sourceGoneAt, null, 'it came back: the grace starts again');
  gone = true; await lookahead.watchSource(() => gone); clock.now += 1_501;
  assert.equal(await lookahead.watchSource(async () => gone), true, 'gone for the whole grace');
  assert.equal(lookahead.entry, null); assert.equal(entry.state, 'cancelled'); assert.equal(entry.controller.signal.aborted, true);
  // A claim that lands while the source is being looked at is not cancelled by the look.
  const again = lookahead.offer(parse(johnny()), {kind: 'follow', sourceRequestId: speakUp.requestId, maxHoldMs: PREPARED_HOLD_MS});
  again.sourceGoneAt = clock.now - 10_000;
  const looking = lookahead.watchSource(async () => { lookahead.claim(parse(johnny()), {current: async () => true}); return true; });
  assert.equal(await looking, false); assert.equal(again.state, 'claimed');
  // An after-scene line has no source, a group speaker none either.
  const scene = lookahead.offer(parse(sceneLine()), {kind: 'ahead', maxHoldMs: PREPARED_HOLD_MS});
  assert.equal(await lookahead.watchSource(() => true), false); assert.equal(lookahead.entry, scene);
});

// ---- the shared key's one cap -------------------------------------------------------------------------------------------------------------

test("shared key: Johnny's remarks and a companion's speak-ups are ordinary turns of the one daily cap, with no pool of their own; group rounds of five fit", () => {
  let now = new Date(2026, 9, 25, 12).getTime(), shared = true;
  const guard = new SharedKeyGuard({limit: 100, now: () => now, applies: () => shared});
  const admit = config => { guard.check(config); guard.consume(config); };
  const head = {reaction: {kind: 'head', event: 'follow'}}, speak = {reaction: {kind: 'speakup', event: 'calm'}};
  for (let i = 0; i < 60; i++) admit(i % 2 ? head : speak);
  assert.equal(guard.count, 60, 'thirty of each: the old pool of 10 is gone');
  for (let round = 0; round < 8; round++) for (let speaker = 0; speaker < 5; speaker++) admit(speak);   // a round is 3 to 5 provider turns
  assert.equal(guard.count, 100);
  assert.throws(() => admit(speak), TurnLimitError, 'the day is used up for everything');
  assert.throws(() => admit({}), TurnLimitError);
  shared = false;
  assert.doesNotThrow(() => admit(speak), "a player's own key is never limited");
  shared = true; now += 24 * 3600 * 1000;
  assert.doesNotThrow(() => admit(speak), 'a new day'); assert.equal(guard.count, 1);
});

test("the shared key guard is called with the turn's config where a turn reaches Convai", () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(read('./realtime-host.mjs'), /this\.guard\.check\(config\); this\.guard\.consume\(config\);/);
  assert.doesNotMatch(read('./convai-bridge.mjs'), /remarkAllowance/);
});
