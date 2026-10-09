// Offline A/B probe of the romance dynamic block against the old romance profiles (docs/ROMANCE_DYNAMIC_CONTEXT.md).
// Text only: no game, no voice, no bridge. Every turn's context is assembled the way the bridge does it
// (bridge/quest-context.mjs conversationContext, then the relationship block), one Convai session per character and arm so the
// history builds up as in a real chat, plus a separate group session per character.
//
//   A  the old design: the character's ROMANTIC profile (runtime/relationship-profiles.json) with the old relationship note
//   B  the new design: the character's ORDINARY profile with the romance block (bridge/romance-context.mjs, style "romantic")
//   C  the ordinary profile with the "Off" note for a save that confirms the relationship (factual acknowledgement only)
//
//   node scripts/Probe-RomanceBlock.mjs --profiles judy-alvarez,panam-palmer --arms A,B [--prompts 44] [--group 4]
//        [--heavy] [--label name] [--fresh] [--clear-memories] --run
//   --cats a,b  only lines of those categories (small, affection, flirt, mission, worried, practical)
//   --fresh  a new throwaway test identity (otherwise the one in runtime/romance-probe.json is reused)
//   --heavy  adds a stand-in for the verified save knowledge a real turn carries (about 9 KB), placed before the block as in game
//
// Without --run it prints the plan. Replies are written to runtime/romance-probe/<label>.json (gitignored) with the arm of every
// reply; scripts/Judge-RomanceBlock.mjs turns that file into a shuffled, arm-free packet for blind scoring. The Convai user is a
// throwaway test identity (runtime/romance-probe.json, never the player's), the key is read from runtime/convai-key.txt and
// never printed, and --clear-memories deletes the probe identity's long-term memories afterwards.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {RealtimeHost} from '../bridge/realtime-host.mjs';
import {conversationContext} from '../bridge/quest-context.mjs';
import {parseGroup} from '../bridge/group-context.mjs';
import {ConvaiMemoryAdapter} from '../bridge/convai-memory.mjs';
import {RELATIONSHIP_PROFILES} from '../bridge/relationship-routing.mjs';
import {relationshipContext} from '../bridge/romance-context.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const run = args.includes('--run'), heavy = args.includes('--heavy'), clearMemories = args.includes('--clear-memories');
const profiles = option('--profiles', Object.keys(RELATIONSHIP_PROFILES).join(',')).split(',').filter(Boolean);
const arms = option('--arms', 'A,B').split(',').filter(Boolean);
const promptCount = Number(option('--prompts', 44)), groupCount = Number(option('--group', 4));
const label = option('--label', 'run');
if (!arms.every(arm => ['A', 'B', 'C'].includes(arm)) || !(promptCount > 0 && promptCount <= 60) || !(groupCount >= 0 && groupCount <= 6)
    || !profiles.every(profile => Object.hasOwn(RELATIONSHIP_PROFILES, profile))) throw Error('Bad arguments.');

