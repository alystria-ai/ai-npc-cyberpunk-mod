// The Local AI prompt-size estimate against the real token counts of the shipped models (docs/LOCAL_AI.md, "Token estimate and calibration (2026-10-20)").
// bridge/fixtures/token-counts.json holds counts recorded from the bundled llama-server (Gemma 4 and Qwen3.5 tokenizers, the four shipped models): this test needs no server.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PersonaBook, buildMessages, joinBlocks, systemHead, LIMITS} from './mistral-prompt.mjs';
import {BUDGET, PREFILL, PrefillMeter, TokenMeter, budgetedChat, describeFit, estimateTokens, fitMessages, seedRatio, templateTokens, textTokens} from './prompt-budget.mjs';
import {COMPACT, CompactChoice, compactPersonaFor} from './compact-persona.mjs';
import {matureLayer} from './mature-content.mjs';
import {WORLD_RULES_HEADING} from './world-rules.mjs';
import {buildPrompt, HISTORY, MEMORY, REMEMBERED, USER_LINES} from '../scripts/judy-prompt-fixture.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/token-counts.json', import.meta.url), 'utf8'));
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
const judy = book.persona('judy-alvarez');
const base = buildPrompt();

const ACTION = 'ACTION NOTE: V may be asking you to come along. If you agree, begin your reply with the code [FOLLOW]; if you refuse, no code. Never write the code in any other place.';
const RULES = 'Nobody in Night City knows V by name unless V says it. Everyone speaks casually, with plenty of slang. Cops are corrupt and slow. Prices are in eddies. Do not mention the real world.';
const SPANISH = {text: 'Oye Judy, ¿qué estás haciendo ahora mismo? ¿Todavía trabajando en ese braindance? Me preocupa que no duermas nada.', history: [{v: 'Hola Judy, ¿noche larga?', r: '{warm}Sí, V. De esas en las que el corte no se deja y me quedo mirando una forma de onda una hora entera.'}]};
const RUSSIAN = {text: 'Привет, Джуди, чем ты сейчас занята? Опять монтируешь брейнданс? Я переживаю, что ты совсем не спишь.', history: [{v: 'Привет, Джуди, тяжёлая ночь?', r: '{warm}Да, ви. Из тех, когда монтаж не сходится и я час пялюсь на звуковую дорожку.'}]};
const JAPANESE = {text: 'ジュディ、今何してるの？まだあのブレインダンスを編集してるの？全然寝てないのが心配だよ。', history: [{v: 'やあジュディ、長い夜だった？', r: '{warm}うん、V。カットが言うことを聞かなくて、波形を一時間も見つめてた。'}]};

// The prompts the recorded counts belong to, built with the real builders (the same layout the Local route sends).
function scenario(name) {
  const make = (persona, options = {}) => {
    const parts = {...base.contextParts};
    if (options.action) parts.volatile = joinBlocks([parts.volatile, ACTION]);
    return buildMessages({persona, memory: MEMORY, history: options.noHistory ? [] : (options.history ?? HISTORY), contextParts: parts, remembered: options.noHistory ? [] : REMEMBERED,
      text: options.text ?? USER_LINES.a, limits: LIMITS, ...(options.mature ? {mature: options.mature} : {})});
  };
  const jackie = book.persona('jackie-welles');
  switch (name) {
    case 'judy-full': return make(judy);
    case 'judy-full-rules-action': return make({...judy, worldRules: RULES}, {action: true});
    case 'judy-compact': return make(compactPersonaFor(judy, {}));
    case 'judy-compact-rules-action': return make({...compactPersonaFor({...judy, worldRules: RULES}, {}), worldRules: RULES}, {action: true});
    case 'judy-full-mature': return make(judy, {mature: 'full'});
    case 'judy-full-mature-rules': return make({...judy, worldRules: RULES}, {mature: 'full', action: true});
    case 'jackie-full': return make(jackie);
    case 'archetype-full': return make(book.persona('npc-voodoo-boys-female'));
    case 'archetype2-full': return make(book.persona('npc-maelstrom-male'), {action: true});
    case 'judy-nohistory': return make(judy, {noHistory: true});
    case 'judy-es': return make(judy, SPANISH);
    case 'judy-ru': return make(judy, RUSSIAN);
    case 'judy-ja': return make(judy, JAPANESE);
    default: throw Error(name);
  }
}
const charsOf = messages => messages.reduce((sum, message) => sum + message.content.length, 0);
const FAMILIES = {'gemma-4': 'Gemma 4 E4B', qwen: 'Bonsai 2 4B'};

