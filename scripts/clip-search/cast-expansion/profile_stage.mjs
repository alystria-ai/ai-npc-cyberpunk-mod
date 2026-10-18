// Stage one new character's profile outside the shared files (docs/CAST_EXPANSION_RECIPE.md, steps 5-8).
//
// Inputs in staging/cast/<key>/:
//   roster-base.json   {key, name, gender, aliases, records, voice, voiceName, model, twinVoice, twinVoiceName, twinReason}
//   dossier.json       research dossier, third person (research/cyberpunk/dossiers/<key>.json shape)
//   appearance.json    optional {text, source, image}: second-person appearance text ("You have ...")
//   first-person/output.json   the first-person rewrite of first-person/input.json (same ids, same order)
//
//   node profile_stage.mjs build <key>    validate the dossier against the quest maps, build the third-person row
//                                         (row-third.json) and write first-person/input.json for the rewrite
//   node profile_stage.mjs check <key>    check first-person/output.json (the repo's own checker; structural problems
//                                         must be fixed, pronoun/name flags are read line by line)
//   node profile_stage.mjs finish <key>   build the final first-person row (row.json), the store entry
//                                         (first-person/store.json) and profile-text.txt
// Nothing here writes outside staging/cast/<key>/; merge.mjs puts finished characters into the shared files.
import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateResearch, buildProfiles} from '../../../research/cyberpunk/scripts/build_research.mjs';
import {makeInput, checkRewrite} from '../../Rewrite-FirstPersonProfiles.mjs';
import {splitBackstory, splitStyle, sha256} from '../../first-person-profiles.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [command, key] = process.argv.slice(2);
if (!['build', 'check', 'finish'].includes(command) || !/^[a-z0-9-]+$/.test(key || '')) throw Error('usage: build|check|finish <key>');
const dir = resolve(repo, 'staging/cast', key);
const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));
const optional = async path => readJson(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
const write = async (path, value) => { await mkdir(dirname(path), {recursive: true}); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 1) + '\n'); };

const BASE_FIELDS = ['key', 'name', 'gender', 'aliases', 'records', 'voice', 'voiceName', 'model'];
async function inputs() {
  const base = await readJson(resolve(dir, 'roster-base.json'));
  if (base.key !== key) throw Error('roster-base key mismatch');
  for (const field of BASE_FIELDS) if (base[field] === undefined) throw Error(`roster-base.json lacks ${field}`);
  if (!['MALE', 'FEMALE'].includes(base.gender)) throw Error('gender must be MALE or FEMALE');
  const dossier = await readJson(resolve(dir, 'dossier.json'));
  const appearance = await optional(resolve(dir, 'appearance.json'));
  const roster = await readJson(resolve(repo, 'characters/roster.json'));
  if (roster.some(row => row.key === key)) throw Error(`${key} is already on the roster`);
  const kokoro = await readJson(resolve(repo, 'characters/kokoro-voices.json')).catch(() => null);
  const row = Object.fromEntries(BASE_FIELDS.map(field => [field, base[field]]));
  return {base, row, dossier, appearance, kokoro};
}

function third({row, dossier, appearance}, firstPerson = {}) {
  const maps = [];
  return {maps, build: async () => {
    const folder = resolve(repo, 'research/cyberpunk/quest-maps');
    for (const name of (await readdir(folder)).filter(n => n.endsWith('.json')).sort()) maps.push(await readJson(resolve(folder, name)));
    const result = validateResearch({roster: [row], dossiers: [dossier], maps});
    if (result.errors.length) throw Error('dossier: ' + result.errors.join('; '));
    for (const warning of result.warnings) console.log('warning:', warning);
    const [built] = buildProfiles([row], [dossier], {appearance: appearance?.text ? {[key]: appearance} : {}, firstPerson});
    return built;
  }};
}

const text = row => ['BACKSTORY (backstory)', row.backstory, 'SPEAKING STYLE DESCRIPTION (speaking_style_description)', row.speakingStyleDescription,
  'SPEAKING STYLE SAMPLE DIALOGUES (speaking_style_sample_dialogues)', row.speakingStyleSampleDialogues].join('\n\n') + '\n';

const data = await inputs();
if (command === 'build') {
  const row = await third(data).build();
  await write(resolve(dir, 'row-third.json'), row);
  await write(resolve(dir, 'first-person/input.json'), makeInput(row));
  console.log(`${key}: third-person row built (${row.backstoryWords} words); rewrite first-person/input.json into first-person/output.json`);
} else {
  const input = await readJson(resolve(dir, 'first-person/input.json'));
  const output = await readJson(resolve(dir, 'first-person/output.json'));
  const issues = checkRewrite(input, output);
  for (const issue of issues) console.log(`${issue.id}: ${issue.message}${issue.text ? '\n    ' + issue.text : ''}`);
  const fatal = issues.filter(issue => /^(.*: expected|wrong id|empty line|contains a line break|lost the|meta text|the opening line|no first-person)/u.test(issue.message));
  console.log(`${key}: ${issues.length} flags, ${fatal.length} structural`);
  if (command === 'finish') {
    if (fatal.length) throw Error('fix the structural problems first');
    const plain = await third(data).build();
    // rebuild row-third to make sure the input still describes the current dossier
    const fresh = makeInput(plain);
    if (JSON.stringify(fresh) !== JSON.stringify(input)) throw Error('the dossier changed since build: run build again and redo the rewrite');
    const {core: backstoryCore} = splitBackstory(plain.backstory), {core: styleCore} = splitStyle(plain.speakingStyleDescription);
    const {reassemble, lineSegments} = await import('../../first-person-profiles.mjs');
    const store = {backstory: {sourceSha256: sha256(backstoryCore), text: reassemble(lineSegments(backstoryCore), output.backstory.map(line => line.text))},
      speakingStyleDescription: {sourceSha256: sha256(styleCore), text: reassemble(lineSegments(styleCore, {style: true}), output.style.map(line => line.text))}};
    const row = await third(data, {[key]: store}).build();
    if (!/^I(?:'|’)m\b/u.test(row.backstory)) throw Error('the final backstory must open with "I\'m"');
    await write(resolve(dir, 'first-person/store.json'), store);
    await write(resolve(dir, 'row.json'), row);
    await write(resolve(dir, 'profile-text.txt'), text(row));
    console.log(`${key}: final row ${row.backstoryWords} words; row.json, first-person/store.json, profile-text.txt written`);
  }
}
