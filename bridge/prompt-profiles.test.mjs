import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, writeFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BASE_PROFILE, BUILT_IN_IDS, PROFILE_LIMITS, customProfileId, defaultProfile, familyOf, limitsWith, mergeProfile, profileIdFor, profileSignature,
  readOverride, renderClosing, renderRules, validateOverride} from './prompt-profiles.mjs';
import {PromptProfiles} from './prompt-profile-store.mjs';
import {buildMessages, systemHead, LIMITS} from './mistral-prompt.mjs';
import {matureLayer, guardLayer} from './mature-content.mjs';
import {buildPrompt, messagesFor, HISTORY, MEMORY, REMEMBERED, USER_LINES} from '../scripts/judy-prompt-fixture.mjs';

const prompt = buildPrompt();
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const args = (extra = {}) => ({persona: prompt.persona, memory: MEMORY, history: HISTORY, contextParts: prompt.contextParts, remembered: REMEMBERED, text: USER_LINES.a, limits: LIMITS, ...extra});
const temp = async () => mkdtemp(join(tmpdir(), 'prompt-profiles-'));

// ---- Which profile a turn uses ---------------------------------------------------------------------------------------------

test('profileIdFor: the route, the loaded tier, the Mature setting and the Custom endpoint choose the profile; Convai has none', () => {
  assert.equal(profileIdFor({route: 'mistral'}), 'mistral');
  assert.equal(profileIdFor({route: 'mistral', mature: true}), 'mistral', 'Mistral never gets a Mature profile');
  assert.equal(profileIdFor({route: 'local', tier: 'lite'}), 'local-lite');
  assert.equal(profileIdFor({route: 'local', tier: 'standard'}), 'local-standard');
  assert.equal(profileIdFor({route: 'local', tier: null}), 'local-standard', 'a model whose tier is not known yet is a Standard one');
  assert.equal(profileIdFor({route: 'local', tier: 'lite', mature: true}), 'mature-lite');
  assert.equal(profileIdFor({route: 'local', tier: 'standard', mature: true}), 'mature-standard');
  assert.equal(profileIdFor({route: 'custom', custom: {origin: 'https://openrouter.ai', model: 'qwen/qwen3-30b'}}), 'custom-openrouter-ai-qwen-qwen3-30b');
  assert.equal(profileIdFor({route: 'convai'}), null);
});

test('customProfileId: one stable id per endpoint and model, lower case, at most 80 characters, a cut one keeps a hash so two stay apart', () => {
  assert.equal(customProfileId('http://127.0.0.1:1234', 'Gemma-3-4B-IT'), 'custom-127-0-0-1-1234-gemma-3-4b-it');
  assert.equal(customProfileId('http://127.0.0.1:1234', 'Gemma-3-4B-IT'), customProfileId('http://127.0.0.1:1234', 'Gemma-3-4B-IT'));
  assert.notEqual(customProfileId('http://127.0.0.1:1234', 'a'), customProfileId('http://127.0.0.1:1235', 'a'));
  const long = 'x'.repeat(200);
  const a = customProfileId('https://example.com', `${long}a`), b = customProfileId('https://example.com', `${long}b`);
  assert(a.length <= 80 && b.length <= 80 && a !== b);
  assert.match(a, /^custom-[a-z0-9-]+$/);
});

