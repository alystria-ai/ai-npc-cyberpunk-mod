// Scripted quest lines on the bridge (bridge/quest-lines.mjs, docs/QUEST_PRIMITIVES.md section 4): the strict reaction parser, the request through parseInput, the reply a
// resolved line becomes, its voice route, and the places convai-bridge.mjs wires it in. Pure and offline; the voice itself is in prepared-voice.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseInput} from './protocol.mjs';
import {parseScriptedReaction, scriptedResult, scriptedRoute, expressionSignalFor, SCRIPTED_CHANNELS} from './quest-lines.mjs';
import {normalizeConvaiEmotion} from './companion-expressions.mjs';
import {baselineFromSignal} from './emotion-analysis.mjs';
import {providerPrior, selectEmotion} from './emotion-selector.mjs';

const NOW = 4_000_000_000_000;
const good = {kind: 'scripted', pack: 'panam-sunset-coffee', line: 'P1.walk.02', channel: 'own', expiresAt: NOW};

test('parseScriptedReaction: a good reaction is returned with exactly its five fields, extra fields are dropped', () => {
  assert.deepEqual(parseScriptedReaction(good, 'panam-palmer'), good);
  assert.deepEqual(parseScriptedReaction({...good, extra: 'x', text: 'ignored'}, 'panam-palmer'), good);
  for (const channel of SCRIPTED_CHANNELS) assert.equal(parseScriptedReaction({...good, channel}, 'judy-alvarez').channel, channel);
  assert.deepEqual(SCRIPTED_CHANNELS, ['own', 'holocall', 'head', 'remote']);
  // Line ids are the ones the pack writes: letters, digits and . _ : -
  for (const line of ['P1.walk.02', 'a', 'x:y_z-1', 'A'.repeat(64)]) assert.equal(parseScriptedReaction({...good, line}, 'panam-palmer')?.line, line);
});

test('parseScriptedReaction: anything else fails closed', () => {
  const bad = [undefined, null, 'scripted', 5, [], {...good, kind: 'speakup'}, {...good, kind: undefined},
    {...good, pack: undefined}, {...good, pack: 'Panam'}, {...good, pack: 'pa'}, {...good, pack: '1panam'}, {...good, pack: 'a'.repeat(49)}, {...good, pack: '../etc'}, {...good, pack: 'panam sunset'},
    {...good, line: undefined}, {...good, line: ''}, {...good, line: 'a'.repeat(65)}, {...good, line: '../x'}, {...good, line: 'a b'}, {...good, line: 'a/b'}, {...good, line: 'a\\b'}, {...good, line: 5},
    {...good, channel: undefined}, {...good, channel: 'Own'}, {...good, channel: 'phone'}, {...good, channel: ''},
    {...good, expiresAt: undefined}, {...good, expiresAt: 0}, {...good, expiresAt: -5}, {...good, expiresAt: 1.5}, {...good, expiresAt: '5'}, {...good, expiresAt: 2 ** 60}, {...good, expiresAt: NaN}];
  for (const value of bad) assert.equal(parseScriptedReaction(value, 'panam-palmer'), null, JSON.stringify(value));
  // A named roster profile only: never a resident, an archetype or a malformed key.
  for (const profile of ['resident-male', 'resident-female', 'npc-ripperdoc-01', 'Panam', '', undefined, null, 5, 'a b', 'x'.repeat(81)]) {
    assert.equal(parseScriptedReaction(good, profile), null, String(profile));
  }
  // Johnny is a named character: a line of the head channel is his.
  assert.equal(parseScriptedReaction({...good, channel: 'head'}, 'johnny-silverhand')?.channel, 'head');
});

// ---- the request ----
let serial = 300;
function base(profileKey = 'panam-palmer', name = 'Panam') {
  const generation = ++serial, entity = `${2000 + serial}ULL`;
  return {requestId: `${NOW}-${generation}-${entity}`, generation, entity, name, bodyType: 'WomanAverage', profileKey};
}
const line = (extra = {}, who = ['panam-palmer', 'Panam']) => ({...base(...who), text: 'Scripted line.', reaction: {...good}, ...extra});
const parse = raw => parseInput(JSON.stringify(raw));
const head = {version: 1, stage: 'friends', milestones: ['alt', 'second-chance']};
const group = {id: 'g', index: 1, total: 2, audience: ['panam-palmer', 'judy-alvarez'], heard: []};

