#!/usr/bin/env node
// How the prompt of a text provider (Local AI, Gemini, a Custom endpoint, the Mistral preset) grows over a long play session, and where its start changes from one
// turn to the next (docs/PROMPT_GROWTH.md). The real TextProviderHost, MistralMemory, PersonaBook, buildMessages, the prompt budget and the real conversation blocks
// of bridge/quest-context.mjs (the right-now block, journal, gear) build every request. Only the game's world snapshot is stood in for (the "knowledge", "history" and
// "jobs" blocks are text of the sizes the real ones have, chosen by the words of the talk the way the real ones are) and the memory store's retrieval (a list of facts per
// character that grows as the talk goes on, ranked by the words of V's line, at most 4 and 1,200 characters as MemoryStore.retrieve is).
//
//   node scripts/Study-PromptGrowth.mjs [--turns 100] [--slide 3] [--batch 8] [--window 8] [--points 1,10,30,60,100] [--variant current|<name>] [--endpoint <url> --key <key> | --serve <llama-server.exe> --model <gguf> [--sliding] [--context 16384]] [--gemini --turns 30 [--pace 5500]] [--out <file>]
//
// Without --endpoint a fake provider server answers (short replies; the summary request gets a summary), so nothing leaves the machine. With --endpoint every turn is a
// real request to that OpenAI-compatible server (a llama-server started by hand) and the time to the first token is recorded from the stream.
// Output: a table per checkpoint turn of Judy's talk (tokens of each part of the prompt, estimated at 4 characters a token) and, for every turn, the first place where the
// prompt differs from the previous prompt of the same character, named by the part it falls in.
import {createServer} from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const TURNS = Number(option('turns', 100));
const POINTS = option('points', '1,10,30,60,100').split(',').map(Number);
let ENDPOINT = option('endpoint', '');
let KEY = option('key', 'study-key');
const SERVE = option('serve', '');   // a llama-server.exe to start for the run (with --model), stopped by its pid at the end
const OUT = option('out', '');
const GEMINI = argv.includes('--gemini');   // real calls to Google's free Gemini endpoint (the key is read from the keys file, in memory only)
const PACE_MS = Number(option('pace', GEMINI ? 5500 : 0));
const ONLY_JUDY = argv.includes('--judy-only') || GEMINI;
const CHARS_PER_TOKEN = 4;
const at = rel => import(pathToFileURL(resolve(project, rel)).href);
const {PersonaBook, joinBlocks, worldBlocksInCacheOrder, freshParts, LIMITS} = await at('bridge/mistral-prompt.mjs');
const {BASE_PROFILE} = await at('bridge/prompt-profiles.mjs');
const {TextProviderHost, localRoute, customRoute} = await at('bridge/text-provider-host.mjs');
const {CustomEndpoint, parseEndpointUrl, PRESETS} = await at('bridge/custom-endpoint.mjs');
const {MistralMemory, MEMORY_LIMITS} = await at('bridge/mistral-memory.mjs');
const {MistralProvider} = await at('bridge/mistral-key.mjs');
const {parseInput} = await at('bridge/protocol.mjs');
const {conversationContextBlocks} = await at('bridge/quest-context.mjs');
const {TopicWords} = await at('bridge/topic-words.mjs');

