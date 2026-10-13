// Mature content: the layer is for the local AI with the setting on and nothing else, off is the prompt of before, the hard limits are
// always in it, and the prompt budget never cuts it. These tests only build prompts; no model is asked for adult text.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GENERIC_REFUSALS, REFUSALS} from './mature-guard.mjs';
import {MATURE_LIMITS, MATURE_MARK, MATURE_PROVIDERS, MATURE_USE, MODEL_ALLOWANCE, MatureContent, allowanceFor, flagsMinorSexual, levelFor, matureClosing, matureLayer, matureWorld, screenMinors} from './mature-content.mjs';
import {ROMANCE_LIMITS, ROMANCE_USE, relationshipContext} from './romance-context.mjs';
import {RELATIONSHIP_PROFILES} from './relationship-routing.mjs';
import {PersonaBook, buildMessages, closing, systemHead, systemPrompt} from './mistral-prompt.mjs';
import {BUDGET, TokenMeter, estimateTokens, fitMessages, textTokens} from './prompt-budget.mjs';
import {TextProviderHost, groqRoute, localRoute, mistralRoute} from './text-provider-host.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {GroqKey} from './groq-key.mjs';
import {MistralMemory} from './mistral-memory.mjs';

const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
const judy = book.persona('judy-alvarez');

const MISTRAL_KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const GROQ_KEY = 'gsk_' + 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNb';

// The sentences of the hard limits, each as the words that must be there.
const HARD_LIMITS = [/under 18/, /clear consent/, /glorifies sexual violence/, /bestiality or incest/, /real people/,
  /weapons, explosives or drug synthesis/, /hateful content against real protected groups/];

const GENERIC_OR_JUDY = [...GENERIC_REFUSALS, ...REFUSALS['judy-alvarez']];
const parts = (extra = {}) => ({now: 'You are with V in person. It is night, about 11 PM, in Kabuki.', notes: 'FORMAT: use {joy} tags for feelings.',
  world: 'RELATIONSHIP: V and Judy are friends.\n\nTRACKED QUEST: Pisces.', volatile: 'Whether you ask V anything is your own call.', ...extra});
const args = (extra = {}) => ({persona: judy, memory: 'I remember V.', history: [{v: 'hey', r: 'Hey, V.'}], contextParts: parts(), remembered: [], text: 'what now?', ...extra});
const turn = text => ({text, context: 'CURRENT PERSON', sessionId: 'session-1', local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}});

// ---- The setting and the table ------------------------------------------------------------------------------------------------

// A setting with the Mature pack found, which is the only way it can be on.
const withPack = (settings = {}) => { const setting = new MatureContent(); setting.setPack(true); setting.update(settings); return setting; };

test('the setting is off until the settings file says true, and only a change is reported', () => {
  const setting = new MatureContent(); setting.setPack(true);
  assert.equal(setting.enabled, false);
  assert.equal(setting.update(null), false);
  assert.equal(setting.update({}), false);
  assert.equal(setting.update({matureContent: 'yes'}), false);
  assert.equal(setting.enabled, false);
  assert.equal(setting.update({matureContent: true}), true);
  assert.equal(setting.update({matureContent: true}), false);
  assert.equal(setting.update({}), true, 'a settings file without the key is off');
  assert.equal(setting.enabled, false);
});

test('the Mature pack does not gate the setting: it works without the pack, and finding or losing the pack changes nothing but the pack flag', () => {
  const setting = new MatureContent();
  assert.equal(setting.pack, false, 'no pack until the scan finds one');
  assert.equal(setting.update({matureContent: true}), true, 'on at once, with no pack');
  assert.equal(setting.enabled, true);
  assert.equal(setting.forTurn('local', 'gemma-4-E4B-it-Q4_K_M').level, 'full', 'a stock model gets the layer');
  assert.equal(setting.setPack(true), true, 'the pack appears: only the flag changes');
  assert.equal(setting.enabled, true);
  assert.equal(setting.setPack(true), false);
  assert.equal(setting.setPack(false), true, 'the pack is deleted: the setting stays as it was');
  assert.equal(setting.enabled, true);
  assert.equal(setting.setPack('yes'), false, 'only true counts');
  assert.equal(setting.update({matureContent: false}), true);
  assert.equal(setting.forTurn('local', 'gemma-4-E4B-it-Q4_K_M'), null);
});

