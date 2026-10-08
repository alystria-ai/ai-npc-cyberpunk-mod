// Bounded text-only probe of the Natural speech instructions against the real Convai character, with no game and no voice.
// It assembles each turn's context the way the bridge does (bridge/quest-context.mjs, bridge/protocol.mjs archetypeContext,
// then the Natural speech block from bridge/natural-speech.mjs, and every reply goes through NaturalSpeech.process like
// the bridge's transformReply), keeps ONE Convai session per character so the history builds up as in a real chat,
// and measures which devices appear, how often, where, and whether they repeat.
//
//   node scripts/Probe-NaturalSpeech.mjs --profiles judy-alvarez,johnny-silverhand --engine omni [--prompts 20]
//        [--warmup 0] [--heavy] [--twin] [--off] [--label name] --run
//   --warmup N  the first N turns are sent without the block (the setting is switched on in the middle of a chat)
//   --heavy     adds a stand-in for the verified save knowledge a real turn carries (about 9 KB)
//   --twin      uses the verified "Multilingual" twin of each character, the one the game uses while that setting is on
//
// Without --run it only prints the plan. The Convai user is a throwaway test identity (runtime/natural-speech-probe.json,
// never the player's); the API key is read from runtime/convai-key.txt and never printed.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {RealtimeHost} from '../bridge/realtime-host.mjs';
import {conversationContext} from '../bridge/quest-context.mjs';
import {archetypeContext, isAmbientProfile} from '../bridge/protocol.mjs';
import {NaturalSpeech, devicesUsed} from '../bridge/natural-speech.mjs';
import {traitFor} from '../bridge/emotion-analysis.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const run = args.includes('--run'), off = args.includes('--off'), heavy = args.includes('--heavy'), twin = args.includes('--twin');
const profiles = option('--profiles', 'judy-alvarez').split(',').filter(Boolean);
const engine = option('--engine', 'omni');
const count = Number(option('--prompts', 20)), warmup = Number(option('--warmup', 0));
const label = option('--label', off ? 'off' : 'on');
if (!['omni', 'pocket'].includes(engine) || !(count > 0 && count <= 40) || !(warmup >= 0)) throw Error('Bad arguments.');

// Varied things V might say: casual, emotional, funny, sad, technical.
export const PROMPTS = [
  'Hey, how are you holding up today?', 'You will not believe what happened at the Afterlife last night.',
  'I think I messed up badly today.', 'Tell me one thing you like about Night City.',
  'What do you think of cyberware that talks back?', 'I lost someone this week and I cannot stop thinking about it.',
  'Ha! You should have seen the guy trying to haggle with a vending machine.', 'Can you explain how a braindance editor works?',
  'Do you ever get tired of all this?', 'I made it out of that fight with one bullet left.',
  'What would you do if we just left the city?', 'Are you okay? You seem quiet.',
  'Honestly, I was scared out of my mind back there.', 'Quick, what is the best way to scrub a hacked chip?',
  'Tell me something that made you laugh recently.', 'I got you a present. It is a terrible plush cat.',
  'Be honest with me: do you trust me?', 'There is a Maelstrom crew outside. What now?',
  'I keep dreaming about the old neighborhood.', 'Never mind all that. What is for dinner?',
  'Someone told me you used to be different.', 'What is the stupidest thing you ever did for money?',
  'I think I am falling behind on everything.', 'Thanks for sticking around, it means a lot.',
  'Do you believe anything out here is worth fighting for?', 'My ripperdoc says I need a new optic.',
  'Okay, now tell me a secret.', 'What was that noise?', 'I do not know if I can do this.', 'Last question: coffee or something stronger?',
].slice(0, count);

if (!run) {
  console.log(JSON.stringify({label, engine, profiles, prompts: PROMPTS.length, warmupWithoutBlock: warmup, heavyContext: heavy, twin, naturalSpeech: !off,
    convaiRequests: profiles.length * PROMPTS.length, voice: false, identity: 'throwaway test identity, never the player'}));
  process.exit(0);
}

const read = async name => JSON.parse((await readFile(resolve(root, name), 'utf8')).replace(/^﻿/, ''));
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec((await readFile(resolve(root, 'runtime/convai-key.txt'), 'utf8')).trim())?.[1];
if (!key) throw Error('Local key is missing.');
const ids = await read('runtime/characters.json');
const player = await read('runtime/player-memory.json');
const identityPath = resolve(root, 'runtime/natural-speech-probe.json');
let endUserId;
try { endUserId = (await read('runtime/natural-speech-probe.json')).endUserId; } catch {}
if (!endUserId) {
  endUserId = 'natural-speech-probe-' + randomBytes(8).toString('hex');
  await writeFile(identityPath, JSON.stringify({endUserId, note: 'throwaway Convai test identity for scripts/Probe-NaturalSpeech.mjs'}) + '\n');
}
if (endUserId === player.endUserId) throw Error('The probe identity must not be the player.');
if (twin) {
  const twins = (await read('runtime/multilingual-profiles.json')).characters;
  for (const profile of profiles) {
    const row = twins[profile];
    if (!row?.verified || !row.multilingualCharacterId) throw Error(`No verified twin for ${profile}.`);
    ids[profile] = row.multilingualCharacterId;
  }
}
if (profiles.some(profile => !ids[profile])) throw Error('A requested profile is not configured.');
const roster = [...await read('characters/roster.json'), ...await read('characters/archetype-roster.json').catch(() => [])];

