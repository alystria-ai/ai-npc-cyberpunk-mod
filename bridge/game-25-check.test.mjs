// Relationship receipts and world knowledge on game 2.5 (docs/GAME_VERSIONS.md): the pack, the check that backs it and the generator step.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateKnowledgePack} from './world-knowledge.mjs';
import {widenGameVersion} from '../research/cyberpunk/scripts/build_native_pack.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const pack = read('../characters/world-knowledge.json'), check = read('../research/cyberpunk/game-2.5-check.json');
const enabled = rule => ['source-verified', 'live-verified'].includes(rule.status);

test('the shipped pack lists 2.31 and 2.5 and every executable rule and every evidence row covers both', () => {
  assert.deepEqual(pack.gameVersions, ['2.31', '2.5']);
  assert.equal(validateKnowledgePack(pack).ok, true);
  assert.deepEqual(pack.evidence.filter(row => !row.gameVersions.includes('2.31') || !row.gameVersions.includes('2.5')).map(row => row.id), []);
  const rules = pack.rules.filter(enabled);
  assert(rules.length > 800);
  assert.deepEqual(rules.filter(rule => !rule.gameVersions.includes('2.31') || !rule.gameVersions.includes('2.5')).map(rule => rule.id), []);
});

test('the 2.5 check lists exactly the evidence rows of the pack, so a new row stays on 2.31 until the check is repeated for it', () => {
  assert.equal(check.version, 1); assert.equal(check.game, '2.5'); assert.equal(check.basedOn, '2.31');
  assert.deepEqual([...check.verifiedEvidenceIds].sort(), pack.evidence.map(row => row.id).sort());
  // Rebuilding the published pack from its own 2.31 rows gives the shipped pack back.
  const authored = structuredClone(pack);
  for (const row of [...authored.evidence, ...authored.rules]) if (row.gameVersions) row.gameVersions = row.gameVersions.filter(version => version !== '2.5');
  authored.gameVersions = ['2.31'];
  assert.deepEqual(widenGameVersion(authored, check), pack);
});

test('widenGameVersion widens only checked evidence and a rule only when ALL of its evidence is widened', () => {
  const base = {gameVersions: ['2.31'], evidence: [{id: 'a', gameVersions: ['2.31']}, {id: 'b', gameVersions: ['2.31']}, {id: 'c', gameVersions: ['2.31']}],
    rules: [{id: 'r1', status: 'source-verified', gameVersions: ['2.31'], evidenceRefs: ['a']},
      {id: 'r2', status: 'source-verified', gameVersions: ['2.31'], evidenceRefs: ['a', 'c']},
      {id: 'r3', status: 'unmapped'}]};
  const out = widenGameVersion(base, {game: '2.5', basedOn: '2.31', verifiedEvidenceIds: ['a', 'b']});
  assert.deepEqual(out.gameVersions, ['2.31', '2.5']);
  assert.deepEqual(out.evidence.map(row => row.gameVersions), [['2.31', '2.5'], ['2.31', '2.5'], ['2.31']]);
  assert.deepEqual(out.rules.map(row => row.gameVersions), [['2.31', '2.5'], ['2.31'], undefined]);
  assert.deepEqual(base.rules[0].gameVersions, ['2.31'], 'the input is not changed');
  assert.deepEqual(widenGameVersion(base, {game: '2.5', basedOn: '2.31', verifiedEvidenceIds: []}).gameVersions, ['2.31']);
});