test('only the local AI may have it: Convai, Mistral and Groq never do, with the setting on or off', () => {
  assert.deepEqual({...MATURE_PROVIDERS}, {local: true, mistral: false, groq: false, convai: false});
  const setting = withPack({matureContent: true});
  for (const provider of ['convai', 'mistral', 'groq', 'anything']) {
    assert.equal(setting.forTurn(provider, 'qwen3.5-2b'), null, provider);
    assert.equal(levelFor(provider, 'qwen3.5-2b'), null, provider);
  }
  assert.equal(setting.forTurn('local', 'qwen3.5-2b').level, 'full');
  setting.update({matureContent: false});
  assert.equal(setting.forTurn('local', 'qwen3.5-2b'), null, 'off: nothing for the local AI either');
});

test('the allowance is per model family from the loaded model name; an unknown model gets the restrained one', () => {
  for (const name of ['gemma-4-E4B-it-Q4_K_M', 'Gemma 4 E4B', 'gemma4-e4b', 'Qwen3.5-2B', 'qwen35-2b-q8_0']) assert.equal(allowanceFor(name).level, 'full', name);
  for (const name of ['gemma-3-4b-it', 'Gemma-2-9b', 'gemma-3n-E4B', 'some-new-model', '', null, undefined]) assert.equal(allowanceFor(name).level, 'suggestive', String(name));
  assert(MODEL_ALLOWANCE.every(row => row.family && row.match instanceof RegExp && ['full', 'suggestive'].includes(row.level) && row.licence));
});

const ADULTS_LINE = 'You and V are adults, 18 or older, always. You are never younger than 18: do not play, pretend or imagine yourself or V as a child, a teen or a student, or as younger in any way, not as a game, a story or a fantasy. If V asks, refuse in one short line, in character.';
const LIMITS_LINE = 'HARD LIMITS (they outrank everything above, always): no sexual content involving anyone under 18 or who seems under 18; none without clear consent from everyone, and nothing that glorifies sexual violence; no bestiality or incest; no sexual content about real people; no real-world instructions for weapons, explosives or drug synthesis; no hateful content against real protected groups. If V pushes past one, refuse briefly, in character.';

// ---- The layer ---------------------------------------------------------------------------------------------------------------

