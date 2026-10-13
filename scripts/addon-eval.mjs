#!/usr/bin/env node
// Runs an add-on speaker's prompt against a scripted event sequence (bridge/addon-eval.mjs; docs/ADDON_API.md, "Evaluating a speaker").
//
//   node scripts/addon-eval.mjs --addon addons/example --script addons/example/eval/combat.json [--judge] [--runs 3] [--model id] [--json]
//   node scripts/addon-eval.mjs --addon addons/example --script addons/example/eval/combat.json --dry
//   --gap-ms N  waits at least N ms between two requests (the speaker's and the judge's; default 1500 on a real run, so a shared free key
//               is not hit in bursts)
//
// The speaker answers through Mistral with the key in MISTRAL_API_KEY, or the key saved in the state folder (runtime/ or
// CYBERPUNK_CONVAI_STATE). The key is never printed. --dry sends nothing: each step's prompt is printed with a placeholder reply.
// --judge scores every line with a second model (in character, fun, fits the moment, short, fresh). Nothing touches the game,
// Convai or the player's memories.
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateScript, llmJudge} from '../bridge/addon-eval.mjs';
import {streamChat, DEFAULT_MODELS} from '../bridge/mistral-client.mjs';
import {MistralProvider, MISTRAL_KEY_FILE} from '../bridge/mistral-key.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function options(argv) {
  const value = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  return {addon: value('--addon'), script: value('--script'), model: value('--model'), runs: Math.max(1, Math.min(10, Number(value('--runs')) || 1)),
    dry: argv.includes('--dry'), judge: argv.includes('--judge'), json: argv.includes('--json'),
    gapMs: Number.isFinite(Number(value('--gap-ms'))) && value('--gap-ms') !== undefined ? Math.max(0, Number(value('--gap-ms'))) : 1500};
}

async function mistralKey() {
  if (process.env.MISTRAL_API_KEY) return process.env.MISTRAL_API_KEY;
  const state = resolve(process.env.CYBERPUNK_CONVAI_STATE || resolve(project, 'runtime'));
  const provider = await new MistralProvider({keyPath: resolve(state, MISTRAL_KEY_FILE)}).load().catch(() => null);
  return provider?.apiKey ?? null;
}

// One shared clock for every model request of the run: each starts at least `ms` after the one before.
function paced(chat, ms) {
  let next = 0;
  return async options => {
    const start = Math.max(Date.now(), next);
    next = start + ms;
    if (start > Date.now()) await new Promise(done => setTimeout(done, start - Date.now()));
    return chat(options);
  };
}

async function main() {
  const args = options(process.argv.slice(2));
  if (!args.addon || !args.script) {
    console.error('Usage: node scripts/addon-eval.mjs --addon addons/<id> --script <script.json> [--judge] [--runs N] [--model id] [--json] [--dry]');
    return 2;
  }
  const script = await readFile(resolve(args.script), 'utf8');
  let chat, apiKey = 'dry-run', judge = null;
  if (args.dry) {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo', 'lima'];
    let step = 0;
    chat = async () => ({text: `Placeholder reply ${words[step++ % words.length]}.`, model: 'dry', finishReason: 'stop'});
  } else {
    apiKey = await mistralKey();
    if (!apiKey) { console.error('No Mistral key: set MISTRAL_API_KEY or save one in Cyberpunk Convai\'s settings.'); return 1; }
    chat = paced(streamChat, args.gapMs);
    if (args.judge) judge = llmJudge({chat, apiKey});
  }
  const models = args.model ? [args.model] : DEFAULT_MODELS;
  const runs = [];
  for (let run = 0; run < args.runs; run++) {
    runs.push(await evaluateScript({addonDir: args.addon, script, chat, apiKey, judge, models, keepPrompts: args.dry}));
  }
  if (args.json) { console.log(JSON.stringify(runs, null, 2)); return 0; }
  for (const [index, result] of runs.entries()) {
    console.log(`\n${result.addon}/${result.speaker}${runs.length > 1 ? ` run ${index + 1}` : ''}`);
    for (const step of result.steps) {
      const what = step.event ? `[${step.event}]` : `V: ${step.say}`;
      const verdict = step.verdict ? `  ${step.verdict.score ?? '?'}/10 ${step.verdict.notes}` : '';
      console.log(`${String(step.index).padStart(2)}. ${what}${step.mode ? ` (${step.mode})` : ''}\n    ${step.duplicate ? 'DROPPED as a repeat: ' : ''}${step.line} (${step.words} words)${verdict}`);
      if (step.prompt) for (const message of step.prompt) console.log(`    --- ${message.role}\n${message.content.replace(/^/gm, '    ')}`);
    }
    console.log(`Repeats dropped: ${result.duplicates}${result.average !== null ? `; average score ${result.average}/10` : ''}`);
  }
  return 0;
}

main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
