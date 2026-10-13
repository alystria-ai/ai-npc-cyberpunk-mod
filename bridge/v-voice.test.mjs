import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {V_VOICE_KEYS, V_MAX_CHARS, VVoice, VLine, loadVVoiceReferences, extraVoices, vGenderOf, vLineText, wavToPackets} from './v-voice.mjs';
import {TurnClock, withClock} from './turn-clock.mjs';
import {LocalPcmClient} from './local-pcm-client.mjs';
import {LocalPcmHost, ownedLocalPcmPacket} from './local-pcm-host.mjs';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';
import {parseTurnContext} from './turn-context.mjs';
import {INTERNAL_VOICE_KEYS, withoutVariants} from './voice-variants.mjs';

// ---- helpers (nothing here plays a sound) -------------------------------------------------------------------------------

function wav({seconds = 1, rate = 24000, channels = 1, bits = 16, level = 0.25} = {}) {
  const frames = Math.round(seconds * rate), align = channels * bits / 8, data = Buffer.alloc(frames * align);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const value = Math.round(level * 32767 * Math.sin(frame / 20));
    if (bits === 16) data.writeInt16LE(value, frame * align + channel * 2);
    else data.writeIntLE(value * 256, frame * align + channel * 3, 3);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * align, 28); header.writeUInt16LE(align, 32);
  header.writeUInt16LE(bits, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(predicate, label = 'condition') {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail('timed out waiting for ' + label);
    await sleep(2);
  }
}
const packet = (extra = {}) => ({version: 1, engine: 'pocket-tts', sampleRate: 24000, channels: 1, format: 'f32le',
  owner: '1'.repeat(32), id: 1, profile: 'v-male', modelSha256: '2'.repeat(64), index: 1, offsetFrames: 0, frames: 4800,
  pcm: new Float32Array(4800).fill(0.1), ...extra});
const typed = (extra = {}) => ({requestId: 'r1', profileKey: 'judy-alvarez', text: 'Hey Judy, how are you holding up?',
  turnContext: {version: 1, status: 'ready', gender: 'male', dialogueVolume: 0.8}, ...extra});

// ---- the reference clips ------------------------------------------------------------------------------------------------

async function clipFolder(rows) {
  const directory = await mkdtemp(join(tmpdir(), 'v-voice-test-'));
  const voices = {};
  for (const [gender, row] of Object.entries(rows)) {
    const bytes = row.bytes ?? wav({seconds: 2});
    await writeFile(join(directory, row.file ?? `v-${gender}.wav`), bytes);
    voices[gender] = {file: row.file ?? `v-${gender}.wav`, transcript: row.transcript ?? 'Some words V says.', sha256: row.sha256 ?? sha(bytes), seconds: 2};
  }
  await writeFile(join(directory, 'v-voice.json'), JSON.stringify({version: 1, voices}));
  return directory;
}

test('V’s two voices are registry entries only: never a profile, a route key or a name in a per-profile list', () => {
  assert.deepEqual([...INTERNAL_VOICE_KEYS].sort(), Object.values(V_VOICE_KEYS).sort());
  assert.deepEqual(withoutVariants(['judy-alvarez', 'judy-alvarez-v2', 'v-male', 'v-female', 'addon-skippy-gun']), ['judy-alvarez', 'addon-skippy-gun']);
});

