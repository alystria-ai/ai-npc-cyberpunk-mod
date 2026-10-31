import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {AddonHost, discoverAddons, validateManifest} from './addons.mjs';
import {AddonContent, CONTENT_LIMITS, validateContent} from './addon-content.mjs';
import {PromptProfiles} from './prompt-profile-store.mjs';
import {PersonaBook, systemHead, systemPrompt} from './mistral-prompt.mjs';
import {WorldRules, convaiWorldRulesBlocks} from './world-rules.mjs';
import {guardLayer} from './mature-content.mjs';
import {PromptingEditor} from './prompting-editor.mjs';
import {CharacterEditor} from './character-editor.mjs';

// Content packs (add-on API 1.1, bridge/addon-content.mjs): a manifest with `content` and nothing else changes how the characters talk.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const pack = (id, content, extra = {}) => ({id, name: `${id[0].toUpperCase()}${id.slice(1)} pack`, version: '1.0.0', requires: '1.1', content, ...extra});
const dirOf = id => `/mods/AiNpcCyberpunkMod${id[0].toUpperCase()}${id.slice(1)}`;
const hostOf = (...manifests) => new AddonHost({addons: manifests.map(value => validateManifest(value, dirOf(value.id)))});
const setSwitches = (host, values) => host.observeSettings(JSON.stringify({version: 1, addons: Object.fromEntries(Object.entries(values).map(([id, on]) => [id, {contentEnabled: on}]))}));
const logs = () => { const lines = []; return Object.assign(message => lines.push(message), {lines}); };
const MISTRAL = {route: 'mistral'}, LOCAL = {route: 'local', tier: 'standard', mature: false}, MATURE = {route: 'local', tier: 'standard', mature: true};
const CUSTOM = {route: 'custom', custom: {origin: 'http://127.0.0.1:1234', model: 'qwen-7b'}};
const bare = {name: 'Judy Alvarez', backstory: 'A braindance editor.', style: 'Dry.', samples: [], rules: [], memories: []};