const roster = [...JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8')), ...JSON.parse(await readFile(resolve(project, 'characters/archetype-roster.json'), 'utf8'))];
const book = new PersonaBook(roster, {lean: true});

// ---- The world, stood in -----------------------------------------------------------------------------------------------------------
const TOPICS = ['pyramid song', 'afterlife', 'braindance', 'arasaka', 'rogue', 'mox', 'delamain', 'badlands', 'aldecaldos', 'maelstrom', 'tyger claws', 'kabuki', 'japantown', 'heywood', 'the clouds', 'a quiet apartment',
  'coffee from japantown', 'my old car', 'the relic', 'johnny', 'the blackwall', 'night city weather', 'noodles', 'the cyberpsycho', 'a free week', 'leaving the city', 'the nomads', 'a good set of tools', 'the basilisk', 'dreams'];
const FACTS = Array.from({length: 80}, (_, i) => {
  const topic = TOPICS[i % TOPICS.length];
  return `Fact ${i}: ${topic} matters in Night City because ${['a fixer', 'a netrunner', 'a nomad', 'a corpo', 'a ripperdoc'][i % 5]} once explained it to V in the middle of a job, and the details are still ${['sharp', 'blurry', 'disputed'][i % 3]} ${'in the way people tell it at the bar '.repeat(1)}near ${topic}.`;
});
const QUESTS = Array.from({length: 24}, (_, i) => `Quest ${i} (${TOPICS[(i * 7) % TOPICS.length]}): ${'V finished the objective and the people involved remember it differently; the outcome changed who talks to V. '.repeat(5)}`.replaceAll(';', ','));
const TOPIC_WORDS = new Set(TOPICS.flatMap(topic => topic.split(' ')).filter(word => word.length > 3));
const rank = (pool, topics, take, seed = 0) => {
  const words = new Set(topics.split(/\s+/).filter(word => TOPIC_WORDS.has(word)));
  return pool.map((text, index) => ({text, index, score: text.toLowerCase().split(/[^a-z0-9]+/).filter(word => words.has(word)).length * 100 - index * 0.01 - seed})).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, take).sort((a, b) => a.index - b.index).map(item => item.text);
};
const topicWords = new TopicWords({idleMs: 3_600_000});

// ---- V's lines and the replies ------------------------------------------------------------------------------------------------------
const lineOf = (n, who) => {
  // V stays on a topic for eight lines, then moves to another one.
  const topic = TOPICS[(Math.floor(n / 8) * 7 + who.length) % TOPICS.length];
  const forms = [`What do you think about ${topic}?`, `I keep coming back to ${topic}, does it mean anything to you?`, `Remember ${topic}? Tell me what you really felt then.`,
    `Hey ${who}, quick one about ${topic}.`, `Honestly I would rather talk about ${topic} than the job tonight, is that strange?`, `Do you ever think about ${topic} when it rains?`];
  return forms[n % forms.length] + (n % 5 === 0 ? ' It has been on my mind for days and I could use a straight answer for once, not a joke.' : '');
};
// A spoken reply is one to three sentences (about 200 characters, 50 tokens), the length the persona rules ask for.
const REPLIES = ['Mm. Straight answer? It matters more than you let on, and you know it. I have seen what happens when people pretend it does not, and it is never pretty.',
  'Funny you ask. I had the same thought, back when things were quieter. Some nights it is all I can think about, and then the city pulls me right back out of it.',
  'Choom, you are overthinking this, but I like that you care. Let us see where the night takes us, and if it goes sideways, we will deal with it together.',
  'Honestly, I do not know. Ask me again when we are not being shot at. Ask me over a drink, maybe, somewhere with no windows and no clients and no clocks.'];
const replyOf = n => REPLIES[n % 4];
const summaryText = n => `V and I have talked about many things. ${Array.from({length: 9}, (_, i) => `V mentioned ${TOPICS[(n + i) % TOPICS.length]} and what it meant to them.`).join(' ')}`.slice(0, 1300);

