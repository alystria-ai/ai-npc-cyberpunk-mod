import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveKnowledge} from './world-knowledge.mjs';

// Step B of docs/QUEST_DECISIONS.md: the decision rows added in research/cyberpunk/decision-rows-b.json, as shipped in the reviewed pack.
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const pack = read('../characters/world-knowledge.json');
const spec = read('../research/cyberpunk/decision-rows-b.json');
const dispositions = read('../research/cyberpunk/decision-rows-b-dispositions.json').dispositions;
const rows = pack.rules.filter(rule => rule.id.startsWith('db.'));
const leaves = node => node.all ? node.all.flatMap(leaves) : node.any ? node.any.flatMap(leaves) : [node];
const fact = (value = 1) => ({status: 'known', value, present: true, sourceId: 'native-capture', evidenceRefs: ['fact-capture']});
const journal = (questKey, value = 'succeeded') => ({status: 'known', value, revealed: true, questKey, sourceId: 'native-capture', evidenceRefs: ['journal-capture']});
function told(profileKey, facts, journals) {
  const result = resolveKnowledge({pack, profileKey, maxChars: 10000, snapshot: {version: 1, status: 'ready', gameVersion: '2.31', generation: 1,
    capturedAt: '2026-10-14T06:45:00.000Z', audience: {channel: 'private', profileKeys: [profileKey]}, facts, journal: journals, activeQuestKeys: []}});
  const doc = JSON.parse(result.context.slice(result.context.indexOf('\n') + 1));
  return [...(doc.choices || []), ...(doc.facts || [])].map(item => item.statement ?? item.text ?? JSON.stringify(item));
}

test('every spec row is in the pack, verified rows are executable and unverified rows are not', () => {
  assert.equal(rows.length, spec.rows.length);
  for (const row of spec.rows) {
    const rule = rows.find(candidate => candidate.id === row.id);
    assert.ok(rule, row.id);
    assert.equal(rule.status, row.status === 'verified' ? 'source-verified' : 'candidate', row.id);
    assert.equal(rule.narrativeLinks[0].decisionId, row.decisionId);
  }
  assert.ok(spec.rows.filter(row => row.status === 'verified').length >= 9);
});

test('no executable row can fire on an absent fact, and every fact it reads is allowlisted with a hash-bound writer', () => {
  for (const rule of rows.filter(candidate => candidate.status === 'source-verified')) {
    for (const leaf of leaves(rule.condition)) {
      if (leaf.type === 'fact') {
        assert.ok(['gte', 'eq', 'in'].includes(leaf.op), rule.id);
        assert.ok(leaf.op === 'in' ? !leaf.value.includes(0) && leaf.value.length : leaf.value >= 1, `${rule.id} ${leaf.key}`);
        const entry = pack.factAllowlist[leaf.key];
        assert.ok(entry?.evidenceRefs?.length, `${rule.id} ${leaf.key} not allowlisted`);
      } else assert.ok(pack.journalAllowlist[leaf.key], `${rule.id} ${leaf.key}`);
    }
  }
});

test('an unverified row never reaches a prompt and its facts are not read by it', () => {
  const candidate = rows.find(rule => rule.id === 'db.frank-chat-cut-short');
  assert.equal(candidate.status, 'candidate');
  assert.equal(pack.factAllowlist.q000_corpo_02_cut_short, undefined);
  const statements = told('frank-nostra', {q000_corpo_02_cut_short: fact()}, {'ah5.corpo-rat.talk-friend': journal('the-heist')});
  assert.ok(!statements.some(text => /in a rush/.test(text)));
});

test('a verified decision reaches the character who would know it, and only then', () => {
  const rule = rows.find(candidate => candidate.id === 'db.river-parents-heard');
  assert.equal(rule.status, 'source-verified');
  const heard = told('river-ward', {sq029_02_dark_story: fact()}, {});
  assert.ok(heard.some(text => text === rule.statement), JSON.stringify(heard));
  assert.ok(!told('river-ward', {}, {}).includes(rule.statement));
  assert.ok(!told('judy-alvarez', {sq029_02_dark_story: fact()}, {}).includes(rule.statement));
});

test('Dex hears that V told him about Evelyn, the audience fix for the heist briefing disclosure', () => {
  const rule = pack.rules.find(candidate => candidate.id === 'jt.report-evelyn.disclosed');
  assert.ok(rule.audience.speakers.includes('dexter-deshawn') && rule.audience.recipients.includes('dexter-deshawn'));
  const facts = {q005_01_dex_knows: fact()}, journals = {'jt.heist.briefing': journal('the-heist')};
  assert.ok(told('dexter-deshawn', facts, journals).includes(rule.statement));
  assert.ok(told('jackie-welles', facts, journals).includes(rule.statement));
  assert.ok(!told('judy-alvarez', facts, journals).includes(rule.statement));
});

test('every outcome of the step B lanes has exactly one disposition, and a row disposition names a row in the spec', () => {
  const seen = new Set(), ids = new Set(spec.rows.map(row => row.id));
  for (const item of dispositions) {
    const key = `${item.decisionId}/${item.outcomeKey}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
    assert.match(item.disposition, /^(row:[a-z0-9._-]+|no-signal|zero-only|shared-writer|ambiguous|no-speaker|told-by-v|transient|out-of-scope|covered-by-existing-rule)$/, key);
    if (item.disposition.startsWith('row:')) assert.ok(ids.has(item.disposition.slice(4)), key);
  }
  for (const row of spec.rows) assert.ok(seen.has(`${row.decisionId}/${row.outcomeKey}`), row.id);
});