test('the manifest of a content pack: the short form, the full form, and what is refused', () => {
  const short = validateManifest(pack('medieval', {worldRules: ['  People bow to lords.  ', ''], prompting: {'*': {closing: {text: 'Speak as {name}.'}}}}), dirOf('medieval'));
  assert.deepEqual(short.speakers, []);
  assert.equal(short.requires.api, '1.1');
  assert.deepEqual(short.content, {worldRules: ['People bow to lords.'], prompting: {'*': {closing: {text: 'Speak as {name}.'}}}, memory: 'shared'});
  const full = validateManifest({schema: 1, id: 'medieval', name: 'Medieval', version: '1.0.0', requires: {api: '1.1'}, speakers: [], content: {worldRules: ['One.']}}, dirOf('medieval'));
  assert.deepEqual(full.content, {worldRules: ['One.'], prompting: {}, memory: 'shared'});
  assert.equal(validateManifest({schema: 1, id: 'plain', name: 'Plain', version: '1.0.0', requires: {api: '1.0'}, speakers: []}, '/x').content, undefined, 'an add-on without content has none');

  const bad = (value, pattern) => assert.throws(() => validateManifest(value, dirOf('medieval')), pattern);
  bad(pack('medieval', {worldRules: 'text'}), /worldRules must be a list/);
  bad(pack('medieval', {worldRules: [5]}), /worldRules\[0\] must be a text/);
  bad(pack('medieval', {worldRules: ['x'.repeat(CONTENT_LIMITS.ruleText + 1)]}), /longer than 600/);
  bad(pack('medieval', {worldRules: Array.from({length: 25}, (_, index) => `Rule ${index}.`)}), /more than 24 lines/);
  bad(pack('medieval', {worldRules: Array.from({length: 8}, (_, index) => `${index}`.repeat(550))}), /characters in all/);
  bad(pack('medieval', {extra: 1}), /content\.extra is not a known field/);
  bad(pack('medieval', {characters: 5}), /must be an object of profile keys/);
  bad(pack('medieval', 'text'), /content must be an object/);
  bad(pack('medieval', {prompting: {nonsense: {closing: {text: 'x'}}}}), /not a profile id/);
  bad(pack('medieval', {prompting: {'*': {closing: {text: 'x'.repeat(701)}}}}), /content\.prompting\.\*: closing\.text is not valid \(closing-long\)/);
  bad(pack('medieval', {prompting: {'*': {rules: []}}}), /rules is not valid \(rules-few\)/);
  bad(pack('medieval', {prompting: {'*': {sampling: {temperature: 9}}}}), /sampling\.temperature is not valid \(out-of-range\)/);
  bad(pack('medieval', {prompting: {'*': {unknownField: 1}}}), /unknownField is not valid \(unknown-field\)/);
  bad(pack('medieval', {worldRules: ['x'], filler: 'y'.repeat(41000)}), /content\.filler is not a known field/);
  bad(pack('medieval', {prompting: Object.fromEntries(Array.from({length: 13}, (_, index) => [`custom-host-model-${index}`, {closing: {text: 'x'}}]))}), /more than 12 profiles/);
  bad({...pack('medieval', {worldRules: ['One.']}), requires: '1.0'}, /content needs requires\.api "1\.1" or higher/);
  bad({...pack('medieval', {worldRules: ['One.']}), requires: {api: '1.0'}}, /content needs requires\.api "1\.1" or higher/);
  bad({...pack('medieval', {worldRules: ['One.']}), schema: 2}, /schema must be 1/);
  bad({id: 'plain', name: 'Plain', version: '1.0.0', requires: '1.0', speakers: []}, /schema must be 1/);
  bad({schema: 1, id: 'plain', name: 'Plain', version: '1.0.0', requires: '1.0', speakers: []}, /requires\.api/);
  bad({schema: 1, id: 'plain', name: 'Plain', version: '1.0.0', requires: {api: '1.0'}}, /speakers must be a list/);
  // A pack written for a newer API is judged by that API, not by this version's content rules.
  assert.equal(validateManifest(pack('future', {anythingNew: true}, {requires: '1.2'}), '/x').content, undefined);
  // The same checks as a player's edit: the profile ids are the shipped ones, a Custom id, or "*".
  assert.deepEqual(Object.keys(validateContent({prompting: {mistral: {closing: {text: 'a'}}, 'local-lite': {closing: {text: 'b'}}, 'custom-127-0-0-1-1234-qwen-7b': {closing: {text: 'c'}}}}).prompting).sort(),
    ['custom-127-0-0-1-1234-qwen-7b', 'local-lite', 'mistral']);
  // A value equal to a shipped default is kept (the pack may mean it for the profiles where it differs).
  assert.deepEqual(validateContent({prompting: {'*': {sampling: {temperature: 0.5}}}}).prompting, {'*': {sampling: {temperature: 0.5}}});
});

test('the whole content object is capped', () => {
  const fat = {worldRules: Array.from({length: 24}, () => 'w'.repeat(160)),
    prompting: Object.fromEntries(['*', 'mistral', 'local-lite', 'local-standard', 'mature-lite', 'mature-standard'].map((key, index) => [key,
      {rules: Array.from({length: 16}, (_, rule) => ({id: `r${rule}`, text: `${index}`.repeat(2000), talk: `${index}`.repeat(1900)}))}]))};
  assert.throws(() => validateContent(fat), /rules is not valid \(rules-total\)|larger than 40000/);
  // Under each field's own caps but over the whole: six profiles of nine thousand characters of rules.
  const wide = {prompting: Object.fromEntries(['*', 'mistral', 'local-lite', 'local-standard', 'mature-lite', 'mature-standard'].map((key, index) => [key,
    {rules: Array.from({length: 5}, (_, rule) => ({id: `r${rule}`, text: `${index}`.repeat(1800)}))}]))};
  assert.throws(() => validateContent(wide), /larger than 40000 characters/);
});

