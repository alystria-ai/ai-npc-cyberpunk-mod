// The compact character text of a slow machine (bridge/compact-persona.mjs, docs/LOCAL_AI.md "Compact character text on slow machines"): a fast machine's prompt is
// untouched, a slow one's head is within the budget with every required part present, the switch has a hysteresis, and the choice is stable from turn to turn.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PersonaBook, buildMessages, systemHead} from './mistral-prompt.mjs';
import {PREFILL, PrefillMeter} from './prompt-budget.mjs';
import {COMPACT, CompactChoice, compactPersonaFor} from './compact-persona.mjs';
import {localRoute} from './text-provider-host.mjs';
import {matureLayer} from './mature-content.mjs';
import {WORLD_RULES_HEADING, worldRulesBlock} from './world-rules.mjs';

const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
const judy = book.persona('judy-alvarez'), jackie = book.persona('jackie-welles');
const WORLD_RULES = 'Nobody in Night City knows V by name unless V says it. Everyone speaks casually, with plenty of slang.';
const RULE_STARTS = ['OUTPUT RULES', '1. You speak out loud', '2. Say only the words', '3. Be brief', '4. Start with the answer', '5. Sound like this one person', '6. Use only facts', '7. The "Right now"', '8. You are a real person', '9. Answer in the language'];

// ---- the cut ----------------------------------------------------------------------------------------------------------------------

test('the compact persona keeps who the character is, how it talks, its relationships and every rule, and leaves the lore, the looks and the extra examples out', () => {
  const plain = compactPersonaFor(judy, {});
  assert.notEqual(plain, judy);
  const head = systemHead({persona: plain});
  const full = systemHead({persona: judy});
  assert(head.length < full.length * 0.6, `${head.length} of ${full.length} characters`);
  assert(head.length <= COMPACT.targetChars + 120, `the head aims at ${COMPACT.targetChars}, is ${head.length}`);
  assert(head.startsWith(full.split('\n')[0]), 'the same opening sentence');
  for (const kept of ["I'm Judy Alvarez", 'HOW YOU TALK', 'Editorial delivery: direct, quick', 'ESTABLISHED RELATIONSHIPS', 'V: A possible client, ally, friend or lover', 'KNOWLEDGE AND CURRENT SAVE', ...RULE_STARTS]) {
    assert(head.includes(kept), `kept: ${kept}`);
  }
  for (const gone of ['PUBLIC INTRINSIC TOPIC MATERIAL', 'Scope:', 'Your appearance', 'cyberport behind your ear', 'Laguna Bend and residents gathering']) assert(!head.includes(gone), `cut: ${gone}`);
  // The output rules are word for word the ones of the whole text.
  const rules = text => text.slice(text.indexOf('OUTPUT RULES'));
  assert.equal(rules(head), rules(full));
  // Nothing is made up: every kept line is a line (or a leading part of one) of the whole text.
  for (const line of plain.backstory.split('\n').filter(Boolean)) assert(judy.backstory.includes(line.slice(0, 60)), `from the original: ${line.slice(0, 60)}`);
  // Pure: the same text every time, and the persona given is not changed.
  assert.deepEqual(compactPersonaFor(judy, {}), plain);
  assert.equal(judy.backstory.includes('PUBLIC INTRINSIC TOPIC MATERIAL'), true);
});