// What the real count of a rebuilt prompt is: the recorded one, scaled when a character's text was edited since the recording (the ratio holds, the length moves).
function truth(family, name, messages) {
  const row = fixture.families[family].prompts[name];
  return {tokens: row.tokens * charsOf(messages) / row.chars, drift: Math.abs(charsOf(messages) / row.chars - 1)};
}

test('the fixture holds both tokenizers, all four shipped models, and the prompts it was recorded from', () => {
  assert.deepEqual(Object.keys(fixture.families).sort(), ['gemma-4', 'qwen']);
  assert.equal(fixture.families['gemma-4'].models.length + fixture.families.qwen.models.length, 4);
  for (const family of Object.values(fixture.families)) {
    assert(Object.keys(family.prompts).length >= 12 && Object.keys(family.texts).length >= 24);
    for (const row of Object.values(family.prompts)) assert(row.tokens > 4000 && row.chars / row.tokens > 4 && row.chars / row.tokens < 4.7, JSON.stringify(row));
  }
  assert(Object.keys(fixture.texts).every(name => fixture.families.qwen.texts[name] > 0 && fixture.families['gemma-4'].texts[name] > 0));
});

test('the real ratio of the persona prompt is 4.2 to 4.5 characters a token on both tokenizers, and the template costs about six tokens a message', () => {
  for (const [family, rows] of Object.entries(fixture.families)) {
    for (const [name, row] of Object.entries(rows.prompts)) {
      const ratio = row.chars / row.tokens;
      assert(ratio >= 4.2 && ratio <= 4.6, `${family} ${name}: ${ratio.toFixed(2)}`);
      const template = row.tokens - row.contentTokens;
      assert(template <= templateTokens(row.messages) && template >= templateTokens(row.messages) - 20, `${family} ${name}: template ${template} of ${templateTokens(row.messages)}`);
    }
  }
});

test('the estimate of a whole prompt is never low and never more than 15% high, on every recorded prompt of both tokenizers (the seed ratio, before the server has said anything)', () => {
  assert.equal(seedRatio('Bonsai 2 4B'), BUDGET.knownCharsPerToken);
  assert.equal(seedRatio('Gemma 4 E4B · uncensored'), BUDGET.knownCharsPerToken);
  assert.equal(seedRatio('Qwen3.5-4B · uncensored'), BUDGET.knownCharsPerToken);
  assert.equal(seedRatio('some model nobody measured'), BUDGET.charsPerToken);
  let checked = 0;
  for (const family of Object.keys(fixture.families)) {
    for (const name of Object.keys(fixture.families[family].prompts)) {
      const messages = scenario(name);
      const real = truth(family, name, messages);
      if (real.drift > 0.2) continue;   // a character's text was rewritten since the recording: nothing to compare
      const estimate = estimateTokens(messages, seedRatio(FAMILIES[family]));
      assert(estimate >= real.tokens * 0.99 && estimate <= real.tokens * 1.15, `${family} ${name}: estimated ${estimate}, the server counted ${Math.round(real.tokens)}`);
      checked++;
    }
  }
  assert(checked >= 20, `${checked} comparisons`);
});

test('texts of other scripts: counted at least 90% of what the tokenizers count, never wildly more, and the two kinds the ratio cannot know are what the meter learns', () => {
  const prose = ['english', 'spanish', 'french', 'german', 'portuguese', 'italian', 'russian', 'polish', 'japanese', 'chinese', 'korean', 'arabic', 'greek', 'hebrew', 'thai', 'hindi', 'czech', 'turkish'];
  for (const [family, rows] of Object.entries(fixture.families)) {
    const seed = seedRatio(FAMILIES[family]);
    for (const name of prose) {
      const estimate = textTokens(fixture.texts[name], seed), real = rows.texts[name];
      assert(estimate >= real * 0.9, `${family} ${name}: estimated ${estimate.toFixed(0)}, counted ${real}`);
      assert(estimate <= real * 2.1, `${family} ${name}: estimated ${estimate.toFixed(0)}, counted ${real}`);
    }
    // Rare-language words (Haitian Creole, Hungarian), telemetry (ids, JSON) and tag strings tokenize at 2.6 to 3.5 characters a token: the estimate runs 10 to 40% low on them.
    // That is what the meter's learned ratio and bias are for; here it is only pinned that the gap is the size the docs say.
    for (const name of ['creole', 'hungarian', 'ids', 'tags']) {
      const gap = rows.texts[name] / textTokens(fixture.texts[name], seed);
      assert(gap > 1.05 && gap < 1.7, `${family} ${name}: the server counts ${gap.toFixed(2)} times the estimate`);
    }
  }
  // The old counts for CJK (a token a character) and Cyrillic-like scripts (half a token) were 1.5 and 1.7 times the measured ones: the trimming that followed was early for those players.
  assert(textTokens(fixture.texts.japanese, 4) < fixture.families.qwen.texts.japanese * 1.4);
  assert(textTokens(fixture.texts.russian, 4) < fixture.families.qwen.texts.russian * 1.8);
});