test('parseInput: a scripted line keeps its reaction, is a private turn, and carries no eddies or bonds', () => {
  const input = parse(line({bonds: {version: 1, packs: true}, eddies: {version: 1}}));
  assert.deepEqual(input.reaction, good);
  assert.equal(input.text, 'Scripted line.'); assert.equal(input.profileKey, 'panam-palmer');
  assert.equal(input.bonds, undefined, 'a reaction is no turn of V: no bond is recorded'); assert.equal(input.eddies, undefined);
  assert.equal(input.group, undefined); assert.equal(input.head, undefined); assert.equal(input.holocall, undefined);
  assert.equal(parse(line({reaction: {...good, extra: 'x'}})).reaction.expiresAt, NOW, 'unknown keys are dropped');
  for (const channel of ['own', 'head', 'remote']) assert.equal(parse(line({reaction: {...good, channel}})).reaction.channel, channel);
});

test('parseInput: a malformed or misplaced scripted reaction refuses the whole turn', () => {
  const holo = {version: 1, contact: 'Panam', mode: 'audio'};
  const refused = {
    'a bad pack': line({reaction: {...good, pack: 'Bad Pack'}}),
    'a bad line': line({reaction: {...good, line: '../x'}}),
    'a bad channel': line({reaction: {...good, channel: 'tv'}}),
    'no expiry': line({reaction: {kind: 'scripted', pack: good.pack, line: good.line, channel: 'own'}}),
    'a group round': line({group}),
    'a battle field': line({battle: {version: 1, status: 'none'}}),
    'a loot field': line({loot: {version: 1, batch: 'loot-1', status: 'ready', items: []}}),
    'a head field': line({head}),
    'a holocall field on a line of the own channel': line({holocall: holo}),
    'a holocall field on a line of the head channel': line({holocall: holo, reaction: {...good, channel: 'head'}}),
    'a holocall field on a line of the remote channel': line({holocall: holo, reaction: {...good, channel: 'remote'}}),
    'an ordinary NPC': line({}, ['resident-male', 'Passer-by']),
    'an archetype': line({}, ['npc-ripperdoc-01', 'Ripperdoc']),
    'an add-on speaker': line({addon: {version: 1, id: 'skippy', speaker: 'skippy', event: 'hello', facts: {}}}),
  };
  for (const [what, raw] of Object.entries(refused)) assert.equal(parse(raw), null, what);
});

test('parseInput: a line of the holocall channel still comes on a private turn, with or without the call field', () => {
  const holo = {version: 1, contact: 'Panam', mode: 'audio'};
  const call = {...good, channel: 'holocall'};
  assert.deepEqual(parse(line({reaction: call})).reaction, call);
  const withField = parse(line({reaction: call, holocall: holo}));
  assert.deepEqual(withField.reaction, call);
  assert.deepEqual(withField.holocall, {contact: 'Panam', mode: 'audio'});
  assert.equal(parse(line({reaction: call, holocall: holo, group})), null);
});

test('the other requests are unchanged by the new kind', () => {
  assert.equal(parse(line({reaction: {kind: 'scripting', pack: good.pack, line: good.line, channel: 'own', expiresAt: NOW}})), null);
  assert.equal(parse({...base(), text: 'Hello.'}).reaction, undefined);
});

// ---- the reply ----

test('expressionSignalFor: the mod\'s emotion categories become an ordered emotion the face plan reads, the rest say nothing about the face', () => {
  for (const [emotion, label] of [['happy', 'happy'], ['sad', 'sadness'], ['fear', 'fear'], ['angry', 'anger'], ['surprise', 'surprise'], ['Happy', 'happy'], ['happy/fear', 'happy'], ['fear/neutral', 'fear']]) {
    const signal = expressionSignalFor(emotion);
    assert.deepEqual(signal, {version: 1, correlated: true, sequence: 0, emotion: label, scale: 2, basis: 'ordered'}, emotion);
    // The body is one the game-facing normaliser admits, and both planners read it as an ordered label.
    assert.ok(normalizeConvaiEmotion(signal), emotion + ' is admitted');
    assert.ok(providerPrior(signal), emotion + ' has a prior'); assert.ok(baselineFromSignal(signal), emotion + ' has a baseline');
  }
  for (const emotion of ['neutral', 'emphatic', 'shrug', 'nod', 'question', 'nod/shrug', '', undefined, null, 5, {}]) assert.equal(expressionSignalFor(emotion), undefined, String(emotion));
  const plan = selectEmotion({reply: 'They took the car and I want it back.', profile: 'panam-palmer', convai: expressionSignalFor('angry')});
  assert.equal(plan.summary.family, 'anger', 'the ordered label sets the line\'s mood');
});

