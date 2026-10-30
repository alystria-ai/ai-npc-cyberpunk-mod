#!/usr/bin/env node
// Measures llama-server launch flags against each other on a realistic mod conversation (docs/LOCAL_AI_PERFORMANCE.md).
//
//   node scripts/Bench-LocalAiLaunch.mjs --dry                                   print the prompt sizes and the command lines, start nothing
//   node scripts/Bench-LocalAiLaunch.mjs --engine <llama-server.exe> --model <gguf> [options]
//
//   --variants a,b,c   which flag sets to compare, in this order (default main,cms256,poll0,threads4)
//                      main      the flags the mod launches today (buildServerArgs)
//                      swaoff    main without --swa-full (what the mod did before 29 Oct)
//                      kvq8      main with the 8-bit KV cache
//                      cms0, cms256, reuse256, poll0, threads4, ub1024, bs   main plus one CYBERPUNK_CONVAI_LOCAL_TUNING knob
//                      name=<tuning text>  main plus any tuning text, with + between knobs, for example  combo=checkpoint-step=256+poll=0
//   --scenarios talk,switch,mixed   talk: one character, N turns. switch: Judy, Panam, Judy again (the prompt cache). mixed: every turn followed by the companion action decision.
//   --turns 8          turns of the talk and mixed scenarios
//   --rounds 1         the variants run round after round (A B C, A B C) so a drifting laptop hits all of them alike
//   --sliding          the model has sliding-window layers (Gemma): main passes --swa-full, as the mod does when the card has room
//   --context 16384    -c. --device <id> picks a device (default: the largest discrete one)
//   --engine-prefix <script>   a script the engine runs first (a stand-in server for a test of this script)
//   --out <file>       JSON result (default runtime/bench-local-ai/<label>.json)
//
// Each variant starts its own llama-server on a free port, with the same environment the mod gives it (64 MiB graphics allocations), waits for /health, runs the scenarios with the
// SAME scripted conversation (the history is scripted, so the prompts are identical across variants), and stops it by its pid. It records per request the time to the first token,
// the prompt tokens read new and reused (llama-server's own `timings`), the generation speed, and per variant the graphics memory the server took (nvidia-smi, total used before and
// after) and its CPU seconds. Only one server runs at a time. Do not run it while a game test is under way: the numbers are meant for an idle machine in Balanced or Performance power mode.
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {spawn, execFile} from 'node:child_process';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const run = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const dry = argv.includes('--dry');
const prefix = option('engine-prefix') ? [option('engine-prefix')] : [];   // a script for the engine to run first (a stand-in server in a test)
const sliding = argv.includes('--sliding');
const label = option('label', new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'));
const turns = Math.max(2, Number(option('turns', 8)));
const rounds = Math.max(1, Number(option('rounds', 1)));
const contextSize = Number(option('context', 16384));
const scenarioNames = option('scenarios', 'talk,switch,mixed').split(',');
const variantNames = option('variants', 'main,cms256,poll0,threads4').split(',');
const at = rel => import(pathToFileURL(resolve(project, rel)).href);
const {PersonaBook, buildMessages, systemHead} = await at('bridge/mistral-prompt.mjs');
const {buildServerArgs, serverEnvironment, parseDeviceList, pickDevice} = await at('bridge/local-llm-server.mjs');
const {resolveLaunchTuning, TUNING_VARIABLE} = await at('bridge/local-launch-tuning.mjs');

// ---- The conversation ------------------------------------------------------------------------------------------------------------
const roster = JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8'));
const book = new PersonaBook(roster, {lean: true});
// A stable world block of about 4,300 tokens made of other characters' backstories, the size Judy's world zone has (docs/LOCAL_AI.md, 'Judy's prompt was read again on every turn').
const worldText = roster.filter(row => !['judy-alvarez', 'panam-palmer'].includes(row.key) && row.backstory).slice(0, 4).map(row => `${row.name}: ${String(row.backstory).slice(0, 3600)}`).join('\n\n');
const NOTES = 'Reply in one to three short spoken sentences. No stage directions. Speak as the character, to V.';
const nowText = n => n < 2 ? 'Right now: V is in the apartment, evening, rain on the window.' : 'Still: V is in the apartment, late evening, rain on the window.';
const LINES = [
  ['Hey, you awake?', 'Always, chica. What is it?'], ['Did you eat anything today?', 'Half a noodle cup. Do not look at me like that.'],
  ['Tell me about the Afterlife.', 'Loud, expensive, full of people pretending not to be scared.'], ['Do you trust Rogue?', 'With my life. With my drinks, less so.'],
  ['What would you do with a free week?', 'Sleep. Then probably break into something.'], ['Any news from the Mox?', 'Quiet. Too quiet, which is never good in this city.'],
  ['I was thinking about leaving Night City.', 'You say that every month. I would miss you though.'], ['Want to go for a drive?', 'Only if I pick the music.'],
  ['What is your favourite place in the city?', 'The roof of my building, when the smog clears. Rare.'], ['I got shot at today.', 'Of course you did. Show me where it hurts.'],
  ['Do you ever get scared?', 'Every day. Scared people stay careful.'], ['Thanks for listening.', 'Anytime. Now go sleep.']];
const history = (n, offset = 0) => Array.from({length: n}, (_, i) => ({v: LINES[(i + offset) % LINES.length][0], r: LINES[(i + offset) % LINES.length][1]}));
const messagesFor = (key, name, turn, offset = 0) => buildMessages({persona: book.persona(key, name), history: history(turn, offset),
  contextParts: {notes: NOTES, world: worldText, now: nowText(turn)}, text: LINES[(turn + offset) % LINES.length][0]});
const decisionOf = messages => [...messages, {role: 'user', content: 'Answer with one word, YES or NO: does V ask you to do something right now?'}];
const warmupOf = (key, name) => [{role: 'system', content: systemHead({persona: book.persona(key, name)})}, {role: 'user', content: 'hi'}];

const SCENARIOS = {
  talk: () => [{kind: 'warmup', messages: warmupOf('judy-alvarez', 'Judy Alvarez'), maxTokens: 1},
    ...Array.from({length: turns}, (_, i) => ({kind: 'turn', turn: i + 1, messages: messagesFor('judy-alvarez', 'Judy Alvarez', i)}))],
  switch: () => [['judy-alvarez', 'Judy Alvarez', 0], ['judy-alvarez', 'Judy Alvarez', 1], ['panam-palmer', 'Panam Palmer', 0], ['panam-palmer', 'Panam Palmer', 1],
    ['judy-alvarez', 'Judy Alvarez', 2], ['judy-alvarez', 'Judy Alvarez', 3]].map(([key, name, turn], i) => ({kind: 'turn', turn: i + 1, messages: messagesFor(key, name, turn)})),
  mixed: () => Array.from({length: turns}, (_, i) => [{kind: 'turn', turn: i + 1, messages: messagesFor('judy-alvarez', 'Judy Alvarez', i)},
    {kind: 'decision', turn: i + 1, messages: decisionOf(messagesFor('judy-alvarez', 'Judy Alvarez', i)), maxTokens: 6}]).flat(),
};

// ---- The variants ----------------------------------------------------------------------------------------------------------------
const KNOWN = {main: {}, swaoff: {swaFull: false}, kvq8: {kvType: 'q8_0'}, cms0: {tuning: 'checkpoint-step=0'}, cms256: {tuning: 'checkpoint-step=256'}, reuse256: {tuning: 'cache-reuse=256'},
  poll0: {tuning: 'poll=0'}, threads4: {tuning: 'threads=4'}, ub1024: {tuning: 'ubatch=1024'}, bs: {tuning: 'backend-sampling'}};
function variantOf(name) {
  if (KNOWN[name]) return {name, swaFull: sliding, ...KNOWN[name]};
  const [alias, ...rest] = name.split('=');
  if (rest.length) return {name: alias, swaFull: sliding, tuning: rest.join('=').replaceAll('+', ',')};
  throw Error(`unknown variant ${name}`);
}
const variants = variantNames.map(variantOf);
const commandLine = (variant, model, port, device) => {
  const tuning = resolveLaunchTuning({environment: {[TUNING_VARIABLE]: variant.tuning ?? ''}});
  return buildServerArgs({model, port, keyFile: 'KEYFILE', device, contextSize, cacheRamMiB: 4096, kvType: variant.kvType ?? null, swaFull: variant.swaFull, extraArgs: tuning.args});
};

// ---- Helpers ---------------------------------------------------------------------------------------------------------------------
const sleep = ms => new Promise(done => setTimeout(done, ms));
const freePort = () => new Promise((done, fail) => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const {port} = server.address(); server.close(() => done(port)); }); server.on('error', fail); });
async function gpuUsedMiB() {
  try { const {stdout} = await run('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], {timeout: 8000}); return Number(stdout.trim().split(/\r?\n/)[0]); } catch { return null; }
}
async function cpuSeconds(pid) {
  try { const {stdout} = await run('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`], {timeout: 15000}); return Number(stdout.trim()); } catch { return null; }
}
async function machineState() {
  const power = await run('powercfg', ['/getactivescheme'], {timeout: 8000}).then(r => r.stdout.trim(), () => 'unknown');
  const game = await run('tasklist', ['/FI', 'IMAGENAME eq Cyberpunk2077.exe', '/NH'], {timeout: 8000}).then(r => /Cyberpunk2077/i.test(r.stdout), () => null);
  return {power, gameRunning: game};
}

async function request(base, key, spec) {
  const body = {model: 'local', messages: spec.messages, max_tokens: spec.maxTokens ?? 70, temperature: 0, stream: true, cache_prompt: true, timings_per_token: false};
  const started = performance.now();
  const response = await fetch(`${base}/v1/chat/completions`, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${key}`}, body: JSON.stringify(body)});
  if (!response.ok) throw Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  let firstMs = null, timings = null, buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, {stream: true});
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut).trim(); buffer = buffer.slice(cut + 1);
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      let data; try { data = JSON.parse(line.slice(5)); } catch { continue; }
      if (firstMs === null && data.choices?.[0]?.delta?.content) firstMs = performance.now() - started;
      if (data.timings) timings = data.timings;
    }
  }
  return {kind: spec.kind, turn: spec.turn ?? null, firstMs: firstMs === null ? null : Math.round(firstMs), totalMs: Math.round(performance.now() - started),
    newTokens: timings?.prompt_n ?? null, cachedTokens: timings?.cache_n ?? null, promptMs: timings ? Math.round(timings.prompt_ms) : null,
    promptPerSecond: timings?.prompt_per_second ? Math.round(timings.prompt_per_second) : null, generated: timings?.predicted_n ?? null,
    tokensPerSecond: timings?.predicted_per_second ? Number(timings.predicted_per_second.toFixed(1)) : null};
}

async function runVariant(variant, {engine, model, device}) {
  const directory = await mkdtemp(join(tmpdir(), 'bench-local-ai-'));
  const keyFile = join(directory, 'key.txt'), key = `bench-${Math.random().toString(36).slice(2)}`;
  await writeFile(keyFile, key);
  const port = await freePort();
  const args = commandLine(variant, model, port, device).map(arg => arg === 'KEYFILE' ? keyFile : arg);
  const before = await gpuUsedMiB();
  const startedAt = performance.now();
  const child = spawn(engine, [...prefix, ...args], {env: {...process.env, ...serverEnvironment(process.env)}, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true});
  const result = {variant: variant.name, tuning: variant.tuning ?? null, args: args.filter(arg => arg !== keyFile).join(' '), scenarios: {}};
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let waited = 0; ; waited += 500) {
      if (child.exitCode !== null) throw Error(`llama-server exited with ${child.exitCode}`);
      if (waited > 240_000) throw Error('llama-server did not become ready in 240 s');
      try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
      await sleep(500);
    }
    result.loadSeconds = Number(((performance.now() - startedAt) / 1000).toFixed(1));
    result.vramMiB = (await gpuUsedMiB()) - before;
    const cpuStart = await cpuSeconds(child.pid);
    for (const name of scenarioNames) {
      // Each scenario starts from a slot that holds something unrelated, so the first turn is a real cold read.
      await request(base, key, {kind: 'reset', messages: [{role: 'user', content: `Unrelated text ${Math.random()}. Say OK.`}], maxTokens: 2});
      const rows = [];
      for (const spec of SCENARIOS[name]()) rows.push(await request(base, key, spec));
      result.scenarios[name] = rows;
    }
    result.cpuSeconds = Number(((await cpuSeconds(child.pid)) - cpuStart).toFixed(1));
    result.vramAfterMiB = (await gpuUsedMiB()) - before;
  } finally {
    if (child.exitCode === null) await run('taskkill', ['/PID', String(child.pid), '/T', '/F'], {timeout: 15000}).catch(() => {});
    await rm(directory, {recursive: true, force: true}).catch(() => {});
  }
  return result;
}

const median = list => { const sorted = list.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
function summarise(results) {
  const lines = [];
  for (const name of scenarioNames) {
    lines.push(`\nscenario ${name}: per variant, over ${rounds} round(s). first = time to first token (ms, median of turns after the first), new = prompt tokens read new (median, later turns), turn1 = new tokens of the first turn, sum = all new tokens, gen = tokens/s`);
    for (const variant of variants) {
      const runs = results.filter(item => item.variant === variant.name && item.scenarios[name]);
      const rows = runs.flatMap(item => item.scenarios[name].filter(row => row.kind === 'turn'));
      const later = rows.filter(row => row.turn > 1);
      const text = [`first ${median(later.map(row => row.firstMs))}`, `new ${median(later.map(row => row.newTokens))}`, `turn1 ${median(rows.filter(row => row.turn === 1).map(row => row.newTokens))}`,
        `sum ${Math.round(rows.reduce((total, row) => total + (row.newTokens ?? 0), 0) / Math.max(1, runs.length))}`, `gen ${median(rows.map(row => row.tokensPerSecond))}`];
      lines.push(`  ${variant.name.padEnd(10)} ${text.join('   ')}`);
    }
  }
  lines.push('\nper variant: load seconds / graphics memory taken (MiB) / CPU seconds over the scenarios');
  for (const variant of variants) {
    const runs = results.filter(item => item.variant === variant.name);
    lines.push(`  ${variant.name.padEnd(10)} load ${median(runs.map(item => item.loadSeconds))}   vram ${median(runs.map(item => item.vramMiB))}   cpu ${median(runs.map(item => item.cpuSeconds))}`);
  }
  return lines.join('\n');
}

// ---- Main ------------------------------------------------------------------------------------------------------------------------
if (dry) {
  for (const name of scenarioNames) {
    const specs = SCENARIOS[name]();
    const chars = spec => spec.messages.reduce((total, message) => total + message.content.length, 0);
    console.log(`${name}: ${specs.length} requests, first prompt ${chars(specs.find(spec => spec.kind === 'turn'))} characters (about ${Math.round(chars(specs.find(spec => spec.kind === 'turn')) / 3.6)} tokens), last ${chars(specs.at(-1))} characters`);
  }
  for (const variant of variants) console.log(`${variant.name.padEnd(10)} llama-server ${commandLine(variant, 'MODEL.gguf', 8080, 'Vulkan1').filter(arg => arg !== 'KEYFILE').join(' ')}`);
  process.exit(0);
}
const engine = option('engine'), model = option('model');
if (!engine || !model) { console.error('--engine <llama-server.exe> and --model <gguf> are required (or --dry)'); process.exit(2); }
const listing = await run(engine, [...prefix, '--list-devices'], {timeout: 60_000}).then(r => r.stdout + r.stderr, error => String(error.stdout ?? '') + String(error.stderr ?? ''));
const device = option('device') ?? pickDevice(parseDeviceList(listing))?.id;
if (!device) { console.error('no graphics device found'); process.exit(2); }
const state = await machineState();
console.log(`device ${device}, context ${contextSize}, ${sliding ? 'sliding-window model (main passes --swa-full)' : 'no --swa-full in main'}`);
console.log(`power: ${state.power}\ngame running: ${state.gameRunning}`);
const results = [];
const out = resolve(project, option('out', `runtime/bench-local-ai/${label}.json`));
await mkdir(dirname(out), {recursive: true});
// The file is rewritten after every variant, so a run that is stopped keeps what it measured.
const save = () => writeFile(out, JSON.stringify({label, at: new Date().toISOString(), engine, model, device, contextSize, sliding, state, results}, null, 1));
for (let round = 1; round <= rounds; round++) {
  for (const variant of variants) {
    console.log(`round ${round}: ${variant.name} ...`);
    try { results.push({round, ...await runVariant(variant, {engine, model, device})}); }
    catch (error) { console.log(`  failed: ${String(error.message ?? error).slice(0, 200)}`); results.push({round, variant: variant.name, failed: String(error.message ?? error)}); }
    await save();
  }
}
console.log(summarise(results.filter(item => !item.failed)));
console.log(`\nwritten ${out}`);
process.exit(0);