test('the Mature layer, the guard layer, the world rules, a character\'s own rules and remembered facts are never cut: they leave less room for the persona, with a floor', () => {
  const own = {...judy, worldRules: WORLD_RULES, rules: ['Always say choom, never chummer.'], memories: ['V saved my life at the Clouds.']};
  for (const options of [{mature: 'full'}, {mature: 'suggestive'}, {guard: true}, {}]) {
    const compact = compactPersonaFor(own, options);
    const head = systemHead({persona: compact, ...options});
    assert(head.includes('Always say choom, never chummer.') && head.includes('V saved my life at the Clouds.'), JSON.stringify(options));
    for (const start of RULE_STARTS) assert(head.includes(start));
    if (options.mature) assert(head.endsWith(matureLayer(options.mature)), 'the layer is whole and last');
    const bare = systemHead({persona: {...own, backstory: '', style: '', samples: []}, ...options}).length + worldRulesBlock(WORLD_RULES).length + 2;
    const own_ = compact.backstory.length + compact.style.length + compact.samples.join('').length;
    assert(own_ <= Math.max(COMPACT.floorChars, COMPACT.targetChars - bare) + 120, `${JSON.stringify(options)}: persona text ${own_}`);
    assert(compact.backstory.startsWith("I'm Judy Alvarez"), 'the character is always there');
    assert(compact.style.length > 300, 'and so is the voice');
  }
  // The Mature layer takes room from the persona; with it on the persona text is smaller than with it off.
  const text = options => { const c = compactPersonaFor(own, options); return c.backstory.length + c.style.length; };
  assert(text({mature: 'full'}) < text({}));
  // The whole prompt with world rules: the rules are in the system message after the head, whole.
  const messages = buildMessages({persona: {...compactPersonaFor(own, {}), worldRules: WORLD_RULES}, history: [], contextParts: {now: 'You are with V in person.', notes: '', world: 'WORLD', volatile: ''}, text: 'hi'});
  assert(messages[0].content.includes(`${WORLD_RULES_HEADING}\n${WORLD_RULES}`));
});

test('across the roster: every named character\'s head comes to about 1,500 to 2,100 tokens, and a short persona is left as it is', () => {
  let changed = 0;
  for (const row of roster) {
    const persona = book.persona(row.key);
    for (const options of [{}, {mature: 'full'}]) {
      const compact = compactPersonaFor(persona, options);
      const head = systemHead({persona: compact, ...options}), tokens = head.length / 4.2;
      if (compact !== persona) { changed++; assert(tokens >= 1300 && tokens <= 2200, `${row.key} ${JSON.stringify(options)}: ${Math.round(tokens)} tokens`); assert(compact.backstory.length > 400 && compact.style.length > 200, row.key); }
      else assert(systemHead({persona, ...options}).length / 4.2 < 2300, `${row.key} unchanged but ${Math.round(systemHead({persona, ...options}).length / 4.2)} tokens`);
    }
  }
  assert(changed > 200, `${changed} personas changed`);
  const short = {name: 'Ana', ambient: false, backstory: 'I run a noodle stall in Kabuki. I know everyone on the street.', style: 'Friendly and quick.', samples: ['Hey, choom.']};
  assert.equal(compactPersonaFor(short, {}), short);
});

// ---- the hysteresis ---------------------------------------------------------------------------------------------------------------

const reading = (meter, rate, fresh = 3000) => meter.observe({timings: {promptTokens: fresh, cachedTokens: 100, promptMs: fresh / rate * 1000}});

test('PrefillMeter.compact: two readings in a row under 600 switch it on, two in a row at 1,000 or more switch it off, and nothing in between flips it', () => {
  assert.equal(PREFILL.compactBelow, 600); assert.equal(PREFILL.compactAbove, 1000);
  const meter = new PrefillMeter();
  assert.equal(meter.compact, false, 'nothing measured: whole text');
  reading(meter, 80); assert.equal(meter.compact, false, 'one slow reading is not enough');
  reading(meter, 900); reading(meter, 80); assert.equal(meter.compact, false, 'not two in a row');
  reading(meter, 300); assert.equal(meter.compact, true);
  for (const rate of [650, 800, 990, 200, 700, 5000, 400]) { reading(meter, rate); assert.equal(meter.compact, true, `${rate}: no flip`); }
  reading(meter, 2000); assert.equal(meter.compact, true, 'one fast reading is not enough');
  reading(meter, 1500); assert.equal(meter.compact, false);
  reading(meter, 550); assert.equal(meter.compact, false); reading(meter, 700); reading(meter, 590); assert.equal(meter.compact, false, 'a reading at or above 600 starts the count again');
  reading(meter, 100, 100); assert.equal(meter.compact, false, 'a small prompt says nothing about the speed');
  // A stuck request is the strongest evidence: one is enough.
  const stuck = new PrefillMeter();
  stuck.observeFailure({headersMs: 1000, elapsedMs: 61000, progress: {processed: 2802, total: 7592, cache: 2802}});
  assert.equal(stuck.compact, true);
  // The prior of a model with layers on the CPU is not a measurement.
  const cpu = new PrefillMeter({offload: true});
  assert.equal(cpu.slow, true); assert.equal(cpu.compact, false);
  // A model loaded again starts from what was learned.
  assert.equal(new PrefillMeter({compact: true}).compact, true);
  // A fast machine never gets there, however its readings wobble above the line.
  const fast = new PrefillMeter();
  for (const rate of [5200, 4800, 650, 5100, 700, 4900, 4000, 900]) reading(fast, rate);
  assert.equal(fast.compact, false);
});

