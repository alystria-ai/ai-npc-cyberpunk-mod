// Cast sweep (2026-10-30): compile character cards into dossiers and roster rows, and merge them into the shared data files.
//
//   node scripts/cast-sweep/compile.mjs check [--cards staging/cast-sweep/cards] [--keys a,b]
//        validate every card (shape, first person, banned words, sample lines) and build its row; prints the failures
//   node scripts/cast-sweep/compile.mjs apply [--keys a,b]
//        check, then write: research/cyberpunk/dossiers/<key>.json, characters/profile-text/<key>.txt, characters/roster.json,
//        research/cyberpunk/generated/{profile-plan,coverage}.json, characters/{appearance,multilingual-voice-map,profile-build-report}.json,
//        characters/cast-sweep-voices.json (fallback archetype voice and the chosen clip per character)
//
// A card is one small JSON file written from the person's record facts, the wiki extract and the game's text (see
// docs/CAST_SWEEP.md for the template). Everything else a dossier needs (sources, standard knowledge limits, claims) is added here.
import {readFile, writeFile, readdir, mkdir} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateResearch, buildProfiles} from '../../research/cyberpunk/scripts/build_research.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
let command = args[0];
if (!['check', 'apply', 'split'].includes(command)) throw Error('usage: check|apply [--cards dir] [--keys a,b] | split <array.json>');
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const cardsDir = resolve(repo, option('--cards', 'staging/cast-sweep/cards'));
let only = option('--keys', '') ? new Set(option('--keys').split(',')) : null;
const path = rel => resolve(repo, rel);
if (command === 'split') {
  // split <array.json>: write every card of the file to <cards>/<key>.json, then check just those cards
  const list = JSON.parse((await readFile(resolve(args[1]), 'utf8')).replace(/^﻿/, ''));
  if (!Array.isArray(list)) throw Error('the file must hold an array of cards');
  await mkdir(cardsDir, {recursive: true});
  for (const card of list) {
    if (!/^[a-z0-9-]+$/u.test(card?.key || '')) throw Error('a card has no valid key');
    await writeFile(resolve(cardsDir, card.key + '.json'), JSON.stringify(card, null, 1) + '\n');
  }
  only = new Set(list.map(card => card.key));
  command = 'check';
}
const readJson = async (file, fix = true) => JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
const NEUTRAL = 'Nothing that happens after V meets me, about myself, V or anyone else, unless the live context says so.';
const GUARD = 'I do not invent a past, family, secrets or events beyond what is described here. When I am asked about more, I say I would rather not say, or that I do not know.';
const META = /\b(?:wiki|database entry|the game\b|game's|summon\w*|spawn\w*|playthrough|this save|current[- ]save|noncanonical|Phantom Liberty|mod presentation|a mod\b|the mod\b|branch|lifepath|quest-dependent|point of no return|npc|record|tweak|archetype)/iu;
const DASH = /[–—]|--/u;
const AGES = new Set(['young', 'adult', 'older']);

const KOKORO = {
  MALE: {young: ['Ethan', 'Ryan', 'Logan'], adult: ['Noah', 'Lucas', 'Cole', 'Ethan', 'Ryan'], older: ['Mark', 'John', 'Cole', 'Henry', 'Harry']},
  FEMALE: {young: ['Anna', 'Emily', 'Katie', 'Julia', 'Laura'], adult: ['Rachel', 'Megan', 'Katie', 'Sarah', 'Emily'], older: ['Sarah', 'Linda', 'Helen']},
};
const hash = text => createHash('sha256').update(text).digest().readUInt32BE(0);

const [people, wiki, kokoro, voiceMap, archetypes, roster] = await Promise.all([
  readJson(path('staging/cast-sweep/final-people.json')),
  readJson(path('staging/cast-sweep/wiki.json')).catch(() => ({})),
  readJson(path('characters/kokoro-voices.json')),
  readJson(path('characters/multilingual-voice-map.json')),
  readJson(path('characters/archetype-roster.json')),
  readJson(path('characters/roster.json'))]);
const personByKey = new Map(people.map(p => [p.key, p]));
const archetypeKeys = new Map(archetypes.map(a => [a.key, a.gender]));
const kokoroByFirst = new Map(kokoro.voices.filter(v => v.voice_value?.startsWith('convai-kokoro-')).map(v => [v.name.split(' ')[0], v]));
const azureByGender = {MALE: [], FEMALE: []};
for (const [id, voice] of Object.entries(voiceMap.voices)) azureByGender[voice.gender]?.push([id, voice]);
const stemsFile = existsSync(path('staging/cast-sweep/voices.json')) ? await readJson(path('staging/cast-sweep/voices.json')) : {};
const settings = await readJson(path('characters/profile-settings.json'));
const wordCount = text => text.trim().split(/\s+/u).length;
const sentences = text => (text.match(/[^.!?]+[.!?]+/gu) || []).length;

function problems(card, person) {
  const bad = [];
  const need = (ok, message) => { if (!ok) bad.push(message); };
  need(card.key === person.key, 'key does not match');
  need(card.name === person.name, 'name does not match');
  need(['MALE', 'FEMALE'].includes(card.gender), 'gender');
  need(AGES.has(card.age), 'age must be young, adult or older');
  need(archetypeKeys.get(card.archetype) === card.gender, `archetype ${card.archetype} is not an archetype of this gender`);
  need(typeof card.summary === 'string' && wordCount(card.summary) >= 6 && wordCount(card.summary) <= 40, 'summary: one third-person sentence of 6 to 40 words');
  need(typeof card.intro === 'string' && card.intro.startsWith(`I'm ${card.name}`), `intro must open with "I'm ${card.name}"`);
  need(typeof card.intro === 'string' && wordCount(card.intro) >= 25 && wordCount(card.intro) <= 120, 'intro: 25 to 120 words');
  need(Array.isArray(card.background) && card.background.length >= 1 && card.background.length <= 4 && card.background.every(l => typeof l === 'string' && wordCount(l) >= 5 && wordCount(l) <= 45), 'background: 1 to 4 lines of 5 to 45 words');
  need(typeof card.manner === 'string' && wordCount(card.manner) >= 12 && wordCount(card.manner) <= 90 && /^I /u.test(card.manner), 'manner: first person ("I ..."), 12 to 90 words');
  need(Array.isArray(card.samples) && card.samples.length >= 6 && card.samples.length <= 8 && new Set(card.samples).size === card.samples.length
    && card.samples.every(l => typeof l === 'string' && wordCount(l) >= 3 && wordCount(l) <= 30), 'samples: 6 to 8 distinct lines of 3 to 30 words');
  need(card.look === '' || (typeof card.look === 'string' && /^You /u.test(card.look) && card.look.length <= 300), 'look: empty or "You ..." up to 300 characters');
  need(Array.isArray(card.uncertain) && card.uncertain.length <= 2 && card.uncertain.every(l => typeof l === 'string'), 'uncertain: at most 2 lines');
  need(!card.limits || (Array.isArray(card.limits) && card.limits.length <= 2 && card.limits.every(l => typeof l === 'string' && /^I /u.test(l))), 'limits: at most 2 first-person lines');
  const persona = [card.intro, ...(card.background || []), ...(card.limits || [])].join('\n');
  const found = persona.match(META);
  need(!found, `persona text contains "${found?.[0]}"`);
  const sampled = (card.samples || []).join('\n').match(new RegExp(META.source.replace(String.raw`the game\b|game's|`, ''), 'iu'));
  need(!sampled, `samples contain "${sampled?.[0]}"`);
  for (const [field, value] of Object.entries({intro: card.intro, manner: card.manner, look: card.look, summary: card.summary,
    background: (card.background || []).join(' '), samples: (card.samples || []).join(' '), uncertain: (card.uncertain || []).join(' '), limits: (card.limits || []).join(' ')})) {
    if (typeof value === 'string' && DASH.test(value)) bad.push(`${field}: dash`);
    if (typeof value === 'string' && /[\r\n]/u.test(field === 'intro' || field === 'manner' ? value : '')) bad.push(`${field}: line break`);
  }
  need(!/\b(?:cigarette|folded|crossed|bent|light falls|backdrop|under the light|behind you)\b/iu.test(card.look || ''), 'look: a pose or lighting note');
  need(!(card.samples || []).some(l => /^\s*(?:V|Player|[A-Z][a-z]+):/u.test(l)), 'a sample line has a speaker label');
  need(!/(?:^|\s)(?:he|she|his|her|him)\s+(?:is|was|has)\b/iu.test(card.intro || '') || /^I/u.test(card.intro || ''), 'intro is third person');
  return bad;
}

function dossierOf(card, person) {
  const page = wiki[card.key];
  const sources = [];
  const ids = [];
  if (page?.title) {
    ids.push('wiki');
    sources.push({id: 'wiki', url: 'https://cyberpunk.fandom.com/wiki/' + encodeURIComponent(page.title.replace(/ /gu, '_')).replace(/%27/g, "'").replace(/%3A/g, ':'),
      title: `${page.title} — Cyberpunk Wiki`, kind: 'community', accessed: '2026-10-30', locator: 'Infobox; Biography',
      notes: 'Page wikitext read through the MediaWiki API (a direct page fetch returns HTTP 402). Narrative reference only; reworded, not copied.'});
  }
  ids.push('records');
  sources.push({id: 'records', url: 'https://cyberpunk.fandom.com/wiki/Cyberpunk_2077', title: 'Installed character records and English text tables', kind: 'transcript',
    accessed: '2026-10-30', locator: `Character record ${person.records.slice(0, 3).join(', ')}; display name ${person.display.join(' / ')}`,
    notes: 'Record names, affiliation and display name read from the installed tweak sources (base game and Phantom Liberty) and the English text tables of the repo localisation index. Used for identity only.'});
  return {version: 1, key: card.key, name: card.name, kind: 'named', firstPersonNative: true,
    profile: {backstory: card.intro, publicSummary: card.summary, speakingStyleDescription: card.manner, speakingStyleSampleDialogues: card.samples},
    intrinsicClaims: [{id: 'identity.' + card.key, text: card.summary, sourceIds: ids, confidence: page?.title ? 'source-supported' : 'uncertain'}],
    relationships: [],
    knowledge: {background: card.background, private: [], unknown: [NEUTRAL, GUARD, ...(card.limits || [])], conditional: []},
    questKeys: [],
    uncertainties: [...card.uncertain,
      'Only the identity, role and place in Night City are used. No meeting, job, deal or outcome with V is assumed, and a copy summoned by the mod establishes none.',
      ...(page?.title ? [] : ['No page of its own on the wiki; the profile is kept short on purpose and adds no invented history.'])],
    sources};
}

function rowBase(card, person) {
  const ageList = KOKORO[card.gender][card.age];
  const first = ageList[hash(card.key) % ageList.length];
  const kv = kokoroByFirst.get(first);
  return {key: card.key, name: card.name, gender: card.gender, aliases: [card.name], records: person.records.map(r => 'Character.' + r),
    voice: kv.voice_value, voiceName: kv.name, model: settings.model, invite: false, minor: true};
}

const maps = [];
for (const name of (await readdir(path('research/cyberpunk/quest-maps'))).filter(n => n.endsWith('.json')).sort()) maps.push(await readJson(path('research/cyberpunk/quest-maps/' + name)));
const existing = new Set(roster.map(row => row.key));
const files = (await readdir(cardsDir).catch(() => [])).filter(n => n.endsWith('.json')).sort();
const failures = [], ready = [];
for (const file of files) {
  const key = file.replace(/\.json$/u, '');
  if (only && !only.has(key)) continue;
  try {
    const card = await readJson(resolve(cardsDir, file));
    const person = personByKey.get(key);
    if (!person) { failures.push([key, ['not in final-people.json']]); continue; }
    if (existing.has(key)) { failures.push([key, ['already on the roster']]); continue; }
    const bad = problems(card, person);
    if (bad.length) { failures.push([key, bad]); continue; }
    const dossier = dossierOf(card, person), base = rowBase(card, person);
    const result = validateResearch({roster: [base], dossiers: [dossier], maps});
    if (result.errors.length) { failures.push([key, result.errors]); continue; }
    const appearance = card.look ? {[key]: {text: card.look, source: wiki[key]?.title ? 'https://cyberpunk.fandom.com/wiki/' + wiki[key].title.replace(/ /gu, '_') : 'none'}} : {};
    const [built] = buildProfiles([base], [dossier], {appearance});
    if (!/^I(?:'|’)m\b/u.test(built.backstory)) { failures.push([key, ['backstory does not open with "I\'m"']]); continue; }
    ready.push({card, person, dossier, built});
  } catch (error) { failures.push([key, [String(error.message || error)]]); }
}
console.log(`cards ${files.length}  ready ${ready.length}  failed ${failures.length}`);
for (const [key, bad] of failures) console.log(`FAIL ${key}: ${bad.join(' | ')}`);
await writeFile(path('staging/cast-sweep/compile-failures.json'), JSON.stringify(failures, null, 1));
if (command === 'check' || !ready.length) process.exit(failures.length && command === 'check' ? 0 : 0);

// apply
const indentOf = rel => {
  if (!existsSync(path(rel))) return 2;
  const raw = readFileSync(path(rel), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  return [1, 2, 4].find(n => raw === JSON.stringify(JSON.parse(raw), null, n) + '\n') ?? 2;
};
const writeJson = async (rel, value) => { const indent = indentOf(rel); await mkdir(dirname(path(rel)), {recursive: true}); await writeFile(path(rel), JSON.stringify(value, null, indent) + '\n'); };
const plan = await readJson(path('research/cyberpunk/generated/profile-plan.json'));
const appearance = await readJson(path('characters/appearance.json'));
const report = await readJson(path('characters/profile-build-report.json'));
const coverage = await readJson(path('research/cyberpunk/generated/coverage.json'));
const voices = existsSync(path('characters/cast-sweep-voices.json')) ? await readJson(path('characters/cast-sweep-voices.json')) : {version: 1, characters: {}};
for (const {card, person, dossier, built} of ready) {
  const row = {...built};
  if (card.look) appearance[card.key] = {text: card.look, source: wiki[card.key]?.title ? 'https://cyberpunk.fandom.com/wiki/' + wiki[card.key].title.replace(/ /gu, '_') : 'none'};
  else appearance[card.key] = {text: '', source: 'none'};
  roster.push(row); plan.push(row);
  const azure = azureByGender[card.gender][hash(card.key + ':twin') % azureByGender[card.gender].length];
  voiceMap.assignments[card.key] = {voice: azure[0], voiceName: azure[1].name, reason: `Default ${card.gender === 'MALE' ? 'male' : 'female'} ${card.age} twin voice for a minor named character (cast sweep).`};
  report.characters.push({key: card.key, words: row.backstoryWords, speakingStyleWords: row.speakingStyleDescription.split(/\s+/).length,
    sampleDialogueWords: row.speakingStyleSampleDialogues.split(/\s+/).length, voice: row.voiceName, sources: row.sources.length, researchRevision: row.researchRevision});
  voices.characters[card.key] = {fallback: card.archetype, clip: stemsFile[card.key]?.repo ?? null};
  await writeJson(`research/cyberpunk/dossiers/${card.key}.json`, dossier);
  await writeFile(path(`characters/profile-text/${card.key}.txt`), ['BACKSTORY (backstory)', row.backstory, 'SPEAKING STYLE DESCRIPTION (speaking_style_description)',
    row.speakingStyleDescription, 'SPEAKING STYLE SAMPLE DIALOGUES (speaking_style_sample_dialogues)', row.speakingStyleSampleDialogues].join('\n\n') + '\n');
}
report.profiles = roster.length;
report.named = roster.filter(row => row.kind === 'named').length;
report.ambient = roster.filter(row => row.kind === 'ambient').length;
coverage.profilesExpected = roster.length;
coverage.profilesAuthored = roster.length;
await writeJson('characters/roster.json', roster);
await writeJson('research/cyberpunk/generated/profile-plan.json', plan);
await writeJson('characters/appearance.json', appearance);
await writeJson('characters/multilingual-voice-map.json', voiceMap);
await writeJson('characters/profile-build-report.json', report);
await writeJson('research/cyberpunk/generated/coverage.json', coverage);
await writeJson('characters/cast-sweep-voices.json', voices);
// The knowledge packs list every profile that may be an audience (bridge/knowledge-service.mjs INVALID_AUDIENCE); LIMIT.profiles is 1024.
for (const rel of ['characters/world-knowledge.json', 'research/cyberpunk/generated/world-knowledge.json']) {
  const pack = await readJson(path(rel));
  for (const {card} of ready) if (!pack.profileKeys.includes(card.key)) pack.profileKeys.push(card.key);
  await writeJson(rel, pack);
}
console.log(`applied ${ready.length} characters; roster now ${roster.length}`);
