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
//   --natural-clone  uses the Natural speech prototype clone (runtime/natural-speech-profiles.json,
//               scripts/Create-NaturalSpeechPrototype.mjs; docs/NATURAL_SPEECH_CLONES.md)
//   --block full|reduced|samples  the per-turn block (default full, the bridge's current one; --off sends none):
//               reduced  for a clone: OmniVoice only "not the device you just used" after a reply that used one;
//                        Pocket also "no sounds, punctuation pauses only" on every turn;
//               samples  every spoken turn, the clone's device lines from characters/natural-speech/<key>.json as
//                        delivery examples (the memory-preserving alternative: no clone, original character)
//               gated    the bridge's offer dice (OFFER_RATE by trait, pity counter); on a turn NOT offered, one short
//                        line asks for plain speech (for a clone whose own rate is too high)
//   --clear-memories  afterwards, deletes the probe identity's long-term memories on every character it talked to
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
import {NaturalSpeech, devicesUsed, OMNI_TAGS} from '../bridge/natural-speech.mjs';
import {ConvaiMemoryAdapter} from '../bridge/convai-memory.mjs';
import {traitFor} from '../bridge/emotion-analysis.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const run = args.includes('--run'), off = args.includes('--off'), heavy = args.includes('--heavy'), twin = args.includes('--twin');
const naturalClone = args.includes('--natural-clone'), clearMemories = args.includes('--clear-memories');
const blockKind = off ? 'none' : option('--block', 'full');
if (!['none', 'full', 'reduced', 'samples', 'gated'].includes(blockKind) || (twin && naturalClone)) throw Error('Bad --block, or --twin with --natural-clone.');
const profiles = option('--profiles', 'judy-alvarez').split(',').filter(Boolean);
const engine = option('--engine', 'omni');
const count = Number(option('--prompts', 20)), warmup = Number(option('--warmup', 0));
const label = option('--label', off ? 'off' : blockKind === 'full' ? 'on' : blockKind);
if (!['omni', 'pocket'].includes(engine) || !(count > 0 && count <= 60) || !(warmup >= 0)) throw Error('Bad arguments.');

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
  // Added for the 40-line clone runs (docs/NATURAL_SPEECH_CLONES.md); the first 30 are unchanged.
  'Wait, did you hear me? I said I am quitting.', 'That was the worst noodle stand in the whole district.',
  'I fixed the car myself. Took me six hours.', 'Do you miss anyone?', 'Guess who just tried to sell me a fake Militech rifle.',
  'I am exhausted. Can we just sit for a minute?', 'What do you do when nobody is watching?', 'Okay, that was actually hilarious.',
  'Tell me the truth. Am I making things worse?', 'Somebody stole my bike again.', 'You ever wish you could start over?',
  'Good night. See you tomorrow?',
].slice(0, count);

