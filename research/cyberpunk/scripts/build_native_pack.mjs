import {readFile, readdir, writeFile, mkdir, stat} from 'node:fs/promises';
import {resolve, dirname, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateKnowledgePack} from '../../../bridge/world-knowledge.mjs';

const here = dirname(fileURLToPath(import.meta.url)), research = resolve(here, '..'), root = resolve(research, '../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (object, key) => Object.hasOwn(object, key);
const enabled = rule => ['source-verified', 'live-verified'].includes(rule.status);
const safePath = value => typeof value === 'string' && /^(raw\/|localization\/raw\/|scene-evidence\/[a-z0-9-]+\/raw\/)/.test(value) && !value.includes('\\')
  && !value.split('/').some(part => !part || part === '..' || part === '.') && !value.includes(':');

export function jsonPointer(document, pointer) {
  if (pointer === '') return document;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw Error('Invalid JSON pointer');
  let value = document;
  for (const raw of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/u.test(raw)) throw Error('Invalid JSON pointer escape');
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !own(value, key)) throw Error('Missing JSON pointer');
    value = value[key];
  }
  return value;
}

export function mergeNativePacks(parts, profileKeys) {
  const sources = new Map(), evidence = new Map(), rules = new Map(), factAllowlist = {}, journalAllowlist = {};
  const versions = new Set(), errors = [];
  function rows(map, values, kind) {
    if (!Array.isArray(values)) { errors.push(`Invalid ${kind} list`); return; }
    for (const row of values) {
      if (!row?.id) { errors.push(`Missing ${kind} ID`); continue; }
      if (map.has(row.id) && !equal(map.get(row.id), row)) errors.push(`Conflicting ${kind} ID: ${row.id}`);
      else map.set(row.id, row);
    }
  }
  function inventory(destination, values, kind) {
    for (const [key, row] of Object.entries(values || {})) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) { errors.push(`Invalid ${kind} key`); continue; }
      if (!own(destination, key)) destination[key] = structuredClone(row);
      else {
        const previous = destination[key];
        const {evidenceRefs: a, writers: writersA, writerAuditScope: scopeA, ...left} = previous;
        const {evidenceRefs: b, writers: writersB, writerAuditScope: scopeB, ...right} = row;
        if (!equal(left, right)) errors.push(`Conflicting ${kind} entry: ${key}`);
        previous.evidenceRefs = [...new Set([...(a || []), ...(b || [])])];
        // Optional provenance can be richer in one author's lane. It cannot
        // change executable selectors or erase a different audit scope.
        if (writersA || writersB) previous.writers = [...new Map([...(writersA || []), ...(writersB || [])]
          .map(writer => [JSON.stringify(writer), writer])).values()];
        if (scopeA && scopeB && !equal(scopeA, scopeB)) errors.push(`Conflicting ${kind} writer audit scope: ${key}`);
        if (scopeA || scopeB) previous.writerAuditScope = scopeA || scopeB;
      }
    }
  }
  for (const part of parts) {
    if (part.version !== 1 || !Array.isArray(part.gameVersions)) { errors.push('Invalid native pack version'); continue; }
    for (const version of part.gameVersions) versions.add(version);
    rows(sources, part.sources, 'source'); rows(evidence, part.evidence, 'evidence'); rows(rules, part.rules, 'rule');
    inventory(factAllowlist, part.factAllowlist, 'fact'); inventory(journalAllowlist, part.journalAllowlist, 'journal');
  }
  const pack = {version: 1, id: 'cyberpunk-reviewed-knowledge', revision: 1, gameVersions: [...versions].sort(),
    profileKeys: [...profileKeys].sort(), sources: [...sources.values()], evidence: [...evidence.values()],
    factAllowlist, journalAllowlist, rules: [...rules.values()].sort((a, b) => a.id.localeCompare(b.id))};
  const validation = validateKnowledgePack(pack);
  errors.push(...validation.errors.map(row => `Runtime pack: ${JSON.stringify(row)}`));
  return {pack, errors};
}