test('both clips load from the first folder that has a manifest, with their key, hash and transcript', async t => {
  const directory = await clipFolder({male: {}, female: {transcript: 'Another line.'}});
  t.after(() => rm(directory, {recursive: true, force: true}));
  const found = await loadVVoiceReferences([join(directory, 'missing'), directory]);
  assert.equal(found.directory, directory);
  assert.deepEqual(Object.keys(found.voices).sort(), ['female', 'male']);
  assert.equal(found.voices.male.key, 'v-male'); assert.equal(found.voices.female.key, 'v-female');
  assert.equal(found.voices.female.transcript, 'Another line.');
  assert.match(found.voices.male.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(extraVoices(found).map(voice => voice.key).sort(), ['v-female', 'v-male']);
  assert.deepEqual(Object.keys(extraVoices(found)[0]).sort(), ['key', 'reference', 'sha256', 'transcript']);
});

test('a clip that does not match its hash, or is missing, is left out; no manifest at all is an empty result, never an error', async t => {
  const bytes = wav({seconds: 2});
  const directory = await clipFolder({male: {bytes, sha256: 'a'.repeat(64)}, female: {}});
  t.after(() => rm(directory, {recursive: true, force: true}));
  const lines = [];
  const found = await loadVVoiceReferences([directory], {log: line => lines.push(line)});
  assert.deepEqual(Object.keys(found.voices), ['female']);
  assert.equal(lines.length, 1); assert.match(lines[0], /male clip not used/);
  const empty = await loadVVoiceReferences([join(directory, 'nothing-here')]);
  assert.deepEqual(empty, {directory: null, voices: {}});
  await rm(join(directory, 'v-female.wav'));
  const quiet = [];
  assert.deepEqual((await loadVVoiceReferences([directory], {log: line => quiet.push(line)})).voices, {}, 'a missing file leaves that gender out');
  assert.equal(quiet.length, 1, 'only the hash mismatch is reported, a plainly missing file is not');
});

test('a manifest with an unsafe file name or a bad transcript is not used', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'v-voice-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const bytes = wav({seconds: 2});
  await writeFile(join(directory, 'v-male.wav'), bytes);
  await writeFile(join(directory, 'v-voice.json'), JSON.stringify({version: 1, voices: {
    male: {file: '../v-male.wav', transcript: 'x', sha256: sha(bytes)},
    female: {file: 'v-male.wav', transcript: '   ', sha256: sha(bytes)}}}));
  const lines = [];
  const found = await loadVVoiceReferences([directory], {log: line => lines.push(line)});
  assert.deepEqual(found.voices, {});
  assert.equal(lines.length, 2);
});

// ---- the line, the gender and the audio ---------------------------------------------------------------------------------

test('V\'s gender comes from the turn context only', () => {
  assert.equal(vGenderOf({gender: 'male'}), 'male');
  assert.equal(vGenderOf({gender: 'female'}), 'female');
  // V's voice tone wins over the resolved gender: a female-bodied V with the male voice speaks with the male clip.
  assert.equal(vGenderOf({gender: 'female', voice: 'male'}), 'male');
  assert.equal(vGenderOf({gender: 'male', voice: 'female'}), 'female');
  for (const value of [undefined, null, {}, {gender: 'robot'}, {gender: 'Female'}]) assert.equal(vGenderOf(value), null);
  assert.equal(V_VOICE_KEYS.male, 'v-male'); assert.equal(V_VOICE_KEYS.female, 'v-female');
});

test('the spoken line is one clean line, cut on a sentence end when it is too long, and empty text says nothing', () => {
  assert.equal(vLineText('  Hello\n\tthere,\u0007 V.  '), 'Hello there, V.');
  for (const value of ['', '   ', '...', '!?', undefined, null, 5]) assert.equal(vLineText(value), null);
  const long = 'First sentence is here. ' + 'word '.repeat(80);
  const cut = vLineText(long);
  assert.ok(cut.length <= V_MAX_CHARS);
  assert.equal(vLineText('A short one.'), 'A short one.');
  const sentences = vLineText(('This sentence ends here. '.repeat(20)).trim());
  assert.ok(sentences.endsWith('here.') && sentences.length <= V_MAX_CHARS, 'a long text ends on a sentence');
  assert.ok(vLineText('x'.repeat(500)).length <= V_MAX_CHARS, 'one long word is still bounded');
});

test('a rendered WAV becomes in-order 24 kHz mono packets the local renderer accepts', () => {
  const bytes = wav({seconds: 3.5});
  const {packets, frames} = wavToPackets(bytes, {profile: 'v-male'});
  assert.equal(frames, 84000);
  assert.deepEqual(packets.map(item => item.frames), [48000, 36000]);
  let sent = 0, last = 0, identity;
  for (const [index, item] of packets.entries()) {
    const owned = ownedLocalPcmPacket(item, {token: 'v-test', frames: sent, index, identity});
    identity = owned.identity; sent += item.frames; last = item.index;
  }
  assert.equal(sent, frames); assert.equal(last, 2);
});

