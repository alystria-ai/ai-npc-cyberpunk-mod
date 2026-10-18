// Merge finished staged characters (profile_stage.mjs finish) into the shared data files. One writer only: the lead of the
// cast expansion runs this serially, then the tests. Additions are appended (new rows at the end of arrays, new keys at
// the end of objects) so a later merge with other branches that also add characters stays a simple concatenation.
//
//   node merge.mjs profiles --keys a,b      roster row, profile text, first-person store, appearance, dossier, profile plan,
//                                           build report, coverage counts, twin voice assignment
//   node merge.mjs knowledge --keys a,b     world-knowledge profileKeys (characters/ and research/cyberpunk/generated/)
//   node merge.mjs release-plan --keys a,b  voice.localProfiles and registry.preparedLocalProfiles (keys whose three voice
//                                           rows are ready in the live configs)
//   node merge.mjs release-data --keys a,b  the Convai IDs of these keys only, from runtime/characters.json and
//                                           runtime/multilingual-profiles.json into packaging/release-data/ (the full
//                                           packaging/Refresh-ReleaseData.mjs copy would also pick up other branches' rows
//                                           from the shared runtime folder)
// --dry-run prints what would change.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2), phase = args[0], dryRun = args.includes('--dry-run');
const keys = args.includes('--keys') ? args[args.indexOf('--keys') + 1].split(',').filter(Boolean) : [];
if (!['profiles', 'knowledge', 'release-plan', 'release-data'].includes(phase) || !keys.length) throw Error('usage: profiles|knowledge|release-plan|release-data --keys a,b [--dry-run]');
const path = rel => resolve(repo, rel);
const readJson = async rel => JSON.parse((await readFile(path(rel), 'utf8')).replace(/^﻿/, ''));
const staged = (key, name) => resolve(repo, 'staging/cast', key, name);
const changed = [];
async function save(rel, value, indent) {
  if (indent === undefined && typeof value !== 'string') indent = existsSync(path(rel)) ? indentOf(rel) : 2;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, indent) + '\n';
  changed.push(rel);
  if (dryRun) return;
  await mkdir(dirname(path(rel)), {recursive: true});
  await writeFile(path(rel), text);
}
// keep the file's own indentation (some files use 1 space)
const indentOf = rel => {
  const raw = readFileSync(path(rel), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  return [1, 2, 4].find(n => raw === JSON.stringify(JSON.parse(raw), null, n) + '\n') ?? 2;
};

if (phase === 'profiles') {
  const roster = await readJson('characters/roster.json');
  const plan = await readJson('research/cyberpunk/generated/profile-plan.json');
  const store = await readJson('characters/first-person-profiles.json');
  const appearance = await readJson('characters/appearance.json');
  const report = await readJson('characters/profile-build-report.json');
  const coverage = await readJson('research/cyberpunk/generated/coverage.json');
  const voiceMap = await readJson('characters/multilingual-voice-map.json');
  for (const key of keys) {
    if (roster.some(row => row.key === key)) throw Error(`${key} already on the roster`);
    const row = JSON.parse(readFileSync(staged(key, 'row.json'), 'utf8'));
    const base = JSON.parse(readFileSync(staged(key, 'roster-base.json'), 'utf8'));
    const firstPerson = JSON.parse(readFileSync(staged(key, 'first-person/store.json'), 'utf8'));
    const dossier = readFileSync(staged(key, 'dossier.json'), 'utf8');
    const look = existsSync(staged(key, 'appearance.json')) ? JSON.parse(readFileSync(staged(key, 'appearance.json'), 'utf8')) : {text: '', source: 'none'};
    if (!/^I(?:'|’)m\b/u.test(row.backstory)) throw Error(`${key}: row is not the finished first-person row`);
    if (!voiceMap.voices[base.twinVoice] || voiceMap.voices[base.twinVoice].gender !== base.gender) throw Error(`${key}: twin voice missing or wrong gender`);
    roster.push(row);
    plan.push(row);
    store.characters[key] = firstPerson;
    appearance[key] = look;
    voiceMap.assignments[key] = {voice: base.twinVoice, voiceName: base.twinVoiceName, reason: base.twinReason};
    report.characters.push({key, words: row.backstoryWords, speakingStyleWords: row.speakingStyleDescription.split(/\s+/).length,
      sampleDialogueWords: row.speakingStyleSampleDialogues.split(/\s+/).length, voice: row.voiceName, sources: row.sources.length,
      researchRevision: row.researchRevision});
    await save(`characters/profile-text/${key}.txt`, readFileSync(staged(key, 'profile-text.txt'), 'utf8'));
    await save(`research/cyberpunk/dossiers/${key}.json`, dossier.endsWith('\n') ? dossier : dossier + '\n');
  }
  report.profiles = roster.length;
  report.named = roster.filter(row => row.kind === 'named').length;
  report.ambient = roster.filter(row => row.kind === 'ambient').length;
  coverage.profilesExpected = roster.length;
  coverage.profilesAuthored = roster.length;
  await save('characters/roster.json', roster);
  await save('research/cyberpunk/generated/profile-plan.json', plan);
  await save('characters/first-person-profiles.json', store);
  await save('characters/appearance.json', appearance);
  await save('characters/profile-build-report.json', report);
  await save('research/cyberpunk/generated/coverage.json', coverage);
  await save('characters/multilingual-voice-map.json', voiceMap);
} else if (phase === 'knowledge') {
  for (const rel of ['characters/world-knowledge.json', 'research/cyberpunk/generated/world-knowledge.json']) {
    const pack = await readJson(rel);
    for (const key of keys) if (!pack.profileKeys.includes(key)) pack.profileKeys.push(key);
    await save(rel, pack);
  }
} else if (phase === 'release-data') {
  const ids = await readJson('runtime/characters.json'), twins = await readJson('runtime/multilingual-profiles.json');
  const outIds = await readJson('packaging/release-data/characters.json'), outTwins = await readJson('packaging/release-data/multilingual-profiles.json');
  for (const key of keys) {
    const twin = twins.characters?.[key];
    if (!/^[0-9a-f-]{36}$/u.test(ids[key] ?? '')) throw Error(`${key}: no original ID in runtime/characters.json`);
    if (!twin?.verified || twin.originalCharacterId !== ids[key]) throw Error(`${key}: no verified twin for the current original`);
    outIds[key] = ids[key];
    outTwins.characters[key] = twin;
  }
  await save('packaging/release-data/characters.json', outIds);
  await save('packaging/release-data/multilingual-profiles.json', outTwins);
} else {
  const plan = await readJson('packaging/release-plan.json');
  const live = ['local-voices.autobest-short.json', 'local-voices.autobest-long.json', 'pocket-voices.autobest.json']
    .map(name => JSON.parse(readFileSync(path('runtime/' + name), 'utf8').replace(/^﻿/, '')));
  const list = plan.voice.localProfiles;
  for (const key of keys) {
    if (!live.every(config => config.voices[key]?.status === 'ready')) throw Error(`${key}: not ready in all three live configs`);
    if (!list.includes(key)) list.push(key);
  }
  // the list is kept sorted with '-' before '.' (plain code-unit order of the keys)
  list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  plan.voice.registry.preparedLocalProfiles = list.length;
  // profiles that fall back to a Convai voice locally: every roster profile without a prepared reference
  const roster = await readJson('characters/roster.json');
  plan.voice.registry.fallbackProfiles = roster.filter(row => !list.includes(row.key)).length;
  await save('packaging/release-plan.json', plan);
}
console.log(`${phase}: ${keys.length} keys; ${dryRun ? 'would change' : 'changed'}:`, [...new Set(changed)].join(', '));