test('discovery: a folder with only the manifest is found; an invalid or too-new pack is skipped with one clear reason; old add-ons load beside it', async () => {
  const mods = await mkdtemp(resolve(tmpdir(), 'convai-content-'));
  try {
    const put = async (name, value) => { const dir = resolve(mods, name); await mkdir(dir, {recursive: true}); await writeFile(resolve(dir, 'convai-addon.json'), JSON.stringify(value)); return dir; };
    await put('AiNpcCyberpunkModMedieval', pack('medieval', {worldRules: ['People bow to lords.']}));
    await put('AiNpcCyberpunkModBroken', pack('broken', {worldRules: [3]}));
    await put('AiNpcCyberpunkModFuture', {schema: 1, id: 'future', name: 'Future', version: '1.0.0', requires: {api: '1.2'}, speakers: [], content: {fresh: true}});
    await put('AiNpcCyberpunkModSkippy', {schema: 1, id: 'skippy', name: 'Skippy', version: '1.0.0', requires: {api: '1.0'},
      speakers: [{id: 'gun', name: 'Skippy', persona: {backstory: 'A smart pistol.'}}]});
    const {addons, problems} = await discoverAddons({roots: [{path: mods, children: true}]});
    assert.deepEqual(addons.map(addon => addon.id).sort(), ['medieval', 'skippy']);
    assert.equal(addons.find(addon => addon.id === 'skippy').content, undefined);
    assert.deepEqual(problems.map(item => [item.id, item.status]).sort(), [['broken', 'invalid'], ['future', 'incompatible']]);
    assert.match(problems.find(item => item.id === 'broken').reason, /^content\.worldRules\[0\] must be a text$/);
    // An old main mod (API 1.0) reads the same pack (its content is not judged): it says plainly that the pack needs a newer mod.
    const old = await discoverAddons({roots: [{path: mods, children: true}], version: '1.0'});
    assert.deepEqual(old.addons.map(addon => addon.id), ['skippy']);
    const medieval = old.problems.find(item => item.id === 'medieval');
    assert.equal(medieval.status, 'incompatible');
    assert.equal(medieval.reason, 'needs add-on API 1.1; this AI NPC Cyberpunk Mod has 1.0');
    // The host publishes the packs for the game's settings page and the notices for the ones that did not load.
    const host = new AddonHost({addons, problems});
    const status = host.status();
    assert.deepEqual(status.addons.find(item => item.id === 'medieval'), {id: 'medieval', name: 'Medieval pack', version: '1.0.0', status: 'ready', content: {worldRules: 1, prompting: []}, speakers: []});
    assert.equal(status.addons.find(item => item.id === 'skippy').content, undefined);
    assert.equal(status.addons.find(item => item.id === 'broken').status, 'invalid');
    assert.equal(host.hasSpeakers, true);
    assert.equal(hostOf(pack('medieval', {worldRules: ['x']})).hasSpeakers, false);
  } finally { await rm(mods, {recursive: true, force: true}); }
});

test('a pack-only host is active for the settings file but watches no state file and keeps no stock', () => {
  const host = hostOf(pack('medieval', {worldRules: ['x']}));
  assert.equal(host.active, true);
  assert.equal(host.stock, null);
  assert.deepEqual(Object.keys(host.watchHandlers('/runtime')), ['addon-settings.json']);
  const withSpeaker = new AddonHost({addons: [validateManifest({schema: 1, id: 'skippy', name: 'Skippy', version: '1.0.0', requires: {api: '1.0'},
    speakers: [{id: 'gun', name: 'Skippy', persona: {backstory: 'A gun.'}}]}, '/x')]});
  assert.deepEqual(Object.keys(withSpeaker.watchHandlers('/runtime')).sort(), ['addon-settings.json', 'addon-state.json']);
});