test('other sample rates and channel counts are converted: 48 kHz stereo halves in length, 24-bit decodes', () => {
  const stereo = wavToPackets(wav({seconds: 1, rate: 48000, channels: 2}), {profile: 'v-female'});
  assert.equal(stereo.frames, 24000);
  assert.ok(stereo.packets[0].pcm.every(value => Number.isFinite(value) && Math.abs(value) <= 1));
  const deep = wavToPackets(wav({seconds: 0.5, bits: 24}), {profile: 'v-female'});
  assert.equal(deep.frames, 12000);
  assert.ok(Math.max(...deep.packets[0].pcm) > 0.2 && Math.max(...deep.packets[0].pcm) < 0.3);
  assert.throws(() => wavToPackets(Buffer.from('not a wav')), /WAV/);
});

test('the game\'s dialogue volume rides along in the parsed turn context and never makes an empty snapshot count', () => {
  const parsed = parseTurnContext({version: 1, status: 'ready', hour: 3, minute: 4, gender: 'female', dialogueVolume: 0.42});
  assert.equal(parsed.dialogueVolume, 0.42); assert.equal(parsed.gender, 'female');
  for (const bad of [-0.1, 1.5, NaN, '0.5', null]) assert.equal(parseTurnContext({version: 1, status: 'ready', hour: 3, minute: 4, dialogueVolume: bad}).dialogueVolume, undefined);
  assert.deepEqual(parseTurnContext({version: 1, status: 'ready', dialogueVolume: 0.5}), {version: 1, status: 'unavailable'});
});

// ---- the stage clock ----------------------------------------------------------------------------------------------------

test('a stage clock listener fires once, on the first mark, or at once when the mark already exists', () => {
  const clock = new TurnClock({now: () => 100});
  const seen = [];
  clock.on('ttsSent', at => seen.push(['first', at]));
  assert.deepEqual(seen, []);
  clock.mark('ttsSent', 150); clock.mark('ttsSent', 160); clock.remark('ttsSent', 170);
  assert.deepEqual(seen, [['first', 150]], 'once, on the first mark only');
  clock.on('ttsSent', at => seen.push(['late', at]));
  assert.deepEqual(seen.at(-1), ['late', clock.at('ttsSent')]);
  clock.on('x', () => { throw Error('a listener never fails a mark'); });
  assert.doesNotThrow(() => clock.mark('x'));
});

// ---- the feature's gate ---------------------------------------------------------------------------------------------------

function feature(extra = {}) {
  const calls = {play: [], stream: [], render: [], prepare: [], warm: 0, logs: [], reports: []};
  const voice = new VVoice({
    voices: {male: {key: 'v-male'}, female: {key: 'v-female'}},
    planFor: () => ({engine: 'pocket', language: 'en'}),
    ready: () => true,
    isLocal: () => true,
    stream: async (key, text, options) => { calls.stream.push([key, text]); await options.onPcm(packet({profile: key})); return {frames: 4800}; },
    render: async (key, text, options) => { calls.render.push([key, text, options.language]); return {audio: wav({seconds: 1}).toString('base64')}; },
    play: async (config, producer, options) => { calls.play.push(config); await producer(async () => {}, {signal: options.signal}); },
    prepare: async key => { calls.prepare.push(key); },
    warm: async () => { calls.warm++; },
    log: line => calls.logs.push(line),
    report: (input, summary) => calls.reports.push(summary),
    ...extra});
  voice.update({vVoice: true});
  return {voice, calls};
}

test('the setting is off by default and follows runtime/settings.json', () => {
  const voice = new VVoice({voices: {male: {key: 'v-male'}}});
  assert.equal(voice.enabled, false);
  assert.equal(voice.update({}), false); assert.equal(voice.update({vVoice: 'yes'}), false);
  assert.equal(voice.update({vVoice: true}), true); assert.equal(voice.enabled, true);
  assert.equal(voice.update({vVoice: true}), false);
  assert.equal(voice.update({vVoice: false}), true); assert.equal(voice.enabled, false);
});