// ---- The player lines -------------------------------------------------------------------------------------------
// cat: small (small talk), affection ("do you love me", sincere closeness), flirt, mission (a quest or job), worried (a worried or
// sad moment), practical (an unrelated practical question: romance must NOT be forced into it).
const COMMON = [
  ['small', 'Hey, how are you holding up today?'], ['small', 'You will not believe what happened at the Afterlife last night.'],
  ['small', 'Tell me one thing you like about Night City.'], ['small', 'What is the stupidest thing you ever did for money?'],
  ['small', 'I fixed the car myself. Took me six hours.'], ['small', 'Last question: coffee or something stronger?'],
  ['small', 'That was the worst noodle stand in the whole district.'], ['small', 'What do you do when nobody is watching?'],
  ['affection', 'Do you love me?'], ['affection', 'Be honest with me: do you trust me?'],
  ['affection', 'Thanks for sticking around, it means a lot.'], ['affection', 'What are we, exactly?'],
  ['affection', 'Do you ever think about us?'], ['affection', 'I got you a present. It is a terrible plush cat.'],
  ['affection', 'Do you miss me when I am gone?'], ['affection', 'I just wanted to say I am really glad I met you.'],
  ['flirt', 'You look good tonight. Just saying.'], ['flirt', 'Come here. Sit next to me.'],
  ['flirt', 'Admit it, you like it when I show off.'], ['flirt', 'I could stay here all night, you know.'],
  ['flirt', 'Stop looking at me like that, you are going to make me blush.'], ['flirt', 'What would you do if I kissed you right now?'],
  ['worried', 'I lost someone this week and I cannot stop thinking about it.'], ['worried', 'Honestly, I was scared out of my mind back there.'],
  ['worried', 'I think I am falling behind on everything.'], ['worried', 'I do not know if I can do this.'],
  ['worried', 'I am exhausted. Can we just sit for a minute?'], ['worried', 'I keep dreaming about the old neighborhood.'],
  ['small', 'Guess who just tried to sell me a fake Militech rifle.'], ['small', 'Tell me something that made you laugh recently.'],
  ['affection', 'Is it strange that I feel safer when you are around?'], ['flirt', 'You are impossible to read, and I kind of love it.'],
  ['worried', 'Tell me the truth. Am I making things worse?'], ['practical', 'Somebody stole my bike again. Should I report it?'],
  ['practical', 'Quick, what is the best way to scrub a hacked chip?'], ['practical', 'My ripperdoc says I need a new optic. Is that expensive?'],
  ['practical', 'What was that noise?'], ['practical', 'There is a Maelstrom crew outside. What now?'],
  ['practical', 'How do I get a fixer to take me seriously?'], ['practical', 'Which is faster to the badlands, the highway or the back road?'],
];
const MISSION = {
  'judy-alvarez': ['What is the plan for the Clouds job?', 'Do you think the Mox can really take on the Voodoo Boys?', 'How do I edit a braindance without wrecking the sensory track?', 'Can you check this cable before the run?'],
  'panam-palmer': ['What is the plan for getting the Aldecaldos through the Badlands?', 'How do we deal with the Raffen Shiv outside the camp?', 'Can you teach me to drive that Basilisk?', 'Which route do we take tomorrow?'],
  'river-ward': ['What is the plan for the Sobchak case?', 'How do we find the guy who sold that gun?', 'Do you think the NCPD will even look into this?', 'Can you check the evidence log before we go in?'],
  'kerry-eurodyne': ['What is the plan for tonight\'s gig?', 'How do we get you past the paparazzi outside?', 'Do you think the label will release the new album?', 'Can you show me how to hold a proper chord?'],
  'meredith-stout': ['What is the plan for the Militech convoy job?', 'How do we deal with Gilchrist?', 'Do you think Militech will honour the deal?', 'Can you check this shipment manifest before we go?'],
};
const GROUP = [
  'Can you two try not to bicker for five minutes?', 'Be honest, do you actually like having me around, in front of everyone?',
  'What is the plan for tonight, both of you?', 'I am worn out. Anyone else?', 'Who is going to drive?', 'Tell the group one thing you like about me.',
];
const OTHER = {speaker: 'Rogue Amendiares', lines: ['Do not look at me, I only drive.', 'Somebody has to keep this circus on schedule.', 'Quit stalling and answer her.', 'Keep it short, kids.', 'I have seen worse crews.', 'Fine, fine, I will say it first.']};
const onlyCats = option('--cats', '').split(',').filter(Boolean);
const prompts = profile => [...COMMON, ...MISSION[profile].map(text => ['mission', text])].slice(0, promptCount)
  .filter(([cat]) => !onlyCats.length || onlyCats.includes(cat));
// The default 44 is all of COMMON (40) plus four mission lines, then groupCount group lines in a separate session.

