// Offline, text-only probe of the inline emotion tags ("Expressive emotions", docs/EMOTION_TAGS.md) against the real Convai
// characters: no game, no voice, no bridge. Each turn's context is assembled the way the bridge does (bridge/quest-context.mjs,
// then Follow-up, Natural speech and the emotion block, in the bridge's order), every reply goes through the bridge's cleaning
// (NaturalSpeech.process, ExpressiveEmotions.process), and ONE Convai session per character keeps the history, as in a chat.
//
//   node scripts/Probe-EmotionTags.mjs --profiles judy-alvarez,panam-palmer --block off|v0|new|<file> [--prompts 40]
//        [--no-natural] [--no-followup] [--hangover N] [--seed 1] [--label name] [--clear-memories] --run
//   --block off     no emotion block (the control); natural and follow-up blocks are still sent
//   --block v0      the October 7 block, before this work (scripts/emotion-block-october7.txt)
//   --block new     the block now in bridge/emotion-tags.mjs (EMOTION_TAG_BLOCK = EXPRESSIVE_TEXT)
//   --block <file>  the text in that file (a candidate wording)
//   --hangover N    the block is sent for the first N turns only, then dropped (does the model keep writing tags?)
//   --engine omni|pocket  which voice the turn is for (default omni; the Natural speech block differs)
//
// Without --run it only prints the plan. Every run uses a FRESH throwaway Convai identity (never the player's); the API key is
// read from runtime/convai-key.txt and never printed. Output: runtime/emotion-tags-probe/<label>-<profile>.json, one row per
// turn: the player line, the raw reply, Convai's late emotion label, which blocks were sent.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {RealtimeHost} from '../bridge/realtime-host.mjs';
import {conversationContext} from '../bridge/quest-context.mjs';
import {archetypeContext, isAmbientProfile} from '../bridge/protocol.mjs';
import {NaturalSpeech} from '../bridge/natural-speech.mjs';
import {ExpressiveEmotions} from '../bridge/expressive-emotions.mjs';
import {FollowUp} from '../bridge/follow-up.mjs';
import {EMOTION_TAG_BLOCK} from '../bridge/emotion-tags.mjs';
import {traitFor} from '../bridge/emotion-analysis.mjs';
import {waitLateEmotion} from '../bridge/emotion-selector.mjs';
import {ConvaiMemoryAdapter} from '../bridge/convai-memory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const run = args.includes('--run');
const profiles = option('--profiles', 'judy-alvarez').split(',').filter(Boolean);
const blockOption = option('--block', 'new');
const engine = option('--engine', 'omni');
const seed = Number(option('--seed', 1)), hangover = Number(option('--hangover', 0));
const count = Number(option('--prompts', 40));
const label = option('--label', blockOption.replace(/[^a-z0-9]+/gi, '-').slice(0, 24));
if (!(count > 0 && count <= 40) || !['omni', 'pocket'].includes(engine)) throw Error('Bad arguments.');

// What V says: provocation, sad news, teasing, flirting, surprise, mission talk and small talk (category in the second slot).
export const PROMPTS = [
  ['provocation', 'You are useless in a fight, you know that?'], ['small', 'Rain again. Does this city ever dry out?'],
  ['sad', 'I just found out an old friend of mine died last night.'], ['teasing', 'Admit it, you were scared back there.'],
  ['mission', 'We have ten minutes before the guards rotate. What is the plan?'], ['flirting', 'You look incredible tonight.'],
  ['surprise', 'Guess who just walked into the bar.'], ['provocation', 'Why should I trust a word you say?'],
  ['small', 'What are you having for breakfast?'], ['sad', 'They shot him right in front of me and I could not do a thing.'],
  ['teasing', 'Nice haircut. Did you lose a fight with a drone?'], ['mission', 'I need you to cover the east entrance while I hack the terminal.'],
  ['surprise', 'I won the lottery. Three million eddies!'], ['flirting', 'I cannot stop thinking about last night.'],
  ['provocation', 'Everyone says you sold out. Did you?'], ['small', 'What is your favorite place in Night City?'],
  ['sad', 'My place got torched. Everything I owned is gone.'], ['mission', 'The shipment is two floors down. How do we get past security?'],
  ['teasing', 'You snore like a busted turbine, did you know that?'], ['surprise', 'The door was open and the whole place was empty.'],
  ['flirting', 'Stay a little longer. I like having you close.'], ['small', 'Did you sleep okay?'],
  ['provocation', 'Go on, say it to my face.'], ['mission', 'They know we are here. Orders?'],
  ['sad', 'I think I am losing my memory of my parents\' faces.'], ['surprise', 'That thing I bought is alive. It is moving.'],
  ['teasing', 'I bet you cannot go a whole day without complaining.'], ['small', 'I found a stray cat outside. Can I keep it?'],
  ['flirting', 'Is it weird that I feel safe whenever you are around?'], ['mission', 'We got the data shard. Now what?'],
  ['provocation', 'You are just like every other corpo lapdog.'], ['sad', 'I could not save her.'],
  ['surprise', 'Your old crew just called. They want you back.'], ['mission', 'Which is better, going in loud or quiet?'],
  ['flirting', 'What would you do if I kissed you right now?'], ['teasing', 'Careful, your soft side is showing.'],
  ['small', 'Long day. Anything on your mind?'], ['sad', 'The doc says I do not have long.'],
  ['mission', 'Check the roof, I will take the stairs.'], ['provocation', 'I heard you ran away when things got hard.'],
].slice(0, count);