test('scriptedResult: a line with audio carries its path, one without is missing audio and is marked for the live voice only in Developer mode', () => {
  const resolved = {text: ' You actually came. ', audioPath: 'C:/packs/p/audio/P1.walk.01.wav', emotion: 'happy', gesture: 'happy', channel: 'own', speaker: 'panam-palmer'};
  const withAudio = scriptedResult(resolved);
  assert.deepEqual(withAudio, {text: 'You actually came.', model: 'scripted', finishReason: 'stop', transport: 'local',
    expressionSignal: {version: 1, correlated: true, sequence: 0, emotion: 'happy', scale: 2, basis: 'ordered'}, audioPath: 'C:/packs/p/audio/P1.walk.01.wav'});
  assert.equal(scriptedResult(resolved, {developerMode: true}).liveVoice, undefined, 'a line with audio is always the prepared voice');
  const none = scriptedResult({...resolved, audioPath: null, emotion: 'neutral'});
  assert.deepEqual(none, {text: 'You actually came.', model: 'scripted', finishReason: 'stop', transport: 'local', missingAudio: true});
  assert.equal('expressionSignal' in none, false);
  assert.equal(scriptedResult({...resolved, audioPath: undefined}, {developerMode: true}).liveVoice, true);
  assert.equal(scriptedResult({...resolved, audioPath: ''}, {developerMode: false}).liveVoice, undefined);
  assert.equal(scriptedResult({...resolved, audioPath: ''}, {developerMode: 'yes'}).liveVoice, undefined, 'only a real true');
  for (const bad of [null, undefined, 'x', [], {}, {text: ''}, {text: '   '}, {text: 5}]) assert.equal(scriptedResult(bad), null, JSON.stringify(bad));
});

test('scriptedRoute: the prepared voice whatever the player chose, text when voice playback is off, the live voice only in Developer mode with no file', () => {
  const resolved = {text: 'Line.', audioPath: '/a.wav'};
  assert.equal(scriptedRoute(scriptedResult(resolved)), 'prepared');
  assert.equal(scriptedRoute(scriptedResult(resolved), {playbackEnabled: true}), 'prepared');
  assert.equal(scriptedRoute(scriptedResult(resolved), {playbackEnabled: false}), 'text', 'a player who turned voice playback off gets text only');
  assert.equal(scriptedRoute(scriptedResult({text: 'Line.'})), 'text', 'no file: shown, never the live voice');
  assert.equal(scriptedRoute(scriptedResult({text: 'Line.'}, {developerMode: true})), 'live');
  assert.equal(scriptedRoute(scriptedResult({text: 'Line.'}, {developerMode: true}), {playbackEnabled: false}), 'text');
  assert.equal(scriptedRoute(null), 'text');
});

// ---- the bridge's wiring (the bridge is a program, not a module: its places are checked in its source, as other suites do) ----

const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const between = (from, to) => bridge.slice(bridge.indexOf(from), bridge.indexOf(to, bridge.indexOf(from)));

