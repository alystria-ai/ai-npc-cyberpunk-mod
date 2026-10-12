// How long does a turn's knowledge preparation take, from the real parts the game published?
// (docs/QUEST_DECISIONS.md, step 1.) knowledgePreparedMs in runtime/bridge-latency.json is the time from the turn arriving to
// the knowledge being ready (the admission step before it parses the request and hashes it): PlayerKnowledge.prepare, which runs parseWorldSnapshot, resolveKnowledge (the pack's rules over the
// snapshot) and withConversationKnowledge (journal history, recent events, open jobs).
//
//   node scripts/Measure-KnowledgePrepare.mjs --runtime <folder with knowledge-*.json and last-input.json> [--turns 40]
//        [--profiles judy-alvarez,johnny-silverhand,...] [--json]
//
// Read-only: it copies nothing, calls no provider and sends no turn. Point --runtime at a COPY of the game's runtime folder
// (the installed files are only read). Prints the admission step (request parse and parts) and the prepare step per profile,
// cold (first turn) and warm (the median and the worst of the rest), then the budgeted context of each profile.
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {configureKnowledgeParts} from '../bridge/knowledge-parts.mjs';
import {parseInput} from '../bridge/protocol.mjs';
import {PlayerKnowledge} from '../bridge/player-knowledge.mjs';
import {parsedInputIdentity} from '../bridge/group-prefetch.mjs';
import {resolveKnowledge} from '../bridge/world-knowledge.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const runtime = option('--runtime');
if (!runtime) throw Error('usage: node scripts/Measure-KnowledgePrepare.mjs --runtime <folder> [--turns 40] [--profiles a,b]');
const TURNS = Math.max(2, Number(option('--turns', 40)));
const PROFILES = String(option('--profiles', 'judy-alvarez,panam-palmer,johnny-silverhand,jackie-welles,takemura,kerry-eurodyne,river-ward,evelyn-parker,hanako-arasaka,regina-jones')).split(',');
const AS_JSON = args.includes('--json');

const pack = JSON.parse(readFileSync(resolve(root, 'characters/world-knowledge.json'), 'utf8'));
const questCatalog = JSON.parse(readFileSync(resolve(root, 'research/cyberpunk/generated/quest-catalog.json'), 'utf8'));
const lastInput = JSON.parse(readFileSync(resolve(runtime, 'last-input.json'), 'utf8'));
const header = lastInput.worldKnowledge;
const capturedAt = Date.parse(header.capturedAt);
const binding = {worldToken: header.worldToken, generation: header.generation};
configureKnowledgeParts({runtimeDir: runtime});

const memory = {route: profile => ({endUserId: `measure-${profile}`, guard: {endUserId: `measure-${profile}`, characterId: profile,
  resetEpoch: 0, characterEpoch: 0}}), isCurrent: () => true};
const router = new PlayerKnowledge({playerMemory: memory, pack, questCatalog, now: () => capturedAt + 1000,
  isWorldCurrent: () => true, getBoundary: () => binding});

const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const round = value => Math.round(value * 10) / 10;
const result = {runtime, turns: TURNS, admission: {}, prepare: {}, contexts: {}};

for (const profile of PROFILES) {
  const request = {...lastInput, profileKey: profile, name: profile};
  request.requestId = `${1791832762 + PROFILES.indexOf(profile)}-${request.generation}-${request.entity}`;
  const admission = [], prepare = [];
  let context = '';
  for (let turn = 0; turn < TURNS; turn += 1) {
    // Each turn is a new file read from the game: the raw text is parsed again (parts resolved from the cache or disk).
    const raw = JSON.stringify({...request, text: `${request.text} ${turn}`});
    let started = performance.now();
    const input = parseInput(raw);
    parsedInputIdentity(input); // the poll hashes every new request to tell it from the last one
    admission.push(performance.now() - started);
    if (!input) throw Error(`the request for ${profile} did not parse`);
    started = performance.now();
    const prepared = await router.prepare(input, {channel: 'private', ...binding});
    prepare.push(performance.now() - started);
    context = prepared.input?.worldKnowledge ? '' : context;
  }
  result.admission[profile] = {coldMs: round(admission[0]), medianMs: round(median(admission.slice(1))), worstMs: round(Math.max(...admission.slice(1)))};
  result.prepare[profile] = {coldMs: round(prepare[0]), medianMs: round(median(prepare.slice(1))), worstMs: round(Math.max(...prepare.slice(1)))};
}

// What each profile is told, by the resolver alone (the same call prepare makes).
const world = parseInput(JSON.stringify({...lastInput, requestId: lastInput.requestId})).worldKnowledge;
for (const profile of PROFILES) {
  const snapshot = {...world, audience: {channel: 'private', profileKeys: [profile]}, identity: {status: 'unknown'}};
  const resolved = resolveKnowledge({pack, snapshot, profileKey: profile, query: 'is it', maxChars: 8000});
  const counts = resolved.diagnostics.counts;
  let facts = [], choices = [];
  try { const data = JSON.parse(resolved.context.slice(resolved.context.indexOf('\n') + 1)); facts = data.facts ?? []; choices = data.choices ?? []; } catch { /* a context that is not JSON */ }
  result.contexts[profile] = {chars: resolved.context.length, true: counts.true, selected: counts.selected, omitted: counts.omitted,
    choices: choices.length, facts: facts.length, outsideAudience: counts.outsideAudience,
    decisionsDropped: resolved.diagnostics.decisions?.dropped, decisionsSelected: resolved.diagnostics.decisions?.selected,
    decisionsTrue: resolved.diagnostics.decisions?.true};
}

if (AS_JSON) console.log(JSON.stringify(result, null, 1));
else {
  console.log(`runtime ${runtime}, ${TURNS} turns per profile`);
  console.log('profile'.padEnd(20), 'admission cold/med/worst'.padEnd(26), 'prepare cold/med/worst');
  for (const profile of PROFILES) {
    const a = result.admission[profile], p = result.prepare[profile];
    console.log(profile.padEnd(20), `${a.coldMs} / ${a.medianMs} / ${a.worstMs}`.padEnd(26), `${p.coldMs} / ${p.medianMs} / ${p.worstMs}`);
  }
  console.log('\nprofile'.padEnd(21), 'true  selected  omitted  decisions(true/kept/dropped)  chars');
  for (const profile of PROFILES) {
    const c = result.contexts[profile];
    console.log(profile.padEnd(20), String(c.true).padEnd(5), String(c.selected).padEnd(9), String(c.omitted).padEnd(8),
      `${c.decisionsTrue ?? '-'}/${c.decisionsSelected ?? '-'}/${c.decisionsDropped ?? '-'}`.padEnd(29), c.chars);
  }
}
