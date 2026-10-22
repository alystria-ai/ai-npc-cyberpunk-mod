import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {serializeCharacterSamples} from '../../../scripts/character-samples.mjs';
import {applyRewrite} from '../../../scripts/first-person-profiles.mjs';
import {compileIntrinsicCharacterPacks, intrinsicProfileMaterial, adoptedIntrinsicKeys,
  requireAdoptedIntrinsicPacks, requireAdoptedIntrinsicMaterial} from './intrinsic_character_claims.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const folder = resolve(here, '..');
const text = value => typeof value === 'string' && value.trim().length > 0;
const array = value => Array.isArray(value) ? value : [];
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A character's example lines in the profile: the dossier's own plus the adopted native claim pack's. More than this many
// is too much prompt for what the lines teach, so a dossier that has more must pick (see nativeSampleIds below).
export const MAX_SAMPLES = 10;

export function validateResearch({roster, dossiers, maps}) {
  const errors = [], warnings = [];
  const expected = new Map(roster.map(value => [value.key, value]));
  const characters = new Map(), quests = new Map(), decisions = new Map();
  const error = (where, message) => errors.push(`${where}: ${message}`);
  function sources(document, where) {
    const ids = new Set();
    for (const source of array(document.sources)) {
      if (!text(source.id) || ids.has(source.id)) error(where, 'Missing or duplicate source ID');
      ids.add(source.id);
      if (!text(source.title) || !text(source.locator) || !text(source.notes)) error(where, `Incomplete source provenance: ${source.id}`);
      try { if (!['https:', 'http:'].includes(new URL(source.url).protocol)) throw Error(); }
      catch { error(where, `Invalid public source URL: ${source.id}`); }
    }
    if (!ids.size) error(where, 'No consulted sources');
    return ids;
  }
  function references(row, ids, where) {
    if (!Array.isArray(row.sourceIds) || !row.sourceIds.length) error(where, 'No source references');
    for (const id of array(row.sourceIds)) if (!ids.has(id)) error(where, `Unknown source ${id}`);
  }
  for (const map of maps) {
    const where = `quest-maps/${map.lane}`;
    if (map.version !== 1 || !text(map.lane)) error(where, 'Invalid version or lane');
    const ids = sources(map, where);
    for (const quest of array(map.quests)) {
      if (!text(quest.key) || !text(quest.title) || !text(quest.synopsis)) error(where, 'Incomplete quest identity or synopsis');
      references(quest, ids, `${where}/${quest.key}`);
      const combined = quests.get(quest.key) || {...quest, lanes: [], sources: [], decisions: [], stages: [], characters: []};
      combined.lanes.push(map.lane);
      const referencedSources = new Set([...array(quest.sourceIds), ...array(quest.stages).flatMap(row => array(row.sourceIds)),
        ...array(quest.decisions).flatMap(row => [...array(row.sourceIds), ...array(row.outcomes).flatMap(outcome => array(outcome.sourceIds))])]);
      combined.sources.push(...array(map.sources).filter(source => referencedSources.has(source.id)).map(source => ({...source, lane: map.lane})));
      combined.stages.push(...array(quest.stages).map(stage => ({...stage, lane: map.lane})));
      combined.characters = [...new Set([...combined.characters, ...array(quest.characters)])];
      for (const stage of array(quest.stages)) references(stage, ids, `${where}/${quest.key}/stage:${stage.key}`);
      for (const decision of array(quest.decisions)) {
        const name = `${where}/${decision.id}`;
        if (!text(decision.id) || decisions.has(decision.id)) error(name, 'Missing or duplicate global decision ID');
        if (!text(decision.description) || !text(decision.topic)) error(name, 'Missing decision description/topic');
        references(decision, ids, name);
        const outcomes = new Set();
        for (const outcome of array(decision.outcomes)) {
          if (!text(outcome.key) || outcomes.has(outcome.key)) error(name, 'Missing or duplicate outcome key');
          outcomes.add(outcome.key);
          if (!text(outcome.description)) error(name, 'Outcome has no meaning');
          references(outcome, ids, `${name}/${outcome.key}`);
        }
        if (!outcomes.size) error(name, 'No researched outcomes');
        if (!['unmapped', 'candidate', 'source-verified', 'live-verified', 'disabled'].includes(decision.runtime?.status)) error(name, 'Missing explicit runtime qualification');
        if (['source-verified', 'live-verified'].includes(decision.runtime?.status)) {
          // Narrative authors cannot qualify native code by citing a walkthrough.
          if (!decision.runtime.conditions || !array(decision.runtime.evidence).length) error(name, 'Executable decision lacks native condition evidence');
        }
        const compiled = {...decision, questKey: quest.key, lane: map.lane};
        decisions.set(decision.id, compiled); combined.decisions.push(compiled);
      }
      quests.set(quest.key, combined);
    }
  }
  for (const dossier of dossiers) {
    const where = `dossiers/${dossier.key}`;
    if (dossier.version !== 1 || !expected.has(dossier.key) || characters.has(dossier.key)) error(where, 'Unexpected/duplicate character or unsupported version');
    const ids = sources(dossier, where);
    const profile = dossier.profile || {};
    if (!text(profile.backstory) || !text(profile.speakingStyleDescription)) error(where, 'Separate biography/style fields required');
    if (profile.publicSummary !== undefined && !text(profile.publicSummary)) error(where, 'Public summary must be nonempty text');
    if (array(profile.speakingStyleSampleDialogues).length < 6 || !profile.speakingStyleSampleDialogues.every(text)) error(where, 'At least six original delivery examples required');
    if (new Set(array(profile.speakingStyleSampleDialogues)).size !== array(profile.speakingStyleSampleDialogues).length) error(where, 'Duplicate dialogue examples');
    try { serializeCharacterSamples(profile.speakingStyleSampleDialogues, expected.get(dossier.key) || dossier); }
    catch (exception) { error(where, exception.message); }
    if (profile.nativeSampleIds !== undefined && (!Array.isArray(profile.nativeSampleIds) || !profile.nativeSampleIds.every(text))) error(where, 'nativeSampleIds must be a list of native sample IDs');
    if (!array(dossier.intrinsicClaims).length) error(where, 'No individual supported identity claims');
    for (const claim of array(dossier.intrinsicClaims)) {
      references(claim, ids, `${where}/${claim.id}`);
      if (!text(claim.text) || !['corroborated', 'source-supported', 'uncertain'].includes(claim.confidence)) error(where, 'Claim lacks text/confidence');
    }
    for (const type of ['background', 'private', 'unknown', 'conditional']) if (!Array.isArray(dossier.knowledge?.[type])) error(where, `Missing knowledge.${type}`);
    const conditional = [...array(dossier.knowledge?.conditional)];
    for (const relation of array(dossier.relationships)) {
      references(relation, ids, `${where}/relationship:${relation.withKey}`);
      conditional.push(...array(relation.changes));
    }
    for (const item of conditional) {
      references(item, ids, `${where}/conditional:${item.decisionId}`);
      const decision = decisions.get(item.decisionId);
      if (!decision) error(where, `Unknown conditional decision ${item.decisionId}`);
      else {
        if (decision.questKey !== item.questKey) error(where, `Conditional quest mismatch for ${item.decisionId}`);
        if (!array(decision.outcomes).some(outcome => outcome.key === item.outcomeKey)) error(where, `Unknown required outcome ${item.decisionId}/${item.outcomeKey}`);
      }
    }
    for (const questKey of array(dossier.questKeys)) if (!quests.has(questKey)) warnings.push(`${where}: quest ${questKey} has no authored map yet`);
    characters.set(dossier.key, dossier);
  }
  const missing = [...expected.keys()].filter(key => !characters.has(key));
  if (missing.length) errors.push(`Missing dossiers: ${missing.join(', ')}`);
  const statuses = {};
  for (const decision of decisions.values()) statuses[decision.runtime?.status || 'missing'] = (statuses[decision.runtime?.status || 'missing'] || 0) + 1;
  return {errors, warnings, characters, quests, decisions, coverage: {
    profilesExpected: expected.size, profilesAuthored: characters.size, profilesMissing: missing,
    questLanes: maps.length, questsAuthored: quests.size, decisionsAuthored: decisions.size,
    outcomesAuthored: [...decisions.values()].reduce((count, decision) => count + array(decision.outcomes).length, 0),
    runtimeQualification: statuses,
    nativeMappingComplete: decisions.size > 0 && [...decisions.values()].every(decision => ['source-verified', 'live-verified'].includes(decision.runtime?.status)),
  }};
}