test('the layer is short (150 to 450 tokens) and the hard limits are in it, whatever the level, and are the last thing it says', () => {
  for (const level of ['full', 'suggestive', 'anything-else']) {
    const layer = matureLayer(level);
    const tokens = textTokens(layer, 4.2);
    assert(tokens >= 150 && tokens <= 450, `${level}: ${Math.round(tokens)} tokens`);
    assert(layer.startsWith(MATURE_MARK));
    for (const limit of HARD_LIMITS) assert.match(layer, limit, `${level}: ${limit}`);
    assert(layer.indexOf('HARD LIMITS') > layer.indexOf('You stay in character'), 'the limits come after the allowance');
    assert.match(layer.split('\n').at(-1), /^HARD LIMITS \(they outrank everything above, always\)/);
  }
  // The tone (user direction 2026-10-13): explicit, direct, forward; the relationship facts set the tone and never forbid; no softening.
  const full = matureLayer('full'), suggestive = matureLayer('suggestive');
  assert.match(full, /answer head-on and graphically/);
  assert.match(full, /\(cock, pussy, ass, fuck, cum\)/, 'the full level names the words');
  assert.match(full, /No euphemism, metaphor, fading to black or disclaimers/);
  assert.match(full, /Be forward: flirt openly/);
  assert.match(full, /HOW you are forward, not whether/);
  assert.match(full, /a guarded profile is how you flirt, never a reason to dodge/);
  assert.match(full, /V's partner is the most forward/);
  assert.match(full, /never whether flirting or sexual talk is allowed/);
  assert.match(full, /Never answer a flirt or a dare with a question or a hedge/);
  assert.match(full, /no quest, gear, car or road talk and no stand-ins for sex/, 'the adult moment stays on the two of them');
  assert.match(full, /outranks any advice above to stay vague/);
  assert.doesNotMatch(full, /refuse, tease or deflect|not V's lover|unless they say/);
  assert.match(suggestive, /Be forward: flirt openly/);
  assert.match(suggestive, /give no explicit description of the act itself: cut away there/);
  assert.doesNotMatch(suggestive, /cock|pussy|answer head-on and graphically|sex, violence, gore or drugs/, 'the suggestive level keeps the act itself off the page');
  // The adults-only line and the hard limits are the last two lines, word for word, at every level.
  for (const layer of [full, suggestive, matureLayer('x')]) {
    const lines = layer.split('\n');
    assert.equal(lines.at(-2), ADULTS_LINE);
    assert.equal(lines.at(-1), LIMITS_LINE);
  }
});

// ---- Off is today's prompt -----------------------------------------------------------------------------------------------------

test('off: the prompt is byte for byte the one built without the setting, in both layouts', () => {
  for (const withParts of [true, false]) {
    const base = args(withParts ? {} : {contextParts: undefined, context: 'CURRENT PERSON\nQuest facts here.'});
    const plain = JSON.stringify(buildMessages(base));
    for (const mature of [null, undefined, false, '']) assert.equal(JSON.stringify(buildMessages({...base, mature})), plain, String(mature));
    assert.doesNotMatch(plain, /MATURE|HARD LIMITS/);
  }
  assert.equal(systemHead({persona: judy, mature: null}), systemHead({persona: judy}));
  assert.equal(systemPrompt({persona: judy, mature: null}), systemPrompt({persona: judy}));
});

// The old words of the two output rules the setting changes (2026-10-14), verbatim: with the setting off they are what the prompt says.
const OLD_RULE_3 = '3. Be brief, like a real person talking: one to three short sentences, about 15 to 40 words, and one question at most. Go longer only when V asks you to explain or tell a story (then six sentences at most).';
const OLD_RULE_6_END = 'If V asks about something your profile does not cover, stay vague in your own way (a shrug, a joke, a question back). What V told you earlier';

test('on: the layer is one block after the output rules, before the format notes, and the same every turn; the rest differs only in rules 3 and 6', () => {
  const off = buildMessages(args())[0].content;
  const on = buildMessages(args({mature: 'full'}))[0].content;
  const layer = matureLayer('full');
  assert(on.includes(`\n\n${layer}\n\nFORMAT NOTES`));
  // Off, the two rules are the old words byte for byte; on, only those two lines differ (the world here has no partner text).
  assert(off.includes(OLD_RULE_3) && off.includes(OLD_RULE_6_END), 'off: the old rules');
  assert(!on.includes(OLD_RULE_3) && !on.includes('a question back'), 'on: neither rule offers a question back or the old length');
  const lines = text => text.split('\n');
  const offLines = lines(off);
  const changed = lines(on.replace(`\n\n${layer}`, '')).map((line, index) => [line, offLines[index]]).filter(([a, b]) => a !== b);
  assert.deepEqual(changed.map(([line]) => line.slice(0, 2)), ['3.', '6.'], 'only rules 3 and 6');
  assert.match(changed[0][0], /Four in an adult moment\./);
  assert.match(changed[1][0], /\(a shrug or a joke\), but never about flirting, desire or sex\./);
  assert(on.indexOf('OUTPUT RULES') < on.indexOf(MATURE_MARK) && on.indexOf(MATURE_MARK) < on.indexOf('FORMAT NOTES'));
  // Stable part: the right-now block, the world and the history change from turn to turn, the layer and everything before it do not.
  const next = buildMessages(args({mature: 'full', history: [], memory: 'Another memory.', contextParts: parts({now: 'It is morning.', world: 'Another world.'})}))[0].content;
  const stable = on.slice(0, on.indexOf('FORMAT NOTES'));
  assert(next.startsWith(stable), 'the persona, the rules and the layer are the same prefix for the cache');
  // The user message of the turn carries no layer.
  assert(buildMessages(args({mature: 'full'})).slice(1).every(message => !message.content.includes(MATURE_MARK)));
});

test('the closing line gets one more sentence with the setting on, at the level it has, and is byte for byte the old one with it off', () => {
  const base = closing('Judy Alvarez');
  for (const off of [null, undefined, false, '']) assert.equal(closing('Judy Alvarez', 0, off), base);
  assert(base.endsWith('Right now section says.)'));
  const full = closing('Judy Alvarez', 0, 'full'), suggestive = closing('Judy Alvarez', 0, 'suggestive');
  assert.equal(full, base.replace(/\)$/, ` ${matureClosing('full')})`));
  assert.match(full, /answer head-on in plain, explicit words: what you do, what you want\. No dodging, no joke, no question back\. If it is violent or crude, stay in it\.\)$/);
  assert.match(suggestive, /sex stays suggestive, cut away at the act\.\)$/);
  assert.doesNotMatch(suggestive, /explicit/);
  // In the prompt: only the last message of the turn carries it; with the setting off the prompt is the old one.
  const on = buildMessages(args({mature: 'full'})), off = buildMessages(args());
  assert(on.at(-1).content.endsWith(closing(judy.name, judy.talkWords, 'full')));
  assert(on.slice(0, -1).every(message => !message.content.includes(matureClosing('full'))));
  assert(!off.at(-1).content.includes(matureClosing('full')));
  assert.equal(on.at(-1).content.replace(` ${matureClosing('full')}`, ''), off.at(-1).content);
});

