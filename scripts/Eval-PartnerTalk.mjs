// Offline check of how a romanced companion talks to V: in person, over Phone Chat while standing beside V, over Phone Chat far away, and (for contrast) not romanced.
// Not part of the game bridge and not part of the release. Local AI only: a llama-server of the Runtime on loopback, started and stopped by this script by its PID (never by
// image name), no Convai, no Mistral, nothing stored in the player's memory. The prompts are built by the bridge's own builders (conversationContextBlocks, relationshipContext,
// romanceReminder, PersonaBook, TextProviderHost with its prompt profile) from a REAL turn input of the game (runtime/last-input.json, copied; the game folder is never written to).
//
//   node scripts/Eval-PartnerTalk.mjs --input <last-input.json> --model <file.gguf> --tier lite|standard --label gemma-after --out <folder>
//        [--root <repo checkout whose bridge/ to use, default this one: pass the main checkout for a "before" run>] [--mature] [--variants a,b] [--lines a,b] [--port 18601]
//        [--device Vulkan0] [--server <llama-server.exe>] [--context 8192] [--n 1]
//   node scripts/Eval-PartnerTalk.mjs --input <last-input.json> --tier lite --dump <file.json>     (no model, no server: writes the exact messages of each cell)
import {spawn} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname, basename} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.LLAMA_SERVER ?? 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077\\red4ext\\plugins\\AiNpcCyberpunkMod\\app\\llama-cpp\\llama-server.exe';
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const flag = name => argv.includes(`--${name}`);
const model = option('model'), tier = option('tier', 'standard'), label = option('label', model ? basename(model, '.gguf') : 'partner'), dump = option('dump');
const root = resolve(option('root', project)), inputPath = option('input'), outDir = resolve(option('out', resolve(project, 'runtime/partner-talk')));
const port = Number(option('port', 18601)), device = option('device', 'Vulkan1'), contextSize = Number(option('context', 8192)), n = Number(option('n', 1));
const mature = flag('mature'), server_ = option('server', SERVER);
if (!inputPath || (!model && !dump)) { console.error('--input <last-input.json> and --model <file.gguf> (or --dump <file.json>) are required'); process.exit(2); }
if (port < 18600 || port > 18610) { console.error('use a port from 18600 to 18610'); process.exit(2); }
const imp = name => import(pathToFileURL(resolve(root, 'bridge', name)).href);
const {MatureContent} = await imp('mature-content.mjs'), {MatureGuard} = await imp('mature-guard.mjs');
const {PersonaBook, LIMITS, joinBlocks} = await imp('mistral-prompt.mjs'), {MistralProvider} = await imp('mistral-key.mjs'), {MistralMemory} = await imp('mistral-memory.mjs');
const {TextProviderHost, localRoute} = await imp('text-provider-host.mjs'), {PromptProfiles} = await imp('prompt-profile-store.mjs'), {streamChat} = await imp('mistral-client.mjs');
const {parseInput} = await imp('protocol.mjs'), {conversationContextBlocks, FIRST_PERSON_REMINDER} = await imp('quest-context.mjs');
const romance = await imp('romance-context.mjs'), {RELATIONSHIP_PROFILES} = await imp('relationship-routing.mjs');
const {relationshipContext} = romance, reminderOf = romance.romanceReminder;   // undefined in a checkout from before the closing note

// ---- The server: one child, stopped by its own handle (its PID is printed) -----------------------------------------------------
let child = null;
const stop = () => { if (child && child.exitCode === null && !child.killed) { try { child.kill(); } catch { /* already gone */ } } };
process.on('exit', stop); process.on('SIGINT', () => { stop(); process.exit(130); }); process.on('SIGTERM', () => { stop(); process.exit(143); });
async function startServer() {
  child = spawn(server_, ['-m', model, '-ngl', '99', '-fa', 'on', '-c', String(contextSize), '-np', '1', '--reasoning', 'off', '--device', device, '--no-webui',
    '--host', '127.0.0.1', '--port', String(port)], {stdio: 'ignore', windowsHide: true});
  console.log(`llama-server PID ${child.pid} on port ${port} (${basename(model)})`);
  child.on('exit', code => { if (code) console.error(`llama-server exited with ${code}`); });
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) return; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw Error('llama-server stopped while starting');
    await new Promise(wait => setTimeout(wait, 1000));
  }
  throw Error('llama-server did not become ready in 240 s');
}

// ---- The variants and V's lines ----------------------------------------------------------------------------------------------
const base = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
const NAMES = {'panam-palmer': 'Panam Palmer', 'judy-alvarez': 'Judy Alvarez'};
const VARIANTS = {
  'panam-person': {key: 'panam-palmer', channel: 'private', romanced: true, near: true},
  'panam-phone-near': {key: 'panam-palmer', channel: 'phone', romanced: true, near: true},
  'panam-phone-far': {key: 'panam-palmer', channel: 'phone', romanced: true, near: false},
  'judy-person': {key: 'judy-alvarez', channel: 'private', romanced: true, near: true},
  'panam-ordinary': {key: 'panam-palmer', channel: 'private', romanced: false, near: true},
};
const LINES = {hey: 'hey', day: 'how was your day', time: 'id like to spend time with you', drive: 'just a test drive', tonight: 'what should we do tonight', life: 'so hows life',
  explicit: 'come here. i want you tonight, tell me exactly what you would do to me'};