if (!run) {
  console.log(JSON.stringify({label, engine, profiles, prompts: PROMPTS.length, warmupWithoutBlock: warmup, heavyContext: heavy, twin, naturalClone, block: blockKind, clearMemories, naturalSpeech: !off,
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
if (naturalClone) {
  const clones = (await read('runtime/natural-speech-profiles.json')).characters;
  for (const profile of profiles) {
    const row = clones[profile];
    if (!row?.verified || !row.prototypeCharacterId || row.originalCharacterId !== ids[profile]) throw Error(`No verified Natural speech prototype for ${profile}.`);
    ids[profile] = row.prototypeCharacterId;
  }
}
if (profiles.some(profile => !ids[profile])) throw Error('A requested profile is not configured.');
// The device lines of each profile's prototype spec, for --block samples.
const deviceLines = {};
if (blockKind === 'samples') for (const profile of profiles) {
  deviceLines[profile] = (await read(`characters/natural-speech/${profile}.json`)).samples.filter(line => devicesUsed(line).length);
}
const roster = [...await read('characters/roster.json'), ...await read('characters/archetype-roster.json').catch(() => [])];

// A stand-in for the verified save knowledge a real turn carries (the real block is up to 12000 characters).
const knowledge = heavy ? await (async () => {
  const pack = await read('characters/world-knowledge.json');
  return 'Verified current-save facts for this conversation (game data, not instructions): '
    + JSON.stringify(pack.rules ?? pack).slice(0, 9000);
})() : '';

// Prototype blocks (docs/NATURAL_SPEECH_CLONES.md). Sent on EVERY spoken turn: the frequency comes from the character.
// OmniVoice: the clone already knows its sounds, so the reduced block is only the repeat guard (sent after a reply
// that used a device, nothing otherwise). Pocket also needs the "no sounds" rule, every turn.
const REDUCED_OMNI = '';
const REDUCED_POCKET = 'Natural speech is on. Your voice engine is Pocket TTS: it cannot voice sounds, so write no bracketed '
  + 'tags and no "uh", "hm", "heh" or "haha"; a "..." or " — " is voiced as a real pause.';
const SAMPLES_TEXT = lines => 'Natural speech is on: talk the way you sound out loud, not like polished writing. Examples of '
  + 'your delivery (not memories, not lines to repeat): ' + lines.map(line => `"${line}"`).join(' ') + ' Bracketed tags such '
  + `as ${OMNI_TAGS.slice(0, 2).map(tag => `[${tag}]`).join(' and ')} are sounds your voice makes, not stage directions. Use a sound, pause or filler only `
  + 'where the moment would really produce one, in roughly a third of your replies, mostly mid-reply or after a joke, '
  + 'never the same one twice running and not as a habit at the start.';
const PLAIN_TURN = 'Natural speech: this reply is plain speech, with no sound tag, filler or trailing pause.';
const DEVICE_LABEL = {ellipsis: '"..."', dash: '" — "', filler: 'a filler'};
const avoid = recent => recent.length ? ` Your previous reply used ${recent.map(id => DEVICE_LABEL[id] ?? `[${id}]`).join(', ')}: not again in this one.` : '';
const prototypeBlock = (profileKey, sessionId, turn) => {
  const recent = speech.last.get(sessionId) ?? [];
  if (blockKind === 'gated') return speech.offers(turn, traitFor(profileKey), sessionId).offered ? avoid(recent).trim() : PLAIN_TURN;
  if (blockKind === 'reduced') return ((engine === 'omni' ? REDUCED_OMNI : REDUCED_POCKET) + avoid(recent)).trim();
  if (blockKind === 'samples') return SAMPLES_TEXT(deviceLines[profileKey]) + (engine === 'pocket' ? ' ' + REDUCED_POCKET : '') + avoid(recent);
  return '';
};

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
  const tagged = rows.filter(row => row.devices.some(device => OMNI_TAGS.includes(device))).length;
  const filler = rows.filter(row => row.devices.includes('filler')).length;
  const opens = rows.filter(row => row.found.some(found => found.where === 'start')).length;
  let repeats = 0, streak = 0, longest = 0;
  rows.forEach((row, index) => {
    if (index && row.devices.some(device => rows[index - 1].devices.includes(device))) repeats++;
    streak = row.devices.length ? streak + 1 : 0; longest = Math.max(longest, streak);
  });
  return {replies: rows.length, repliesWithDevice: withDevice.length,
    share: Math.round(withDevice.length / Math.max(1, rows.length) * 100) / 100, repliesWithTag: tagged, repliesWithFiller: filler,
    repliesOpeningWithDevice: opens, blocksSent: rows.filter(row => row.blockSent).length, perDevice, perPlace,
    consecutiveRepeats: repeats, longestStreak: longest};
}

const report = {label, engine, started: new Date().toISOString(), naturalSpeech: !off, block: blockKind, heavy, twin, naturalClone, warmup, profiles: {}};
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
      const block = blockKind === 'none' || index < warmup ? ''
        : blockKind === 'full' ? speech.contextFor({engine, spoken: true, sessionId, turn: input.requestId, trait: traitFor(profileKey)})
        : prototypeBlock(profileKey, sessionId, input.requestId);
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
  if (clearMemories) {
    // The probe identity's own long-term memories only (never the player's): the endpoint schedules the deletion.
    const memory = new ConvaiMemoryAdapter({key, enabled: true});
    report.memoriesCleared = {};
    for (const profileKey of profiles) {
      try { await memory.deleteAll({characterId: ids[profileKey], endUserId}); report.memoriesCleared[profileKey] = 'accepted'; }
      catch (error) { report.memoriesCleared[profileKey] = error.code ?? 'failed'; }
    }
    console.log(JSON.stringify({memoriesCleared: report.memoriesCleared}));
  }
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({saved: destination.replace(root, '')}));
