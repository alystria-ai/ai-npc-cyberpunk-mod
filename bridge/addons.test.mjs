import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, stat} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {ADDON_API_VERSION, ADDON_ENV, ADDON_PROVIDERS, AddonHost, CET_MODS, LOCAL_REMARK_GAP_S, addonRoots, apiCompatible, discoverAddons, fixedProvider,
  inspectReference, isAddonProfile, isNearDuplicate, lineSimilarity, parseAddonInput, parseAddonReaction, parseAddonSettings,
  parseAddonState, parseApiVersion, sampleLine, sharedMemory, speakerProfileKey, validateManifest} from './addons.mjs';
import {parseInput} from './protocol.mjs';
import {PersonaBook, systemHead} from './mistral-prompt.mjs';
import {TextProviderHost, mistralRoute} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';

// Line endings normalised: a Windows checkout (core.autocrlf) has CRLF, and the source checks below match on \n.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function manifest(overrides = {}) {
  return {schema: 1, id: 'skippy', name: 'Skippy', version: '1.0.0', requires: {api: '1.0'},
    speakers: [{id: 'gun', name: 'Skippy', persona: {backstory: 'A smart pistol with opinions.', style: 'Chirpy.',
      samples: ['V: Hi.\nSkippy: Hiya, boss!'], intro: 'You are Skippy, a talking smart pistol.', identityRule: 'You are a gun, not a person.',
      rules: ['Never ask a question during combat.']}}], ...overrides};
}

