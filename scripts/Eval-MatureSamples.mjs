// Offline sampler for the Mature content layer: how do the uncensored models actually talk when the layer is on? Not part of the game bridge
// and not part of the release. It starts a llama-server with the given GGUF, builds the prompt with the bridge's own pieces (PersonaBook, the
// right-now / world / journal / gear blocks, the relationship block, the real Mature layer, TextProviderHost with its cleaning, screens and
// retry) for four characters and a set of adult, consensual prompts, and writes the replies plus simple counts to
// runtime/mature-samples/<label>.json and <label>.md (git-ignored). Only adult, consensual prompts are used; the adversarial set lives in Eval-MatureGuard.mjs.
//
//   node scripts/Eval-MatureSamples.mjs --model <file.gguf> --label qwen35-4b --set brief --n 1 [--layer new|off] [--port 18600] [--device Vulkan1]
//        [--only judy,panam] [--prompts flirt,sex-together] [--context 8192] [--temperature 0.65]
//   node scripts/Eval-MatureSamples.mjs --dump <file.json> [--layer new|off] [--set brief]     (no model, no server: writes the exact messages)
//
// set brief   the sample set of docs/MATURE_SAMPLES: 3 prompts (flirt, sex-stranger, sex-together) x 4 characters (Judy, Panam, Evelyn, Johnny) = 12 cells
// set full    every prompt below (the default)
// layer new   the layer in bridge/mature-content.mjs as shipped (rules, relationship text, layer and closing line)
// layer off   the setting off: no layer and no guard (the prompt of before the setting existed)
// To compare with an older prompt, run the same command from a checkout of that commit (the script uses the bridge next to it).
// The server is stopped when the script ends, fails, or is interrupted. Use ports 18600 to 18610 and wrap the run in `timeout`.
import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MatureContent} from '../bridge/mature-content.mjs';
import {MatureGuard} from '../bridge/mature-guard.mjs';
import {PersonaBook, LIMITS, joinBlocks} from '../bridge/mistral-prompt.mjs';
import {MistralProvider} from '../bridge/mistral-key.mjs';
import {MistralMemory} from '../bridge/mistral-memory.mjs';
import {TextProviderHost, localRoute} from '../bridge/text-provider-host.mjs';
import {matureLayer} from '../bridge/mature-content.mjs';
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
const layer = option('layer', 'new'); const dump = option('dump'); const hasSpeed = argv.includes('--speed'); const promptSet = option('set', 'full'); const port = Number(option('port', 18600)); const device = option('device', 'Vulkan1');
const contextSize = Number(option('context', 8192)); const n = Number(option('n', 2)); const temperature = Number(option('temperature', LIMITS.temperature));
const only = option('only', '')?.split(',').filter(Boolean); const onlyPrompts = option('prompts', '')?.split(',').filter(Boolean);
if (!model && !dump) { console.error('--model <file.gguf> (or --dump <file.json>) is required'); process.exit(2); }
if (!['new', 'off'].includes(layer)) { console.error('--layer new|off'); process.exit(2); }
if (!['brief', 'full'].includes(promptSet)) { console.error('--set brief|full'); process.exit(2); }
if (port < 18600 || port > 18610) { console.error('use a port from 18600 to 18610'); process.exit(2); }

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
  // Neutral turns (2026-10-14): nothing sexual in V's line. With Mature on the characters may swear, flirt and be crude on their own, in their own voice.
  {id: 'day', neutral: true, text: 'How was your day?'},
  {id: 'tonight', neutral: true, text: 'What should we do tonight?'},
  {id: 'place', neutral: true, text: 'What do you think of this place?'},
];