test('precedence: the shipped profile, then the packs (folder order, a later one wins per field, a specific id beats "*"), then the player\'s own change', async () => {
  const a = pack('alpha', {prompting: {'*': {sampling: {temperature: 0.9}, closing: {text: 'A closes {name}.'}}, mistral: {sampling: {temperature: 0.7}}}});
  const b = pack('beta', {prompting: {'*': {closing: {text: 'B closes {name}.'}, intro: {named: 'B opens {name}.'}}}});
  const content = new AddonContent({host: hostOf(b, a)});       // handed in the wrong order on purpose
  const store = new PromptProfiles({packs: content});
  const shipped = new PromptProfiles();
  const mistral = store.resolve(MISTRAL), local = store.resolve(LOCAL);
  assert.equal(shipped.resolve(MISTRAL).sampling.temperature, 0.5);
  assert.equal(mistral.sampling.temperature, 0.7, 'the specific profile beats "*" inside a pack');
  assert.equal(local.sampling.temperature, 0.9, '"*" reaches every profile');
  assert.equal(mistral.closing.text, 'B closes {name}.', 'beta comes after alpha: its closing wins');
  assert.equal(local.closing.text, 'B closes {name}.');
  assert.equal(local.intro.named, 'B opens {name}.');
  assert.deepEqual(mistral.rules, shipped.resolve(MISTRAL).rules, 'a field no pack names stays the shipped one');
  assert.equal(store.resolve(CUSTOM).sampling.temperature, 0.9, 'a Custom profile gets "*"');
  assert.equal(store.resolve(MATURE).sampling.temperature, 0.9);
  assert.equal(store.resolve(MISTRAL), mistral, 'the same object on every turn: the prompt is byte-stable');
  assert.equal(store.getBase('mistral').sampling.temperature, 0.7);
  assert.deepEqual(shipped.getDefault('mistral'), store.getDefault('mistral'), 'the shipped default stays shown as it is');
  assert.deepEqual(store.list().find(row => row.id === 'mistral').packs, ['Alpha pack', 'Beta pack']);
  // The player's change is laid over the packs. A value equal to the shipped default but not to the pack's is a real change and is kept; one equal to the pack's is no change.
  const kept = await store.set('mistral', {sampling: {temperature: 0.5}});
  assert.equal(kept.ok, true);
  assert.deepEqual(kept.override, {sampling: {temperature: 0.5}});
  assert.equal(store.resolve(MISTRAL).sampling.temperature, 0.5, 'the player wins over the pack');
  assert.equal(store.resolve(MISTRAL).closing.text, 'B closes {name}.', 'what the player did not change stays the pack\'s');
  const same = await store.set('mistral', {sampling: {temperature: 0.7}});
  assert.equal(same.override, null, 'a value equal to the pack\'s is dropped');
  assert.equal(store.resolve(MISTRAL).sampling.temperature, 0.7);
  await store.set('mistral', {closing: {text: 'Mine {name}.'}});
  assert.equal(store.resolve(MISTRAL).closing.text, 'Mine {name}.');
  const reset = await store.reset('mistral', 'closing');
  assert.equal(reset.profile.closing.text, 'B closes {name}.', 'Reset to default returns to the pack\'s wording');
  assert.equal((await store.reset('mistral')).override, null);
});

test('providers: Convai is never given a prompt profile, Mistral, Local AI and Custom are, and the guard stays last in the head', () => {
  const content = new AddonContent({host: hostOf(pack('medieval', {prompting: {'*': {closing: {text: 'Speak as {name}, medieval.'}, rules: [{id: 'old', text: 'Speak in old words.'}]}}}))});
  const store = new PromptProfiles({packs: content});
  assert.equal(store.resolve({route: 'convai'}), null, 'Convai\'s prompting lives on Convai\'s side');
  for (const turn of [MISTRAL, LOCAL, MATURE, CUSTOM, {route: 'local', tier: 'lite'}]) assert.equal(store.resolve(turn).closing.text, 'Speak as {name}, medieval.', JSON.stringify(turn));
  const plain = new PromptProfiles();
  // The head with the pack: the rules are the pack's, and the hard limits (guard) come after them, word for word the same as without the pack.
  const withPack = systemHead({persona: bare, guard: true, profile: store.resolve(MISTRAL)});
  const without = systemHead({persona: bare, guard: true, profile: plain.resolve(MISTRAL)});
  assert.match(withPack, /Speak in old words\./);
  assert.doesNotMatch(without, /Speak in old words\./);
  assert.ok(withPack.endsWith(guardLayer()) && without.endsWith(guardLayer()), 'the guard is appended last, untouched');
  // The facts of the game are not part of a profile: the same context gives the same world block with and without the pack.
  const layers = {notes: 'Notes.', world: 'World facts.', now: 'Right now facts.'};
  const tail = prompt => prompt.slice(prompt.indexOf('World facts.'));
  assert.equal(tail(systemPrompt({persona: bare, layers, profile: store.resolve(MISTRAL)})), tail(systemPrompt({persona: bare, layers, profile: plain.resolve(MISTRAL)})));
});

