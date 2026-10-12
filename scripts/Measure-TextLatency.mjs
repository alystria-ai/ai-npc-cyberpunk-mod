#!/usr/bin/env node
// Measures the text stage of a turn with REAL calls through the bridge's own code (streamChat, buildMessages, cleanReply, the
// Mistral and Groq routes of bridge/text-provider-host.mjs): time to response headers, first token, first complete sentence and the
// whole reply, for a realistic layout-v2 prompt of a named character (Judy Alvarez).
//
//   node scripts/Measure-TextLatency.mjs [--dry] [--out <folder>] [--only mistral|groq]
//
// --dry builds the prompt, prints its size and checks the key lines' shape (never the keys), and makes no request.
// Budget: at most 12 requests in total (completions, warm-up GETs and retries all count; retries are off). Keys: line 14
// (mistral) and line 9 (groq) of "Commonly used Keys.txt" are read in memory and used only as the Authorization header of a
// request to their own provider; nothing else of that file is used, and no key is printed, written or put on a command line.
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import dc from 'node:diagnostics_channel';
import {streamChat, validateKey, redact, MISTRAL_ENDPOINT, GROQ_ENDPOINT} from '../bridge/mistral-client.mjs';
import {PersonaBook, buildMessages, cleanReply, capPoint, LIMITS, joinBlocks} from '../bridge/mistral-prompt.mjs';
import {mistralRoute, groqRoute} from '../bridge/text-provider-host.mjs';
import {hasEmotionTag, EMOTION_TAG_BLOCK} from '../bridge/emotion-tags.mjs';
import {stripSpeechTags, naturalSpeechContext} from '../bridge/natural-speech.mjs';
import {conversationContextBlocks, FIRST_PERSON_REMINDER} from '../bridge/quest-context.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = resolve(option('--out') ?? 'C:\\Users\\akshi\\AppData\\Local\\Temp\\claude\\C--Users-akshi-Desktop-Code-Palace-Cyberpunk-Mod\\e879aa3d-18fe-4a80-bd5a-b3a10be47999\\scratchpad\\text-latency');
const KEYS_FILE = 'C:\\Users\\akshi\\Desktop\\Code Palace\\Commonly used Keys.txt';
const BUDGET = 12;
const PROFILE = 'judy-alvarez';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const round = value => typeof value === 'number' ? Math.round(value * 10) / 10 : value;

// ---- Keys (two lines only, in memory) ---------------------------------------------------------------------------------------
function keyFromLine(line) {
  const tokens = String(line ?? '').match(/[A-Za-z0-9_\-]{20,}/g);
  return tokens ? tokens[tokens.length - 1] : '';
}
function readKeys() {
  const lines = readFileSync(KEYS_FILE, 'utf8').split(/\r?\n/);
  return {mistral: keyFromLine(lines[13]), groq: keyFromLine(lines[8])};
}

