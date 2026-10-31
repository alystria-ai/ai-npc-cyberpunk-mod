// Local benchmark of retrieval-driven prompts (docs/NATURAL_TALK_RESEARCH_2026-10-30.md, section 15). Offline: no model, no game, no network. Not part of the release.
//
//   node scripts/Bench-TalkRetrieval.mjs [--facts 40] [--quests 10] [--turns 3] [--embed-ms 17] [--json]
//
// 1. Prompt size and cache reuse, before (the whole topic material and the whole world blocks on every turn) and after (retrieval), for four characters and three prompt families
//    (Google Gemini, Local AI Standard, a Custom generic endpoint). A conversation is a fixed script (small talk, topic questions, work questions, a world-fact question) with the history
//    growing turn by turn. "New tokens" is what a prefix cache has to read again: the prompt after the longest prefix it shares with the previous turn's prompt.
// 2. The time of the retrieval itself (reading the sources from the turn's knowledge, then TalkRetrieval.prepare): words only, and with a stand-in embedder, on the turn's own stage clock (`retrieved`). A stand-in embedder is the only
//    one that exists here (the model files are not in this checkout), so the cost of the real query embedding is NOT measured: `--embed-ms` adds a stated figure to show the total.
// 3. The vector lookup alone, 384 dimensions, over one character's units and over the whole roster's.
// The world is made up (bridge/fixtures/talk-world.mjs) in the sizes of a mid-game save; the characters' topic material is the real roster's.
import {readFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback; };
const FACTS = option('facts', 40), QUESTS = option('quests', 10), ROUNDS = option('turns', 3), EMBED_MS = option('embed-ms', 17), asJson = argv.includes('--json');

const imp = name => import(new URL(`../bridge/${name}`, import.meta.url).href);
const {PersonaBook, buildMessages, withRetrievedParts, joinBlocks, worldBlocksInCacheOrder} = await imp('mistral-prompt.mjs');
const {conversationContextBlocks, retrievalSources} = await imp('quest-context.mjs');
const {TalkRetrieval, Corpus, rankUnits, contentTokens} = await imp('talk-retrieval.mjs');
const {estimateTokens, BUDGET} = await imp('prompt-budget.mjs');
const {defaultProfile, profileIdFor, customProfileId} = await imp('prompt-profiles.mjs');
const {TurnClock, withClock, markStage} = await imp('turn-clock.mjs');
const {worldTurn} = await imp('fixtures/talk-world.mjs');
const {textKey} = await imp('topic-material.mjs');

const roster = JSON.parse(await readFile(resolve(root, 'characters/roster.json'), 'utf8'));
const before = new PersonaBook(roster, {lean: true}), after = new PersonaBook(roster, {lean: true, topics: true});
const corpus = new Corpus(roster.flatMap(row => after.topicMaterial(row.key, {raw: true})?.items.map(item => item.text.split('\n')[0]) ?? []));

const CAST = [['panam-palmer', 'Panam'], ['judy-alvarez', 'Judy'], ['johnny-silverhand', 'Johnny'], ['river-ward', 'River']];
const PROFILES = {
  gemini: defaultProfile(customProfileId('https://generativelanguage.googleapis.com', 'gemini-flash-lite-latest'), {family: 'gemini'}),
  'local-standard': defaultProfile(profileIdFor({route: 'local', tier: 'standard'})),
  custom: defaultProfile(customProfileId('https://example.test', 'some-model'), {family: 'generic'}),
};
// The rarest content word of a topic item, to ask about it the way a player would ("tell me about X").
const rarest = text => contentTokens(text).sort((a, b) => corpus.idf(b) - corpus.idf(a))[0];
function script(key) {
  const items = after.topicMaterial(key).items;
  const ask = item => `tell me about ${rarest(item.text.split('\n')[0])}`;
  return [
    ['small', 'hey'], ['small', 'how is it going'], ['topic', ask(items[0])], ['small', 'thanks'], ['topic', ask(items[Math.min(3, items.length - 1)])], ['work', 'what now?'],
    ['small', 'so hows life'], ['world', 'what happened to Saul Bright?'], ['small', 'perhaps'], ['work', 'any work for me?'], ['small', 'okay done'], ['topic', ask(items[Math.min(5, items.length - 1)])],
  ];
}
const REPLIES = ['Fine, V.', 'Not bad. You?', 'Long story, but sure.', 'Anytime.', 'Hm. Maybe.', 'Keep your head down.', 'Busy, mostly.', 'Rough times, V.', 'Mm.', 'There is always something.', 'Good.', 'Ask me later.'];

