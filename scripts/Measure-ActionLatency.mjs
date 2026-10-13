#!/usr/bin/env node
// What the companion-action decision (bridge/text-actions.mjs) costs the player in waiting time, measured through the text host with
// REAL requests: the time from the turn start to the reply's first sentence (what the voice waits for; the whole reply when it has no
// separate first sentence) on the Mistral route or on a local llama-server, for three kinds of line, with and without actions.
//
//   node scripts/Measure-ActionLatency.mjs [--n 40] [--local <port>] [--old <folder>] [--label x]
//
//   kinds    plain  ordinary talk in a party member's chat (the game offers a leave in every such turn)
//            look   talk that mentions a car, a fight or leaving without asking for it (the decision is asked and says no)
//            asked  a plain request for the offered action (the decision is asked and says yes)
//   variants base   no actions at all (the reply as it was before actions existed)
//            new    this tree: screen, decision, speculative reply
//            seq    --seq: this tree without the overlap of decision and reply (a route with `parallel: false`)
//            old    --old <folder>: another tree of the repository (for example `git archive 098ee41d bridge | tar -x -C <folder>`),
//                   the bridge as it was when the decision came before every reply
// The variants take turns on every line, one request at a time, so drifts of the service hit all of them alike. --local needs a
// llama-server started by hand (the same convention as Eval-MistralPrompt.mjs --local). Mistral key: MISTRAL_API_KEY or the
// "Commonly used Keys.txt" line, in memory only. Output: a table and runtime/action-latency/<label>.json.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const perKind = Number(option('n', 40));
const localPort = Number(option('local', 0));
const oldRoot = option('old', '');
const label = option('label', 'run');
const KEYS_FILE = 'C:\\Users\\akshi\\Desktop\\Code Palace\\Commonly used Keys.txt';

const load = async root => {
  const at = file => import(pathToFileURL(resolve(root, 'bridge', file)).href);
  const [host, prompt, key, memory, stream, emotion, rate] = await Promise.all(['text-provider-host.mjs', 'mistral-prompt.mjs', 'mistral-key.mjs',
    'mistral-memory.mjs', 'reply-stream.mjs', 'emotion-tags.mjs', 'mistral-rate.mjs'].map(at));
  return {...host, ...prompt, ...key, ...memory, ...stream, ...emotion, ...rate};
};
const fresh = await load(project);
const old = oldRoot ? await load(resolve(oldRoot)) : null;
const {screenWords} = await import(pathToFileURL(resolve(project, 'bridge/text-action-words.mjs')).href);

async function mistralKey() {
  if (process.env.MISTRAL_API_KEY) return process.env.MISTRAL_API_KEY.trim();
  const text = await readFile(KEYS_FILE, 'utf8');
  const line = text.split(/\r?\n/).find(row => /^\s*mistral\s*[:=]/i.test(row));
  const value = line && /[:=]\s*(\S+)\s*$/.exec(line)?.[1];
  if (value) return value;
  throw Error('No Mistral key found');
}

const roster = [...JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8')), ...JSON.parse(await readFile(resolve(project, 'characters/archetype-roster.json'), 'utf8'))];
const apiKey = localPort ? 'local' : await mistralKey();

// The lines: ordinary talk, look-alikes and requests from the fixture the screen is tested with.
const phrases = JSON.parse(await readFile(resolve(project, 'bridge/fixtures/action-phrases.json'), 'utf8'));
const english = text => /^[\x20-\x7e\u2018\u2019\u201c\u201d]+$/.test(text);
const pick = (list, count) => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / count)) === 0).slice(0, count);
const kinds = {
  plain: pick(phrases.chat.filter(text => english(text) && !screenWords(text, {}).length), perKind).map(text => ({text, code: null})),
  look: pick(phrases.chat.filter(text => english(text) && screenWords(text, {}).length), perKind).map(text => ({text, code: 'DRIVE'})),
  asked: ['DRIVE', 'FIGHT', 'FOLLOW', 'LEAVE'].flatMap(code => pick(phrases.requests.filter(row => row.code === code && english(row.text)), Math.ceil(perKind / 4)).map(row => ({text: row.text, code: row.code}))),
};
const TOKEN = 'drive-0123456789abcdefghij';
const SELF_LEAVE = {leave: {members: [{name: 'Judy Alvarez', self: true}]}};
const offerFor = code => ({version: 1, token: TOKEN, source: 'private-text', expiresAt: 99999999, ...SELF_LEAVE,
  ...(code === 'DRIVE' ? {carName: 'Quadra Type-66', destinationName: 'Afterlife'} : {drive: false}),
  ...(code === 'FIGHT' ? {tactic: {targetName: 'Maelstrom Gonk', hostile: true, distance: 14, kinds: ['fight']}} : {}),
  ...(code === 'FOLLOW' ? {follow: {name: 'Judy Alvarez'}} : {})});

