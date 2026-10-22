// How bridge/convai-bridge.mjs answers a character the player made (docs/CHARACTER_EDITOR.md, "Your own characters"). The bridge is a program,
// not a module, so the turn code is read out of its source and run here over fakes; the wiring around it is pinned the way the add-on tests
// pin theirs (bridge/addon-voice.test.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = bridge.indexOf('// ---- Characters the player made (bridge/custom-characters.mjs, docs/CHARACTER_EDITOR.md)');
const end = bridge.indexOf('async function runInput(request, prepared, clock) {');
assert(start > 0 && end > start, 'the custom turn code was found');
const turnSource = bridge.slice(start, end);

const profile = {key: 'custom-rebecca-k3j9', name: 'Rebecca'};
function rig({active = true, route = 'local', voiced = false, streaming = true, playback = true, uses = true, current = true} = {}) {
  const log = [], published = [];
  const deps = {
    log, published,
    noteTurn: input => log.push(['noteTurn', input.requestId]),
    intrinsicConversationContext: {blocks: input => { log.push(['blocks', input.requestId]); return [{key: 'a', tier: 'world', text: 'World.'}, {key: 'b', tier: 'now', text: 'Now.'}]; }},
    joinedContext: blocks => blocks.map(block => block.text).join('\n\n'),
    contextPartsOf: blocks => ({world: blocks[0].text, now: blocks[1].text, notes: '', volatile: ''}),
    profileFor: (input, roster) => roster.find(row => row.key === input.profileKey),
    roster: [profile],
    mistral: {active, route},
    stopped: false,
    mistralHost: {
      reply: async (config, options) => { log.push(['reply', config, !!options.stream]); return {text: 'Boom.', model: 'm', timing: {}}; },
      prewarm: async config => { log.push(['prewarm', config]); },
    },
    warmConnection: async options => { log.push(['warmConnection', options]); },
    localVoice: {playbackEnabled: playback, usesProfile: key => { log.push(['usesProfile', key]); return uses; }, voiceKeyFor: (key, seed) => { log.push(['voiceKeyFor', key, seed]); return 'resident-female-v2'; },
      prepareProfile: async key => { log.push(['prepareProfile', key]); return {}; }},
    atomic: async (path, text) => { log.push(['atomic', path, JSON.parse(text)]); return true; },
    replyPath: 'runtime/reply.json',
    note: (input, values) => log.push(['note', values]),
    status: async (state, detail) => log.push(['status', state, detail]),
    throwIfCancelled: () => {},
    turnUsesLocal: () => voiced,
    audioAvailable: () => true,
    readSpeechStateCached: async () => ({}),
    vVoice: {noteGender: () => log.push(['v-gender']), start: () => { log.push(['v-start']); return {waitClear: async () => {}}; }},
    replyStreaming: streaming,
    newReplyStream: (config, row) => { log.push(['stream', row.name]); return {kind: 'stream'}; },
    voiceStreamedReply: async (input, row, options) => { log.push(['voiceStreamedReply', typeof options.final.then, options.userText()]); return {text: 'Streamed.', engine: 'pocket'}; },
    synthesizeReply: async (input, reply, signal, currentFn, row) => { log.push(['synthesizeReply', reply.text, row.name]); return {...reply, engine: 'omni'}; },
    measure: async (input, values) => log.push(['measure', Object.keys(values)]),
    publishResult: async (input, row, result) => { published.push(result); log.push(['publish', result.text, result.ttsEnabled, result.userText]); return true; },
  };
  const names = Object.keys(deps);
  const code = new Function(...names, `${turnSource}\nreturn {customTurnConfig, warmCustom, runCustomTurn};`)(...names.map(name => deps[name]));
  const currentFn = Object.assign(async () => current, {sync: () => current});
  const request = (extra = {}) => ({controller: new AbortController(), receivedAt: Date.now(), ...extra});
  const input = (extra = {}) => ({requestId: '1-1-5ULL', profileKey: profile.key, name: 'Rebecca', text: 'Hello', ...extra});
  const clock = {mark: name => log.push(['mark', name])};
  return {...code, deps, log, published, currentFn, request, input, clock};
}
const find = (log, name) => log.filter(item => item[0] === name);