test('CompactChoice: chosen when a character\'s first turn comes and kept while the server holds that character; one line when it starts', () => {
  const lines = [];
  const choice = new CompactChoice({log: line => lines.push(line)});
  const speed = new PrefillMeter();
  const ask = (persona, meter = speed, extra = {}) => choice.personaFor(persona, {speed: meter, ...extra});
  assert.equal(ask(judy), judy, 'a fast machine: the very same object');
  assert.equal(ask(judy), judy); assert.equal(lines.length, 0);
  reading(speed, 150); reading(speed, 150);                    // the machine turns slow in the middle of a talk
  assert.equal(speed.compact, true);
  assert.equal(ask(judy), judy, 'Judy\'s cached prompt is kept: the talk goes on as it was');
  const jack = ask(jackie);
  assert.notEqual(jack, jackie, 'the next character starts compact');
  assert.equal(ask(jackie), jack, 'the very same persona turn after turn');
  assert.equal(ask({...jackie}), jack, 'a persona rebuilt with the same text gives the same choice');
  const startLines = lines.filter(line => /compact character text \(this computer reads about \d+ tokens a second\)/.test(line));
  assert.equal(startLines.length, 1, lines.join('\n'));
  const again = ask(judy);
  assert.notEqual(again, judy, 'the slot held Jackie: Judy\'s first turn again is a new start, compact');
  // A group talk that goes back and forth between two characters names each cut once, not at every change of speaker.
  for (let at = 0; at < 3; at++) { ask(jackie); ask(judy); }
  assert.equal(lines.filter(line => /compact character text for Judy Alvarez/.test(line)).length, 1, lines.join('\n'));
  assert.equal(lines.filter(line => /compact character text for Jackie Welles/.test(line)).length, 1, lines.join('\n'));
  // Another Mature level or new world rules cut it again (the head around it changed anyway).
  const withMature = ask(judy, speed, {mature: 'full'});
  assert(systemHead({persona: withMature, mature: 'full'}).length < systemHead({persona: again, mature: 'full'}).length + 1);
  assert.equal(ask(judy, speed, {mature: 'full'}), withMature);
  // A model loaded again (a new meter, carrying the state) is a new start.
  const reload = new PrefillMeter({compact: true});
  assert.notEqual(ask(judy, reload), judy);
  // Back to fast: after two fast readings the next character gets the whole text, and one line says so.
  reading(reload, 3000); reading(reload, 3000);
  assert.equal(ask(jackie, reload), jackie);
  assert(lines.some(line => /whole character text again/.test(line)));
  assert.equal(lines.filter(line => /compact character text \(/.test(line)).length, 1, 'one start line for the whole stretch');
});

// ---- through the route ------------------------------------------------------------------------------------------------------------

const history = count => Array.from({length: count}, (_, index) => ({v: `Tell me about the job number ${index}.`, r: 'It was a long night, V. Mostly waiting, then everything at once.'}));
const turnArgs = (persona, extra = {}) => ({persona, memory: '', history: history(4), text: 'What are you up to right now?', reaction: false, remembered: [],
  contextParts: {now: 'You are with V in person. It is night, about 11 PM, in Kabuki.', notes: 'FORMAT: use {joy} tags for feelings.', world: 'WORLD FACTS\n- Judy lives in Kabuki.', worldBlocks: [{key: 'knowledge', text: 'WORLD FACTS\n- Judy lives in Kabuki.'}], volatile: ''}, ...extra});

function rig({rate, contextSize = 16384, handle = {}} = {}) {
  const sent = [], logs = [];
  const server = {ensure: async () => ({apiKey: 'k', endpoint: 'http://127.0.0.1:1/v1', model: 'm', requestModel: 'm', contextSize, loadedAt: 1, offload: false, ...(typeof handle === 'function' ? handle() : handle)}), status: () => ({state: 'ready'}),
    begin: () => () => {}, inflight: 0, noteSlot() {}, preempt: () => false};
  const state = {rate};
  const chat = async options => {
    sent.push(options.messages);
    const fresh = 3000;
    return {text: 'ok', usage: {prompt_tokens: 4000}, trace: {timings: {promptTokens: fresh, cachedTokens: 0, promptMs: fresh / state.rate * 1000}}};
  };
  const route = localRoute({server, chat, log: line => logs.push(line)});
  const turn = async (args) => { const messages = buildMessages(args); await route.chat({messages, provider: 'local'}); return {built: messages, sent: sent.at(-1)}; };
  return {route, turn, sent, logs, state};
}
const system = messages => messages[0].content;
const headOf = (messages, persona, options = {}) => systemHead({persona, ...options});

test('a fast machine: the prompts are byte for byte what buildMessages built, turn after turn', async () => {
  const {turn, logs, route} = rig({rate: 5000});
  for (const persona of [judy, jackie, judy, judy, jackie]) {
    const args = turnArgs(persona, {mature: 'full'});
    const {built, sent} = await turn(args);
    assert.deepEqual(sent, built);
    assert(system(sent).includes('PUBLIC INTRINSIC TOPIC MATERIAL'));
  }
  assert.equal(logs.some(line => /compact/.test(line)), false);
  assert.equal(await route.shapePersona(judy, {mature: 'full'}), judy, 'and so is the warm-up');
});

test('a model with so few layers on the card that the CPU does the work starts with the compact text on its first turn; a partly offloaded one reads the whole text until it is measured slow', async () => {
  const cpu = rig({rate: 120, handle: {offload: true, cpuBound: true}});
  const {built, sent} = await cpu.turn(turnArgs(jackie, {mature: 'full'}));
  assert(system(sent).length < system(built).length - 3000, `${system(sent).length} of ${system(built).length}`);
  assert(cpu.logs.some(line => /compact character text/.test(line)), cpu.logs.join('\n'));
  // Partly on the CPU (a larger share on the card): not a reason by itself; the first turn is the whole text, as before.
  const part = rig({rate: 120, handle: {offload: true, cpuBound: false}});
  const second = await part.turn(turnArgs(jackie, {mature: 'full'}));
  assert.deepEqual(second.sent, second.built);
  assert.equal(part.logs.some(line => /compact/.test(line)), false);
});

test('a model that replaces a slow one on the same computer starts from what the machine was just seen to do: the compact text and a smaller prompt, not the whole prompt of an unmeasured model', async () => {
  // 2026-10-22 report: Qwen 3.5 mostly on the CPU (the card too small beside the game), then stepped down to Bonsai that fits on the card: no reading, a whole 8,821-token prompt, 75 s.
  let load = {model: 'qwen', loadedAt: 1, offload: true, cpuBound: false};
  const {turn, logs, state} = rig({rate: 120, handle: () => load});
  const first = await turn(turnArgs(judy, {mature: 'full'}));
  assert.deepEqual(first.sent, first.built, 'a partly offloaded model reads the whole text on its first turn');
  load = {model: 'bonsai', loadedAt: 2, offload: false, cpuBound: false};
  const second = await turn(turnArgs(jackie, {mature: 'full', text: 'second'}));
  assert(system(second.sent).length < system(second.built).length - 3000, `${system(second.sent).length} of ${system(second.built).length}`);
  assert(logs.some(line => /compact character text/.test(line)), logs.join(String.fromCharCode(10)));
  // The same computer reading fast again is measured fast: two readings at 1,000 or more bring the whole text back.
  state.rate = 5000;
  load = {model: 'bonsai', loadedAt: 3, offload: false, cpuBound: false};
  for (let at = 0; at < 3; at++) await turn(turnArgs(jackie, {mature: 'full', text: `fast ${at}`}));
  const back = await turn(turnArgs(judy, {mature: 'full', text: 'back'}));
  assert.deepEqual(back.sent, back.built, 'a machine measured fast is given the whole text again');
  // A machine that was fast has nothing to carry: the model that follows it starts as before.
  const fast = rig({rate: 5000, handle: () => load});
  load = {model: 'a', loadedAt: 1, offload: false, cpuBound: false};
  await fast.turn(turnArgs(judy, {mature: 'full'}));
  load = {model: 'b', loadedAt: 2, offload: false, cpuBound: false};
  const next = await fast.turn(turnArgs(jackie, {mature: 'full'}));
  assert.deepEqual(next.sent, next.built);
});

test('a slow machine: once it is measured slow, the next character starts compact, within the budget, with the required parts, and the same text every turn', async () => {
  const {turn, logs, route, state} = rig({rate: 180});
  // Nothing is known at first: Judy's first turn reads the whole text and measures the speed (180 tokens a second). A second reading makes it slow.
  const first = await turn(turnArgs(judy, {mature: 'full'}));
  assert.deepEqual(first.sent.map(m => m.content).join().includes('PUBLIC INTRINSIC'), true, 'the first turn of a machine nobody has measured is the whole text');
  await turn(turnArgs(judy, {mature: 'full'}));
  assert.equal(logs.some(line => /compact character text/.test(line)), false, 'the talk with Judy goes on with the text it started with');
  // The next character: Jackie.
  const shown = [];
  for (let at = 0; at < 3; at++) {
    const {built, sent} = await turn(turnArgs(jackie, {mature: 'full', history: history(4 + at), text: `line ${at}`}));
    shown.push(sent);
    assert(system(sent).length < system(built).length - 3000, `${system(sent).length} of ${system(built).length}`);
    assert(!system(sent).includes('PUBLIC INTRINSIC TOPIC MATERIAL'));
    for (const start of [...RULE_STARTS, 'MATURE CONTENT IS ON', 'HOW YOU TALK', 'ESTABLISHED RELATIONSHIPS']) assert(system(sent).includes(start), start);
    // The right-now block, the format notes and V's words are the whole ones.
    assert(system(sent).includes('FORMAT NOTES FOR EVERY REPLY') && system(sent).includes('You are with V in person.'));
    assert(sent.at(-1).content.includes(`V says: line ${at}`));
  }
  // The head is the very same text in the three turns, so the server's prefix cache holds it.
  const head = headOf(shown[0], book.persona('jackie-welles'));
  const common = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
  const headLength = system(shown[0]).indexOf('FORMAT NOTES FOR EVERY REPLY');
  assert(common(system(shown[0]), system(shown[1])) >= headLength && common(system(shown[0]), system(shown[2])) >= headLength, 'a stable head');
  assert(headLength / 4.2 < 2200, `${Math.round(headLength / 4.2)} tokens of head`);
  assert(headLength < head.length, 'shorter than the whole head');
  // One line when it started.
  assert.equal(logs.filter(line => /compact character text \(this computer reads about \d+ tokens a second\)/.test(line)).length, 1, logs.join('\n'));
  // The warm-up of a character reads the very head the first turn will: the same persona, the same text.
  const warm = await route.shapePersona(book.persona('jackie-welles'), {mature: 'full'});
  assert.equal(system(shown[0]).startsWith(systemHead({persona: warm, mature: 'full'})), true);
  // The machine gets fast again: after two fast readings the next character is whole.
  state.rate = 4000;
  await turn(turnArgs(jackie, {mature: 'full'})); await turn(turnArgs(jackie, {mature: 'full'}));
  const back = await turn(turnArgs(judy, {mature: 'full'}));
  assert.deepEqual(back.sent, back.built);
});