test('the Gemini profile (2026-10-30): few rules said as what to do, the context as what she already knows, the reaction to V first, three short examples and no "never" list', () => {
  const profile = defaultProfile(customProfileId('https://generativelanguage.googleapis.com', 'gemini-flash-lite-latest'), {family: familyOf('gemini-flash-lite-latest')});
  assert.deepEqual(profile.rules.map(rule => rule.id), ['voice', 'answer', 'short', 'now', 'facts', 'plain', 'identity', 'language'], 'the identity rule keeps its id for an add-on speaker');
  const rules = profile.rules.map(rule => rule.text).join(' ');
  assert.match(rules, /React to what V just said before anything else/);
  assert.match(rules, /what you already know, the way anyone knows where they are/);
  assert.ok((rules.match(/\bnever\b/gi) ?? []).length === 0, 'no "never" in the rules: a named thing to avoid is a thing to say');
  assert.equal(profile.examples.length, 3);
  assert.ok(profile.examples.every(line => line.length < 80 && !/Night City|Watson|eddies|V's/.test(line)), 'short, with no world facts to copy');
  assert.equal(profile.sampling.temperature, 0.7);
  assert.doesNotMatch(JSON.stringify(profile.rules), /[;–—]/);
});

test('familyOf: Custom models start from their family; an unknown one gets the generic default', () => {
  for (const [model, family] of [['qwen/qwen3-30b-a3b', 'qwen'], ['google/gemma-3-27b-it', 'gemma'], ['meta-llama/Llama-3.3-70B', 'llama'], ['mistralai/ministral-8b', 'mistral'],
    ['gemini-flash-lite-latest', 'gemini'], ['google/gemini-2.5-flash', 'gemini'], ['deepseek-chat', 'generic'], ['', 'generic'], [undefined, 'generic']]) assert.equal(familyOf(model), family, String(model));
  for (const family of ['generic', 'qwen', 'gemma', 'gemini', 'llama', 'mistral']) assert(defaultProfile(customProfileId('http://h', 'm'), {family}));
  assert.equal(defaultProfile('nope'), null);
  assert.equal(defaultProfile('base'), null, 'the base is not a profile id');
});

// ---- The prompt a profile builds ------------------------------------------------------------------------------------------

test('every shipped profile is plain frozen data (JSON-safe), and its prompt is the same on every build', () => {
  for (const id of BUILT_IN_IDS) {
    const profile = defaultProfile(id);
    assert(Object.isFrozen(profile) && Object.isFrozen(profile.rules) && Object.isFrozen(profile.rules[0]));
    assert.deepEqual(JSON.parse(JSON.stringify(profile)), profile);
    assert.equal(sha(buildMessages(args({profile}))), sha(buildMessages(args({profile}))));
    assert(profile.rules.length >= 1 && profile.rules.length <= PROFILE_LIMITS.rules, id);
  }
});

test('a prompt built without a profile is the one built with the base profile, byte for byte (the pinned hashes of prompt-pinned.test.mjs hold)', () => {
  assert.equal(sha(buildMessages(args())), sha(buildMessages(args({profile: BASE_PROFILE}))));
  assert.equal(sha(systemHead({persona: prompt.persona})), sha(systemHead({persona: prompt.persona, profile: BASE_PROFILE})));
});

test('with no player change a profile resolved through the store builds exactly what its default builds', async () => {
  const profiles = new PromptProfiles();
  for (const [turn, id] of [[{route: 'mistral'}, 'mistral'], [{route: 'local', tier: 'lite'}, 'local-lite'], [{route: 'local', tier: 'standard', mature: true}, 'mature-standard'],
    [{route: 'custom', custom: {origin: 'https://openrouter.ai', model: 'qwen/qwen3'}}, customProfileId('https://openrouter.ai', 'qwen/qwen3')]]) {
    const effective = profiles.resolve(turn);
    assert.equal(effective, profiles.resolve(turn), 'memoized: the same object every turn');
    assert.equal(sha(buildMessages(args({profile: effective}))), sha(buildMessages(args({profile: id.startsWith('custom-') ? defaultProfile(id, {family: 'qwen'}) : profiles.getDefault(id)}))), id);
  }
  assert.equal(profiles.resolve({route: 'convai'}), null);
});

test('rules render in the profile\'s order, numbered, with the Mature and reply-length variants; the identity line of an add-on speaker takes the identity rule\'s place', () => {
  const base = renderRules(BASE_PROFILE, {name: 'Judy'});
  assert.match(base, /^OUTPUT RULES \(they outrank everything above about format\)\n1\. You speak out loud, as Judy, to V\./);
  assert.match(base, /\n8\. You are a real person\./);
  assert.match(renderRules(BASE_PROFILE, {name: 'Judy', mature: true}), /Four in an adult moment\./);
  assert.doesNotMatch(base, /Four in an adult moment/);
  assert.match(renderRules(BASE_PROFILE, {name: 'Judy', talkWords: 20, mature: true}), /at most 20 words/);
  assert.match(renderRules(BASE_PROFILE, {name: ''}), /as yourself, to V/);
  assert.match(renderRules(BASE_PROFILE, {name: 'Skippy', identityRule: 'You are a machine.'}), /\n8\. You are a machine\.\n9\. /);
  const reordered = mergeProfile(BASE_PROFILE, {rules: [...BASE_PROFILE.rules].reverse().map(rule => ({...rule}))});
  assert.match(renderRules(reordered, {name: 'Judy', identityRule: 'You are a machine.'}), /\n2\. You are a machine\.\n/);
  const without = mergeProfile(BASE_PROFILE, {rules: [{id: 'only', text: 'Speak.'}]});
  assert.equal(renderRules(without, {name: 'X', identityRule: 'I am a prop.'}), 'OUTPUT RULES (they outrank everything above about format)\n1. Speak.\n2. I am a prop.');
});

test('the closing line: {name} and {words} are filled, the Mature clause follows the text, an empty closing drops the parentheses', () => {
  assert.equal(renderClosing(BASE_PROFILE, {name: 'Judy'}), '(Reply as Judy, out loud: begin with your answer or reaction, one to three short sentences, no invented facts, nothing you are doing or have just done beyond what the Right now section says.)');
  assert.match(renderClosing(BASE_PROFILE, {name: '', talkWords: 12}), /^\(Reply as this person, .*at most 12 words.*says\.\)$/);
  assert.match(renderClosing(BASE_PROFILE, {name: 'Judy', extra: 'Be crude.'}), /says\. Be crude\.\)$/);
  assert.equal(renderClosing(mergeProfile(BASE_PROFILE, {closing: {text: '', talk: ''}}), {name: 'Judy'}), '');
  assert.equal(renderClosing(mergeProfile(BASE_PROFILE, {closing: {text: '', talk: ''}}), {name: 'Judy', extra: 'Be crude.'}), '(Be crude.)');
});

test('a changed profile changes the prompt where the profile says, and nowhere else: the persona, the world, the memory and the right-now block are the same text', () => {
  const profile = mergeProfile(BASE_PROFILE, {rules: [{id: 'short', text: 'Be short.'}], examples: ['Yeah, sure.'], closing: {text: 'Answer {name}.'},
    labels: {formatNotes: 'NOTES', world: 'WORLD', remember: 'MEMORY', rightNow: 'NOW', thisTurn: 'TURN', things: 'THINGS'}, layout: {youNow: false, volatile: 'after'}, limits: {turns: 1}});
  const plain = buildMessages(args()), changed = buildMessages(args({profile}));
  assert.notEqual(changed[0].content, plain[0].content);
  const system = changed[0].content;
  assert(system.includes('OUTPUT RULES (they outrank everything above about format)\n1. Be short.'));
  assert(system.includes('EXAMPLES OF A GOOD REPLY (the shape only: never copy their words)\n- Yeah, sure.'));
  for (const label of ['NOTES', 'WORLD', 'MEMORY', 'NOW']) assert(system.includes(`\n\n${label}\n`), label);
  // The facts: the same world text, memory text and right-now text sit under the changed labels.
  assert.equal(system.split('\n\nWORLD\n')[1].split('\n\nMEMORY\n')[0], plain[0].content.split(`\n\n${BASE_PROFILE.labels.world}\n`)[1].split('\n\nWHAT YOU REMEMBER OF V FROM EARLIER TALKS (true unless the live context says otherwise)\n')[0]);
  assert.equal(system.split('\n\nNOW\n')[1], plain[0].content.split('\n\nRIGHT NOW (from the game; background only, this changes as the talk goes on)\n')[1]);
  assert.equal(changed.length, 4, 'the system message, one exchange of history (limits.turns 1) and the last message');
  const last = changed.at(-1).content;
  assert(!last.includes('[YOU, RIGHT NOW'));
  assert(last.indexOf('V says:') < last.indexOf('[TURN]') && last.indexOf('[TURN]') < last.indexOf('(Answer '), 'the notes come after V\'s line and before the closing');
  assert(last.includes('[THINGS]'));
});

test('the safety guards and the Mature layer are outside the profile: no change to rules, examples or closing removes them', () => {
  const empty = mergeProfile(BASE_PROFILE, {rules: [{id: 'x', text: 'Anything.'}], examples: [], closing: {text: '', talk: ''}});
  const mature = buildMessages(args({profile: empty, mature: 'full'}));
  assert(mature[0].content.includes(matureLayer('full')), 'the Mature layer ends the head');
  assert(mature.at(-1).content.startsWith('[YOU, RIGHT NOW') || mature.at(-1).content.includes('V says:'));
  assert.match(mature.at(-1).content, /\(.+\)$/s, 'the Mature closing clause still ends the message');
  const guarded = buildMessages(args({profile: empty, guard: true}));
  assert(guarded[0].content.includes(guardLayer()));
  // A persona's own rules and an add-on's identity line are the persona's: a profile does not drop them.
  const addon = {...prompt.persona, identityRule: 'You are a prop and know it.', rules: ['Never say the word box.']};
  const head = systemHead({persona: addon, profile: empty});
  assert(head.includes('You are a prop and know it.') && head.includes('- Never say the word box.'));
  // The facts block is the caller's: the same world and right-now text under any rules.
  assert(mature[0].content.includes(prompt.contextParts.now.slice(0, 40)));
});

test('a profile\'s persona length and turns only shorten what the shipped limits allow', () => {
  const profile = mergeProfile(BASE_PROFILE, {limits: {persona: 3000, turns: 2}});
  assert.equal(limitsWith(profile, LIMITS).persona, 3000);
  assert.equal(limitsWith(profile, LIMITS).turns, 2);
  assert.equal(limitsWith(mergeProfile(BASE_PROFILE, {limits: {persona: 16000, turns: 11}}), {...LIMITS, persona: 5000, turns: 4}).persona, 5000);
  assert.equal(limitsWith(BASE_PROFILE, LIMITS), LIMITS, 'no limits of its own: the very same object');
  const short = systemHead({persona: prompt.persona, profile});
  assert(short.length < systemHead({persona: prompt.persona}).length + 1 && short.length <= 3000 + 2000 + 1500, 'the head is cut to the profile\'s persona length (plus the rules)');
});

// ---- Validation ----------------------------------------------------------------------------------------------------------------

test('validateOverride: a change equal to the default is not stored; null puts a field or a sub-field back; only the changed fields remain', () => {
  const d = BASE_PROFILE;
  assert.deepEqual(validateOverride({sampling: {temperature: 0.65}, rules: JSON.parse(JSON.stringify(d.rules))}, d), {ok: true, value: {}});
  const first = validateOverride({sampling: {temperature: 0.4, topP: 0.9}, closing: {text: 'Reply, {name}.'}}, d);
  assert.deepEqual(first, {ok: true, value: {sampling: {temperature: 0.4, topP: 0.9}, closing: {text: 'Reply, {name}.'}}});
  const second = validateOverride({sampling: {topP: null}}, d, first.value);
  assert.deepEqual(second.value, {sampling: {temperature: 0.4}, closing: {text: 'Reply, {name}.'}});
  assert.deepEqual(validateOverride({sampling: null, closing: null}, d, first.value).value, {});
  assert.deepEqual(validateOverride({sampling: {topP: 'off'}}, mergeProfile(d, {sampling: {topP: 0.9}})).value, {sampling: {topP: null}}, "'off' switches an optional field off where the default has one");
});

test('validateOverride: limits, types and unknown fields are refused with stable codes; nothing is partly applied', () => {
  const d = BASE_PROFILE;
  const code = (patch, expected, extra = {}) => {
    const result = validateOverride(patch, d);
    assert.equal(result.ok, false, JSON.stringify(patch).slice(0, 80));
    assert(result.errors.some(error => error.code === expected && Object.entries(extra).every(([key, value]) => error[key] === value)), `${expected}: ${JSON.stringify(result.errors)}`);
  };
  code('nope', 'bad-request');
  code({bogus: 1}, 'unknown-field');
  code({sampling: {nope: 1}}, 'unknown-field');
  code({sampling: {temperature: 3}}, 'out-of-range', {min: 0, max: 2});
  code({sampling: {temperature: '0.5'}}, 'out-of-range');
  code({sampling: {maxTokens: 12.5}}, 'out-of-range');
  code({sampling: {repeatPenalty: 0.5}}, 'out-of-range');
  code({sampling: {topP: 'off', temperature: 9}}, 'out-of-range');
  code({limits: {turns: 12}}, 'out-of-range');
  code({limits: {persona: 100}}, 'out-of-range');
  code({rules: []}, 'rules-few');
  code({rules: Array.from({length: 17}, (_, i) => `rule ${i}`)}, 'rules-many', {max: 16});
  code({rules: ['x'.repeat(2001)]}, 'rule-long', {max: 2000});
  code({rules: [{id: 'a', text: 'x'}, {id: 'a', text: 'y'}]}, 'rule-id-twice');
  code({rules: [{id: 'Bad Id', text: 'x'}]}, 'rule-id');
  code({rules: [{text: ''}]}, 'rule-empty');
  code({rules: [{text: 'x', unknown: 'y'}]}, 'unknown-field');
  code({rules: Array.from({length: 7}, (_, i) => ({id: `r${i}`, text: 'x'.repeat(1500)}))}, 'rules-total', {max: 9000});
  code({rules: 'be nice'}, 'bad-type');
  code({examples: ['x'.repeat(301)]}, 'examples-long', {max: 300});
  code({examples: Array.from({length: 9}, (_, i) => `line ${i}`)}, 'examples-many', {max: 8});
  code({examples: Array.from({length: 6}, (_, i) => `${i}`.repeat(290))}, 'examples-total');
  code({closing: {text: 'x'.repeat(701)}}, 'closing-long', {max: 700});
  code({labels: {rules: ''}}, 'empty');
  code({labels: {rules: 'x'.repeat(241)}}, 'labels-long', {max: 240});
  code({labels: {nope: 'x'}}, 'unknown-field');
  code({layout: {volatile: 'middle'}}, 'bad-value');
  code({layout: {youNow: 'yes'}}, 'bad-value');
  code({stop: ['a', 'b', 'c', 'd', 'e']}, 'stop-many', {max: 4});
  code({stop: ['x'.repeat(33)]}, 'stop-long', {max: 32});
  code({intro: {named: 'x'.repeat(601)}}, 'intro-long', {max: 600});
  // A bad field does not stop a good one from being checked, but the whole call is refused.
  assert.equal(validateOverride({sampling: {temperature: 0.5}, rules: []}, d).ok, false);
});

test('validateOverride: texts are tidied to one line, a stop string keeps its line break, a list drops repeats, rule shorthand gets ids', () => {
  const result = validateOverride({rules: ['  Be   short.\n', 'Be short.', {id: 'two', text: 'Second.', talk: 'Second, {words}.'}], stop: ['\nV says:', '\r\n\nV:', '   '], examples: ['A\u0000 b', 'a b']}, BASE_PROFILE);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.rules, [{id: 'rule-1', text: 'Be short.'}, {id: 'rule-2', text: 'Be short.'}, {id: 'two', text: 'Second.', talk: 'Second, {words}.'}]);
  assert.deepEqual(result.value.stop, ['\nV says:', '\n\nV:']);
  assert.deepEqual(result.value.examples, ['A b']);
});