test('the config of a turn is the persona-book route: the live context, the channel and the character\'s own key and name', () => {
  const r = rig();
  const config = r.customTurnConfig(r.input({text: 'Hi V'}), profile);
  assert.deepEqual(config.local, {profileKey: profile.key, name: 'Rebecca', channel: 'private'});
  assert.equal(config.text, 'Hi V');
  assert.equal(config.context, 'World.\n\nNow.');
  assert.deepEqual(config.contextParts, {world: 'World.', now: 'Now.', notes: '', volatile: ''});
  assert.equal(r.customTurnConfig(r.input({group: {id: 'g', index: 0, total: 2, audience: [profile.key, 'judy-alvarez']}}), profile).local.channel, 'group');
  assert.deepEqual(find(r.log, 'noteTurn').length, 2);
});

test('with Convai answering, the turn is refused in one plain sentence and nothing is asked of a model', async () => {
  const r = rig({active: false});
  await r.runCustomTurn(r.request(), r.input(), profile, r.currentFn, r.clock);
  const [, path, reply] = find(r.log, 'atomic')[0];
  assert.equal(path, 'runtime/reply.json');
  assert.equal(reply.errorCode, 'custom-provider');
  assert.match(reply.error, /^Rebecca is one of your own characters\. They need Mistral, Local AI or Custom/);
  assert.deepEqual([reply.requestId, reply.generation, reply.entity], ['1-1-5ULL', undefined, undefined]);
  assert.equal(find(r.log, 'reply').length, 0);
  assert.equal(r.published.length, 0);
});

test('a text turn goes to the main text host and is published without sound when no local voice speaks', async () => {
  const r = rig({voiced: false});
  await r.runCustomTurn(r.request(), r.input(), profile, r.currentFn, r.clock);
  const [, config, streamed] = find(r.log, 'reply')[0];
  assert.equal(streamed, false);
  assert.deepEqual(config.local, {profileKey: profile.key, name: 'Rebecca', channel: 'private'});
  assert.deepEqual(find(r.log, 'status')[0], ['status', 'thinking', 'Rebecca']);
  assert.equal(find(r.log, 'v-start').length, 1, 'V\'s typed line is voiced beside the reply');
  assert.deepEqual(r.published.map(result => [result.text, result.ttsEnabled, result.transport]), [['Boom.', false, 'realtime']]);
  assert.equal(find(r.log, 'synthesizeReply').length, 0);
  // V's voice starts once the request is under way, not after the reply.
  assert.equal(r.log.findIndex(item => item[0] === 'v-start') < r.log.findIndex(item => item[0] === 'publish'), true);
});

test('with a local voice the first sentence is voiced while the rest is written, and the words V spoke ride on the result', async () => {
  const r = rig({voiced: true});
  await r.runCustomTurn(r.request(), r.input(), profile, r.currentFn, r.clock, {userText: 'what I said'});
  assert.deepEqual(find(r.log, 'stream'), [['stream', 'Rebecca']]);
  assert.equal(find(r.log, 'reply')[0][2], true, 'the text host is given the stream');
  assert.deepEqual(find(r.log, 'voiceStreamedReply')[0], ['voiceStreamedReply', 'function', 'what I said']);
  assert.equal(find(r.log, 'synthesizeReply').length, 0);
  assert.deepEqual(find(r.log, 'publish')[0], ['publish', 'Streamed.', undefined, 'what I said']);
  // Without streaming the reply is voiced whole.
  const whole = rig({voiced: true, streaming: false});
  await whole.runCustomTurn(whole.request(), whole.input(), profile, whole.currentFn, whole.clock);
  assert.deepEqual(find(whole.log, 'synthesizeReply')[0], ['synthesizeReply', 'Boom.', 'Rebecca']);
  assert.equal(find(whole.log, 'voiceStreamedReply').length, 0);
  assert.deepEqual(find(whole.log, 'publish')[0], ['publish', 'Boom.', undefined, undefined]);
  // Voice playback off: written only.
  const quiet = rig({voiced: true, playback: false});
  await quiet.runCustomTurn(quiet.request(), quiet.input(), profile, quiet.currentFn, quiet.clock);
  assert.equal(find(quiet.log, 'synthesizeReply').length + find(quiet.log, 'voiceStreamedReply').length, 0);
  assert.equal(quiet.published[0].ttsEnabled, false);
});