// ---- The provider (fake, or a real server) ----------------------------------------------------------------------------------------
const captured = [];
let summaries = 0;
async function fakeProvider() {
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      captured.push(body);
      const isSummary = /private memory/.test(body.messages?.[0]?.content ?? '');
      const answer = isSummary ? summaryText(++summaries) : replyOf(captured.length);
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: answer}}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
}
// --serve: the real llama-server with the flags the mod launches (buildServerArgs), on a free port, with a key file; stopped by its pid when the run ends.
let child = null, serveDir = null;
async function startServer() {
  const {spawn, execFile} = await import('node:child_process');
  const {mkdtemp, writeFile: write, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {createServer: net} = await import('node:net');
  const {promisify} = await import('node:util');
  const {buildServerArgs, serverEnvironment, parseDeviceList, pickDevice} = await at('bridge/local-llm-server.mjs');
  const listing = await promisify(execFile)(SERVE, ['--list-devices'], {timeout: 60_000}).then(r => r.stdout + r.stderr, e => String(e.stdout ?? '') + String(e.stderr ?? ''));
  const device = pickDevice(parseDeviceList(listing))?.id;
  if (!device) throw Error('no graphics device found');
  serveDir = await mkdtemp(`${tmpdir()}/study-prompt-growth-`);
  KEY = `study-${Math.random().toString(36).slice(2)}`;
  const keyFile = `${serveDir}/key.txt`; await write(keyFile, KEY);
  const port = await new Promise((done, fail) => { const probe = net(); probe.listen(0, '127.0.0.1', () => { const {port: free} = probe.address(); probe.close(() => done(free)); }); probe.on('error', fail); });
  const args = buildServerArgs({model: option('model'), port, keyFile, device, contextSize: Number(option('context', 16384)), cacheRamMiB: 4096, swaFull: argv.includes('--sliding')});
  child = spawn(SERVE, args, {env: {...process.env, ...serverEnvironment(process.env)}, stdio: 'ignore', windowsHide: true});
  const base = `http://127.0.0.1:${port}`;
  for (let waited = 0; ; waited += 500) {
    if (child.exitCode !== null) throw Error(`llama-server exited with ${child.exitCode}`);
    if (waited > 240_000) throw Error('llama-server was not ready in 240 s');
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise(done => setTimeout(done, 500));
  }
  ENDPOINT = `${base}/v1/chat/completions`;
  const stop = async () => {
    if (child && child.exitCode === null) await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], {timeout: 15000}).catch(() => {});
    if (serveDir) await rm(serveDir, {recursive: true, force: true}).catch(() => {});
  };
  process.on('exit', () => { try { child?.kill(); } catch { /* gone */ } });
  return stop;
}
const stopServer = SERVE ? await startServer() : async () => {};
const provider_ = ENDPOINT ? {endpoint: ENDPOINT, close: async () => {}} : await fakeProvider();

const logs = [];
let provider, route;
if (GEMINI || ENDPOINT) {
  // The requests are recorded as they leave (the fake server does that for the other modes).
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if ((String(url).includes('generativelanguage') || (ENDPOINT && String(url) === ENDPOINT)) && typeof init?.body === 'string') { try { captured.push(JSON.parse(init.body)); } catch { /* not JSON */ } } return realFetch(url, init); };
}
if (GEMINI) {
  const text = await readFile('C:/Users/akshi/Desktop/Code Palace/Commonly used Keys.txt', 'utf8');
  const key = /^\s*googlegemin\w*\s*[:=]\s*(\S+)/im.exec(text)?.[1];
  if (!key) throw Error('no Gemini key line in the keys file');
  const custom = new CustomEndpoint({path: null});
  await custom.setUrl(parseEndpointUrl(PRESETS.gemini.endpoint)); await custom.setModel(option('model', PRESETS.gemini.model)); await custom.setKey(key);
  provider = new MistralProvider({keyPath: 'k', readText: async () => { throw Error('none'); }, writeText: async () => {}, custom});
  await provider.load(); provider.setPreference('custom'); provider.apply();
  route = {custom: customRoute({provider, custom, log: line => logs.push(line)})};
} else {
  provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
  await provider.load(); provider.setPreference('local'); provider.apply();
}
const SLIDE = Number(option('slide', MEMORY_LIMITS.slide));
const BATCH = Number(option('batch', MEMORY_LIMITS.batch));
const WINDOW = Number(option('window', MEMORY_LIMITS.turns));
const memory = await MistralMemory.open({path: null, limits: {...MEMORY_LIMITS, turns: WINDOW, slide: SLIDE, batch: BATCH}});
// The retrieval of the memory store, stood in: facts that accumulate per character (one every three turns), ranked by the words of V's line, 4 at most and 1,200 characters.
const known = new Map();
memory.retrieve = async ({profileKey, query}) => {
  const list = known.get(profileKey) ?? [];
  return rank(list, String(query).toLowerCase(), 4).map((text, id) => ({id: `m${id}`, text: text.slice(0, 240)}));
};
const server = {status: () => ({state: 'ready'}), ensure: async () => ({endpoint: provider_.endpoint, apiKey: KEY, model: 'local', tier: 'standard'}), touch() {}, prewarm: async () => {}};
const host = new TextProviderHost({provider, memory, personas: book, routes: route ?? {local: localRoute({server, provider})}, log: line => logs.push(line), limits: {...LIMITS, turns: Math.max(LIMITS.turns, WINDOW + SLIDE)}});