test('a switch: off gives the very prompt of no pack, on brings it back, and the change is announced once', () => {
  const medieval = pack('medieval', {worldRules: ['People bow to lords.'], prompting: {mistral: {closing: {text: 'Speak as {name}, a medieval person.'}}}});
  const host = hostOf(medieval), lines = logs();
  const content = new AddonContent({host, log: lines});
  const store = new PromptProfiles({packs: content});
  const shipped = new PromptProfiles();
  const promptWith = (profiles, rules) => systemPrompt({persona: rules ? {...bare, worldRules: rules} : bare, profile: profiles.resolve(MISTRAL)});
  const on = promptWith(store, content.worldRulesText(''));
  assert.match(on, /People bow to lords\./);
  assert.match(store.resolve(MISTRAL).closing.text, /medieval person/);
  let changes = 0;
  content.onChanged = () => { changes++; };
  setSwitches(host, {medieval: false});
  assert.equal(changes, 1);
  assert.deepEqual(lines.lines, ['Content pack medieval is off']);
  const off = promptWith(store, content.worldRulesText(''));
  assert.equal(off, promptWith(shipped, ''), 'switched off: byte for byte the prompt of no pack');
  assert.deepEqual(store.resolve(MISTRAL), shipped.resolve(MISTRAL), 'and the same profile');
  setSwitches(host, {medieval: false});
  assert.equal(changes, 1, 'the same value again changes nothing');
  setSwitches(host, {medieval: true});
  assert.equal(changes, 2);
  assert.equal(promptWith(store, content.worldRulesText('')), on, 'back on: the same prompt as before');
  host.observeSettings('{"version":1,"addons":{}}');                // no saved value: on by default
  assert.equal(content.enabled('medieval'), true);
  assert.equal(changes, 2);
});

