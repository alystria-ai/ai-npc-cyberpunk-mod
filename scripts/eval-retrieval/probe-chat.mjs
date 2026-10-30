// One non-streaming Command A+ call, to see the raw answer shape (empty replies came from hidden reasoning using the token budget).
import {readKey} from './lib.mjs';
for (const extra of [{}, {reasoning_effort: 'none'}]) {
  const started = performance.now();
  const r = await fetch('https://api.cohere.ai/compatibility/v1/chat/completions', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + readKey('cohere')}, body: JSON.stringify({model: 'command-a-plus-05-2026', max_tokens: 160, messages: [{role: 'system', content: 'You are Judy Alvarez. One to three short spoken sentences.'}, {role: 'user', content: 'Judy, do you still dive?'}], ...extra})});
  console.log(JSON.stringify(extra), r.status, Math.round(performance.now() - started), 'ms', (await r.text()).slice(0, 700));
}