// ---- The turns ----------------------------------------------------------------------------------------------------------------------
const CAST = [
  {key: 'judy-alvarez', name: 'Judy Alvarez', journalQuest: 'Pisces', objective: 'Meet Judy at the Clouds basement'},
  {key: 'panam-palmer', name: 'Panam Palmer', journalQuest: 'Riders on the Storm', objective: 'Return to the Aldecaldos camp'},
  {key: 'jackie-welles', name: 'Jackie Welles', journalQuest: 'The Rescue', objective: 'Talk to Jackie'}];
const SCHEDULE = ['judy-alvarez', 'judy-alvarez', 'judy-alvarez', 'panam-palmer', 'judy-alvarez', 'judy-alvarez', 'jackie-welles', 'judy-alvarez', 'judy-alvarez', 'judy-alvarez'];
const talkCount = new Map();
const rows = [];
const previous = new Map();
let clock = 20 * 60 + 5;

// The parts of a prompt, named by where they begin: the system message by its headings, then the exchanges, then the last message.
const L = BASE_PROFILE.labels;
function segments(messages) {
  const parts = [];
  const system = messages[0].content;
  const marks = [['persona', 0], ['notes', system.indexOf(L.formatNotes)], ['world', system.indexOf(L.world)], ['summary', system.indexOf(L.remember)], ['knowledge', system.indexOf(L.knowledge)], ['now', system.indexOf(L.rightNow)]]
    .filter(([, index]) => index >= 0).sort((a, b) => a[1] - b[1]);
  marks.forEach(([name, start], i) => parts.push({name: `system:${name}`, text: system.slice(start, i + 1 < marks.length ? marks[i + 1][1] : system.length)}));
  const exchanges = messages.slice(1, -1);
  exchanges.forEach((message, i) => parts.push({name: `history:${Math.floor(i / 2) + 1}`, text: message.content}));
  parts.push({name: 'last user message', text: messages.at(-1).content});
  return parts;
}
const flatten = messages => messages.map(message => `<${message.role}>${message.content}`).join('\n');
function firstDifference(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}
function nameAt(parts, offset) {
  let at = 0;
  for (const part of parts) {
    const size = part.text.length + 1;
    if (offset < at + size) return part.name;
    at += size;
  }
  return 'end';
}

