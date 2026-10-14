// Step B of docs/QUEST_DECISIONS.md: turn a small, human-written spec of decision rows into a native-rules lane
// file that build_native_pack.mjs merges and verifies like every other lane.
//
//   node research/cyberpunk/scripts/decision_rows.mjs [--spec file] [--out file] [--saves "<Saved Games dir>"] [--check]
//
// The spec (research/cyberpunk/decision-rows-b.json) lists rows. A row is either
//   status "verified"   -> an executable rule (status source-verified). Every fact it reads gets an allowlist entry
//                          whose evidence points at a hash-bound export of the node that writes it. It needs a
//                          positive condition: a fact that reads 0 is "unknown" in the game, never "refused".
//   status "unverified" -> a non-executable row (status candidate): the draft rule is kept under "candidate" and
//                          nothing is added to the allowlists, so the game never reads its facts.
// Facts cited by a verified row must be writable by a node that is present in a scene-evidence batch (those are
// exported with recorded JSON hashes). When the only writer is in the bulk index, the tool lists the depot paths to
// export first (extract_scene_evidence.py) instead of citing an unbound file.
import {readFile, writeFile, readdir} from 'node:fs/promises';
import {existsSync, createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeRuleAuthorHash} from './narrative_topic_identity.mjs';

const here = dirname(fileURLToPath(import.meta.url)), research = resolve(here, '..'), root = resolve(research, '../..');
const identifier = v => typeof v === 'string' && v.length <= 160 && /^[a-z0-9][a-z0-9_.-]*$/u.test(v);
const factName = v => typeof v === 'string' && /^[A-Za-z0-9_#. -]{1,120}$/u.test(v);
const sha12 = text => createHash('sha256').update(text).digest('hex').slice(0, 12);
const PERSPECTIVES = new Set(['participant', 'witnessed', 'private', 'told-by-v']);
const CHANNELS = new Set(['private', 'phone', 'group']);
const FACT_OPS = new Set(['eq', 'ne', 'gte', 'lte', 'in']);
const JOURNAL_STATES = new Set(['inactive', 'active', 'succeeded', 'failed']);
const ALIAS_POLICIES = new Set(['identity-preserving-namespace', 'compatible-facet', 'compatible-stage', 'mutually-exclusive-stance']);

/** Leaves of a condition tree, depth-first. */
export function leaves(node, out = []) {
  if (node?.all || node?.any) for (const child of node.all || node.any) leaves(child, out);
  else if (node) out.push(node);
  return out;
}

/** True when a leaf could hold with a zero (absent) fact: the game reads absent facts as 0 and the Lua collector
 *  reports a zero as unknown, so such a leaf can never be proven. */
export function acceptsZero(leaf) {
  if (leaf.type !== 'fact') return false;
  if (leaf.op === 'eq') return leaf.value === 0;
  if (leaf.op === 'gte') return leaf.value <= 0;
  if (leaf.op === 'in') return leaf.value.includes(0);
  return ['ne', 'lte'].includes(leaf.op);
}

function checkCondition(condition, errors, where, {facts, journals}) {
  if (!condition) { errors.push(`${where}: condition required`); return; }
  const check = (node, depth) => {
    if (depth > 4) { errors.push(`${where}: condition too deep`); return; }
    if (node.all || node.any) {
      const list = node.all || node.any;
      if (Object.keys(node).length !== 1 || !Array.isArray(list) || !list.length || list.length > 6) errors.push(`${where}: bad all/any`);
      else list.forEach(child => check(child, depth + 1));
      return;
    }
    if (node.type === 'fact') {
      if (!factName(node.key) || !FACT_OPS.has(node.op)) errors.push(`${where}: bad fact leaf ${JSON.stringify(node)}`);
      else if (node.op === 'in' ? !Array.isArray(node.value) || !node.value.every(Number.isInteger) : !Number.isInteger(node.value)) errors.push(`${where}: bad fact value ${node.key}`);
      else if (acceptsZero(node)) errors.push(`${where}: ${node.key} ${node.op} ${node.value} accepts zero; a zero fact is unknown, not a refusal`);
    } else if (node.type === 'journal') {
      if (!journals[node.key]) errors.push(`${where}: journal key ${node.key} is not in the pack's journal allowlist`);
      if (!['eq', 'ne', 'in'].includes(node.op) || (node.op === 'in' ? !Array.isArray(node.value) || !node.value.every(v => JOURNAL_STATES.has(v)) : !JOURNAL_STATES.has(node.value))) errors.push(`${where}: bad journal leaf ${node.key}`);
      if (node.op === 'ne') errors.push(`${where}: journal ne needs a guard; use eq/in`);
    } else errors.push(`${where}: unknown leaf type ${node.type}`);
    void facts;
  };
  check(condition, 1);
}

/** Validate the spec without touching the game data. */
export function validateSpec(spec, {decisions, profiles, journals, facts = {}}) {
  const errors = [], ids = new Set(), outcomes = new Set();
  if (spec?.version !== 1 || !Array.isArray(spec.rows)) return ['spec: version 1 and rows required'];
  for (const [i, row] of spec.rows.entries()) {
    const where = `rows[${i}] ${row?.id}`;
    if (!identifier(row?.id) || ids.has(row.id)) errors.push(`${where}: bad or duplicate id`);
    ids.add(row?.id);
    if (!['verified', 'unverified'].includes(row?.status)) errors.push(`${where}: status`);
    const decision = decisions.get(row?.decisionId), outcome = decision?.outcomes?.find(o => o.key === row?.outcomeKey);
    if (!outcome) { errors.push(`${where}: unknown decision/outcome ${row?.decisionId}/${row?.outcomeKey}`); continue; }
    const pair = `${row.decisionId}/${row.outcomeKey}`;
    if (row.status === 'verified' && outcomes.has(pair)) errors.push(`${where}: two verified rows for ${pair}`);
    if (row.status === 'verified') outcomes.add(pair);
    if (typeof row.statement !== 'string' || row.statement.length < 20 || row.statement.length > 600) errors.push(`${where}: statement length`);
    if (!/^V |^Johnny |^[A-Z]/.test(row.statement || '')) errors.push(`${where}: statement should start with a capital`);
    if (!Array.isArray(row.speakers) || !row.speakers.length || !row.speakers.every(s => profiles.has(s))) errors.push(`${where}: speakers must be roster keys`);
    if (!PERSPECTIVES.has(row.perspective)) errors.push(`${where}: perspective`);
    if (row.channels !== undefined && !(Array.isArray(row.channels) && row.channels.length && row.channels.every(c => CHANNELS.has(c)))) errors.push(`${where}: channels`);
    if (typeof row.notes !== 'string' || row.notes.length < 20) errors.push(`${where}: notes (why this reading is right, or why it is unverified)`);
    // A row whose decision already has rules under a reviewed topic alias names its native topic and the reviewed alias that joins it
    // (narrative_topic_identity.mjs refuses a canonical-topic rule next to an alias domain, and a native topic without an alias).
    if (row.topic !== undefined || row.topicAlias !== undefined) {
      const alias = row.topicAlias;
      if (!identifier(row.topic) || row.topic === decision.topic) errors.push(`${where}: topic must be a native topic different from the catalog topic ${decision.topic}`);
      if (!alias || !ALIAS_POLICIES.has(alias.policy) || typeof alias.rationale !== 'string' || !alias.rationale.trim() || alias.rationale.length > 1200
        || !/^native-reviews\/[a-z0-9-]+\.md$/u.test(alias.reviewRef || '')) errors.push(`${where}: topicAlias needs a policy, a rationale and a native-reviews/<name>.md reviewRef`);
      if (row.status !== 'verified') errors.push(`${where}: only a verified row joins a topic domain`);
    }
    if (row.liveCheck !== undefined && (typeof row.liveCheck !== 'string' || row.liveCheck.length < 20)) errors.push(`${where}: liveCheck`);
    if (row.status === 'verified') {
      if (row.perspective === 'told-by-v') errors.push(`${where}: a told-by-v rule needs a disclosure receipt, not a save fact`);
      checkCondition(row.condition, errors, where, {facts, journals});
      if (!leaves(row.condition).some(l => l.type === 'fact') && !leaves(row.condition).some(l => l.type === 'journal')) errors.push(`${where}: no selector`);
    } else {
      if (typeof row.unverifiedBecause !== 'string' || row.unverifiedBecause.length < 15) errors.push(`${where}: unverifiedBecause`);
    }
  }
  return errors;
}

async function streamWriters(indexPath, names) {
  const writers = new Map();
  for await (const line of createInterface({input: createReadStream(indexPath)})) {
    if (!line.includes('"role":"assignment"')) continue;
    const row = JSON.parse(line);
    if (!names.has(row.factName)) continue;
    if (!writers.has(row.factName)) writers.set(row.factName, []);
    writers.get(row.factName).push({jsonPath: row.source.jsonPath, assetSha256: row.source.assetSha256, depot: row.source.depotPath,
      jsonPointer: row.jsonPointer, value: row.value, setExactValue: row.setExactValue, bound: false});
  }
  return writers;
}

function walk(node, pointer, visit) {
  if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${pointer}/${i}`, visit)); return; }
  if (!node || typeof node !== 'object') return;
  visit(node, pointer);
  for (const key of Object.keys(node)) walk(node[key], `${pointer}/${key}`, visit);
}

/** Hash-bound writers: every scene-evidence batch asset that contains a questSetVar for one of the names. */
async function batchWriters(cache, names) {
  const writers = new Map(), seen = new Set(), list = [...names];
  const base = resolve(cache, 'scene-evidence');
  for (const batch of await readdir(base).catch(() => [])) {
    const inventory = resolve(base, batch, 'inventory.json');
    if (!existsSync(inventory)) continue;
    const doc = JSON.parse((await readFile(inventory, 'utf8')).replace(/^﻿/, ''));
    for (const asset of doc.assets || []) {
      if (!asset.winner || !asset.jsonSha256 || !/\.(scene|questphase)$/.test(asset.depotPath) || seen.has(asset.assetSha256)) continue;
      seen.add(asset.assetSha256);
      const file = resolve(base, batch, asset.jsonPath);
      if (!existsSync(file)) continue;
      const text = (await readFile(file, 'utf8')).replace(/^﻿/, '');
      if (!list.some(name => text.includes(name))) continue;
      walk(JSON.parse(text), '', (node, pointer) => {
        if (node.$type !== 'questSetVar_NodeType' || !node.factName) return;
        const name = node.factName.$value ?? node.factName;
        if (!names.has(name)) return;
        if (!writers.has(name)) writers.set(name, []);
        writers.get(name).push({jsonPath: `scene-evidence/${batch}/${asset.jsonPath}`, assetSha256: asset.assetSha256, jsonSha256: asset.jsonSha256,
          depot: asset.depotPath, jsonPointer: pointer, value: node.value, setExactValue: node.setExactValue, bound: true});
      });
    }
  }
  return writers;
}

export async function collectWriters(cache, names) {
  const [bound, bulk] = await Promise.all([batchWriters(cache, names), streamWriters(resolve(cache, 'index/facts.jsonl'), names)]);
  const result = new Map();
  for (const name of names) {
    const rows = [...(bound.get(name) || [])];
    const have = new Set(rows.map(r => r.assetSha256));
    // A bulk-index writer is only usable once its asset has been re-exported with recorded hashes.
    const missing = (bulk.get(name) || []).filter(r => !have.has(r.assetSha256));
    result.set(name, {bound: rows, unbound: missing});
  }
  return result;
}

const positive = writer => (Number(writer.value) || 0) > 0;
const sourceText = depot => `archive winner ${depot} exported with WolvenKit CLI (scene-evidence batch); raw SHA-256 and serialized JSON SHA-256 are recorded in the batch inventory. Authored by research/cyberpunk/scripts/decision_rows.mjs from decision-rows-b.json.`;

/** Build the lane file. `pack` is the current merged pack (its allowlists tell which selectors already exist). */
export function buildLane({spec, pack, decisions, writers, id, saveNotes = {}}) {
  const errors = [], sources = new Map(), evidence = new Map(), rules = [], factAllowlist = {}, needExports = new Map();
  const evidenceFor = (name, writer) => {
    const key = `db.ev.fact.${name}.${sha12(`${writer.jsonPath}${writer.jsonPointer}`)}`.toLowerCase();
    if (!evidence.has(key)) {
      const sourceId = `db.source.${sha12(writer.assetSha256)}`;
      sources.set(sourceId, {id: sourceId, kind: 'native', locator: sourceText(writer.depot)});
      evidence.set(key, {id: key, sourceId, kind: 'native',
        locator: `${writer.depot.split('\\').pop()} sets ${name} to ${writer.value} (questSetVar node).`, gameVersions: ['2.31'],
        native: {jsonPath: writer.jsonPath, assetSha256: writer.assetSha256, jsonSha256: writer.jsonSha256, jsonPointer: writer.jsonPointer,
          expectedType: 'questSetVar_NodeType', expected: {'/factName': name, '/value': writer.value}}});
    }
    return key;
  };
  for (const row of spec.rows) {
    const decision = decisions.get(row.decisionId);
    const link = [{decisionId: row.decisionId, outcomeKey: row.outcomeKey}];
    const audience = {speakers: [...row.speakers], perspective: row.perspective, channels: row.channels || ['private', 'phone'],
      recipients: ['v', ...new Set(row.recipients || row.speakers)].filter((v, i, a) => a.indexOf(v) === i)};
    const common = {id: row.id, revision: 1, questKey: decision.questKey, topic: row.topic ?? decision.topic, outcome: row.outcomeKey};
    if (row.status === 'unverified') {
      rules.push({id: row.id, status: 'candidate', questKey: decision.questKey, narrativeLinks: link,
        notes: `Unverified candidate, not executable. ${row.unverifiedBecause} ${row.notes}`,
        candidate: {statement: row.statement, audience, condition: row.condition ?? null, category: 'decision',
          saves: saveNotes[row.id] ?? null, ...(row.liveCheck ? {liveCheck: row.liveCheck} : {})}});
      continue;
    }
    const refs = new Set();
    for (const leaf of leaves(row.condition)) {
      if (leaf.type === 'journal') {
        const entry = pack.journalAllowlist[leaf.key];
        for (const ref of entry?.evidenceRefs || []) refs.add(ref);
        continue;
      }
      const collected = writers.get(leaf.key) || {bound: [], unbound: []};
      const picked = collected.bound.filter(positive);
      const existing = pack.factAllowlist[leaf.key];
      if (!picked.length && !existing) {
        errors.push(`${row.id}: ${leaf.key} has no positive writer in a hash-bound export`);
        for (const w of collected.unbound.filter(positive)) needExports.set(w.depot.toLowerCase(), w.depot);
        continue;
      }
      for (const w of picked) refs.add(evidenceFor(leaf.key, w));
      for (const ref of existing?.evidenceRefs || []) refs.add(ref);
      if (!existing && !factAllowlist[leaf.key]) {
        factAllowlist[leaf.key] = {evidenceRefs: picked.map(w => evidenceFor(leaf.key, w)),
          writers: picked.map(w => ({jsonPath: w.jsonPath, jsonPointer: w.jsonPointer, value: w.value, setExactValue: w.setExactValue ?? 0})),
          writerAuditScope: {scope: 'Positive assignments in freshly exported installed 2.31 native assets cited by this lane; writers outside these assets are not claimed to be exhausted.',
            candidateWriters: picked.length}};
      } else if (existing && !factAllowlist[leaf.key]) factAllowlist[leaf.key] = {evidenceRefs: [...existing.evidenceRefs]};
    }
    const sourceIds = [...new Set([...refs].map(ref => evidence.get(ref)?.sourceId ?? pack.evidence.find(e => e.id === ref)?.sourceId).filter(Boolean))];
    rules.push({...common, status: 'source-verified', reviewed: true, gameVersions: ['2.31'], category: 'decision',
      priority: row.priority ?? 7, stable: true, statement: row.statement, sourceIds, evidenceRefs: [...refs], audience,
      condition: row.condition, narrativeLinks: link, notes: row.notes});
  }
  const lane = {version: 1, id, revision: 1, gameVersions: ['2.31'], profileKeys: [], sources: [...sources.values()], evidence: [...evidence.values()],
    factAllowlist, journalAllowlist: {}, rules};
  return {lane, errors, needExports: [...needExports.values()]};
}

async function main() {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
  const specPath = resolve(arg('--spec', resolve(research, 'decision-rows-b.json')));
  const outPath = resolve(arg('--out', resolve(research, 'native-rules/decisions-b-20261014.json')));
  const read = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));
  const spec = await read(specPath), pack = await read(resolve(root, 'characters/world-knowledge.json'));
  const catalog = await read(resolve(research, 'generated/quest-catalog.json'));
  const roster = await read(resolve(root, 'characters/roster.json'));
  const decisions = new Map(catalog.quests.flatMap(q => q.decisions.map(d => [d.id, {...d, questKey: q.key}])));
  const specErrors = validateSpec(spec, {decisions, profiles: new Set(roster.map(r => r.key)), journals: pack.journalAllowlist, facts: pack.factAllowlist});
  if (specErrors.length) { console.error(specErrors.join('\n')); process.exitCode = 1; return; }
  const names = new Set(spec.rows.filter(r => r.status === 'verified').flatMap(r => leaves(r.condition)).filter(l => l.type === 'fact').map(l => l.key));
  const writers = await collectWriters(resolve(research, 'cache/game'), names);
  // Optional: check every fact of a verified row against real saves (nonzero somewhere), and record what was seen.
  const saveNotes = {};
  const savesDir = arg('--saves');
  if (savesDir) {
    const {saveState, fnv1a32} = await import('./save_snapshot.mjs');
    const observed = new Map([...names].map(n => [n, new Map()]));
    for (const name of await readdir(savesDir)) {
      let state; try { state = saveState(resolve(savesDir, name, 'sav.dat')); } catch { continue; }
      for (const n of names) { const v = state.facts.get(fnv1a32(n)); if (v) observed.get(n).set(v, (observed.get(n).get(v) || 0) + 1); }
    }
    for (const row of spec.rows.filter(r => r.status === 'verified')) for (const leaf of leaves(row.condition).filter(l => l.type === 'fact')) {
      if (!observed.get(leaf.key).size && !pack.factAllowlist[leaf.key]) specErrors.push(`${row.id}: ${leaf.key} is not set in any real save`);
    }
    for (const [n, m] of observed) console.log(`save values ${n}: ${[...m].map(([v, c]) => `${v}x${c}`).join(' ') || 'none'}`);
    if (specErrors.length) { console.error(specErrors.join('\n')); process.exitCode = 1; return; }
  }
  const {lane, errors, needExports} = buildLane({spec, pack, decisions, writers, id: 'decisions-b-20261014', saveNotes});
  if (errors.length) {
    console.error(errors.join('\n'));
    if (needExports.length) console.error(`Export these first (extract_scene_evidence.py, resource kind by extension):\n${needExports.join('\n')}`);
    process.exitCode = 1; return;
  }
  // Reviewed topic aliases for the rows that join an existing topic domain. The alias pins the rule's hash, so it is derived here from
  // the lane just built; a hand edit of a row changes the hash and the pack build then refuses the stale alias.
  const aliasPath = resolve(research, 'native-topic-aliases.json'), aliasDocument = await read(aliasPath), aliasErrors = [];
  const wanted = spec.rows.filter(row => row.status === 'verified' && row.topicAlias).map(row => {
    const rule = lane.rules.find(candidate => candidate.id === row.id), decision = decisions.get(row.decisionId);
    if (!existsSync(resolve(research, row.topicAlias.reviewRef))) aliasErrors.push(`${row.id}: review note ${row.topicAlias.reviewRef} does not exist`);
    return {ruleId: row.id, decisionId: row.decisionId, outcomeKey: row.outcomeKey, nativeTopic: row.topic, catalogTopic: decision.topic,
      ruleSha256: nativeRuleAuthorHash(rule), policy: row.topicAlias.policy, rationale: row.topicAlias.rationale,
      reviewRef: row.topicAlias.reviewRef, reviewed: true};
  });
  let aliasChanged = false;
  for (const alias of wanted) {
    const at = aliasDocument.aliases.findIndex(candidate => candidate.ruleId === alias.ruleId);
    if (at < 0) { aliasDocument.aliases.push(alias); aliasChanged = true; }
    else if (JSON.stringify(aliasDocument.aliases[at]) !== JSON.stringify(alias)) { aliasDocument.aliases[at] = alias; aliasChanged = true; }
  }
  if (aliasErrors.length) { console.error(aliasErrors.join('\n')); process.exitCode = 1; return; }
  if (process.argv.includes('--check') && aliasChanged) { console.error('native-topic-aliases.json is out of date for the topicAlias rows; run without --check'); process.exitCode = 1; return; }
  if (!process.argv.includes('--check')) {
    await writeFile(outPath, JSON.stringify(lane, null, 2) + '\n');
    if (aliasChanged) await writeFile(aliasPath, JSON.stringify(aliasDocument, null, 2) + '\n');
  }
  const verified = lane.rules.filter(r => r.status === 'source-verified').length;
  console.log(JSON.stringify({rows: lane.rules.length, verified, unverified: lane.rules.length - verified, aliases: wanted.length, facts: Object.keys(lane.factAllowlist).length,
    evidence: lane.evidence.length, written: !process.argv.includes('--check') ? outPath : null}, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