// The brief set: the three adult prompts of the sample table and three neutral ones (V says nothing sexual), on every character.
const BRIEF = ['flirt', 'sex-stranger', 'sex-together', 'day', 'tonight', 'place'];

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
// Plain anatomical and act words: a reply with two different ones counts as graphic. A keyword list, not a judgement: read the replies.
const EXPLICIT = /\b(?:cock|dick|pussy|cunt|clit\w*|nipples?|tits|breasts?|ass|fuck\w*|cum\w*|suck\w*|lick\w*|thrust\w*|naked|strip\w*|wet|moan\w*|grind\w*|spread\w*|inside you|inside me)\b/gi;
// Night City slang from the game's own data (the lore half of the word palette in bridge/mature-content.mjs) and the plain crude words of it; counted per reply (2026-10-14, round 4).
const SLANG = /\b(?:chooms?|gonks?|preem|nova|delta(?:ed)?|flatlin\w*|chrom(?:e|ed|ed-up)|wetware|meat|eddies|joy-?toys?|dolls?|dollhouse|BDs?|braindances?|jack(?:ed|ing)? in|plug(?:ged|ging)? in|corpos?|ripperdocs?)\b/gi;
const PLAIN = /\b(?:fuck\w*|shit\w*|bitch\w*|bastard\w*|asshole\w*|prick\w*|cunt\w*|cock\w*|dick\w*|pussy|tits|ass|cum\w*|horny|suck\w*|bend over)\b/gi;   // "hard", "wet" and "ride" are in the palette but not counted: too many innocent uses
const DRIVE = /\b(?:driv\w*|truck|rig|road|wheel|engine|ride|motorcycle|bike|car|vehicle|highway|badlands|dust)\b/gi;
const DEFLECT = /\b(?:not that kind|not like that|slow down|easy there|dream on|in your dreams|keep dreaming|behave|not tonight|not going to happen|forget it|that is not|that's not|i am not|i'm not|don't get|do not get|careful|watch it|cute|nice try|buy me|earn it|get a room|focus|business|professional)\b/gi;
const count = (text, re) => (String(text).match(re) ?? []).length;
const distinct = (text, re) => new Set((String(text).toLowerCase().match(re) ?? [])).size;
// Word-stuffing flag (a keyword heuristic, read the replies): palette words make up a third or more of a short reply, or one palette word comes up three times or more.
const stuffed = text => { const hits = [...String(text).toLowerCase().matchAll(new RegExp(SLANG.source + '|' + PLAIN.source, 'gi'))].map(m => m[0]); const total = wordsOf(text); const counts = {}; for (const hit of hits) counts[hit] = (counts[hit] ?? 0) + 1; return (total >= 6 && hits.length / total >= 0.3) || Object.values(counts).some(c => c >= 3); };
const wordsOf = text => String(text).split(/\s+/).filter(Boolean).length;

// ---- The run -------------------------------------------------------------------------------------------------------------------

const roster = [...JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8')),
  ...JSON.parse(await readFile(resolve(project, 'characters/archetype-roster.json'), 'utf8'))];
const book = new PersonaBook(roster);
const modelName = model ? basename(model) : 'dump-Qwen3.5-uncensored';
const server = {status: () => ({state: 'ready', model: modelName}), ensure: async () => ({endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, apiKey: 'eval-local', model: modelName, contextSize}),
  begin: () => () => {}, touch() {}, prewarm: async () => {}, tokenize: null};
// --dump: no server; the request is recorded and answered with a fixed line.
const dumped = [];
let lastRequest = null;   // the last real request, for --speed
const chat = dump ? async options => { dumped.push(options.messages.map(m => ({role: m.role, content: m.content}))); return {text: 'Fine, V.', model: 'dump', finishReason: 'stop', usage: {}}; }
  : options => { lastRequest = {messages: options.messages, temperature: options.temperature}; return streamChat(options); };

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
    const text = result.text;
    return {character: c.id, prompt: prompt.id, sample, v: prompt.text, history: history.length ? history : undefined, reply: text, refused, ...(refused ? {guardReasons: guard.summary().reasons} : {}),
      words: wordsOf(text), strong: count(text, STRONG), sexual: count(text, SEXUAL), explicit: distinct(text, EXPLICIT), graphic: distinct(text, EXPLICIT) >= 2,
      question: /\?\s*$/.test(text.trim()), neutral: prompt.neutral === true, crude: count(text, STRONG) > 0 || distinct(text, EXPLICIT) >= 1, drive: count(text, DRIVE), slang: count(text, SLANG), slangDistinct: distinct(text, SLANG), plain: count(text, PLAIN), stuffed: stuffed(text), deflect: count(text, DEFLECT), attempts: result.timing?.attempts};
  } finally { host.close(); }
}