const partsOf = blocks => {
  const world = worldBlocksInCacheOrder(blocks.filter(item => item.tier === 'world'));
  return {...Object.fromEntries(['now', 'notes', 'volatile', 'closing', 'retrieved'].map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))])),
    world: joinBlocks(world.map(item => item.text)), worldBlocks: world.filter(item => item.text).map(item => ({key: item.key, text: item.text}))};
};
const flat = messages => messages.map(message => `<${message.role}>${message.content}`).join('\n');
const commonPrefix = (a, b) => { let i = 0; const n = Math.min(a.length, b.length); while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++; return i; };
const mean = values => values.reduce((a, b) => a + b, 0) / (values.length || 1);
const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; };

// ---- 1. Prompt size and cache reuse -----------------------------------------------------------------------------------------------------------------
async function conversation(key, name, family, mode) {
  const book = mode === 'after' ? after : before, profile = PROFILES[family];
  const talk = new TalkRetrieval({topicFor: k => after.topicMaterial(k), corpus});
  const rows = [];
  let history = [], previous = '';
  for (const round of Array.from({length: ROUNDS})) {
    history = []; previous = '';
    for (const [index, [kind, text]] of script(key).entries()) {
      const input = worldTurn(text, {profileKey: key, name, facts: FACTS, quests: QUESTS});
      const full = partsOf(conversationContextBlocks(input));
      let contextParts = full;
      if (mode === 'after') contextParts = withRetrievedParts(full, await talk.prepare({profileKey: key, requestId: input.requestId, text, reaction: false}, {sources: retrievalSources(input)}));
      const messages = buildMessages({persona: book.persona(key, name), memory: '', history, contextParts, remembered: [], text, profile});
      const prompt = flat(messages);
      const shared = previous ? commonPrefix(previous, prompt) : 0;
      const cpt = BUDGET.charsPerToken;
      rows.push({kind, chars: prompt.length, tokens: estimateTokens(messages), system: messages[0].content.length, last: messages.at(-1).content.length, newTokens: Math.ceil((prompt.length - shared) / cpt), first: !previous});
      previous = prompt;
      history = [...history, {v: text, r: REPLIES[index % REPLIES.length]}].slice(-8);
    }
  }
  return rows;
}
const sizeRows = [];
for (const family of Object.keys(PROFILES)) {
  for (const [key, name] of CAST) {
    const a = await conversation(key, name, family, 'before'), b = await conversation(key, name, family, 'after');
    sizeRows.push({family, key, before: a, after: b});
  }
}
const summarize = (rows, filter = () => true) => {
  const pick = rows.filter(filter);
  return {tokens: Math.round(mean(pick.map(row => row.tokens))), system: Math.round(mean(pick.map(row => row.system))), last: Math.round(mean(pick.map(row => row.last))),
    newTokens: Math.round(mean(pick.filter(row => !row.first).map(row => row.newTokens))), n: pick.length};
};
const sizes = {};
for (const family of Object.keys(PROFILES)) {
  const rows = sizeRows.filter(item => item.family === family);
  const side = (name, filter) => ({before: summarize(rows.flatMap(item => item.before), filter), after: summarize(rows.flatMap(item => item.after), filter)});
  sizes[family] = {all: side('all'), small: side('small', row => row.kind === 'small'), topic: side('topic', row => row.kind === 'topic'), work: side('work', row => row.kind === 'work'), world: side('world', row => row.kind === 'world')};
}

