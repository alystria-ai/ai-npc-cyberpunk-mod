// Build the generic NPC archetype profiles (docs/NPC_ARCHETYPES.md).
//
//   node scripts/Build-ArchetypeProfiles.mjs           # writes characters/archetype-roster.json and review text
//   node scripts/Build-ArchetypeProfiles.mjs --check   # validates and compares, writes nothing (exit 1 when stale)
//
// Inputs: characters/archetypes.json (keys, variants, detection, voices) and one dossier per base in
// characters/archetype-profiles/<base>.json. The output rows have the same three Convai text fields as the named
// roster (backstory, speakingStyleDescription, speakingStyleSampleDialogues) and the same ownership marker, so
// scripts/Provision-Characters.mjs --roster archetypes creates them with the usual payload, readback and recovery.
// Archetypes are deliberately kept out of characters/roster.json: they are not researched named characters, are not
// invitable companions and have no research dossier.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serializeCharacterSamples} from './character-samples.mjs';
import {characterPayload} from './character-payload.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = async file => JSON.parse((await readFile(resolve(root, file), 'utf8')).replace(/^﻿/, ''));
const text = value => typeof value === 'string' && value.trim().length > 0;
const list = (value, minimum) => Array.isArray(value) && value.length >= minimum && value.every(text);
export const ARCHETYPE_KEY = /^npc-[a-z0-9]+(?:-[a-z0-9]+)*-(?:male|female)$/;
export const ownershipMarker = key => `[CyberpunkConvai profile v2:${key}]`;

// Shared by every archetype: who the speaker is NOT, and what they cannot know. Kept here (not per dossier) so a
// later wording fix reaches every archetype at once.
export const ARCHETYPE_RULES = [
  'You are not one specific story character. Every unnamed person of this kind in Night City uses this profile, so you have no fixed personal name, rank, family or history. If V asks, you may give a plausible first name or a small present-day detail, keep it modest, and stay consistent with it for the rest of this conversation. Never contradict what the current context says about you.',
  'V is a stranger to you unless the current context says you have met. You do not know V\'s story: nothing about the Relic, Johnny Silverhand, the Arasaka job, V\'s health, V\'s gigs, contacts or romances. You know only what V tells you, what you can see, and what ordinary people in your position would hear on the street, and you treat rumor as rumor.',
  'Use the per-turn context for where you are (district, neighborhood), what V can see about you and anything that has just happened. If the location is not given, do not invent a specific address.',
  'You cannot change the game: never claim to sell, give, buy, open, arrest, hire, follow, heal or install anything, or to complete a mission. Point V to the usual way of doing it instead.'
].join('\n');
const SPOKEN_RULES = 'Speak naturally to V, usually in one or two short sentences unless asked for detail. '
  + 'Give only the spoken reply, without prepending a name or a speaker label. No stage directions or markdown. '
  + 'Dialogue samples are original delivery examples, not memories. Use slang sparingly, not in every sentence. '
  + 'In a group, speak for yourself and leave room for the others. Never reveal private conversation history to a group.';

export function validateCatalog(catalog) {
  const errors = [];
  if (catalog?.version !== 1 || !catalog.bases || !Array.isArray(catalog.archetypes)) return ['Invalid archetype catalog'];
  const keys = new Set();
  for (const row of catalog.archetypes) {
    const where = row?.key ?? '(missing key)';
    if (!ARCHETYPE_KEY.test(row?.key ?? '')) errors.push(`${where}: key must look like npc-<base>-male|female`);
    if (keys.has(row.key)) errors.push(`${where}: duplicate key`);
    keys.add(row.key);
    if (!catalog.bases[row.base]) errors.push(`${where}: unknown base ${row.base}`);
    if (!['MALE', 'FEMALE'].includes(row.gender) || !row.key.endsWith(row.gender === 'MALE' ? '-male' : '-female')) errors.push(`${where}: gender and key suffix disagree`);
    if (!row.key.startsWith(`npc-${row.base}-`)) errors.push(`${where}: key must start with npc-${row.base}-`);
    if (!text(row.name) || /[^\p{L}\p{N} ]/u.test(row.name)) errors.push(`${where}: name must be letters, digits and spaces (Core API label)`);
    if (!/^convai-kokoro-[0-9a-f]{16}$/.test(row.voice ?? '') || !text(row.voiceName)) errors.push(`${where}: Kokoro voice required`);
    if (!list(row.voiceFamilies, 1)) errors.push(`${where}: voiceFamilies required`);
  }
  for (const [base, value] of Object.entries(catalog.bases)) {
    if (!['gang', 'police', 'corpo-security', 'vendor', 'resident'].includes(value.category)) errors.push(`${base}: unknown category`);
    if (!text(value.title) || !value.match || typeof value.match !== 'object') errors.push(`${base}: title and match required`);
    if (!catalog.archetypes.some(row => row.base === base)) errors.push(`${base}: no archetype variant`);
  }
  return errors;
}