test('world rules: the player\'s text first, then each pack\'s lines, the same string between changes; Convai gets them too, trimmed to a budget, and loses them when the pack is off', () => {
  const host = hostOf(pack('beta', {worldRules: ['Beta fact one.']}), pack('alpha', {worldRules: ['Alpha fact one.', 'Alpha fact two.']}));
  const lines = logs();
  const content = new AddonContent({host, log: lines});
  const mine = 'Everyone speaks casually.';
  const text = content.worldRulesText(mine);
  assert.equal(text, `${mine}\n- Alpha fact one.\n- Alpha fact two.\n- Beta fact one.`, 'folder order, after the player\'s');
  assert.equal(content.worldRulesText(mine), text);
  assert.equal(content.worldRulesText(''), '- Alpha fact one.\n- Alpha fact two.\n- Beta fact one.');
  // The persona book reads it through the view and carries it as the persona's world rules.
  const store = {get: () => mine};
  const book = new PersonaBook([{key: 'judy-alvarez', name: 'Judy', backstory: 'Editor.'}], {worldRules: content.worldRulesView(store)});
  assert.equal(book.persona('judy-alvarez').worldRules, text);
  assert.match(systemPrompt({persona: book.persona('judy-alvarez')}), /WORLD RULES[^\n]*\nEveryone speaks casually\.\n- Alpha fact one\./);
  // The editor lists them read-only.
  assert.deepEqual(content.worldRulesList().map(item => [item.id, item.rules.length]), [['alpha', 2], ['beta', 1]]);
  // Convai: the same words in the dynamic info context, after the player's.
  const convai = rules => convaiWorldRulesBlocks(content.convaiWorldRulesText(rules), false);
  assert.equal(convai(mine).length, 1);
  assert.equal(convai(mine)[0].tier, 'convai');
  assert.match(convai(mine)[0].text, /Everyone speaks casually\.\n- Alpha fact one\.\n- Alpha fact two\.\n- Beta fact one\.$/);
  assert.equal(convai('')[0].text.includes('Alpha fact one.'), true, 'with no rules of the player\'s own the packs still reach Convai');
  assert.deepEqual(convaiWorldRulesBlocks(content.convaiWorldRulesText(mine), true), [], 'while a text provider answers the persona carries them instead');
  setSwitches(host, {alpha: false});
  assert.equal(content.worldRulesText(mine), `${mine}\n- Beta fact one.`);
  assert.doesNotMatch(convai(mine)[0].text, /Alpha/);
  setSwitches(host, {alpha: false, beta: false});
  assert.equal(content.worldRulesText(mine), mine);
  assert.deepEqual(convai(mine), convaiWorldRulesBlocks(mine, false), 'both off: exactly what Convai got without any pack');
  assert.deepEqual(convai(''), [], 'no rules at all: no block');
  assert.deepEqual(content.worldRulesList(), []);
  // The Convai text keeps the player's rules whole and leaves a pack's lines out when the whole would pass its size; one log line says so.
  const big = pack('big', {worldRules: Array.from({length: 6}, (_, index) => String.fromCharCode(65 + index).repeat(580))});
  const crowded = new AddonContent({host: hostOf(big), log: lines});
  const player = 'p'.repeat(2000);
  const sent = crowded.convaiWorldRulesText(player);
  assert.ok(sent.startsWith(player + '\n'), 'the player\'s rules stay whole');
  assert.ok(Array.from(sent).length <= CONTENT_LIMITS.convaiRules, Array.from(sent).length);
  assert.ok(sent.includes('- AAAA') && sent.includes('CCCC') && !sent.includes('DDDD'), 'the lines that fit stay in order, the rest is left out');
  crowded.convaiWorldRulesText(player);
  assert.equal(lines.lines.filter(line => /Convai's world rules hold 4000 characters/.test(line)).length, 1, 'one log line');
  assert.equal(crowded.worldRulesText(player).includes('FFFF'), true, 'the text providers carry all of them');
});

test('the rules of all the packs together are bounded, a later pack\'s lines that do not fit are left out with one log line', () => {
  const heavy = id => pack(id, {worldRules: Array.from({length: 7}, (_, index) => `${id}${index}`.padEnd(560, 'x'))});
  const lines = logs();
  const content = new AddonContent({host: hostOf(heavy('aaa'), heavy('bbb')), log: lines});
  const text = content.worldRulesText('');
  assert.ok(Array.from(text).length <= CONTENT_LIMITS.combinedRules + 7 * 3 * 2, Array.from(text).length);
  assert.ok(text.includes('aaa6') && text.includes('bbb2') && !text.includes('bbb6'));
  content.worldRulesText('x');
  assert.equal(lines.lines.filter(line => /longer than 6000 characters together/.test(line)).length, 1);
});

test('with no add-on, or none with content, nothing changes: the same profile objects and the same strings', () => {
  const empty = new AddonContent({host: new AddonHost()});
  assert.equal(empty.installed, false);
  assert.equal(empty.layerFor('mistral'), null);
  assert.equal(empty.worldRulesText('abc'), 'abc');
  assert.equal(empty.convaiWorldRulesText('abc'), 'abc');
  assert.deepEqual(empty.worldRulesList(), []);
  const speakerOnly = new AddonContent({host: new AddonHost({addons: [validateManifest({schema: 1, id: 'skippy', name: 'Skippy', version: '1.0.0', requires: {api: '1.0'}, speakers: [{id: 'gun', name: 'S', persona: {backstory: 'x'}}]}, '/x')]})});
  assert.equal(speakerOnly.installed, false);
  const plain = new PromptProfiles(), linked = new PromptProfiles({packs: empty});
  assert.deepEqual(linked.resolve(MISTRAL), plain.resolve(MISTRAL));
  assert.equal(linked.resolve(MISTRAL), linked.resolve(MISTRAL));
  assert.deepEqual(linked.list(), plain.list(), 'no `packs` field appears in the editor\'s list');
  const bridge = read('./convai-bridge.mjs');
  assert.match(bridge, /worldRules: addonContent\.installed \? addonContent\.worldRulesView\(worldRules\) : worldRules, topics: talkRetrievalOn\}\);/, 'without a pack the persona book reads the player\'s store itself');
  assert.match(bridge, /packs: addonContent\.installed \? addonContent : null,/);
  assert.match(bridge, /\.\.\.convaiWorldRulesBlocks\(addonContent\.convaiWorldRulesText\(worldRules\.get\(\)\), mistral\.active\),/, 'Convai\'s dynamic info carries the packs\' rules after the player\'s');
  assert.match(bridge, /addonContent: addonContent\.installed \? addonContent : null,/);
  assert.match(bridge, /addonContent\.onChanged = \(\) => \{ dropPrefetch\(\); prefetchObserved = ''; \};/);
});