test('the bridge answers a scripted line before any profile, knowledge or Convai step, and asks no model', () => {
  const run = between('async function runInput(', '// ---- Scripted quest lines');
  const scripted = run.indexOf("input.reaction?.kind === 'scripted') { await runScriptedTurn(request, input, current, clock); return; }");
  assert.ok(scripted > 0, 'runInput hands a scripted line to runScriptedTurn');
  for (const later of ['customCharacters.has(profile.key)', 'addonHost.isSpeaker(profile.key)', 'knowledgeRouter.prepare(', 'admitPlayerConversation(', 'respond(input']) {
    assert.ok(run.indexOf(later) > scripted, `${later} comes after the scripted branch`);
  }
  assert.match(run, /if \(input\.reaction\?\.kind !== 'scripted'\) warmTalkTargets\(/, 'no live voice is warmed for a prepared line');
  const turn = between('async function runScriptedTurn(', 'async function synthesizePrepared(');
  assert.match(turn, /bondPacks\.lineFor\?\.\(pack, line\)/);
  assert.match(turn, /scriptedResult\(resolved, \{developerMode: replyCapture\.enabled\}\)/);
  assert.match(turn, /fail\('', 'scripted-line'\)/);
  assert.match(turn, /scriptedRoute\(reply, \{playbackEnabled: localVoice\.playbackEnabled !== false\}\)/);
  assert.match(turn, /scriptedPackError\(input, 'no prepared audio for'\)/);
  assert.match(between('const scriptedPackError', 'function rememberScripted('), /\[QuestLines\] pack error: /);
  for (const forbidden of ['mistralHost.reply', 'realtime.reply', 'addonTextHost', 'knowledgeRouter', 'connections.', 'respond(', 'convaiReply', 'allowance']) {
    assert.ok(!turn.includes(forbidden), `a scripted turn never touches ${forbidden}`);
  }
  assert.match(turn, /status\('thinking'/); assert.match(turn, /clock\.mark\('admitted'\)/);
  assert.match(turn, /rememberScripted\(input, result\.text\)/, 'her line becomes her own words after it is published');
  assert.match(between('function rememberScripted(', 'async function runScriptedTurn('), /if \(!mistral\.active \|\| memoryQuiescing\) return;[\s\S]*mistralMemory\.record\(/, 'only the text providers keep a local exchange');
});

test('the prepared branch sits at the top of the voice route, below the voice playback off rule, and reaches no live voice engine', () => {
  const body = between('async function synthesizeReplyBody(', 'const turnPlan = turnVoice(input);');
  const off = body.indexOf('localVoice.playbackEnabled===false');
  const prepared = body.indexOf('if (result.audioPath) return synthesizePrepared(input, result, signal, current, profile);');
  assert.ok(off > 0 && prepared > off, 'voice playback off still gives text only');
  const voice = between('async function synthesizePrepared(', 'let lastAudioHeartbeat');
  assert.match(voice, /createPreparedVoice\(\{load: async \(\) => pcm\}\)/);
  assert.match(voice, /decodePreparedWav\(await readPreparedFile\(audioPath\)\)/);
  assert.match(voice, /engine: 'prepared'/);
  assert.ok(!/localVoice\.(synthesize|prepareProfile)|omniVoiceFor|voxtral/.test(voice), 'a prepared line never reaches a live voice engine');
  assert.match(bridge, /customCharacters\.has\(input\.profileKey\) \|\| input\.reaction\?\.kind === 'scripted'\)/, 'a scripted line has no knowledge receipt, like an add-on line');
  assert.match(bridge, /engine === 'prepared' \? preparedPace/, 'a prepared line teaches no live engine\'s pace');
});

test('a scripted line leaves the character\'s Convai session and warm connection alone', () => {
  const publish = between('async function publishResult(', 'const micPath');
  assert.match(publish, /const scripted = input\.reaction\?\.kind === 'scripted'/);
  assert.match(publish, /if \(!scripted\) realtimeSessions\.set\(/);
  assert.match(publish, /if \(!scripted\) connections\.used\(/);
  assert.match(publish, /if \(!scripted\) \(result\.transport === 'realtime' \? realtimeSessions : sessions\)\.set\(/);
  assert.match(publish, /result\.transport === 'realtime' && !scripted\) connections\.used\(/);
});

test('the quest link is wired where the pack state changes, and its files are the two runtime files', () => {
  assert.match(bridge, /new QuestLink\(\{packs: bondPacks, readEvents: \(\) => readFile\(resolve\(runtime, 'quest-events\.json'\), 'utf8'\)/);
  assert.match(bridge, /writePlay: text => atomic\(resolve\(runtime, 'quest-play\.json'\), text\)/);
  assert.match(bridge, /bondPacks\.afterTurn\(input, result\?\.userText, proposal\);\s*questSync\(\);/, 'after a turn');
  assert.match(bridge, /bondPacks\.noteMeeting\(profileKey, kind === 'arrived' \? 'met' : 'stood-up', gameSeconds\); questSync\(\);/, 'after a phone meeting event');
  assert.match(bridge, /bondPacks\.noteMeeting\(input\.profileKey, 'met', gameSeconds\); questSync\(\);/, 'after a greeting at a meeting');
  assert.match(bridge, /Convai conversation bridge ready'\);[\s\S]{0,200}questSync\(\);/, 'a quest left active in the save is handed to the game at start');
  assert.match(bridge, /questPoller\.stop\(\);/, 'the timer ends with the service');
  assert.ok(!/setInterval\([^)]*quest/i.test(bridge), 'no quest timer is created outside the poller');
});