test('a look-ahead turn for a group round runs beside the speaker still heard, takes no typed voice and waits to be claimed', async () => {
  const r = rig({voiced: true});
  const waits = [];
  const lookahead = {markReady: () => waits.push('ready'), waitClaimed: async () => { waits.push('claimed'); }};
  await r.runCustomTurn(r.request({lookahead}), r.input({group: {id: 'g', index: 1, total: 2, audience: [profile.key, 'judy-alvarez']}}), profile, r.currentFn, r.clock);
  assert.deepEqual(waits, ['ready', 'claimed']);
  assert.equal(find(r.log, 'v-start').length, 0);
  assert.equal(find(r.log, 'status').length, 0, 'no "thinking" status for a turn that is not the one heard');
  assert.equal(find(r.log, 'stream').length, 0, 'a look-ahead is written whole, then voiced');
  assert.equal(find(r.log, 'synthesizeReply').length, 1);
  assert.equal(find(r.log, 'reply')[0][1].local.channel, 'group');
});

test('a reply that is no longer wanted is not published', async () => {
  const r = rig({current: false});
  await r.runCustomTurn(r.request(), r.input(), profile, r.currentFn, r.clock);
  assert.equal(r.published.length, 0);
});

test('opening the composer on a character warms its text route and the voice that will speak, and nothing when nothing would answer', async () => {
  const local = rig({route: 'local'});
  local.warmCustom(profile.key);
  await new Promise(done => setImmediate(done));
  assert.deepEqual(find(local.log, 'prewarm')[0], ['prewarm', {local: {profileKey: profile.key, name: 'Rebecca'}}]);
  assert.deepEqual(find(local.log, 'prepareProfile'), [['prepareProfile', 'resident-female-v2']], 'the voice that will really speak, from the character\'s own key');
  assert.deepEqual(find(local.log, 'voiceKeyFor')[0], ['voiceKeyFor', profile.key, profile.key]);
  const cloud = rig({route: 'mistral'});
  cloud.warmCustom(profile.key);
  assert.deepEqual(find(cloud.log, 'warmConnection'), [['warmConnection', {provider: 'mistral'}]]);
  assert.equal(find(cloud.log, 'prewarm').length, 0);
  const none = rig({active: false});
  none.warmCustom(profile.key);
  assert.equal(none.log.length, 0, 'Convai answering: nothing is warmed');
  const unknown = rig();
  unknown.warmCustom('custom-ghost-aaaa');
  assert.equal(unknown.log.length, 0);
  const silent = rig({playback: false});
  silent.warmCustom(profile.key);
  assert.equal(find(silent.log, 'prepareProfile').length, 0, 'voice playback off: no voice is prepared');
  const unrouted = rig({uses: false});
  unrouted.warmCustom(profile.key);
  assert.equal(find(unrouted.log, 'prepareProfile').length, 0);
});