test('only a typed line of the player gets a V line: never speech, a reaction, a phone chat, an add-on or a later group speaker', () => {
  const {voice} = feature();
  assert.equal(voice.skipReason(typed()), null);
  assert.equal(voice.skipReason(typed({group: {index: 1, total: 2}})), null);
  for (const extra of [{source: 'microphone'}, {reaction: {kind: 'battle'}}, {channel: 'phone'}, {addon: {id: 'x'}}, {group: {index: 2, total: 2}}])
    assert.notEqual(voice.skipReason(typed(extra)), null, JSON.stringify(extra));
  voice.update({vVoice: false});
  assert.equal(voice.skipReason(typed()), 'off');
  assert.equal(voice.start(typed()), null);
});

test('off, or with no clips, nothing is started and nothing is loaded', () => {
  const {voice, calls} = feature({voices: {}});
  assert.equal(voice.start(typed()), null);
  assert.equal(voice.start(typed()), null);
  assert.equal(calls.logs.length, 1, 'the missing clips are reported once');
  assert.deepEqual(calls.play, []);
  voice.warmUp();
  assert.equal(calls.warm, 0);
});

test('the voice is chosen by V\'s gender from the turn context; an unknown gender, volume or muted game says nothing', async () => {
  const {voice, calls} = feature();
  const male = voice.start(typed()); await male.finished;
  const female = voice.start(typed({turnContext: {version: 1, status: 'ready', gender: 'female', dialogueVolume: 0.5}})); await female.finished;
  assert.deepEqual(calls.stream.map(row => row[0]), ['v-male', 'v-female']);
  assert.equal(voice.start(typed({turnContext: {version: 1, status: 'ready', dialogueVolume: 0.5}})), null);
  assert.equal(voice.start(typed({turnContext: undefined})), null);
  assert.equal(voice.start(typed({turnContext: {version: 1, status: 'ready', gender: 'male'}})), null, 'volume unknown');
  assert.equal(voice.start(typed({turnContext: {version: 1, status: 'ready', gender: 'male', dialogueVolume: 0}})), null, 'game muted');
  assert.equal(voice.start(typed({text: '...'})), null);
  assert.ok(calls.logs.length >= 2 && calls.logs.length <= 3, 'each reason is reported once');
});

test('a Convai-voice turn, an unsupported language or a voice the chosen backend lacks gives no V line (and loads nothing)', () => {
  for (const extra of [{planFor: () => ({engine: 'convai', language: 'en'})}, {planFor: () => null}, {ready: () => false}]) {
    const {voice, calls} = feature(extra);
    assert.equal(voice.start(typed()), null);
    assert.deepEqual(calls.play.concat(calls.stream, calls.render), []);
  }
});

// ---- one line ---------------------------------------------------------------------------------------------------------------

// A stand-in for the renderer host: runs the producer, then reports the clock the way LocalPcmHost does.
function renderer({audibleAfter = 1, endAfter = 3, onFrame: seen = []} = {}) {
  const state = {controls: [], produced: false, played: false, aborted: false};
  const play = async (config, producer, options) => {
    state.config = config;
    options.signal.addEventListener('abort', () => { state.aborted = true; }, {once: true});
    const emitted = [];
    let failure;
    const producing = producer(async item => { emitted.push(item); }, {signal: options.signal}).then(() => { state.produced = true; }, error => { failure = error; });
    for (let poll = 0; poll < endAfter + 40; poll++) {
      if (failure) throw failure;
      if (options.signal.aborted || !(await options.current())) throw Error('cancelled');
      const control = options.onFrame({receivedFrames: emitted.length ? 4800 : 0, ended: state.produced && poll >= endAfter, positionSeconds: 0});
      state.controls.push(control);
      if (state.produced && poll >= endAfter) break;
      await sleep(1);
    }
    await producing; if (failure) throw failure; state.played = true; state.emitted = emitted;
  };
  return {play, state};
}

