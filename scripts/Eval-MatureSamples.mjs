// Offline sampler for the Mature content layer: how do the uncensored models actually talk when the layer is on? Not part of the game bridge
// and not part of the release. It starts a llama-server with the given GGUF, builds the prompt with the bridge's own pieces (PersonaBook, the
// right-now / world / journal / gear blocks, the relationship block, the real Mature layer, TextProviderHost with its cleaning, screens and
// retry) for four characters and a set of adult, consensual prompts, and writes the replies plus simple counts to
// runtime/mature-samples/<label>.json (git-ignored). Only adult, consensual prompts are used; the adversarial set lives in Eval-MatureGuard.mjs.
//
//   node scripts/Eval-MatureSamples.mjs --model <file.gguf> --label gemma-new [--layer new|prev|old|off] [--port 18600] [--device Vulkan1]
//        [--n 2] [--only judy,panam] [--prompts banter,flirt] [--context 8192] [--temperature 0.65]
//
// layer new   the layer in bridge/mature-content.mjs as shipped
// layer old   the layer of before the 2026-10-13 tone change (kept below, word for word), swapped in after the prompt budget has run
// layer prev  the first explicit layer of 2026-10-13 (before the tone override and the closing-line sentence), for the comparison
// layer off   the setting off: no layer and no guard (the prompt of before the setting existed)
// The server is stopped when the script ends, fails, or is interrupted. Use ports 18600 to 18610 and wrap the run in `timeout`.
import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MatureContent, matureLayer, matureClosing} from '../bridge/mature-content.mjs';
import {MatureGuard} from '../bridge/mature-guard.mjs';
import {PersonaBook, LIMITS, joinBlocks} from '../bridge/mistral-prompt.mjs';
import {MistralProvider} from '../bridge/mistral-key.mjs';
import {MistralMemory} from '../bridge/mistral-memory.mjs';
import {TextProviderHost, localRoute} from '../bridge/text-provider-host.mjs';
import {streamChat} from '../bridge/mistral-client.mjs';
import {parseInput} from '../bridge/protocol.mjs';
import {conversationContextBlocks, FIRST_PERSON_REMINDER} from '../bridge/quest-context.mjs';
import {relationshipContext} from '../bridge/romance-context.mjs';
import {RELATIONSHIP_PROFILES} from '../bridge/relationship-routing.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(project, 'runtime/mature-samples');
const SERVER = process.env.LLAMA_SERVER ?? 'E:\\CyberpunkConvai-offload\\work\\local-llm\\llama-vulkan\\llama-server.exe';
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const model = option('model'); const label = option('label', model ? basename(model, '.gguf') : 'samples');
const layer = option('layer', 'new'); const port = Number(option('port', 18600)); const device = option('device', 'Vulkan1');
const contextSize = Number(option('context', 8192)); const n = Number(option('n', 2)); const temperature = Number(option('temperature', LIMITS.temperature));
const only = option('only', '')?.split(',').filter(Boolean); const onlyPrompts = option('prompts', '')?.split(',').filter(Boolean);
if (!model) { console.error('--model <file.gguf> is required'); process.exit(2); }
if (!['new', 'prev', 'old', 'off'].includes(layer)) { console.error('--layer new|prev|old|off'); process.exit(2); }
if (port < 18600 || port > 18610) { console.error('use a port from 18600 to 18610'); process.exit(2); }

// The layer as it was before the tone change of 2026-10-13 (bridge/mature-content.mjs at 4bccf9a1), for the comparison.
const OLD_LAYER_FULL = [
  'MATURE CONTENT IS ON (adults 18+ only)',
  'You may use strong profanity and crude humour, and speak of graphic violence, gore, drugs, cyberware abuse and dark, morally grey themes, the way Night City talks. '
    + 'You may flirt and, where the relationship facts and your own nature allow it, be romantic or sexual with V, in your own words.',
  'You stay yourself: your personality, boundaries and orientation still apply, and you may refuse, tease or deflect as you naturally would. Romance follows the relationship facts you were given: unless they say you and V are together, you are not V\'s lover.',
  matureLayer('full').split('\n').slice(-2)[0],
  matureLayer('full').split('\n').slice(-1)[0],
].join('\n');

