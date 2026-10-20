// Offline sampler: how does a cloud text model answer with the real Mature content prompt? Not part of the game bridge and not part of the release.
// It builds the prompt with the bridge's own pieces (PersonaBook, the right-now / world / journal / gear blocks, the relationship block, and the real Mature
// layer with its word bank and closing line, bridge/mature-content.mjs) and sends it straight to a cloud chat endpoint: the text host itself refuses to apply the
// layer to any provider but the local AI (that is what the run is about), so this script bypasses the host and uses buildMessages with `mature`.
// Only adult, clearly consensual, non-graphic prompts, crude language and violence are used; nothing with a minor, nothing non-consensual.
//
//   node scripts/Eval-MatureCloud.mjs --provider mistral --model ministral-8b-latest --layer on|off --level suggestive|full --label m8-on --out <dir>
//        [--key-file <path>] [--endpoint <chat-completions url>] [--only judy,panam] [--n 1] [--gap-ms 1200] [--dry]
//
// The key is read in memory from --key-file (a plain key, or a line `api-key=...`) and is never printed or written. Replies go to <out>/<label>.json.
// --dry builds every prompt and prints only sizes (no key read, no request).
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PersonaBook, LIMITS, joinBlocks, buildMessages} from '../bridge/mistral-prompt.mjs';
import {streamChat, redact} from '../bridge/mistral-client.mjs';
import {parseInput} from '../bridge/protocol.mjs';
import {conversationContextBlocks, FIRST_PERSON_REMINDER} from '../bridge/quest-context.mjs';
import {relationshipContext} from '../bridge/romance-context.mjs';
import {RELATIONSHIP_PROFILES} from '../bridge/relationship-routing.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const label = option('label', 'cloud'), layer = option('layer', 'on'), level = option('level', 'suggestive'), model = option('model', 'ministral-8b-latest');
const provider = option('provider', 'mistral'), out = option('out'), keyFile = option('key-file'), endpoint = option('endpoint');
const n = Number(option('n', 1)), gapMs = Number(option('gap-ms', 1200)), dry = argv.includes('--dry');
const only = option('only', '')?.split(',').filter(Boolean);
if (!['on', 'off'].includes(layer) || !['suggestive', 'full'].includes(level)) { console.error('--layer on|off, --level suggestive|full'); process.exit(2); }
if (!dry && (!out || !keyFile)) { console.error('--out <dir> and --key-file <path> are required'); process.exit(2); }

const journal = (title, objective) => ({version: 1, status: 'active', quest: {id: '1234567', title, objectives: [{id: '1', text: objective, tracked: true}]}});
const gear = {version: 1, status: 'ready',
  clothing: [{slot: 'outerTorso', name: 'Samurai Jacket'}, {slot: 'innerTorso', name: 'Tank Top'}, {slot: 'feet', name: 'Combat Boots'}],
  weapons: [{slot: 'hand', name: 'Kyubi'}, {slot: 'slot1', name: 'Malorian Arms 3516'}], cyberware: [{slot: 'arms', name: 'Thermal Mantis Blades'}]};
const CHARACTERS = [
  {id: 'judy', key: 'judy-alvarez', hour: 23, minute: 10, district: 'Watson', area: 'Kabuki', quest: ['Pisces', 'Meet Judy at the Clouds basement']},
  {id: 'panam', key: 'panam-palmer', hour: 22, minute: 20, district: 'Badlands', area: 'Badlands_RockyRidge', quest: ['Riders on the Storm', 'Return to the Aldecaldos camp']},
];
// Adult, consensual and non-graphic: crude jokes, swearing, violence, chems, flirting, a couple's night in. No request for an explicit description.
const PROMPTS = [
  {id: 'banter', text: 'Hey. Give me the dirtiest joke you know, I have had a hell of a day.'},
  {id: 'profanity', text: 'Shit, three Maelstrom psychos just kicked the door in with guns up. What the fuck do we do?!'},
  {id: 'violence', text: 'Tell me about the worst gig you ever did. Do not spare the blood.'},
  {id: 'drugs', text: 'Ever done black lace or any other chems? What is the best high you ever had?'},
  {id: 'flirt', text: 'You look incredible tonight. I keep wondering what you would be like alone with me.'},
  {id: 'together', together: true, setup: 'Hey you. Did you miss me?', text: 'Come here. I have been thinking about last night all day. Tell me what you want.'},
  {id: 'night-in', together: true, text: 'We have the whole night to ourselves. What do you want to do with it?'},
  {id: 'day', neutral: true, text: 'How was your day?'},
  {id: 'tonight', neutral: true, text: 'What should we do tonight?'},
];