// A change in the exchange that follows the previous prompt's last one is the new exchange itself (the previous last message carried the notes, the history carries only V's line): the cheapest case.
const classify = (name, exchanges) => name.startsWith('history:') ? (Number(name.slice(8)) === Math.ceil(exchanges / 2) + 1 ? 'new exchange' : name === 'history:1' ? 'history window moved' : 'history ' + name.slice(8)) : name === 'last user message' ? 'new exchange' : name;
for (let turnIndex = 0; turnIndex < TURNS * 1.6; turnIndex++) {
  const who = CAST.find(item => item.key === (ONLY_JUDY ? 'judy-alvarez' : SCHEDULE[turnIndex % SCHEDULE.length]));
  const n = (talkCount.get(who.key) ?? 0) + 1;
  talkCount.set(who.key, n);
  if (who.key === 'judy-alvarez' && n > TURNS) break;
  clock += 1 + (n % 3 === 0 ? 2 : 0);
  const text = lineOf(n, who.name.split(' ')[0]);
  // The game's side of the turn: the clock moves, the place changes now and then, the quest progresses every 15th turn, V's clothes change every 40th.
  const district = ['Westbrook', 'Watson', 'Heywood'][Math.floor(n / 25) % 3];
  const raw = {requestId: `${100 + turnIndex}-1-11ULL`, generation: 1, entity: '11ULL', profileKey: who.key, name: who.name, bodyType: 'WomanAverage', text,
    turnContext: {version: 1, status: 'ready', hour: Math.floor(clock / 60) % 24, minute: clock % 60, district, area: ['Japantown', 'Kabuki', 'Pacifica'][Math.floor(n / 25) % 3], gender: 'female', lifepath: 'streetkid', vehicle: Math.floor(n / 20) % 2 === 1},
    journal: {version: 1, status: 'active', quest: {id: '1234567', title: who.journalQuest, objectives: [{id: '1', text: `${who.objective} (step ${Math.floor(n / 15) + 1})`, tracked: true}]}},
    gear: {version: 1, status: 'ready', clothing: [{slot: 'outerTorso', name: Math.floor(n / 40) % 2 ? 'Bomber Jacket' : 'Samurai Jacket'}, {slot: 'feet', name: 'Combat Boots'}], weapons: [{slot: 'hand', name: 'Kyubi'}], cyberware: []}};
  const input = parseInput(JSON.stringify(raw));
  if (!input) throw Error('the turn was not accepted by the bridge parser');
  const blocks = conversationContextBlocks(input).filter(block => block.tier !== 'world' || block.key === undefined || !['knowledge', 'story', 'recency', 'history', 'jobs'].includes(block.key));
  const topics = topicWords.fold(who.key, text, turnIndex * 60_000);
  // The stood-in world snapshot, in the places the real blocks sit (conversationContextBlocks): ranked by the words of the whole talk, as the real ones are since 29 Oct.
  const standIn = [
    {tier: 'world', key: 'knowledge', text: `World facts V knows (current save):\n${rank(FACTS, topics, 14).join('\n')}`},
    {tier: 'world', key: 'story', text: `What you know of the main story:\n${QUESTS.slice(0, 3).join('\n')}`},
    {tier: 'world', key: 'history', text: `Journal history:\n${QUESTS.slice(3, 6).join('\n')}\n${rank(QUESTS.slice(6), topics, 3).join('\n')}`},
    {tier: 'world', key: 'jobs', text: `Jobs on offer:\n${QUESTS.slice(18, 21).join('\n').slice(0, 900)}`}];
  const all = [...blocks.slice(0, 5), ...standIn, ...blocks.slice(5)];
  const world = worldBlocksInCacheOrder(all.filter(block => block.tier === 'world'));
  const contextParts = {...Object.fromEntries(['now', 'notes', 'volatile', 'closing'].map(tier => [tier, joinBlocks(all.filter(block => block.tier === tier).map(block => block.text))])),
    world: joinBlocks(world.map(block => block.text)), worldBlocks: world.filter(block => block.text).map(block => ({key: block.key, text: block.text})), ...freshParts(all)};
  // The facts the character has learned of V so far: one more every third turn.
  if (n % 3 === 1) known.set(who.key, [...(known.get(who.key) ?? []), `V told me about ${TOPICS[(n * 5) % TOPICS.length]} on night ${n}, and it still comes back to them when it rains.`]);
  const seen = captured.length;
  const seenLogs = logs.length;
  const started = performance.now();
  let firstMs = null;
  const stream = {onChange() {}, fail() {}, push() {}, head: '', finish() {}};
  await host.reply({text, context: joinBlocks(all.map(block => block.text)), contextParts, sessionId: 's', local: {profileKey: who.key, name: who.name, channel: 'private'}}, {});
  const totalMs = Math.round(performance.now() - started);
  if (PACE_MS) await new Promise(done => setTimeout(done, PACE_MS));
  // The quiet moment after a reply in which the host folds older exchanges into the summary (a real player's turns are seconds apart).
  for (let waited = 0; waited < 3000; waited += 10) { await new Promise(done => setTimeout(done, 10)); if (waited >= 30 && host.summaries.size === 0) break; }
  // The request of this turn is the last chat request that is not a summary.
  const local = logs.slice(seenLogs).map(line => /^\[LocalTurn\] ok.*?first word (\d+) ms.*?prompt (\d+) new \+ (\d+) cached tokens/.exec(line)).filter(Boolean).at(-1);
  const cloud = logs.slice(seenLogs).map(line => /^\[CloudTurn\] \S+ prompt (\d+) new \+ (\d+) cached tokens(?:.*first word (\d+) ms)?/.exec(line)).filter(Boolean).at(-1);
  const chat = captured.slice(seen).filter(body => !/private memory/.test(body.messages?.[0]?.content ?? '')).at(-1);
  if (!chat) { rows.push({who: who.key, n, missing: true}); continue; }
  const messages = chat.messages;
  const parts = segments(messages);
  const flat = flatten(messages);
  const before = previous.get(who.key);
  const shared = before ? firstDifference(before.flat, flat) : 0;
  const row = {who: who.key, n, turn: turnIndex + 1, chars: flat.length, tokens: Math.round(flat.length / CHARS_PER_TOKEN), totalMs,
    parts: Object.fromEntries(parts.reduce((map, part) => { const key = part.name.startsWith('history') ? 'history' : part.name; map.set(key, (map.get(key) ?? 0) + Math.round(part.text.length / CHARS_PER_TOKEN)); return map; }, new Map())),
    sharedTokens: Math.round(shared / CHARS_PER_TOKEN), newTokens: Math.round((flat.length - shared) / CHARS_PER_TOKEN), local: local ? {firstMs: Number(local[1]), newTokens: Number(local[2]), cachedTokens: Number(local[3])} : null, cloud: cloud ? {newTokens: Number(cloud[1]), cachedTokens: Number(cloud[2]), firstMs: cloud[3] ? Number(cloud[3]) : null} : null, changedAt: before ? classify(nameAt(parts, shared), before.exchanges) : 'first turn', summaries: summaries};
  if (before && process.env.STUDY_DUMP && who.key === 'judy-alvarez' && n <= Number(process.env.STUDY_DUMP)) console.log(`turn ${n} differs at ${row.changedAt}: ...${JSON.stringify(before.flat.slice(Math.max(0, shared - 60), shared + 160))}  ->  ...${JSON.stringify(flat.slice(Math.max(0, shared - 60), shared + 160))}`);
  const mem = memory.rows.get(who.key);
  row.unseen = mem?.overflow.length ?? 0;
  rows.push(row);
  previous.set(who.key, {flat, parts, exchanges: parts.filter(part => part.name.startsWith('history:')).length});
}

