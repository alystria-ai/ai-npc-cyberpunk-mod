// Response audit runner: every scenario through one provider, the exact prompt, the reply, the length, the latency and the token counts kept.
//
//   node scripts/response-audit/run.mjs --provider mistral --model ministral-8b-latest --label base-m8b [--n 1] [--only id,id] [--group lore] [--concurrency 3]
//   node scripts/response-audit/run.mjs --provider local --label base-bonsai            (starts the installed Local AI model: the game must NOT be running)
//   node scripts/response-audit/run.mjs --provider custom --label base-custom            (the same llama-server through its OpenAI-compatible endpoint)
//   node scripts/response-audit/run.mjs --provider convai --label base-convai            (text only, anonymous: no end user, no long-term memory)
//   node scripts/response-audit/run.mjs --dry [--show id]                                (the prompt of every scenario, no request)
// Results: <main checkout>/deliverables/response-audit-data/<label>.json (gitignored). See README.md.
import {writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {TextProviderHost} from '../../bridge/text-provider-host.mjs';
import {PromptProfiles} from '../../bridge/prompt-profile-store.mjs';
import {MatureContent} from '../../bridge/mature-content.mjs';
import {readFile} from 'node:fs/promises';
import {buildMessages, LIMITS, joinBlocks} from '../../bridge/mistral-prompt.mjs';
import {ReplyStream} from '../../bridge/reply-stream.mjs';
import {hasEmotionTag} from '../../bridge/emotion-tags.mjs';
import {redact} from '../../bridge/mistral-client.mjs';
import {actionMenu} from '../../bridge/text-actions.mjs';
import {SCENARIOS, offerFor} from './scenarios.mjs';
import {loadPersonas, buildTurn, stubMemory, spokenText, checks, dataDir, sleep} from './lib.mjs';
import {recorder, mistralProvider, startLocal, stopLocal, localProvider, customProvider, convaiSetup} from './providers.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const flag = name => argv.includes(`--${name}`);
const providerName = option('provider', 'mistral'), label = option('label', `${providerName}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`);
const model = option('model', 'ministral-8b-latest'), n = Number(option('n', 1)), concurrency = Number(option('concurrency', providerName === 'mistral' ? 3 : 1));
const only = option('only', '').split(',').filter(Boolean), groups = option('group', '').split(',').filter(Boolean);
const voice = option('voice', providerName === 'convai' ? 'none' : 'pocket');
// Prompt profiles (bridge/prompt-profiles.mjs): --profiles base builds the one shared prompt every text provider had before profiles (no profile layer at all); the default is the shipped profiles.
// --candidate <file.json> lays {profileId: patch} over the shipped profiles through the same API a player's override uses (an in-memory store, nothing written). --mature turns the Mature setting on (Local AI and Custom).
const profilesMode = option('profiles', 'default'), candidateFile = option('candidate', '');
const matureOn = flag('mature');
const promptProfiles = profilesMode === 'base' || providerName === 'convai' ? null : new PromptProfiles({});
if (promptProfiles && candidateFile) {
  // A candidate is a .json file or a .mjs module whose default export is {profileId: patch} (the module may build its patch from the shipped profiles).
  const candidate = candidateFile.endsWith('.mjs') ? (await import(pathToFileURL(resolve(candidateFile)).href)).default : JSON.parse(await readFile(candidateFile, 'utf8'));
  for (const [id, patch] of Object.entries(candidate)) { const done = await promptProfiles.set(id, patch); if (!done.ok) throw Error(`candidate ${id}: ${JSON.stringify(done.errors)}`); }
}
const matureContent = matureOn && (providerName === 'local' || providerName === 'custom') ? (() => { const setting = new MatureContent(); setting.update({matureContent: true}); return setting; })() : null;
// The adult-talk scenarios (group `mature`) run only with --mature or when the group is named.
const scenarios = SCENARIOS.filter(s => (!only.length || only.includes(s.id)) && (!groups.length || groups.includes(s.group)) && (s.group !== 'mature' || flag('mature') || groups.includes('mature') || only.includes(s.id)));
const personas = await loadPersonas({lean: option('lean', '1') !== '0'});   // --lean 0: the roster text as it was before the response audit's prompt pass
// --compact: every character with the compact text a machine measured to read slowly is given (bridge/compact-persona.mjs), to see what a small card's player gets.
if (flag('compact')) {
  const {compactPersonaFor} = await import('../../bridge/compact-persona.mjs');
  const whole = personas.persona.bind(personas);
  personas.persona = (key, name) => compactPersonaFor(whole(key, name), {limits: LIMITS});
}

if (flag('dry')) {
  for (const scn of scenarios) {
    const turn = await buildTurn(scn, personas, {voice});
    const messages = buildMessages({persona: turn.persona, memory: turn.memory.summary, history: turn.memory.turns, contextParts: turn.contextParts, remembered: turn.memory.remembered, text: turn.text, limits: LIMITS});
    if (option('show', '') === scn.id) { for (const m of messages) console.log(`--- ${m.role} ---\n${m.content}\n`); continue; }
    console.log(`${scn.id.padEnd(26)} ${scn.group.padEnd(9)} system ${String(messages[0].content.length).padStart(6)} chars  user ${String(messages.at(-1).content.length).padStart(5)}  messages ${messages.length}`);
  }
  process.exit(0);
}

const quant = (list, q) => list.length ? [...list].sort((x, y) => x - y)[Math.min(list.length - 1, Math.floor(q * list.length))] : null;
await mkdir(dataDir, {recursive: true});

// ---- text providers -------------------------------------------------------------------------------------------------------------
async function runTextTurn(setup, scn, sample) {
  const turn = await buildTurn(scn, personas, {voice});
  const {chat, requests} = recorder();
  const delivered = [];
  const logs = [];
  const host = new TextProviderHost({provider: setup.provider, memory: stubMemory(turn.memory), personas, limits: LIMITS, log: line => logs.push(line),
    routes: setup.routeFor(model, chat), ...(promptProfiles ? {promptProfiles} : {}), ...(matureContent ? {matureContent} : {}), ...(scn.offer ? {deliverAction: async message => { delivered.push(message); return true; }} : {})});
  const stream = new ReplyStream({name: turn.persona.name, isTag: hasEmotionTag, speak: false});
  let headMs = null;
  const at = Date.now();
  stream.onChange(() => { if (headMs === null && stream.head) headMs = Date.now() - at; });
  let reply = null, error = null;
  try {
    reply = await host.reply({local: turn.local, text: turn.text, context: turn.context, contextParts: turn.contextParts,
      ...(scn.offer ? {companionAction: offerFor(scn, turn.persona.name)} : {})}, {stream});
  } catch (e) { error = redact(String(e?.message ?? e), setup.provider.key ?? '').slice(0, 200); }
  host.close();
  const ms = Date.now() - at;
  const main = [...requests].reverse().find(r => r.text !== undefined && (r.maxTokens ?? 0) > 20) ?? requests.at(-1);
  const raw = reply?.text ?? '';
  const spoken = spokenText(raw);
  return {id: scn.id, sample, group: scn.group, char: scn.char, name: turn.persona.name, playerText: scn.text, want: scn.want, history: turn.memory.turns,
    memory: scn.summary ? {summary: scn.summary, remembered: scn.remembered} : undefined, offer: scn.offer, action: delivered[0] ? Object.keys(delivered[0]).filter(k => !['version', 'token', 'source', 'expiresAt'].includes(k)) : undefined,
    prompt: main?.messages ?? null, requests: requests.map(r => ({maxTokens: r.maxTokens, ms: r.ms, usage: r.usage, finishReason: r.finishReason, error: r.error, chars: r.messages?.reduce((a, m) => a + m.content.length, 0), reply: r === main ? undefined : r.text})),
    raw, spoken, ms, headMs: headMs ?? (error ? null : ms), model: reply?.timing?.model ?? main?.answeredBy, attempts: reply?.timing?.attempts, usage: main?.usage ?? null,
    promptTokens: main?.usage?.prompt_tokens ?? main?.timings?.promptTokens ?? null, completionTokens: main?.usage?.completion_tokens ?? null, firstTokenMs: main?.firstTokenMs ?? null,
    profile: logs.map(line => /^[PromptProfile] turn uses (S+)/.exec(line)?.[1]).find(Boolean) ?? (promptProfiles ? null : 'base'), requestCount: requests.length, ...(error ? {error} : {}), ...checks(spoken, {name: turn.persona.name, playerText: scn.text, raw})};
}

// ---- Convai ---------------------------------------------------------------------------------------------------------------
async function runConvaiTurn(setup, scn, sample) {
  const turn = await buildTurn(scn, personas, {voice});
  const language = /^(?:judy-spanish|panam-german|vendor-french)$/.test(scn.id);
  const characterId = (language && setup.twins[scn.char]?.multilingualCharacterId) || setup.ids[scn.char];
  if (!characterId) return {id: scn.id, sample, group: scn.group, char: scn.char, playerText: scn.text, want: scn.want, error: 'no Convai character id for this profile'};
  const at = Date.now();
  let sessionId, reply = null, error = null;
  const history = [];
  // The character has Convai long-term memory, so a turn needs an end user. Each scenario gets its own throwaway one (the `probe-<uuid>` family that scripts/cleanup-test-end-users.mjs
  // recognises), so nothing of the audit reaches the owner's real memory users or another scenario. The ids are kept in convai-audit-end-users.json for that cleanup.
  const endUserId = `probe-${randomUUID()}`;
  setup.endUsers.push({endUserId, scenario: scn.id, sample, at: new Date().toISOString()});
  try {
    // The canned earlier talk is sent as real turns of one session (Convai keeps its own history); the replies to it are Convai's own.
    for (const earlier of turn.memory.turns) {
      const r = await setup.host.reply({key: setup.key, characterId, endUserId, scope: 'private', ttsEnabled: false, text: earlier.v, context: turn.context, ...(sessionId ? {sessionId} : {})});
      sessionId = r.sessionID ?? sessionId; history.push({v: earlier.v, r: r.text});
    }
    // An action request carries the game's offer (the host arms it only for a private turn of an identified user, which the throwaway end user is).
    setup.delivered.length = 0;
    reply = await setup.host.reply({key: setup.key, characterId, endUserId, scope: 'private', ttsEnabled: false, text: turn.text, context: turn.context,
      ...(scn.offer ? {companionAction: offerFor(scn, turn.persona.name)} : {}), ...(sessionId ? {sessionId} : {})});
  } catch (e) { error = redact(String(e?.message ?? e), setup.key).slice(0, 200); }
  const raw = reply?.text ?? '', spoken = spokenText(raw);
  return {id: scn.id, sample, group: scn.group, char: scn.char, name: turn.persona.name, playerText: scn.text, want: scn.want, history,
    contextSent: turn.context, prompt: null, ...(scn.offer ? {offer: scn.offer, action: setup.delivered.length ? Object.keys(setup.delivered[0]).filter(k => !['version', 'token', 'source', 'expiresAt'].includes(k)) : []} : {}), raw, spoken, ms: Date.now() - at, llmMs: reply?.timing?.llmMs ?? null, requestCount: 1 + history.length,
    ...(error ? {error} : {}), ...checks(spoken, {name: turn.persona.name, playerText: scn.text, raw})};
}

// ---- main ---------------------------------------------------------------------------------------------------------------
let setup, localHandle = null, started = Date.now(), run;
try {
  if (providerName === 'mistral') setup = await mistralProvider();
  else if (providerName === 'local' || providerName === 'custom') {
    const local = await startLocal({pin: option('pin', 'lite'), mature: matureOn, log: m => { if (flag('verbose')) console.error(m); }});
    localHandle = local.status;
    console.log(`local model ready: ${local.status.model} (tier ${local.status.tier}, context ${local.handle.contextSize})`);
    setup = providerName === 'local' ? localProvider(local.server) : await customProvider(local.server);
    setup.server = local.server;
  } else if (providerName === 'convai') { setup = await convaiSetup(); setup.endUsers = []; }
  else throw Error(`unknown provider ${providerName}`);

  const jobs = scenarios.flatMap(scn => Array.from({length: n}, (_, i) => ({scn, sample: i + 1})));
  const results = [], failures = [];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const {scn, sample} = jobs[next++];
      try {
        const row = providerName === 'convai' ? await runConvaiTurn(setup, scn, sample) : await runTextTurn(setup, scn, sample);
        results.push(row); if (row.error) failures.push({id: scn.id, error: row.error});
      } catch (e) { failures.push({id: scn.id, error: String(e?.message ?? e).slice(0, 200)}); }
      done++;
      if (done % 5 === 0 || done === jobs.length) console.log(`  ${done}/${jobs.length} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
  };
  await Promise.all(Array.from({length: concurrency}, worker));
  results.sort((a, b) => a.id.localeCompare(b.id) || a.sample - b.sample);
  const times = results.filter(r => !r.error && Number.isFinite(r.ms)).map(r => r.ms);
  run = {label, provider: providerName, profiles: profilesMode, candidate: candidateFile || undefined, mature: matureOn || undefined, model: providerName === 'mistral' ? model : (localHandle?.model ?? providerName), voice, at: new Date().toISOString(), n,
    summary: {replies: results.filter(r => !r.error).length, failed: failures.length, msP50: quant(times, 0.5), msP90: quant(times, 0.9),
      meanWords: +(results.reduce((a, r) => a + (r.words ?? 0), 0) / Math.max(1, results.length)).toFixed(1),
      promptTokensMean: Math.round(results.reduce((a, r) => a + (r.promptTokens ?? 0), 0) / Math.max(1, results.filter(r => r.promptTokens).length)),
      completionTokensMean: Math.round(results.reduce((a, r) => a + (r.completionTokens ?? 0), 0) / Math.max(1, results.filter(r => r.completionTokens).length))},
    results, failures};
  await writeFile(resolve(dataDir, `${label}.json`), JSON.stringify(run, null, 1));
  if (setup?.endUsers?.length) await writeFile(resolve(dataDir, `convai-audit-end-users-${label}.json`), JSON.stringify(setup.endUsers, null, 1));
  console.log(`${label}: ${JSON.stringify(run.summary)} -> ${resolve(dataDir, `${label}.json`)}`);
  for (const f of failures.slice(0, 6)) console.log('  failed', f.id, f.error);
} finally {
  try { await setup?.host?.close?.(); } catch { /* best effort */ }
  if (providerName === 'local' || providerName === 'custom') await stopLocal();
}
process.exit(0);
