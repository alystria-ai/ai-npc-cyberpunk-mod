// Do better retrieved items give better replies? Picks queries where the variants' top items differ, builds the prompt the way the mod
// does (persona, then the retrieved items under a "what you remember" heading, at most 4 items and 1200 characters), gets a reply from
// Google Gemini for each variant and writes blind judge files.
//   node scripts/eval-retrieval/reply-quality.mjs gen  [--systems granite,embgemma,cohere>rerank] [--count 15]
//   node scripts/eval-retrieval/reply-quality.mjs pack          -> local/reply-judge-<n>.json (anonymised) + local/reply-judge-map.json
//   node scripts/eval-retrieval/reply-quality.mjs score         -> reads local/reply-judge-out-<n>.json, prints the mean scores per system
// Gemini calls are cached in local/cache/replies.json, so a re-run costs nothing. The key is read at run time only.
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {readKey, readJson, writeJson, root, localDir, here, sleep, cached} from './lib.mjs';

const mode = process.argv[2];
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const systems = arg('systems', 'granite,embgemma,cohere>rerank').split(',');
const count = Number(arg('count', 15));
const queries = readJson(join(here, 'data/queries.json'));
const items = new Map(readJson(join(here, 'data/items.json')).map(item => [item.id, item]));
const rankings = readJson(join(localDir, 'rankings-main.json'));
const K = 4, BUDGET = 1200;

const top = (system, q) => {
  const out = []; let used = 0;
  for (const row of rankings[system][q.id]) {
    const text = items.get(row.id).text.slice(0, 240);
    if (out.length >= K || used + text.length > BUDGET) break;
    out.push(row.id); used += text.length;
  }
  return out;
};
// Queries worth a reply test: the variants disagree on the top items, and the query has gold (not small talk). Spread over categories.
function choose() {
  const pool = queries.filter(q => q.gold.length && systems.every(s => rankings[s]?.[q.id]));
  const differing = pool.filter(q => new Set(systems.map(s => top(s, q).join('|'))).size > 1);
  // prefer queries where at least one variant has a gold item in its top 4 and another does not (retrieval quality differs)
  const hit = (s, q) => top(s, q).some(id => q.gold.includes(id));
  const split = differing.filter(q => new Set(systems.map(s => hit(s, q))).size > 1);
  const ranked = [...split, ...differing.filter(q => !split.includes(q))];
  const byCategory = {}; const chosen = [];
  for (const q of ranked) { byCategory[q.category] = (byCategory[q.category] || 0) + 1; if (byCategory[q.category] <= Math.ceil(count / 3)) chosen.push(q); }
  return chosen.slice(0, count);
}

const persona = speaker => readFileSync(join(root, 'characters/profile-text', speaker + '.txt'), 'utf8').slice(0, 3500);
const nameOf = speaker => speaker.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
function systemPrompt(q, ids) {
  const remembered = ids.length ? `\n\nWHAT YOU REMEMBER OF V FROM EARLIER TALKS AND WHAT YOU KNOW\n${ids.map(id => '- ' + items.get(id).text.slice(0, 240)).join('\n')}` : '';
  return `You are ${nameOf(q.speaker)} in Cyberpunk 2077, talking to V face to face. Stay in character. Answer in one to three short spoken sentences, no stage directions, no lists. Use what you remember only when it fits what V just said, never recite it.\n\n${persona(q.speaker)}${remembered}`;
}
async function gemini(system, text) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + readKey('googlegemini')},
      body: JSON.stringify({model: 'gemini-flash-lite-latest', max_tokens: 160, temperature: 0.5, messages: [{role: 'system', content: system}, {role: 'user', content: text}]}),
    });
    if (response.status === 429) { await sleep(15000 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
    return (await response.json()).choices?.[0]?.message?.content?.trim() ?? '';
  }
  throw new Error('Gemini kept rate limiting');
}

if (mode === 'gen') {
  const chosen = choose();
  const store = (await cached('replies.json', () => ({}))) ?? {};
  let calls = 0;
  for (const q of chosen) for (const system of systems) {
    const key = `${q.id}|${top(system, q).join(',')}`;
    if (store[key] !== undefined) continue;
    store[key] = await gemini(systemPrompt(q, top(system, q)), q.text);
    calls++; writeJson(join(localDir, 'cache/replies.json'), store);
    await sleep(4200);
  }
  writeJson(join(localDir, 'reply-queries.json'), {systems, queries: chosen.map(q => q.id)});
  console.log(chosen.length, 'queries,', calls, 'new Gemini calls. By category:', Object.fromEntries(Object.entries(chosen.reduce((m, q) => (m[q.category] = (m[q.category] || 0) + 1, m), {}))));
}

if (mode === 'pack') {
  const {queries: ids, systems: used} = readJson(join(localDir, 'reply-queries.json'));
  const store = readJson(join(localDir, 'cache/replies.json'));
  let state = 11; const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
  const rows = [], map = {};
  for (const id of ids) {
    const q = queries.find(x => x.id === id);
    const replies = used.map(system => ({system, ids: top(system, q), reply: store[`${q.id}|${top(system, q).join(',')}`]})).sort(() => random() - 0.5);
    map[id] = {};
    rows.push({qid: id, speaker: nameOf(q.speaker), vSays: q.text, fittingMemoryOrFact: q.gold.map(g => items.get(g).text), replies: replies.map((r, i) => { const label = 'ABCDEF'[i]; map[id][label] = r.system; return {label, reply: r.reply}; })});
  }
  const half = Math.ceil(rows.length / 2);
  writeJson(join(localDir, 'reply-judge-1.json'), rows.slice(0, half));
  writeJson(join(localDir, 'reply-judge-2.json'), rows.slice(half));
  writeJson(join(localDir, 'reply-judge-map.json'), map);
  console.log(rows.length, 'queries packed');
}

if (mode === 'score') {
  const map = readJson(join(localDir, 'reply-judge-map.json'));
  const judged = {};
  for (const name of readdirSync(localDir).filter(n => n.startsWith('reply-judge-out-'))) Object.assign(judged, readJson(join(localDir, name)));
  const sum = {}, n = {}, wins = {};
  for (const [qid, byLabel] of Object.entries(judged)) {
    const totals = {};
    for (const [label, s] of Object.entries(byLabel)) {
      const system = map[qid]?.[label]; if (!system) continue;
      const row = (sum[system] ??= {answers: 0, memory: 0, natural: 0}); n[system] = (n[system] || 0) + 1;
      row.answers += s.answers; row.memory += s.memory; row.natural += s.natural;
      totals[system] = s.answers + s.memory + s.natural;
    }
    const best = Math.max(...Object.values(totals));
    for (const [system, total] of Object.entries(totals)) if (total === best) wins[system] = (wins[system] || 0) + 1 / Object.values(totals).filter(t => t === best).length;
  }
  console.log('| variant | answers the question | uses the right memory | natural | total (of 15) | wins |\n|---|---|---|---|---|---|');
  for (const system of Object.keys(sum)) { const r = sum[system], c = n[system]; console.log(`| ${system} | ${(r.answers / c).toFixed(2)} | ${(r.memory / c).toFixed(2)} | ${(r.natural / c).toFixed(2)} | ${((r.answers + r.memory + r.natural) / c).toFixed(2)} | ${(wins[system] || 0).toFixed(1)} of ${c} |`); }
}