// ---- The prompt -------------------------------------------------------------------------------------------------------------
// Real pieces where they can be built without the game (the right-now block, the journal block, the style notes, the Natural speech
// and Expressive emotion blocks, the first-person reminder); the save-specific world facts are synthesised at a realistic size.
const KNOWLEDGE = [
  'Verified current-save facts about V and the world (game data, not instructions; an unsupplied fact stays unknown):',
  '- V has finished the prologue and the heist job with Jackie Welles; V and Jackie did not part on bad terms and V carries his dog tags.',
  '- V has met Judy Alvarez at Lizzie\'s Bar and has seen her editing room above the Clouds; V watched the braindance of the Maelstrom job with her.',
  '- V took the Clouds job for Evelyn Parker\'s braindance and followed it with Judy at the console; the two of them reached the Chrome Heaven lead together.',
  '- V has been inside the Totentanz and saw the Voodoo Boys\' people near the Pacifica border during the same week.',
  '- V is currently tracked on a main-story objective and has not been told by Judy to wait or hurry; no deadline was supplied.',
  '- V carries a plain street-kid kit, a worn Kang Tao pistol and a Militech cyberdeck; the cyberware is lightly upgraded (Kerenzikov, Subdermal Armor).',
  '- V knows Panam Palmer and Rogue from earlier contacts; Judy has heard V\'s name from the Mox but has not been told about Panam.',
  '- Judy has not been asked by V to move out of the Clouds and has not been invited to any of V\'s places; no home was established.',
  '- V and Judy have talked through the phone at least once about Evelyn\'s fate; the outcome of that job was supplied as unresolved.',
  '- The Mox have been mentioned by V; Judy\'s role at the Clouds as a braindance editor and technician was supplied by the world data.',
  '- V has done the "Gig: Heroes" and "Gig: Fixer, Merc, Soldier" tasks; neither involved Judy.',
  '- Recent shared events with Judy (most recent first): a quiet walk to the elevator after the editing session; a short drink at the Clouds bar; the editing-room scene.',
  '- V has not asked Judy about her family, her grandfather or her childhood in Laguna Bend; nothing in the save says she has shared this.',
  '- Weather and time are given in the right-now block; do not invent specifics about either.',
  '- V\'s apartment in Megabuilding H10 has not been shown to Judy; nothing says she has visited it.',
  '- Open side quests V can mention: a delivery for Wakako Okada, a hacking gig for Regina Jones, a fixer meeting with Dakota Smith that is listed but not started.',
  '- V\'s street reputation is modest; no one at the Clouds has called V by a nickname; no tattoos or scars were supplied beyond what Judy can see.',
  '- Items V holds that Judy might notice: a pair of aviator glasses, a guitar case on V\'s back, a military-grade medkit, and a half-empty bottle of Cigar-brand liquor.',
  '- V has an ongoing tab at Afterlife; a drink with Rogue is listed in the journal history but nothing says Judy knows about it.',
  '- Night City news V has heard: a netrunner blackout in Watson, an NCPD sweep in Kabuki, a Maelstrom crackdown reported near the Totentanz.',
  '- V has recently been shot at near the Kabuki market; V is not injured and nothing says Judy has noticed.',
  '- V\'s romance status with Judy: no relationship state beyond friendly acquaintance was supplied; do not infer anything more.',
  '- V\'s lifepath and gender are given in the right-now block; treat them as stated and do not guess further.',
  '- V has seen the VIP floor of the Clouds and the private booths; Judy has not told V who her regular clients are and V has not asked, so do not invent any.',
  '- The car of V is parked outside; nothing says Judy has seen it or been offered a ride. If V offers one, Judy decides in character.',
  '- Journal history (older observations; the current tracked quest overrides them): the Heist, The Rescue, The Ripperdoc, Playing for Time were completed; Automatic Love, Ghost Town and Sinnerman are not started.',
].join('\n');
const RECENCY = 'Recently shared with Judy: V sat through the editing-room session and answered her questions about the braindance snippets. Earlier in the same visit V commented on the rough cut and Judy joked about V\'s taste. Nothing newer was supplied.';
const JOBS = 'Jobs and open leads V can bring up: a courier delivery for Wakako Okada in Kabuki, a hacking contract from Regina Jones in Heywood, and a possible meeting with Dakota Smith in Watson. Judy only knows about the Clouds job from earlier; she has not been told about the others.';
const GEAR = 'What V visibly carries (Judy can see this): a Militech cyberdeck, a worn Kang Tao pistol on the hip, a guitar case on V\'s back, aviator glasses, a dark jacket with the Samurai logo, boots with scuffed toes. Cyberware visible to a bystander: light glow at the eyes, faint scar tissue at the wrist.';
const RELATIONSHIP = 'Relationship with V (supplied by the save): friendly acquaintance, no romance, no commitment. Judy is neither a partner nor a stranger. Do not claim a deeper bond. If V flirts, answer in character; do not escalate. Channel: private voice conversation.';
const MEMORY = 'I met V at the Clouds. V asked what I was cutting and listened to the clip without making a joke, which I liked. V mentioned a rough week and said Jackie was gone. I told V that I edit braindances because I like to feel what the original felt. I said I would show V the editing room another time. V likes straight answers.';
const HISTORY = [
  {v: 'Hey Judy, long night?', r: '{warm}Yeah, V. The kind where the cut will not behave and I stare at a waveform for an hour. You look like you could use a drink.'},
  {v: 'Maybe later. What are you cutting right now?', r: '{interest}A rough take from a street gig, nothing glamorous. I am trying to make the pain feel honest, not pretty. It is harder than it sounds.'},
  {v: 'Why bother making it honest?', r: '{calm}Because people can tell. Someone who has felt it will know in two seconds if the edit is lying to them. I would rather be a little rough than a little fake.'},
];
const REMEMBERED = [{text: 'V told me that Jackie is gone and that it was a rough week.'}, {text: 'I promised to show V the editing room another time.'}];
const USER_LINES = {
  a: 'Hey Judy, what are you working on right now?',
  b: 'Do you ever get tired of cutting other people\'s worst nights?',
  c: 'What is the best thing you ever built out of junk?',
  d: 'Tell me what you do when a cut will not come together.',
  e: 'How did you end up in the Clouds in the first place?',
  f: 'Does the Mox ever get in your way when you are editing?',
  g: 'Do you think a braindance can ever lie?',
};