test('TokenMeter: the ratio learned from one real prompt (Judy, Spanish line) makes the estimate of the others within 8% above and 4% below, on both tokenizers', () => {
  for (const family of Object.keys(fixture.families)) {
    const meter = new TokenMeter({charsPerToken: seedRatio(FAMILIES[family])});
    const first = scenario('judy-full');
    meter.observe(first, truth(family, 'judy-full', first).tokens);   // scaled like the others: the Natural speech block in the fixture prompt may have been reworded since the recording
    assert(meter.samples === 1);
    for (const name of ['jackie-full', 'archetype-full', 'archetype2-full', 'judy-compact', 'judy-es', 'judy-ru', 'judy-ja', 'judy-full-mature-rules', 'judy-nohistory']) {
      const messages = scenario(name), real = truth(family, name, messages);
      if (real.drift > 0.2) continue;
      const estimate = estimateTokens(messages, meter.charsPerToken);
      assert(estimate >= real.tokens * 0.96 && estimate <= real.tokens * 1.08, `${family} ${name}: estimated ${estimate}, counted ${Math.round(real.tokens)}`);
    }
  }
});

test('TokenMeter: prompts with some text of other scripts teach the ratio too, with the other text taken off at what it is counted at', () => {
  const meter = new TokenMeter({charsPerToken: 4});
  const messages = scenario('judy-ru');
  const real = fixture.families.qwen.prompts['judy-ru'];
  assert.equal(meter.observe(messages, real.tokens), true);
  assert(Math.abs(meter.charsPerToken - 4.3) < 0.25, `${meter.charsPerToken}`);
  // A prompt that is mostly another script teaches nothing about plain text.
  const japanese = new TokenMeter({charsPerToken: 4});
  assert.equal(japanese.observe([{role: 'user', content: fixture.texts.japanese.repeat(20)}], 3000), false);
});

test('TokenMeter bias: what the server counts over the budget (the 2026-10-20 report: counted 3,270, the server 5,262) is learned, applied to the next fit, followed for two turns, then let go', () => {
  const messages = scenario('judy-compact');
  const meter = new TokenMeter({charsPerToken: 4.2});
  assert.equal(meter.bias, 1);
  meter.observe(messages, 5262, {raw: 3270, exact: true});
  assert(Math.abs(meter.lastGap - 5262 / 3270) < 1e-9);
  assert(Math.abs(meter.bias - 1.609) < 0.01, `${meter.bias}`);
  // One turn that matches the budget: the bigger of the last two still holds. A second: it is let go.
  meter.observe(messages, 3270, {raw: 3270, exact: true}); assert(meter.bias > 1.6);
  meter.observe(messages, 3280, {raw: 3270, exact: true}); assert.equal(meter.bias, 1);
  // The template and rounding (a few tokens) are no gap; a server that counts a little less is none either.
  meter.observe(messages, 3270 + 40, {raw: 3270, exact: true}); meter.observe(messages, 2800, {raw: 3270, exact: true});
  assert.equal(meter.bias, 1);
  // A gap that cannot be real is bounded.
  meter.observe(messages, 99999, {raw: 3270, exact: true});
  assert.equal(meter.bias, BUDGET.maxBias);
  meter.reset(); assert.equal(meter.bias, 1);
  // Without the budget's own count the estimate under the ratio learned meanwhile is what the server's count is held against: a ratio that was wrong is not counted twice.
  const wrong = new TokenMeter({charsPerToken: 6});
  wrong.observe(messages, fixture.families.qwen.prompts['judy-compact'].tokens);
  assert.equal(wrong.bias, 1);
});