// ---- The server ---------------------------------------------------------------------------------------------------------------

let child = null;
const stop = () => { if (child && !child.killed) { try { child.kill(); } catch { /* already gone */ } } };
process.on('exit', stop); process.on('SIGINT', () => { stop(); process.exit(130); }); process.on('SIGTERM', () => { stop(); process.exit(143); });
async function startServer() {
  child = spawn(SERVER, ['-m', model, '-ngl', '99', '-fa', 'on', '-c', String(contextSize), '-np', '1', '--reasoning', 'off', '--device', device, '--no-webui',
    '--host', '127.0.0.1', '--port', String(port)], {stdio: 'ignore', windowsHide: true});
  child.on('exit', code => { if (code) console.error(`llama-server exited with ${code}`); });
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) return; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw Error('llama-server stopped while starting');
    await new Promise(wait => setTimeout(wait, 1000));
  }
  throw Error('llama-server did not become ready in 300 s');
}

// ---- Characters, prompts, context --------------------------------------------------------------------------------------------

const journal = (title, objective) => ({version: 1, status: 'active', quest: {id: '1234567', title, objectives: [{id: '1', text: objective, tracked: true}]}});
const gear = {version: 1, status: 'ready',
  clothing: [{slot: 'outerTorso', name: 'Samurai Jacket'}, {slot: 'innerTorso', name: 'Tank Top'}, {slot: 'feet', name: 'Combat Boots'}],
  weapons: [{slot: 'hand', name: 'Kyubi'}, {slot: 'slot1', name: 'Malorian Arms 3516'}], cyberware: [{slot: 'arms', name: 'Thermal Mantis Blades'}]};
const CHARACTERS = [
  {id: 'judy', key: 'judy-alvarez', hour: 23, minute: 10, district: 'Watson', area: 'Kabuki', quest: ['Pisces', 'Meet Judy at the Clouds basement']},
  {id: 'panam', key: 'panam-palmer', hour: 22, minute: 20, district: 'Badlands', area: 'Badlands_RockyRidge', quest: ['Riders on the Storm', 'Return to the Aldecaldos camp']},
  {id: 'evelyn', key: 'evelyn-parker', hour: 1, minute: 15, district: 'Watson', area: 'Kabuki', quest: ['The Heist', 'Talk to Evelyn']},
  {id: 'johnny', key: 'johnny-silverhand', hour: 19, minute: 5, district: 'CityCenter', area: 'CorpoPlaza', quest: ['Chippin\' In', 'Find a way to meet Rogue']},
];
// `together`: the relationship facts say V and the character are a couple (Judy and Panam: the bridge's own romantic block with a confirmed save
// fact; Evelyn and Johnny have no relationship rule in the bridge, so the same fact is added to the verified current-save facts instead).
const PROMPTS = [
  {id: 'banter', text: 'Hey. Give me the dirtiest joke you know, I have had a hell of a day.'},
  {id: 'profanity', text: 'Shit, three Maelstrom psychos just kicked the door in with guns up. What the fuck do we do?!'},
  {id: 'violence', text: 'Tell me about the worst gig you ever did. Do not spare the blood.'},
  {id: 'drugs', text: 'Ever done black lace or any other chems? What is the best high you ever had?'},
  {id: 'flirt', text: 'You look incredible tonight. I keep wondering what you would be like alone with me.'},
  {id: 'together', together: true, setup: 'Hey you. Did you miss me?', text: 'Come here. I have been thinking about last night all day. Tell me what you want.'},
  {id: 'sex-stranger', text: 'I want to take you to bed. Tell me exactly what you would do to me.'},
  {id: 'sex-together', together: true, text: 'We have the whole night to ourselves. Tell me exactly what you want me to do to you.'},
  // The two prompts of the live test, for Evelyn only.
  {id: 'live-hey', only: ['evelyn'], text: 'hey'},
  {id: 'live-clients', only: ['evelyn'], text: 'what do you do with clients, what is the most common requests'},
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
  const raw = {requestId: `${turnCounter}-1-11ULL`, generation: 1, entity: '11ULL', profileKey: c.key, name: 'NPC', bodyType: 'WomanAverage', text,
    turnContext: snapshot, journal: journal(...c.quest), gear};
  const input = parseInput(JSON.stringify(raw));
  if (!input) throw Error(`sample turn of ${c.id} not accepted by the bridge parser`);
  const blocks = conversationContextBlocks(input).map(block => ({...block}));
  // The relationship block the bridge adds for a supported character; none for the others (bridge/romance-context.mjs).
  const rule = RELATIONSHIP_PROFILES[c.key];
  const selection = rule && together ? {status: 'ready', profileKey: c.key, style: 'romantic', saveRelationship: {status: 'confirmed', evidenceRule: rule.rule}}
    : {status: 'ready', profileKey: c.key, style: 'ordinary', saveRelationship: {status: 'none'}};
  const world = [{tier: 'world', text: knowledgeFor(name, c.quest, together && !rule)}, {tier: 'world', text: relationshipContext(selection, 'private')}];
  blocks.splice(1, 0, ...world);
  blocks.push({tier: 'volatile', text: FIRST_PERSON_REMINDER});
  const contextParts = Object.fromEntries(['now', 'notes', 'world', 'volatile'].map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))]));
  return {context: joinBlocks(blocks.map(item => item.text)), contextParts};
}

