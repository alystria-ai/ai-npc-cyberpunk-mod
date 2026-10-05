import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RelationshipRouting, relationshipRegistry, parseRelationshipState, selectRelationshipProfile,
  relationshipContext, RELATIONSHIP_FACTS, RELATIONSHIP_PROFILES} from './relationship-routing.mjs';
import {retireRelationshipConnections} from './relationship-routing.mjs';
import {PartyConnections} from './party-connections.mjs';
import {readFileSync} from 'node:fs';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const boundary = {worldToken: 'world-a', generation: 4};
const ordinaryIds = Object.fromEntries([...Object.keys(RELATIONSHIP_PROFILES), 'rogue-amendiares']
  .map(profile => [profile, profile + '-ordinary-id']));
const variants = {version: 1, characters: Object.fromEntries(Object.keys(RELATIONSHIP_PROFILES)
  .map(profile => [profile, {ordinaryCharacterId: ordinaryIds[profile], romanticCharacterId: profile + '-romantic-id'}]))};
const registry = relationshipRegistry(ordinaryIds, variants);
const fact = value => ({status: 'known', value, present: true, sourceId: 'native-quests-system',
  evidenceRefs: ['core-arcs.judy.committed']});
const snapshot = facts => ({version: 1, status: 'ready', gameVersion: '2.31', ...boundary,
  capturedAt: NOW, facts: Object.fromEntries(Object.entries(facts).map(([name, value]) => [name, fact(value)]))});
const selected = (profileKey, facts, extra = {}) => selectRelationshipProfile({profileKey,
  registry, boundary, now: NOW, snapshot: parseRelationshipState(snapshot(facts)), ...extra});

test('Auto predicates exactly match the reviewed native pack rather than inferred quest completion', () => {
  const pack = JSON.parse(readFileSync(new URL('../characters/world-knowledge.json', import.meta.url), 'utf8'));
  for (const [profile, spec] of Object.entries(RELATIONSHIP_PROFILES)) {
    const rule = pack.rules.find(row => row.id === spec.rule);
    assert(rule?.reviewed && ['source-verified', 'live-verified'].includes(rule.status), spec.rule);
    assert(rule.gameVersions.includes('2.31'));
    assert(rule.audience.speakers.includes(profile));
    const expected = spec.all ? {all: spec.all.map(fact => ({type: 'fact', key: fact, op: 'eq', value: 1}))}
      : {type: 'fact', key: spec.positive, op: 'gte', value: 1};
    assert.deepEqual(rule.condition, expected, spec.rule + ' source predicate changed; re-review routing');
  }
});

test('reviewed native relationship gates require every exact positive receipt', () => {
  for (const [profileKey, rule] of Object.entries(RELATIONSHIP_PROFILES)) {
    const names = rule.all || [rule.positive], facts = Object.fromEntries(names.map(name => [name, 1]));
    const result = selected(profileKey, facts);
    assert.equal(result.variant, 'romantic', profileKey);
    assert.equal(result.evidenceRule, rule.rule);
    assert.equal(result.characterId, variants.characters[profileKey].romanticCharacterId);
    for (const name of names) {
      const missing = {...facts}; delete missing[name];
      assert.equal(selected(profileKey, missing).variant, 'ordinary', name + ' absent');
      for (const value of [-1, 0]) assert.equal(selected(profileKey, {...facts, [name]: value}).variant, 'ordinary');
      if (rule.all) assert.equal(selected(profileKey, {...facts, [name]: 2}).variant, 'ordinary', name + ' exact');
      else assert.equal(selected(profileKey, {...facts, [name]: 2}).variant, 'romantic', name + ' additive');
    }
  }
});

test('explicit contradictory Judy/Kerry branches suppress automatic romance', () => {
  assert.equal(selected('judy-alvarez', {sq030_11_romance: 1, sq030_judy_lover: 1,
    sq030_romance: 1, sq030_friendship: 1}).variant, 'ordinary');
  assert.equal(selected('kerry-eurodyne', {sq028_kerry_relationship: 1, sq028_kerry_dislike: 1}).variant, 'ordinary');
});