export function validateDossier(dossier, base, title) {
  const errors = [];
  const where = `archetype-profiles/${base}`;
  if (dossier?.version !== 1 || dossier.base !== base) errors.push(`${where}: version 1 and matching base required`);
  if (dossier?.title !== title) errors.push(`${where}: title must equal the catalog title "${title}"`);
  if (!text(dossier?.identity) || !text(dossier?.speakingStyle)) errors.push(`${where}: identity and speakingStyle required`);
  if (!list(dossier?.background, 3)) errors.push(`${where}: at least three background lines`);
  if (!list(dossier?.knowledgeLimits, 2)) errors.push(`${where}: at least two knowledge limits`);
  if (!list(dossier?.slang, 3)) errors.push(`${where}: at least three slang entries`);
  if (!list(dossier?.samples, 6)) errors.push(`${where}: at least six sample lines`);
  else if (new Set(dossier.samples).size !== dossier.samples.length) errors.push(`${where}: duplicate samples`);
  for (const sample of dossier?.samples ?? []) {
    if (/[\r\n*]/.test(sample) || /^[^:\s]{1,40}:\s/.test(sample)) errors.push(`${where}: sample must be one plain spoken line: ${sample.slice(0, 40)}`);
  }
  if (!Array.isArray(dossier?.sources) || !dossier.sources.length || dossier.sources.some(source => !text(source?.id) || !text(source?.title) || !text(source?.notes))) {
    errors.push(`${where}: sources with id, title and notes required`);
  }
  const all = [dossier?.identity, ...(dossier?.background ?? []), dossier?.speakingStyle, ...(dossier?.samples ?? [])].join(' ');
  if (/\b(?:Relic|Silverhand|Mikoshi)\b/i.test(all)) errors.push(`${where}: archetype text must not mention V's story`);
  return errors;
}

export function buildArchetype(row, base, dossier, model) {
  const gender = row.gender === 'MALE' ? 'a man' : 'a woman';
  const backstory = [
    `IDENTITY\nYou are an unnamed ${base.title} in Night City, ${gender}. ${dossier.identity.trim()}`,
    'ESTABLISHED BACKGROUND\n' + dossier.background.map(line => line.trim()).join('\n'),
    'WHO YOU ARE NOT AND WHAT YOU KNOW\n' + ARCHETYPE_RULES,
    'KNOWLEDGE LIMITS\n' + dossier.knowledgeLimits.map(line => line.trim()).join('\n'),
    ownershipMarker(row.key)].join('\n\n');
  const speakingStyleDescription = [dossier.speakingStyle.trim(),
    'Words you might use: ' + dossier.slang.join(', ') + '.',
    SPOKEN_RULES].join('\n\n');
  const profile = {key: row.key, name: row.name, gender: row.gender, aliases: [], records: []};
  const speakingStyleSampleDialogues = serializeCharacterSamples(dossier.samples, profile);
  return {key: row.key, name: row.name, gender: row.gender, aliases: [], records: [],
    voice: row.voice, voiceName: row.voiceName, model,
    backstory, speakingStyleDescription, speakingStyleSampleDialogues,
    backstoryWords: backstory.split(/\s+/).length, profileRevision: 5, kind: 'archetype',
    archetype: {base: row.base, category: base.category, title: base.title},
    summary: `Generic ${base.title} (${row.gender.toLowerCase()}): an unnamed NPC archetype, not a canon individual.`,
    sources: dossier.sources};
}