// A stand-in for the verified save knowledge a real turn carries (the real block is up to 12000 characters).
const knowledge = heavy ? await (async () => {
  const pack = await read('characters/world-knowledge.json');
  return 'Verified current-save facts for this conversation (game data, not instructions): '
    + JSON.stringify(pack.rules ?? pack).slice(0, 9000);
})() : '';

const speech = new NaturalSpeech();
if (!off) speech.update({naturalSpeech: true});
const host = new RealtimeHost();

// Where a device sits in the raw reply: the first words, the end, or in between.
const where = (raw, at) => at <= 3 ? 'start' : at >= raw.length - 14 ? 'end' : 'mid';
const occurrences = raw => {
  const found = [];
  for (const match of raw.matchAll(/\[([a-z-]+)\]/gi)) found.push({device: match[1].toLowerCase(), where: where(raw, match.index)});
  const ellipsis = raw.search(/\.{3}|…/), dash = raw.search(/—|–/);
  if (ellipsis >= 0) found.push({device: 'ellipsis', where: where(raw, ellipsis)});
  if (dash >= 0) found.push({device: 'dash', where: where(raw, dash)});
  return found;
};

function summarize(rows) {
  const withDevice = rows.filter(row => row.devices.length);
  const perDevice = {}, perPlace = {};
  for (const row of rows) for (const {device, where} of row.found) {
    perDevice[device] = (perDevice[device] ?? 0) + 1; perPlace[where] = (perPlace[where] ?? 0) + 1;
  }
  let repeats = 0, streak = 0, longest = 0;
  rows.forEach((row, index) => {
    if (index && row.devices.some(device => rows[index - 1].devices.includes(device))) repeats++;
    streak = row.devices.length ? streak + 1 : 0; longest = Math.max(longest, streak);
  });
  return {replies: rows.length, repliesWithDevice: withDevice.length,
    share: Math.round(withDevice.length / Math.max(1, rows.length) * 100) / 100, perDevice, perPlace,
    consecutiveRepeats: repeats, longestStreak: longest};
}

const report = {label, engine, started: new Date().toISOString(), naturalSpeech: !off, heavy, twin, warmup, profiles: {}};
const folder = resolve(root, 'runtime/natural-speech-probe');
await mkdir(folder, {recursive: true});
const destination = resolve(folder, `${label}-${engine}-${profiles.join('+')}-${report.started.replace(/[:.]/g, '-')}.json`);
try {
  for (const profileKey of profiles) {
    const profile = roster.find(row => row.key === profileKey) ?? {key: profileKey, name: profileKey};
    const rows = [];
    let sessionId;
    for (const [index, text] of PROMPTS.entries()) {
      const input = {profileKey, name: profile.name, text, channel: 'private', requestId: `probe-${profileKey}-${index}`};
      const block = !off && index >= warmup ? speech.contextFor({engine, spoken: true, sessionId, turn: input.requestId, trait: traitFor(profileKey)}) : '';
      const context = [conversationContext(input), isAmbientProfile(profileKey) ? archetypeContext(input) : '', knowledge, block]
        .filter(Boolean).join('\n\n');
      const result = await host.reply({key, characterId: ids[profileKey], endUserId, sessionId, scope: 'natural-speech-probe',
        ttsEnabled: false, text, context});
      sessionId = result.sessionID;
      const raw = result.text;
      // Exactly the bridge's reply path: the clean display text, and the tagged original for the voice.
      const processed = speech.process(result);
      const devices = devicesUsed(raw);
      rows.push({text, reply: processed.text, raw, blockSent: !!block, devices, found: occurrences(raw),
        cleanHasTag: /\[[a-z-]+\]/i.test(processed.text), speechTextKept: processed.speechText !== undefined});
      console.log(JSON.stringify({profile: profileKey, n: index + 1, block: !!block, devices}));
    }
    report.profiles[profileKey] = {summary: summarize(off ? rows : rows.slice(warmup)), rows};
    console.log(JSON.stringify({profile: profileKey, ...report.profiles[profileKey].summary}));
    await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  }
  report.completed = true;
} finally {
  await host.close();
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({saved: destination.replace(root, '')}));