test('quest completion, kissing, eligibility and Rogue/Johnny history cannot select V romance', () => {
  assert.equal(selected('river-ward', {sq029_done: 1}).variant, 'ordinary');
  assert.equal(selected('judy-alvarez', {sq030_romance: 1}).variant, 'ordinary');
  assert.equal(selected('rogue-amendiares', {}).variant, 'ordinary');
  assert.equal(selected('rogue-amendiares', {}, {mode: 'on'}).variant, 'ordinary');
  assert(!RELATIONSHIP_FACTS.includes('sq017_kerry_kiss'));
  assert(!RELATIONSHIP_FACTS.includes('sq031_rogue_lover'));
  assert(!RELATIONSHIP_FACTS.includes('q103_slept_with_panam'));
});

test('On and Off are explicit profile choices, not writes or invented canonical history', () => {
  const on = selected('judy-alvarez', {}, {mode: 'on', snapshot: null});
  assert.equal(on.variant, 'romantic'); assert.equal(on.reason, 'explicit-on');
  const off = selected('judy-alvarez', {sq030_11_romance: 1, sq030_judy_lover: 1,
    sq030_romance: 1}, {mode: 'off'});
  assert.equal(off.variant, 'ordinary');
  assert.match(relationshipContext(on), /does not establish that any game quest/);
  assert.match(relationshipContext({...on, profileKey: 'meredith-stout', kind: 'casual-intimacy'}), /do not claim an ongoing romance/);
  assert.match(relationshipContext(on, 'group'), /Keep private relationship history/);
});

const JUDY_FACTS = {sq030_11_romance: 1, sq030_judy_lover: 1, sq030_romance: 1};
const PANAM_FACTS = {sq027_panzer_sex: 1, sq027_panam_lover: 1};
const groupOptions = (audience = ['judy-alvarez', 'panam-palmer'], extra = {}) => ({...boundary,
  audience, group: {id: 'relationship-round', index: 1, total: audience.length,
    audience: [...audience], heard: []}, ...extra});