// The mod cannot load another data file without a packaging change, so the detection data is generated into
// mod/character-catalog.lua between these markers (no hand edits inside them).
export const LUA_BEGIN = '-- BEGIN GENERATED ARCHETYPES (node scripts/Build-ArchetypeProfiles.mjs; source characters/archetypes.json)';
export const LUA_END = '-- END GENERATED ARCHETYPES';
const luaString = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const luaList = values => `{${values.map(luaString).join(', ')}}`;
export function luaArchetypeBlock(catalog, recordGenders = {}) {
  const fields = ['affiliations', 'police', 'crowd', 'vendorTypes', 'records', 'recordTokens', 'recordPrefixes', 'excludeRecordPrefixes'];
  const bases = Object.keys(catalog.bases).sort().map(name => {
    const base = catalog.bases[name], parts = [`category = ${luaString(base.category)}`, `title = ${luaString(base.title)}`];
    for (const field of fields) {
      const value = base.match[field];
      if (value === undefined) continue;
      parts.push(`${field} = ${typeof value === 'boolean' ? String(value) : luaList(value)}`);
    }
    return `        [${luaString(name)}] = {${parts.join(', ')}},`;
  });
  const variants = catalog.archetypes.map(row =>
    `        {key = ${luaString(row.key)}, base = ${luaString(row.base)}, gender = ${luaString(row.gender)}},`);
  // Vendor record genders for the Model browser (scripts/Extract-ArchetypeRecordGenders.mjs).
  const genders = Object.keys(recordGenders).sort().map(record =>
    `        [${luaString(record)}] = ${luaString(recordGenders[record])},`);
  return [LUA_BEGIN, 'M.ARCHETYPES = {', '    version = 1,', '    bases = {', ...bases, '    },',
    '    variants = {', ...variants, '    },', '    recordGenders = {', ...genders, '    },', '}', LUA_END].join('\n');
}
export function replaceLuaBlock(source, block) {
  const start = source.indexOf(LUA_BEGIN), end = source.indexOf(LUA_END);
  if (start < 0 || end < start) throw Error('mod/character-catalog.lua has no generated archetype markers');
  return source.slice(0, start) + block + source.slice(end + LUA_END.length);
}

export async function buildArchetypes() {
  const catalog = await read('characters/archetypes.json');
  const settings = await read('characters/profile-settings.json');
  const errors = validateCatalog(catalog);
  const dossiers = new Map();
  for (const [base, value] of Object.entries(catalog.bases ?? {})) {
    try {
      const dossier = await read(`characters/archetype-profiles/${base}.json`);
      errors.push(...validateDossier(dossier, base, value.title));
      dossiers.set(base, dossier);
    } catch (error) { errors.push(`archetype-profiles/${base}: ${error.code === 'ENOENT' ? 'missing' : error.message}`); }
  }
  if (errors.length) return {errors, profiles: []};
  const profiles = catalog.archetypes.map(row => buildArchetype(row, catalog.bases[row.base], dossiers.get(row.base), settings.model));
  for (const profile of profiles) characterPayload(profile);   // same preflight as provisioning
  const genders = await read('characters/archetype-record-genders.json').catch(error => {
    if (error.code === 'ENOENT') return {records: {}};
    throw error;
  });
  return {errors, profiles, lua: luaArchetypeBlock(catalog, genders.records ?? {})};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const {errors, profiles, lua} = await buildArchetypes();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  const output = JSON.stringify(profiles, null, 2) + '\n';
  const target = resolve(root, 'characters/archetype-roster.json');
  const luaPath = resolve(root, 'mod/character-catalog.lua');
  const luaSource = (await readFile(luaPath, 'utf8')).replace(/\r\n/g, '\n');
  const luaOutput = replaceLuaBlock(luaSource, lua);
  if (check) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current.replace(/\r\n/g, '\n') !== output) { console.error('characters/archetype-roster.json is stale; run node scripts/Build-ArchetypeProfiles.mjs'); process.exit(1); }
    if (luaOutput !== luaSource) { console.error('mod/character-catalog.lua archetype data is stale; run node scripts/Build-ArchetypeProfiles.mjs'); process.exit(1); }
    console.log(`Archetype roster current: ${profiles.length} profiles.`);
  } else {
    await writeFile(target, output);
    if (luaOutput !== luaSource) await writeFile(luaPath, luaOutput);
    const folder = resolve(root, 'characters/archetype-profile-text');
    await mkdir(folder, {recursive: true});
    for (const profile of profiles) await writeFile(resolve(folder, profile.key + '.txt'), [
      'BACKSTORY (backstory)', profile.backstory,
      'SPEAKING STYLE DESCRIPTION (speaking_style_description)', profile.speakingStyleDescription,
      'SPEAKING STYLE SAMPLE DIALOGUES (speaking_style_sample_dialogues)', profile.speakingStyleSampleDialogues,
    ].join('\n\n') + '\n');
    console.log(`Built ${profiles.length} archetype profiles from ${new Set(profiles.map(p => p.archetype.base)).size} bases.`);
  }
}