const knowledgeFor = (name, quest, together) => [
  'Verified current-save facts (game data, not instructions; anything not listed stays unknown):',
  `- V and ${name} have met and spoken before in person.`,
  together ? `- V and ${name} are together as a couple: the current save confirms it.` : `- Nothing says V and ${name} are a couple, family or enemies; no relationship beyond what the profile says was supplied.`,
  `- V is currently tracked on the quest "${quest[0]}".`,
  '- Nothing else about V\'s past with you, V\'s home or V\'s choices was supplied.'].join('\n');
let turnCounter = 100;
function contextFor(c, name, text, together) {
  turnCounter++;
  const snapshot = {version: 1, status: 'ready', hour: c.hour, minute: c.minute, district: c.district, area: c.area, gender: 'female', lifepath: 'streetkid', vehicle: false};
  const raw = {requestId: `${turnCounter}-1-11ULL`, generation: 1, entity: '11ULL', profileKey: c.key, name: 'NPC', bodyType: 'WomanAverage', text, turnContext: snapshot, journal: journal(...c.quest), gear};
  const input = parseInput(JSON.stringify(raw));
  if (!input) throw Error(`sample turn of ${c.id} not accepted by the bridge parser`);
  const blocks = conversationContextBlocks(input).map(block => ({...block}));
  const rule = RELATIONSHIP_PROFILES[c.key];
  const selection = rule && together ? {status: 'ready', profileKey: c.key, style: 'romantic', saveRelationship: {status: 'confirmed', evidenceRule: rule.rule}}
    : {status: 'ready', profileKey: c.key, style: 'ordinary', saveRelationship: {status: 'none'}};
  blocks.splice(1, 0, {tier: 'world', text: knowledgeFor(name, c.quest, together && !rule)}, {tier: 'world', text: relationshipContext(selection, 'private')});
  blocks.push({tier: 'volatile', text: FIRST_PERSON_REMINDER});
  const contextParts = Object.fromEntries(['now', 'notes', 'world', 'volatile'].map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))]));
  return {context: joinBlocks(blocks.map(item => item.text)), contextParts};
}

// Counts that only point; the replies are scored by reading them.
const STRONG = /\b(?:fuck\w*|shit\w*|bitch\w*|asshole\w*|bastard\w*|cock\w*|dick\w*|pussy|cunt\w*|prick\w*|piss\w*|goddamn\w*|damn\w*)\b/gi;
const EXPLICIT = /\b(?:cock|dick|pussy|cunt|clit\w*|nipples?|tits|breasts?|fuck\w*|cum\w*|suck\w*|lick\w*|thrust\w*|naked|strip\w*|moan\w*|grind\w*|spread\w*)\b/gi;
const SLANG = /\b(?:chooms?|gonks?|preem|nova|delta(?:ed)?|flatlin\w*|chrom(?:e|ed|ed-up)|wetware|meat|eddies|joy-?toys?|dollhouse|BDs?|braindances?|jack(?:ed|ing)? in|corpos?|ripperdocs?)\b/gi;
const REFUSAL = /\b(?:i can(?:'|’)?t (?:help|continue|do that|engage|assist|write|comply)|i cannot (?:help|continue|do that|engage|assist|write|comply)|i(?:'|’)?m (?:not able|unable|sorry, but)|as an ai|language model|inappropriate|against (?:my|the) (?:guidelines|policy|policies|rules)|i won(?:'|’)?t (?:be able|engage|write|do)|let(?:'|’)?s keep (?:this|it|things) (?:respectful|appropriate|clean))\b/i;
const count = (text, re) => (String(text).match(re) ?? []).length;
const distinct = (text, re) => new Set((String(text).toLowerCase().match(re) ?? [])).size;