const blockText = async () => {
  if (blockOption === 'off') return null;
  if (blockOption === 'v0') return (await readFile(resolve(root, 'scripts/emotion-block-october7.txt'), 'utf8')).trim();
  if (blockOption === 'new') return EMOTION_TAG_BLOCK;
  return (await readFile(resolve(blockOption), 'utf8')).trim();
};

if (!run) {
  console.log(JSON.stringify({label, profiles, prompts: PROMPTS.length, block: blockOption, engine, hangoverAfter: hangover || null,
    convaiRequests: profiles.length * PROMPTS.length, identity: 'fresh throwaway per run, never the player'}));
  process.exit(0);
}

const read = async name => JSON.parse((await readFile(resolve(root, name), 'utf8')).replace(/^﻿/, ''));
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec((await readFile(resolve(root, 'runtime/convai-key.txt'), 'utf8')).trim())?.[1];
if (!key) throw Error('Local key is missing.');
const ids = await read('runtime/characters.json');
const player = await read('runtime/player-memory.json');
const endUserId = 'emotion-tags-probe-' + randomBytes(8).toString('hex');
if (endUserId === player.endUserId) throw Error('The probe identity must not be the player.');
if (profiles.some(profile => !ids[profile])) throw Error('A requested profile is not configured.');
const roster = [...await read('characters/roster.json'), ...await read('characters/archetype-roster.json').catch(() => [])];
const text = await blockText();

const rng = start => () => { start |= 0; start = start + 0x6D2B79F5 | 0; let t = Math.imul(start ^ start >>> 15, 1 | start); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const hash = value => [...value].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);

const host = new RealtimeHost();
const folder = resolve(root, 'runtime/emotion-tags-probe');
await mkdir(folder, {recursive: true});
try {
  for (const profileKey of profiles) {
    const profile = roster.find(row => row.key === profileKey) ?? {key: profileKey, name: profileKey};
    const random = rng(seed + hash(profileKey));
    const speech = new NaturalSpeech(), emotions = new ExpressiveEmotions(), followUp = new FollowUp();
    if (!args.includes('--no-natural')) speech.update({naturalSpeech: true});
    if (!args.includes('--no-followup')) followUp.update({followUpInterest: true});
    if (blockOption !== 'off') emotions.update({expressiveEmotions: true});
    const rows = [];
    let sessionId;
    for (const [index, [category, line]] of PROMPTS.entries()) {
      const input = {profileKey, name: profile.name, text: line, channel: 'private', requestId: `etp-${profileKey}-${index}`,
        ...(profile.archetype ? {archetype: profile.archetype} : {})};
      const trait = traitFor(profileKey);
      const withEmotion = text !== null && (!hangover || index < hangover);
      const follow = followUp.contextFor({sessionId: profileKey, turn: input.requestId, trait, text: line, random});
      const natural = speech.contextFor({engine, spoken: true, sessionId, turn: input.requestId, trait, profile: profileKey, name: profile.name, random});
      const gate = emotions.contextFor({engine, spoken: true});
      const emotion = withEmotion && gate ? text : '';
      const context = [conversationContext(input), isAmbientProfile(profileKey) ? archetypeContext(input) : '', follow, natural, emotion]
        .filter(Boolean).join('\n\n');
      const config = {key, characterId: ids[profileKey], endUserId, sessionId, scope: 'emotion-tags-probe', ttsEnabled: false, text: line, context};
      const result = await host.reply(config, undefined).catch(error => ({error: String(error?.message ?? error)}));
      if (result.error) { rows.push({n: index, category, player: line, error: result.error}); console.log(JSON.stringify({profile: profileKey, n: index + 1, error: result.error})); continue; }
      sessionId = result.sessionID;
      const processed = emotions.process(speech.process({...result}));
      let late;
      if (Number.isSafeInteger(result.lateEmotionToken)) {
        late = await waitLateEmotion(() => host.lateEmotion({...config, sessionId}, result.lateEmotionToken)).catch(() => undefined);
      }
      if (followUp.enabled) followUp.record(profileKey, processed.text);
      rows.push({n: index, category, profile: profileKey, player: line, raw: result.text, clean: processed.text,
        marks: processed.emotionMarks ?? null, speechText: processed.speechText ?? null,
        convai: late ? {emotion: late.emotion, scale: late.scale, basis: late.basis} : null,
        blocks: {emotion: !!emotion, natural: !!natural, followUp: !!follow}, contextChars: context.length});
      console.log(JSON.stringify({profile: profileKey, n: index + 1, emotionBlock: !!emotion, tags: (result.text.match(/\{[^}]*\}/g) ?? []).length}));
    }
    await writeFile(resolve(folder, `${label}-${profileKey}.json`), JSON.stringify({label, profile: profileKey, block: blockOption,
      blockText: text, engine, seed, hangover, at: new Date().toISOString(), rows}, null, 2) + '\n');
  }
} finally {
  await host.close();
  if (args.includes('--clear-memories')) {
    // The probe identity's own long-term memories only (never the player's).
    const memory = new ConvaiMemoryAdapter({key, enabled: true});
    for (const profileKey of profiles) await memory.deleteAll({characterId: ids[profileKey], endUserId}).catch(() => {});
  }
}