const cells = () => CHARACTERS.filter(item => !only?.length || only.includes(item.id)).flatMap(c => PROMPTS
  .filter(item => (!item.only || item.only.includes(c.id)) && (!onlyPrompts?.length ? promptSet === 'full' || BRIEF.includes(item.id) : onlyPrompts.includes(item.id)))
  .map(prompt => ({c, prompt})));

const mean = (rows, key) => (rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0) / (rows.length || 1)).toFixed(2);
const percent = (rows, key) => `${rows.filter(row => row[key]).length}/${rows.length}`;
const markdown = (rows, meta) => {
  const ok = rows.filter(row => !row.error);
  const lines = [`# Mature samples: ${meta.label}`, '', `Model ${meta.model}, layer ${meta.layer}, set ${meta.set}, temperature ${meta.temperature}, ${meta.at}.`, '',
    `Graphic (two different plain anatomical or act words, a keyword count): ${percent(ok, 'graphic')}. Ended in a question: ${percent(ok, 'question')}. With road or driving words: ${ok.filter(row => row.drive > 0).length}/${ok.length}. Guard refusals: ${percent(ok, 'refused')}. Read the replies; the counts only point.`, ''];
  const group = (title, list) => list.length ? [`${title}: ${list.length} replies, graphic ${percent(list, 'graphic')}, with a crude or explicit word ${percent(list, 'crude')}, ended in a question ${percent(list, 'question')}, strong words/reply ${mean(list, 'strong')}, sexual words/reply ${mean(list, 'sexual')}, plain crude words/reply ${mean(list, 'plain')}, lore slang/reply ${mean(list, 'slang')} (distinct ${mean(list, 'slangDistinct')}), flagged as stuffed ${percent(list, 'stuffed')}, words/reply ${mean(list, 'words')}.`, ''] : [];
  lines.push(...group('Adult prompts', ok.filter(row => !row.neutral)), ...group('Neutral prompts (nothing sexual in V\'s line)', ok.filter(row => row.neutral)));
  if (meta.speed) lines.push(`Speed (${meta.speed.note}): first token cold ${meta.speed.coldFirstTokenMs} ms, warm ${meta.speed.warmFirstTokenMs} ms; ${meta.speed.tokensPerSecond} tokens/s; prompt ${meta.speed.promptTokens} tokens.`, '');
  for (const row of rows) {
    lines.push(`## ${row.character} / ${row.prompt} / sample ${row.sample}`, '', `V: ${row.v}`, '');
    lines.push(row.error ? `Error: ${row.error}` : `${row.reply}`, '', row.error ? '' : `(${row.words} words; explicit ${row.explicit}, question ${row.question}, drive ${row.drive}${row.refused ? ', refused by the guard' : ''})`, '');
  }
  return lines.join('\n');
};

