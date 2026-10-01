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
