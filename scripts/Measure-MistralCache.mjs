// Does Mistral's prompt cache explain the 0.5 s against 1.0 s "headers" time of a text turn, and would a warm-up request help?
// (docs/LATENCY_2026-10-12.md, section "2026-10-13".)
//
//   node scripts/Measure-MistralCache.mjs [--gaps 2,10,30,60,120] [--warm]
//
// Real `ministral-8b-latest` calls with a prompt the size of a real turn's (Judy's persona and rules from the roster, then a
// synthetic world block; the bridge's own `buildMessages` and `prompt_cache_key`). Each call differs only in the player's last message,
// so everything before it is the cacheable prefix. Reports time to response headers, time to the first text, and how many prompt
// tokens the server says it served from cache (`usage.prompt_tokens_details.cached_tokens`). Text only; no voice. The key is the one the
// bridge uses (runtime/player-mistral-key.txt), read in memory, never printed.
//
// --warm: before the last call of a gap, send the bridge-style warm-up (the same prefix, `max_tokens: 1`) and report that call too.
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {streamChat} from '../bridge/mistral-client.mjs';
import {PersonaBook, buildMessages, LIMITS} from '../bridge/mistral-prompt.mjs';
import {mistralRoute} from '../bridge/text-provider-host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const GAPS = String(option('--gaps', '2,10,30,60,120')).split(',').map(Number).filter(Number.isFinite);
const WARM = args.includes('--warm');
const KEY = (readFileSync(resolve(root, 'runtime/player-mistral-key.txt'), 'utf8').match(/[A-Za-z0-9_\-]{20,}/g) ?? []).pop();
if (!KEY) throw Error('no Mistral key');
const sleep = ms => new Promise(done => setTimeout(done, ms));

const roster = JSON.parse(readFileSync(resolve(root, 'characters/roster.json'), 'utf8'));
const persona = new PersonaBook(roster).persona('judy-alvarez');
const world = Array.from({length: 120}, (_, i) => `- Fact ${i + 1} about V and the world, supplied by the save: V met someone near district ${i % 9} and nothing more is known about it; do not invent details.`).join('\n');
const parts = {now: 'Right now (from the game, this turn only): It is night, about 11 PM, in Watson.', notes: 'Use {joy} tags for feelings.', world, volatile: 'Whether you ask V anything is your own call.'};
const messagesFor = text => buildMessages({persona, memory: 'I met V at the Clouds.', history: [{v: 'Hey Judy.', r: '{warm}Hey, V.'}], contextParts: parts, remembered: [], text, limits: LIMITS});
const route = mistralRoute({provider: {}, cacheScope: 'cache-probe'});
const extraBody = route.cacheBody('judy-alvarez');

let counter = 0;
async function call(label, {maxTokens = LIMITS.maxTokens} = {}) {
  const messages = messagesFor(`Probe ${++counter}: what are you working on right now?`);
  let headersMs, firstTokenMs, usage;
  const t0 = performance.now();
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init);
    headersMs = Math.round(performance.now() - t0);
    return response;
  };
  try {
    const chunks = [];
    const result = await streamChat({apiKey: KEY, model: 'ministral-8b-latest', messages, maxTokens, temperature: LIMITS.temperature, retries: 0, fetchImpl, extraBody,
      onDelta: (piece, soFar) => { if (firstTokenMs === undefined && piece) firstTokenMs = Math.round(performance.now() - t0); chunks.push(soFar.length); }});
    usage = result.usage;
    console.log(JSON.stringify({label, headersMs, firstTokenMs, totalMs: Math.round(performance.now() - t0), promptTokens: result.usage?.prompt_tokens, cached: result.usage?.prompt_tokens_details?.cached_tokens ?? result.usage?.num_cached_tokens}));
  } catch (error) {
    console.log(JSON.stringify({label, error: String(error?.message ?? error).replace(KEY, '[key]').slice(0, 160)}));
  }
  return usage;
}

console.log(JSON.stringify({promptChars: messagesFor('x').reduce((sum, m) => sum + m.content.length, 0)}));
await call('first call (cold)');
for (const gap of GAPS) {
  await sleep(gap * 1000);
  await call(`after ${gap} s idle`);
  if (WARM) { await sleep(gap * 1000); await call(`warm-up, then (${gap} s idle)`, {maxTokens: 1}); await sleep(1500); await call(`after the warm-up (${gap} s idle)`); }
}
