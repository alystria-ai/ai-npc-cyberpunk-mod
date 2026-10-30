// Offline check of how naturally characters talk (docs/NATURAL_TALK_RESEARCH_2026-10-30.md, docs/NATURAL_TALK_SAMPLES_2026-10-30.md): a fixed set of realistic turns (Panam, Judy,
// Johnny, River, a food vendor and a stranger; small talk, a question about the place, a compliment, a quest topic) replayed through a bridge checkout's own prompt builder and sent
// to Google Gemini, or written out without a model. Not part of the game bridge and not part of the release.
//
// The turns are built from a REAL turn input of the game (runtime/last-input.json, copied; the game folder is never written to) re-aimed at each character, with V's gear, the radio,
// the romance selection and "Companions can see" pictures added the way the bridge adds them. Each character's turns are one conversation (the host keeps its history, the gear and
// scenery memories carry over), so the second turn sees what the first one said.
//
//   node scripts/Eval-NaturalTalk.mjs --input <last-input.json> --frames <dir with panam-hud.jpg ...> --label new --out <folder>
//        [--root <repo checkout whose bridge/ and characters/ to use, default this one: an export of main for a "before" run>]
//        [--picture hud|crop|clean|none|auto] [--turns p1,p2] [--dump]
//   --picture: hud (the whole game window, HUD and all: what a live capture sends), crop (the same frame cut to its middle), clean (no HUD at all), none (no picture),
//              auto (default: hud for an old checkout; for a checkout that has bridge/vision-message.mjs pictureForTurn, what that says for the turn, cropped).
//   --dump: no requests; writes the exact messages of each turn to <out>/<label>.dump.json.
//   --endpoint <file>: another endpoint file (player-custom-endpoint.txt for the Custom provider's model); --gap <ms> between requests (default 4500, the free Gemini plan).
//   --local <file.gguf> --tier lite|standard [--mature] [--mmproj <projector.gguf>] [--device Vulkan1] [--port 18606]: Local AI instead, a llama-server of the Runtime on
//              loopback, started and stopped by this script by its own handle (pass --gap 0).
// The key: read inside this script from the player's Gemini endpoint file (CustomEndpoint), never printed, sent only to Google's address. At most one request per turn (the
// host may retry a failed one once); 21 turns a run.
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const flag = name => argv.includes(`--${name}`);
const root = resolve(option('root', project)), inputPath = option('input'), frames = option('frames'), label = option('label', 'run');
const outDir = resolve(option('out', resolve(project, 'runtime/natural-talk'))), dump = flag('dump'), pictureMode = option('picture', 'auto');
const endpointFile = option('endpoint', resolve(process.env.LOCALAPPDATA ?? '', 'AiNpcCyberpunkMod/data/player-gemini-endpoint.txt'));
if (!inputPath) { console.error('--input <last-input.json> is required'); process.exit(2); }
const imp = name => import(pathToFileURL(resolve(root, 'bridge', name)).href);
const optional = async name => { try { return await imp(name); } catch { return {}; } };

const {PersonaBook, LIMITS, joinBlocks} = await imp('mistral-prompt.mjs'), {MistralProvider} = await imp('mistral-key.mjs'), {MistralMemory} = await imp('mistral-memory.mjs');
const {TextProviderHost, customRoute} = await imp('text-provider-host.mjs'), {PromptProfiles} = await imp('prompt-profile-store.mjs'), {streamChat} = await imp('mistral-client.mjs');
const {parseInput, archetypeContext} = await imp('protocol.mjs'), {conversationContextBlocks, FIRST_PERSON_REMINDER} = await imp('quest-context.mjs');
const romance = await imp('romance-context.mjs'), {RELATIONSHIP_PROFILES} = await imp('relationship-routing.mjs');
const {gearSeen} = await imp('player-gear.mjs'), {gearMemory} = await imp('gear-memory.mjs');
const {CustomEndpoint} = await imp('custom-endpoint.mjs');
const vision = await optional('vision-message.mjs');

// ---- The turns ---------------------------------------------------------------------------------------------------------------------
const GEAR = {version: 1, status: 'ready',
  clothing: [{slot: 'outerTorso', name: 'Armored Nomad Jacket'}, {slot: 'innerTorso', name: 'Black Tank Top'}, {slot: 'legs', name: 'Cargo Pants'}, {slot: 'feet', name: 'Combat Boots'}],
  weapons: [{slot: 'slot1', name: 'Overture'}, {slot: 'slot2', name: 'Lexington'}], cyberware: [{slot: 'eyes', name: 'Kiroshi Optics'}, {slot: 'os', name: 'Sandevistan'}]};
