// Collects REAL companion replies for the emotion-picker evaluation (assets/emotion/segments-*.json): text-only Convai
// turns with the "Expressive emotions" block ON (the player's setting), each with the character's raw inline tags
// ({calm}, {interest}, ...) and Convai's own late bot-emotion label, exactly what the bridge's picker sees in game.
//
//   node scripts/Probe-EmotionReplies.mjs --profiles evelyn-parker,alex [--prompts 28] [--label name] --run
//
// Without --run it only prints the plan. A FRESH throwaway Convai identity per run (never the player's); the API key
// is read from runtime/convai-key.txt and never printed. One session per character; one request per prompt per
// character (about 28 per character), no retries. Output: runtime/emotion-probe/<label>-<profile>.json.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {RealtimeHost} from '../bridge/realtime-host.mjs';
import {conversationContext} from '../bridge/quest-context.mjs';
import {archetypeContext, isAmbientProfile} from '../bridge/protocol.mjs';
import {ExpressiveEmotions} from '../bridge/expressive-emotions.mjs';
import {waitLateEmotion} from '../bridge/emotion-selector.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const run = args.includes('--run');
const profiles = option('--profiles', 'evelyn-parker').split(',').filter(Boolean);
const label = option('--label', 'probe');

// What V says: moods that make a companion guarded, defensive, teasing, sarcastic, warm, worried, annoyed, amused,
// sad, proud, flirty or matter-of-fact.
export const PROMPTS = [
  'Someone told me you were captured once. Is that true?', 'Why do you always dodge when I ask about your past?',
  'Nice outfit. Did you lose a bet?', 'You look really good today, not gonna lie.',
  'Great plan, genius. Now we are completely lost.', 'I think someone is following us.',
  'I finally paid off my debt to the fixer!', 'Do you ever miss the person you used to be?',
  'What do you think of the corpos running this city?', 'Can you hand me that data shard?',
  'I am proud of how far you have come.', 'I accidentally deleted the security footage.',
  'That was the dumbest thing I have ever seen you do. I loved it.', 'I do not trust you. Prove me wrong.',
  'Tell me about your family.', 'You got hurt back there. Let me look at it.',
  'I heard you snore last night. Like a chainsaw.', 'What do you want to do when this is all over?',
  'I am sorry I got you into this mess.', 'Somebody stole my car and left a note that said thanks.',
  'How much would a job like this cost me?', 'Do you think we are going to make it out of this alive?',
  'Why did you lie to me about the shipment?', 'Look at that view. Makes you forget everything for a second.',
  'That guy keeps staring at us. Want me to handle him?', 'Ha! You actually fell for it!',
  'We got the money. Every last eddie.', 'I found something in your bag. Is this yours?',
];