// Visible appearance (characters/appearance.json, read by buildResearch). Only a nonempty
// text adds a section; it is second person ("You have ...") like the rest of the biography.
function appearanceSection(appearance, key) {
  const text = appearance[key]?.text?.trim();
  return text ? ['Your appearance:\n' + text] : [];
}

// `firstPerson` is the `characters` map of characters/first-person-profiles.json: a first-person copy of
// the composed backstory (everything but the appearance and the ownership marker) and of the dossier's
// speaking style paragraphs, valid only for the exact third-person text it was written from.
export function buildProfiles(roster, dossiers, {intrinsicPacks = [], intrinsicRoot = root, loadIntrinsicArtifact, appearance = {}, firstPerson = {}, maxSamples = MAX_SAMPLES} = {}) {
  const byKey = new Map(dossiers.map(dossier => [dossier.key, dossier]));
  for (const key of Object.keys(firstPerson)) {
    if (!roster.some(old => old.key === key)) throw Error(`First-person text for an unknown character: ${key}`);
  }
  for (const key of Object.keys(appearance)) {
    if (!roster.some(old => old.key === key)) throw Error(`Appearance text for an unknown character: ${key}`);
  }
  const intrinsic = new Map(compileIntrinsicCharacterPacks(intrinsicPacks,
    {roster, root: intrinsicRoot, loadArtifact: loadIntrinsicArtifact})
    .map(view => [view.key, intrinsicProfileMaterial(view)]));
  return roster.map(old => {
    const dossier = byKey.get(old.key);
    if (!dossier) throw Error(`Missing dossier ${old.key}`);
    const native = intrinsic.get(old.key);
    const backstoryCore = [dossier.profile.backstory.trim(),
      ...(dossier.knowledge.background.length ? ['ESTABLISHED BACKGROUND\n' + [...new Set(dossier.knowledge.background)].join('\n')] : []),
      ...(dossier.relationships.length ? ['ESTABLISHED RELATIONSHIPS\n'
        + dossier.relationships.map(row => `${row.withKey}: ${row.baseline}`).join('\n')] : []),
      ...(native?.backstory ? [native.backstory] : []),
      'KNOWLEDGE AND CURRENT SAVE\nUse verified current-save context for decisions and relationship state. '
        + 'Current game state overrides conflicting memories. Summoning a copy establishes no quest outcome, survival, romance or prior meeting. '
        + 'When asked about unknown events, acknowledge the uncertainty. Your background is your own knowledge, not proof that V or the other listeners know your secrets. '
        + 'Keep private motives, covert identities and confidences private unless verified context establishes disclosure to this audience. '
        + 'A group invitation or direct question alone does not establish that disclosure.',
      'KNOWLEDGE LIMITS\n' + dossier.knowledge.unknown.join('\n')].join('\n\n');
    const backstory = [applyRewrite(backstoryCore, firstPerson[old.key]?.backstory, old.key + '/backstory'),
      ...appearanceSection(appearance, old.key),
      `[CyberpunkConvai profile v2:${old.key}]`].join('\n\n');
    const speakingStyleDescription = [applyRewrite(dossier.profile.speakingStyleDescription.trim(),
        firstPerson[old.key]?.speakingStyleDescription, old.key + '/speaking style'),
      'Speak naturally to V, usually in one or two sentences unless asked for detail. '
        + 'Give only the spoken reply, without prepending your name or a speaker label. '
        + 'No stage directions or markdown. Dialogue samples are original delivery examples, not memories. '
        + 'In a group, speak for yourself and leave room for the others. Never reveal private conversation history to a group.'].join('\n\n');
    const {sampleDialogue: retiredExamples, speakingRules: retiredStyle, relationships: retiredRelationships,
      nativeIntrinsic: retiredNative, nativeIntrinsicRevision: retiredNativeRevision, ...preserved} = old;
    const samples = serializeCharacterSamples(dossier.profile.speakingStyleSampleDialogues, old).split(/\n\s*\n/u);
    // The native pack's example lines are hash-bound and cannot be edited here; `profile.nativeSampleIds` lists the ones to
    // keep (in order). Without it all of them are used.
    const nativeIds = native?.receipt?.sampleIds || [];
    const nativeSamples = native && Array.isArray(dossier.profile.nativeSampleIds)
      ? dossier.profile.nativeSampleIds.map(id => {
        const at = nativeIds.indexOf(id);
        if (at < 0) throw Error(`${old.key}: nativeSampleIds names ${id}, which the native pack does not have`);
        return native.samples[at];
      })
      : native?.samples || [];
    const allSamples = [...new Set([...samples, ...nativeSamples])];
    if (allSamples.length > maxSamples) throw Error(`${old.key}: ${allSamples.length} example lines; at most ${maxSamples} (pick native ones with profile.nativeSampleIds)`);
    return {...preserved, kind: dossier.kind, summary: (dossier.profile.publicSummary || dossier.profile.backstory).trim(), backstory, speakingStyleDescription,
      // Keep the research transcript in its dossier; the API field is examples
      // of this character's speech only, with no V prompt or speaker prefix.
      speakingStyleSampleDialogues: serializeCharacterSamples(allSamples, old),
      profileRevision: 5, backstoryWords: backstory.split(/\s+/).length,
      researchRevision: native?.backstory ? fingerprint({dossier, nativeIntrinsicRevision: native.revision}) : fingerprint(dossier),
      ...(native?.backstory ? {nativeIntrinsicRevision: native.revision, nativeIntrinsic: native.receipt} : {}),
      researchPath: `research/cyberpunk/dossiers/${old.key}.json`,
      sources: dossier.sources, uncertainty: dossier.uncertainties};
  });
}