// ---- 2. The retrieval's own time --------------------------------------------------------------------------------------------------------------------
function standInEmbedder(delay = 0) {
  const dim = 384;
  const vector = text => { const out = new Float32Array(dim); for (const word of contentTokens(text)) { let h = 0; for (const ch of word) h = (h * 31 + ch.codePointAt(0)) >>> 0; out[h % dim] += 1; } const n = Math.hypot(...out) || 1; return out.map(value => value / n); };
  const embedder = {id: 'stand-in-384', dim, available: () => true, ready: () => true, warm: async () => true, vector,
    async embed(texts) { if (delay) await new Promise(resolve => setTimeout(resolve, delay)); return texts.map(vector); }};
  return embedder;
}
async function timeRetrieval(embedder, label, simulatedMs = 0) {
  const talk = new TalkRetrieval({topicFor: k => after.topicMaterial(k), corpus, embedder,
    queryVector: embedder ? async text => { if (simulatedMs) await new Promise(resolve => setTimeout(resolve, simulatedMs)); return embedder.vector(text); } : undefined});
  if (embedder) for (const [key] of CAST) await talk.embedUnits(talk.topicSource(key).units, {start: true});
  const times = [];
  const inputs = CAST.flatMap(([key, name]) => script(key).map(([kind, text]) => ({key, kind, text, input: worldTurn(text, {profileKey: key, name, facts: FACTS, quests: QUESTS})})));
  for (let round = 0; round < (simulatedMs ? 2 : 40); round++) {
    for (const {key, kind, text, input} of inputs) {
      const started = performance.now();
      await talk.prepare({profileKey: key, requestId: `${input.requestId}-${round}`, text, reaction: false}, {sources: retrievalSources(input)});
      if (round > 0) times.push({kind, ms: performance.now() - started});
    }
  }
  const all = times.map(row => row.ms);
  return {label, n: all.length, mean: mean(all), p50: quantile(all, 0.5), p95: quantile(all, 0.95), max: Math.max(...all),
    small: mean(times.filter(row => row.kind === 'small').map(row => row.ms)), topic: mean(times.filter(row => row.kind !== 'small').map(row => row.ms))};
}
const timings = [await timeRetrieval(null, 'words only (no embedder)'), await timeRetrieval(standInEmbedder(), 'with a stand-in embedder, 0 ms per query'),
  await timeRetrieval(standInEmbedder(), `the same plus a simulated ${EMBED_MS} ms query embedding`, EMBED_MS)];

// The whole of the bridge's own work for a turn, from the knowledge-attached input to the finished messages, before (the full blocks) and after (retrieval, then the smaller prompt).
async function timeTurnPath(mode, simulatedMs = 0) {
  const embedder = standInEmbedder();
  const talk = new TalkRetrieval({topicFor: k => after.topicMaterial(k), corpus, embedder, queryVector: async text => { if (simulatedMs) await new Promise(resolve => setTimeout(resolve, simulatedMs)); return embedder.vector(text); }});
  if (mode === 'after') for (const [key] of CAST) await talk.embedUnits(talk.topicSource(key).units, {start: true});
  const book = mode === 'after' ? after : before, profile = PROFILES.gemini, times = [];
  const inputs = CAST.flatMap(([key, name]) => script(key).map(([kind, text]) => ({key, name, kind, text, input: worldTurn(text, {profileKey: key, name, facts: FACTS, quests: QUESTS})})));
  for (let round = 0; round < 12; round++) {
    for (const {key, name, kind, text, input} of inputs) {
      const started = performance.now();
      const full = partsOf(conversationContextBlocks(input));
      let contextParts = full;
      if (mode === 'after') contextParts = withRetrievedParts(full, await talk.prepare({profileKey: key, requestId: `${input.requestId}-${round}`, text, reaction: false}, {sources: retrievalSources(input)}));
      buildMessages({persona: book.persona(key, name), memory: '', history: [], contextParts, remembered: [], text, profile});
      if (round > 1) times.push({kind, ms: performance.now() - started});
    }
  }
  const all = times.map(row => row.ms);
  return {mode, simulatedMs, mean: mean(all), p95: quantile(all, 0.95), small: mean(times.filter(row => row.kind === 'small').map(row => row.ms)), other: mean(times.filter(row => row.kind !== 'small').map(row => row.ms))};
}
const turnPath = [await timeTurnPath('before'), await timeTurnPath('after'), await timeTurnPath('after', EMBED_MS)];

// The turn's stage clock with the new stage.
const clockInput = worldTurn('what happened to Saul Bright?', {facts: FACTS, quests: QUESTS});
const clock = new TurnClock();
const clockTalk = new TalkRetrieval({topicFor: k => after.topicMaterial(k), corpus});
await withClock(clock, async () => {
  markStage('admitted');
  await clockTalk.prepare({profileKey: 'panam-palmer', requestId: clockInput.requestId, text: clockInput.text, reaction: false}, {sources: retrievalSources(clockInput)});
  markStage('retrieved');
  markStage('recalled');
});
const stage = clock.snapshot().steps.filter(step => step.to === 'retrieved' || step.to === 'recalled');