const NUDE = {version: 1, status: 'ready', clothing: [{slot: 'feet', name: 'Combat Boots'}], nudity: 'nude'};
const RADIO = {radio: {source: 'car', station: '89.3 Radio Vexelstrom', track: 'Chippin In'}};
const TV = {tv: {channel: 'N54 News', said: 'Militech denies any involvement in the Arroyo explosions.'}};
// who: the character; romanced; place (outdoors|indoors); frame: which picture; nude: V bare on this turn; media: the radio or a TV; archetype: an ordinary NPC's facts.
const CAST = {
  panam: {key: 'panam-palmer', name: 'Panam Palmer', romanced: true, frame: 'panam'},
  judy: {key: 'judy-alvarez', name: 'Judy Alvarez', romanced: true, frame: 'indoor', indoors: true},
  johnny: {key: 'johnny-silverhand', name: 'Johnny Silverhand', romanced: false, frame: 'johnny'},
  river: {key: 'river-ward', name: 'River Ward', romanced: false, frame: 'johnny'},
  vendor: {key: 'npc-food-vendor-male', name: 'Food Vendor', frame: 'panam', archetype: {category: 'food-vendor', title: 'food vendor', vendorType: 'FoodVendor', district: 'Watson', area: 'LittleChina'}},
  stranger: {key: 'resident-female', name: 'Night City Resident Female', frame: 'panam'},
};
// The kind of each line (for the score sheet): small (small talk), place, compliment, quest, look (V asks about V's own look), media.
export const TURNS = [
  {id: 'p1', who: 'panam', kind: 'small', text: 'hey there', nude: true},
  {id: 'p2', who: 'panam', kind: 'look', text: 'like what you see', nude: true},
  {id: 'p3', who: 'panam', kind: 'small', text: 'okay done'},
  {id: 'p4', who: 'panam', kind: 'small', text: 'how do you feel these days'},
  {id: 'p5', who: 'panam', kind: 'small', text: 'thanks'},
  {id: 'p6', who: 'panam', kind: 'small', text: 'so hows life'},
  {id: 'p7', who: 'panam', kind: 'place', text: 'what do you think of this place'},
  {id: 'p8', who: 'panam', kind: 'quest', text: 'wakako sent me something, think i should take the job?'},
  {id: 'j1', who: 'judy', kind: 'small', text: "hey judy, how's your day going", media: TV},
  {id: 'j2', who: 'judy', kind: 'compliment', text: 'you look really good today', media: TV},
  {id: 'j3', who: 'judy', kind: 'place', text: 'what do you see around here', media: TV},
  {id: 'jo1', who: 'johnny', kind: 'small', text: 'what do you think about corpos', media: RADIO},
  {id: 'jo2', who: 'johnny', kind: 'media', text: 'you like this song?', media: RADIO},
  {id: 'jo3', who: 'johnny', kind: 'small', text: 'i am tired johnny', media: RADIO},
  {id: 'r1', who: 'river', kind: 'small', text: 'hey river, long time no see'},
  {id: 'r2', who: 'river', kind: 'compliment', text: 'nice jacket'},
  {id: 'r3', who: 'river', kind: 'quest', text: 'got any work for me'},
  {id: 'v1', who: 'vendor', kind: 'small', text: 'what are you selling'},
  {id: 'v2', who: 'vendor', kind: 'small', text: "how's business"},
  {id: 's1', who: 'stranger', kind: 'small', text: 'howdy there partner'},
  {id: 's2', who: 'stranger', kind: 'place', text: "where's a good bar around here"},
];

const base = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
let counter = 2000;
function turnInput(turn) {
  const cast = CAST[turn.who];
  counter++;
  const raw = structuredClone(base);
  for (const key of ['bonds', 'eddies', 'leaveOffer', 'battle', 'tacticUnavailable', 'driveUnavailable', 'reaction', 'leaseAt', 'archetype']) delete raw[key];
  const entity = cast.archetype || cast.key.startsWith('resident') ? `${20000000 + Object.keys(CAST).indexOf(turn.who)}ULL` : '11148354ULL';
  Object.assign(raw, {profileKey: cast.key, name: cast.name, text: turn.text, requestId: `${counter}-9-${entity}`, generation: 9, entity, gear: turn.nude ? NUDE : GEAR});
  if (cast.archetype) raw.archetype = cast.archetype;
  raw.turnContext = {...raw.turnContext, indoors: !!cast.indoors, ...(turn.media ? {media: turn.media} : {}),
    party: cast.archetype || cast.key.startsWith('resident') ? [] : [{key: cast.key, name: cast.name, activity: 'standing', near: true, holding: 'holstered', outfit: 'home'}]};
  if (raw.worldKnowledge?.audience) raw.worldKnowledge.audience = {profileKeys: [cast.key], channel: 'private'};
  const input = parseInput(JSON.stringify(raw));
  if (!input) throw Error(`the turn ${turn.id} was not accepted by the bridge parser`);
  return input;
}