async function jsonFiles(path) {
  return Promise.all((await readdir(path).catch(() => [])).filter(name => name.endsWith('.json')).sort()
    .map(async name => JSON.parse((await readFile(resolve(path, name), 'utf8')).replace(/^\uFEFF/, ''))));
}
export async function buildResearch({applyProfiles = false, includeIntrinsicClaims = false, intrinsicPacks,
  loadIntrinsicArtifact, intrinsicRoot = root} = {}) {
  const roster = JSON.parse((await readFile(resolve(root, 'characters/roster.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const appearance = JSON.parse((await readFile(resolve(root, 'characters/appearance.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const firstPerson = JSON.parse((await readFile(resolve(root, 'characters/first-person-profiles.json'), 'utf8')
    .catch(() => '{"characters":{}}')).replace(/^﻿/, '')).characters;
  const settingsPath = resolve(root, 'characters/profile-settings.json');
  const settings = JSON.parse((await readFile(settingsPath, 'utf8')).replace(/^\uFEFF/, ''));
  const adopted = adoptedIntrinsicKeys(settings, roster);
  if (intrinsicPacks === undefined) {
    // Explicit first adoption can include the reviewed folder. Subsequent
    // ordinary profile builds require exactly the persisted adoption set, even
    // when the native cache is absent. Never silently shrink an adopted persona.
    intrinsicPacks = includeIntrinsicClaims ? await jsonFiles(resolve(folder, 'native-character-claims'))
      : await Promise.all(adopted.map(key => readFile(resolve(folder, 'native-character-claims', key + '.json'), 'utf8')
        .then(raw => JSON.parse(raw.replace(/^\uFEFF/, '')))
        .catch(cause => { throw Error(`Adopted intrinsic history ${key} cannot be loaded; restore its source pack and evidence before rebuilding.`, {cause}); })));
  }
  requireAdoptedIntrinsicPacks(adopted, intrinsicPacks);
  const dossiers = await jsonFiles(resolve(folder, 'dossiers'));
  const maps = await jsonFiles(resolve(folder, 'quest-maps'));
  const result = validateResearch({roster, dossiers, maps});
  // Resolve required native history before any generated outputs are replaced.
  // Explicit opt-in and persisted adoption both reject stale/missing evidence.
  const profiles = result.errors.length ? [] : buildProfiles(roster, dossiers,
    {intrinsicPacks, loadIntrinsicArtifact, intrinsicRoot, appearance, firstPerson});
  if (!result.errors.length) requireAdoptedIntrinsicMaterial(adopted, profiles, roster);
  const nativeIntrinsic = profiles.filter(profile => profile.nativeIntrinsic).map(profile => profile.nativeIntrinsic);
  const generated = resolve(folder, 'generated'); await mkdir(generated, {recursive: true});
  const report = {version: 1, builtAt: new Date().toISOString(), ...result.coverage, errors: result.errors,
    warnings: result.warnings, nativeIntrinsic};
  await writeFile(resolve(generated, 'coverage.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(generated, 'quest-catalog.json'), JSON.stringify({version: 1, quests: [...result.quests.values()]}, null, 2) + '\n');
  if (result.errors.length) { console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return report; }
  await writeFile(resolve(generated, 'profile-plan.json'), JSON.stringify(profiles, null, 2) + '\n');
  console.log(JSON.stringify({profiles: profiles.length, ...result.coverage, warnings: result.warnings}, null, 2));
  if (applyProfiles) {
    const backup = resolve(root, 'runtime/research-profile-backups'); await mkdir(backup, {recursive: true});
    await writeFile(resolve(backup, Date.now() + '-roster.json'), JSON.stringify(roster, null, 2) + '\n');
    const adoptedKeys = [...new Set([...adopted, ...nativeIntrinsic.map(profile => profile.key)])].sort();
    await writeFile(settingsPath, JSON.stringify({...settings, profileRevision: 5,
      profileSource: 'research/cyberpunk/dossiers', ...(adoptedKeys.length ? {nativeIntrinsicProfiles: adoptedKeys} : {})}, null, 2) + '\n');
    // Persist the required source set before replacing the adopted persona.
    // The previous roster's receipt is also a recovery witness on later builds.
    await writeFile(resolve(root, 'characters/roster.json'), JSON.stringify(profiles, null, 2) + '\n');
    await mkdir(resolve(root, 'characters/profile-text'), {recursive: true});
    for (const profile of profiles) await writeFile(resolve(root, 'characters/profile-text', profile.key + '.txt'), [
      'BACKSTORY (backstory)', profile.backstory,
      'SPEAKING STYLE DESCRIPTION (speaking_style_description)', profile.speakingStyleDescription,
      'SPEAKING STYLE SAMPLE DIALOGUES (speaking_style_sample_dialogues)', profile.speakingStyleSampleDialogues,
    ].join('\n\n') + '\n');
    await writeFile(resolve(root, 'characters/profile-build-report.json'), JSON.stringify({
      profiles: profiles.length, named: dossiers.filter(row => row.kind === 'named').length,
      ambient: dossiers.filter(row => row.kind === 'ambient').length,
      profileRevision: 5, model: settings.model, source: 'research/cyberpunk/dossiers',
      nativeIntrinsic,
      sampleDialogueFormat: 'spoken utterances only; no speaker labels or player prompts',
      apiFields: ['backstory', 'speaking_style_description', 'speaking_style_sample_dialogues'],
      characters: profiles.map(profile => ({key: profile.key, words: profile.backstoryWords,
        speakingStyleWords: profile.speakingStyleDescription.split(/\s+/).length,
        sampleDialogueWords: profile.speakingStyleSampleDialogues.split(/\s+/).length,
        voice: profile.voiceName, sources: profile.sources.length, researchRevision: profile.researchRevision})),
    }, null, 2) + '\n');
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildResearch({
  applyProfiles: process.argv.includes('--apply-profiles'), includeIntrinsicClaims: process.argv.includes('--intrinsic-claims')});