function line(extra = {}, hostOptions) {
  const host = renderer(hostOptions);
  const logs = [], summaries = [];
  const clock = new TurnClock();
  const made = new VLine({input: typed(), key: 'v-male', text: 'Hello Judy.', plan: {engine: 'pocket', language: 'en'}, volume: 0.6,
    play: host.play, stream: async (key, text, options) => { await options.onPcm(packet()); return {}; },
    render: async () => ({audio: wav({seconds: 1}).toString('base64')}), clock, log: item => logs.push(item),
    onSettled: summary => summaries.push(summary), ...extra});
  return {line: made, host, logs, summaries, clock};
}

test('a line that is spoken: audible once the renderer holds audio, blocks the reply until it ends, then clears', async () => {
  const {line: made, host, summaries} = line();
  assert.equal(made.state, 'synth');
  await until(() => made.state === 'playing', 'the line to become audible');
  assert.equal(made.holds(), true, 'the reply waits while V is audible');
  assert.equal(made.blocking, true);
  await made.clear;
  assert.equal(made.state, 'done');
  assert.equal(made.holds(), false);
  await made.finished;
  assert.equal(host.state.played, true);
  assert.deepEqual(host.state.controls.at(-1), {allow: true, paused: false, volume: 0.6, pan: 0}, 'played at the game\'s dialogue volume, with no spatial pan');
  assert.equal(host.state.config.text, 'Hello Judy.');
  assert.match(host.state.config.token, /^v-[0-9a-f]{16}$/);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].result, 'played');
  for (const name of ['voiceStart', 'ttsSent', 'firstPcm', 'synthDone', 'audible', 'ended']) assert.ok(name in summaries[0].marks, name);
  assert.ok(!('dropped' in summaries[0].marks));
});

test('the reply ready before V is audible drops V: the reply never waits for synthesis', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const {line: made, summaries} = line({stream: async (key, text, options) => { await gate; await options.onPcm(packet()); return {}; }});
  assert.equal(made.holds(), false, 'not audible yet: the reply is not held');
  assert.equal(made.state, 'dropped'); assert.equal(made.reason, 'slower-than-reply');
  await made.clear;
  release();
  await made.finished;
  assert.equal(summaries.length, 1); assert.equal(summaries[0].reason, 'slower-than-reply');
  assert.equal(made.holds(), false);
});

test('the companion\'s own voice request stops a local V line that is not audible yet, but never one that is playing', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const slow = line({stream: async (key, text, options) => { await gate; await options.onPcm(packet()); return {}; }});
  slow.line.companionVoiceStarted();
  assert.equal(slow.line.state, 'dropped'); assert.equal(slow.line.reason, 'reply-voice-started');
  release(); await slow.line.finished;

  const playing = line();
  await until(() => playing.line.state === 'playing', 'audible');
  playing.line.companionVoiceStarted();
  assert.equal(playing.line.state, 'playing', 'an audible line is not cut');
  await playing.line.clear;

  let free;
  const cloudGate = new Promise(done => { free = done; });
  const cloud = line({local: false, stream: async (key, text, options) => { await cloudGate; await options.onPcm(packet()); return {}; }});
  cloud.line.companionVoiceStarted();
  assert.equal(cloud.line.state, 'synth', 'a cloud voice shares no worker with the reply');
  free(); await until(() => cloud.line.state === 'playing' || cloud.line.settled, 'cloud line'); await cloud.line.clear;
});

test('a failing synthesis or renderer drops the line quietly: one log line, the clear resolves, nothing throws', async () => {
  const {line: made, logs, summaries} = line({stream: async () => { throw Error('Mistral voice error: 429'); }});
  await made.clear; await made.finished;
  assert.equal(made.state, 'dropped'); assert.equal(made.reason, 'failed');
  assert.equal(logs.length, 1); assert.match(logs[0], /429/);
  assert.equal(made.holds(), false);
  assert.equal(summaries.length, 1);
  const broken = line({play: async () => { throw Error('renderer page did not open'); }});
  await broken.line.clear;
  assert.equal(broken.line.reason, 'failed'); assert.equal(broken.logs.length, 1);
});