/** Authored semantics require review; these checks prove the cited artifact exists unchanged. */
export async function verifyNativeEvidence({pack, inventory, loadArtifact, decisions}) {
  const errors = [], verified = [], assets = new Map((inventory.assets || []).filter(row => row.winner).map(row => [row.jsonPath, row]));
  const cached = new Map();
  for (const evidence of pack.evidence) {
    if (evidence.kind !== 'native') continue;
    const refs = [evidence.native, ...(evidence.nativeRefs || [])];
    if (!evidence.native) { errors.push(`${evidence.id}: native artifact details missing`); continue; }
    for (const reference of refs) {
      const asset = assets.get(reference?.jsonPath);
      if (!safePath(reference?.jsonPath) || !asset || !/^[a-f0-9]{64}$/.test(reference.assetSha256)
        || reference.assetSha256 !== asset.assetSha256) {
        errors.push(`${evidence.id}: missing, overridden or mismatched native asset`); continue;
      }
      try {
        if (!cached.has(reference.jsonPath)) {
          const artifact = await loadArtifact(asset);
          cached.set(reference.jsonPath, {...artifact, rawSha256: hash(artifact.raw)});
        }
        const artifact = cached.get(reference.jsonPath);
        if (artifact.rawSha256 !== reference.assetSha256) throw Error('Native binary hash mismatch');
        const pointed = jsonPointer(artifact.json, reference.jsonPointer);
        if (reference.expectedType !== undefined && pointed?.$type !== reference.expectedType) throw Error('Native node type mismatch');
        if (own(reference, 'expectedValue') && !equal(pointed, reference.expectedValue)) throw Error('Native value mismatch');
        verified.push({evidenceId: evidence.id, jsonPath: reference.jsonPath, jsonPointer: reference.jsonPointer,
          assetSha256: reference.assetSha256, jsonSha256: artifact.jsonSha256,
          archive: asset.archive, archiveEntrySha1: asset.archiveEntrySha1, depotPath: asset.depotPath});
      } catch (error) { errors.push(`${evidence.id}: ${error.message}`); }
    }
  }
  const mapped = new Map();
  for (const rule of pack.rules.filter(enabled)) {
    if (!Array.isArray(rule.narrativeLinks) || !rule.narrativeLinks.length) {
      errors.push(`${rule.id}: missing narrative outcome link`); continue;
    }
    for (const link of rule.narrativeLinks) {
      const decision = decisions.get(link.decisionId), outcome = decision?.outcomes?.find(row => row.key === link.outcomeKey);
      if (!outcome || decision.questKey !== rule.questKey) {
        errors.push(`${rule.id}: unknown or mismatched narrative outcome ${link.decisionId}/${link.outcomeKey}`); continue;
      }
      const key = `${link.decisionId}/${link.outcomeKey}`;
      if (!mapped.has(key)) mapped.set(key, []);
      mapped.get(key).push(rule.id);
    }
  }
  const outcomes = [...decisions.values()].flatMap(decision => (decision.outcomes || []).map(outcome => ({
    decisionId: decision.id, questKey: decision.questKey, outcomeKey: outcome.key,
    rules: mapped.get(`${decision.id}/${outcome.key}`) || [],
  })));
  return {errors, verified, outcomes, counts: {enabledRules: pack.rules.filter(enabled).length,
    citedArtifacts: cached.size, verifiedEvidencePointers: verified.length, outcomesResearched: outcomes.length,
    outcomesWithReviewedRules: outcomes.filter(row => row.rules.length).length,
    outcomesUnmapped: outcomes.filter(row => !row.rules.length).length}};
}

async function main() {
  const read = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  const parts = await Promise.all((await readdir(resolve(research, 'native-rules'))).filter(name => name.endsWith('.json')).sort()
    .map(name => read(resolve(research, 'native-rules', name))));
  const profiles = await read(resolve(root, 'characters/roster.json'));
  const catalog = await read(resolve(research, 'generated/quest-catalog.json'));
  const decisions = new Map(catalog.quests.flatMap(quest => quest.decisions.map(decision => [decision.id, {...decision, questKey: quest.key}])));
  const {pack, errors} = mergeNativePacks(parts, profiles.map(row => row.key));
  const cache = resolve(research, 'cache/game'), inventory = await read(resolve(cache, 'inventory.json'));
  // Scene exports are deliberately bounded to reviewed graph references and
  // keep separate manifests. Canonicalize their paths without flattening them.
  for (const name of await readdir(resolve(cache, 'scene-evidence')).catch(() => [])) {
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    const prefix = `scene-evidence/${name}/`;
    const scene = await read(resolve(cache, prefix, 'inventory.json')).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (scene) inventory.assets.push(...scene.assets.map(asset => ({...asset,
      jsonPath: prefix + asset.jsonPath, rawPath: prefix + asset.rawPath})));
  }
  // Shipped localized text has its own winning base/EP1 manifest. Scene English
  // can differ from the installed language archive; retain both as distinct refs.
  const localization = await read(resolve(cache, 'localization/inventory.json')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (localization) inventory.assets.push(...localization.assets.map(asset => ({...asset,
    jsonPath: `localization/${asset.jsonPath}`, rawPath: `localization/${asset.rawPath}`})));
  const loadArtifact = async asset => {
    const rawPath = resolve(cache, asset.rawPath), jsonPath = resolve(cache, asset.jsonPath);
    for (const path of [rawPath, jsonPath]) {
      const local = relative(cache, path);
      if (local.startsWith('..') || isAbsolute(local) || (await stat(path)).size > 128 * 1024 * 1024) throw Error('Native artifact outside budget/root');
    }
    const [raw, jsonRaw] = await Promise.all([readFile(rawPath), readFile(jsonPath)]);
    return {raw, json: JSON.parse(jsonRaw.toString('utf8').replace(/^\uFEFF/, '')), jsonSha256: hash(jsonRaw)};
  };
  const result = await verifyNativeEvidence({pack, inventory, loadArtifact, decisions});
  errors.push(...result.errors);
  const report = {version: 1, builtAt: new Date().toISOString(), errors, ...result.counts,
    verified: result.verified, outcomes: result.outcomes,
    qualification: errors.length ? 'rejected' : 'source-verified-not-live-qualified'};
  await mkdir(resolve(research, 'generated'), {recursive: true});
  await writeFile(resolve(research, 'generated/native-coverage.json'), JSON.stringify(report, null, 2) + '\n');
  if (!errors.length) {
    const serialized = JSON.stringify(pack, null, 2) + '\n';
    await writeFile(resolve(research, 'generated/world-knowledge.json'), serialized);
    if (process.argv.includes('--apply')) await writeFile(resolve(root, 'characters/world-knowledge.json'), serialized);
  }
  console.log(JSON.stringify({errors, ...result.counts, qualification: report.qualification}, null, 2));
  if (errors.length) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