async function makeHost(tree, withActions) {
  const provider = new tree.MistralProvider({});
  provider.key = apiKey; provider.applied = localPort ? 'local' : 'mistral';
  const fakeServer = {status: () => ({state: 'ready'}), ensure: async () => ({apiKey: 'eval-local', endpoint: `http://127.0.0.1:${localPort}/v1/chat/completions`, model: 'local'}),
    begin: () => () => {}, touch() {}, prewarm: async () => {}};
  const routes = localPort ? {local: tree.localRoute({server: fakeServer, provider})}
    : {mistral: tree.mistralRoute({provider, model: () => ['ministral-8b-latest'], scheduler: tree.mistralScheduler, cacheScope: `latency-${label}`})};
  const memory = await tree.MistralMemory.open({path: null});
  return new tree.TextProviderHost({provider, memory, personas: new tree.PersonaBook(roster), log: () => {}, routes,
    ...(withActions ? {deliverAction: async () => true} : {})});
}
const variants = [
  {name: 'base', tree: fresh, actions: false},
  ...(process.argv.includes('--seq') ? [{name: 'seq', tree: fresh, actions: true, sequential: true}] : []),
  ...(old ? [{name: 'old', tree: old, actions: true}] : []),
  {name: 'new', tree: fresh, actions: true},
];
for (const variant of variants) {
  variant.host = await makeHost(variant.tree, variant.actions);
  // seq: this tree without the overlap (a route that serves one request at a time): the screen and the decision, then the reply.
  if (variant.sequential) for (const route of Object.values(variant.host.routes)) route.parallel = false;
}

async function turn(variant, line, kind) {
  const {tree, host} = variant;
  const stream = new tree.ReplyStream({name: 'Judy Alvarez', isTag: tree.hasEmotionTag, speak: false});
  const at = performance.now();
  let head = null;
  stream.onChange(() => { if (head === null && stream.head) head = performance.now() - at; });
  await host.reply({local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}, text: line.text, context: 'CURRENT PERSON: Judy Alvarez, a companion of V.',
    sessionId: undefined, ...(variant.actions ? {companionAction: offerFor(kind === 'plain' ? null : line.code)} : {})}, {stream});
  return {headMs: Math.round(head ?? performance.now() - at), wholeMs: Math.round(performance.now() - at)};
}

const rows = [];
for (const [kind, lines] of Object.entries(kinds)) {
  for (const line of lines) {
    for (const variant of variants) {
      try { rows.push({kind, variant: variant.name, text: line.text, ...await turn(variant, line, kind)}); }
      catch (error) { console.log(`  failed ${variant.name} ${kind}: ${String(error?.message ?? error).replace(apiKey, '***').slice(0, 100)}`); }
    }
  }
  console.log(`  ${kind}: ${lines.length} lines done`);
}
const quant = (list, q) => list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(q * list.length))] : null;
console.log(`\n${localPort ? `local llama-server :${localPort}` : 'Mistral ministral-8b'}: time to the first sentence (ms), median / p90\n`);
const table = [];
for (const kind of Object.keys(kinds)) {
  const cells = variants.map(variant => {
    const mine = rows.filter(row => row.kind === kind && row.variant === variant.name).map(row => row.headMs);
    return `${variant.name} ${String(quant(mine, 0.5)).padStart(5)} / ${String(quant(mine, 0.9)).padStart(5)} (${mine.length})`;
  });
  table.push(`  ${kind.padEnd(6)} ${cells.join('   ')}`);
}
console.log(table.join('\n'));
await mkdir(resolve(project, 'runtime/action-latency'), {recursive: true});
await writeFile(resolve(project, `runtime/action-latency/${label}.json`), JSON.stringify({label, at: new Date().toISOString(), local: localPort || null, rows}, null, 1));
for (const variant of variants) variant.host.close();
process.exit(0);