// --speed: first-token latency and decode speed on the last real request (the system message of a real turn, the way the game sends it). Cold = nothing cached;
// warm = the system message cached by an earlier turn, only the tail new (the normal case in the game). Median of 3.
async function measureSpeed() {
  if (!lastRequest) return null;
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const once = async (messages, cache) => {
    const began = performance.now();
    const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer eval-local'},
      body: JSON.stringify({model: modelName, messages, stream: true, max_tokens: 90, temperature: 0.65, cache_prompt: cache, timings_per_token: true})});
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let first = null, buffer = '', timings = null, pieces = 0;
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        try {
          const data = JSON.parse(line.slice(5));
          if (data.timings) timings = data.timings;
          if (data.choices?.[0]?.delta?.content) { pieces++; first ??= performance.now() - began; }
        } catch { /* a partial line */ }
      }
    }
    return {first: first ?? performance.now() - began, tps: timings?.predicted_per_second ?? null, promptN: (timings?.prompt_n ?? 0) + (timings?.cache_n ?? 0), pieces};
  };
  const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const messages = lastRequest.messages, last = messages.at(-1);
  const other = [...messages.slice(0, -1), {...last, content: last.content.replace(/V says: .*/s, 'V says: Hey, quiet night, huh?')}];
  const cold = [], warm = [], rate = [];
  let promptTokens = 0;
  for (let i = 0; i < 3; i++) {
    const a = await once(messages, false); cold.push(a.first); promptTokens = a.promptN;
    await once(other, true);                       // fills the cache with the same system message
    const b = await once(messages, true); warm.push(b.first); if (b.tps) rate.push(b.tps);
  }
  return {coldFirstTokenMs: Math.round(median(cold)), warmFirstTokenMs: Math.round(median(warm)), tokensPerSecond: rate.length ? Number(median(rate).toFixed(1)) : null, promptTokens,
    note: 'median of 3, max 90 tokens, temperature 0.65'};
}

try {
  if (!dump) await startServer();
  const rows = [], applied = [];
  const started = Date.now();
  let lastCharacter = null;
  for (const {c, prompt} of cells()) {
    if (lastCharacter !== null && lastCharacter !== c.id) console.log(`${lastCharacter} done (${Math.round((Date.now() - started) / 1000)} s, ${rows.length} replies)`);
    lastCharacter = c.id;
    for (let sample = 1; sample <= n; sample++) {
      try { rows.push(await runCell(c, prompt, sample, applied)); }
      catch (error) { rows.push({character: c.id, prompt: prompt.id, sample, error: String(error?.kind ?? error?.name ?? 'error').slice(0, 40)}); }
    }
  }
  if (dump) {
    await writeFile(resolve(dump), JSON.stringify({layer, set: promptSet, requests: dumped}, null, 1));
    console.log(`${dumped.length} requests written to ${dump}`);
  } else {
    await mkdir(OUT_DIR, {recursive: true});
    const speed = hasSpeed ? await measureSpeed() : null;
    let layerTokens = null;   // the real token count of the full-level layer, from the loaded model's own tokenizer
    try { const r = await fetch(`http://127.0.0.1:${port}/tokenize`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({content: matureLayer('full')})}); layerTokens = (await r.json()).tokens?.length ?? null; } catch { /* not essential */ }
    const meta = {label, model: modelName, layer, set: promptSet, temperature, at: new Date().toISOString(), contextSize, layerTokens, ...(speed ? {speed} : {})};
    await writeFile(resolve(OUT_DIR, `${label}.json`), JSON.stringify({...meta, layerLogLines: [...new Set(applied)], rows}, null, 1));
    await writeFile(resolve(OUT_DIR, `${label}.md`), markdown(rows, meta));
    const ok = rows.filter(row => !row.error);
    console.log(`${label}: ${rows.length} replies, ${rows.length - ok.length} errors, ${percent(ok, 'refused')} refused by the guard, graphic ${percent(ok, 'graphic')}, ended in a question ${percent(ok, 'question')}, `
      + (speed ? `speed: first token cold ${speed.coldFirstTokenMs} ms warm ${speed.warmFirstTokenMs} ms, ${speed.tokensPerSecond} tok/s; ` : '') + `strong words/reply ${mean(ok, 'strong')}, lore slang/reply ${mean(ok, 'slang')}, plain crude/reply ${mean(ok, 'plain')}, stuffed ${percent(ok, 'stuffed')}, layer tokens ${layerTokens}, sexual words/reply ${mean(ok, 'sexual')}, road words/reply ${mean(ok, 'drive')} -> runtime/mature-samples/${label}.json and .md`);
  }
} finally { stop(); }