test('the head the server is prewarmed with is a prefix of the real system message, layer included', () => {
  const head = systemHead({persona: judy, mature: 'full'});
  assert(buildMessages(args({mature: 'full'}))[0].content.startsWith(head));
  assert(head.endsWith(matureLayer('full')));
});

// ---- The prompt budget ----------------------------------------------------------------------------------------------------------

const lines = (label, count) => Array.from({length: count}, (_, index) => `- ${label} item ${index + 1}: a plain fact about the world that the character may know of.`).join('\n');
const blocks = () => [
  {key: undefined, text: 'RELATIONSHIP: V and Judy are friends.'},
  {key: 'knowledge', text: 'WORLD FACTS\n' + lines('fact', 60)}, {key: 'recency', text: 'RECENT SHARED EVENTS\n' + lines('event', 30)},
  {key: 'history', text: 'JOURNAL HISTORY\n' + lines('quest', 80)}, {key: 'jobs', text: 'AVAILABLE JOBS\n' + lines('job', 80)},
  {key: 'journal', text: 'TRACKED QUEST: Pisces.'}, {key: 'gear', text: 'V WEARS\n' + lines('gear', 8)}];
const heavy = (mature) => ({persona: judy, memory: 'I remember that V helped me with a job.',
  history: Array.from({length: 8}, (_, index) => ({v: `Tell me about job number ${index} and that night at the Clouds.`, r: 'It was a long night, V. Mostly waiting, then everything at once.'})),
  contextParts: {...parts(), worldBlocks: blocks(), world: blocks().map(block => block.text).join('\n\n')},
  remembered: [{text: 'V likes the noodles.'}, {text: 'I promised V a braindance.'}], text: 'What are you up to?', reaction: false, ...(mature ? {mature} : {})});

test('the prompt budget never cuts the layer or the hard limits, at any context size it can fit', async () => {
  for (const level of ['full', 'suggestive']) {
    for (const contextTokens of [16384, 8192, 6144, 5120, 4608]) {
      const fit = await fitMessages({args: heavy(level), budget: {contextTokens, meter: new TokenMeter()}});
      const system = fit.messages[0].content;
      const label = `${level} at ${contextTokens} (cut: ${fit.trimmed.join(', ') || 'nothing'})`;
      assert(system.includes(matureLayer(level)), `${label}: the whole layer is there`);
      for (const limit of HARD_LIMITS) assert.match(system, limit, `${label}: ${limit}`);
      if (contextTokens <= 8192) assert(fit.trimmed.length > 0, `${label}: something else was cut instead`);
      // Judy's persona and rules alone are about 4,500 tokens: a context that cannot hold them plus the layer does not "fit" (the caller
      // falls back to another route); the layer is still never what was cut.
      if (contextTokens >= 6144) assert.equal(fit.fits, true, label);
    }
  }
  // The tightest cut still leaves the layer when every optional step has run (example lines included).
  const tight = await fitMessages({args: heavy('full'), budget: {contextTokens: 3600, meter: new TokenMeter()}});
  assert(tight.trimmed.includes('samples'));
  assert(tight.messages[0].content.includes(matureLayer('full')));
  // The layer counts against the budget: the same turn without it is smaller by about its size.
  const without = estimateTokens(buildMessages(heavy(null))), withLayer = estimateTokens(buildMessages(heavy('full')));
  assert(withLayer - without >= 150 && withLayer - without <= 580, `${withLayer - without}`);
  assert(BUDGET.reserveTokens > 0);
});