test('readOverride keeps the valid parts of a damaged file and drops the rest (a hand-edited file never breaks a prompt)', () => {
  const kept = readOverride({version: 1, sampling: {temperature: 0.3, topP: 7, repeatPenalty: null}, rules: 'bad', closing: {text: 'Fine.', talk: 5}, labels: {nope: 'x', rules: 'RULES'}, layout: {volatile: 'after'}}, BASE_PROFILE);
  assert.deepEqual(kept, {sampling: {temperature: 0.3}, closing: {text: 'Fine.'}, labels: {rules: 'RULES'}, layout: {volatile: 'after'}});
  assert.deepEqual(readOverride(null, BASE_PROFILE), {});
  assert.deepEqual(readOverride([], BASE_PROFILE), {});
});

// ---- The store -------------------------------------------------------------------------------------------------------------------

test('set stores only the changed fields in <dir>/<profile>.json, the next resolve sees them without a restart, reset deletes the file', async () => {
  const dir = await temp();
  try {
    const profiles = await PromptProfiles.open({dir});
    const turn = {route: 'local', tier: 'lite'};
    const before = profiles.resolve(turn);
    const saved = await profiles.set('local-lite', {sampling: {temperature: 0.3}, closing: {text: 'Short, {name}.'}});
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.override, {sampling: {temperature: 0.3}, closing: {text: 'Short, {name}.'}});
    const after = profiles.resolve(turn);
    assert.notEqual(after, before);
    assert.equal(after.sampling.temperature, 0.3);
    assert.equal(after.sampling.maxTokens, before.sampling.maxTokens, 'a field the player did not change is the default');
    assert.equal(after.closing.talk, before.closing.talk);
    assert.equal(profiles.resolve(turn), after, 'memoized until the next change');
    assert.equal(profiles.getDefault('local-lite').sampling.temperature, before.sampling.temperature, 'the default is never touched');
    const files = await readdir(dir);
    assert.deepEqual(files, ['local-lite.json'], 'one file, no temp file left behind');
    const stored = JSON.parse(await readFile(join(dir, 'local-lite.json'), 'utf8'));
    assert.deepEqual(Object.keys(stored).sort(), ['closing', 'id', 'sampling', 'updated', 'version']);
    assert.deepEqual(stored.sampling, {temperature: 0.3});
    // A second process (the next session) reads it back.
    const again = await PromptProfiles.open({dir});
    assert.equal(again.resolve(turn).sampling.temperature, 0.3);
    // Reset one field, then everything.
    assert.equal((await profiles.reset('local-lite', 'closing')).ok, true);
    assert.equal(profiles.resolve(turn).closing.text, before.closing.text);
    assert.equal(profiles.resolve(turn).sampling.temperature, 0.3);
    assert.equal((await profiles.reset('local-lite')).override, null);
    assert.equal(profiles.resolve(turn), before === profiles.resolve(turn) ? before : profiles.getDefault('local-lite'));
    assert.deepEqual(await readdir(dir), []);
    assert.equal(sha(buildMessages(args({profile: profiles.resolve(turn)}))), sha(buildMessages(args({profile: before}))), 'reset: the prompt is the default again, byte for byte');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('set refuses what validate refuses and an id nobody knows; a refused save changes nothing', async () => {
  const dir = await temp();
  try {
    const profiles = await PromptProfiles.open({dir});
    const bad = await profiles.set('mistral', {sampling: {temperature: 5}});
    assert.equal(bad.ok, false);
    assert.equal(profiles.getOverride('mistral'), null);
    assert.deepEqual(await readdir(dir), []);
    assert.deepEqual((await profiles.set('nope', {sampling: {temperature: 0.2}})).errors, [{field: '', code: 'unknown-profile'}]);
    assert.deepEqual((await profiles.reset('nope')).errors, [{field: '', code: 'unknown-profile'}]);
    assert.deepEqual((await profiles.reset('mistral', 'bogus')).errors, [{field: 'bogus', code: 'unknown-field'}]);
    // A custom id that is not the configured endpoint's and has no file is not known either.
    assert.equal((await profiles.set('custom-other-model', {sampling: {temperature: 0.2}})).ok, false);
    // A write that fails leaves memory as it was.
    const failing = await PromptProfiles.open({dir, write: async () => { throw new Error('disk full'); }});
    await assert.rejects(failing.set('mistral', {sampling: {temperature: 0.2}}), /disk full/);
    assert.equal(failing.getOverride('mistral'), null);
    assert.equal((await failing.set('mistral', {sampling: {temperature: 0.2}}).catch(() => ({ok: false}))).ok, false, 'the chain goes on after a failed save');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('Custom profiles: one per configured endpoint and model, starting from the family default; an earlier endpoint with a saved change stays listed', async () => {
  const dir = await temp();
  try {
    let active = {route: 'custom', custom: {origin: 'https://openrouter.ai', model: 'qwen/qwen3-30b-a3b'}};
    const profiles = await PromptProfiles.open({dir, active: () => active});
    const id = customProfileId('https://openrouter.ai', 'qwen/qwen3-30b-a3b');
    const list = profiles.list();
    assert.deepEqual(list.filter(row => row.active).map(row => row.id), [id]);
    const row = list.find(item => item.id === id);
    assert.deepEqual([row.provider, row.models, row.family, row.host, row.changed], ['custom', 'qwen/qwen3-30b-a3b', 'qwen', 'openrouter.ai', false]);
    assert.deepEqual(list.filter(item => item.provider !== 'custom').map(item => item.id), [...BUILT_IN_IDS]);
    assert.equal(profiles.getDefault(id), defaultProfile(id, {family: 'qwen'}));
    assert.equal((await profiles.set(id, {sampling: {temperature: 0.3}})).ok, true);
    assert.equal(profiles.resolve(active).sampling.temperature, 0.3);
    // Another model: its own profile, from the generic family; the first is no longer active but is still listed, with its change.
    active = {route: 'custom', custom: {origin: 'http://127.0.0.1:1234', model: 'some-model'}};
    const second = customProfileId('http://127.0.0.1:1234', 'some-model');
    const next = profiles.list();
    assert.deepEqual(next.filter(item => item.active).map(item => item.id), [second]);
    assert.equal(next.find(item => item.id === id).changed, true);
    assert.equal(profiles.resolve(active).sampling.temperature, 0.65);
    assert.equal(profiles.getEffective(id).sampling.temperature, 0.3, 'the earlier endpoint\'s profile is still editable');
    // After a restart the earlier endpoint is remembered from its file.
    const reopened = await PromptProfiles.open({dir, active: () => active});
    assert(reopened.list().some(item => item.id === id && item.family === 'qwen' && item.changed));
    assert.equal(reopened.getEffective(id).sampling.temperature, 0.3);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('list marks the active built-in profile of the turn (a Mature turn on the Standard model is mature-standard), and `changed` follows the player\'s edits', async () => {
  const profiles = new PromptProfiles({active: () => ({route: 'local', tier: 'standard', mature: true})});
  assert.deepEqual(profiles.list().filter(row => row.active).map(row => row.id), ['mature-standard']);
  assert.deepEqual(profiles.list({route: 'mistral'}).filter(row => row.active).map(row => row.id), ['mistral']);
  assert.deepEqual(profiles.list({route: 'convai'}).filter(row => row.active), []);
  for (const row of profiles.list()) assert(row.id && row.label && row.provider && row.models, JSON.stringify(row));
  await profiles.set('mistral', {sampling: {temperature: 0.2}});
  assert.equal(profiles.list().find(row => row.id === 'mistral').changed, true);
});

test('a damaged file is skipped, kept as .corrupt before the next save, and a file with the wrong id or version is not used', async () => {
  const dir = await temp();
  try {
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, 'mistral.json'), '{not json');
    await writeFile(join(dir, 'local-lite.json'), JSON.stringify({version: 1, id: 'mistral', sampling: {temperature: 0.1}}));
    await writeFile(join(dir, 'mature-lite.json'), JSON.stringify({version: 2, id: 'mature-lite', sampling: {temperature: 0.1}}));
    await writeFile(join(dir, 'local-standard.json'), JSON.stringify({version: 1, id: 'local-standard', sampling: {temperature: 0.1, topP: 4}, rules: 'bad'}));
    await writeFile(join(dir, 'readme.txt'), 'x');
    const lines = [];
    const profiles = await PromptProfiles.open({dir, log: line => lines.push(line)});
    assert.equal(profiles.getOverride('mistral'), null);
    assert.equal(profiles.getOverride('local-lite'), null);
    assert.equal(profiles.getOverride('mature-lite'), null);
    assert.deepEqual(profiles.getOverride('local-standard'), {sampling: {temperature: 0.1}}, 'the valid part of a file is used');
    assert(lines.some(line => line.includes('mistral could not be read')));
    assert.equal(profiles.resolve({route: 'mistral'}).sampling.temperature, defaultProfile('mistral').sampling.temperature);
    assert.equal((await profiles.set('mistral', {sampling: {temperature: 0.2}})).ok, true);
    assert.equal(await readFile(join(dir, 'mistral.json.corrupt'), 'utf8'), '{not json');
    assert.equal(JSON.parse(await readFile(join(dir, 'mistral.json'), 'utf8')).sampling.temperature, 0.2);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('preview renders the rules, the closing and the examples of the effective profile for a sample speaker', async () => {
  const profiles = new PromptProfiles();
  const preview = profiles.preview('local-lite', {name: 'Panam', talkWords: 0, mature: false});
  assert(preview.rules.startsWith('OUTPUT RULES') && preview.rules.includes('You are Panam, talking out loud to V'));
  assert(preview.closing.startsWith('(Reply as Panam'));
  assert(profiles.preview('mistral').examples.startsWith('EXAMPLES OF A GOOD REPLY'), 'the Mistral profile ships three example replies');
  assert.equal(preview.examples, '');
  await profiles.set('local-lite', {examples: ['Fine.']});
  assert.equal(profiles.preview('local-lite').examples, 'EXAMPLES OF A GOOD REPLY (the shape only: never copy their words)\n- Fine.');
  assert.equal(profiles.preview('nope'), null);
});

test('profileSignature changes with any text of a profile and not with an equal copy', () => {
  assert.equal(profileSignature(BASE_PROFILE), profileSignature(mergeProfile(BASE_PROFILE, {})));
  assert.notEqual(profileSignature(BASE_PROFILE), profileSignature(mergeProfile(BASE_PROFILE, {sampling: {temperature: 0.5}})));
  assert.notEqual(sha(messagesFor(prompt, 'a')), sha(buildMessages(args({profile: mergeProfile(BASE_PROFILE, {closing: {text: 'x'}})}))));
});