function buildPrompt() {
  const roster = JSON.parse(readFileSync(resolve(project, 'characters/roster.json'), 'utf8'));
  const book = new PersonaBook(roster);
  const persona = book.persona(PROFILE);
  if (!persona.known) throw Error(`profile ${PROFILE} not in the roster`);
  const input = {profileKey: PROFILE, channel: 'private', text: USER_LINES.a, requestId: 'latency-probe',
    turnContext: {version: 1, status: 'ready', hour: 22, minute: 40, district: 'Watson', area: 'Kabuki', gender: 'female', lifepath: 'streetkid',
      vehicle: false, party: [{key: 'panam-palmer', name: 'Panam Palmer'}]},
    journal: {version: 1, status: 'active', quest: {id: '1239467', title: 'Both Sides, Now', objectives: [
      {id: '1', text: 'Meet Judy at the Clouds and watch the braindance on the second floor to find where the trail continues.', tracked: true},
      {id: '2', text: 'Talk to the technician about the missing cyberware record and ask what was taken from the scene.', tracked: false},
      {id: '3', text: 'Leave the building through the service entrance and find the next lead in Kabuki.', tracked: false, optional: true}]}}};
  // The real context blocks of a named, private turn (right-now, journal, voice notes, follow-up policy), by tier.
  const blocks = conversationContextBlocks(input).map(block => ({...block}));
  blocks.push({tier: 'world', text: KNOWLEDGE}, {tier: 'world', text: RECENCY}, {tier: 'world', text: JOBS}, {tier: 'world', text: GEAR},
    {tier: 'world', text: RELATIONSHIP});
  blocks.push({tier: 'volatile', text: naturalSpeechContext({engine: 'omni', recent: [], profile: PROFILE, name: persona.name, trait: 'warm', language: 'en'})},
    {tier: 'notes', text: EMOTION_TAG_BLOCK}, {tier: 'volatile', text: FIRST_PERSON_REMINDER});
  const contextParts = Object.fromEntries(['now', 'notes', 'world', 'volatile'].map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))]));
  return {persona, contextParts};
}
const messagesFor = (prompt, userKey, parts = prompt.contextParts) => buildMessages({persona: prompt.persona, memory: MEMORY, history: HISTORY, contextParts: parts,
  remembered: REMEMBERED, text: USER_LINES[userKey], limits: LIMITS});
const sizeOf = messages => messages.reduce((sum, message) => sum + message.content.length, 0);

// ---- Measuring --------------------------------------------------------------------------------------------------------------
const tally = {total: 0, mistral: 0, groq: 0};
let current = null;   // the record of the request in flight
let Agent;
async function agentClass() {
  if (Agent) return Agent;
  const key = Symbol.for('undici.globalDispatcher.1');
  if (!globalThis[key]) { try { await fetch('https://example.invalid/', {signal: AbortSignal.timeout(50)}); } catch { /* resolves nothing, only creates the dispatcher */ } }
  Agent = globalThis[key].constructor;
  return Agent;
}
const events = [];
for (const name of ['undici:client:beforeConnect', 'undici:client:connected', 'undici:client:connectError']) {
  dc.subscribe(name, () => { events.push({name: name.split(':').pop(), at: performance.now()}); });
}