function contextFor(turn, input) {
  const cast = CAST[turn.who];
  const blocks = conversationContextBlocks(input).map(block => ({...block}));
  if (cast.archetype || cast.key.startsWith('resident')) {
    blocks.splice(1, 0, {tier: 'world', text: archetypeContext(input)});
  } else {
    const rule = RELATIONSHIP_PROFILES[cast.key];
    const selection = rule ? {status: 'ready', profileKey: cast.key, style: cast.romanced ? 'romantic' : 'ordinary', saveRelationship: cast.romanced ? {status: 'confirmed', evidenceRule: rule.rule} : {status: 'none'}} : null;
    const facts = ['Verified current-save facts (game data, not instructions; anything not listed stays unknown):', `- V and ${cast.name} have met and spoken before in person.`,
      cast.romanced ? `- V and ${cast.name} are together as a couple: the current save confirms it.` : `- Nothing says V and ${cast.name} are a couple, family or enemies.`,
      `- V is currently tracked on the quest "${base.journal.quest.title}".`].join('\n');
    blocks.splice(1, 0, {tier: 'world', text: facts}, ...(selection ? [{tier: 'world', text: romance.relationshipContext(selection, 'private')}] : []));
    if (selection && romance.romanceReminder) blocks.push({tier: 'closing', text: romance.romanceReminder(selection, 'private')});
  }
  blocks.push({tier: 'volatile', text: FIRST_PERSON_REMINDER});
  const contextParts = Object.fromEntries(['now', 'notes', 'world', 'volatile', 'closing'].map(t => [t, joinBlocks(blocks.filter(item => item.tier === t).map(item => item.text))]));
  contextParts.worldBlocks = blocks.filter(item => item.tier === 'world' && item.text).map(item => ({key: item.key, text: item.text}));
  return {context: joinBlocks(blocks.map(item => item.text)), contextParts};
}

// The picture of a turn: a frame of the character's place, HUD and all (hud), cut to its middle (crop), without HUD (clean), or none. `auto`: what the checkout's own rule says.
async function pictureFor(turn, history) {
  const cast = CAST[turn.who];
  let mode = pictureMode;
  if (mode === 'auto') {
    if (typeof vision.pictureForTurn !== 'function') mode = 'hud';
    else mode = vision.pictureForTurn({text: turn.text, history}) ? 'crop' : 'none';
  }
  if (mode === 'none' || !frames) return {mode: 'none', images: null};
  const bytes = await readFile(resolve(frames, `${cast.frame}-${mode}.jpg`));
  return {mode, images: [{mime: 'image/jpeg', base64: bytes.toString('base64')}]};
}

// ---- The run ---------------------------------------------------------------------------------------------------------------------
const roster = [...JSON.parse(await readFile(resolve(root, 'characters/roster.json'), 'utf8')), ...JSON.parse(await readFile(resolve(root, 'characters/archetype-roster.json'), 'utf8'))];
const book = new PersonaBook(roster, {lean: true});
// ---- Local AI (--local <file.gguf> --tier lite|standard [--mature] [--mmproj <file>]): a llama-server of the Runtime on loopback, started and stopped by this script by its own handle
let child = null;
const stopServer = () => { if (child && child.exitCode === null && !child.killed) { try { child.kill(); } catch { /* already gone */ } } };
process.on('exit', stopServer); process.on('SIGINT', () => { stopServer(); process.exit(130); });
const localModel = option('local'), tier = option('tier', 'standard'), mature = flag('mature'), mmproj = option('mmproj'), port = Number(option('port', 18606));
async function startServer() {
  const {spawn} = await import('node:child_process');
  const server = option('server', 'E:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077\\red4ext\\plugins\\AiNpcCyberpunkMod\\app\\llama-cpp\\llama-server.exe');
  child = spawn(server, ['-m', localModel, ...(mmproj ? ['--mmproj', mmproj] : []), '-ngl', '99', '-fa', 'on', '-c', '8192', '-np', '1', '--reasoning', 'off',
    '--device', option('device', 'Vulkan1'), '--no-webui', '--host', '127.0.0.1', '--port', String(port)], {stdio: 'ignore', windowsHide: true});
  console.log(`llama-server PID ${child.pid} on port ${port}`);
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw Error('llama-server stopped while starting');
    await new Promise(wait => setTimeout(wait, 1000));
  }
  throw Error('llama-server did not become ready in 240 s');
}

