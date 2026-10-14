#!/usr/bin/env node
// Measures the Groq route's prompt offline (docs/LATENCY_2026-10-14.md): what the route sends for a named character's turn with the
// compact shaping off (the 2026-10-12 behaviour: the whole prompt, cut only to fit one request into 8,000 tokens) and on
// (bridge/groq-prompt.mjs), through the real `groqRoute` chat wrapper and `budgetedChat`. The model call is a stub that counts the
// request's tokens; no network, no key, no Groq or Mistral call.
//
//   node scripts/Measure-GroqPrompt.mjs [--json] [--gap-seconds 20] [--turns 12]
//
// Reports: characters and estimated tokens per request (the budget's own estimate at its default 3.6 characters a token, and at
// 4.2, which the prompt really measures), what the budget cut, the prompt build + fit time, and how many of `--turns` turns spaced
// `--gap-seconds` apart the free plan (8,000 tokens a minute, a sliding window over prompt + reply) would answer before the host falls
// back to Mistral (or, with no Mistral key, to Convai), for three prompts: Judy with every optional block on (Expressive emotion notes and the Natural speech offer), Judy with
// those off, and an unnamed archetype NPC. Also checks that the prompt other providers get is unchanged (the hash of `buildMessages`).
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {groqRoute} from '../bridge/text-provider-host.mjs';
import {PersonaBook, buildMessages, LIMITS} from '../bridge/mistral-prompt.mjs';
import {estimateTokens} from '../bridge/prompt-budget.mjs';
import {buildPrompt, messagesFor, sizeOf, HISTORY, MEMORY, REMEMBERED, USER_LINES} from './judy-prompt-fixture.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? Number(args[at + 1]) : fallback; };
const GAP = option('--gap-seconds', 20), TURNS = option('--turns', 12);
const REPLY_TOKENS = 100;          // a spoken reply (1 to 3 sentences) is about 100 tokens
const PLAN_TPM = 8000;
const REAL_CHARS_PER_TOKEN = 4.2;  // this prompt measured on Gemma 4 and Qwen3.5 (docs/LOCAL_AI.md)