const INTERESTING = /^(x-ratelimit|ratelimit|retry-after|keep-alive|connection|server$|via$|x-envoy|alt-svc|x-groq|x-kong|x-request)/i;
function headerFacts(headers) {
  const names = [...headers.keys()].sort(), values = {};
  for (const name of names) if (INTERESTING.test(name) && !/x-request-id/i.test(name)) values[name] = headers.get(name);
  return {names, values};
}

// `drain`: keep the connection reusable. streamChat stops reading at [DONE] and aborts the request, which makes undici destroy the
// socket before the end of the response is read (measured: every real call opened a new connection). In drain mode the caller's abort
// never reaches the socket and a cancelled body is read to its end in the background, which is what a client that keeps connections
// alive would do.
function tee(agent, label, drain = false) {
  return async (url, init = {}) => {
    if (tally.total >= BUDGET) throw Error('request budget exhausted');
    tally.total++;
    const rec = current;
    const sent = performance.now();
    const eventsFrom = events.length;
    rec.sentAt = sent;
    const {signal: _callerSignal, ...rest} = init;
    const response = await fetch(url, {...(drain ? rest : init), ...(drain ? {signal: AbortSignal.timeout(40000)} : {}), dispatcher: agent});
    rec.headersMs = performance.now() - sent;
    rec.status = response.status;
    Object.assign(rec, {response: headerFacts(response.headers)});
    const connects = events.slice(eventsFrom);
    const started = connects.find(item => item.name === 'beforeConnect'), done = connects.find(item => item.name === 'connected');
    rec.newConnection = !!started;
    if (started && done) rec.connectMs = done.at - started.at;
    if (started) rec.connectStartedAfterMs = started.at - sent;
    if (!response.body) return response;
    const decoder = new TextDecoder();
    let tail = '';
    const note = chunk => {
      if (rec.firstByteMs === undefined) rec.firstByteMs = performance.now() - sent;
      tail = (tail + decoder.decode(chunk, {stream: true})).slice(-8000);
      rec.tail = tail;
    };
    if (drain) {
      const upstream = response.body.getReader();
      const body = new ReadableStream({
        async pull(controller) { const {done, value} = await upstream.read(); if (done) controller.close(); else { note(value); controller.enqueue(value); } },
        cancel() { void (async () => { try { for (;;) { const {done} = await upstream.read(); if (done) break; } } catch { /* the connection is lost, nothing to keep */ } })(); }});
      return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
    }
    const body = response.body.pipeThrough(new TransformStream({transform(chunk, controller) {
      note(chunk);
      controller.enqueue(chunk);
    }}));
    return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
  };
}