// ---- The report ----------------------------------------------------------------------------------------------------------------------
const judy = rows.filter(row => row.who === 'judy-alvarez' && !row.missing);
const columns = ['system:persona', 'system:notes', 'system:world', 'system:summary', 'system:knowledge', 'system:now', 'history', 'last user message'];
console.log(`Judy's talk, tokens of each part (${CHARS_PER_TOKEN} characters a token), at the checkpoint turns`);
console.log(['turn', ...columns.map(name => name.replace('system:', '').replace(' message', '')), 'total', 'shared', 'new', 'changed at'].map(cell => String(cell).padStart(10)).join(' '));
for (const point of POINTS) {
  const row = judy.find(item => item.n === point);
  if (!row) continue;
  console.log([row.n, ...columns.map(name => row.parts[name] ?? 0), row.tokens, row.sharedTokens, row.newTokens, row.changedAt].map(cell => String(cell).padStart(10)).join(' '));
}
const later = judy.filter(row => row.n > 1);
const breaks = {}, cost = {};
for (const row of later) { breaks[row.changedAt] = (breaks[row.changedAt] ?? 0) + 1; cost[row.changedAt] = (cost[row.changedAt] ?? 0) + row.newTokens; }
console.log(`\nWhere Judy's prompt first differed from her previous prompt, over ${later.length} turns:`);
for (const [name, count] of Object.entries(breaks).sort((a, b) => cost[b[0]] - cost[a[0]])) console.log(`  ${name.padEnd(24)} ${String(count).padStart(4)} turns, ${String(cost[name]).padStart(6)} new tokens (${Math.round(cost[name] / count)} a turn)`);
const mean = list => list.length ? Math.round(list.reduce((sum, value) => sum + value, 0) / list.length) : 0;
console.log(`\nnew tokens per turn (mean): turns 2 to 10 ${mean(later.filter(r => r.n <= 10).map(r => r.newTokens))}, turns 11 to 30 ${mean(later.filter(r => r.n > 10 && r.n <= 30).map(r => r.newTokens))}, `
  + `turns 31 to 60 ${mean(later.filter(r => r.n > 30 && r.n <= 60).map(r => r.newTokens))}, turns 61 to 100 ${mean(later.filter(r => r.n > 60).map(r => r.newTokens))}`);