test('the editor: the effective profile (preview included) has the pack, the page is told which packs change it, and the world rules page lists the pack\'s rules read-only', async () => {
  const host = hostOf(pack('medieval', {worldRules: ['People bow to lords.'], prompting: {mistral: {closing: {text: 'Speak as {name}, medieval.'}}}}));
  const content = new AddonContent({host});
  const store = new PromptProfiles({packs: content});
  const editor = new PromptingEditor({profiles: store});
  const details = editor.details('mistral');
  assert.deepEqual(details.packs, ['Medieval pack']);
  assert.equal(details.effective.closing.text, 'Speak as {name}, medieval.');
  assert.notEqual(details.default.closing.text, 'Speak as {name}, medieval.', 'the shipped default is still the shipped one');
  assert.match(editor.preview('mistral').closing, /Speak as Judy, medieval\./);
  // A preview of unsaved edits is laid over the pack's wording, not over the shipped one.
  assert.match(editor.preview('mistral', {}, {sampling: {temperature: 0.3}}).closing, /Speak as Judy, medieval\./);
  assert.equal(editor.details('local-lite').packs, undefined, 'a profile no pack changes carries no note');
  assert.deepEqual(editor.validate('mistral', {closing: {text: 'Mine.'}}), {ok: true, fields: ['closing']});
  await editor.set('mistral', {closing: {text: 'Mine {name}.'}});
  assert.equal(editor.details('mistral').effective.closing.text, 'Mine {name}.');
  assert.equal((await editor.reset('mistral', 'closing')).effective.closing.text, 'Speak as {name}, medieval.');
  setSwitches(host, {medieval: false});
  assert.equal(editor.details('mistral').packs, undefined);
  assert.equal(editor.details('mistral').effective.closing.text, editor.details('mistral').default.closing.text);
  setSwitches(host, {medieval: true});
  const worldRules = await WorldRules.open({});
  await worldRules.set('Mine.');
  const characters = new CharacterEditor({personas: new PersonaBook([]), overrides: {}, worldRules, addonContent: content});
  assert.deepEqual(characters.worldRulesForPage, {text: 'Mine.', limit: 2000, packs: [{id: 'medieval', name: 'Medieval pack', rules: ['People bow to lords.']}]});
  assert.equal(new CharacterEditor({personas: new PersonaBook([]), overrides: {}, worldRules}).worldRulesForPage.packs, undefined);
  // The page shows both (a source check of the two places).
  const page = read('./character-editor-page.mjs');
  assert.match(page, /T\('From the content pack \{name\}', \{name: pack\.name\}\)/);
  assert.match(page, /readonly: true\}, pack\.rules\.join/);
  assert.match(page, /T\('Content packs that change this prompt: \{names\}\./);
});
