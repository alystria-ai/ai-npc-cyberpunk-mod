import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MicrophoneSession} from './microphone-session.mjs';
import {createLocalSpeech, NO_SPEECH_ERROR} from './local-stt-capture.mjs';
import {createAddonVoice, addonVoiceConfig} from './addon-voice.mjs';

// V speaking to an add-on speaker (F7, F10): the recording is recognised by the Mistral route's recogniser and the words go to the
// add-on turn route. Nothing here opens a Convai connection (docs/ADDON_API.md, "Talk and group conversation").
const KEY = 'addon-cab-delamain';   // a profile key that is not in any character roster
const source = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function fakeStt({available = true, text = 'take me to Afterlife', partial = ''} = {}) {
  const log = [];
  return {log, availability: () => ({available, reason: available ? null : 'model-missing'}),
    start: async id => { log.push('start:' + id); }, pushAudio: chunk => { log.push('audio:' + chunk.length); return true; },
    heard: () => partial, finish: async id => { log.push('finish:' + id); return {text, seconds: 2}; },
    cancel: async id => { log.push('cancel:' + id); }, warm: async () => {}, close: async () => {}};
}
function fakeCapture() {
  const log = [];
  let sink = null;
  return {log, emit: chunk => sink?.(chunk),
    begin: async onChunk => { log.push('begin'); sink = onChunk; return {device: 'Fake microphone'}; },
    end: async () => { log.push('end'); sink = null; }, abort: async () => { log.push('abort'); sink = null; },
    close: async () => {}};
}

const first = {requestId: '9-1-88ULL', entity: '88ULL', generation: 1, profileKey: KEY, name: 'Delamain', text: '[Microphone]', voiceOnly: true,
  addon: {id: 'cab', speaker: 'delamain', blocks: [{tier: 'volatile', key: 'ride', text: 'speed 40'}]}};
const second = {...first, addon: {...first.addon, blocks: [{tier: 'volatile', key: 'ride', text: 'speed 55'}]}, journal: {at: 2}};

// The whole voice path with fakes: the recogniser (a real createLocalSpeech channel over fake stt/capture), the turn route and a
// fake Convai host whose voice channel must never be asked for.
function rig({isSpeaker = key => key === KEY, runTurn, stt = fakeStt(), capture = fakeCapture(), currentOpen = true} = {}) {
  const speech = createLocalSpeech({stt, capture});
  const convai = {opened: 0, voiceChannel() { convai.opened++; return {beginVoice: async () => { convai.opened++; }, finishVoice: async () => { convai.opened++; },
    heard: async () => '', close: async () => {}}; }};
  const turns = [], answered = [], states = [], replies = [], errors = [];
  const voice = createAddonVoice({isSpeaker, speech,
    currentFor: (requestId, signal) => { const current = async () => currentOpen && !signal?.aborted; current.sync = () => currentOpen; return current; },
    runTurn: runTurn ?? (async turn => { turns.push(turn); }),
    answerError: async turn => { answered.push(turn); }});
  const mic = new MicrophoneSession({hostFactory: voice.hostFactory(() => convai.voiceChannel()), minRecordMs: 0,
    onState: async state => { states.push(state); },
    onReply: async (input, result) => { replies.push(result); },
    onError: async (input, error) => { states.push('error'); errors.push(error); }});
  return {voice, mic, convai, turns, answered, states, replies, errors, stt, capture, speech, runTurns: turns};
}

test('recognition feeds the add-on turn: the words replace the placeholder, the finish-time context rides along, the turn is not published twice', async () => {
  const f = rig();
  await f.mic.start(first, addonVoiceConfig(first));
  assert.deepEqual(f.states, ['starting', 'recording']);
  f.capture.emit(Buffer.alloc(3200));
  await f.mic.finish(first.requestId, {input: second, config: addonVoiceConfig(second)});
  assert.equal(f.turns.length, 1);
  const turn = f.turns[0];
  assert.equal(turn.input.text, 'take me to Afterlife', 'the recognised words, not "[Microphone]"');
  assert.equal(turn.userText, 'take me to Afterlife');
  assert.equal(turn.input.profileKey, KEY);
  assert.deepEqual(turn.input.addon.blocks, second.addon.blocks, 'the context the game refreshed at finish');
  assert.equal(turn.input.journal.at, 2);
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].userText, 'take me to Afterlife', 'a group round needs the words for the next speakers');
  assert.equal(f.replies[0].published, true);
  assert.equal(f.replies[0].text, '', 'the microphone reply step has nothing left to speak');
  assert.deepEqual(f.states, ['starting', 'recording', 'reply', 'off']);
  assert.deepEqual(f.capture.log, ['begin', 'end', 'abort']);
  assert.ok(f.stt.log.some(line => line.startsWith('finish:')));
});

