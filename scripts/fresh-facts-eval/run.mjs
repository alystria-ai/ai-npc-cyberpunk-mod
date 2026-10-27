// Runs the fresh-facts variants against a real model with the Runtime's own llama-server, the way the bridge starts and calls it (bridge/local-llm-server.mjs buildServerArgs, the profile's sampling).
// node scripts/fresh-facts-eval/run.mjs --model <gguf> --server <llama-server.exe> --profile local-lite --out results.json [--samples 8] [--only clothes|drinks] [--variants a,b] [--device Vulkan1] [--port 18093]
import {spawn} from 'node:child_process';
import {writeFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {buildServerArgs} from '../../bridge/local-llm-server.mjs';
import {LOCAL_STOP_STRINGS} from '../../bridge/text-provider-host.mjs';
import {defaultProfile} from '../../bridge/prompt-profiles.mjs';
import {cleanReply} from '../../bridge/mistral-prompt.mjs';
import {clothesCase, drinksCase} from './scenarios.mjs';
import {CLOTHES_VARIANTS, DRINKS_VARIANTS, CLOTHES_TEXTS, DRINKS_TEXTS, judge} from './variants.mjs';

const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; };
const model = arg('model'), server = arg('server'), profileId = arg('profile', 'local-lite'), out = arg('out'), samples = Number(arg('samples', 8)), port = Number(arg('port', 18093));
const device = arg('device', 'Vulkan1'), only = arg('only', 'both'), wanted = arg('variants', '').split(',').filter(Boolean);
if (!model || !server || !out) throw Error('--model, --server and --out are required');

const dir = mkdtempSync(join(tmpdir(), 'fresh-facts-'));
const key = randomBytes(18).toString('hex'), keyFile = join(dir, 'key.txt');
writeFileSync(keyFile, key);
const args = buildServerArgs({model, port, keyFile, device});
const child = spawn(server, args, {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
let logTail = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logTail = (logTail + chunk).slice(-4000); });
const stop = () => { try { child.kill(); } catch { /* gone */ } };
process.on('exit', stop); process.on('SIGINT', () => { stop(); process.exit(1); });
const base = `http://127.0.0.1:${port}`;
const headers = {'content-type': 'application/json', authorization: `Bearer ${key}`};

async function waitReady() {
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw Error(`llama-server exited ${child.exitCode}: ${logTail.slice(-600)}`);
    try { const r = await fetch(`${base}/health`); if (r.ok) return; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw Error('llama-server did not become ready');
}

const profile = defaultProfile(profileId), sampling = profile.sampling;
async function ask(messages) {
  const body = {model: 'local', messages, max_tokens: 160, stream: false, temperature: sampling.temperature, stop: [...LOCAL_STOP_STRINGS], chat_template_kwargs: {enable_thinking: false},
    ...(sampling.repeatPenalty ? {repeat_penalty: sampling.repeatPenalty} : {})};
  const started = performance.now();
  const response = await fetch(`${base}/v1/chat/completions`, {method: 'POST', headers, body: JSON.stringify(body)});
  const json = await response.json();
  return {text: json.choices?.[0]?.message?.content ?? `ERROR ${JSON.stringify(json).slice(0, 200)}`, ms: Math.round(performance.now() - started), promptTokens: json.usage?.prompt_tokens};
}

const results = [];
try {
  await waitReady();
  await ask([{role: 'user', content: 'hi'}]);   // warm
  const plan = [];
  if (only !== 'drinks') plan.push(['clothes', clothesCase, CLOTHES_VARIANTS, CLOTHES_TEXTS]);
  if (only !== 'clothes') plan.push(['drinks', drinksCase, DRINKS_VARIANTS, DRINKS_TEXTS]);
  for (const [kind, build, variants, texts] of plan) {
    for (const [name, make] of Object.entries(variants)) {
      if (wanted.length && !wanted.includes(name)) continue;
      for (const spec of texts) {
        const {text, later} = spec, label = later ? text + " (later)" : text;
        const c = build(text, {profile: profileId, later});
        const messages = make(c);
        for (let i = 0; i < samples; i++) {
          const answer = await ask(messages);
          const reply = cleanReply(answer.text, {name: c.input.name});
          results.push({kind, variant: name, text: label, reply, raw: answer.text, verdict: judge(kind, reply), ms: answer.ms, promptTokens: answer.promptTokens});
        }
        const mine = results.filter(r => r.kind === kind && r.variant === name && r.text === label);
        console.log(`${kind} ${name} "${label}": ok ${mine.filter(r => r.verdict === 'ok').length} bad ${mine.filter(r => r.verdict === 'bad').length} review ${mine.filter(r => r.verdict === 'review').length} (${mine[0]?.promptTokens} tok)`);
        writeFileSync(out, JSON.stringify({model, profile: profileId, results}, null, 1));
      }
    }
  }
  if (process.argv.includes('--coldprobe')) {
    // What a changed prefix costs: the same prompt with its very first token changed (the fresh line at the top of the system message), with only the end of the system message changed (where the fresh line goes), and unchanged.
    const probe = async (label, change) => {
      const times = [];
      for (let i = 0; i < 6; i++) {
        const c = clothesCase('what am i wearing now?', {profile: profileId}), messages = c.messages.map(row => ({...row}));
        change(messages, i + 1);
        const started = performance.now();
        const response = await fetch(`${base}/v1/chat/completions`, {method: 'POST', headers, body: JSON.stringify({model: 'local', messages, max_tokens: 1, stream: false, temperature: 0})});
        await response.json();
        times.push(Math.round(performance.now() - started));
      }
      console.log(`prefix probe ${label}: ${times.join(' ')} ms (median ${[...times].sort((a, b) => a - b)[3]})`);
    };
    await probe('warm (nothing changed)', () => {});
    await probe('changed at the very top', (messages, i) => { messages[0].content = `Note ${i}. ${messages[0].content}`; });
    await probe('changed at the end of the system message', (messages, i) => { messages[0].content += ` Note ${i}.`; });
  }
} finally {
  stop();
  await new Promise(r => setTimeout(r, 1500));
  console.log(`server exited: ${child.exitCode !== null || child.killed}`);
}
process.exit(0);