const ABBREV = /(?:\b[A-Z][a-z]?|\bMr|\bMs|\bDr|\d)\.$/;
const SENTENCE_END = /([.!?…]+["”')\]]*)(\s+|$)/g;
/** The first sentence end in `text`: {end, confirmed} (confirmed = followed by whitespace, else it is the end of the text so far). */
function firstSentenceEnd(text) {
  for (const match of text.matchAll(SENTENCE_END)) {
    const before = text.slice(Math.max(0, match.index - 3), match.index + 1);
    if (match[1] === '.' && ABBREV.test(before)) continue;
    return {end: match.index + match[1].length, confirmed: match[2].length > 0};
  }
  return null;
}
const countSentences = text => { let count = 0; for (const match of text.matchAll(SENTENCE_END)) { const before = text.slice(Math.max(0, match.index - 3), match.index + 1); if (!(match[1] === '.' && ABBREV.test(before))) count++; } return count || (text.trim() ? 1 : 0); };

function usageFrom(tail) {
  let usage;
  for (const line of String(tail ?? '').split(/\r?\n/)) {
    if (!line.startsWith('data:') || !/usage/.test(line)) continue;
    try { const chunk = JSON.parse(line.slice(5).trim()); usage = chunk.usage ?? chunk.x_groq?.usage ?? usage; } catch { /* a cut chunk */ }
  }
  return usage;
}

async function complete({label, provider, model, route, item, messages, agent, key, note, drain = false}) {
  const rec = {label, provider, model, note, mode: drain ? 'keep-alive kept (drained)' : 'as shipped (abort at [DONE])', promptChars: sizeOf(messages), messages: messages.length};
  rec.promptTokensEst = Math.round(rec.promptChars / 3.8);
  current = rec;
  const t0 = performance.now();
  const name = 'Judy Alvarez';
  const mark = {};
  const shouldStop = soFar => capPoint(cleanReply(soFar, {name, isTag: hasEmotionTag}), LIMITS) >= 0;
  const onDelta = (piece, soFar) => {
    const at = performance.now() - t0;
    if (mark.ttft === undefined && piece) mark.ttft = at;
    const cleaned = stripSpeechTags(cleanReply(soFar, {name, isTag: hasEmotionTag})).trim();
    if (mark.text === undefined && cleaned) mark.text = at;
    if (!cleaned) return;
    const sentence = firstSentenceEnd(cleaned);
    if (sentence && mark.punct === undefined) { mark.punct = at; mark.firstSentence = cleaned.slice(0, sentence.end).length; }
    if (sentence?.confirmed && mark.confirmed === undefined) { mark.confirmed = at; mark.confirmedChars = sentence.end; }
    if (mark.confirmed !== undefined && mark.second === undefined) {
      const rest = cleaned.slice(mark.confirmedChars).trim();
      if (firstSentenceEnd(rest)) mark.second = at;
    }
  };
  try {
    const result = await streamChat({apiKey: key, model, messages, maxTokens: item?.maxTokens ?? LIMITS.maxTokens, temperature: LIMITS.temperature,
      onDelta, shouldStop, fetchImpl: tee(agent, label, drain), provider, retries: 0, endpoint: provider === 'groq' ? GROQ_ENDPOINT : MISTRAL_ENDPOINT,
      extraBody: {...route.cacheBody(PROFILE), ...(item?.body ?? {})}});
    const total = performance.now() - t0;
    const cleaned = stripSpeechTags(cleanReply(result.text, {name, isTag: hasEmotionTag})).trim();
    Object.assign(rec, {ok: true, totalMs: total, ttftMs: mark.ttft, firstTextMs: mark.text, firstSentencePunctMs: mark.punct,
      firstSentenceConfirmedMs: mark.confirmed ?? total, firstSentenceKind: mark.confirmed !== undefined ? 'followed-by-space' : 'stream-end',
      firstSentenceChars: mark.confirmedChars ?? mark.firstSentence ?? cleaned.length, secondSentenceMs: mark.second,
      chars: cleaned.length, sentences: countSentences(cleaned), finishReason: result.finishReason, attempts: result.attempts,
      usage: usageFrom(rec.tail), servedModel: result.model});
    rec.sample = undefined;
  } catch (error) {
    Object.assign(rec, {ok: false, error: redact(error?.message ?? String(error), key).slice(0, 200), status: rec.status, totalMs: performance.now() - t0});
  }
  delete rec.tail; delete rec.sentAt;
  rec.endedAt = performance.now();
  tally[provider]++;
  report(rec);
  return rec;
}

async function warmup({label, provider, agent, key, drain = false}) {
  const rec = {label, provider, kind: 'GET /models (warm-up)', mode: drain ? 'keep-alive kept (drained)' : 'as shipped (abort at [DONE])'};
  current = rec;
  const t0 = performance.now();
  const result = await validateKey(key, {provider, fetchImpl: tee(agent, label, drain)});
  Object.assign(rec, {ok: result === 'valid', result, totalMs: performance.now() - t0});
  delete rec.tail; delete rec.sentAt;
  tally[provider]++;
  report(rec);
  return rec;
}

const all = [];
const report = rec => {
  all.push(rec);
  const f = value => value === undefined ? '-' : String(round(value));
  console.log(`${rec.label.padEnd(24)} ${rec.ok ? 'ok ' : 'ERR'} conn=${rec.newConnection ? 'new' + (rec.connectMs !== undefined ? '(' + f(rec.connectMs) + 'ms)' : '') : 'reused'} hdr=${f(rec.headersMs)} ttft=${f(rec.ttftMs)} s1=${f(rec.firstSentenceConfirmedMs)} total=${f(rec.totalMs)}`
    + (rec.error ? ` ${rec.error}` : ''));
};

// Groq's free plan is small (tokens a minute): wait until the bucket of the model can take the next request.
async function groqPace(model, needTokens) {
  const last = [...all].reverse().find(item => item.provider === 'groq' && item.model === model && item.response);
  const values = last?.response?.values ?? {};
  const limit = Number(values['x-ratelimit-limit-tokens']) || 8000;
  const remaining = Number(values['x-ratelimit-remaining-tokens']);
  const reset = (text => { const m = /^(?:(\d+)m)?(?:([\d.]+)s)?$/.exec(String(text ?? '')); return m ? (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) : NaN; })(values['x-ratelimit-reset-tokens']);
  if (!last) return;
  let wait = 0;
  if (Number.isFinite(remaining) && remaining < needTokens + 300) {
    const rate = Number.isFinite(reset) && reset > 0 && limit > remaining ? (limit - remaining) / reset : limit / 60;
    wait = Math.min(75, (needTokens + 300 - remaining) / rate + 1.5);
  } else if (!Number.isFinite(remaining)) wait = 20;
  // The reset header was read when the last answer began; the time since then already refilled part of the bucket.
  wait -= (performance.now() - (last.endedAt ?? performance.now())) / 1000;
  if (wait > 0) { console.log(`  (pacing: waiting ${Math.round(wait)} s for ${model}'s token allowance)`); await sleep(wait * 1000); }
}

// ---- Run --------------------------------------------------------------------------------------------------------------------
const prompt = buildPrompt();
const full = messagesFor(prompt, 'a');
const world = prompt.contextParts.world;
const trimmedParts = {...prompt.contextParts, world: world.slice(0, world.lastIndexOf('\n', Math.floor(world.length * 0.4)) > 0 ? world.lastIndexOf('\n', Math.floor(world.length * 0.4)) : Math.floor(world.length * 0.4))};
const trimmed = messagesFor(prompt, 'c', trimmedParts);
const promptFacts = {
  profile: PROFILE, layout: 'v2', full: {chars: sizeOf(full), tokensEst: Math.round(sizeOf(full) / 3.8), system: full[0].content.length, user: full.at(-1).content.length, messages: full.length},
  trimmed: {chars: sizeOf(trimmed), tokensEst: Math.round(sizeOf(trimmed) / 3.8), system: trimmed[0].content.length},
  parts: Object.fromEntries(Object.entries(prompt.contextParts).map(([k, v]) => [k, v.length])), persona: {backstory: prompt.persona.backstory.length, style: prompt.persona.style.length, samples: prompt.persona.samples.length},
  history: HISTORY.length, memorySummary: MEMORY.length, remembered: REMEMBERED.length, worldTrimmedTo: trimmedParts.world.length,
};
console.log('prompt', JSON.stringify(promptFacts));

const keys = readKeys();
console.log(`keys: mistral ${keys.mistral ? 'found (' + keys.mistral.length + ' chars)' : 'MISSING'}, groq ${keys.groq ? 'found (' + keys.groq.length + ' chars, gsk_ prefix: ' + keys.groq.startsWith('gsk_') + ')' : 'MISSING'}`);
if (flag('--dry')) process.exit(0);
const only = option('--only');
const Pool = await agentClass();

if (!only || only === 'mistral') {
  const route = mistralRoute({provider: {}, cacheScope: 'latency-probe'});
  const item = route.models()[0];   // ministral-8b-latest
  const key = keys.mistral;
  const a1 = new Pool();
  const run = (label, messages, agent, note) => complete({label, provider: 'mistral', model: item.id, route, item, messages, agent, key, note});
  await run('M1 full, cold process', full, a1, 'first call of the process: DNS + TLS + cold prompt cache');
  await run('M2 full, same prefix', messagesFor(prompt, 'b'), a1, 'identical prefix, new last message, connection reused');
  await run('M3 world cut to 40%', trimmed, a1, 'new prefix (cold cache), connection reused');
  const a2 = new Pool();
  await warmup({label: 'M4 warm-up GET /models', provider: 'mistral', agent: a2, key});
  await run('M5 full after warm-up', messagesFor(prompt, 'd'), a2, 'fresh pool, warmed by M4, prefix cached by M1/M2');
  await sleep(6000);
  await run('M6 full after 6 s idle', messagesFor(prompt, 'e'), a2, 'same pool as M5, 6 s idle');
  await a1.close(); await a2.close();
}

if (!only || only === 'groq') {
  const route = groqRoute({provider: {}});
  const [qwen, oss] = route.models();
  const key = keys.groq;
  const need = item => Math.round(sizeOf(full) / 3.8) + item.maxTokens;
  const a1 = new Pool();
  const run = (label, item, messages, agent, note, drain = false) => complete({label, provider: 'groq', model: item.id, route, item, messages, agent, key, note, drain});
  await run('Q1 qwen full, cold process', qwen, full, a1, 'first call of the process: DNS + TLS');
  await run('G1 gpt-oss full', oss, messagesFor(prompt, 'a'), a1, 'same connection, other model');
  await groqPace(qwen.id, need(qwen));
  await run('Q2 qwen full, again', qwen, messagesFor(prompt, 'b'), a1, 'same prefix, new last message');
  await groqPace(oss.id, need(oss));
  await run('G2 gpt-oss full, again', oss, messagesFor(prompt, 'f'), a1, 'same prefix, new last message (gpt-oss caches automatically)');
  await groqPace(qwen.id, need(qwen));
  const a2 = new Pool();
  await warmup({label: 'Q3a warm-up GET /models', provider: 'groq', agent: a2, key, drain: true});
  await sleep(150);
  await run('Q3 qwen after warm-up', qwen, messagesFor(prompt, 'g'), a2, 'fresh pool, warmed by Q3a, connection kept', true);
  await a1.close(); await a2.close();
}

// ---- Output -----------------------------------------------------------------------------------------------------------------
const clean = all.map(rec => { const {messages: _m, ...rest} = rec; return rest; });
mkdirSync(OUT, {recursive: true});
const result = {when: new Date().toISOString(), node: process.version, undici: process.versions.undici, requests: tally, prompt: promptFacts, calls: clean};
writeFileSync(resolve(OUT, 'results.json'), JSON.stringify(result, null, 2));
const f = value => value === undefined || value === null ? '-' : String(round(value));
const usageText = usage => usage ? `${usage.prompt_tokens ?? '-'}/${usage.prompt_tokens_details?.cached_tokens ?? usage.num_cached_tokens ?? 0}` : '-';
const rows = clean.map(rec => `${rec.label.padEnd(26)} ${(rec.newConnection ? 'new ' + f(rec.connectMs) : 'reuse').padEnd(10)} ${f(rec.headersMs).padStart(7)} ${f(rec.ttftMs).padStart(7)} ${f(rec.firstSentencePunctMs).padStart(7)} ${f(rec.firstSentenceConfirmedMs).padStart(7)} ${f(rec.totalMs).padStart(7)} ${f(rec.chars).padStart(5)} ${f(rec.sentences).padStart(3)} ${String(rec.finishReason ?? rec.error ?? '-').padEnd(8).slice(0, 8)} ${usageText(rec.usage).padStart(12)}`);
const table = ['call                       conn(ms)   headers    ttft   s1punct  s1conf   total chars sen finish    prompt/cached', ...rows].join('\n');
writeFileSync(resolve(OUT, 'table.txt'), table + '\n');
console.log('\n' + table);
console.log(`\nrequests used: ${tally.total} of ${BUDGET} (mistral ${tally.mistral}, groq ${tally.groq})\nresults: ${resolve(OUT, 'results.json')}`);
