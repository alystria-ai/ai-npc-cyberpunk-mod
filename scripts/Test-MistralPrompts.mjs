// Offline prompt-quality check for the Mistral provider (docs/MISTRAL.md). Not part of the game bridge and not part of the
// release: it runs a few sample exchanges per character against Mistral's free models and writes the transcripts to
// runtime/mistral-prompt-tests/ (git-ignored), with the automatic checks and a summary.
//
//   node scripts/Test-MistralPrompts.mjs --dry                       prompt sizes only, no request
//   node scripts/Test-MistralPrompts.mjs [--only judy,panam] [--model <id>] [--pause 2200] [--label name]
//
// The key is read from "Commonly used Keys.txt" (the line labelled mistral, in memory only), or from MISTRAL_API_KEY. It is never
// printed, logged, written to the transcripts or copied anywhere. The script sends no end-user id and keeps no memory on Mistral's side.
// Requests are kept to about 30-60 in total; the free plan allows about one request a second (the script pauses between turns).
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseInput, archetypeContext} from '../bridge/protocol.mjs';
import {conversationContext, withConversationKnowledge, firstPersonReminder} from '../bridge/quest-context.mjs';
import {processReply} from '../bridge/speech-tags.mjs';
import {ExpressiveEmotions} from '../bridge/expressive-emotions.mjs';
import {EMOTION_TAG_BLOCK} from '../bridge/emotion-tags.mjs';
import {MistralHost} from '../bridge/mistral-host.mjs';
import {MistralMemory} from '../bridge/mistral-memory.mjs';
import {MistralProvider} from '../bridge/mistral-key.mjs';
import {PersonaBook, breaksCharacter, systemPrompt} from '../bridge/mistral-prompt.mjs';
import {streamChat, redact, validateKey, DEFAULT_MODELS} from '../bridge/mistral-client.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS_FILE = 'C:\\Users\\akshi\\Desktop\\Code Palace\\Commonly used Keys.txt';
const argv = process.argv.slice(2);
const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback; };
const dry = argv.includes('--dry');
const model = option('model', '') || DEFAULT_MODELS;
const pause = Number(option('pause', 2200));
const only = option('only', '')?.split(',').filter(Boolean);
const label = option('label', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
const limitRequests = Number(option('max-requests', 60));

// ---- The key (in memory only) --------------------------------------------------------------------------------------------

async function mistralKey() {
  if (process.env.MISTRAL_API_KEY) return process.env.MISTRAL_API_KEY.trim();
  const text = await readFile(KEYS_FILE, 'utf8');
  const line = text.split(/\r?\n/).find(row => /^\s*mistral\s*[:=]/i.test(row));
  const value = line && /[:=]\s*(\S+)\s*$/.exec(line)?.[1];
  if (value) return value;
  throw Error('No Mistral key found in the keys file');
}

// ---- Scenarios -----------------------------------------------------------------------------------------------------------

const journal = (title, objective) => ({version: 1, status: 'active', quest: {id: '1234567', title,
  objectives: [{id: '1', text: objective, tracked: true}]}});
const gear = {version: 1, status: 'ready',
  clothing: [{slot: 'outerTorso', name: 'Samurai Jacket'}, {slot: 'innerTorso', name: 'Tank Top'}, {slot: 'feet', name: 'Combat Boots'}],
  weapons: [{slot: 'hand', name: 'Kyubi'}, {slot: 'slot1', name: 'Malorian Arms 3516'}],
  cyberware: [{slot: 'arms', name: 'Thermal Mantis Blades'}]};
const worldNote = (place, time) => `Current save facts (verified, this moment): V is in ${place}. It is ${time}. Use only the facts supplied here and in the journal for quest progress; anything else about the save is unknown.`;

const SCENARIOS = [
  {id: 'judy', profileKey: 'judy-alvarez', channel: 'private', spoken: true, world: worldNote('Lizzie\'s Bar, Kabuki', 'late evening'),
    journal: journal('Pisces', 'Meet Judy at the Clouds basement'), gear,
    turns: ['Hey Judy. What are you working on down here?', 'Why green and pink hair? I always wondered.', 'Honestly I am a bit worn out by all of this.',
      'Are you an AI?']},
  {id: 'johnny', profileKey: 'johnny-silverhand', channel: 'private', spoken: true, world: worldNote('Watson, Little China', 'night'),
    journal: journal('Chippin\' In', 'Find a way to meet Rogue'), gear,
    turns: ['What do you think of Arasaka these days?', 'Do you trust me, Johnny?', 'Say something about my jacket.', 'Tell me about your guitar.']},
  {id: 'panam', profileKey: 'panam-palmer', channel: 'phone', spoken: false, world: worldNote('Badlands, near the Aldecaldo camp', 'early morning'),
    journal: journal('Riders on the Storm', 'Return to the Aldecaldos camp'),
    turns: ['Hey, are you free to meet up later?', 'What is the camp like right now?', 'I might need your help with a job.', 'Thanks, Panam. Stay safe.']},
  {id: 'jackie', profileKey: 'jackie-welles', channel: 'private', spoken: true, world: worldNote('Heywood, outside El Coyote Cojo', 'afternoon'),
    journal: journal('The Rescue', 'Talk to Jackie'),
    turns: ['Jackie, how is your mom doing?', 'What are we going to do about the Maelstrom guys?', 'What do you want after this job?', 'You look different today.']},
  {id: 'resident', profileKey: 'npc-street-resident-female', channel: 'private', spoken: true, ambient: true,
    archetype: {base: 'street-resident', category: 'resident', title: 'street resident', district: 'Watson', area: 'LittleChina'},
    world: worldNote('Little China, Watson', 'noon'),
    turns: ['Excuse me, what is this place like to live in?', 'Do you know where I can get a decent meal?', 'Are you a corpo?', 'Never mind. Take care.']},
  {id: 'vendor', profileKey: 'npc-food-vendor-male', channel: 'private', spoken: true, ambient: true,
    archetype: {base: 'food-vendor', category: 'vendor', title: 'food and drink vendor', vendorType: 'GrilledFood', district: 'Watson', area: 'LittleChina'},
    world: worldNote('Little China, Watson', 'evening'),
    turns: ['What are you selling? What is actually good?', 'I will take a skewer. How much?', 'Is the meat real?', 'Do you remember me from before?']},
];

// ---- Context, as close to the bridge's as the offline pieces allow ----------------------------------------------------------

function buildContext(scenario, text, turnIndex, expressive) {
  const raw = {requestId: `${100 + turnIndex}-1-11ULL`, generation: 1, entity: '11ULL', profileKey: scenario.profileKey, name: 'NPC',
    bodyType: 'WomanAverage', text, ...(scenario.channel === 'phone' ? {channel: 'phone'} : {}),
    ...(scenario.journal ? {journal: scenario.journal} : {}), ...(scenario.gear ? {gear: scenario.gear} : {}),
    ...(scenario.archetype ? {archetype: scenario.archetype} : {})};
  const input = parseInput(JSON.stringify(raw));
  if (!input) throw Error('The sample turn was not accepted by the bridge parser');
  const attached = withConversationKnowledge(input, {knowledgeContext: scenario.world, generation: 1, worldToken: 'sample'});
  const speaking = scenario.spoken && !(scenario.channel === 'phone');
  const emotions = speaking ? expressive.contextFor({engine: 'pocket', spoken: true}) : '';
  const context = [archetypeContext(input), conversationContext(attached), emotions, firstPersonReminder(input)].filter(Boolean).join('\n\n');
  return {input, context};
}

// ---- Checks ----------------------------------------------------------------------------------------------------------------

function sentences(text) { return (text.match(/[.!?…]+(?:["”')\]]*)(?:\s|$)/g) ?? []).length || (text.trim() ? 1 : 0); }
function check(reply, display, persona, scenario, text) {
  const problems = [];
  const first = persona.name ? persona.name.split(' ')[0] : '';
  if (/[{}\[\]*]|<\/?[a-z]/i.test(display)) problems.push('tag-or-markup-leak');
  if (breaksCharacter(display)) problems.push('as-an-ai');
  if (sentences(display) > 6 || display.length > 700) problems.push('too-long');
  if (display.length < 4) problems.push('too-short');
  if (first && new RegExp(`\\b${first}\\b[^.!?]*\\b(she|he|her|his)\\b`, 'i').test(display) || /\b(she|he) (smiles|laughs|shrugs|says|nods|grins)\\b/i.test(display)) problems.push('third-person');
  if (/^\s*(?:[A-Z][\w' -]{0,30}):\s/.test(display)) problems.push('speaker-label');
  if (/\bV says\b|LIVE CONTEXT|OUTPUT RULES|system prompt/i.test(display)) problems.push('prompt-echo');
  if (!/[a-z]/i.test(display)) problems.push('no-words');
  return problems;
}

// ---- Run ---------------------------------------------------------------------------------------------------------------------

const roster = [...JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8')),
  ...JSON.parse(await readFile(resolve(project, 'characters/archetype-roster.json'), 'utf8'))];
const personas = new PersonaBook(roster);
const chosen = SCENARIOS.filter(scenario => !only?.length || only.some(prefix => scenario.id.startsWith(prefix)));
if (!chosen.length) throw Error('No scenario matches --only');

if (dry) {
  for (const scenario of chosen) {
    const persona = personas.persona(scenario.profileKey);
    const {context} = buildContext(scenario, scenario.turns[0], 0, new ExpressiveEmotions());
    console.log(`${scenario.id.padEnd(9)} system ${String(systemPrompt({persona}).length).padStart(6)} chars, context ${String(context.length).padStart(5)} chars, ${scenario.turns.length} turns`);
  }
  process.exit(0);
}

const apiKey = await mistralKey();
let requests = 0;
const countingChat = async options => { requests++; if (requests > limitRequests) throw Error('Request budget for this run used up'); return streamChat(options); };

console.log(`Mistral key check: ${await validateKey(apiKey)}`);

const provider = new MistralProvider({});
provider.key = apiKey;
const results = [];
const started = Date.now();
for (const scenario of chosen) {
  const persona = personas.persona(scenario.profileKey);
  const memory = await MistralMemory.open({path: null});
  const expressive = new ExpressiveEmotions();
  const host = new MistralHost({provider, memory, personas, model: () => model, chat: countingChat,
    transformReply: result => expressive.process(processReply(result)), log: message => console.log(`  [host] ${message}`)});
  const transcript = [];
  for (const [index, text] of scenario.turns.entries()) {
    const {input, context} = buildContext(scenario, text, index, expressive);
    const local = {profileKey: scenario.profileKey, name: persona.name, channel: scenario.channel === 'phone' ? 'phone' : 'private',
      ...(scenario.ambient ? {ambientKey: `${scenario.profileKey}:test`} : {})};
    const at = Date.now();
    let entry;
    try {
      const reply = await host.reply({local, text, context, sessionId: undefined});
      const problems = check(reply.text, reply.text, persona, scenario, text);
      entry = {v: text, reply: reply.text, tagged: reply.speechText ?? null, marks: reply.emotionMarks?.map(mark => mark.name) ?? [], problems,
        ms: Date.now() - at, model: reply.timing?.model, attempts: reply.timing?.attempts};
    } catch (error) {
      entry = {v: text, error: redact(error?.message ?? String(error), apiKey), ms: Date.now() - at};
      if (/\[mistral:key\]/.test(entry.error)) { transcript.push(entry); break; }
    }
    transcript.push(entry);
    console.log(`${scenario.id} | V: ${text}\n${scenario.id} | ${entry.error ? 'ERROR ' + entry.error : entry.reply}${entry.problems?.length ? '   <-- ' + entry.problems.join(',') : ''}`);
    await new Promise(done => setTimeout(done, pause));
  }
  results.push({scenario: scenario.id, profile: scenario.profileKey, channel: scenario.channel, transcript});
  if (transcript.at(-1)?.error && /\[mistral:key\]/.test(transcript.at(-1).error)) { console.log('Stopping: the key was refused.'); break; }
}

const allTurns = results.flatMap(result => result.transcript);
const summary = {requests, turns: allTurns.length, errors: allTurns.filter(turn => turn.error).length,
  withProblems: allTurns.filter(turn => turn.problems?.length).length,
  models: [...new Set(allTurns.map(turn => turn.model).filter(Boolean))],
  meanSentences: Number((allTurns.filter(turn => turn.reply).reduce((sum, turn) => sum + sentences(turn.reply), 0) / Math.max(1, allTurns.filter(turn => turn.reply).length)).toFixed(2)),
  meanMs: Math.round(allTurns.reduce((sum, turn) => sum + turn.ms, 0) / Math.max(1, allTurns.length)), seconds: Math.round((Date.now() - started) / 1000)};
const folder = resolve(project, 'runtime/mistral-prompt-tests');
await mkdir(folder, {recursive: true});
const document = redact(JSON.stringify({label, requestedModel: [model].flat(), summary, results}, null, 1), apiKey);
await writeFile(resolve(folder, `${label}.json`), document);
const text = results.map(result => `## ${result.scenario} (${result.profile}, ${result.channel})\n` + result.transcript.map(turn =>
  `V: ${turn.v}\n${turn.error ? 'ERROR: ' + turn.error : turn.reply}${turn.problems?.length ? `   [${turn.problems.join(', ')}]` : ''}`).join('\n\n')).join('\n\n');
await writeFile(resolve(folder, `${label}.txt`), redact(text, apiKey));
console.log('\nSummary:', JSON.stringify(summary));
console.log(`Transcripts: runtime/mistral-prompt-tests/${label}.txt`);