test('no Convai connection, memory or warm-up is opened for an add-on voice turn', async () => {
  const f = rig();
  await f.mic.start(first, addonVoiceConfig(first));
  await f.mic.finish(first.requestId, {input: second, config: addonVoiceConfig(second)});
  assert.equal(f.convai.opened, 0, 'the Convai voice channel was never created or used');
  // The recording's route names no Convai character or end user, and asks for no cloud voice.
  const config = addonVoiceConfig(second);
  assert.equal(config.characterId, undefined);
  assert.equal(config.endUserId, undefined);
  assert.equal(config.sessionId, undefined);
  assert.equal(config.ttsEnabled, false);
  // In the bridge: the add-on branches of the microphone poll never reach a Convai step.
  const bridge = source('./convai-bridge.mjs');
  const start = bridge.indexOf('else if (addonVoice.voice(input)) {');
  const startBranch = bridge.slice(start, bridge.indexOf('\n      else {', start));
  const finishBranch = bridge.slice(bridge.indexOf("else if (command.action === 'finish' && addonVoice.voice(input)) {"), bridge.indexOf("else if (command.action === 'finish') {"));
  const watch = bridge.slice(bridge.indexOf('if (addonVoice.voice(recording.input)) {'), bridge.indexOf('else if (!owner ||'));
  assert.ok(startBranch.length > 200 && finishBranch.length > 100 && watch.length > 100, 'the branches were found');
  for (const [name, text] of [['start', startBranch], ['finish', finishBranch], ['watch', watch], ['addon-voice.mjs', source('./addon-voice.mjs')]]) {
    for (const banned of ['realtime', 'knowledgeRouter', 'admitPlayerConversation', 'connections.', 'playerMemory', 'convaiReply', 'phoneRealtime', 'quota.']) {
      assert.equal(text.includes(banned), false, `${name} uses ${banned}`);
    }
  }
  assert.doesNotMatch(source('./addon-voice.mjs'), /^import /m, 'the module reaches nothing by itself');
  assert.match(bridge, /const addonVoice = createAddonVoice\(\{isSpeaker: key => addonHost\.isSpeaker\(key\) \|\| customCharacters\.has\(key\), speech: mistralSpeech,/);
  assert.match(bridge, /const mic = new MicrophoneSession\(\{hostFactory: addonVoice\.hostFactory\(\(\) => realtime\.voiceChannel\(\)\),/);
  // Its reply step and its model-voice step skip the Convai text/voice route.
  assert.match(bridge, /prepareReply: async \(input, signal\) => \{\n    if \(addonVoice\.voice\(input\) \|\| localVoice\.playbackEnabled === false\) return;/);
  assert.match(bridge, /onReply: async \(input, result, signal\) => \{\n    if \(addonVoice\.voice\(input\)\) return;/);
});

test('one recogniser for every provider: the Mistral route\'s own, never a Convai session', () => {
  const bridge = source('./convai-bridge.mjs');
  // The recogniser object the Mistral route attaches to the hosts is the one the add-on voice is given.
  assert.match(bridge, /const englishStt = new LocalStt\(/);
  assert.match(bridge, /const mistralSpeech = createLocalSpeech\(\{\n  stt: englishStt,/);
  assert.match(bridge, /attachTextProvider\(host, \{provider: mistral, mistral: mistralHost, speech: mistralSpeech,/);
  // The English recogniser and, per multilingual pack, one more of the same class in the same stack (bridge/speech-language.mjs): no second capture page.
  assert.equal(bridge.match(/new LocalStt\(/g).length, 2, 'the English recogniser and the packs, no second recognition stack');
  assert.equal(bridge.match(/new LocalSttCapture\(/g).length, 1);
  // It takes no provider: the same channel serves a Convai, Mistral or Local AI player.
  const voice = createAddonVoice({isSpeaker: () => true, speech: {voiceChannel: ({reply}) => ({reply})}, currentFor() {}, runTurn() {}, answerError() {}});
  assert.equal(typeof voice.channel().reply, 'function');
});

test('the main mod is unchanged without add-ons: every other recording gets the Convai or Mistral channel exactly as before', async () => {
  for (const isSpeaker of [() => false, key => key === KEY]) {
    const f = rig({isSpeaker});
    const ordinary = {...first, profileKey: 'judy-alvarez', entity: '42ULL', addon: undefined};
    const seen = [];
    const factory = f.voice.hostFactory((input, config) => { seen.push([input, config]); return {tag: 'convai'}; });
    const config = {characterId: 'c', endUserId: 'u', scope: 'private'};
    assert.deepEqual(factory(ordinary, config), {tag: 'convai'});
    assert.deepEqual(seen, [[ordinary, config]], 'the input and config pass through untouched');
  }
  // With no add-on the host knows no speaker: no input is ever an add-on voice.
  const none = rig({isSpeaker: () => false});
  assert.equal(none.voice.voice(first), false);
  assert.equal(none.voice.voice(undefined), false);
  // The session itself hands the factory the recording it is starting (what routes it).
  const received = [];
  const session = new MicrophoneSession({hostFactory: (input, config) => { received.push([input, config]); return {beginVoice: async () => ({}), finishVoice: async () => ({}), close: async () => {}}; },
    onState: async () => {}, onReply: async () => {}, onError: async () => {}, minRecordMs: 0});
  await session.start(first, {characterId: 'x'});
  assert.equal(received[0][0], first);
  assert.deepEqual(received[0][1], {characterId: 'x'});
  await session.cancel();
});

test('microphone lease and cancel work for a profile key outside the roster', async () => {
  // Cancel while recording: the capture and the recogniser are released, nothing is answered.
  let f = rig();
  await f.mic.start(first, addonVoiceConfig(first));
  await f.mic.cancel();
  assert.deepEqual(f.capture.log, ['begin', 'abort']);
  assert.ok(f.stt.log.some(line => line.startsWith('cancel:')));
  assert.equal(f.mic.current, null);
  assert.deepEqual(f.states, ['starting', 'recording', 'off']);
  assert.equal(f.turns.length, 0);
  assert.equal(f.convai.opened, 0);
  // A new recording replaces the old one (the lease passes on): only the second one is answered.
  f = rig();
  await f.mic.start(first, addonVoiceConfig(first));
  const next = {...first, requestId: '9-2-88ULL', generation: 2};
  await f.mic.start(next, addonVoiceConfig(next));
  assert.equal(f.mic.current.requestId, next.requestId);
  await f.mic.finish(next.requestId, {input: next, config: addonVoiceConfig(next)});
  assert.deepEqual(f.turns.map(turn => turn.input.requestId), [next.requestId]);
  // A finish for another request changes nothing; one whose speaker changed retires the recording without a turn.
  f = rig();
  await f.mic.start(first, addonVoiceConfig(first));
  await f.mic.finish('other-request');
  assert.equal(f.mic.current.requestId, first.requestId);
  const moved = {...second, profileKey: 'judy-alvarez'};
  await f.mic.finish(first.requestId, {input: moved, config: addonVoiceConfig(moved)});
  assert.equal(f.turns.length, 0, 'the recording never goes to another route');
  assert.match(f.errors[0].message, /no longer matches/);
  assert.equal(f.mic.current, null);
  assert.deepEqual(f.capture.log, ['begin', 'abort']);
  // A group voice recording keeps its identity: a changed audience cancels it.
  f = rig();
  const group = {...first, group: {id: 'g1', index: 1, total: 2, audience: [KEY], heard: []}};
  await f.mic.start(group, addonVoiceConfig(group));
  const widened = {...group, group: {...group.group, audience: [KEY, 'judy-alvarez']}};
  await f.mic.finish(group.requestId, {input: widened, config: addonVoiceConfig(widened)});
  assert.equal(f.turns.length, 0);
  // The route key of a group recording differs from a private one, so one cannot finish as the other.
  assert.notEqual(addonVoiceConfig(group).scope, addonVoiceConfig(first).scope);
});

test('a recording that held no speech, or a recogniser that is not installed, never reaches the turn route', async () => {
  let f = rig({stt: fakeStt({text: ''})});
  await f.mic.start(first, addonVoiceConfig(first));
  await f.mic.finish(first.requestId, {input: second, config: addonVoiceConfig(second)});
  assert.equal(f.turns.length, 0);
  assert.equal(f.errors[0].message, NO_SPEECH_ERROR);
  assert.equal(f.convai.opened, 0);
  f = rig({stt: fakeStt({available: false})});
  await f.mic.start(first, addonVoiceConfig(first));
  assert.equal(f.errors[0].code, 'local-stt-unavailable');
  assert.equal(f.turns.length, 0);
  assert.equal(f.convai.opened, 0, 'Convai is not the fallback');
  assert.equal(f.capture.log.includes('begin'), false, 'the microphone was never opened');
});

test('a turn that fails is answered as a service error; a cancelled one says nothing', async () => {
  let f = rig({runTurn: async () => { throw Error('Mistral is unreachable'); }});
  await f.mic.start(first, addonVoiceConfig(first));
  await f.mic.finish(first.requestId, {input: second, config: addonVoiceConfig(second)});
  assert.equal(f.answered.length, 1);
  assert.equal(f.answered[0].error.message, 'Mistral is unreachable');
  assert.equal(f.answered[0].input.requestId, first.requestId);
  assert.equal(f.errors.length, 0, 'the microphone is not blamed');
  assert.equal(f.replies[0].userText, 'take me to Afterlife');
  // The recording is no longer the live one when the failure comes.
  f = rig({runTurn: async () => { throw Error('cancelled'); }, currentOpen: false});
  await f.mic.start(first, addonVoiceConfig(first));
  await f.mic.finish(first.requestId, {input: second, config: addonVoiceConfig(second)});
  assert.equal(f.answered.length, 0);
});

test('live words from the recogniser reach the game while V speaks', async () => {
  const stt = fakeStt({partial: 'take me to'});
  const f = rig({stt});
  await f.mic.start(first, addonVoiceConfig(first));
  assert.equal(await f.mic.heard(), 'take me to');
  await f.mic.cancel();
});