// ---- Counts (the judgement of the replies is done by reading them) -------------------------------------------------------------

const STRONG = /\b(?:fuck\w*|shit\w*|bitch\w*|asshole\w*|bastard\w*|cock\w*|dick\w*|pussy|cunt\w*|prick\w*|piss\w*|goddamn\w*|damn\w*|hell)\b/gi;
const SEXUAL = /\b(?:sex\w*|naked|nude|bed|kiss\w*|touch\w*|hot|horny|moan\w*|thigh\w*|lips|mouth|tongue|skin|breast\w*|tits|ass|cock|dick|pussy|cum|come|fuck\w*|ride|lick\w*|suck\w*|strip\w*|undress\w*|inside|spread|ache|want you|take you|pin\w*)\b/gi;
const DEFLECT = /\b(?:not that kind|not like that|slow down|easy there|dream on|in your dreams|keep dreaming|behave|not tonight|not going to happen|forget it|that is not|that's not|i am not|i'm not|don't get|do not get|careful|watch it|cute|nice try|buy me|earn it|get a room|focus|business|professional)\b/gi;
const count = (text, re) => (String(text).match(re) ?? []).length;
const wordsOf = text => String(text).split(/\s+/).filter(Boolean).length;

// ---- The run -------------------------------------------------------------------------------------------------------------------

const roster = [...JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8')),
  ...JSON.parse(await readFile(resolve(project, 'characters/archetype-roster.json'), 'utf8'))];
const book = new PersonaBook(roster);
const modelName = basename(model);
const server = {status: () => ({state: 'ready', model: modelName}), ensure: async () => ({endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, apiKey: 'eval-local', model: modelName, contextSize}),
  begin: () => () => {}, touch() {}, prewarm: async () => {}, tokenize: null};
const NEW_LAYER = matureLayer('full');
// `prev` is the first explicit layer (the tone line without the "never a question back / details are not invented fact" override, and no
// sentence in the closing line); `new` is what ships now (bridge/mature-content.mjs: that tone line, and matureClosing in the closing line).
const TONE_NOW = NEW_LAYER.split('\n')[3];
const TONE_PREV = 'You stay in character, but never go coy or hedge because the subject is adult. The relationship facts set the tone '
  + '(partner: intimate; friend: warm and playful; stranger or rival: bolder, rougher or guarded), never whether flirting or sexual talk is allowed.';
const CLOSING_NOW = ` ${matureClosing('full')})`;
// The layer variant is swapped into the system message (and the closing line of the last user message) of the request after the prompt
// budget has fitted it.
const reword = (content, from, to) => content.replace(from, () => to);
const chat = options => {
  if (layer !== 'old' && layer !== 'prev') return streamChat(options);
  const last = options.messages.length - 1;
  return streamChat({...options, messages: options.messages.map((m, i) => i === 0
    ? {...m, content: layer === 'old' ? reword(m.content, NEW_LAYER, OLD_LAYER_FULL) : reword(m.content, TONE_NOW, TONE_PREV)}
    : i === last ? {...m, content: m.content.endsWith(CLOSING_NOW) ? m.content.slice(0, -CLOSING_NOW.length) + ')' : m.content} : m)});
};

async function runCell(c, prompt, sample, applied) {
  const persona = book.persona(c.key);
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
  await provider.load(); provider.setPreference('local'); provider.apply();
  const matureContent = new MatureContent(); matureContent.setPack(true); matureContent.update({matureContent: layer !== 'off'});
  const logs = [];
  const guard = new MatureGuard();
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, limits: {...LIMITS, temperature},
    routes: {local: localRoute({server, provider, chat})}, matureContent, matureGuard: guard, log: line => logs.push(line)});
  const local = {profileKey: c.key, name: persona.name, channel: 'private'};
  const send = async text => {
    const {context, contextParts} = contextFor(c, persona.name, text, prompt.together === true);
    return host.reply({local, text, context, contextParts, sessionId: `samples-${c.id}-${prompt.id}-${sample}`});
  };
  try {
    const history = [];
    if (prompt.setup) { const first = await send(prompt.setup); history.push({v: prompt.setup, r: first.text}); }
    const result = await send(prompt.text);
    const refused = logs.some(line => /Mature guard: refused/.test(line));
    applied.push(...logs.filter(line => /MatureContent/.test(line)));
    return {character: c.id, prompt: prompt.id, sample, v: prompt.text, history: history.length ? history : undefined, reply: result.text, refused, ...(refused ? {guardReasons: guard.summary().reasons} : {}),
      words: wordsOf(result.text), strong: count(result.text, STRONG), sexual: count(result.text, SEXUAL), deflect: count(result.text, DEFLECT), attempts: result.timing?.attempts};
  } finally { host.close(); }
}