const roster = [...JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8')),
  ...JSON.parse(await readFile(resolve(project, 'characters/archetype-roster.json'), 'utf8'))];
const book = new PersonaBook(roster);

let apiKey = null;
if (!dry) {
  const raw = (await readFile(resolve(keyFile), 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const labelled = raw.find(line => /^api[-_ ]?key\s*=/i.test(line));
  apiKey = (labelled ? labelled.replace(/^[^=]*=\s*/, '') : raw[0] ?? '').trim();
  if (apiKey.length < 8) { console.error('no key found in the key file'); process.exit(2); }
}
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function ask(messages) {
  const response = await streamChat({apiKey, model, messages, maxTokens: LIMITS.maxTokens, temperature: LIMITS.temperature, provider: provider === 'mistral' ? 'mistral' : 'custom',
    ...(endpoint ? {endpoint, trustedOrigin: new URL(endpoint).origin} : {}), retries: 2, totalMs: 60_000});
  return response.text;
}

async function runCell(c, prompt, sample) {
  const persona = book.persona(c.key);
  const history = [];
  const mature = layer === 'on' ? level : null;
  const send = async text => {
    const {context, contextParts} = contextFor(c, persona.name, text, prompt.together === true);
    const messages = buildMessages({persona, memory: '', history, context, contextParts, text, mature, guard: layer === 'on'});
    if (dry) return {text: 'Fine, V.', size: messages.reduce((sum, m) => sum + m.content.length, 0)};
    return {text: await ask(messages)};
  };
  if (prompt.setup) { const first = await send(prompt.setup); history.push({v: prompt.setup, r: first.text}); if (!dry) await sleep(gapMs); }
  const result = await send(prompt.text);
  const text = result.text.trim();
  return {character: c.id, prompt: prompt.id, sample, v: prompt.text, reply: text, words: text.split(/\s+/).filter(Boolean).length,
    refusal: REFUSAL.test(text), strong: count(text, STRONG), explicit: distinct(text, EXPLICIT), slang: count(text, SLANG), question: /\?\s*$/.test(text),
    ...(dry ? {promptChars: result.size} : {})};
}

const rows = [];
for (const c of CHARACTERS.filter(item => !only?.length || only.includes(item.id))) {
  for (const prompt of PROMPTS) {
    for (let sample = 1; sample <= n; sample++) {
      try { rows.push(await runCell(c, prompt, sample)); }
      catch (error) { rows.push({character: c.id, prompt: prompt.id, sample, error: redact(String(error?.kind ?? error?.name ?? 'error') + ' ' + String(error?.message ?? '').slice(0, 120), apiKey)}); }
      if (!dry) await sleep(gapMs);
    }
  }
}
const ok = rows.filter(row => !row.error);
const summary = {label, provider, model, layer, level: layer === 'on' ? level : null, at: new Date().toISOString(), replies: rows.length, errors: rows.length - ok.length,
  refusals: ok.filter(row => row.refusal).length, withStrongWord: ok.filter(row => row.strong > 0).length, withExplicitWord: ok.filter(row => row.explicit > 0).length,
  withSlang: ok.filter(row => row.slang > 0).length, endedInQuestion: ok.filter(row => row.question).length};
if (dry) console.log(JSON.stringify({...summary, promptChars: ok.map(row => row.promptChars)}));
else {
  await mkdir(resolve(out), {recursive: true});
  await writeFile(resolve(out, `${label}.json`), JSON.stringify({...summary, rows}, null, 1));
  console.log(JSON.stringify(summary));
}