test('the turn ending (a newer message, a stop) stops the line, even while it is audible', async () => {
  const controller = new AbortController();
  const {line: made, host} = line({signal: controller.signal}, {endAfter: 500});
  await until(() => made.state === 'playing', 'audible');
  controller.abort();
  assert.equal(made.state, 'dropped'); assert.equal(made.reason, 'turn-ended');
  await made.finished;
  assert.equal(host.state.aborted, true);
  const already = new AbortController(); already.abort();
  const never = line({signal: already.signal});
  assert.equal(never.line.state, 'dropped');
  assert.equal(never.host.state.config, undefined, 'a turn that is already over starts nothing');
});

test('an OmniVoice line is rendered whole, converted to packets and played; another language is passed on', async () => {
  const rendered = [];
  const emitted = [];
  const host = async (config, producer, options) => { await producer(async item => { emitted.push(item); }, {signal: options.signal}); options.onFrame({receivedFrames: 1, ended: false}); options.onFrame({receivedFrames: 1, ended: true}); };
  const made = line({plan: {engine: 'omni', language: 'es'}, play: host,
    render: async (key, text, options) => { rendered.push([key, text, options.language]); return {audio: wav({seconds: 2.2, rate: 24000}).toString('base64')}; }});
  await made.line.clear; await made.line.finished;
  assert.deepEqual(rendered, [['v-male', 'Hello Judy.', 'es']]);
  assert.deepEqual(emitted.map(item => item.frames), [48000, 4800]);
  assert.equal(made.line.state, 'done');
  const english = [];
  const again = line({plan: {engine: 'omni', language: 'en'}, play: host, render: async (key, text, options) => { english.push(Object.hasOwn(options, 'language')); return {audio: wav().toString('base64')}; }});
  await again.line.finished; assert.deepEqual(english, [false]);
});

test('waitClear: a reply published as a whole waits for an audible V line, and drops one that is not audible', async () => {
  const playing = line({}, {endAfter: 12});
  await until(() => playing.line.state === 'playing', 'audible');
  const started = performance.now();
  await playing.line.waitClear();
  assert.equal(playing.line.state, 'done'); assert.ok(performance.now() - started >= 0);
  let release;
  const gate = new Promise(done => { release = done; });
  const slow = line({stream: async (key, text, options) => { await gate; await options.onPcm(packet()); return {}; }});
  await slow.line.waitClear();
  assert.equal(slow.line.reason, 'slower-than-reply');
  release(); await slow.line.finished;
  const controller = new AbortController();
  const long = line({}, {endAfter: 2000});
  await until(() => long.line.state === 'playing', 'audible');
  const waiting = long.line.waitClear(controller.signal);
  controller.abort(); await waiting;
  long.line.drop('test over'); await long.line.finished;
});

test('a second line waits for the first to be released, so two V lines never share the renderer', async () => {
  const {voice, calls} = feature({play: async (config, producer, options) => {
    calls.play.push(config.token);
    await producer(async () => {}, {signal: options.signal});
    options.onFrame({receivedFrames: 1, ended: false}); await sleep(20); options.onFrame({receivedFrames: 1, ended: true}); await sleep(20);
    calls.play.push('released ' + config.token);
  }});
  const first = voice.start(typed()), second = voice.start(typed({requestId: 'r2'}));
  await first.finished; await second.finished;
  assert.equal(calls.play.length, 4);
  assert.match(calls.play[1], /^released v-/, 'the first is released before the second starts');
  assert.notEqual(calls.play[0], calls.play[2]);
});

test('on the turn\'s clock: V\'s audible and end marks are recorded and the companion\'s ttsSent stops an unfinished local line', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const {voice} = feature({stream: async (key, text, options) => { await gate; await options.onPcm(packet()); return {}; },
    play: async (config, producer, options) => { await producer(async () => {}, {signal: options.signal}); }});
  const clock = new TurnClock();
  const made = voice.start(typed(), {clock});
  withClock(clock, () => clock.mark('ttsSent'));
  assert.equal(made.state, 'dropped'); assert.equal(made.reason, 'reply-voice-started');
  release(); await made.finished;
  assert.ok(clock.has('vDropped'));
  const second = feature();
  const clock2 = new TurnClock();
  const spoken = second.voice.start(typed(), {clock: clock2});
  await spoken.finished;
  assert.ok(clock2.has('vAudible') || clock2.has('vDropped'));
});