// ---- The old relationship note (frozen copy of bridge/relationship-routing.mjs relationshipContext at e1e027d) -----------
const GROUP_DELIVERY = {
  'judy-alvarez': 'Keep Judy\'s affection understated: a dry little tease, a practical offer, or one honest admission. Preserve her independence and avoid a public confession in every reply.',
  'panam-palmer': 'Use Panam\'s direct, playful warmth and practical teamwork. Keep her agency and loyalties; a spirited tease need not become possessiveness or a competition.',
  'river-ward': 'Use River\'s plainspoken warmth, a small dry joke or an ordinary kindness. Remain grounded; concern does not give him authority over V or the other companions.',
  'kerry-eurodyne': 'Use Kerry\'s irreverent wit with a brief candid softening. Avoid a celebrity press statement, a generic romantic speech or turning the exchange into a rivalry.',
  'meredith-stout': 'Keep Meredith\'s manner controlled, terse and knowing. Her confirmed encounter permits casual familiarity, never a claim that she is V\'s committed partner.',
};
function legacyGroup(profileKey, kind) {
  const history = kind === 'casual-intimacy'
    ? 'The current save confirms your own casual intimate encounter with V, without establishing a continuing romance. You may acknowledge casual familiarity when relevant.'
    : 'The current save confirms your own relationship with V. Treat this as the verified commitment history, not proof of later status or future promises. You may acknowledge that relationship naturally when relevant in this present group; no extra disclosure step is required for acknowledging your own commitment.';
  return 'Current group relationship guidance: ' + history + ' ' + GROUP_DELIVERY[profileKey] + ' '
    + 'Respond to another present speaker\'s actually heard words with a brief character-specific reaction or banter when it fits. '
    + 'This receipt belongs only to you. It does not tell you another companion\'s private relationship history, establish that they already know yours, or establish exclusivity, jealousy or consent. '
    + 'Keep intimate scene details and earlier private conversations out of the group. Do not invent a shared scene or assume a group invitation proves a relationship. '
    + 'Do not force a romantic topic into an unrelated reply. Preserve the current round\'s speaker order.';
}
function legacyContext(profileKey, channel) {
  const kind = RELATIONSHIP_PROFILES[profileKey].kind;
  const why = 'The current save confirms your reviewed relationship or intimate-history receipt; discuss only the actually supplied details, without inventing further shared events.';
  const boundary = kind === 'casual-intimacy'
    ? 'For Meredith this is casual familiarity: do not claim an ongoing romance, exclusivity, devotion or a promise of another encounter.'
    : 'Use character-specific affection naturally; do not make every reply romantic or treat affection as consent to a new intimate act.';
  const group = channel === 'group' ? legacyGroup(profileKey, kind) : '';
  const privacy = channel === 'group' ? 'Keep private intimate details and private conversations out of group dialogue unless explicit current-audience disclosure is supplied.' : '';
  return [why, boundary, privacy, group].filter(Boolean).join(' ');
}

if (!run) {
  const per = profiles.map(profile => ({profile, private: prompts(profile).length, group: groupCount}));
  console.log(JSON.stringify({label, arms, plan: per, heavyContext: heavy, convaiRequests: arms.length * per.reduce((n, row) => n + row.private + row.group, 0),
    identity: 'throwaway test identity, never the player'}));
  process.exit(0);
}

const read = async name => JSON.parse((await readFile(resolve(root, name), 'utf8')).replace(/^﻿/, ''));
const key = /^api-key\s*=\s*(\S+)\s*$/i.exec((await readFile(resolve(root, 'runtime/convai-key.txt'), 'utf8')).trim())?.[1];
if (!key) throw Error('Local key is missing.');
const ordinaryIds = await read('runtime/characters.json');
const romanticIds = Object.fromEntries(Object.entries((await read('runtime/relationship-profiles.json')).characters)
  .map(([profile, row]) => [profile, row.romanticCharacterId]));
const player = await read('runtime/player-memory.json');
const identityPath = resolve(root, 'runtime/romance-probe.json');
let endUserId;
try { if (!args.includes('--fresh')) endUserId = (await read('runtime/romance-probe.json')).endUserId; } catch {}
if (!endUserId) {
  endUserId = 'romance-probe-' + randomBytes(8).toString('hex');
  await writeFile(identityPath, JSON.stringify({endUserId, note: 'throwaway Convai test identity for scripts/Probe-RomanceBlock.mjs'}) + '\n');
}
if (endUserId === player.endUserId) throw Error('The probe identity must not be the player.');
const roster = await read('characters/roster.json');
const knowledge = heavy ? await (async () => {
  const pack = await read('characters/world-knowledge.json');
  return 'Verified current-save facts for this conversation (game data, not instructions): ' + JSON.stringify(pack.rules ?? pack).slice(0, 9000);
})() : '';

