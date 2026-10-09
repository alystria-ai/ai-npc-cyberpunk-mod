// Bounded text-only probe for the "she is the one in control" leak: a companion answering a question about HERSELF in the
// third person ("I suspect she enjoys the way it makes people look twice"), as if narrating the character. It assembles
// each turn's context the way the bridge does (bridge/quest-context.mjs, then the per-turn blocks), once per CONDITION, so a
// block can be toggled off and the rates compared, and sends ONE fresh Convai session per sample (no history carries over).
//
//   node scripts/Probe-ThirdPerson.mjs --profiles evelyn-parker,judy-alvarez,johnny-silverhand,panam-palmer,takemura,dexter-deshawn
//        --conditions base,live,live-no-follow,live-no-natural,live-no-emotions [--reps 1] [--prompts 10] [--concurrency 1]
//        [--set general|appearance|blue | --text "line"] [--context-file path] [--label name] --run
//   Conditions (blocks in the bridge's order: Follow-up, Natural speech, Expressive emotions; every block FORCED on, the worst case):
//     base  none                       follow  Follow-up only          natural  Natural speech only      emotions  Expressive only
//     live  all three                  live-no-follow / live-no-natural / live-no-emotions  all but one
//
// Without --run it only prints the plan. ONE fixed test Convai identity for every job (never the player's); the API key is read
// from runtime/convai-key.txt and never printed. Output: runtime/third-person-probe/<label>.json (rows + a regex pre-screen
// that flags a reply for a judge to read; the judging itself is done by reading the rows).
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {RealtimeHost} from '../bridge/realtime-host.mjs';
import * as questContext from '../bridge/quest-context.mjs';
const {conversationContext} = questContext;
import {archetypeContext, isAmbientProfile} from '../bridge/protocol.mjs';
import {FOLLOW_UP_TEXT, endsWithQuestion, traitFor} from '../bridge/follow-up.mjs';
import {NaturalSpeech, naturalSpeechContext, PLACES} from '../bridge/natural-speech.mjs';
import {ExpressiveEmotions} from '../bridge/expressive-emotions.mjs';
import {ConvaiMemoryAdapter} from '../bridge/convai-memory.mjs';
import {relationshipContext} from '../bridge/romance-context.mjs';
import {RELATIONSHIP_PROFILES} from '../bridge/relationship-routing.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const run = args.includes('--run');
const profiles = option('--profiles', 'evelyn-parker').split(',').filter(Boolean);
const conditionNames = option('--conditions', 'base,live').split(',').filter(Boolean);
const reps = Number(option('--reps', 1)), concurrency = Number(option('--concurrency', 1));
const label = option('--label', 'third-person');

// Questions a player asks ABOUT the character: appearance, motives, self. A narrator-style leak shows here.
export const PROMPTS = [
  'Why the blue hair?', 'Why do you dress like that?', 'What do you want?', 'Tell me about yourself.',
  'What is with the way you carry yourself?', 'Do you like how you look?', 'What are you afraid of?',
  'Why are you so guarded?', 'What is your deal, anyway?', 'What makes you tick?',
];
// --set appearance: questions that PRESUPPOSE a look or a choice the character's profile never mentions (the live leak was
// "why the blue hair?" to a character whose profile has no hair colour): nothing in the profile answers them, so the model
// has to improvise, and a narrator's voice is the easy way out.
export const APPEARANCE_PROMPTS = [
  'Why the blue hair?', 'Why the red jacket?', 'Why the scar on your cheek?', 'Why did you cut your hair like that?',
  'Why the sunglasses?', 'Why all the tattoos?', 'Why that perfume?', 'Why the gold earrings?', 'What is with the heels?',
  'Why do you always wear black?',
];
// --set blue: the live trigger. "Blue hair" is a trait the character's profile does not give her, and the model knows another
// character who has it (Judy), so the player's presupposition has an easy wrong reading ("it suits her" about someone else).
export const BLUE_PROMPTS = [
  'why blue hair?', 'Why the blue hair?', 'What is with the blue hair?', 'I like the blue hair. Why that color?',
  'How come your hair is blue?', 'Did you dye your hair blue on purpose?', 'Blue hair, huh. Why?', 'So why did you go with blue hair?',
];
const promptSets = {general: PROMPTS, appearance: APPEARANCE_PROMPTS, blue: BLUE_PROMPTS};
if (!promptSets[option('--set', 'general')]) throw Error('Bad arguments.');
// --text "..." sends only that line; --context-file P replaces the bridge's own base context (quest-context.mjs) with the text
// in P, e.g. one reconstructed from a real turn (the per-turn blocks are still added after it).
const prompts = option('--text') ? [option('--text')] : promptSets[option('--set', 'general')].slice(0, Number(option('--prompts', 10)));
const contextFile = option('--context-file');
// --last-block-file P: one more paragraph appended LAST (after every block), to test where a rule works best.
const lastBlock = option('--last-block-file') ? (await readFile(resolve(option('--last-block-file')), 'utf8')).trim() : '';