// ---- 3. The vector lookup alone --------------------------------------------------------------------------------------------------------------------
const rnd = () => { const v = Float32Array.from({length: 384}, () => Math.random() - 0.5); const n = Math.hypot(...v); return v.map(x => x / n); };
const lookups = [];
for (const [label, count] of [['one character (7 units)', 7], ['one character and the world (60 units)', 60], ['the whole roster (636 units)', 636]]) {
  const units = Array.from({length: count}, (_, index) => ({id: `u${index}`, text: `unit ${index}`, vec: rnd()}));
  const query = {tokens: [], vec: rnd()};
  const context = {corpus, vectorOf: unit => unit.vec, rule: {floor: 0.7, margin: 0.1}};
  const times = [];
  for (let i = 0; i < 300; i++) { const t = performance.now(); rankUnits(units, query, context); times.push(performance.now() - t); }
  lookups.push({label, mean: mean(times.slice(20)), p95: quantile(times.slice(20), 0.95)});
}
const vectorBytes = roster.reduce((sum, row) => sum + (after.topicMaterial(row.key)?.items.length ?? 0), 0) * 384 * 4;

// ---- Report ------------------------------------------------------------------------------------------------------------------------------------------
const f1 = value => value.toFixed(value < 1 ? 3 : 1);
const pct = (a, b) => `${Math.round(100 * (b - a) / a)}%`;
if (asJson) {
  console.log(JSON.stringify({facts: FACTS, quests: QUESTS, sizes, timings, turnPath, stage, lookups, vectorBytes}, null, 2));
} else {
  console.log(`Retrieval benchmark: ${CAST.length} characters, ${FACTS} world facts and ${QUESTS} journal quests per turn, ${ROUNDS} runs of a 12-turn script; ${BUDGET.charsPerToken} characters per token (the bridge's own estimate).\n`);
  console.log('Prompt size, mean per turn (tokens; "new" = tokens after the prefix shared with the previous turn, what a prefix cache reads again)\n');
  console.log('| family | turns | before tokens | after tokens | change | before new | after new | change |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [family, set] of Object.entries(sizes)) {
    for (const [name, label] of [['all', 'all turns'], ['small', 'small talk'], ['topic', 'a topic question'], ['work', 'a work question'], ['world', 'a world-fact question']]) {
      const row = set[name];
      console.log(`| ${family} | ${label} | ${row.before.tokens} | ${row.after.tokens} | ${pct(row.before.tokens, row.after.tokens)} | ${row.before.newTokens} | ${row.after.newTokens} | ${pct(row.before.newTokens, row.after.newTokens)} |`);
    }
  }
  console.log('\nSystem message and last message, mean characters (all turns)\n');
  console.log('| family | system before | system after | last before | last after |');
  console.log('|---|---|---|---|---|');
  for (const [family, set] of Object.entries(sizes)) console.log(`| ${family} | ${set.all.before.system} | ${set.all.after.system} | ${set.all.before.last} | ${set.all.after.last} |`);
  console.log('\nTime of the retrieval (TalkRetrieval.prepare, ms per turn, this machine)\n');
  console.log('| case | turns | mean | p50 | p95 | max | small talk | other |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const row of timings) console.log(`| ${row.label} | ${row.n} | ${f1(row.mean)} | ${f1(row.p50)} | ${f1(row.p95)} | ${f1(row.max)} | ${f1(row.small)} | ${f1(row.topic)} |`);
  console.log('\nThe bridge\'s own work for a turn (context blocks, retrieval, prompt build; ms per turn, Gemini prompt)\n');
  console.log('| case | mean | p95 | small talk | other turns |');
  console.log('|---|---|---|---|---|');
  for (const row of turnPath) console.log(`| ${row.mode === 'before' ? 'before: the full blocks' : row.simulatedMs ? `after: retrieval, stand-in query embedding of ${row.simulatedMs} ms` : 'after: retrieval, stand-in query embedding of 0 ms'} | ${f1(row.mean)} | ${f1(row.p95)} | ${f1(row.small)} | ${f1(row.other)} |`);
  console.log(`\nStage clock of one turn: ${stage.map(step => `${step.from} to ${step.to} ${f1(step.ms)} ms`).join(', ')}`);
  console.log('\nThe vector lookup alone (384 dimensions, cosine against every unit, then the cut-off)\n');
  console.log('| pool | mean ms | p95 ms |');
  console.log('|---|---|---|');
  for (const row of lookups) console.log(`| ${row.label} | ${f1(row.mean)} | ${f1(row.p95)} |`);
  console.log(`\nVectors of the whole roster's topic material: ${(vectorBytes / 1024).toFixed(0)} KiB in memory.`);
}