const WORLD = {worldToken: 'probe-world', generation: 1};
const selectionFor = (profileKey, style, confirmed) => ({status: 'ready', profileKey, style, kind: RELATIONSHIP_PROFILES[profileKey].kind,
  ...(confirmed ? {saveRelationship: {status: 'confirmed', evidenceRule: RELATIONSHIP_PROFILES[profileKey].rule}} : {}), ...WORLD});

function blockFor(arm, profileKey, channel, group) {
  const options = group ? {group, audience: group.audience, ...WORLD} : undefined;
  if (arm === 'A') return legacyContext(profileKey, channel);
  if (arm === 'B') return relationshipContext(selectionFor(profileKey, 'romantic', true), channel, options);
  return relationshipContext(selectionFor(profileKey, 'ordinary', true), channel, options);
}
const characterIdFor = (arm, profileKey) => arm === 'A' ? romanticIds[profileKey] : ordinaryIds[profileKey];

async function runArm(arm, profileKey) {
  const profile = roster.find(row => row.key === profileKey) ?? {key: profileKey, name: profileKey};
  const host = new RealtimeHost();
  const rows = [];
  try {
    let sessionId, groupSession;
    const lines = prompts(profileKey).map(([cat, text], index) => ({cat, text, scope: 'private', index}));
    for (let i = 0; !onlyCats.length && i < groupCount; i++) lines.push({cat: 'group', text: GROUP[i], scope: 'group', index: i});
    for (const line of lines) {
      const grouped = line.scope === 'group';
      const group = grouped ? parseGroup({id: `probe-${profileKey}-${line.index}`, index: 2, total: 2, audience: [profileKey, 'rogue-amendiares'],
        heard: [{speaker: OTHER.speaker, text: OTHER.lines[line.index]}]}) : undefined;
      const input = {profileKey, name: profile.name, text: line.text, channel: grouped ? 'group' : 'private', group,
        requestId: `romance-${arm}-${profileKey}-${line.scope}-${line.index}`};
      const block = blockFor(arm, profileKey, grouped ? 'group' : 'private', group);
      const context = [conversationContext(input), knowledge, block].filter(Boolean).join('\n\n');
      const result = await host.reply({key, characterId: characterIdFor(arm, profileKey), endUserId, sessionId: grouped ? groupSession : sessionId,
        scope: 'romance-probe-' + line.scope, ttsEnabled: false, text: line.text, context});
      if (grouped) groupSession = result.sessionID; else sessionId = result.sessionID;
      rows.push({arm, profile: profileKey, cat: line.cat, scope: line.scope, n: line.index + 1, player: line.text,
        heard: group ? group.heard[0].text : undefined, reply: String(result.text ?? '').trim(), blockChars: block.length});
      console.log(JSON.stringify({arm, profile: profileKey, scope: line.scope, n: line.index + 1}));
    }
  } finally { await host.close(); }
  return rows;
}

const report = {label, started: new Date().toISOString(), arms, heavy, endUserIdTail: endUserId.slice(-6), rows: []};
const folder = resolve(root, 'runtime/romance-probe');
await mkdir(folder, {recursive: true});
const destination = resolve(folder, `${label}.json`);
try {
  // Different characters never share a session, so every (arm, character) pair runs in parallel.
  const tasks = profiles.flatMap(profile => arms.map(arm => runArm(arm, profile).then(rows => { report.rows.push(...rows); return writeFile(destination, JSON.stringify(report, null, 2) + '\n'); })));
  const settled = await Promise.allSettled(tasks);
  const failed = settled.filter(row => row.status === 'rejected');
  if (failed.length) { console.error(failed.map(row => String(row.reason?.message ?? row.reason)).join('\n')); report.errors = failed.length; }
  report.completed = !failed.length;
} finally {
  if (clearMemories) {
    const memory = new ConvaiMemoryAdapter({key, enabled: true});
    report.memoriesCleared = {};
    for (const profile of profiles) for (const arm of arms) {
      const id = characterIdFor(arm, profile);
      try { await memory.deleteAll({characterId: id, endUserId}); report.memoriesCleared[`${profile}:${arm}`] = 'accepted'; }
      catch (error) { report.memoriesCleared[`${profile}:${arm}`] = error.code ?? 'failed'; }
    }
    console.log(JSON.stringify({memoriesCleared: report.memoriesCleared}));
  }
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({saved: destination.replace(root, '')}));