function wav(seconds = 0.5, rate = 16000) {
  const samples = Math.round(seconds * rate), data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function folder() { return mkdtemp(resolve(tmpdir(), 'convai-addons-')); }

async function addonFolder(root, name, value) {
  const dir = resolve(root, name);
  await mkdir(dir, {recursive: true});
  await writeFile(resolve(dir, 'convai-addon.json'), typeof value === 'string' ? value : JSON.stringify(value));
  return dir;
}

test('API versions: same major and an equal or lower minor are compatible', () => {
  assert.equal(ADDON_API_VERSION, '1.0');
  assert.deepEqual(parseApiVersion('1.0'), {major: 1, minor: 0});
  assert.equal(parseApiVersion('1'), null);
  assert.equal(apiCompatible('1.0', '1.0'), true);
  assert.equal(apiCompatible('1.0', '1.3'), true);
  assert.equal(apiCompatible('1.2', '1.0'), false, 'an add-on written for 1.2 needs a newer main mod');
  assert.equal(apiCompatible('2.0', '1.9'), false);
  assert.equal(apiCompatible('0.9', '1.0'), false);
  assert.equal(apiCompatible('x', '1.0'), false);
  assert.equal(speakerProfileKey('skippy', 'gun'), 'addon-skippy-gun');
  assert.equal(isAddonProfile('addon-skippy-gun'), true);
  assert.equal(isAddonProfile('judy-alvarez'), false);
});

test('manifest validation names what is wrong and keeps paths inside the add-on folder', () => {
  const dir = resolve(tmpdir(), 'addon-x');
  const valid = validateManifest(manifest({bridge: 'bridge.mjs'}), dir);
  assert.equal(valid.speakers[0].profileKey, 'addon-skippy-gun');
  assert.equal(valid.bridge, resolve(dir, 'bridge.mjs'));
  assert.equal(valid.speakers[0].voice, null);
  const bad = [
    [{schema: 2}, /schema/], [{id: 'Skippy'}, /id must/], [{id: 'a'}, /id must/], [{name: ''}, /name/], [{version: 'one'}, /version/],
    [{requires: {api: 'latest'}}, /requires\.api/], [{bridge: '../evil.mjs'}, /bridge/], [{bridge: 'C:/evil.mjs'}, /bridge/],
    [{bridge: 'bridge.py'}, /bridge/], [{speakers: 'gun'}, /speakers/],
    [{speakers: [1, 2, 3, 4, 5].map(n => ({id: `s${n}`, name: 'S', persona: {backstory: 'x'}}))}, /at most 4/],
    [{speakers: [{id: 'gun', name: 'A', persona: {backstory: 'x'}}, {id: 'gun', name: 'B', persona: {backstory: 'x'}}]}, /twice/],
    [{speakers: [{id: 'gun', name: 'A', persona: {}}]}, /backstory/],
    [{speakers: [{id: 'gun', name: 'A', persona: {backstory: 'x'}, voice: {reference: 'voice.mp3', transcript: 'hi'}}]}, /\.wav/],
    [{speakers: [{id: 'gun', name: 'A', persona: {backstory: 'x'}, voice: {reference: '../v.wav', transcript: 'hi'}}]}, /\.wav/],
    [{speakers: [{id: 'gun', name: 'A', persona: {backstory: 'x'}, voice: {reference: 'v.wav'}}]}, /transcript/],
    [{speakers: [{id: 'gun', name: 'A', persona: {backstory: 'x'}, convai: {characterId: 'abcd-1234-efgh'}}]}, /Mistral or the local AI only/],
    [{providers: ['convai']}, /never use Convai/], [{providers: []}, /providers/], [{providers: ['mistral', 'mistral']}, /providers/],
    [{speakers: [{id: 'gun', name: 'A', persona: {backstory: 'x'}, providers: ['groq']}]}, /never use Convai/],
    [{speakers: [{id: 'gun', name: 'A', persona: {backstory: 'x'}, modes: {Killer: {name: 'K'}}}]}, /mode id/],
    [{speakers: [{id: 'gun', name: 'A', persona: {backstory: 'x'}, modes: {killer: {}}}]}, /needs a name/],
    [{speakers: [{id: 'gun', name: 'A', persona: {backstory: 'x'}, modes: {killer: {name: 'K'}}, defaultMode: 'puppy'}]}, /defaultMode/],
  ];
  for (const [change, pattern] of bad) assert.throws(() => validateManifest(manifest(change), dir), pattern, JSON.stringify(change));
  assert.throws(() => validateManifest([], dir), /object/);
});

test('discovery: the CET mods folder one level deep plus the environment list; bad add-ons are reported, never thrown', async () => {
  const game = await folder();
  const mods = resolve(game, CET_MODS);
  try {
    await addonFolder(mods, 'CyberpunkConvaiSkippy', manifest());
    await addonFolder(mods, 'Broken', '{not json');
    await addonFolder(mods, 'TooNew', manifest({id: 'future', name: 'Future', requires: {api: '1.9'}}));
    await addonFolder(mods, 'Twin', manifest({name: 'Second Skippy'}));
    await mkdir(resolve(mods, 'SomeOtherMod'), {recursive: true});
    const extra = await addonFolder(game, 'dev-addon', manifest({id: 'delamain', name: 'Delamain'}));
    const roots = addonRoots({game, environment: {[ADDON_ENV]: ` ${extra} ;`}});
    assert.deepEqual(roots.map(root => root.children), [true, false]);
    const {addons, problems} = await discoverAddons({roots});
    assert.deepEqual(addons.map(addon => addon.id).sort(), ['delamain', 'skippy']);
    const byFolder = Object.fromEntries(problems.map(problem => [problem.dir.split(/[\\/]/).pop(), problem]));
    assert.equal(byFolder.Broken.status, 'invalid');
    assert.equal(byFolder.TooNew.status, 'incompatible');
    assert.match(byFolder.TooNew.reason, /needs add-on API 1\.9; this Cyberpunk Convai has 1\.0/);
    assert.equal(byFolder.Twin.status, 'duplicate');
    assert.equal(byFolder.SomeOtherMod, undefined, 'a mod folder without a manifest is not an add-on');
    const host = await AddonHost.load({game, environment: {[ADDON_ENV]: extra}});
    assert.equal(host.active, true);
    assert.deepEqual(host.status().addons.map(entry => entry.status).sort(), ['duplicate', 'incompatible', 'invalid', 'ready', 'ready']);
  } finally { await rm(game, {recursive: true, force: true}); }
});

test('without add-ons the host is inert: no rows, ids, blocks, files, timers or changed paths', async () => {
  const runtime = await folder();
  try {
    const host = await AddonHost.load({game: resolve(runtime, 'no-game-here'), environment: {}});
    assert.equal(host.active, false);
    const roster = [{key: 'judy-alvarez', name: 'Judy'}], ids = {'judy-alvarez': 'abc'};
    const before = JSON.stringify([roster, ids]);
    host.extend(roster, ids);
    assert.equal(JSON.stringify([roster, ids]), before);
    assert.deepEqual(host.blocks({profileKey: 'judy-alvarez', text: 'hi'}), []);
    assert.deepEqual(host.watchHandlers(runtime), {});
    const paths = {pocket: 'a.json', omni: {short: 'b.json'}, warnings: []};
    assert.equal(await host.voiceConfigPaths(paths, {stateDirectory: runtime}), paths, 'the very same object comes back');
    assert.equal(host.trigger({profileKey: 'judy-alvarez', text: 'Combat has begun.'}), 'Combat has begun.');
    // A status file an earlier run left (an add-on since uninstalled) is removed, and nothing is written.
    await writeFile(resolve(runtime, 'addons-status.json'), '{}');
    assert.equal(await host.publishStatus(runtime), false);
    await assert.rejects(stat(resolve(runtime, 'addons-status.json')), {code: 'ENOENT'});
    host.observeState(JSON.stringify({version: 1, updated: Date.now(), addons: {x: {companionContext: [{key: 'k', text: 'cab'}]}}}));
    assert.deepEqual(host.blocks({profileKey: 'judy-alvarez'}), [], 'an inactive host ignores a stray state file');
  } finally { await rm(runtime, {recursive: true, force: true}); }
});

test('the bridge only touches add-ons through the host, and every touch is a no-op without one', () => {
  const bridge = read('./convai-bridge.mjs');
  const uses = [...bridge.matchAll(/addonHost\.(\w+)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(uses)].sort(), ['active', 'afterReply', 'beginTurn', 'blocks', 'characterLookup', 'extend', 'isSpeaker', 'loadJournal',
    'localPace', 'modeOf', 'onStock', 'onWarm', 'produce', 'providerNotice', 'publishStatus', 'remarkRefunded', 'remarkStarted', 'routeFor', 'speakers', 'stock',
    'trigger', 'usesVoiceContext', 'voiceConfigPaths', 'watchHandlers']);
  // A remark on the local AI inside its default pace is answered at once with addon-pace, before any text request.
  assert.match(bridge, /const pace = remark \? addonHost\.localPace\(profile\.key, route, undefined, input\.reaction\?\.priority\) : 0;\n\s*if \(pace > 0\) \{[\s\S]{0,400}errorCode: 'addon-pace', gap: LOCAL_REMARK_GAP_S, retryAfter: pace\}/);
  // An add-on speaker branches off before any Convai step of a turn; every other turn is unchanged.
  assert.match(bridge, /if \(profile && addonHost\.isSpeaker\(profile\.key\)\) \{ await runAddonTurn\(request, input, profile, current, clock\); return; \}\n\s*if \(!profile \|\| !ids\[profile\.key\]\)/);
  assert.match(bridge, /text: battleTrigger\(input\), reaction: input\.reaction,/, 'the Convai / text-provider config keeps the battle trigger');
  // The add-on turn never names Convai: no realtime host, no knowledge router, no Convai memory admission.
  const turn = bridge.slice(bridge.indexOf('async function runAddonTurn'), bridge.indexOf('async function runInput'));
  for (const banned of ['realtime.', 'knowledgeRouter', 'admitPlayerConversation', 'connections.', 'convaiReply', 'quota.']) {
    assert.equal(turn.includes(banned), false, `runAddonTurn uses ${banned}`);
  }
  assert.match(bridge, /new TextProviderHost\(\{provider: fixedProvider\(mistral, route\), memory: sharedMemory\(mistralMemory\)/);
  assert.match(bridge, /routes: \{\[route\]: textRoutes\[route\], \.\.\.\(allowsMistral \? \{mistral: textRoutes\.mistral\} : \{\}\)\}/, 'never Groq');
  // The once-a-second re-read exists only with add-ons.
  assert.match(bridge, /const addonTimer = addonHost\.active \? setInterval\(/);
  assert.match(bridge, /\.\.\.addonHost\.blocks\(input\),/);
});

test('roster rows, no Convai ids and the persona book: an add-on speaker is a voice, not a person', () => {
  const host = new AddonHost({addons: [validateManifest(manifest(), tmpdir())]});
  const roster = [{key: 'judy-alvarez', name: 'Judy', backstory: 'Braindance editor.'}];
  const ids = {'judy-alvarez': 'judy-id', 'addon-skippy-gun': 'hand-edited-id'};
  host.extend(roster, ids);
  assert.equal(roster.length, 2);
  assert.deepEqual(ids, {'judy-alvarez': 'judy-id'}, 'an add-on speaker never keeps a Convai character ID, even a hand-edited one');
  const row = roster[1];
  assert.equal(row.kind, 'addon');
  assert.equal(row.voiceOnly, true);
  const book = new PersonaBook(roster);
  const skippy = systemHead({persona: book.persona('addon-skippy-gun')});
  assert.match(skippy, /^You are Skippy, a talking smart pistol\. Stay Skippy for the whole conversation/);
  assert.match(skippy, /\n8\. You are a gun, not a person\.\n/);
  assert.doesNotMatch(skippy, /You are a real person/);
  assert.match(skippy, /YOUR OWN RULES OF SPEECH[^]*- Never ask a question during combat./);
  // An ordinary character is unchanged by the add-on fields.
  const judy = systemHead({persona: book.persona('judy-alvarez')});
  assert.match(judy, /^You are Judy, a real person living in Cyberpunk 2077's Night City/);
  assert.match(judy, /\n8\. You are a real person\. If V says you are an AI/);
});

const SKIPPY_MODES = {
  killer: {name: 'Stone Cold Killer', style: 'Cold, clipped, gleeful about headshots.', samples: ['Skippy: Two down. Next.'],
    rules: ['Celebrate clean kills in five words or fewer.']},
  puppy: {name: 'Puppy-Loving Pacifist', style: 'Anxious, kind, begs V to aim for the legs.', samples: ['Skippy: Not the face, V!'],
    rules: ['Never cheer a death.'], identityRule: 'You are a gun that hates hurting anyone.'},
};
const skippy = (extra = {}) => validateManifest(manifest({speakers: [{...manifest().speakers[0], modes: SKIPPY_MODES, ...extra}]}), tmpdir());

test('providers: add-on speakers use Mistral or the local AI only, the player\'s choice first, and say once what they need', () => {
  assert.deepEqual(ADDON_PROVIDERS, ['mistral', 'local']);
  const host = new AddonHost({addons: [skippy(), validateManifest(manifest({id: 'cab', name: 'Delamain', providers: ['local'],
    speakers: [{id: 'delamain', name: 'Delamain', persona: {backstory: 'A cab AI.'}}]}), tmpdir())]});
  assert.deepEqual(host.speakers.get('addon-skippy-gun').speaker.providers, ['mistral', 'local'], 'both by default');
  const route = (key, state) => host.routeFor(key, state);
  // The player's own provider when the speaker allows it and it works.
  assert.equal(route('addon-skippy-gun', {applied: 'local', mistralKey: true, localReady: true}), 'local');
  assert.equal(route('addon-skippy-gun', {applied: 'mistral', mistralKey: true, localReady: true}), 'mistral');
  // Convai or Groq players: a saved Mistral key, else the Local AI pack; never Convai, never Groq.
  for (const applied of ['convai', 'groq']) {
    assert.equal(route('addon-skippy-gun', {applied, mistralKey: true, localReady: true}), 'mistral');
    assert.equal(route('addon-skippy-gun', {applied, mistralKey: false, localReady: true}), 'local');
    assert.equal(route('addon-skippy-gun', {applied, mistralKey: false, localReady: false}), null);
  }
  assert.equal(route('addon-skippy-gun', {applied: 'local', mistralKey: true, localReady: false}), 'mistral', 'a failed Local AI falls to Mistral');
  // A speaker that allows only the local AI never uses a Mistral key.
  assert.equal(route('addon-cab-delamain', {applied: 'mistral', mistralKey: true, localReady: false}), null);
  assert.equal(route('addon-cab-delamain', {applied: 'convai', mistralKey: true, localReady: true}), 'local');
  assert.equal(route('judy-alvarez', {applied: 'mistral', mistralKey: true}), null, 'not an add-on speaker');
  assert.equal(host.providerNotice('addon-skippy-gun'), "Skippy needs a free Mistral key or the Local AI pack. Set it up under Conversation provider in Cyberpunk Convai's settings.");
  assert.match(host.providerNotice('addon-cab-delamain'), /^Delamain needs the Local AI pack\./);
  // The text host's view of the provider: fixed route, always active, the saved Mistral key, no Groq.
  const player = {apiKey: 'k', applied: 'convai', route: 'convai', active: false, groqApiKey: 'g'};
  const fixed = fixedProvider(player, 'mistral');
  assert.deepEqual([fixed.route, fixed.applied, fixed.active, fixed.apiKey, fixed.groqApiKey], ['mistral', 'mistral', true, 'k', null]);
  assert.throws(() => fixedProvider(player, 'convai'), /cannot use convai/);
  assert.throws(() => fixedProvider(player, 'groq'), /cannot use groq/);
  // The memory view keeps the store's methods but not its fact-extraction hook.
  const store = {recall: () => 'r', record: () => 'w', setExtractor: () => { throw Error('taken over'); }};
  const view = sharedMemory(store);
  assert.equal(view.recall(), 'r');
  assert.equal(view.setExtractor, undefined);
});

test('local AI pace: with the default gap a remark on the local AI waits about 20 s after the last one; Mistral and a chosen gap never wait', () => {
  let now = 0;
  const host = new AddonHost({addons: [skippy()], now: () => now});
  assert.equal(LOCAL_REMARK_GAP_S, 20);
  assert.equal(host.localPace('addon-skippy-gun', 'local'), 0, 'the first remark starts at once');
  host.remarkStarted('addon-skippy-gun', 'local');
  now = 10_000;
  assert.equal(host.localPace('addon-skippy-gun', 'local'), 10);
  assert.equal(host.localPace('addon-skippy-gun', 'mistral'), 0, 'Mistral is not held');
  host.remarkStarted('addon-skippy-gun', 'mistral');
  now = 19_500;
  assert.equal(host.localPace('addon-skippy-gun', 'local'), 1, 'rounded up');
  now = 20_000;
  assert.equal(host.localPace('addon-skippy-gun', 'local'), 0);
  // A gap the player picked is used as it is (the game spaces it).
  host.remarkStarted('addon-skippy-gun', 'local');
  host.observeSettings(JSON.stringify({version: 1, addons: {skippy: {remarkGap: 1, remarkGapChosen: true}}}));
  assert.equal(host.localPace('addon-skippy-gun', 'local'), 0);
  assert.equal(host.localPace('judy-alvarez', 'local'), 0, 'not an add-on speaker');
});

test('local AI pace: the biggest moments (priority 5) are never refused, and a remark nobody heard is given back', () => {
  let now = 0;
  const host = new AddonHost({addons: [skippy()], now: () => now});
  const first = host.remarkStarted('addon-skippy-gun', 'local');
  assert.ok(first, 'a local remark returns a token');
  now = 3_000;
  assert.equal(host.localPace('addon-skippy-gun', 'local', now, 4), 17, 'priority 4 waits');
  assert.equal(host.localPace('addon-skippy-gun', 'local', now, 5), 0, 'priority 5 does not');
  // Never published: the first remark does not count, so the next moment is not refused for it.
  assert.equal(host.remarkRefunded(first), true);
  assert.equal(host.localPace('addon-skippy-gun', 'local', now, 2), 0);
  assert.equal(host.remarkRefunded(first), false, 'refunded once');
  // A later remark that started since keeps its own time.
  const second = host.remarkStarted('addon-skippy-gun', 'local');
  now = 4_000;
  const third = host.remarkStarted('addon-skippy-gun', 'local');
  assert.equal(host.remarkRefunded(second), false);
  assert.equal(host.remarkRefunded(third), true);
  assert.equal(host.localPace('addon-skippy-gun', 'local', now, 2), 19, 'back to the second remark (3 s)');
  assert.equal(host.remarkStarted('addon-skippy-gun', 'mistral'), null, 'Mistral is not paced');
});

test('modes: each personality has its own stable persona prefix, switched by the turn or the game state', () => {
  const host = new AddonHost({addons: [skippy({defaultMode: 'puppy'})], startedAt: 0});
  const roster = [];
  host.extend(roster, {});
  const book = new PersonaBook(roster);
  const head = () => systemHead({persona: book.persona('addon-skippy-gun')});
  const puppy = head();
  assert.equal(host.modeOf('addon-skippy-gun').id, 'puppy');
  assert.match(puppy, /Anxious, kind/);
  assert.match(puppy, /Not the face, V!/);
  assert.match(puppy, /You are a gun that hates hurting anyone\./);
  assert.match(puppy, /- Never ask a question during combat\.[^]*- Never cheer a death\./, 'base rules, then the mode\'s');
  assert.doesNotMatch(puppy, /Two down/);
  assert.equal(head(), puppy, 'the same text on every turn of a mode (a prefix cache keeps working)');
  // The turn's data switches it (the game's handle:setMode)...
  host.beginTurn({profileKey: 'addon-skippy-gun', addon: {mode: 'killer'}});
  const killer = head();
  assert.match(killer, /Cold, clipped/);
  assert.match(killer, /Two down\. Next\./);
  assert.match(killer, /You are a gun, not a person\./, 'the base identity rule when the mode has none');
  assert.notEqual(killer, puppy);
  host.beginTurn({profileKey: 'addon-skippy-gun', addon: {mode: 'unknown'}});
  assert.equal(head(), killer, 'an unknown mode changes nothing');
  // ...and so does the state file.
  host.observeState(JSON.stringify({version: 1, updated: 1, addons: {skippy: {modes: {gun: 'puppy'}}}}));
  assert.equal(head(), puppy);
  assert.deepEqual(host.status().addons[0].speakers[0].modes, ['killer', 'puppy']);
});

test('repetition: near repeats are found cheaply, a repeated remark is dropped, and recent lines reach the prompt', () => {
  assert.equal(isNearDuplicate('Two down, boss!', 'two down boss'), true, 'same words');
  assert.equal(isNearDuplicate('Nice shot, that one won\'t get up again.', 'Nice shot, that one won\'t be getting up.'), true, 'mostly the same');
  assert.equal(isNearDuplicate('Right between the eyes, beautiful work.', 'Ha! Right between the eyes, again.'), true, 'the same four words');
  assert.equal(isNearDuplicate('Leg shot. He will live, I promise.', 'Sirens. We should not be here.'), false);
  assert(lineSimilarity('a b c d', 'a b c d') === 1 && lineSimilarity('', 'a') === 0);
  let now = 1000;
  const host = new AddonHost({addons: [skippy()], now: () => now});
  const remark = {profileKey: 'addon-skippy-gun', reaction: {kind: 'addon'}, addon: {id: 'skippy', speaker: 'gun', event: 'kill'}};
  assert.equal(host.review(remark, 'Two down, boss!').duplicate, false);
  host.afterReply(remark, 'Two down, boss!');
  now += 1000;
  host.afterReply(remark, 'Leg shot. He will live, I promise.');
  assert.deepEqual(host.review(remark, 'two down boss'), {duplicate: true, similar: 'Two down, boss!'});
  assert.equal(host.review({...remark, reaction: null}, 'two down boss').duplicate, false, 'a conversation reply is never dropped');
  // The persona's example lines are used up: saying one again is a repeat though the journal never saw it (only the spoken part counts).
  assert.equal(sampleLine('Game event: V killed one.\nSkippy: Hiya, boss!', 'Skippy'), 'Hiya, boss!');
  assert.equal(sampleLine('Game event: V killed one.', 'Skippy'), '');
  assert.deepEqual(host.review(remark, 'Hiya boss, hiya!'), {duplicate: true, similar: 'Hiya, boss!'});
  assert.equal(host.review({...remark, reaction: null}, 'Hiya boss, hiya!').duplicate, false);
  assert.deepEqual(host.recentLines('addon-skippy-gun'), ['Two down, boss!', 'Leg shot. He will live, I promise.']);
  const recent = host.blocks(remark).find(block => block.key === 'addon:skippy:recent');
  assert.equal(recent.tier, 'volatile');
  assert.match(recent.text, /never repeat one[^]*- Two down, boss!\n- Leg shot/);
  for (let index = 0; index < 20; index++) host.afterReply(remark, `Line number ${index} is unique ${index * 7}`);
  assert.equal(host.recentLines('addon-skippy-gun').length, 12, 'bounded');
});

test('memories: callbacks to earlier fights come from the game or the add-on module, persist, and reach the prompt', async () => {
  const dir = await folder();
  try {
    const host = new AddonHost({addons: [skippy()], startedAt: 0, now: () => 5});
    await host.loadJournal(dir);
    host.modules.set('skippy', {remember: ({event, line}) => event === 'fight-end' ? `A fight ended with: ${line}` : null});
    const input = {profileKey: 'addon-skippy-gun', reaction: {kind: 'addon'}, addon: {id: 'skippy', speaker: 'gun', event: 'fight-end'}};
    host.afterReply(input, 'Six Maelstrom, zero scratches.');
    host.observeState(JSON.stringify({version: 1, updated: 1, addons: {skippy: {memories: [
      {speaker: 'gun', text: 'V spared the Tyger Claw who begged.', at: 3}, {speaker: 'gun', text: 'V spared the Tyger Claw who begged.', at: 3}]}}}));
    assert.deepEqual(host.memories('addon-skippy-gun'), ['A fight ended with: Six Maelstrom, zero scratches.', 'V spared the Tyger Claw who begged.']);
    const block = host.blocks(input).find(item => item.key === 'addon:skippy:memories');
    assert.equal(block.tier, 'world');
    assert.match(block.text, /Earlier moments you shared with V[^]*- V spared the Tyger Claw who begged\./);
    // Saved (debounced) and read back by the next bridge run.
    await new Promise(done => setTimeout(done, 2300));
    const next = new AddonHost({addons: [skippy()]});
    await next.loadJournal(dir);
    assert.deepEqual(next.memories('addon-skippy-gun'), host.memories('addon-skippy-gun'));
    assert.deepEqual(next.recentLines('addon-skippy-gun'), ['Six Maelstrom, zero scratches.']);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('warm-up: a new stamp from the game warms the speaker once', () => {
  const host = new AddonHost({addons: [skippy()], startedAt: 0});
  const warmed = [];
  host.onWarm = key => warmed.push(key);
  const state = at => JSON.stringify({version: 1, updated: 1, addons: {skippy: {warm: {speaker: 'gun', at}}}});
  host.observeState(state(10));
  host.observeState(state(10));
  host.observeState(state(11));
  assert.deepEqual(warmed, ['addon-skippy-gun', 'addon-skippy-gun']);
});

test('an add-on remark end to end on the text host: Mistral only, the mode persona, the trigger, recent lines, one request', async () => {
  const host = new AddonHost({addons: [skippy({defaultMode: 'killer'})], startedAt: 0});
  const roster = [];
  host.extend(roster, {});
  host.afterReply({profileKey: 'addon-skippy-gun', addon: {event: 'kill'}}, 'Two down. Next.');
  const requests = [];
  const chat = async ({messages, apiKey}) => { requests.push({messages, apiKey}); return {text: 'Headshot. He never saw it coming.', model: 'm', finishReason: 'stop'}; };
  const player = {apiKey: 'player-key', applied: 'convai', noteSuccess() {}, noteLimit() {}, limit: null};
  const route = host.routeFor('addon-skippy-gun', {applied: player.applied, mistralKey: true, localReady: false});
  assert.equal(route, 'mistral');
  const text = new TextProviderHost({provider: fixedProvider(player, route), memory: sharedMemory(await MistralMemory.open({path: null})),
    personas: new PersonaBook(roster), routes: {mistral: mistralRoute({provider: player, chat, gapMs: 0})}});
  const input = {profileKey: 'addon-skippy-gun', reaction: {kind: 'addon'}, addon: {id: 'skippy', speaker: 'gun', event: 'headshot', maxWords: 8,
    text: 'V landed a headshot.', facts: {streak: 2}}};
  const blocks = host.blocks(input);
  const parts = Object.fromEntries(['now', 'notes', 'world', 'volatile'].map(tier => [tier, blocks.filter(b => b.tier === tier).map(b => b.text).join('\n\n')]));
  const reply = await text.reply({text: host.trigger(input), reaction: input.reaction, context: '', contextParts: {...parts, worldBlocks: []},
    local: {profileKey: 'addon-skippy-gun', name: 'Skippy', channel: 'private'}});
  assert.equal(reply.text, 'Headshot. He never saw it coming.');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].apiKey, 'player-key');
  const prompt = requests[0].messages.map(message => message.content).join('\n');
  assert.match(prompt, /Cold, clipped/);
  assert.match(prompt, /V landed a headshot\. This event was not spoken by V\. React as Skippy with one short spoken line of at most 8 words/);
  assert.match(prompt, /Your most recent lines[^]*- Two down\. Next\./);
  assert.match(prompt, /streak: 2/);
  assert.equal(host.review(input, reply.text).duplicate, false);
});

test('request data: the addon field and the addon reaction pass the protocol; ordinary requests are unchanged', () => {
  const base = {requestId: '1-2-3ULL', generation: 2, entity: '3ULL', name: 'Skippy', bodyType: '', profileKey: 'addon-skippy-gun',
    text: 'Combat started.', sentAt: 1};
  const now = Date.now();
  const remark = parseInput(JSON.stringify({...base, voiceOnly: true,
    reaction: {kind: 'addon', addon: 'skippy', speaker: 'gun', event: 'combat-start', priority: 3, expiresAt: now + 4000},
    addon: {id: 'skippy', speaker: 'gun', event: 'combat-start', text: 'A fight started.', maxWords: 10,
      facts: {enemies: 3, weapon: {name: 'Skippy', mode: 'puppy'}, bad: () => 1},
      blocks: [{key: 'mode', text: 'Puppy-Loving Pacifist mode: aim for limbs.', tier: 'world'}, {key: 'x y', text: 'bad key'}]}}));
  assert.deepEqual(remark.reaction, {kind: 'addon', addon: 'skippy', speaker: 'gun', event: 'combat-start', expiresAt: now + 4000, priority: 3, maxWords: 10});
  assert.equal(remark.addon.maxWords, 10);
  assert.deepEqual(remark.addon.facts, {enemies: 3, weapon: {name: 'Skippy', mode: 'puppy'}});
  assert.deepEqual(remark.addon.blocks, [{key: 'mode', text: 'Puppy-Loving Pacifist mode: aim for limbs.', tier: 'world'}]);
  // A remark whose event data names another speaker, or none, is refused.
  assert.equal(parseInput(JSON.stringify({...base, reaction: {kind: 'addon', addon: 'skippy', speaker: 'gun', event: 'e', expiresAt: now}})), null);
  assert.equal(parseInput(JSON.stringify({...base, reaction: {kind: 'addon', addon: 'skippy', speaker: 'gun', event: 'e', expiresAt: now},
    addon: {id: 'skippy', speaker: 'other'}})), null);
  // An ordinary request has no addon field at all.
  const plain = parseInput(JSON.stringify({...base, profileKey: 'judy-alvarez', name: 'Judy'}));
  assert.equal(Object.hasOwn(plain, 'addon'), false);
  assert.equal(parseAddonInput({id: 'Bad', speaker: 'gun'}), undefined);
  assert.equal(parseAddonReaction({kind: 'addon', addon: 'skippy', speaker: 'gun', event: 'e', expiresAt: 0}, {id: 'skippy', speaker: 'gun'}), null);
  // The reaction carries the remark's word limit (the text host stops, sizes and cuts the line by it); without one it carries none.
  const reaction = {kind: 'addon', addon: 'skippy', speaker: 'gun', event: 'e', expiresAt: now};
  assert.equal(parseAddonReaction(reaction, {id: 'skippy', speaker: 'gun', maxWords: 9}).maxWords, 9);
  assert.equal(Object.hasOwn(parseAddonReaction(reaction, {id: 'skippy', speaker: 'gun'}), 'maxWords'), false);
});

test('blocks: a speaker gets the no-body note, its game blocks, hook blocks or plain facts; companions get what add-ons tell them', () => {
  const addon = validateManifest(manifest(), tmpdir());
  const host = new AddonHost({addons: [addon], startedAt: 100000});
  const input = {profileKey: 'addon-skippy-gun', reaction: {kind: 'addon'},
    addon: {id: 'skippy', speaker: 'gun', event: 'combat-start', facts: {enemies: 3}, blocks: [{key: 'mode', text: 'Pacifist mode.', tier: 'world'}]}};
  const blocks = host.blocks(input);
  assert.match(blocks[0].text, /a voice with no body/);
  assert.equal(blocks[0].tier, 'notes');
  assert.deepEqual(blocks[1], {tier: 'world', key: 'addon:skippy:mode', text: 'Pacifist mode.'});
  assert.match(blocks[2].text, /enemies: 3/);
  // With a hook, its blocks replace the plain facts.
  host.modules.set('skippy', {speakerBlocks: ({facts}) => [{key: 'fight', text: `Enemies: ${facts.enemies}`}]});
  assert.deepEqual(host.blocks(input).slice(2), [{tier: 'volatile', key: 'addon:skippy:fight', text: 'Enemies: 3'}]);
  // Companion context: only from this bridge run's state file.
  assert.deepEqual(host.blocks({profileKey: 'judy-alvarez'}), []);
  host.observeState(JSON.stringify({version: 1, updated: 10, addons: {skippy: {companionContext: [{key: 'cab', text: 'Old.'}]}}}));
  assert.deepEqual(host.blocks({profileKey: 'judy-alvarez'}), [], 'a state file from before the bridge started is ignored');
  host.observeState(JSON.stringify({version: 1, updated: 100000, addons: {skippy: {companionContext: [{key: 'cab', text: 'You ride in a Delamain cab.'}]}}}));
  assert.deepEqual(host.blocks({profileKey: 'judy-alvarez'}), [{tier: 'world', key: 'addon:skippy:cab', text: 'You ride in a Delamain cab.'}]);
});

test('a hook that throws, returns a promise or keeps failing never breaks a turn and is switched off after three failures', () => {
  const logs = [];
  const host = new AddonHost({addons: [validateManifest(manifest(), tmpdir())], log: line => logs.push(line)});
  let calls = 0;
  host.modules.set('skippy', {speakerBlocks: () => { calls++; throw Error('boom'); }, trigger: () => Promise.resolve('x')});
  const input = {profileKey: 'addon-skippy-gun', addon: {id: 'skippy', speaker: 'gun', event: 'e'}, reaction: {kind: 'addon'}};
  for (let i = 0; i < 5; i++) assert.match(host.blocks(input)[0].text, /voice with no body/);
  assert.equal(calls, 3);
  assert(logs.some(line => /switched off/.test(line)));
  assert.match(host.trigger(input), /This event was not spoken by V/, 'a promise from a hook falls back to the default trigger');
});

test('the file watchers keep what they last saw when a read finds nothing (the game replaces a file by remove then rename)', async () => {
  const host = new AddonHost({addons: [validateManifest(manifest(), tmpdir())]});
  host.observeSettings(JSON.stringify({version: 1, addons: {skippy: {remarkGap: 1, remarkGapChosen: true}}}));
  const before = JSON.stringify(host.settings);
  assert.notEqual(before, '{}');
  const handlers = host.watchHandlers('runtime', {read: async () => { throw Object.assign(Error('gone'), {code: 'ENOENT'}); }});
  for (const handler of Object.values(handlers)) await handler();
  assert.equal(JSON.stringify(host.settings), before);
  // A real (even if empty) document still applies.
  const empty = host.watchHandlers('runtime', {read: async () => JSON.stringify({version: 1, addons: {}})});
  for (const handler of Object.values(empty)) await handler();
  assert.notEqual(JSON.stringify(host.settings), before);
});

test('an async hook that rejects is a logged failure, never an unhandled rejection', async () => {
  const logs = [], unhandled = [];
  const seen = reason => unhandled.push(reason);
  process.on('unhandledRejection', seen);
  try {
    const host = new AddonHost({addons: [validateManifest(manifest(), tmpdir())], log: line => logs.push(line)});
    host.modules.set('skippy', {speakerBlocks: async () => { throw Error('async boom'); }});
    const input = {profileKey: 'addon-skippy-gun', addon: {id: 'skippy', speaker: 'gun', event: 'e'}, reaction: {kind: 'addon'}};
    assert.match(host.blocks(input)[0].text, /voice with no body/);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
    assert(logs.some(line => /must return a value, not a promise/.test(line)));
  } finally { process.off('unhandledRejection', seen); }
});

test('trigger: the hook text, or a short default line within the word limit', () => {
  const host = new AddonHost({addons: [validateManifest(manifest(), tmpdir())]});
  const input = {profileKey: 'addon-skippy-gun', text: 'x', addon: {id: 'skippy', speaker: 'gun', event: 'kill', text: 'V took down an enemy.', maxWords: 8}};
  const line = host.trigger(input);
  assert.match(line, /^V took down an enemy\. This event was not spoken by V\. React as Skippy with one short spoken line of at most 8 words\./);
  assert.match(line, /Do not ask a question/);
  host.modules.set('skippy', {trigger: ({maxWords}) => `Custom ${maxWords}`});
  assert.equal(host.trigger(input), 'Custom 8');
});

test('voices: a checked reference is copied under every root and merged into copies of the voice configurations', async () => {
  const work = await folder();
  try {
    const dir = resolve(work, 'addon');
    await mkdir(resolve(dir, 'voices'), {recursive: true});
    const bytes = wav(0.5);
    await writeFile(resolve(dir, 'voices/gun.wav'), bytes);
    await writeFile(resolve(dir, 'voices/long.wav'), wav(25));
    const addon = validateManifest(manifest({speakers: [
      {...manifest().speakers[0], voice: {reference: 'voices/gun.wav', transcript: 'Hiya boss.'}},
      {id: 'long', name: 'Long', persona: {backstory: 'x'}, voice: {reference: 'voices/long.wav', transcript: 'x'}}]}), dir);
    const state = resolve(work, 'state'), pocketRefs = resolve(work, 'pocket-refs'), omniRefs = resolve(work, 'omni-refs');
    await mkdir(state, {recursive: true});
    await writeFile(resolve(state, 'pocket.json'), JSON.stringify({engine: 'pocket-tts', runtime: {referenceDirectory: pocketRefs},
      voices: {'judy-alvarez': {reference: 'runtime/voice-references/judy.wav', sha256: 'a'.repeat(64), transcript: 'hi'}}}));
    await writeFile(resolve(state, 'omni.json'), JSON.stringify({provider: 'hybrid', engine: 'omnivoice', version: 2,
      preparation: {mode: 'eager', startupProfiles: ['a', 'b', 'c', 'd']}, voices: {}}));
    const logs = [];
    const host = new AddonHost({addons: [addon], log: line => logs.push(line)});
    const paths = await host.voiceConfigPaths({pocket: resolve(state, 'pocket.json'), omni: {short: resolve(state, 'omni.json'), long: resolve(state, 'omni.json')}, warnings: []},
      {stateDirectory: state, roots: [omniRefs]});
    assert.equal(paths.pocket, resolve(state, 'addons.pocket.json'));
    assert.equal(paths.omni.short, resolve(state, 'addons.omni.json'));
    assert.equal(paths.omni.long, paths.omni.short);
    assert.deepEqual(paths.warnings, []);
    const pocket = JSON.parse(await readFile(paths.pocket, 'utf8'));
    assert.deepEqual(pocket.voices['addon-skippy-gun'], {reference: 'runtime/voice-references/addons/addon-skippy-gun.wav',
      sha256: inspectReference(bytes).sha256, transcript: 'Hiya boss.'});
    assert.equal(pocket.voices['judy-alvarez'].transcript, 'hi');
    assert.equal(pocket.voices['addon-skippy-long'], undefined, 'a 25 s reference is refused; the other voice still loads');
    const omni = JSON.parse(await readFile(paths.omni.short, 'utf8'));
    assert.deepEqual(omni.preparation, {mode: 'lazy', startupProfiles: ['a', 'b', 'c']});
    for (const root of [pocketRefs, omniRefs]) assert.deepEqual(await readFile(resolve(root, 'addons/addon-skippy-gun.wav')), bytes);
    assert.equal(host.status().addons[0].speakers[0].voice, 'ready');
    assert.match(host.status().addons[0].speakers[1].voice, /0\.1 to 20 seconds/);
    // The original files are untouched.
    assert.equal(JSON.parse(await readFile(resolve(state, 'omni.json'), 'utf8')).preparation.mode, 'eager');
  } finally { await rm(work, {recursive: true, force: true}); }
});

test('voices: extra voices that belong to no add-on (V’s) are merged the same way, with no add-on installed, and a bad one is left out', async () => {
  const work = await folder();
  try {
    const bytes = wav(0.5);
    await mkdir(resolve(work, 'clips'), {recursive: true});
    await writeFile(resolve(work, 'clips/v-male.wav'), bytes);
    await writeFile(resolve(work, 'clips/v-female.wav'), bytes);
    const state = resolve(work, 'state'), pocketRefs = resolve(work, 'pocket-refs'), omniRefs = resolve(work, 'omni-refs');
    await mkdir(state, {recursive: true});
    await writeFile(resolve(state, 'pocket.json'), JSON.stringify({engine: 'pocket-tts', runtime: {referenceDirectory: pocketRefs},
      preparation: {mode: 'lazy', startupProfiles: []},
      voices: {'judy-alvarez': {reference: 'runtime/voice-references/judy.wav', sha256: 'a'.repeat(64), transcript: 'hi'},
        'v-female': {reference: 'runtime/voice-references/mine.wav', sha256: 'b'.repeat(64), transcript: 'already here'}}}));
    const logs = [];
    const host = new AddonHost({addons: [], log: line => logs.push(line)});
    const paths = {pocket: resolve(state, 'pocket.json'), omni: {}, warnings: []};
    assert.equal(await host.voiceConfigPaths(paths, {stateDirectory: state, roots: [omniRefs]}), paths, 'no extra voices: the very same object');
    const extra = [{key: 'v-male', reference: resolve(work, 'clips/v-male.wav'), sha256: inspectReference(bytes).sha256, transcript: 'Some words.'},
      {key: 'v-female', reference: resolve(work, 'clips/v-female.wav'), transcript: 'Other words.'},
      {key: 'v-bad', reference: resolve(work, 'clips/v-male.wav'), sha256: 'c'.repeat(64), transcript: 'Wrong hash.'},
      {key: 'v-gone', reference: resolve(work, 'clips/none.wav'), transcript: 'Missing.'}];
    const merged = await host.voiceConfigPaths(paths, {stateDirectory: state, roots: [omniRefs], extra});
    assert.equal(merged.pocket, resolve(state, 'addons.pocket.json'));
    const pocket = JSON.parse(await readFile(merged.pocket, 'utf8'));
    assert.deepEqual(pocket.voices['v-male'], {reference: 'runtime/voice-references/addons/v-male.wav', sha256: inspectReference(bytes).sha256, transcript: 'Some words.'});
    assert.equal(pocket.voices['v-female'].transcript, 'already here', 'a voice already in the configuration is left alone');
    assert.equal(pocket.voices['v-bad'], undefined); assert.equal(pocket.voices['v-gone'], undefined);
    assert.equal(logs.length, 2); assert.match(logs.join(' '), /v-bad not used: reference does not match/);
    for (const root of [pocketRefs, omniRefs]) assert.deepEqual(await readFile(resolve(root, 'addons/v-male.wav')), bytes);
    assert.equal(pocket.preparation.mode, 'lazy', 'merging changes nothing about when voices are prepared');
  } finally { await rm(work, {recursive: true, force: true}); }
});

test('state and settings files: only plain, bounded data reaches the bridge, and a settings change reaches the module', () => {
  assert.deepEqual(parseAddonState('nope'), {addons: {}});
  assert.deepEqual(parseAddonState({version: 1, updated: 5, addons: {skippy: {companionContext: [{key: 'a', text: 'x'}]}}}, {notBefore: 10}), {addons: {}});
  assert.deepEqual(parseAddonSettings({version: 1, addons: {skippy: {mode: 2, on: true, label: 'x', bad: {}}}}), {skippy: {mode: 2, on: true, label: 'x'}});
  const seen = [];
  const host = new AddonHost({addons: [validateManifest(manifest(), tmpdir())]});
  host.modules.set('skippy', {onSettings: values => seen.push(values)});
  host.observeSettings(JSON.stringify({version: 1, addons: {skippy: {mode: 2}}}));
  host.observeSettings(JSON.stringify({version: 1, addons: {skippy: {mode: 2}}}));
  assert.deepEqual(seen, [{mode: 2}], 'an unchanged file does not call the hook again');
});

test('the runtime packages and the main manifests ship the add-on host but never an add-on', () => {
  const plan = read('../packaging/release-plan.json'), dev = read('../scripts/development-files.json');
  assert.match(plan, /"bridge\/addons\.mjs"/);
  for (const text of [plan, dev]) {
    assert.match(text, /"source": "mod\/addons\.lua"/);
    assert.doesNotMatch(text, /"addons\//, 'an add-on file is listed in a main mod manifest');
  }
});