const BLOCKS = {
  follow: () => FOLLOW_UP_TEXT,
  natural: ({profile, name, index}) => naturalSpeechContext({engine: 'omni', profile: profile.key, name, trait: traitFor(profile.key),
    place: Object.keys(PLACES)[index % Object.keys(PLACES).length]}),
  emotions: () => { const e = new ExpressiveEmotions(); e.update({expressiveEmotions: true}); return e.contextFor({engine: 'omni', spoken: true}); },
};
// The Relationship block (bridge/romance-context.mjs) as the bridge sends it to an affectionate Judy, Panam, River, Kerry or Meredith.
BLOCKS.romance = ({profile}) => RELATIONSHIP_PROFILES[profile.key]
  ? relationshipContext({status: 'ready', profileKey: profile.key, style: 'romantic',
    saveRelationship: {status: 'confirmed', evidenceRule: RELATIONSHIP_PROFILES[profile.key].rule}}, 'private') : '';
const CONDITIONS = {
  base: [], follow: ['follow'], natural: ['natural'], emotions: ['emotions'],
  live: ['follow', 'natural', 'emotions'],
  romance: ['romance', 'follow', 'natural', 'emotions'],
  'live-no-follow': ['natural', 'emotions'], 'live-no-natural': ['follow', 'emotions'], 'live-no-emotions': ['follow', 'natural'],
};
if (conditionNames.some(name => !CONDITIONS[name]) || !(reps >= 1 && reps <= 50) || !(concurrency >= 1 && concurrency <= 2)) throw Error('Bad arguments.');

const total = profiles.length * conditionNames.length * prompts.length * reps;
if (!run) {
  console.log(JSON.stringify({label, profiles, conditions: conditionNames, prompts: prompts.length, reps, convaiRequests: total,
    identity: 'one fixed test identity (third-person-probe-fixed), memories wiped after every job, never the player'}));
  process.exit(0);
}

const read = async name => JSON.parse((await readFile(resolve(root, name), 'utf8')).replace(/^﻿/, ''));
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec((await readFile(resolve(root, 'runtime/convai-key.txt'), 'utf8')).trim())?.[1];
if (!key) throw Error('Local key is missing.');
const baseContext = contextFile ? (await readFile(resolve(contextFile), 'utf8')).trim() : undefined;
const ids = await read('runtime/characters.json');
const player = await read('runtime/player-memory.json');
// ONE FIXED test identity for every job, never a new one: each new end-user id creates a long-term-memory end user on the account
// (limit 10,000 a month), and an earlier version of this script made one per sample (about 2,200 in a day). Convai's memory is per
// end user and character, so the character's memories of this identity are wiped after every job (the endpoint schedules the
// deletion, so a job that starts right after another on the same character can still see a trace: keep --concurrency low).
// Never the player's identity.
const FIXED_IDENTITY = 'third-person-probe-fixed';
if (FIXED_IDENTITY === player.endUserId) throw Error('The probe identity must not be the player.');
const memory = new ConvaiMemoryAdapter({key, enabled: true});
const speech = new NaturalSpeech(), emotions = new ExpressiveEmotions();
speech.update({naturalSpeech: true}); emotions.update({expressiveEmotions: true});
const host = new RealtimeHost();