test('warming on the composer prepares the page and the voice that was used last, and one clip\'s voice at once', async () => {
  const both = feature();
  both.voice.warmUp(); await sleep(5);
  assert.equal(both.calls.warm, 1); assert.deepEqual(both.calls.prepare, [], 'two clips and no line yet: nothing to guess');
  await both.voice.start(typed({turnContext: {version: 1, status: 'ready', gender: 'female', dialogueVolume: 0.5}})).finished;
  both.voice.warmUp(); await sleep(5);
  assert.deepEqual(both.calls.prepare, ['v-female']);
  const seen = feature();
  seen.voice.noteGender(typed({turnContext: {version: 1, status: 'ready', gender: 'male'}}));
  seen.voice.noteGender(typed({turnContext: undefined}));
  seen.voice.warmUp(); await sleep(5);
  assert.deepEqual(seen.calls.prepare, ['v-male'], 'any typed turn tells which V is playing, even with the setting off');
  const one = feature({voices: {male: {key: 'v-male'}}});
  one.voice.warmUp(); await sleep(5);
  assert.deepEqual(one.calls.prepare, ['v-male']);
  const off = feature(); off.voice.update({vVoice: false}); off.voice.warmUp(); await sleep(5);
  assert.equal(off.calls.warm, 0);
});

// ---- with the real local renderer host and the real continuous speech ----------------------------------------------------

class OfflinePlayer {
  constructor() { this.frames = 0; this.controls = []; this.ended = false; this.error = null; }
  async open(value) { this.token = value.token; }
  async append(bytes, offset) { assert.equal(offset, this.frames); this.frames += bytes.length / 2; }
  snapshot() { return {state: 'playing', sampleRate: 24000, channels: 1, receivedFrames: this.frames, playedFrames: this.ended ? this.frames : 0,
    positionSeconds: this.ended ? this.frames / 24000 : 0, bufferedFrames: this.ended ? 0 : this.frames, ended: this.ended, error: this.error, underruns: 0}; }
  control(value) { this.controls.push({...value}); }
  async end(frames) { assert.equal(frames, this.frames); this.sealed = true; }
  finish() { this.ended = true; }
  fail(message) { this.error = message; }
  async stop() { this.stopped = true; }
}
function offlineHost() {
  const players = [];
  const host = new LocalPcmHost({pollMs: 3, timeoutMs: 5000, cleanupTimeoutMs: 100, createPage: async () => {
    const client = new LocalPcmClient({createPlayer: () => { const player = new OfflinePlayer(); players.push(player); return player; }});
    return {closed: false, window: {localPcm: client}, isClosed() { return this.closed; },
      async close() { this.closed = true; if (client.active) await client.stop(client.active.token); },
      async evaluate(fn, payload) { return runInNewContext(`(${fn.toString()})(payload)`, {window: this.window, payload}); }};
  }});
  return {host, players};
}

test('end to end on the real local renderer host: the Pocket-format packets are accepted, the control carries the game\'s volume, the line ends and the host is free again', async t => {
  const {host, players} = offlineHost();
  t.after(() => host.close());
  const made = new VLine({input: typed(), key: 'v-male', text: 'Hello Judy.', plan: {engine: 'pocket', language: 'en'}, volume: 0.37,
    play: (config, producer, options) => host.play(config, producer, options),
    stream: async (key, text, options) => { await options.onPcm(packet({index: 1, offsetFrames: 0})); await options.onPcm(packet({index: 2, offsetFrames: 4800})); return {frames: 9600}; }});
  await until(() => players[0]?.sealed, 'the renderer to be sealed');
  await until(() => made.state === 'playing', 'the line to be audible');
  assert.equal(made.holds(), true);
  assert.deepEqual(players[0].controls.at(-1), {allow: true, paused: false, volume: 0.37, pan: 0});
  players[0].finish();
  await made.clear; await made.finished;
  assert.equal(made.state, 'done');
  assert.equal(host.active, null, 'the host is free for the next line');
});

