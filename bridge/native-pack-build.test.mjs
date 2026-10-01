import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {jsonPointer, verifyNativeEvidence, mergeNativePacks} from '../research/cyberpunk/scripts/build_native_pack.mjs';

const raw = Buffer.from('Native fixture'), sha = createHash('sha256').update(raw).digest('hex');
test('shared fact selectors preserve richer writer provenance and reject executable disagreement', () => {
  const base = {version: 1, gameVersions: ['2.31'], sources: [], evidence: [], rules: [],
    factAllowlist: {shared: {evidenceRefs: []}}, journalAllowlist: {}};
  const richer = structuredClone(base);
  richer.factAllowlist.shared.writers = [{jsonPath: 'raw/test.quest.json', jsonPointer: '/Data/1', value: 1}];
  richer.factAllowlist.shared.writerAuditScope = 'Installed winners audited';
  const merged = mergeNativePacks([base, richer], ['judy']);
  assert.deepEqual(merged.pack.factAllowlist.shared, richer.factAllowlist.shared);
  assert(!merged.errors.some(error => error.startsWith('Conflicting')));
  const disagreement = structuredClone(base); disagreement.factAllowlist.shared.zeroIsKnown = true;
  assert(mergeNativePacks([base, disagreement], ['judy']).errors.some(error => error.includes('Conflicting fact entry')));
});
function fixture() {
  const native = {jsonPath: 'raw/base/base/quest/fixture.quest.json', assetSha256: sha,
    jsonPointer: '/Data/graph/node', expectedType: 'questSetVar_NodeType'};
  return {pack: {evidence: [{id: 'native-proof', kind: 'native', native}], rules: [{id: 'rule', questKey: 'rescue',
    status: 'source-verified', narrativeLinks: [{decisionId: 'rescue.fate', outcomeKey: 'rescued'}]}]},
    inventory: {assets: [{...native, winner: true, rawPath: 'raw/base/base/quest/fixture.quest', archive: 'base'}]},
    loadArtifact: async () => ({raw, json: {Data: {graph: {node: {$type: 'questSetVar_NodeType', value: 1}}}}}),
    decisions: new Map([['rescue.fate', {id: 'rescue.fate', questKey: 'rescue', outcomes: [{key: 'rescued'}, {key: 'lost'}]}]])};
}
test('evidence pointers are exact own-property lookups with RFC6901 escapes', () => {
  assert.equal(jsonPointer({'a/b': {'a~b': 3}}, '/a~1b/a~0b'), 3);
  assert.throws(() => jsonPointer({}, '/constructor'), /Missing/);
  assert.throws(() => jsonPointer({}, '/invalid~escape'), /escape/);
});
test('partial rule coverage counts researched alternatives honestly', async () => {
  const result = await verifyNativeEvidence(fixture());
  assert.deepEqual(result.errors, []);
  assert.equal(result.counts.outcomesWithReviewedRules, 1);
  assert.equal(result.counts.outcomesUnmapped, 1);
  assert.equal(result.counts.legacyJsonPointers, 1);
  assert.equal(result.verified[0].jsonIntegrity, 'legacy-unbound');
  assert.match(result.exportIntegrity.note, /not bound to its original export/);
});

test('recorded JSON export hashes reject stale decoded contents even when original raw bytes still match', async () => {
  const input = fixture();
  const jsonRaw = Buffer.from(JSON.stringify((await input.loadArtifact()).json));
  const jsonSha256 = createHash('sha256').update(jsonRaw).digest('hex');
  input.inventory.assets[0].jsonSha256 = jsonSha256;
  input.pack.evidence[0].native.jsonSha256 = jsonSha256;
  input.loadArtifact = async () => ({raw, jsonRaw});
  const output = await verifyNativeEvidence({...input, requireJsonHashes: true});
  assert.deepEqual(output.errors, []);
  assert.equal(output.counts.jsonHashBoundPointers, 1);
  assert.equal(output.counts.legacyJsonPointers, 0);
  input.loadArtifact = async () => ({raw, jsonRaw: Buffer.from(jsonRaw.toString().replace('value":1', 'value":2'))});
  assert.match((await verifyNativeEvidence(input)).errors.join('\n'), /JSON export hash mismatch/);
  input.loadArtifact = async () => ({raw, jsonRaw, json: {Data: {graph: {node: {}}}}});
  assert.deepEqual((await verifyNativeEvidence(input)).errors, []); // Exact bytes determine decoded evidence.
  input.pack.evidence[0].native.jsonSha256 = '0'.repeat(64);
  assert.match((await verifyNativeEvidence(input)).errors.join('\n'), /JSON export hash mismatch/);
});

test('strict future builds reject legacy exports and supplied current hashes never retroactively qualify them', async () => {
  const input = fixture();
  input.loadArtifact = async () => ({raw, json: (await fixture().loadArtifact()).json, jsonSha256: 'a'.repeat(64)});
  assert.match((await verifyNativeEvidence({...input, requireJsonHashes: true})).errors.join('\n'), /fresh export evidence required/);
  assert.equal((await verifyNativeEvidence(input)).verified[0].jsonIntegrity, 'legacy-unbound');
});
test('overridden resources, modified bytes and missing pointers cannot qualify', async () => {
  for (const mutate of [input => input.inventory.assets[0].winner = false,
    input => input.pack.evidence[0].native.jsonPointer = '/Data/missing',
    input => input.loadArtifact = async () => ({raw: Buffer.from('changed'), json: {}}),
    input => input.pack.evidence[0].native.jsonPath = 'raw/../secrets']) {
    const input = fixture(); mutate(input);
    assert((await verifyNativeEvidence(input)).errors.length > 0);
  }
});
test('source prose for a different outcome or quest cannot be linked by a native rule', async () => {
  const input = fixture(); input.pack.rules[0].narrativeLinks[0].outcomeKey = 'invented';
  const result = await verifyNativeEvidence(input);
  assert.match(result.errors.join('\n'), /unknown or mismatched/);
  assert.equal(result.counts.outcomesWithReviewedRules, 0);
});
test('shipped localization references verify exact values without replacing scene evidence', async () => {
  const input = fixture();
  const reference = input.pack.evidence[0].native;
  reference.jsonPath = 'localization/raw/ep1/base/localization/choice.json.json';
  reference.jsonPointer = '/Data/graph/node/value';
  delete reference.expectedType;
  reference.expectedValue = 1;
  input.inventory.assets[0].jsonPath = reference.jsonPath;
  assert.deepEqual((await verifyNativeEvidence(input)).errors, []);
  reference.expectedValue = 2;
  assert.match((await verifyNativeEvidence(input)).errors.join('\n'), /Native value mismatch/);
});

test('legacy relative predicates are enforced alongside node type and exact value checks', async () => {
  const input = fixture(), ref = input.pack.evidence[0].native;
  ref.expected = {'/value': 1, '/$type': 'questSetVar_NodeType'};
  assert.deepEqual((await verifyNativeEvidence(input)).errors, []);
  ref.expected['/value'] = 2;
  assert.match((await verifyNativeEvidence(input)).errors.join('\n'), /nested value mismatch/);
  ref.expected = {'/absent': 1};
  assert.match((await verifyNativeEvidence(input)).errors.join('\n'), /Missing JSON pointer/);
  ref.expected = {'/constructor': 'forged'};
  assert.match((await verifyNativeEvidence(input)).errors.join('\n'), /Missing JSON pointer/);
  ref.expected = [];
  assert.match((await verifyNativeEvidence(input)).errors.join('\n'), /Invalid native expected/);
});