test('the bridge opens the store before the voices, gives it to the prompt, the editor and the voice routing, and answers its turns before the Convai checks', () => {
  assert.match(bridge, /const customCharacters = await CustomCharacters\.open\(\{dir: stateDirectory, exchangePath: resolve\(runtime, 'custom-characters\.json'\), roster: rosterIndex\(roster\),/);
  assert(bridge.indexOf('const customCharacters = await CustomCharacters.open') < bridge.indexOf('const voiceConfigPaths = await addonHost.voiceConfigPaths'), 'before the voice configurations are merged');
  // The player's voice clips (story characters' and their own characters'): opened before the store, offered only for keys that still have a
  // character, merged with the voices of the add-ons and of V and read from the data folder (playerVoiceDirectory), never copied.
  assert(bridge.indexOf('const playerVoices = await PlayerVoices.open') < bridge.indexOf('const customCharacters = await CustomCharacters.open'));
  assert.match(bridge, /const playerVoiceAllowed = key => isCustomKey\(key\) \? customCharacters\.has\(key\) : Object\.values\(V_VOICE_KEYS\)\.includes\(key\) \|\| roster\.some\(row => row\?\.key === key && row\.kind === 'named'\);/);
  assert.match(bridge, /await playerVoices\.prune\(key => !isCustomKey\(key\) \|\| customCharacters\.has\(key\)\);/, 'a clip of a deleted character is removed, a story character\'s never');
  assert.match(bridge, /const playerVoiceExtras = await playerVoices\.extras\(playerVoiceAllowed\);/);
  assert.match(bridge, /extra: extraVoices\(vVoiceReferences\)\.concat\(playerVoiceExtras\), playerVoiceDirectory: playerVoices\.folder\}\)/, 'a clip joins the voices of the add-ons and of V');
  assert(bridge.indexOf('const playerVoiceExtras = await playerVoices.extras') < bridge.indexOf('const voiceConfigPaths = await addonHost.voiceConfigPaths'));
  // Voxtral reads a player clip from the data folder and keeps its prepared slot there; the shipped clips keep their own cache.
  assert.match(bridge, /referenceRoot: voxtralReferenceRoot, playerRoot: playerVoices\.folder,/);
  assert.match(bridge, /player: createReferencePreparer\(\{cacheDirectory: resolve\(stateDirectory, PLAYER_PREPARED_FOLDER\),/);
  // A player's clip keeps its slot in the data folder, a voice language pack's in its own prepared/ folder, every other clip in the shared one.
  assert.match(bridge, /prepare: voxtralPreparers \? \(bytes, options = \{\}\) => voxtralPreparer\(options\)\(bytes, options\) : undefined,/);
  assert.match(bridge, /return options\.player \? voxtralPreparers\.player : voxtralPreparers\.shipped;/);
  assert.match(bridge, /onRemoved: key => releasePreparedSlots\(\{folder: resolve\(stateDirectory, PLAYER_PREPARED_FOLDER\), key\}\)/);
  assert.match(bridge, /aliases: key => customCharacters\.voiceAlias\(key\),/, 'a character with no clip speaks with the resident voice of its gender');
  assert.match(bridge, /new PersonaBook\(roster, \{lean: true, overrides: characterOverrides, custom: customCharacters, worldRules\}\)/);
  assert.match(bridge, /new CharacterEditor\(\{personas: personaBook, overrides: characterOverrides, memory: mistralMemory, route: \(\) => mistral\.route, custom: customCharacters,\n  voices: playerVoices,/);
  assert.match(bridge, /onChanged: \(\) => \{ dropPrefetch\(\); prefetchObserved = ''; \}\}\);/, 'a save drops a group reply prepared before it');
  assert.match(bridge, /await mkdir\(runtime, \{recursive: true\}\);\nawait customCharacters\.publish\(\);/, 'the list the game reads is written at start');
  assert.match(bridge, /onDeleted: key => \{ void playerVoices\.clear\(key\)\.catch\(\(\) => \{\}\); return releaseCustomVoice\(key\); \}/, 'deleting a character removes its clip and its prepared setups');
  assert.match(bridge, /for \(let at = roster\.length - 1; at >= 0; at--\) if \(roster\[at\]\?\.kind === 'custom'\) roster\.splice\(at, 1\);/, 'the roster array follows every change in place');
  // The turn: before the Convai identity check, so no Convai id is ever asked for.
  const custom = bridge.indexOf('if (profile && customCharacters.has(profile.key)) { await runCustomTurn(request, input, profile, current, clock); return; }');
  assert(custom > 0 && custom < bridge.indexOf('if (profile && addonHost.isSpeaker(profile.key))') && custom < bridge.indexOf('if (!profile || !ids[profile.key]) {'));
  // V speaking to it is recognised on this computer, like an add-on voice, and answered by the same turn.
  assert.match(bridge, /createAddonVoice\(\{isSpeaker: key => addonHost\.isSpeaker\(key\) \|\| customCharacters\.has\(key\), speech: mistralSpeech,/);
  assert.match(bridge, /return withTurnClock\(request, clock => \(own \? runCustomTurn : runAddonTurn\)\(request, input, profileFor\(input, roster\), current, clock, \{userText\}\)\);/);
  // The turn never touches Convai.
  for (const banned of ['realtime.', 'knowledgeRouter', 'admitPlayerConversation', 'connections.', 'playerMemory', 'phoneRealtime', 'quota.', 'ids[']) assert.equal(turnSource.includes(banned), false, `the custom turn uses ${banned}`);
  // The composer hint of a custom character warms the text route; a Convai hint is unchanged.
  assert.match(bridge, /customCharacters\.has\(unread\.audience\[0\]\)\) warmCustom\(unread\.audience\[0\]\);/);
});