test('end to end with an OmniVoice WAV on the real local renderer host', async t => {
  const {host, players} = offlineHost();
  t.after(() => host.close());
  const made = new VLine({input: typed(), key: 'v-female', text: 'Hello Judy.', plan: {engine: 'omni', language: 'en'}, volume: 1,
    play: (config, producer, options) => host.play(config, producer, options),
    render: async () => ({audio: wav({seconds: 1.5, rate: 22050}).toString('base64')})});
  await until(() => players[0]?.sealed, 'the renderer to be sealed');
  assert.equal(players[0].frames, 36000, '1.5 s at 24 kHz after resampling from 22.05 kHz');
  players[0].finish();
  await made.finished;
  assert.equal(made.state, 'done');
});

test('the companion\'s continuous speech buffers silently while V is audible, publishes nothing, and starts the moment V ends', async () => {
  const owner = {requestId: 'reply-1', entity: 'judy-copy-2', generation: 7};
  let now = 10000;
  const events = [], states = [];
  const vLine = line({}, {endAfter: 40});
  const speech = new ConvaiContinuousSpeech({input: owner, profile: {key: 'judy-alvarez'}, token: 'continuous-1', now: () => now,
    signal: new AbortController().signal, current: async () => true,
    hold: () => vLine.line.holds(),
    readControl: async () => JSON.stringify({version: 1, id: 'continuous-1', ...owner, sequence: 1, updated: now, allow: true, paused: false, volume: 0.8, pan: 0}),
    writeState: async value => { events.push('state'); states.push(value); return true; },
    writeReply: async () => { events.push('reply'); return true; }});
  const snapshot = {version: 1, token: 'continuous-1', sampleRate: 24000, channels: 1, receivedFrames: 12000, positionSeconds: 0,
    text: 'Hey V.', textComplete: true, sourceComplete: false, ended: false, underruns: 0, state: 'buffering'};
  await until(() => vLine.line.state === 'playing', 'V to be audible');
  const quiet = await speech.frame(snapshot);
  assert.deepEqual(quiet, {allow: false, paused: true, volume: 0, pan: 0}, 'the reply gets the quiet control while V is audible');
  assert.deepEqual(events, [], 'nothing is published to the game while V is audible');
  vLine.line.whenClear(() => speech.wakeUp());
  await vLine.line.clear;
  const control = await speech.frame(snapshot);
  assert.equal(control.allow, true, 'the reply starts as soon as V has ended');
  assert.ok(events.includes('reply'));
});

// ---- the wiring in the bridge (the parts a unit test cannot run) ----------------------------------------------------------

const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');

test('the bridge starts V\'s line after the reply is requested, not for a look-ahead, and gates both reply paths', () => {
  const replying = bridge.indexOf('const replying = respond(');
  const started = bridge.indexOf('vVoice.start(input, {signal: controller.signal, clock})');
  assert.ok(replying > 0 && started > replying, 'the text request is under way before V\'s line is started');
  assert.match(bridge, /if \(!ahead\) vLine = vVoice\.start/);
  assert.match(bridge, /hold: \(\) => ahead\?\.isHeld\(\) === true \|\| current\.vLine\?\.\(\)\?\.holds\(\) === true/);
  assert.match(bridge, /await current\.vLine\?\.\(\)\?\.waitClear\(signal\)/);
  assert.match(bridge, /if \(vVoice\.update\(settings\)\)/);
  assert.match(bridge, /vVoice\.warmUp\(\)/);
  assert.match(bridge, /extra: extraVoices\(vVoiceReferences\)/);
});

test('V\'s line is never given a local model of its own: it goes through the chosen voice only', () => {
  const block = bridge.slice(bridge.indexOf('const vVoice = new VVoice('), bridge.indexOf('// A returning shopkeeper\'s memory'));
  assert.match(block, /localVoice\.synthesizeStream\(/);
  assert.match(block, /localVoice\.synthesize\(/);
  assert.match(block, /localVoice\.prepareProfile\(/);
  assert.doesNotMatch(block, /new (Pocket|Resident|Omni)/, 'no voice engine is constructed for V');
});
