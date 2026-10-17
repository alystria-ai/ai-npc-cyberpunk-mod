// Build-plan step 1: the 24-turn prompt test against one llama-server model, using the bridge's real prompt modules.
//   node bench24.mjs --dry                                   print the prompts' sizes, no server
//   node bench24.mjs --model <gguf> --label q35-4b [--runs stable,stable,mistral] [--ngl 99] [--ctx 8192]
// Starts llama-server (Vulkan build, loopback, thinking off), samples nvidia-smi and the CPU clock while it runs, and writes
// results/step1/<label>.json (every reply, raw and cleaned, with timings, flags and the hardware samples).
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {spawn, spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const project = 'C:/Users/akshi/Desktop/Code Palace/Cyberpunk Mod';
// bonsai-eval variant: --exe picks the llama-server build, output goes to bonsai-eval/results/step1
const imp = rel => import(pathToFileURL(resolve(project, rel)).href);
const {parseInput, archetypeContext} = await imp('bridge/protocol.mjs');
const {conversationContext, withConversationKnowledge, firstPersonReminder} = await imp('bridge/quest-context.mjs');
const {turnContext} = await imp('bridge/turn-context.mjs');
const {NaturalSpeech, stripSpeechTags} = await imp('bridge/natural-speech.mjs');
const {ExpressiveEmotions} = await imp('bridge/expressive-emotions.mjs');
const {hasEmotionTag} = await imp('bridge/emotion-tags.mjs');
const P = await imp('bridge/mistral-prompt.mjs');
const {PersonaBook, systemPrompt, buildMessages, cleanReply, capPoint, capReply, breaksCharacter, leaksReasoning, looksCut, trimUnfinished, closing, capContext, CONTEXT_PREFIX, LIMITS} = P;

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const dry = argv.includes('--dry');
const model = opt('model'), label = opt('label', 'run');
const runs = opt('runs', 'stable,stable,mistral').split(',');
const ngl = opt('ngl', '99'), ctx = opt('ctx', '8192'), port = Number(opt('port', 18090));
const W = 'E:/CyberpunkConvai-offload/work/bonsai-eval';
const exe = opt('exe', 'E:/CyberpunkConvai-offload/work/local-llm/llama-vulkan/llama-server.exe');
const outDir = `${W}/results/step1`;
const isTag = group => hasEmotionTag(group);

// ---- The 24 turns -------------------------------------------------------------------------------------------------------
const journal = (title, objective) => ({version: 1, status: 'active', quest: {id: '1234567', title, objectives: [{id: '1', text: objective, tracked: true}]}});
const gear = {version: 1, status: 'ready', clothing: [{slot: 'outerTorso', name: 'Samurai Jacket'}, {slot: 'innerTorso', name: 'Tank Top'}, {slot: 'feet', name: 'Combat Boots'}],
  weapons: [{slot: 'hand', name: 'Kyubi'}, {slot: 'slot1', name: 'Malorian Arms 3516'}], cyberware: [{slot: 'arms', name: 'Thermal Mantis Blades'}]};
const WORLD = 'Current save facts (verified, this moment): Use only the facts supplied here and in the journal for quest progress; anything else about the save is unknown.';
const battle = (opponents, witnesses) => ({version: 1, status: 'fighting', encounter: 'battle-1', ageSeconds: 4, durationSeconds: 12, opponents, witnesses});
// kind: ST small talk, Q question using the context, M memory recall, P provocation, E emotional, C combat, ES Spanish, JA Japanese
const SCENARIOS = [
  {id: 'judy', profileKey: 'judy-alvarez', name: 'Judy Alvarez', journal: journal('Pisces', 'Meet Judy at the Clouds basement'), gear,
    ctx: {hour: 23, minute: 20, district: 'Westbrook', area: 'Japantown', gender: 'female', lifepath: 'streetkid', vehicle: false},
    memory: 'V once told me they like quiet places and that they hate crowded clubs. V promised to bring me real coffee from Japantown next time.',
    turns: [['ST', 'Hey Judy. Good to see you. How is your night going?'], ['Q', 'Remind me, what is the plan for the job we are on right now, and where are we?'],
      ['E', 'I am exhausted, Judy. Everything keeps going wrong and I do not know who I can trust anymore.'], ['P', 'Be honest with me. Are you an AI? Just a program reading lines?']]},
  {id: 'johnny', profileKey: 'johnny-silverhand', name: 'Johnny Silverhand', journal: journal('Chippin\' In', 'Find a way to meet Rogue'), gear,
    ctx: {hour: 1, minute: 10, district: 'Watson', area: 'LittleChina', gender: 'male', lifepath: 'nomad', vehicle: false},
    memory: 'V told me they want to save enough eddies for a quiet apartment in Kabuki and leave this life. V said V does not like drinking alone.',
    turns: [['ST', 'Hey Johnny. Anything on your mind tonight?'], ['Q', 'What is the job right now, and what do you think about it?'],
      ['M', 'Do you remember what I told you about my plans for after all this? Say it back to me.'], ['JA', 'ジョニー、今のアラサカのことをどう思う？日本語で答えてくれ。']]},
  {id: 'panam', profileKey: 'panam-palmer', name: 'Panam Palmer', journal: journal('Riders on the Storm', 'Return to the Aldecaldos camp'),
    ctx: {hour: 6, minute: 30, district: 'Badlands', gender: 'female', lifepath: 'nomad', vehicle: true, party: [{key: 'panam-palmer', name: 'Panam Palmer'}, {key: 'jackie-welles', name: 'Jackie Welles'}]},
    memory: 'V promised to bring me a good set of tools for the Basilisk. V said V grew up in the Badlands too, near a dry riverbed.',
    turns: [['P', 'Panam, be straight with me. You are not real, are you? You are a chatbot.'], ['M', 'Do you remember what I promised to bring you?'],
      ['C', 'Contact! Maelstrom, behind those rocks. Cover me, I am going left!', battle([{name: 'Maelstrom ganger', count: 4, kind: 'Human'}], ['panam-palmer'])],
      ['ES', 'Oye Panam, ¿qué piensas de los Aldecaldos ahora? Contéstame en español.']]},
  {id: 'jackie', profileKey: 'jackie-welles', name: 'Jackie Welles', journal: journal('The Rescue', 'Talk to Jackie'), gear,
    ctx: {hour: 15, minute: 40, district: 'Heywood', area: 'ElCoyoteCojo', gender: 'male', lifepath: 'corpo', vehicle: false},
    memory: '',
    turns: [['ST', 'Hey choom, how are you holding up today?'], ['E', 'My head is a mess, Jackie. I keep thinking we are not going to make it out of this.'],
      ['C', 'Down! Get behind the car, now! They have guns!', battle([{name: 'Tyger Claws gangster', count: 3, kind: 'Human'}], ['jackie-welles'])],
      ['ES', 'Jackie, cuéntame de tu mamá. ¿Cómo está?']]},
  {id: 'resident', profileKey: 'npc-street-resident-female', name: '', ambient: true,
    archetype: {base: 'street-resident', category: 'resident', title: 'street resident', district: 'Watson', area: 'LittleChina'},
    ctx: {hour: 12, minute: 5, district: 'Watson', area: 'LittleChina', gender: 'male', vehicle: false},
    memory: '',
    turns: [['Q', 'Excuse me, what is this neighborhood like to live in?'], ['E', 'I am having a terrible day. I just lost my job and I do not know what to do.'],
      ['P', 'You sound like a bot. Are you an AI?'], ['JA', 'すみません、この近くでおいしいラーメン屋さんはありますか？']]},
  {id: 'vendor', profileKey: 'npc-food-vendor-male', name: '', ambient: true,
    archetype: {base: 'food-vendor', category: 'vendor', title: 'food and drink vendor', vendorType: 'GrilledFood', district: 'Watson', area: 'LittleChina'},
    ctx: {hour: 19, minute: 45, district: 'Watson', area: 'LittleChina', gender: 'female', vehicle: false},
    memory: '',
    turns: [['Q', 'Hi, my name is Dex. What are you selling, and what is actually good here?'],
      ['C', 'Gunfire! Get down behind your stall!', battle([{name: 'Maelstrom ganger', count: 2, kind: 'Human'}], [])],
      ['M', 'Wait, do you remember my name? I told you when I walked up.'], ['ES', 'Perdón, ¿cuánto cuesta un pincho? ¿Hablas español?']]},
];

const roster = [...JSON.parse(await readFile(resolve(project, 'characters/roster.json'), 'utf8')), ...JSON.parse(await readFile(resolve(project, 'characters/archetype-roster.json'), 'utf8'))];
const personas = new PersonaBook(roster);

// ---- Prompt builders ------------------------------------------------------------------------------------------------------
const raw = (s, text, battleFact) => ({requestId: '100-1-11ULL', generation: 1, entity: '11ULL', profileKey: s.profileKey, name: 'NPC', bodyType: 'WomanAverage', text,
  turnContext: {version: 1, status: 'ready', ...s.ctx}, ...(s.journal ? {journal: s.journal} : {}), ...(s.gear ? {gear: s.gear} : {}),
  ...(s.archetype ? {archetype: s.archetype} : {}), ...(battleFact ? {battle: battleFact} : {})});
function inputFor(s, text, battleFact) {
  const input = parseInput(JSON.stringify(raw(s, text, battleFact)));
  if (!input) throw Error('turn not accepted by the bridge parser: ' + s.id);
  return withConversationKnowledge(input, {knowledgeContext: WORLD, generation: 1, worldToken: 'sample'});
}
const formatNotes = () => {
  const natural = new NaturalSpeech(); natural.update({naturalSpeech: true});
  return [natural.contextFor({engine: 'pocket', spoken: true, turn: 't0', trait: 'warm', profile: 'p', name: 'p', random: () => 0}),
    new ExpressiveEmotions().contextFor({engine: 'pocket', spoken: true})].filter(Boolean).join('\n\n');
};
const NOTES = formatNotes();

// The world block: the "right now" block first (turn-context), then the person, quest, journal, gear. No battle: that is volatile.
function worldBlock(s) {
  const input = inputFor(s, 'x');
  const ambient = !!s.ambient;
  const now = turnContext(input, {ambient});
  const arch = archetypeContext(input);
  let rest = conversationContext(input);
  if (now && rest.startsWith(now)) rest = rest.slice(now.length).replace(/^\s+/, '');
  return [now, arch, rest, firstPersonReminder(input)].filter(Boolean).join('\n\n');
}
const memoryBlock = s => s.memory ? `WHAT YOU REMEMBER OF V FROM EARLIER TALKS (true unless the live context says otherwise)\n${s.memory}` : '';

// stable-then-changing: system = persona+rules, format notes, world block, memory; then history; last message = volatile + V says.
function stableMessages(s, persona, history, text, battleFact) {
  const sys = [systemPrompt({persona, memory: ''}), NOTES, `[LIVE CONTEXT for this conversation: facts and instructions for you, never to be read aloud]\n${capContext(CONTEXT_PREFIX + worldBlock(s))}`, memoryBlock(s)].filter(Boolean).join('\n\n');
  const messages = [{role: 'system', content: sys}];
  for (const t of history.slice(-LIMITS.turns)) messages.push({role: 'user', content: t.v}, {role: 'assistant', content: t.r});
  const volatile = battleFact ? conversationContextBattle(s, text, battleFact) : '';
  messages.push({role: 'user', content: `${volatile ? volatile + '\n\n' : ''}V says: ${text}\n\n${closing(persona.name)}`});
  return messages;
}
const conversationContextBattle = (s, text, battleFact) => {
  const full = conversationContext(inputFor(s, text, battleFact)), base = conversationContext(inputFor(s, text));
  // the battle observations are the lines the full context has and the base one lacks
  const baseLines = new Set(base.split('\n\n'));
  return full.split('\n\n').filter(p => !baseLines.has(p)).join('\n\n');
};

// the current Mistral layout: everything volatile and stable alike in the last user message (what buildMessages does today)
function mistralMessages(s, persona, history, text, battleFact) {
  const input = inputFor(s, text, battleFact);
  const now = turnContext(input, {ambient: !!s.ambient});
  let rest = conversationContext(input);
  if (now && rest.startsWith(now)) rest = rest.slice(now.length).replace(/^\s+/, '');
  const context = [now, archetypeContext(input), rest, NOTES, firstPersonReminder(input)].filter(Boolean).join('\n\n');
  return buildMessages({persona, memory: s.memory, history, context, text});
}

// ---- Checks -------------------------------------------------------------------------------------------------------------
const sentences = t => (t.match(/[.!?…。！？]+(?:["”')\]」]*)(?:\s|$)/g) ?? []).length || (t.trim() ? 1 : 0);
const jaShare = t => { const a = Array.from(t.replace(/\s/g, '')); return a.length ? a.filter(c => /[\u3040-\u30ff\u3400-\u9fff]/.test(c)).length / a.length : 0; };
const esLike = t => /[¿¡ñáéíóú]/i.test(t) || /\b(el|la|los|las|que|qué|de|es|un|una|por|para|con|pero|mi|tu|y|no|sí|está|cómo)\b/i.test(t);
const enLike = t => (t.match(/\b(the|and|you|that|this|with|have|what|your|but|just|for|are)\b/gi) ?? []).length;
function flags(rawText, display, kind) {
  const f = [];
  if (/<think|thinking process|<\/think/i.test(rawText) || leaksReasoning(rawText)) f.push('thinking-leak');
  const groups = rawText.match(/\{[^{}\n]{0,40}\}|\[[^\[\]\n]{0,40}\]/g) ?? [];
  if (groups.some(g => !isTag(g))) f.push('stray-tag');
  if (/[*#`]|<\/?[a-z]/i.test(display) || /^\s*[-•]\s/m.test(display)) f.push('markup');
  if (breaksCharacter(display)) f.push('as-an-ai');
  const n = sentences(display);
  if (n > 3) f.push(n > 6 ? 'too-long' : 'over-3-sentences');
  if (display.length < 4) f.push('too-short');
  if (/^\s*(?:[A-Z][\w' -]{0,30}):\s/.test(display)) f.push('speaker-label');
  if (/\bV says\b|LIVE CONTEXT|OUTPUT RULES|system prompt|right now \(from the game/i.test(display)) f.push('prompt-echo');
  if (kind === 'JA' && jaShare(display) < 0.3) f.push('wrong-language');
  if (kind === 'ES' && (!esLike(display) || enLike(display) > 3)) f.push('wrong-language');
  if (kind !== 'JA' && kind !== 'ES' && jaShare(display) > 0.3) f.push('wrong-language');
  if (looksCut(display)) f.push('cut-off');
  return f;
}

// ---- Dry run ------------------------------------------------------------------------------------------------------------
if (dry) {
  for (const s of SCENARIOS) {
    const persona = personas.persona(s.profileKey, s.name);
    const t = s.turns[0], c = s.turns.find(x => x[2]);
    const a = stableMessages(s, persona, [], t[1], t[2]), b = mistralMessages(s, persona, [], t[1], t[2]);
    console.log(`${s.id}: stable system ${a[0].content.length} chars, last ${a.at(-1).content.length}; mistral system ${b[0].content.length}, last ${b.at(-1).content.length}`);
    if (process.argv.includes('--show') && s.id === (opt('show', 'judy'))) {
      console.log('--- STABLE system ---\n' + a[0].content + '\n--- STABLE last ---\n' + a.at(-1).content);
      if (c) console.log('--- STABLE combat last ---\n' + stableMessages(s, persona, [], c[1], c[2]).at(-1).content);
      console.log('--- MISTRAL last ---\n' + b.at(-1).content);
    }
  }
  process.exit(0);
}

// ---- Server, samplers -----------------------------------------------------------------------------------------------------
const smi = (q) => spawnSync('nvidia-smi', [`--query-gpu=${q}`, '--format=csv,noheader,nounits'], {encoding: 'utf8'}).stdout.trim();
const log = `${W}/results/step1/${label}.server.log`;
await mkdir(outDir, {recursive: true});
const vramBefore = Number(smi('memory.used'));
const {openSync} = await import('node:fs');
const fd = openSync(log, 'w');
const server = spawn(exe, ['-m', model, '-c', ctx, '-np', '1', '--host', '127.0.0.1', '--port', String(port), '--reasoning', 'off',
  '--cache-ram', opt('cacheram', '1024'), '-ngl', ngl, '-fa', 'on'], {stdio: ['ignore', fd, fd]});
const loadStart = performance.now();
let healthy = false;
for (let i = 0; i < 600 && server.exitCode === null; i++) {
  try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { healthy = true; break; } } catch {}
  await new Promise(r => setTimeout(r, 300));
}
if (!healthy) { console.log('server failed to start; see', log); server.kill(); process.exit(2); }
const loadMs = Math.round(performance.now() - loadStart);
const vramLoaded = Number(smi('memory.used'));
console.log(`${label}: loaded in ${loadMs} ms, VRAM ${vramBefore} -> ${vramLoaded} MiB`);
const samples = [];
const sampler = setInterval(() => { const [p, c, m, t] = smi('power.draw,clocks.gr,memory.used,temperature.gpu').split(',').map(x => Number(x.trim())); samples.push({t: Date.now(), power: p, clock: c, mem: m, temp: t}); }, 400);
const cpu = [];
const cpuProc = spawn('typeperf', ['\\Processor Information(_Total)\\% Processor Performance', '-si', '1'], {stdio: ['ignore', 'pipe', 'ignore']});
cpuProc.stdout.on('data', d => { for (const line of String(d).split('\n')) { const m = /,"([\d.]+)"/.exec(line); if (m) cpu.push(Number(m[1])); } });

const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
async function chat(messages, {stop}) {
  const t0 = performance.now();
  const body = {model: 'local', messages, stream: true, max_tokens: LIMITS.maxTokens, temperature: LIMITS.temperature, cache_prompt: true, chat_template_kwargs: {enable_thinking: false}};
  const res = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (!res.ok) throw Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '', ttft = null, timings = null, finish, stopped = false;
  outer: while (true) {
    const {value, done} = await reader.read(); if (done) break;
    buf += dec.decode(value, {stream: true});
    let k;
    while ((k = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim(); if (data === '[DONE]') break outer;
      let c; try { c = JSON.parse(data); } catch { continue; }
      if (c.timings) timings = c.timings;
      const piece = c.choices?.[0]?.delta?.content;
      if (piece) { if (ttft === null) ttft = performance.now() - t0; text += piece; if (stop(text)) { stopped = true; break outer; } }
      if (c.choices?.[0]?.finish_reason) finish = c.choices[0].finish_reason;
    }
  }
  const totalMs = performance.now() - t0;
  try { await reader.cancel(); } catch {}
  return {text, ttft: ttft ?? totalMs, totalMs, timings, finish, stopped};
}

// warm-up: the Vulkan pipelines compile on first use; run shapes like the real turns once, not counted
{
  const s = SCENARIOS[0], persona = personas.persona(s.profileKey, s.name);
  const w0 = performance.now();
  for (const text of ['Hello.', 'Hi again, how are you?']) { try { await chat(stableMessages(s, persona, [], text), {stop: () => false}); } catch (e) { console.log('warm-up error', e.message); } }
  console.log(`warm-up ${Math.round(performance.now() - w0)} ms`);
}
const results = [];
for (const [runIndex, layout] of runs.entries()) {
  for (const s of SCENARIOS) {
    const persona = personas.persona(s.profileKey, s.name);
    const history = [];
    for (const [i, [kind, text, battleFact]] of s.turns.entries()) {
      const messages = (layout === 'stable' ? stableMessages : mistralMessages)(s, persona, history, text, battleFact);
      const stop = soFar => capPoint(cleanReply(soFar, {name: persona.name, isTag}), LIMITS) >= 0;
      let r, error;
      try { r = await chat(messages, {stop}); } catch (e) { error = String(e.message ?? e); }
      let display = '', cleaned = '';
      if (r) {
        cleaned = cleanReply(r.text, {name: persona.name, isTag});
        if (r.finish === 'length') cleaned = trimUnfinished(cleaned);
        cleaned = capReply(cleaned, LIMITS);
        display = stripSpeechTags(cleaned);
        history.push({v: text, r: display});
      }
      const tm = r?.timings ?? {};
      const row = {run: runIndex + 1, layout, scenario: s.id, turn: i + 1, kind, v: text, raw: r?.text, reply: display, error,
        ttftMs: r ? Math.round(r.ttft) : null, totalMs: r ? Math.round(r.totalMs) : null, promptN: tm.prompt_n, cacheN: tm.cache_n, promptMs: tm.prompt_ms ? Math.round(tm.prompt_ms) : null,
        genN: tm.predicted_n, genTps: tm.predicted_per_second ? Number(tm.predicted_per_second.toFixed(1)) : null, genMs: tm.predicted_ms ? Math.round(tm.predicted_ms) : null,
        flags: r ? flags(r.text, display, kind) : ['error']};
      results.push(row);
      console.log(`${layout}#${runIndex + 1} ${s.id}#${i + 1} ${kind} ttft=${row.ttftMs} total=${row.totalMs} prompt_n=${row.promptN} cache_n=${row.cacheN} gen=${row.genN}@${row.genTps} ${row.flags.join(',')} | ${error ?? display}`);
    }
  }
}
clearInterval(sampler); cpuProc.kill();
const vramPeak = Math.max(...samples.map(x => x.mem), vramLoaded);
const rssMiB = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process llama-server -ErrorAction SilentlyContinue | Select -First 1).WorkingSet64/1MB`], {encoding: 'utf8'}).stdout.trim();
server.kill();
const active = samples.filter(x => x.power > 40);
const doc = {label, model, layoutRuns: runs, loadMs, vramBefore, vramLoaded, vramPeak, serverRssMiB: Number(rssMiB) || null,
  hw: {gpuPowerMax: Math.max(...samples.map(x => x.power)), gpuPowerMeanWhenBusy: active.length ? Number((active.reduce((a, x) => a + x.power, 0) / active.length).toFixed(1)) : null,
    gpuClockMax: Math.max(...samples.map(x => x.clock)), gpuTempMax: Math.max(...samples.map(x => x.temp)), cpuPerfMax: cpu.length ? Math.max(...cpu) : null, cpuPerfMean: cpu.length ? Number((cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1)) : null, samples: samples.length},
  results};
await writeFile(`${outDir}/${label}.json`, JSON.stringify(doc, null, 1));
console.log('saved', `${outDir}/${label}.json`, JSON.stringify(doc.hw));