// Pre-screen: pronouns or the character's own name in the reply. A judge decides which are self-narration.
const PRONOUN = /\b(?:she|her|hers|herself|he|him|his|himself|they|them|their|theirs)\b/i;
const firstName = name => String(name).split(/\s+/)[0];

const jobs = [];
for (const condition of conditionNames) for (const profileKey of profiles) for (let rep = 0; rep < reps; rep++)
  for (const [index, text] of prompts.entries()) jobs.push({condition, profileKey, text, index, rep});

const rows = [];
const folder = resolve(root, 'runtime/third-person-probe');
await mkdir(folder, {recursive: true});
const destination = resolve(folder, `${label}.json`);
let done = 0;
async function work(job) {
  const profile = roster.find(row => row.key === job.profileKey) ?? {key: job.profileKey, name: job.profileKey};
  const input = {profileKey: job.profileKey, name: profile.name, text: job.text, channel: 'private',
    requestId: `tp-${job.condition}-${job.profileKey}-${job.index}-${job.rep}`, ...(profile.archetype ? {archetype: profile.archetype} : {})};
  const blocks = CONDITIONS[job.condition].map(id => BLOCKS[id]({profile, name: profile.name, index: job.index + job.rep}));
  const context = [baseContext ?? conversationContext(input), isAmbientProfile(job.profileKey) ? archetypeContext(input) : '', ...blocks,
    // The bridge appends this one sentence after the voice blocks (absent from an older checkout, which is how a "before" run is made).
    questContext.firstPersonReminder?.(input) ?? '', lastBlock].filter(Boolean).join('\n\n');
  const config = {key, characterId: ids[job.profileKey], endUserId: FIXED_IDENTITY, sessionId: undefined, scope: 'third-person-probe', ttsEnabled: false, text: job.text, context};
  let row;
  try {
    const result = await host.reply(config, undefined);
    const raw = result.text, processed = emotions.process(speech.process(result)), reply = processed.text;
    const name = firstName(profile.name);
    row = {condition: job.condition, profile: job.profileKey, name: profile.name, prompt: job.text, rep: job.rep, raw, reply,
      voiced: /\[[a-z]+(?:-[a-z]+)*\]/i.test(raw), tagged: /\{[a-z]+(?::[a-z]+)?\}/i.test(raw), startsTagged: /^\s*\{[a-z]+(?::[a-z]+)?\}/i.test(raw),
      endedQ: endsWithQuestion(reply), anyQ: /[?？]/.test(reply),
      pronoun: PRONOUN.test(reply), ownName: new RegExp(`\\b${name}\\b`, 'i').test(reply)};
    row.flag = row.pronoun || row.ownName;
  } catch (error) {
    row = {condition: job.condition, profile: job.profileKey, prompt: job.text, rep: job.rep, error: String(error?.message ?? error).slice(0, 200)};
  }
  try { await memory.deleteAll({characterId: ids[job.profileKey], endUserId: FIXED_IDENTITY}); } catch { /* best effort */ }
  rows.push(row);
  done++;
  if (done % 10 === 0 || done === jobs.length) console.log(JSON.stringify({done, of: jobs.length}));
}
try {
  let next = 0;
  await Promise.all(Array.from({length: concurrency}, async () => { while (next < jobs.length) await work(jobs[next++]); }));
} finally {
  await host.close();
  await writeFile(destination, JSON.stringify({label, at: new Date().toISOString(), conditions: conditionNames, rows}, null, 2) + '\n');
}
const errors = rows.filter(row => row.error).length;
console.log(JSON.stringify({saved: destination.replace(root, ''), rows: rows.length, errors}));