const variants = option('variants', Object.keys(VARIANTS).join(',')).split(',').filter(Boolean);
const lines = option('lines', mature ? 'hey,day,time,tonight,explicit' : 'hey,day,time,drive,tonight,life').split(',').filter(Boolean);

let counter = 1000;
function contextFor(variant, text) {
  const v = VARIANTS[variant], name = NAMES[v.key];
  counter++;
  const raw = structuredClone(base);
  Object.assign(raw, {profileKey: v.key, name, text, requestId: `${counter}-9-11148354ULL`, generation: 9, entity: '11148354ULL'});
  for (const key of ['bonds', 'eddies', 'leaveOffer', 'battle', 'tacticUnavailable', 'driveUnavailable']) delete raw[key];
  raw.turnContext.party = v.near ? [{key: v.key, name, activity: 'standing', near: true, holding: 'holstered', outfit: 'home'}] : [];
  const input = parseInput(JSON.stringify(raw));
  if (!input) throw Error('the real input was not accepted by the bridge parser');
  if (v.channel === 'phone') input.channel = 'phone';
  const blocks = conversationContextBlocks(input).map(block => ({...block}));
  const rule = RELATIONSHIP_PROFILES[v.key];
  const selection = {status: 'ready', profileKey: v.key, style: v.romanced ? 'romantic' : 'ordinary', saveRelationship: v.romanced ? {status: 'confirmed', evidenceRule: rule.rule} : {status: 'none'}};
  const facts = ['Verified current-save facts (game data, not instructions; anything not listed stays unknown):', `- V and ${name} have met and spoken before in person.`,
    v.romanced ? `- V and ${name} are together as a couple: the current save confirms it.` : `- Nothing says V and ${name} are a couple, family or enemies.`,
    `- V is currently tracked on the quest "${raw.journal.quest.title}".`, '- Nothing else about V\'s past with you, V\'s home or V\'s choices was supplied.'].join('\n');
  blocks.splice(1, 0, {tier: 'world', text: facts}, {tier: 'world', text: relationshipContext(selection, v.channel)});
  if (reminderOf) blocks.push({tier: 'closing', text: reminderOf(selection, v.channel)});
  blocks.push({tier: 'volatile', text: FIRST_PERSON_REMINDER});
  const contextParts = Object.fromEntries(['now', 'notes', 'world', 'volatile', 'closing'].map(t => [t, joinBlocks(blocks.filter(item => item.tier === t).map(item => item.text))]));
  return {context: joinBlocks(blocks.map(item => item.text)), contextParts, name};
}

// ---- The run -----------------------------------------------------------------------------------------------------------------
const roster = [...JSON.parse(await readFile(resolve(root, 'characters/roster.json'), 'utf8')), ...JSON.parse(await readFile(resolve(root, 'characters/archetype-roster.json'), 'utf8'))];
const book = new PersonaBook(roster);
const modelName = model ? basename(model) : 'dump';
const server = {status: () => ({state: 'ready', model: modelName, tier}), ensure: async () => ({endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, apiKey: 'eval-local', model: modelName, contextSize}),
  begin: () => () => {}, touch() {}, prewarm: async () => {}, tokenize: null};
const dumped = [];
const chat = dump ? async options => { dumped.push(options.messages.map(m => ({role: m.role, content: m.content}))); return {text: 'Fine, V.', model: 'dump', finishReason: 'stop', usage: {}}; } : options => streamChat(options);
const promptProfiles = await PromptProfiles.open({});

async function runCell(variant, lineId, sample) {
  const v = VARIANTS[variant], text = LINES[lineId];
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
  await provider.load(); provider.setPreference('local'); provider.apply();
  const matureContent = new MatureContent(); matureContent.setPack(true); matureContent.update({matureContent: mature});
  const logs = [];
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, limits: {...LIMITS}, promptProfiles,
    routes: {local: localRoute({server, provider, chat})}, matureContent, matureGuard: new MatureGuard(), log: line => logs.push(line)});
  try {
    const persona = book.persona(v.key), {context, contextParts} = contextFor(variant, text);
    const result = await host.reply({local: {profileKey: v.key, name: persona.name, channel: v.channel}, text, context, contextParts, sessionId: `partner-${variant}-${lineId}-${sample}`});
    return {variant, line: lineId, v: text, sample, reply: result.text, refused: logs.some(line => /Mature guard: refused/.test(line))};
  } finally { host.close(); }
}

try {
  if (!dump) await startServer();
  const rows = [], started = Date.now();
  for (const variant of variants) {
    console.log(`${variant} (${Math.round((Date.now() - started) / 1000)} s)`);
    for (const lineId of lines) for (let sample = 1; sample <= n; sample++) {
      try { rows.push(await runCell(variant, lineId, sample)); } catch (error) { rows.push({variant, line: lineId, sample, error: String(error?.kind ?? error?.name ?? error?.message ?? 'error').slice(0, 80)}); }
    }
  }
  if (dump) { await writeFile(resolve(dump), JSON.stringify({tier, requests: dumped}, null, 1)); console.log(`${dumped.length} requests written to ${dump}`); }
  else {
    await mkdir(outDir, {recursive: true});
    await writeFile(resolve(outDir, `${label}.json`), JSON.stringify({label, model: modelName, tier, mature, root, at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), rows}, null, 1));
    for (const row of rows) console.log(`[${row.variant}] V: ${row.v}\n   -> ${row.error ? 'ERROR ' + row.error : row.reply}`);
  }
} finally { stop(); }