const limit = Number(option('--prompts', 28));
// A second, different prompt list (--set b) for an untouched check after the picker was tuned on the first.
export const PROMPTS_B = [
  'Be honest: were you scared back there?', 'You are late. Again.', 'I made breakfast. Do not laugh at the eggs.',
  'Who was the last person you really trusted?', 'That drive-by almost got us killed.',
  'I picked up a little something for you. Close your eyes.', 'Guess who just got promoted?',
  'Are you ever going to tell me what happened in the Badlands?', 'I do not think anyone will remember us when we are gone.',
  'You really think you can talk your way out of this one?', 'Do you ever get tired of being the strong one?',
  'How is the arm? That looked nasty.', 'I am thinking about quitting the city for good.',
  'Your jokes are terrible, you know that?', 'What would you do with a million eddies?',
  'He is dead. They found him in the alley.', 'I cannot believe you actually showed up.',
  'Want to get out of here? Somewhere quiet.', 'Rumor says there is a bounty on your head.',
  'Hold still, I am trying to fix your jacket.', 'Where did you learn to shoot like that?',
  'I have got bad news about the car.', 'What is the plan if this goes sideways?',
  'You told me you hated this place. Why do you stay?', 'Sorry I am late. I got lost in the market.',
  'I read your file. Interesting stuff.', 'Drinks are on me tonight.', 'Do you think the city will ever change?',
];
// A third list (--set c), collected after the picker was frozen against the first two.
export const PROMPTS_C = [
  'What are you thinking about right now?', 'I borrowed your jacket. Sorry about the stain.', 'You never told me you could cook.',
  'Someone left a threat at my door.', 'Do you actually like it here?', 'Tell me about the worst day of your life.',
  'I think I owe you an apology.', 'That was incredible! How did you do that?', 'Why are you always so serious?',
  'I got us a table at the Afterlife.', 'Do you ever wish you had chosen a different path?', 'I heard the Arasaka job went wrong.',
  'You are a terrible driver, you know that?', 'I will be right back. Do not do anything stupid.',
  'What is the most dangerous thing you have ever done?', 'I need your help, and I cannot tell you why.',
  'You have something on your face.', 'I think I am in over my head.', 'Is it true you used to be someone important?',
  'Look, I brought coffee.', 'The fixer wants to meet us tonight.', 'I had a dream about you last night.',
  'Why did you really come with me?', 'He looked right at us and just walked away.', 'I never thanked you properly.',
  'That song is stuck in my head again.', 'You cannot be serious about this plan.', 'Everyone I know is gone. Except you.',
];
const prompts = {b: PROMPTS_B, c: PROMPTS_C}[option('--set', 'a')] ?? PROMPTS;
if (!run) {
  console.log(JSON.stringify({label, profiles, prompts: prompts.length, convaiRequests: profiles.length * prompts.length}));
  process.exit(0);
}
const read = async name => JSON.parse((await readFile(resolve(root, name), 'utf8')).replace(/^﻿/, ''));
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec((await readFile(resolve(root, 'runtime/convai-key.txt'), 'utf8')).trim())?.[1];
if (!key) throw Error('Local key is missing.');
const ids = await read('runtime/characters.json');
const player = await read('runtime/player-memory.json');
const endUserId = 'emotion-probe-' + randomBytes(8).toString('hex');
if (endUserId === player.endUserId) throw Error('The probe identity must not be the player.');
if (profiles.some(profile => !ids[profile])) throw Error('A requested profile is not configured.');
const roster = [...await read('characters/roster.json'), ...await read('characters/archetype-roster.json').catch(() => [])];
const emotions = new ExpressiveEmotions();
emotions.update({expressiveEmotions: true});
const host = new RealtimeHost();
const folder = resolve(root, 'runtime/emotion-probe');
await mkdir(folder, {recursive: true});
try {
  for (const profileKey of profiles) {
    const profile = roster.find(row => row.key === profileKey) ?? {key: profileKey, name: profileKey};
    const rows = [];
    let sessionId;
    for (const [index, text] of prompts.slice(0, limit).entries()) {
      const input = {profileKey, name: profile.name, text, channel: 'private', requestId: `emo-${profileKey}-${index}`,
        ...(profile.archetype ? {archetype: profile.archetype} : {})};
      const context = [conversationContext(input), isAmbientProfile(profileKey) ? archetypeContext(input) : '',
        emotions.contextFor({engine: 'omni', spoken: true})].filter(Boolean).join('\n\n');
      const config = {key, characterId: ids[profileKey], endUserId, sessionId, scope: 'emotion-probe', ttsEnabled: false, text, context};
      const result = await host.reply(config, undefined).catch(error => ({error: String(error?.message ?? error)}));
      if (result.error) { rows.push({player: text, error: result.error}); console.log(JSON.stringify({profile: profileKey, n: index + 1, error: result.error})); continue; }
      sessionId = result.sessionID;
      let late;
      if (Number.isSafeInteger(result.lateEmotionToken))
        late = await waitLateEmotion(() => host.lateEmotion({...config, sessionId}, result.lateEmotionToken)).catch(() => undefined);
      rows.push({profile: profileKey, player: text, raw: result.text, convai: late ? {emotion: late.emotion, scale: late.scale, basis: late.basis} : null});
      console.log(JSON.stringify({profile: profileKey, n: index + 1, words: result.text.split(/\s+/).length, convai: late?.emotion ?? null}));
    }
    await writeFile(resolve(folder, `${label}-${profileKey}.json`), JSON.stringify({label, profile: profileKey, at: new Date().toISOString(), rows}, null, 2) + '\n');
  }
} finally { await host.close(); }