test('fitMessages: the bias moves the cut with it, the tokenizer\'s count and the estimate alike, and the fit reports the count before it', async () => {
  const sources = scenario('judy-full'), args = sources[Symbol.for('cyberpunk-convai.prompt-source')];
  const count = async messages => estimateTokens(messages, 4.4);
  const limit = 8400;
  const plain = await fitMessages({args, budget: {contextTokens: limit + 320 + 130, reserveTokens: 320, meter: new TokenMeter({charsPerToken: 4.4}), count}});
  const meter = new TokenMeter({charsPerToken: 4.4});
  meter.observe(scenario('judy-compact'), 5262, {raw: 3270, exact: true});
  const biased = await fitMessages({args, budget: {contextTokens: limit + 320 + 130, reserveTokens: 320, meter, count}});
  assert(biased.trimmed.length > plain.trimmed.length, `${biased.trimmed.length} cuts against ${plain.trimmed.length}`);
  assert(biased.bias > 1.6 && plain.bias === 1);
  assert(Math.abs(biased.raw * biased.bias - biased.tokens) <= biased.bias + 1, `raw ${biased.raw}, bias ${biased.bias}, tokens ${biased.tokens}`);
  assert(biased.tokens <= biased.limit && plain.tokens <= plain.limit);
});

test('budgetedChat: a server count far over the budget is written to the log once, learned, and the next prompt is cut for it', async () => {
  const args = scenario('judy-full')[Symbol.for('cyberpunk-convai.prompt-source')];
  const meter = new TokenMeter({charsPerToken: 4.4});
  const seen = [], sizes = [];
  // The tokenizer the budget asked (count) and a server that then read 1.25 times as much (the 2026-10-20 report was 1.6 times, which no cut of this prompt would fit in this context).
  const chat = budgetedChat(async options => {
    const mine = estimateTokens(options.messages, 4.4);
    sizes.push(mine);
    return {text: 'ok', usage: {prompt_tokens: Math.round(mine * 1.25)}};
  }, {budget: async () => ({contextTokens: 7600, meter, count: async messages => estimateTokens(messages, 4.4)}), onMismatch: info => seen.push(info)});
  await chat({messages: buildMessages(args), provider: 'local'});
  assert.equal(seen.length, 1);
  assert(seen[0].gap > 1.15 && seen[0].real > seen[0].raw && seen[0].exact === true);
  assert(meter.bias > 1.05, `${meter.bias}`);
  await chat({messages: buildMessages(args), provider: 'local'});
  assert(sizes[1] < sizes[0], `the second prompt is smaller: ${sizes[0]} then ${sizes[1]}`);
  // A server that agrees with the budget: no log, no bias.
  const calm = new TokenMeter({charsPerToken: 4.4}), quiet = [];
  await budgetedChat(async options => ({text: 'ok', usage: {prompt_tokens: estimateTokens(options.messages, 4.4)}}), {budget: async () => ({contextTokens: 7600, meter: calm, count: async messages => estimateTokens(messages, 4.4)}), onMismatch: info => quiet.push(info)})({messages: buildMessages(args), provider: 'local'});
  assert.equal(quiet.length, 0); assert.equal(calm.bias, 1);
});

test('everything the server is sent is in the count: the messages counted are the messages sent, with the world rules, the Mature layer and the action note in them', async () => {
  const persona = {...judy, worldRules: RULES};
  const parts = {...base.contextParts, volatile: joinBlocks([base.contextParts.volatile, ACTION])};
  const built = buildMessages({persona, memory: MEMORY, history: HISTORY, contextParts: parts, remembered: REMEMBERED, text: USER_LINES.b, limits: LIMITS, mature: 'full'});
  const counted = [], sent = [];
  const chat = budgetedChat(async options => { sent.push(options.messages); return {text: 'ok', usage: {prompt_tokens: 5000}}; },
    {budget: async () => ({contextTokens: 7700, meter: new TokenMeter({charsPerToken: 4.4}), count: async messages => { counted.push(messages); return estimateTokens(messages, 4.4); }}), onFit: () => {}});
  await chat({messages: built, provider: 'local'});
  assert(counted.length >= 1);
  assert.deepEqual(sent[0], counted.at(-1), 'the last list the tokenizer counted is the list that was sent');
  const text = sent[0].map(message => message.content).join('\n');
  assert(text.includes(WORLD_RULES_HEADING) && text.includes(RULES), 'world rules');
  assert(text.includes(matureLayer('full')), 'the Mature layer');
  assert(text.includes('ACTION NOTE: V may be asking you to come along'), 'the action note');
  assert(text.includes(USER_LINES.b), "V's words");
  // The request wrapper adds nothing of its own to the messages (no image, tool or format text): the body's messages are the fitted ones.
  assert.equal(sent[0].length, counted.at(-1).length);
});

