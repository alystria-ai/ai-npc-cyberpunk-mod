// Bounded text-only probe of "Follow-up questions" against the real Convai characters, with no game and no voice.
// It assembles each turn's context the way the bridge does (bridge/quest-context.mjs, archetypeContext, then the block from
// bridge/follow-up.mjs decided by the SAME FollowUp class, so the rate, the pity counter, the exclusions and "never after
// a question" all apply), keeps ONE Convai session per character so the history builds up as in a real chat, and measures
// how often replies end in a question or pull, how long they are, and (in the saved transcript) what they say.
//
//   node scripts/Probe-FollowUp.mjs --profiles judy-alvarez,panam-palmer,johnny-silverhand,npc-tyger-claws-male
//        [--prompts 36] [--off] [--label name] [--seed 1] [--block-file path] [--with-others] [--clear-memories] --run
//   --off            no block, the setting off (the baseline); every other part of the context is the same
//   --seed N         seeds the offer dice (a run is repeatable)
//   --block-file P   use the text in P instead of FOLLOW_UP_TEXT (to compare wordings without editing the module)
//   --with-others    also adds the Natural speech (OmniVoice) and Expressive emotions blocks and the multilingual
//                    reply-language line, in the bridge's order, to check that they coexist
//   --others a,b     only some of them: natural, emotions, multilingual (implies --with-others)
//   --followup-first put the follow-up block before the other blocks (the bridge puts it after them)
//   --clear-memories deletes the probe identity's long-term memories on every character it talked to
//
// Without --run it only prints the plan. Every run uses a FRESH throwaway Convai identity (never the player's, never
// reused, so the off and on runs cannot remember each other); the API key is read from runtime/convai-key.txt and never printed.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {RealtimeHost} from '../bridge/realtime-host.mjs';
import {conversationContext} from '../bridge/quest-context.mjs';
import {archetypeContext, isAmbientProfile} from '../bridge/protocol.mjs';
import {FollowUp, FOLLOW_UP_TEXT, endsWithQuestion, traitFor} from '../bridge/follow-up.mjs';
import {NaturalSpeech} from '../bridge/natural-speech.mjs';
import {ExpressiveEmotions} from '../bridge/expressive-emotions.mjs';
import {MultilingualConversations} from '../bridge/multilingual.mjs';
import {ConvaiMemoryAdapter} from '../bridge/convai-memory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const others = option('--others') ? option('--others').split(',') : args.includes('--with-others') ? ['natural', 'emotions', 'multilingual'] : [];
const followUpFirst = args.includes('--followup-first');
const run = args.includes('--run'), off = args.includes('--off'), withOthers = others.length > 0, clearMemories = args.includes('--clear-memories');
const profiles = option('--profiles', 'judy-alvarez').split(',').filter(Boolean);
const count = Number(option('--prompts', 36)), seed = Number(option('--seed', 1));
const label = option('--label', off ? 'off' : 'on');
if (!(count > 0 && count <= 40) || !Number.isFinite(seed)) throw Error('Bad arguments.');

// What V says: a mix of things that happened to V (a pull can be specific), questions for the character, a request
// and a goodbye (the bridge never offers a pull on those two).
export const PROMPTS = [
  'Hey, how are you holding up today?', 'You will not believe what happened at the Afterlife last night.',
  'I got into a fight with a guy over a parking spot. Won, barely.', 'I think I messed up badly today.',
  'Tell me one thing you like about Night City.', 'I lost someone this week and I cannot stop thinking about it.',
  'Ha! You should have seen the guy trying to haggle with a vending machine.', 'Can you explain how a braindance editor works?',
  'I made it out of that fight with one bullet left.', 'I have been thinking about leaving the city for a while.',
  'Honestly, I was scared out of my mind back there.', 'Follow me, we are going to the car.',
  'I got you a present. It is a terrible plush cat.', 'Be honest with me: do you trust me?',
  'I keep dreaming about the old neighborhood.', 'Never mind all that. What is for dinner?',
  'My ripperdoc says I need a new optic.', 'I fixed the car myself. Took me six hours.',
  'Someone told me you used to be different.', 'That was the worst noodle stand in the whole district.',
  'I am exhausted. Can we just sit for a minute?', 'I think I am falling behind on everything.',
  'Thanks for sticking around, it means a lot.', 'What was that noise?', 'Okay, that was actually hilarious.',
  'Wait here a second, I need to check something.', 'Somebody stole my bike again.', 'You ever wish you could start over?',
  'I do not know if I can do this.', 'Guess who just tried to sell me a fake Militech rifle.',
  'Do you believe anything out here is worth fighting for?', 'I stayed up all night reading about old pre-war music.',
  'Tell me the truth. Am I making things worse?', 'Okay, now tell me a secret.',
  'Honestly, this was a good day. Better than most.', 'Alright, I am heading out. Good night, see you tomorrow.',
].slice(0, count);

if (!run) {
  console.log(JSON.stringify({label, profiles, prompts: PROMPTS.length, followUp: !off, seed, others, followUpFirst,
    convaiRequests: profiles.length * PROMPTS.length, voice: false, identity: 'fresh throwaway identity per run, never the player'}));
  process.exit(0);
}