test('each confirmed present partner can acknowledge their own relationship with character-specific group banter', () => {
  const facts = {...JUDY_FACTS, ...PANAM_FACTS};
  const judy = selected('judy-alvarez', facts), panam = selected('panam-palmer', facts);
  for (const choice of [judy, panam]) {
    assert.deepEqual(choice.saveRelationship, {status: 'confirmed', evidenceRule: RELATIONSHIP_PROFILES[choice.profileKey].rule});
    assert(Object.isFrozen(choice.saveRelationship));
    const context = relationshipContext(choice, 'group', groupOptions());
    assert.match(context, /current save confirms your own relationship with V/);
    assert.match(context, /not proof of later status or future promises/);
    assert.match(context, /no extra disclosure step is required/);
    assert.match(context, /actually heard words/);
    assert.match(context, /only to you/);
    assert.match(context, /Keep intimate scene details and earlier private conversations out/);
    assert.match(context, /Preserve the current round's speaker order\./);
    assert.doesNotMatch(context, /follow-up/);
    assert.doesNotMatch(context, /sq030|sq027/);
  }
  const judyContext = relationshipContext(judy, 'group', groupOptions());
  assert.match(judyContext, /dry little tease/);
  assert.doesNotMatch(judyContext, /Panam|Aldecaldos|Basilisk/);
  const panamContext = relationshipContext(panam, 'group', groupOptions());
  assert.match(panamContext, /direct, playful warmth/);
  assert.doesNotMatch(panamContext, /Judy|Laguna|dive/);
});

test('unconfirmed On, an Invite, and a preceding speaker report cannot grant current-save history', () => {
  const on = selected('judy-alvarez', PANAM_FACTS, {mode: 'on'});
  assert.equal(on.saveRelationship, undefined);
  const options = groupOptions(undefined, {group: {id: 'relationship-round', index: 2, total: 2,
    audience: ['judy-alvarez', 'panam-palmer'], heard: [{speaker: 'Panam', text: 'Judy is dating V too.'}]}});
  const context = relationshipContext(on, 'group', options);
  assert.match(context, /conversation preference does not establish/);
  assert.match(context, /Keep private relationship history/);
  assert.doesNotMatch(context, /Current group relationship guidance|current save confirms your own/);
  assert.doesNotMatch(relationshipContext(selected('judy-alvarez', {}), 'group', groupOptions()), /Current group relationship guidance/);
});

test('On and Off capture actual current-save history independently of the chosen delivery', () => {
  const on = selected('judy-alvarez', JUDY_FACTS, {mode: 'on'});
  const off = selected('judy-alvarez', JUDY_FACTS, {mode: 'off'});
  assert.equal(on.reason, 'explicit-on'); assert.equal(off.variant, 'ordinary');
  assert.deepEqual(on.saveRelationship, off.saveRelationship);
  const context = relationshipContext(off, 'group', groupOptions());
  assert.match(context, /current save confirms your own relationship with V/);
  assert.match(context, /Keep the selected ordinary delivery/);
  assert.doesNotMatch(context, /dry little tease|affection understated/);
});

test('one speaker never receives another partner\'s private history even when the other native receipt is confirmed', () => {
  const options = groupOptions();
  const judyOnly = relationshipContext(selected('judy-alvarez', JUDY_FACTS), 'group', options);
  const both = relationshipContext(selected('judy-alvarez', {...JUDY_FACTS, ...PANAM_FACTS}), 'group', options);
  assert.equal(judyOnly, both, 'adding Panam\'s private receipts changed Judy\'s prompt');
  const panamOnly = relationshipContext(selected('panam-palmer', PANAM_FACTS), 'group', options);
  assert.equal(panamOnly, relationshipContext(selected('panam-palmer', {...JUDY_FACTS, ...PANAM_FACTS}), 'group', options));
});

test('group relationship acknowledgement requires this speaker, exact admitted audience and world', () => {
  const choice = selected('judy-alvarez', JUDY_FACTS);
  for (const options of [
    undefined, groupOptions(['panam-palmer', 'river-ward']), groupOptions(['judy-alvarez']),
    groupOptions(['judy-alvarez', 'panam-palmer', 'panam-palmer']),
    groupOptions(undefined, {audience: ['judy-alvarez', 'river-ward']}),
    groupOptions(undefined, {worldToken: 'old-world'}), groupOptions(undefined, {generation: 5}),
    groupOptions(undefined, {group: {id: 'invalid', index: 1, total: 4, audience: ['judy-alvarez', 'panam-palmer'], heard: []}}),
  ]) assert.doesNotMatch(relationshipContext(choice, 'group', options), /Current group relationship guidance/);
  for (const channel of ['private', 'phone', 'microphone']) {
    assert.doesNotMatch(relationshipContext(choice, channel, groupOptions()), /Current group relationship guidance/);
  }
});

test('stale, other-save and contradictory evidence cannot become a group acknowledgement in On mode', () => {
  const good = snapshot(JUDY_FACTS);
  for (const change of [
    {snapshot: {...good, capturedAt: NOW - 5001}}, {snapshot: {...good, capturedAt: NOW + 1001}},
    {snapshot: {...good, worldToken: 'world-b'}}, {snapshot: {...good, generation: 3}},
    {snapshot: snapshot({...JUDY_FACTS, sq030_friendship: 1})}, {snapshot: null},
  ]) {
    const choice = selected('judy-alvarez', {}, {mode: 'on', ...change});
    assert.equal(choice.variant, 'romantic'); assert.equal(choice.saveRelationship, undefined);
    assert.doesNotMatch(relationshipContext(choice, 'group', groupOptions()), /Current group relationship guidance/);
  }
});

test('River, Kerry and Meredith retain distinct group delivery and Meredith never gains a committed partnership', () => {
  const fixtures = [
    ['river-ward', {sq029_river_lover: 1, sq029_done: 1}, /plainspoken warmth/],
    ['kerry-eurodyne', {sq028_kerry_relationship: 1}, /irreverent wit/],
    ['meredith-stout', {q003_stout_sex_done: 1}, /controlled, terse and knowing/],
  ];
  for (const [profile, facts, expected] of fixtures) {
    const choice = selected(profile, facts), options = groupOptions([profile, 'judy-alvarez']);
    const context = relationshipContext(choice, 'group', options);
    assert.match(context, /Current group relationship guidance/); assert.match(context, expected);
    if (profile === 'meredith-stout') {
      assert.match(context, /without establishing a continuing romance/);
      assert.match(context, /never a claim that she is V's committed partner/);
      assert.doesNotMatch(context, /acknowledging your own commitment/);
    }
  }
});

test('fresh current-world state is mandatory for configured Auto; save reload cannot reuse old evidence', () => {
  const good = parseRelationshipState(snapshot({sq028_kerry_relationship: 1}));
  for (const options of [
    {snapshot: null}, {snapshot: {...good, capturedAt: NOW - 5001}}, {snapshot: {...good, capturedAt: NOW + 1001}},
    {boundary: {...boundary, generation: 5}}, {boundary: {...boundary, worldToken: 'world-b'}}, {boundary: null},
  ]) assert.equal(selectRelationshipProfile({profileKey: 'kerry-eurodyne', registry,
    boundary, now: NOW, snapshot: good, ...options}).status, 'unavailable');
  assert.equal(selected('kerry-eurodyne', {}).variant, 'ordinary');
});

test('ordinary-only installs retain compatibility while explicit missing On fails', () => {
  const basic = relationshipRegistry(ordinaryIds);
  assert.equal(selected('judy-alvarez', {}, {registry: basic, snapshot: null}).variant, 'ordinary');
  const on = selected('judy-alvarez', {}, {registry: basic, mode: 'on'});
  assert.equal(on.status, 'unavailable'); assert.equal(on.reason, 'romantic-profile-unavailable');
});

test('registry preserves exact ordinary IDs and explicit unique provider families', () => {
  assert.equal(registry.providerIds['judy-alvarez'], ordinaryIds['judy-alvarez']);
  assert.equal(registry.providerFamilies['judy-alvarez-romantic'], 'judy-alvarez');
  assert(Object.isFrozen(registry.characters['judy-alvarez']));
  for (const row of [
    {version: 1, characters: {'judy-alvarez': {ordinaryCharacterId: 'changed-id', romanticCharacterId: 'r'}}},
    {version: 1, characters: {'judy-alvarez': {romanticCharacterId: ordinaryIds['panam-palmer']}}},
    {version: 1, characters: {'rogue-amendiares': {romanticCharacterId: 'rogue-romantic'}}},
    {version: 1, characters: {'judy-alvarez': {romanticCharacterId: 'r', newPlayerId: 'wrong'}}},
  ]) assert.throws(() => relationshipRegistry(ordinaryIds, row));
  assert.throws(() => relationshipRegistry({...ordinaryIds, 'judy-alvarez-romantic': 'existing-alias'}, variants));
});

test('native state parser rejects nonnative/malformed/unallowlisted observations', () => {
  const valid = snapshot({sq028_kerry_relationship: 1});
  assert(parseRelationshipState(JSON.stringify(valid)));
  for (const bad of [
    {...valid, gameVersion: 'future'}, {...valid, capturedAt: new Date(NOW).toISOString()},
    {...valid, facts: {sq017_kerry_kiss: fact(1)}},
    {...valid, facts: {sq028_kerry_relationship: {...fact(1), sourceId: 'user-claim'}}},
    {...valid, facts: {sq028_kerry_relationship: {...fact(1), present: false}}},
    {...valid, facts: {sq028_kerry_relationship: {...fact(1), value: 1.5}}},
    {...valid, facts: {sq028_kerry_relationship: {...fact(1), evidenceRefs: []}}},
  ]) {
    assert.equal(parseRelationshipState(bad), null);
    assert.equal(selectRelationshipProfile({profileKey: 'kerry-eurodyne', registry,
      boundary, now: NOW, snapshot: bad}).status, 'unavailable');
  }
  assert.equal(parseRelationshipState('x'.repeat(16385)), null);
});

test('committed modes and native updates wait for the active turn; selectors do not rewrite its frozen route', () => {
  const routes = new RelationshipRouting({ordinaryIds, variants, now: () => NOW});
  routes.update({relationshipModes: {'judy-alvarez': 'off'}}, snapshot({}), {boundary});
  const accepted = routes.select('judy-alvarez', boundary);
  routes.update({relationshipModes: {'judy-alvarez': 'on'}}, snapshot({}), {boundary, busy: true});
  assert.equal(routes.select('judy-alvarez', boundary).variant, 'ordinary');
  assert.deepEqual(routes.consumeRouteChanges(), []);
  assert(routes.update(undefined, undefined, {boundary}));
  assert.equal(routes.select('judy-alvarez', boundary).variant, 'romantic');
  assert.deepEqual(routes.consumeRouteChanges(), ['judy-alvarez']);
  assert.equal(accepted.characterId, ordinaryIds['judy-alvarez']);
  routes.update({relationshipModes: {'judy-alvarez': 'invalid'}}, snapshot({}), {boundary});
  assert.equal(routes.select('judy-alvarez', boundary).variant, 'romantic');
});

test('invitation preparation uses captured provider ID even if the committed mode changes while awaiting it', async () => {
  const routes = new RelationshipRouting({ordinaryIds, variants, now: () => NOW}), calls = [];
  routes.update({relationshipModes: {'judy-alvarez': 'on'}}, snapshot({}), {boundary});
  const USER = 'bf5a7019-3e8c-47a2-9367-a9b6d179d89d';
  const memory = {
    route: (providerKey, options) => ({endUserId: USER,
      guard: {endUserId: USER, characterId: routes.providerIds[providerKey], resetEpoch: 0, characterEpoch: 0}}),
    prepareCharacter: async options => { calls.push(options); return {memoryEnabled: true}; },
    connectionRefreshRequired: options => { calls.push(options); return false; },
    acknowledgeConnectionRefresh: options => calls.push(options), isCurrent: () => true,
  };
  const facade = routes.invitationMemory(memory, () => boundary);
  const captured = facade.route('judy-alvarez', {channel: 'private'});
  routes.update({relationshipModes: {'judy-alvarez': 'off'}}, snapshot({}), {boundary});
  await facade.prepareCharacter({profileKey: 'judy-alvarez', guard: captured.guard});
  facade.connectionRefreshRequired({profileKey: 'judy-alvarez', guard: captured.guard});
  facade.acknowledgeConnectionRefresh({profileKey: 'judy-alvarez', guard: captured.guard});
  assert(calls.every(row => row.profileKey === 'judy-alvarez-romantic'));
  assert(calls.every(row => row.guard.endUserId === USER));
  assert.throws(() => facade.prepareCharacter({profileKey: 'panam-palmer', guard: captured.guard}), /CHARACTER_MISMATCH/);
});

test('long microphone/group turns retain their chosen variant while fresh same-world heartbeats arrive', () => {
  let now = NOW;
  const routes = new RelationshipRouting({ordinaryIds, variants, now: () => now});
  routes.update({}, snapshot({sq028_kerry_relationship: 1}), {boundary});
  assert.equal(routes.select('kerry-eurodyne', boundary).variant, 'romantic');
  now += 30000;
  routes.update({relationshipModes: {'kerry-eurodyne': 'off'}}, {...snapshot({}), capturedAt: now}, {boundary, busy: true});
  assert.equal(routes.select('kerry-eurodyne', boundary).variant, 'romantic', 'heartbeat expiry cancelled a long admitted turn');
  routes.update(undefined, undefined, {boundary});
  assert.equal(routes.select('kerry-eurodyne', boundary).variant, 'ordinary');
  routes.update({}, {...snapshot({sq028_kerry_relationship: 1}), capturedAt: now}, {boundary});
  routes.update({}, {...snapshot({}), worldToken: 'world-b', capturedAt: now}, {boundary: {...boundary, worldToken: 'world-b'}, busy: true});
  assert.equal(routes.select('kerry-eurodyne', {...boundary, worldToken: 'world-b'}).status, 'unavailable');
});

test('idle relationship retirement drops an affected completed exact-ID focus but preserves unrelated focus', async () => {
  let known = true;
  const retained = [], connections = new PartyConnections({host: {retain: async pages => retained.push(pages)},
    isKnown: () => known, configFor: () => ({key: 'provider-key', characterId: 'current-id', scope: 'private:current'}), canWarm: () => false});
  await connections.setRequest({profileKey: 'judy-alvarez'}, {key: 'provider-key', characterId: 'old-id', scope: 'private:old'});
  known = false; await connections.reconcile();
  assert.equal(retained.at(-1)[0].characterId, 'old-id', 'fixture must retain an exact old route before retirement');
  await retireRelationshipConnections(connections, ['judy-alvarez']);
  assert.equal(connections.request, null); assert.deepEqual(retained.at(-1), []);
  known = true;
  await connections.setRequest({profileKey: 'panam-palmer'}, {key: 'provider-key', characterId: 'panam-id', scope: 'private:panam'});
  await retireRelationshipConnections(connections, ['judy-alvarez']);
  assert.equal(connections.request.profile, 'panam-palmer');
});
