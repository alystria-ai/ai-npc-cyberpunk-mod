// Mature content: the layer is for the local AI with the setting on and nothing else, off is the prompt of before, the hard limits are
// always in it, and the prompt budget never cuts it. These tests only build prompts; no model is asked for adult text.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GENERIC_REFUSALS, REFUSALS} from './mature-guard.mjs';
import {MATURE_MARK, MATURE_PROVIDERS, MODEL_ALLOWANCE, MatureContent, allowanceFor, flagsMinorSexual, levelFor, matureLayer, screenMinors} from './mature-content.mjs';
import {PersonaBook, buildMessages, systemHead, systemPrompt} from './mistral-prompt.mjs';
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

// ---- The layer ---------------------------------------------------------------------------------------------------------------

test('the layer is short (150 to 320 tokens) and the hard limits are in it, whatever the level, and are the last thing it says', () => {
  for (const level of ['full', 'suggestive', 'anything-else']) {
    const layer = matureLayer(level);
    const tokens = textTokens(layer, 4.2);
    assert(tokens >= 150 && tokens <= 320, `${level}: ${Math.round(tokens)} tokens`);
    assert(layer.startsWith(MATURE_MARK));
    for (const limit of HARD_LIMITS) assert.match(layer, limit, `${level}: ${limit}`);
    assert(layer.indexOf('HARD LIMITS') > layer.indexOf('You stay yourself'), 'the limits come after the allowance');
    assert.match(layer.split('\n').at(-1), /^HARD LIMITS \(they outrank everything above, always\)/);
  }
  assert.match(matureLayer('full'), /romantic or sexual with V/);
  assert.doesNotMatch(matureLayer('suggestive'), /romantic or sexual/);
  assert.match(matureLayer('suggestive'), /keep it suggestive: no explicit sexual description, cut away/);
  assert.match(matureLayer('full'), /relationship facts/, 'it follows the relationship state the prompt carries');
  assert.match(matureLayer('full'), /orientation still apply/);
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

test('on: the layer is purely additive, one block after the output rules, before the format notes, and the same every turn', () => {
  const off = buildMessages(args())[0].content;
  const on = buildMessages(args({mature: 'full'}))[0].content;
  const layer = matureLayer('full');
  assert(on.includes(`\n\n${layer}\n\nFORMAT NOTES`));
  assert.equal(on.replace(`\n\n${layer}`, ''), off, 'taking the layer out leaves exactly the prompt of before');
  assert(on.indexOf('OUTPUT RULES') < on.indexOf(MATURE_MARK) && on.indexOf(MATURE_MARK) < on.indexOf('FORMAT NOTES'));
  // Stable part: the right-now block, the world and the history change from turn to turn, the layer and everything before it do not.
  const next = buildMessages(args({mature: 'full', history: [], memory: 'Another memory.', contextParts: parts({now: 'It is morning.', world: 'Another world.'})}))[0].content;
  const stable = on.slice(0, on.indexOf('FORMAT NOTES'));
  assert(next.startsWith(stable), 'the persona, the rules and the layer are the same prefix for the cache');
  // The user message of the turn carries no layer.
  assert(buildMessages(args({mature: 'full'})).slice(1).every(message => !message.content.includes(MATURE_MARK)));
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
  assert(withLayer - without >= 150 && withLayer - without <= 430, `${withLayer - without}`);
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
