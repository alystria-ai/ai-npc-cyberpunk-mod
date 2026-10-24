import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
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

// ---- 2026-10-15: the offline check promoted four rows and the Queen row joined its topic domain ----
const PROMOTED = ['db.oda-spared', 'db.royce-downed-by-militech', 'db.hearts-testimony-anonymized', 'db.queen-friendship-hook'];

test('the four rows the offline check promoted are executable, the rest stay candidates with a live check', () => {
  assert.ok(spec.rows.filter(row => row.status === 'verified').length >= 13);
  for (const id of PROMOTED) assert.equal(rows.find(rule => rule.id === id).status, 'source-verified', id);
  for (const row of spec.rows.filter(candidate => candidate.status === 'unverified')) {
    assert.ok(typeof row.liveCheck === 'string' && row.liveCheck.length > 40, `${row.id} has no live-check recipe`);
    assert.ok(typeof row.offline?.review === 'string' && row.offline.review.length > 40, `${row.id} has no offline review`);
    assert.ok(typeof row.unverifiedBecause === 'string', row.id);
  }
});

test('db.queen-friendship-hook joins the reviewed Panam romance topic through a pinned alias', async () => {
  const {nativeRuleAuthorHash} = await import('../research/cyberpunk/scripts/narrative_topic_identity.mjs');
  const aliases = read('../research/cyberpunk/native-topic-aliases.json').aliases;
  const rule = rows.find(candidate => candidate.id === 'db.queen-friendship-hook');
  const romance = pack.rules.find(candidate => candidate.id === 'aldecaldos.native.panam-basilisk-intimacy');
  assert.equal(rule.topic, romance.topic, 'same native topic, so the two outcomes exclude each other');
  assert.notEqual(rule.outcome, romance.outcome);
  const alias = aliases.find(entry => entry.ruleId === rule.id);
  assert.ok(alias?.reviewed === true && alias.nativeTopic === rule.topic && alias.catalogTopic === 'panam.romance');
  // The alias pins the rule as authored (2.31). The published pack adds 2.5 after the 2.5 check (build_native_pack.mjs, game-2.5-check.json).
  const authored = {...rule, gameVersions: rule.gameVersions.filter(version => version !== '2.5')};
  assert.equal(alias.ruleSha256, nativeRuleAuthorHash(authored), 'the alias pins this exact rule');
  assert.ok(existsSync(new URL(`../research/cyberpunk/${alias.reviewRef}`, import.meta.url)));
  // The friendship hook alone: Panam tells it. The romance alone is unchanged. Both together are a contradiction and neither is told.
  const hook = {'al5.panam.friendship-hook': journal('queen-of-the-highway', 'active')};
  assert.ok(told('panam-palmer', {}, hook).includes(rule.statement));
  assert.ok(!told('judy-alvarez', {}, hook).includes(rule.statement));
  const lover = {sq027_panzer_sex: fact(), sq027_panam_lover: fact()};
  assert.ok(told('panam-palmer', lover, {}).includes(romance.statement));
  const both = told('panam-palmer', lover, hook);
  assert.ok(!both.includes(rule.statement) && !both.includes(romance.statement));
});

test('the promoted rows reach the one who would know and nobody else', () => {
  const cases = [
    ['db.oda-spared', 'takemura', {q112_08_oda_spared: fact()}, {'jt.parade.oda-defeated': journal('play-it-safe')}],
    ['db.royce-downed-by-militech', 'jackie-welles', {q003_militech_invades: fact(), q003_royce_dead: fact()}, {'jt.pickup.completed': journal('the-pickup')}],
    ['db.hearts-testimony-anonymized', 'mr-hands', {sts_ep1_06_testimony_agree: fact()}, {'pg5.hearts.completed': journal('gig-heaviest-of-hearts')}]];
  for (const [id, speaker, facts, journals] of cases) {
    const rule = rows.find(candidate => candidate.id === id);
    assert.ok(told(speaker, facts, journals).includes(rule.statement), id);
    assert.ok(!told(speaker, {}, journals).includes(rule.statement), `${id} needs its fact`);
    assert.ok(!told('judy-alvarez', facts, journals).includes(rule.statement), `${id} is not for Judy`);
  }
});

test('Oda spared and Oda killed exclude each other, and Royce under the Militech assault does not fire after the boss fight', () => {
  const spared = rows.find(candidate => candidate.id === 'db.oda-spared'), killed = pack.rules.find(candidate => candidate.id === 'jt.oda-fate.killed');
  assert.equal(spared.topic, killed.topic);
  const both = told('takemura', {q112_08_oda_spared: fact(), q112_oda_dead: fact()}, {'jt.parade.oda-defeated': journal('play-it-safe')});
  assert.ok(!both.includes(spared.statement) && !both.includes(killed.statement), 'a contradictory snapshot tells neither');
  const royce = rows.find(candidate => candidate.id === 'db.royce-downed-by-militech');
  const bossFight = told('jackie-welles', {q003_royce_dead: fact()}, {'jt.pickup.completed': journal('the-pickup')});
  assert.ok(!bossFight.includes(royce.statement));
});

test('the committed offline check covers every spec row and agrees with the grades the rows rely on', () => {
  const report = read('../research/cyberpunk/generated/decision-rows-offline-check.json');
  assert.ok(report.savesRead >= 100);
  assert.deepEqual(report.rows.map(row => row.id).sort(), spec.rows.map(row => row.id).sort());
  for (const id of PROMOTED) {
    const row = report.rows.find(candidate => candidate.id === id);
    assert.equal(row.grade, 'anchored-and-seen', id);
    assert.ok(row.conditionHoldsInSaves > 0, id);
  }
  for (const row of report.rows) assert.ok(row.combos.rows.length > 0 && row.combos.selectors.length > 0, row.id);
});