test('the soft target is raised to the next step instead of letting the whole prompt through when it misses by a few tokens (the 2026-10-20 cliff), and a step beyond the largest is none', () => {
  const slow = new PrefillMeter();
  slow.observe({timings: {promptTokens: 3000, cachedTokens: 1469, promptMs: 15000}});   // 200 tokens a second: wants 1,600 tokens, the step is 1,300
  const first = slow.soft(1506);
  assert.equal(first.reserveTokens, 0);
  const total = limit => limit.contextTokens - Math.max(BUDGET.minMargin, limit.contextTokens * BUDGET.marginRatio) | 0;
  assert(Math.abs(total(first) - (1506 + 1300)) <= 2, `${total(first)}`);
  const raised = slow.soft(1506, 2830);
  assert(Math.abs(total(raised) - (1506 + 1800)) <= 2, `the next step holds 2,830: ${total(raised)}`);
  assert(Math.abs(total(slow.soft(1506, 4100)) - (1506 + 2500)) <= 2 || total(slow.soft(1506, 4100)) >= 4100 - 2);
  assert.equal(slow.soft(1506, 1506 + PREFILL.steps.at(-1) + 50), null, 'nothing beyond the largest step');
  assert.equal(new PrefillMeter().soft(1506, 3000), null, 'a machine nobody has measured has no target to raise');
});

test('the compact character text aims at the same tokens the soft target counts: its target in characters follows the model\'s ratio, and one choice keeps its text while a character is held', () => {
  const full = systemHead({persona: judy});
  const heads = {};
  for (const ratio of [3.8, 4.0, 4.4, 4.6]) {
    const compact = compactPersonaFor(judy, {charsPerToken: ratio});
    assert.notEqual(compact, judy);
    const head = systemHead({persona: compact});
    heads[ratio] = head.length;
    const tokens = textTokens(head, ratio);
    assert(tokens >= COMPACT.targetTokens * 0.9 && tokens <= COMPACT.targetTokens * 1.1, `ratio ${ratio}: ${Math.round(tokens)} tokens of ${COMPACT.targetTokens}`);
    assert(head.length < full.length * 0.6);
  }
  assert(heads[4.6] > heads[3.8] + 800, 'a model that packs more characters into a token gets more characters');
  assert.equal(systemHead({persona: compactPersonaFor(judy, {})}).length > 7000, true, 'without a ratio: the old target of 8,000 characters');
  // Through the choice: the meter's ratio is quantised and taken once, so a ratio that drifts does not change the text of a held character.
  const speed = new PrefillMeter(); speed.observe({timings: {promptTokens: 3000, cachedTokens: 0, promptMs: 30000}}); speed.observe({timings: {promptTokens: 3000, cachedTokens: 0, promptMs: 30000}});
  assert.equal(speed.compact, true);
  const choice = new CompactChoice();
  const meter = new TokenMeter({charsPerToken: 4.0});
  const jackie = book.persona('jackie-welles');
  const one = choice.personaFor(jackie, {speed, meter});
  meter.observe(scenario('judy-full'), fixture.families.qwen.prompts['judy-full'].tokens);
  assert.equal(choice.personaFor(jackie, {speed, meter}), one, 'the very same text while the server holds this character');
  assert.equal(choice.personaFor(jackie, {speed, meter: new TokenMeter({charsPerToken: 4.4})}), one, 'and a different meter does not change a held character');
  const lines = [];
  const logged = new CompactChoice({log: line => lines.push(line)});
  logged.personaFor(book.persona('judy-alvarez'), {speed, meter: new TokenMeter({charsPerToken: 4.4})});
  const line = lines.find(item => /compact character text for Judy Alvarez: the head goes from about (\d+) to (\d+) tokens/.test(item));
  assert(line, lines.join('\n'));
  const [, whole, small] = /about (\d+) to (\d+) tokens/.exec(line).map(Number);
  assert(Math.abs(whole - textTokens(full, 4.4)) < 25 && small < whole * 0.6, line);
});