const roster = JSON.parse(readFileSync(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'));
const archetype = new PersonaBook(roster).persona(roster[0].key);
const judy = buildPrompt();
const BLANK = /\n\n/;
const plainParts = {...judy.contextParts, notes: '', volatile: judy.contextParts.volatile.split(BLANK).filter(block => !/^Natural speech is on/.test(block)).join('\n\n')};
const VARIANTS = {
  'Judy, everything on': () => key => messagesFor(judy, key),
  'Judy, no emotion notes or Natural speech': () => key => messagesFor(judy, key, plainParts),
  'archetype NPC (Maelstrom ganger)': () => key => buildMessages({persona: archetype, memory: '', history: HISTORY.slice(-2), contextParts: {...plainParts, world: plainParts.world.split(BLANK).slice(-2).join('\n\n')},
    remembered: [], text: USER_LINES[key], limits: LIMITS}),
};
const lines = Object.keys(USER_LINES);

async function run(make, compact, provider = {}) {
  const sent = [];
  const stub = async options => { sent.push(options.messages); return {text: 'ok', usage: undefined, finishReason: 'stop'}; };
  const logs = [];
  const route = groqRoute({provider, chat: stub, log: line => logs.push(line), compact});
  const rows = [];
  let window = [];                 // [{at, tokens}] of the tokens the free plan has counted in the last minute
  let answered = 0, fellBack = 0;
  for (let turn = 0; turn < TURNS; turn++) {
    const now = turn * GAP * 1000;
    const messages = make(lines[turn % lines.length]);
    const started = performance.now();
    await route.chat({messages, provider: 'groq'});
    const ms = performance.now() - started;
    const out = sent.at(-1);
    const chars = sizeOf(out), est36 = estimateTokens(out), real = Math.ceil(chars / REAL_CHARS_PER_TOKEN) + 6 * out.length;
    window = window.filter(item => item.at > now - 60000);
    const used = window.reduce((sum, item) => sum + item.tokens, 0);
    const ok = used + real + REPLY_TOKENS <= PLAN_TPM;
    if (ok) { window.push({at: now, tokens: real + REPLY_TOKENS}); answered++; } else fellBack++;
    rows.push({turn, chars, tokensAt36: est36, tokensAt42: real, ms: Math.round(ms * 10) / 10});
  }
  return {rows, answered, fellBack, logs: [...new Set(logs)]};
}

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
const summary = result => ({
  chars: median(result.rows.map(row => row.chars)), tokensAt36: median(result.rows.map(row => row.tokensAt36)), tokensAt42: median(result.rows.map(row => row.tokensAt42)),
  fitMs: median(result.rows.map(row => row.ms)), groqAnswered: result.answered, wouldFallBackToMistral: result.fellBack, log: result.logs.slice(0, 2),
});
const report = {turns: TURNS, gapSeconds: GAP, planTokensPerMinute: PLAN_TPM, variants: {},
  otherProvidersPromptHash: sha(messagesFor(judy, 'a'))};   // what Mistral and the local AI build from the same arguments: no shaping on that path
for (const [name, make] of Object.entries(VARIANTS)) {
  const build = make();
  const full = sizeOf(build('a'));
  const off = summary(await run(build, false)), on = summary(await run(build, true)), onWithMistral = summary(await run(build, true, {apiKey: 'mistral-key-present'}));
  // Groq's prefill is about 415 ms for 6,000 tokens (docs/LATENCY_2026-10-12.md section 5), 0.07 ms a token.
  report.variants[name] = {fullChars: full, off, on, onWithMistral, estimatedPrefillSavedMs: Math.round((off.tokensAt42 - on.tokensAt42) * 0.07)};
}
// --roster: every named character of the roster with the fixture's context, with the optional notes on ("full") and with the format notes and
// the volatile notes emptied ("plain"): how many prompts land under 3,900 real tokens (two Groq turns a minute) before and after.
if (args.includes('--roster')) {
  const named = JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8')).filter(row => row.kind === 'named');
  const book = new PersonaBook(named);
  report.roster = {characters: named.length};
  for (const [label, parts] of [['full', judy.contextParts], ['plain', {...judy.contextParts, notes: '', volatile: ''}]]) {
    const counts = {before: 0, after: 0, afterWithMistralKey: 0}, tokens = {before: [], after: []};
    for (const row of named) {
      const messages = buildMessages({persona: book.persona(row.key), memory: MEMORY, history: HISTORY, contextParts: parts, remembered: REMEMBERED, text: USER_LINES.a, limits: LIMITS});
      for (const [name, compact, provider] of [['before', false, {}], ['after', true, {}], ['afterWithMistralKey', true, {apiKey: 'k'}]]) {
        let sent;
        await groqRoute({provider, chat: async options => { sent = options.messages; return {text: 'ok'}; }, log: () => {}, compact}).chat({messages, provider: 'groq'});
        const real = Math.ceil(sizeOf(sent) / REAL_CHARS_PER_TOKEN);
        if (real <= 3900) counts[name]++;
        if (tokens[name]) tokens[name].push(real);
      }
    }
    report.roster[label] = {under3900Tokens: counts, medianTokensBefore: median(tokens.before), medianTokensAfter: median(tokens.after)};
  }
}
if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  for (const [name, item] of Object.entries(report.variants)) {
    console.log(`
${name} (full prompt ${item.fullChars} chars)`);
    for (const [label, row] of [['off (before)', item.off], ['on, Groq key only', item.on], ['on, Mistral key too', item.onWithMistral]]) {
      console.log(`  ${label}: ${row.chars} chars, ${row.tokensAt36} tokens at 3.6 c/t (the budget's estimate), ${row.tokensAt42} at 4.2; build+fit ${row.fitMs} ms; `
        + `of ${TURNS} turns ${GAP} s apart Groq answers ${row.groqAnswered}, Mistral takes ${row.wouldFallBackToMistral}`);
      for (const line of row.log) console.log('      ' + line);
    }
    console.log(`  estimated Groq prefill saved per turn: ${item.estimatedPrefillSavedMs} ms`);
  }
  if (report.roster) for (const label of ['full', 'plain']) console.log(`roster, ${label} context: ${JSON.stringify(report.roster[label])} of ${report.roster.characters} named characters`);
  console.log(`
prompt hash for the other providers (Judy, line a): ${report.otherProvidersPromptHash}`);
}