const read = async name => JSON.parse((await readFile(resolve(root, name), 'utf8')).replace(/^﻿/, ''));
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec((await readFile(resolve(root, 'runtime/convai-key.txt'), 'utf8')).trim())?.[1];
if (!key) throw Error('Local key is missing.');
const ids = await read('runtime/characters.json');
const player = await read('runtime/player-memory.json');
const endUserId = 'follow-up-probe-' + randomBytes(8).toString('hex');
if (endUserId === player.endUserId) throw Error('The probe identity must not be the player.');
if (profiles.some(profile => !ids[profile])) throw Error('A requested profile is not configured.');
const roster = [...await read('characters/roster.json'), ...await read('characters/archetype-roster.json').catch(() => [])];
const blockText = option('--block-file') ? (await readFile(resolve(option('--block-file')), 'utf8')).trim() : FOLLOW_UP_TEXT;

// A small seeded generator so a run can be repeated.
const rng = start => () => { start |= 0; start = start + 0x6D2B79F5 | 0; let t = Math.imul(start ^ start >>> 15, 1 | start); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const random = rng(seed);

const followUp = new FollowUp();
if (!off) followUp.update({followUpInterest: true});
const speech = new NaturalSpeech(), emotions = new ExpressiveEmotions(), multilingual = new MultilingualConversations();
if (others.includes('natural')) speech.update({naturalSpeech: true});
if (others.includes('emotions')) emotions.update({expressiveEmotions: true});
const host = new RealtimeHost();

const words = text => (text.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
const sentences = text => text.replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]*["'”)]*/g)?.map(s => s.trim()).filter(Boolean) ?? [];
// Heuristic pull: a question in the last two sentences (the quality is judged by reading the saved transcript).
const hasPull = text => sentences(text).slice(-2).some(s => /[?？]/.test(s));

function summarize(rows) {
  const n = rows.length, pct = (a, b = n) => Math.round(a / Math.max(1, b) * 100);
  const offered = rows.filter(r => r.offered), plain = rows.filter(r => !r.offered);
  const length = group => group.length ? Math.round(group.reduce((sum, r) => sum + r.words, 0) / group.length * 10) / 10 : null;
  return {replies: n, offered: offered.length, offeredPct: pct(offered.length),
    endedWithQuestion: rows.filter(r => r.endedQ).length, endedWithQuestionPct: pct(rows.filter(r => r.endedQ).length),
    pullInLastTwoSentences: rows.filter(r => r.pull).length, pullPct: pct(rows.filter(r => r.pull).length),
    anyQuestionMark: rows.filter(r => r.anyQ).length,
    endedWithQuestionWhenOffered: offered.filter(r => r.endedQ).length, pullWhenOffered: offered.filter(r => r.pull).length,
    endedWithQuestionWhenNot: plain.filter(r => r.endedQ).length, pullWhenNot: plain.filter(r => r.pull).length,
    avgWords: length(rows), avgWordsOffered: length(offered), avgWordsNot: length(plain),
    over50Pct: pct(rows.filter(r => r.words > 50).length), over75Pct: pct(rows.filter(r => r.words > 75).length), maxWords: Math.max(0, ...rows.map(r => r.words)),
    reasons: rows.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] ?? 0) + 1; return acc; }, {}),
    twoPullsInARow: rows.filter((r, i) => i && r.offered && rows[i - 1].offered).length};
}

const report = {label, started: new Date().toISOString(), followUp: !off, seed, others, followUpFirst, profiles: {}, blockText: off ? null : blockText};
const folder = resolve(root, 'runtime/follow-up-probe');
await mkdir(folder, {recursive: true});
const destination = resolve(folder, `${label}-${profiles.join('+')}-${report.started.replace(/[:.]/g, '-')}.json`);
try {
  for (const profileKey of profiles) {
    const profile = roster.find(row => row.key === profileKey) ?? {key: profileKey, name: profileKey};
    const rows = [];
    let sessionId;
    for (const [index, text] of PROMPTS.entries()) {
      const input = {profileKey, name: profile.name, text, channel: 'private', requestId: `probe-${profileKey}-${index}`,
        ...(profile.archetype ? {archetype: profile.archetype} : {})};
      const decision = off ? {offered: false, reason: 'off'}
        : followUp.offers({sessionId: profileKey, turn: input.requestId, trait: traitFor(profileKey), text, random});
      const blocks = [];
      if (decision.offered && followUpFirst) blocks.push(blockText);
      blocks.push(speech.contextFor({engine: 'omni', spoken: true, sessionId, turn: input.requestId, trait: traitFor(profileKey), random}));
      blocks.push(emotions.contextFor({engine: 'omni', spoken: true}));
      if (decision.offered && !followUpFirst) blocks.push(blockText);
      blocks.push(multilingual.contextFor(text));
      const context = [conversationContext(input), isAmbientProfile(profileKey) ? archetypeContext(input) : '', ...blocks].filter(Boolean).join('\n\n');
      const result = await host.reply({key, characterId: ids[profileKey], endUserId, sessionId, scope: 'follow-up-probe', ttsEnabled: false, text, context});
      sessionId = result.sessionID;
      const raw = result.text, processed = emotions.process(speech.process(result)), reply = processed.text;
      const endedQ = endsWithQuestion(reply);
      if (!off) followUp.record(profileKey, reply);
      rows.push({text, reply, offered: decision.offered, reason: decision.reason, words: words(reply), endedQ, pull: hasPull(reply), anyQ: /[?？]/.test(reply),
        ...(withOthers ? {raw} : {})});
      console.log(JSON.stringify({profile: profileKey, n: index + 1, offered: decision.offered, reason: decision.reason, words: words(reply), endedQ}));
    }
    report.profiles[profileKey] = {trait: traitFor(profileKey), summary: summarize(rows), rows};
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