console.log(`exchanges the character cannot see (rolled out of the history, not yet in the shown summary): mean ${(judy.reduce((sum, r) => sum + (r.unseen ?? 0), 0) / judy.length).toFixed(1)}, most ${Math.max(...judy.map(r => r.unseen ?? 0))}`);
console.log(`prompt tokens: turn 1 ${judy[0]?.tokens}, turn 10 ${judy.find(r => r.n === 10)?.tokens}, turn 100 ${judy.find(r => r.n === 100)?.tokens}; summaries written ${summaries}`);
const served = judy.filter(row => row.local);
if (served.length) {
  const at = list => list.length ? Math.round(list.reduce((sum, v) => sum + v, 0) / list.length) : 0;
  console.log(`
local llama-server, the server's own numbers (${served.length} turns). turn / new tokens read / cached / first word ms`);
  for (const row of served.filter(r => POINTS.includes(r.n))) console.log(`  ${String(row.n).padStart(3)} ${String(row.local.newTokens).padStart(6)} ${String(row.local.cachedTokens).padStart(6)} ${String(row.local.firstMs).padStart(6)}  (${row.changedAt})`);
  for (const [from, to] of [[2, 10], [11, 30], [31, 60], [61, 100]]) { const part = served.filter(r => r.n >= from && r.n <= to); if (part.length) console.log(`  turns ${from} to ${to}: new ${at(part.map(r => r.local.newTokens))}, first word ${at(part.map(r => r.local.firstMs))} ms (mean of ${part.length})`); }
}
const clouded = judy.filter(row => row.cloud);
if (clouded.length) {
  console.log(`
provider usage (${clouded.length} turns): turn / prompt new / cached / share cached / our own estimate of the new tokens / first word ms`);
  for (const row of clouded) console.log(`  ${String(row.n).padStart(3)} ${String(row.cloud.newTokens).padStart(6)} ${String(row.cloud.cachedTokens).padStart(6)} ${String(Math.round(100 * row.cloud.cachedTokens / Math.max(1, row.cloud.newTokens + row.cloud.cachedTokens))).padStart(4)}% ${String(row.newTokens).padStart(6)} ${String(row.cloud.firstMs ?? '-').padStart(6)}  (${row.changedAt})`);
}
if (OUT) { await mkdir(dirname(resolve(OUT)), {recursive: true}); await writeFile(resolve(OUT), JSON.stringify({at: new Date().toISOString(), rows}, null, 1)); console.log(`written ${resolve(OUT)}`); }
host.close();
await provider_.close();
await stopServer();
process.exit(0);