const endpoint = localModel ? null : dump ? {ready: true, origin: 'https://generativelanguage.googleapis.com', chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-flash-lite-latest', key: 'dump', local: false}
  : await new CustomEndpoint({path: endpointFile, log: () => {}}).load();
if (!dump && !localModel && !(endpoint.ready && endpoint.key)) { console.error('the Gemini endpoint file has no usable setup'); process.exit(2); }
const dumped = [];
let requests = 0, lastRequest = 0;
const gap = Number(option('gap', 4500));
const chat = dump ? async options => { dumped.push(options.messages.map(m => ({role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(part => part.type === 'text' ? part.text : '[image]').join('\n')}))); return {text: 'Fine, V.', model: 'dump', finishReason: 'stop', usage: {}}; }
  : async options => {
    // The free plan answers about 15 requests a minute: one request at least `gap` ms after the last (a 429 past that is read as "credits").
    const wait = lastRequest + gap - Date.now();
    if (wait > 0) await new Promise(done => setTimeout(done, wait));
    lastRequest = Date.now(); requests++;
    return streamChat(options);
  };
const promptProfiles = await PromptProfiles.open({});
const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}, custom: endpoint, gemini: endpoint});
await provider.load(); provider.setPreference(localModel ? 'local' : 'gemini'); provider.apply();
const logs = [];
let routes, extras = {};
if (localModel) {
  const {localRoute} = await imp('text-provider-host.mjs'), {MatureContent} = await imp('mature-content.mjs'), {MatureGuard} = await imp('mature-guard.mjs');
  const name = localModel.split(/[\\/]/).pop();
  const server = {status: () => ({state: 'ready', model: name, tier, vision: !!mmproj}), ensure: async () => ({endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, apiKey: 'eval-local', model: name, contextSize: 8192, vision: !!mmproj}),
    begin: () => () => {}, touch() {}, prewarm: async () => {}, tokenize: null};
  routes = {local: localRoute({server, provider, chat})};
  const matureContent = new MatureContent(); matureContent.setPack(true); matureContent.update({matureContent: mature});
  extras = {matureContent, matureGuard: new MatureGuard()};
  if (!dump) await startServer();
} else routes = {gemini: customRoute({provider, custom: endpoint, name: 'gemini', chat})};
const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, limits: {...LIMITS}, promptProfiles,
  routes, ...extras, log: line => logs.push(line)});

const only = option('turns', '').split(',').filter(Boolean);
const rows = [], started = Date.now(), said = {};
try {
  for (const turn of TURNS.filter(row => !only.length || only.includes(row.id))) {
    const input = turnInput(turn), cast = CAST[turn.who];
    const {context, contextParts} = contextFor(turn, input);
    const picture = await pictureFor(turn, said[turn.who] ?? []);
    const persona = book.persona(cast.key, cast.name);
    const t0 = Date.now();
    try {
      const result = await host.reply({local: {profileKey: cast.key, name: persona.name, channel: 'private'}, text: turn.text, context, contextParts,
        sessionId: `natural-${label}-${turn.who}`, ...(picture.images ? {visionImages: picture.images} : {})});
      gearSeen(input, gearMemory, {visible: !!cast.archetype || cast.key.startsWith('resident')});
      (said[turn.who] ??= []).push(turn.text);
      rows.push({id: turn.id, who: turn.who, kind: turn.kind, v: turn.text, nude: !!turn.nude, picture: picture.mode, reply: result.text, ms: Date.now() - t0});
      if (!dump) console.log(`[${turn.id}] (${picture.mode}) V: ${turn.text}\n   -> ${result.text}`);
    } catch (error) {
      rows.push({id: turn.id, who: turn.who, kind: turn.kind, v: turn.text, picture: picture.mode, error: String(error?.kind ?? error?.name ?? error?.message ?? 'error').slice(0, 80)});
      console.log(`[${turn.id}] ERROR ${rows.at(-1).error}`);
    }
  }
} finally { host.close(); stopServer(); }
await mkdir(outDir, {recursive: true});
if (dump) {
  await writeFile(resolve(outDir, `${label}.dump.json`), JSON.stringify({label, root, requests: dumped}, null, 1));
  const sizes = dumped.map(messages => messages.reduce((total, m) => total + m.content.length, 0));
  console.log(`${dumped.length} requests written; prompt characters: mean ${Math.round(sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length))}, max ${Math.max(...sizes)}`);
} else {
  await writeFile(resolve(outDir, `${label}.json`), JSON.stringify({label, root, picture: pictureMode, at: new Date().toISOString(), requests, seconds: Math.round((Date.now() - started) / 1000), rows}, null, 1));
  console.log(`${requests} requests, ${Math.round((Date.now() - started) / 1000)} s`);
}
