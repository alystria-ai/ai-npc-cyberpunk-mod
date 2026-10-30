// Cohere Command (OpenAI-compatible endpoint) against Google Gemini on in-character turns: latency to the first token and to the whole
// reply, plus the replies themselves, for reading. Keys are read at run time only and never printed.
//   node scripts/eval-retrieval/chat-compare.mjs   -> local/chat-compare.json
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {readKey, root, localDir, writeJson, sleep, median} from './lib.mjs';

const TURNS = [
  ['panam-palmer', 'Hey Panam. Still up?'],
  ['panam-palmer', 'What do you think Saul would say if he saw us now?'],
  ['judy-alvarez', 'Judy, do you still dive? I miss watching you work.'],
  ['judy-alvarez', 'Be honest, was leaving the Mox the right call?'],
  ['johnny-silverhand', 'Johnny, why do you hate Arasaka so much? Give me the short version.'],
  ['johnny-silverhand', 'Say something that is not a threat for once.'],
  ['viktor-vektor', 'Viktor, my hands are shaking again. Is that the chrome?'],
  ['viktor-vektor', 'How much for a patch job? I am running low.'],
];
const MODELS = [
  {label: 'cohere command-a-plus-05-2026', base: 'https://api.cohere.ai/compatibility/v1', model: 'command-a-plus-05-2026', key: 'cohere', extra: {reasoning_effort: 'none'}},
  {label: 'cohere command-a-03-2025', base: 'https://api.cohere.ai/compatibility/v1', model: 'command-a-03-2025', key: 'cohere', extra: {}},
  {label: 'gemini-flash-lite-latest', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-lite-latest', key: 'googlegemini', extra: {}},
];
const persona = speaker => readFileSync(join(root, 'characters/profile-text', speaker + '.txt'), 'utf8').slice(0, 3500);
const system = speaker => `You are ${speaker.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')} in Cyberpunk 2077, talking to V face to face. Stay in character. Answer in one to three short spoken sentences, no stage directions, no lists.\n\n${persona(speaker)}`;

async function ask(spec, speaker, text) {
  const started = performance.now();
  const response = await fetch(spec.base + '/chat/completions', {
    method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + readKey(spec.key)},
    body: JSON.stringify({model: spec.model, stream: true, max_tokens: 160, temperature: 0.8, messages: [{role: 'system', content: system(speaker)}, {role: 'user', content: text}], ...spec.extra}),
  });
  if (!response.ok) throw new Error(`${spec.label} HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  let first = null, reply = '', buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, {stream: true});
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      try { const delta = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content; if (delta) { first ??= performance.now() - started; reply += delta; } } catch {}
    }
  }
  return {firstMs: Math.round(first ?? -1), totalMs: Math.round(performance.now() - started), reply: reply.trim()};
}

const out = [];
const only = process.argv[2];   // optional label filter, e.g. plus
for (const spec of MODELS.filter(spec => !only || spec.label.includes(only))) {
  const rows = [];
  for (const [speaker, text] of TURNS) {
    try { rows.push({speaker, text, ...(await ask(spec, speaker, text))}); }
    catch (error) { rows.push({speaker, text, error: String(error.message).replace(/Bearer\s+\S+/g, '')}); }
    await sleep(3500);   // the trial chat limit is 20 a minute
  }
  const ok = rows.filter(r => !r.error);
  out.push({label: spec.label, medianFirstMs: median(ok.map(r => r.firstMs)), medianTotalMs: median(ok.map(r => r.totalMs)), failures: rows.length - ok.length, rows});
  console.log(spec.label, 'first-token median', median(ok.map(r => r.firstMs)), 'ms, total', median(ok.map(r => r.totalMs)), 'ms, failures', rows.length - ok.length);
}
writeJson(join(localDir, `chat-compare${only ? '-' + only : ''}.json`), out);