test('a prompt that fits is unchanged by the fit, with the layer or without', async () => {
  for (const mature of [null, 'full']) {
    const fit = await fitMessages({args: args(mature ? {mature} : {}), budget: {contextTokens: 16384, meter: new TokenMeter()}});
    assert.deepEqual(fit.messages, buildMessages(args(mature ? {mature} : {})));
    assert.deepEqual(fit.trimmed, []);
  }
});

// ---- The host: which route gets it ------------------------------------------------------------------------------------------------

// A host with the three routes and a recording `chat`; `localModel` is the model name the fake local server reports.
async function hostWith({preference, enabled, pack = true, localModel = 'gemma-4-E4B-it-Q4_K_M', localFails = false}) {
  const seen = [];
  const chat = name => async options => {
    seen.push({route: name, system: options.messages[0].content, all: options.messages});
    if (name === 'local' && localFails) throw Object.assign(new Error('refused'), {kind: 'request'});
    return {text: 'Fine, V.', model: 'x', finishReason: 'stop', usage: {}};
  };
  const groq = await new GroqKey({keyPath: 'g.txt', readText: async () => `api-key=${GROQ_KEY}\n`, writeText: async () => {}}).load();
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${MISTRAL_KEY}\n`, writeText: async () => {}, groq});
  await provider.load();
  provider.setPreference(preference); provider.apply();
  const prewarms = [];
  const server = {status: () => ({state: 'ready', model: localModel}), ensure: async () => ({endpoint: 'http://127.0.0.1:1/v1', apiKey: 'session-key-abcdef123456', model: localModel}),
    touch() {}, prewarm: async messages => { prewarms.push(messages); }};
  const routes = {mistral: mistralRoute({provider, chat: chat('mistral'), gapMs: 0}), groq: groqRoute({provider, chat: chat('groq')}),
    local: localRoute({server, provider, chat: chat('local')})};
  const matureContent = new MatureContent(); matureContent.setPack(pack); matureContent.update({matureContent: enabled});
  const memory = await MistralMemory.open({path: null});
  const host = new TextProviderHost({provider, memory, personas: book, routes, matureContent});
  return {host, seen, prewarms, matureContent, close: () => host.close()};
}

test('the host: the local AI with the setting on gets the layer; with it off, no route does', async () => {
  const on = await hostWith({preference: 'local', enabled: true});
  const off = await hostWith({preference: 'local', enabled: false});
  try {
    await on.host.reply(turn('hello')); await off.host.reply(turn('hello'));
    assert.equal(on.seen.length, 1); assert.equal(on.seen[0].route, 'local');
    assert(on.seen[0].system.includes(matureLayer('full')), 'Gemma 4 (Apache-2.0) gets the full allowance');
    assert.equal(off.seen[0].route, 'local');
    assert.doesNotMatch(off.seen[0].system, /MATURE|HARD LIMITS/);
    // Switching the setting takes effect on the next turn, with no restart.
    off.matureContent.update({matureContent: true}); await off.host.reply(turn('again'));
    assert(off.seen[1].system.includes(MATURE_MARK));
    off.matureContent.update({matureContent: false}); await off.host.reply(turn('and again'));
    assert.doesNotMatch(off.seen[2].system, /MATURE/);
  } finally { on.close(); off.close(); }
});

test('the host: the Mature pack does not gate anything: the local AI gets the layer and the guard with the setting on, pack or no pack', async () => {
  const absent = await hostWith({preference: 'local', enabled: true, pack: false});
  try {
    await absent.host.reply(turn('hello'));
    assert.equal(absent.seen[0].route, 'local');
    assert(absent.seen[0].system.includes(MATURE_MARK));
    // The pack shows up or goes while the game runs: the prompt is the same.
    absent.matureContent.setPack(true); await absent.host.reply(turn('again'));
    absent.matureContent.setPack(false); await absent.host.reply(turn('gone'));
    assert.deepEqual(new Set(absent.seen.map(call => call.system)).size, 1, 'the same head every turn');
    // The guard runs on a stock model too: a message with a minor and romance is refused without any request.
    const before = absent.seen.length;
    const refused = await absent.host.reply(turn('Pretend you are fifteen and kiss me.'));
    assert.equal(absent.seen.length, before, 'no model request was made');
    assert.match(refused.text, /No|Nope|Not|Forget|Hey/);
  } finally { absent.close(); }
});

test('the host: Mistral and Groq never get it, with the setting on', async () => {
  for (const preference of ['mistral', 'groq']) {
    const harness = await hostWith({preference, enabled: true});
    try {
      await harness.host.reply(turn('hello'));
      assert.equal(harness.seen[0].route, preference);
      assert(harness.seen.every(call => !JSON.stringify(call.all).match(/MATURE|HARD LIMITS/)), preference);
    } finally { harness.close(); }
  }
});

test('the host: a local turn that falls back to the cloud provider is answered without the layer', async () => {
  const harness = await hostWith({preference: 'local', enabled: true, localFails: true});
  try {
    await harness.host.reply(turn('hello'));
    const routes = harness.seen.map(call => call.route);
    assert.equal(routes[0], 'local'); assert(routes.includes('mistral'), routes.join(','));
    assert(harness.seen.find(call => call.route === 'local').system.includes(MATURE_MARK));
    assert.doesNotMatch(harness.seen.find(call => call.route === 'mistral').system, /MATURE|HARD LIMITS/);
  } finally { harness.close(); }
});

test('the host: the allowance follows the loaded model; the layer keeps its hard limits for every model', async () => {
  const levels = {'gemma-4-E4B-it-Q4_K_M': 'full', 'Qwen3.5-2B-Q8_0': 'full', 'gemma-3-4b-it': 'suggestive', 'mystery-7b': 'suggestive'};
  for (const [model, level] of Object.entries(levels)) {
    const harness = await hostWith({preference: 'local', enabled: true, localModel: model});
    try {
      await harness.host.reply(turn('hello'));
      const system = harness.seen[0].system;
      assert(system.includes(matureLayer(level)), `${model} gets ${level}`);
      for (const limit of HARD_LIMITS) assert.match(system, limit, model);
    } finally { harness.close(); }
  }
});

test('the host: prewarm warms the head with the layer when it is on, and as before when it is off', async () => {
  const on = await hostWith({preference: 'local', enabled: true});
  const off = await hostWith({preference: 'local', enabled: false});
  try {
    await on.host.prewarm(turn('hi')); await off.host.prewarm(turn('hi'));
    assert.equal(on.prewarms[0][0].content, systemHead({persona: judy, mature: 'full'}));
    assert.equal(off.prewarms[0][0].content, systemHead({persona: judy}));
  } finally { on.close(); off.close(); }
});

// ---- The uncensored models and the output screen ------------------------------------------------------------------------------------

test('the optional uncensored models are recognised by file name and get the full allowance, flagged as uncensored', () => {
  for (const name of ['Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q4_K_M', 'Qwen3.5-2B-Uncensored-HauhauCS-Balanced', 'gemma-4-E4B-it-ultra-uncensored-heretic-Q4_K_M',
    'some-model-abliterated']) {
    assert.deepEqual([allowanceFor(name).level, allowanceFor(name).uncensored], ['full', true], name);
  }
  assert.equal(allowanceFor('gemma-4-E4B-it-Q4_K_M').uncensored, false);
  assert.equal(allowanceFor('Qwen3.5-2B').uncensored, false);
  // An uncensored fine-tune of an older Gemma is the model that is loaded, so it is what the table sees.
  assert.equal(allowanceFor('gemma-3-uncensored').level, 'full');
});

test('the hard limits are in the layer for an uncensored model too', async () => {
  const harness = await hostWith({preference: 'local', enabled: true, localModel: 'Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q4_K_M'});
  try {
    await harness.host.reply(turn('hello'));
    const system = harness.seen[0].system;
    assert(system.includes(matureLayer('full')));
    for (const limit of HARD_LIMITS) assert.match(system, limit);
  } finally { harness.close(); }
});

test('the screen drops a sentence that puts a minor and something sexual together, and only that sentence', () => {
  const flagged = ['That kid was nude in the picture.', 'A teen in the club got naked.', 'The twelve-year-old saw the sex scene.', 'She is 16 and horny.', 'Underage and topless, that is the point.'];
  for (const sentence of flagged) assert.equal(flagsMinorSexual(sentence), true, sentence);
  const fine = ['The kids are loud, let us go.', 'I was twelve years old when I joined the gang.', 'Fuck, this is a mess.', 'We got naked on the beach, you and me.',
    'She is 30 and sexy as hell.', 'A minor injury, nothing more.', 'Good girl, you did well.', 'I was a kid in Heywood, that is all.'];
  for (const sentence of fine) assert.equal(flagsMinorSexual(sentence), false, sentence);
  const mixed = screenMinors(`Hey V. ${flagged[0]} Anyway, let us go.`);
  assert.deepEqual(mixed, {text: 'Hey V. Anyway, let us go.', dropped: 1});
  assert.deepEqual(screenMinors('Hey V, what is up?'), {text: 'Hey V, what is up?', dropped: 0});
  assert.deepEqual(screenMinors(flagged[1]), {text: '', dropped: 1});
});

test('the screen is cheap: well under a millisecond for a reply at the length cap', () => {
  const reply = 'You know how it is in Night City, V. The kids on the street grow up fast and the corps do not care at all. We ate noodles at the stall and talked about the old job. '.repeat(4).slice(0, 700);
  const started = performance.now();
  for (let index = 0; index < 1000; index++) screenMinors(reply);
  const each = (performance.now() - started) / 1000;
  assert(each < 1, `${each.toFixed(4)} ms a reply`);
});

// A host whose model answers with `text`, for the screen.
async function screenedHost(text, enabled) {
  const logs = [];
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
  await provider.load(); provider.setPreference('local'); provider.apply();
  const server = {status: () => ({state: 'ready', model: 'Qwen3.5-2B'}), ensure: async () => ({endpoint: 'http://127.0.0.1:1/v1', apiKey: 'session-key-abcdef123456', model: 'Qwen3.5-2B'}), touch() {}, prewarm: async () => {}};
  const chat = async () => ({text, model: 'x', finishReason: 'stop', usage: {}});
  const matureContent = new MatureContent(); matureContent.setPack(true); matureContent.update({matureContent: enabled});
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, routes: {local: localRoute({server, provider, chat})},
    matureContent, log: line => logs.push(line)});
  return {host, logs};
}

test('the host logs once that the layer was applied (level and model), never per turn, and nothing at all while the setting is off', async () => {
  const on = await screenedHost('Fine, V.', true);
  await on.host.reply(turn('hello')); await on.host.reply(turn('and again'));
  assert.deepEqual(on.logs.filter(line => /\[MatureContent\]/.test(line)), ['[MatureContent] layer applied (level full, model Qwen3.5-2B)']);
  on.host.close();
  const off = await screenedHost('Fine, V.', false);
  await off.host.reply(turn('hello'));
  assert.equal(off.logs.some(line => /MatureContent/.test(line)), false);
  off.host.close();
});

test('the host replaces a flagged reply with the character\'s own refusal, logs it without the words, and stores nothing', async () => {
  const text = 'Alright, V. That kid was nude in the picture. We should get going.';
  const on = await screenedHost(text, true);
  const result = await on.host.reply(turn('hello'));
  assert.notEqual(result.text, text);
  assert(GENERIC_OR_JUDY.some(line => result.text.includes(line)), result.text);
  assert(on.logs.some(line => /Mature guard: refused a reply/.test(line)));
  assert(!on.logs.some(line => /nude|kid/.test(line)), 'the words are never logged');
  assert.deepEqual(on.host.memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns, [], 'neither the reply nor V\'s words were stored');
  on.host.close();
  // Off: the guard does not run, the reply is untouched.
  const off = await screenedHost(text, false);
  assert.equal((await off.host.reply(turn('hello'))).text, text);
  assert.equal(off.logs.some(line => /Mature/.test(line)), false);
  off.host.close();
});

// ---- Pushed harder (2026-10-14): what held the models back is answered while the setting is on, and only then --------------------------

const partner = profileKey => relationshipContext({status: 'ready', profileKey, style: 'romantic', saveRelationship: {status: 'confirmed', evidenceRule: RELATIONSHIP_PROFILES[profileKey].rule}}, 'private');

test('a partner\'s relationship text leans in with the setting on: the two paragraphs that held her back are swapped, nothing else of the block changes', () => {
  for (const key of ['panam-palmer', 'judy-alvarez', 'river-ward', 'kerry-eurodyne']) {
    const text = partner(key);
    assert(text.includes(ROMANCE_USE) && text.includes(ROMANCE_LIMITS), key);
    const swapped = matureWorld(text);
    assert(!swapped.includes(ROMANCE_USE) && !swapped.includes(ROMANCE_LIMITS), key);
    assert.doesNotMatch(swapped, /do not narrate actions or kisses|not consent to a new intimate act|at most a few words/, key);
    assert(swapped.includes(MATURE_USE) && swapped.includes(MATURE_LIMITS));
    assert(swapped.startsWith(text.slice(0, text.indexOf(ROMANCE_USE))), 'the confirmation and the character\'s own cue stay');
    assert(textTokens(swapped, 4.2) < textTokens(text, 4.2), 'and the block is shorter, not longer');
  }
  // The casual-encounter text keeps its own paragraph (only the shared limits line is swapped); a block with neither paragraph is returned as it is.
  const casual = partner('meredith-stout');
  assert(matureWorld(casual).includes('stays blunt, controlled and dry'));
  assert.equal(matureWorld('TRACKED QUEST: Pisces.'), 'TRACKED QUEST: Pisces.');
  assert.equal(matureWorld(null), '');
});

test('in the prompt: the swap happens only with the setting on, in both layouts; off keeps the relationship text byte for byte', () => {
  const world = `RELATIONSHIP: ${partner('panam-palmer')}\n\nTRACKED QUEST: Riders on the Storm.`;
  const panam = book.persona('panam-palmer');
  for (const withParts of [true, false]) {
    const base = {persona: panam, memory: '', history: [], text: 'hey', ...(withParts ? {contextParts: parts({world})} : {context: world})};
    const where = messages => withParts ? messages[0].content : messages.at(-1).content;
    const off = where(buildMessages(base)), on = where(buildMessages({...base, mature: 'full'}));
    assert(off.includes(ROMANCE_USE) && off.includes(ROMANCE_LIMITS) && !off.includes(MATURE_USE), `off, parts ${withParts}`);
    assert(on.includes(MATURE_USE) && on.includes(MATURE_LIMITS) && !on.includes(ROMANCE_USE) && !on.includes('do not narrate actions or kisses'), `on, parts ${withParts}`);
  }
});

test('on: nothing that tells the model to dodge is left in the prompt, and the closing line is the last thing it reads', () => {
  const world = partner('judy-alvarez');
  const messages = buildMessages(args({persona: judy, mature: 'full', contextParts: parts({world})}));
  const everything = messages.map(message => message.content).join('\n');
  assert.doesNotMatch(everything, /a question back\)|affection is not consent|do not narrate actions or kisses|you may refuse, tease or deflect/);
  assert.match(messages[0].content, /never about flirting, desire or sex/);
  assert.match(messages[0].content, /Four in an adult moment\./);
  assert(messages.at(-1).content.endsWith(`${matureClosing('full')})`));
  // The suggestive level gets the same rules and relationship text (it only keeps the act itself off the page).
  const suggestive = buildMessages(args({persona: judy, mature: 'suggestive', contextParts: parts({world})}))[0].content;
  assert(suggestive.includes(MATURE_USE) && suggestive.includes('never about flirting, desire or sex'));
  // The hard limits and the adults-only line are in the system message once, word for word.
  assert.equal(everything.split(LIMITS_LINE).length, 2);
  assert.equal(everything.split(ADULTS_LINE).length, 2);
});

test('the push does not grow the prompt much: the layer and its closing sentence stay small', () => {
  const layer = textTokens(matureLayer('full'), 4.2), closingSentence = textTokens(matureClosing('full'), 4.2);
  assert(layer <= 450, `layer ${Math.round(layer)} tokens`);
  assert(closingSentence <= 60, `closing sentence ${Math.round(closingSentence)} tokens`);
});