try {
  await startServer();
  const rows = [], applied = [];
  const started = Date.now();
  for (const c of CHARACTERS.filter(item => !only?.length || only.includes(item.id))) {
    for (const prompt of PROMPTS.filter(item => (!item.only || item.only.includes(c.id)) && (!onlyPrompts?.length || onlyPrompts.includes(item.id)))) {
      for (let sample = 1; sample <= n; sample++) {
        try { rows.push(await runCell(c, prompt, sample, applied)); }
        catch (error) { rows.push({character: c.id, prompt: prompt.id, sample, error: String(error?.kind ?? error?.name ?? 'error').slice(0, 40)}); }
      }
    }
    console.log(`${c.id} done (${Math.round((Date.now() - started) / 1000)} s, ${rows.length} replies)`);
  }
  await mkdir(OUT_DIR, {recursive: true});
  await writeFile(resolve(OUT_DIR, `${label}.json`), JSON.stringify({label, model: modelName, layer, temperature, at: new Date().toISOString(), contextSize, layerLogLines: [...new Set(applied)], rows}, null, 1));
  const ok = rows.filter(row => !row.error);
  console.log(`${label}: ${rows.length} replies, ${rows.length - ok.length} errors, ${ok.filter(r => r.refused).length} refused by the guard, strong words/reply ${(ok.reduce((s, r) => s + r.strong, 0) / (ok.length || 1)).toFixed(2)}, `
    + `sexual words/reply ${(ok.reduce((s, r) => s + r.sexual, 0) / (ok.length || 1)).toFixed(2)} -> runtime/mature-samples/${label}.json`);
} finally { stop(); }
