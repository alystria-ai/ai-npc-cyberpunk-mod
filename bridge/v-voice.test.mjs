import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {V_VOICE_KEYS, V_ENGINES, V_MAX_CHARS, V_HANDOFF_LEAD_MS, V_GRACE_MS, V_RESCUE_BUDGET_MS, VVoice, VLine, loadVVoiceReferences, extraVoices, vGenderOf, vLineText, wavToPackets, vSettingsFor} from './v-voice.mjs';
import {TurnClock, withClock} from './turn-clock.mjs';
import {PcmEdges, fadeGain} from './pcm-edges.mjs';
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
  const calls = {play: [], stream: [], prepare: [], warm: 0, logs: [], tally: [], reports: []};
  const voice = new VVoice({
    voices: {male: {key: 'v-male'}, female: {key: 'v-female'}},
    planFor: () => ({engine: 'pocket', language: 'en'}),
    ready: () => true,
    isLocal: () => true,
    stream: async (key, text, options) => { calls.stream.push([key, text]); await options.onPcm(packet({profile: key})); return {frames: 4800}; },
    play: async (config, producer, options) => { calls.play.push(config); await producer(async () => {}, {signal: options.signal}); },
    prepare: async key => { calls.prepare.push(key); },
    warm: async () => { calls.warm++; },
    log: line => (/^this session:/.test(line) ? calls.tally : calls.logs).push(line), graceMs: 0,
    report: (input, summary) => calls.reports.push(summary),
    ...extra});
  voice.update({vVoice: true});
  return {voice, calls};
}

test('the setting is on unless the player turned it off, and follows runtime/settings.json', () => {
  const voice = new VVoice({voices: {male: {key: 'v-male'}}});
  assert.equal(voice.enabled, false, 'until the settings are read');
  assert.equal(voice.update(undefined), false); assert.equal(voice.enabled, false);
  assert.equal(voice.update({}), true, 'a file that never stored it counts as on'); assert.equal(voice.enabled, true);
  assert.equal(voice.update({vVoice: 'yes'}), false); assert.equal(voice.enabled, true);
  assert.equal(voice.update({vVoice: true}), false);
  assert.equal(voice.update({vVoice: false}), false, 'a saved false the player never chose is the old default: still on'); assert.equal(voice.enabled, true);
  assert.equal(voice.update({vVoice: false, vVoiceChosen: false}), false); assert.equal(voice.enabled, true);
  assert.equal(voice.update({vVoice: false, vVoiceChosen: true}), true); assert.equal(voice.enabled, false, 'a chosen false is kept');
  assert.equal(voice.update({}), true, 'no stored value is on again'); assert.equal(voice.update({vVoice: false, vVoiceChosen: true}), true);
  assert.equal(voice.update({vVoice: true}), true); assert.equal(voice.enabled, true);
});

test('only a typed line of the player gets a V line: never speech, a reaction, an add-on remark, a phone chat or a later group speaker', () => {
  const {voice} = feature();
  assert.equal(voice.skipReason(typed()), null);
  assert.equal(voice.skipReason(typed({group: {index: 1, total: 2}})), null);
  // A line typed to an add-on's voice (the Delamain cab, Skippy) is a typed line: V is heard (live 2026-10-16: silent in the cab).
  assert.equal(voice.skipReason(typed({addon: {id: 'delamain-cab', speaker: 'delamain'}})), null);
  for (const extra of [{source: 'microphone'}, {reaction: {kind: 'battle'}}, {reaction: {kind: 'addon'}, addon: {id: 'x'}}, {channel: 'phone'}, {group: {index: 2, total: 2}}])
    assert.notEqual(voice.skipReason(typed(extra)), null, JSON.stringify(extra));
  voice.update({vVoice: false, vVoiceChosen: true});
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

test('a plan for an engine V never uses (the Convai voice), no plan, OmniVoice with nothing to render it, or a Pocket voice that is not routed gives no V line and loads nothing', () => {
  for (const extra of [{planFor: () => ({engine: 'convai', language: 'en'})}, {planFor: () => ({engine: 'omni', language: 'en'})}, {planFor: () => null}, {ready: () => false}]) {
    const {voice, calls} = feature(extra);
    assert.equal(voice.start(typed()), null);
    assert.deepEqual(calls.play.concat(calls.stream), []);
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
    clock, log: item => logs.push(item), graceMs: 0,
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
  assert.equal(both.calls.warm, 1); assert.deepEqual(both.calls.prepare, ['v-male', 'v-female'], 'two clips, nothing known yet (a first session): both are prepared, one after the other');
  await both.voice.start(typed({turnContext: {version: 1, status: 'ready', gender: 'female', dialogueVolume: 0.5}})).finished;
  both.voice.warmUp(); await sleep(5);
  assert.deepEqual(both.calls.prepare, ['v-male', 'v-female', 'v-female']);
  const seen = feature();
  seen.voice.noteGender(typed({turnContext: {version: 1, status: 'ready', gender: 'male'}}));
  seen.voice.noteGender(typed({turnContext: undefined}));
  seen.voice.warmUp(); await sleep(5);
  assert.deepEqual(seen.calls.prepare, ['v-male'], 'any typed turn tells which V is playing, even with the setting off');
  const one = feature({voices: {male: {key: 'v-male'}}});
  one.voice.warmUp(); await sleep(5);
  assert.deepEqual(one.calls.prepare, ['v-male']);
  const off = feature(); off.voice.update({vVoice: false, vVoiceChosen: true}); off.voice.warmUp(); await sleep(5);
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

// ---- V's own engine: Pocket (the companions' worker, or a worker of V's own) or the Voxtral cloud voice -------------------------

// The engine is V's setting (runtime/settings.json vVoiceEngine), whatever the companions use. `main`: the companions' voice is the
// Pocket worker itself (it speaks V, one job at a time). `own`: V has a Pocket worker of its own (the companions use OmniVoice, a
// cloud voice or the Convai voice). `cloud`: the Voxtral voice.
function engineFeature({engine = 'pocket', main = false, own = false, ownReady = true, problem = null, endAfter = 30, language = 'en', stream, ownStream, cloudStream, cloudLanguages = []} = {}) {
  const host = renderer({endAfter});
  const seen = {own: [], ownReady: [], ownPrepare: [], cloud: [], cloudWarm: [], main: [], mainPrepare: []};
  const helper = {
    speaks: () => own,
    ready: key => { seen.ownReady.push(key); return ownReady; },
    stream: async (key, text, options) => {
      seen.own.push([key, text]);
      if (ownStream) return ownStream(key, text, options);
      await options.onPcm(packet({profile: key})); return {frames: 4800};
    },
    prepare: async key => { seen.ownPrepare.push(key); }};
  const cloud = {
    problem: () => (typeof problem === 'function' ? problem() : problem),
    stream: async (key, text, options) => {
      seen.cloud.push([key, text]);
      if (cloudStream) return cloudStream(key, text, options);
      await options.onPcm(packet({profile: key})); return {frames: 4800};
    },
    speaks: language => cloudLanguages.includes(language),
    warm: key => { seen.cloudWarm.push(key); }};
  const made = feature({planFor: () => ({engine, language}), ready: () => main, helper, cloud, play: host.play,
    stream: async (key, text, options) => {
      seen.main.push([key, text]);
      if (stream) return stream(key, text, options);
      await options.onPcm(packet({profile: key})); return {frames: 4800};
    },
    prepare: async key => { seen.mainPrepare.push(key); }});
  made.voice.update({vVoice: true, vVoiceEngine: engine});
  return {...made, seen, host};
}

test('the engine is the player\'s choice: Pocket unless Voxtral is stored, and a change of it counts as a change', () => {
  const voice = new VVoice({voices: {male: {key: 'v-male'}}});
  assert.equal(voice.engine, 'pocket'); assert.deepEqual(V_ENGINES, ['pocket', 'voxtral', 'omni']);
  assert.equal(voice.update({}), true); assert.equal(voice.engine, 'pocket', 'a file that never stored it is Pocket');
  assert.equal(voice.update({vVoiceEngine: 'pocket'}), false);
  assert.equal(voice.update({vVoiceEngine: 'voxtral'}), true); assert.equal(voice.engine, 'voxtral');
  assert.equal(voice.update({vVoiceEngine: 'voxtral'}), false);
  assert.equal(voice.update({vVoiceEngine: 'omni'}), true); assert.equal(voice.engine, 'omni', 'OmniVoice is kept when the player chose it');
  assert.equal(voice.wantsPocket, false, 'OmniVoice for V loads no Pocket worker of any kind');
  for (const value of ['convai', 'POCKET', 'Omni', 7, null]) { voice.update({vVoiceEngine: 'voxtral'}); assert.equal(voice.update({vVoiceEngine: value}), true, String(value)); assert.equal(voice.engine, 'pocket', String(value)); }
  assert.equal(voice.wantsPocket, true);
  voice.update({vVoiceEngine: 'voxtral'}); assert.equal(voice.wantsPocket, false, 'the cloud engine needs no Pocket worker');
  voice.update({vVoiceEngine: 'pocket', vVoice: false, vVoiceChosen: true}); assert.equal(voice.wantsPocket, false, 'V off: no Pocket worker for V');
  assert.equal(new VVoice({voices: {}}).wantsPocket, false);
});

test('Pocket with the companions on Pocket: the shared worker speaks V, one job at a time, so the companion\'s own request stops an unfinished V line', async () => {
  const {voice, seen} = engineFeature({main: true});
  const clock = new TurnClock();
  const quick = voice.start(typed(), {clock});
  await quick.finished;
  assert.deepEqual(seen.main, [['v-male', 'Hey Judy, how are you holding up?']]);
  assert.deepEqual(seen.own.concat(seen.cloud, seen.ownReady), [], 'no other engine is asked');
  let release;
  const gate = new Promise(done => { release = done; });
  const slow = engineFeature({main: true, stream: async (key, text, options) => { await gate; await options.onPcm(packet({profile: key})); return {}; }});
  const slowClock = new TurnClock();
  const made = slow.voice.start(typed(), {clock: slowClock});
  withClock(slowClock, () => slowClock.mark('ttsSent'));
  assert.equal(made.state, 'dropped'); assert.equal(made.reason, 'reply-voice-started');
  release(); await made.finished;
});

test('Pocket with a worker of its own (companions on OmniVoice, a cloud voice or the Convai voice): audible in a few ms, never stopped by the companion\'s request, and the reply waits for its end', async () => {
  const {voice, seen, host} = engineFeature({own: true});
  const clock = new TurnClock();
  const made = voice.start(typed(), {clock});
  assert.ok(made, 'a line is started');
  await until(() => made.state === 'playing', 'V to be audible');
  withClock(clock, () => clock.mark('ttsSent'));
  assert.equal(made.state, 'playing', 'the companion\'s request does not stop V: a different worker');
  await made.waitClear();
  assert.equal(made.state, 'done'); assert.equal(made.holds(), false);
  assert.ok(clock.has('vAudible') && clock.has('vEnded') && !clock.has('vDropped'));
  await made.finished;
  assert.deepEqual(seen.own, [['v-male', 'Hey Judy, how are you holding up?']]);
  assert.deepEqual(seen.main.concat(seen.cloud), [], 'neither the companions\' worker nor the cloud is used');
  assert.equal(host.state.played, true);
});

test('with its own worker V is first and the companion second, in order, never overlapping: held while V is audible, released after it ends', async () => {
  const order = [];
  const {voice} = engineFeature({own: true, endAfter: 40});
  const made = voice.start(typed());
  made.whenClear(() => order.push('V ended'));
  await until(() => made.state === 'playing', 'V to be audible');
  order.push('V audible');
  for (let poll = 0; poll < 5; poll++) { assert.equal(made.holds(), true); await sleep(2); }
  await made.clear;
  assert.equal(made.holds(), false);
  order.push('reply may start');
  assert.deepEqual(order, ['V audible', 'V ended', 'reply may start']);
  await made.finished;
});

test('a line on V\'s own worker that is still waiting for its first audio is not stopped by the companion\'s request, but the reply never waits for it', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const {voice} = engineFeature({own: true, ownStream: async (key, text, options) => { await gate; await options.onPcm(packet({profile: key})); return {}; }});
  const clock = new TurnClock();
  const made = voice.start(typed(), {clock});
  withClock(clock, () => clock.mark('ttsSent'));
  assert.equal(made.state, 'synth', 'not stopped: nothing is shared');
  assert.equal(made.holds(), false, 'the reply is ready first: V is dropped, the reply is never delayed');
  assert.equal(made.reason, 'slower-than-reply');
  release(); await made.finished;
});

test('V\'s own worker still loading (or failed) gives no V line, asks for a due load, and uses no other engine', () => {
  const {voice, seen, calls} = engineFeature({own: true, ownReady: false});
  assert.equal(voice.start(typed()), null);
  assert.equal(voice.start(typed({requestId: 'r2'})), null);
  assert.deepEqual(seen.ownReady, ['v-male', 'v-male'], 'asking is what starts a due load');
  assert.deepEqual(calls.play.concat(seen.main, seen.own, seen.cloud), []);
  assert.ok(calls.logs.some(line => /not loaded yet/.test(line)));
});

test('a Pocket turn with no worker able to speak it gives no line and warms nothing', async () => {
  const {voice, seen, calls} = engineFeature({});          // not the companions' worker, no worker of V's own
  assert.equal(voice.start(typed()), null);
  voice.noteGender(typed()); voice.warmUp(); await sleep(5);
  assert.equal(calls.warm, 0); assert.deepEqual(seen.mainPrepare.concat(seen.ownPrepare, seen.cloudWarm), []);
  assert.ok(calls.logs.length <= 1);
});

test('Pocket speaks English only, and Voxtral only the languages its model lists: another language gives no V line (with one log line) and nothing is started', () => {
  for (const [engine, options] of [['pocket', {own: true}], ['pocket', {main: true}], ['pocket', {main: true, cloudLanguages: ['es']}], ['voxtral', {}], ['voxtral', {cloudLanguages: ['fr', 'de']}]]) {
    const made = engineFeature({engine, language: 'es', ...options});
    assert.equal(made.voice.start(typed()), null, engine);
    assert.equal(made.voice.start(typed()), null);
    assert.deepEqual(made.calls.play.concat(made.seen.main, made.seen.own, made.seen.cloud), []);
    assert.equal(made.calls.logs.length, 1); assert.match(made.calls.logs[0], /does not speak this language/);
  }
});

test('Voxtral 3: a line in a language the cloud voice speaks is spoken by it (plan language kept), and English is unchanged', async () => {
  for (const language of ['es', 'ja', 'en']) {
    const {voice, seen, host, calls} = engineFeature({engine: 'voxtral', language, cloudLanguages: ['es', 'ja']});
    const made = voice.start(typed({text: 'Hola Judy, como estas hoy?'}));
    assert.ok(made, language);
    assert.equal(made.plan.engine, 'voxtral'); assert.equal(made.plan.language, language);
    await made.finished;
    assert.deepEqual(seen.cloud, [['v-male', 'Hola Judy, como estas hoy?']], language);
    assert.deepEqual(seen.main.concat(seen.own), [], 'no Pocket worker is asked for anything');
    assert.equal(host.state.played, true); assert.equal(calls.reports[0].result, 'played');
  }
});

test('Voxtral: a line in another language tells the cloud voice its language (so it can clone from a voice language pack\'s V clip) and the log names that clip; English sends no language', async () => {
  for (const language of ['zh', 'en']) {
    const asked = [];
    const {voice, calls} = engineFeature({engine: 'voxtral', language, cloudLanguages: ['zh'], cloudStream: async (key, text, options) => { asked.push(options); await options.onPcm(packet({profile: key})); return {frames: 4800}; }});
    voice.cloud.languageSet = (key, spoken) => (spoken === 'zh' && key === 'v-male' ? 'multilingual/zh-cn/v-voice/v-male' : null);
    const made = voice.start(typed({text: '走吧，我们出发。'}));
    assert.ok(made, language); await made.finished;
    assert.equal(asked.length, 1, language);
    if (language === 'zh') {
      assert.equal(asked[0].language, 'zh');
      assert.ok(calls.logs.some(line => line.includes('V\'s line in zh is cloned from multilingual/zh-cn/v-voice/v-male')), calls.logs.join('|'));
    } else {
      assert.equal('language' in asked[0], false, 'an English line is exactly what it was');
      assert.equal(calls.logs.some(line => line.includes('is cloned from')), false);
    }
  }
});

test('Voxtral: V\'s line is asked of the cloud voice at once; no Pocket worker is touched, and the companion\'s request does not stop it', async () => {
  const {voice, seen, host, calls} = engineFeature({engine: 'voxtral'});
  const clock = new TurnClock();
  const made = voice.start(typed(), {clock});
  assert.ok(made);
  await until(() => made.state === 'playing', 'V to be audible');
  withClock(clock, () => clock.mark('ttsSent'));
  assert.equal(made.state, 'playing', 'a cloud voice shares nothing with the reply');
  await made.waitClear();
  assert.equal(made.state, 'done');
  await made.finished;
  assert.deepEqual(seen.cloud, [['v-male', 'Hey Judy, how are you holding up?']]);
  assert.deepEqual(seen.main.concat(seen.own, seen.ownReady, seen.mainPrepare, seen.ownPrepare), [], 'no Pocket worker is asked for anything');
  assert.equal(host.state.played, true);
  assert.equal(calls.reports[0].engine, 'voxtral'); assert.equal(calls.reports[0].result, 'played');
  for (const name of ['voiceStart', 'ttsSent', 'firstPcm', 'audible', 'ended']) assert.ok(name in calls.reports[0].marks, name);
});

test('Voxtral: a line that is not audible when the reply is ready is dropped, never waited for', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const {voice} = engineFeature({engine: 'voxtral', cloudStream: async (key, text, options) => { await gate; await options.onPcm(packet({profile: key})); return {}; }});
  const made = voice.start(typed(), {clock: new TurnClock()});
  assert.equal(made.holds(), false); assert.equal(made.reason, 'slower-than-reply');
  release(); await made.finished;
});

test('Voxtral cannot speak now (no key, a limit cooling down, no clip, Mature content): no line, one log line per reason, and never a local voice instead', async () => {
  let problem = 'no Mistral key';
  const {voice, seen, calls} = engineFeature({engine: 'voxtral', own: true, main: true, problem: () => problem});
  assert.equal(voice.start(typed()), null); assert.equal(voice.start(typed()), null);
  problem = 'a Mistral limit is cooling down';
  assert.equal(voice.start(typed()), null);
  assert.deepEqual(calls.logs.map(line => /no Mistral key|cooling down/.exec(line)?.[0]), ['no Mistral key', 'cooling down']);
  assert.deepEqual(seen.main.concat(seen.own, seen.cloud, seen.ownReady), [], 'no Pocket worker is used as a stand-in, not even a loaded one');
  assert.deepEqual(calls.play, []);
  voice.warmUp(); await sleep(5);
  assert.equal(calls.warm, 0); assert.deepEqual(seen.cloudWarm.concat(seen.mainPrepare, seen.ownPrepare), []);
  problem = null;
  await voice.start(typed()).finished;
  assert.deepEqual(seen.cloud.map(row => row[0]), ['v-male'], 'asked again as soon as it can speak');
});

test('Voxtral failing drops the line quietly: one ask (no retry that would arrive after the reply), no Pocket worker, nothing thrown', async () => {
  const {voice, seen, calls} = engineFeature({engine: 'voxtral', own: true, main: true, cloudStream: async () => { throw Error('Mistral voice error: 429'); }});
  const made = voice.start(typed(), {clock: new TurnClock()});
  await made.clear; await made.finished;
  assert.equal(made.state, 'dropped'); assert.equal(made.reason, 'failed');
  assert.equal(seen.cloud.length, 1);
  assert.deepEqual(seen.main.concat(seen.own), []);
  assert.equal(calls.logs.length, 1); assert.match(calls.logs[0], /429/);
});

test('warming on the composer: the page and the voice that was used last; Voxtral reads and encodes V\'s clip, Pocket prepares its voice where it is spoken', async () => {
  // Voxtral: with no line yet both clips are warmed, afterwards the one that was used.
  const cloud = engineFeature({engine: 'voxtral'});
  cloud.voice.warmUp(); await sleep(5);
  assert.equal(cloud.calls.warm, 1); assert.deepEqual(cloud.seen.cloudWarm, ['v-male', 'v-female']);
  assert.deepEqual(cloud.seen.mainPrepare.concat(cloud.seen.ownPrepare), [], 'nothing is prepared on a Pocket worker for the cloud voice');
  cloud.voice.noteGender(typed({turnContext: {version: 1, status: 'ready', gender: 'female'}}));
  cloud.voice.warmUp(); await sleep(5);
  assert.deepEqual(cloud.seen.cloudWarm.slice(2), ['v-female']);
  const one = engineFeature({engine: 'voxtral'}); one.voice.voices = {male: {key: 'v-male'}};
  one.voice.warmUp(); await sleep(5);
  assert.deepEqual(one.seen.cloudWarm, ['v-male']);
  // Pocket on V's own worker prepares there; on the companions' worker, there.
  const own = engineFeature({own: true});
  own.voice.warmUp(); await sleep(5);
  assert.equal(own.calls.warm, 1); assert.deepEqual(own.seen.ownPrepare, ['v-male', 'v-female'], 'two clips and nothing known: both, on the own worker');
  assert.deepEqual(own.seen.mainPrepare, []);
  own.voice.noteGender(typed()); own.voice.warmUp(); await sleep(5);
  assert.deepEqual(own.seen.ownPrepare, ['v-male', 'v-female', 'v-male']); assert.deepEqual(own.seen.mainPrepare, []);
  const main = engineFeature({main: true});
  main.voice.noteGender(typed()); main.voice.warmUp(); await sleep(5);
  assert.deepEqual(main.seen.mainPrepare, ['v-male']); assert.deepEqual(main.seen.ownPrepare, []);
  // V off warms nothing.
  const off = engineFeature({engine: 'voxtral'}); off.voice.update({vVoice: false, vVoiceChosen: true, vVoiceEngine: 'voxtral'}); off.voice.warmUp(); await sleep(5);
  assert.equal(off.calls.warm, 0); assert.deepEqual(off.seen.cloudWarm, []);
});

// ---- V on OmniVoice (2026-10-21): the companions' own GPU worker, queued first, waited for ------------------------------------------

// `render` stands in for the Omni worker's queue; `order` records who asked first. `problem`: why V's line cannot be rendered now (null: it can).
function omniFeature({problem = null, render, language = 'en', endAfter = 30, play, graceMs = 0, own = false} = {}) {
  const host = renderer({endAfter});
  const seen = {render: [], prepare: [], problem: [], helper: [], main: [], order: []};
  const omni = {
    problem: key => { seen.problem.push(key); return typeof problem === 'function' ? problem() : problem; },
    render: async (key, text, options) => {
      seen.render.push({key, text, ...options}); seen.order.push('V render');
      if (render) return render(key, text, options);
      return {audio: wav({seconds: 1}).toString('base64')};
    },
    prepare: async key => { seen.prepare.push(key); }};
  const helper = {speaks: () => own, ready: () => true, stream: async () => { seen.helper.push('stream'); return {}; }, prepare: async () => { seen.helper.push('prepare'); }};
  const made = feature({planFor: () => ({engine: 'omni', language}), omni, helper, play: play ?? host.play, graceMs,
    stream: async () => { seen.main.push('stream'); return {}; }, prepare: async () => { seen.main.push('prepare'); }});
  made.voice.update({vVoice: true, vVoiceEngine: 'omni'});
  return {...made, seen, host};
}

test('OmniVoice for V: the render is queued on the worker the moment the line is sent, before the renderer page is ready and ahead of anything the companion asks', async () => {
  let openPage;
  const pageOpened = new Promise(done => { openPage = done; });
  const host = renderer({endAfter: 3});
  const {voice, seen, calls} = omniFeature({play: async (config, producer, options) => { await pageOpened; return host.play(config, producer, options); }});
  const clock = new TurnClock();
  const made = voice.start(typed(), {clock});
  assert.ok(made, 'a line is started');
  await until(() => seen.render.length === 1, 'V\'s render to be queued');
  assert.equal(host.state.config, undefined, 'the renderer page is not ready yet: the render did not wait for it');
  seen.order.push('companion render');   // the companion's text arrives later and its render queues behind V's
  assert.deepEqual(seen.order, ['V render', 'companion render']);
  assert.deepEqual([seen.render[0].key, seen.render[0].text], ['v-male', 'Hey Judy, how are you holding up?']);
  assert.equal(seen.render[0].language, undefined, 'English sends no language');
  assert.ok(seen.render[0].signal instanceof AbortSignal, 'the turn can cancel a job that has not started');
  withClock(clock, () => clock.mark('ttsSent'));
  assert.equal(made.state, 'synth', 'the companion\'s own request does not stop V: V is in front of it in the same queue');
  openPage();
  await made.waitClear();
  assert.equal(made.state, 'done');
  await made.finished;
  assert.equal(calls.reports.length, 1);
  assert.equal(calls.reports[0].engine, 'omni'); assert.equal(calls.reports[0].result, 'played');
  for (const name of ['voiceStart', 'ttsSent', 'firstPcm', 'synthDone', 'audible', 'ended']) assert.ok(name in calls.reports[0].marks, name);
});

test('OmniVoice for V loads nothing of its own: no Pocket worker, no helper, no companion worker call', async () => {
  const {voice, seen} = omniFeature({own: true});      // even where a V Pocket helper would be in charge
  const made = voice.start(typed());
  await made.waitClear(); await made.finished;
  assert.equal(made.state, 'done');
  assert.deepEqual(seen.helper.concat(seen.main), [], 'neither V\'s Pocket worker nor the companions\' Pocket worker is asked');
  assert.equal(seen.render.length, 1);
  voice.warmUp(); await sleep(5);
  assert.deepEqual(seen.helper.concat(seen.main), [], 'not even to prepare');
});

test('a slow OmniVoice render is waited for: the reply is held (no grace, no budget), never dropped for being slow, and follows V', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const {voice, host, calls} = omniFeature({graceMs: 5, render: async () => { await gate; return {audio: wav({seconds: 1}).toString('base64')}; }});
  const long = 'word '.repeat(40).trim();     // a long line: a Pocket or Voxtral line this long would have no budget to be rescued
  const made = voice.start(typed({text: long}));
  const order = [];
  made.whenClear(() => order.push('V ended'));
  await sleep(60);                             // far beyond the 5 ms grace
  assert.equal(made.state, 'synth', 'still being made: not dropped for being slow');
  assert.equal(made.waiting, true);
  for (let poll = 0; poll < 3; poll++) { assert.equal(made.holds(), true, 'the reply waits'); assert.equal(made.holdsPublish(), true); await sleep(5); }
  assert.equal(made.graceStarted, false, 'a grace never starts: nothing limits the wait');
  const reply = made.waitClear().then(() => order.push('reply may start'));
  release();
  await reply; await made.finished;
  assert.deepEqual(order, ['V ended', 'reply may start'], 'the companion follows V');
  assert.equal(made.state, 'done'); assert.equal(made.reason, null);
  assert.equal(host.state.played, true);
  assert.equal(calls.reports[0].result, 'played');
  assert.ok(!('waitedMs' in calls.reports[0]), 'no grace was counted');
});

test('a failed OmniVoice render (the worker errored or exited) is skipped with the reason in the log, and the companion still answers', async () => {
  const {voice, calls} = omniFeature({render: async () => { throw Error('Local voice worker exited (1)'); }});
  const made = voice.start(typed());
  assert.ok(made);
  assert.equal(made.holds(), true, 'while the render is pending the reply waits for it');
  await made.waitClear();                      // the reply is released the moment V fails
  assert.equal(made.state, 'dropped'); assert.equal(made.reason, 'failed');
  assert.equal(made.holds(), false); assert.equal(made.holdsPublish(), false);
  await made.finished;
  assert.ok(calls.logs.some(line => /V's line was not spoken \(Local voice worker exited \(1\)\)/.test(line)), calls.logs.join('|'));
  assert.equal(calls.reports[0].result, 'dropped'); assert.equal(calls.reports[0].reason, 'failed'); assert.equal(calls.reports[0].engine, 'omni');
  // A worker that answers with no audio is the same: skipped, logged.
  const silent = omniFeature({render: async () => ({})});
  const empty = silent.voice.start(typed()); await empty.waitClear(); await empty.finished;
  assert.equal(empty.state, 'dropped'); assert.ok(silent.calls.logs.some(line => /returned no audio/.test(line)));
});

test('OmniVoice that cannot render now (companions on another voice, pack gone, worker not loaded, playback Off) gives no line, asks the worker for nothing and says why once', () => {
  for (const reason of ['the companions are not on OmniVoice now', 'the OmniVoice pack is missing', 'the OmniVoice worker is still loading', 'voice playback is off, so OmniVoice is not loaded']) {
    const {voice, seen, calls} = omniFeature({problem: reason});
    assert.equal(voice.start(typed()), null);
    assert.equal(voice.start(typed({requestId: 'r2'})), null);
    assert.deepEqual(seen.render, [], 'nothing was rendered');
    assert.equal(voice.speakable('v-male'), false);
    assert.equal(calls.logs.filter(line => line.includes(reason)).length, 1, 'the reason is logged once: ' + reason);
    voice.warmUp(); assert.equal(calls.warm, 0, 'nothing is warmed'); assert.deepEqual(seen.prepare, []);
  }
  const none = feature({planFor: () => ({engine: 'omni', language: 'en'})});
  none.voice.update({vVoice: true, vVoiceEngine: 'omni'});
  assert.equal(none.voice.start(typed()), null, 'no Omni voice wired at all');
});

test('OmniVoice speaks V\'s line in the language it is written in (any language, nothing is skipped for it)', async () => {
  const spanish = omniFeature({language: 'es'});
  const made = spanish.voice.start(typed({text: 'Hola Judy, como estas?'}));
  assert.ok(made); await made.waitClear(); await made.finished;
  assert.equal(spanish.seen.render[0].language, 'es');
  const japanese = omniFeature({language: 'ja'});
  assert.ok(japanese.voice.start(typed({text: 'ジュディ、元気？'})));
  await until(() => japanese.seen.render.length === 1, 'the render');
  assert.equal(japanese.seen.render[0].language, 'ja');
  // The same turn on Pocket is still skipped: Pocket speaks English only.
  const pocket = feature({planFor: () => ({engine: 'pocket', language: 'es'})});
  assert.equal(pocket.voice.start(typed({text: 'Hola Judy, como estas?'})), null);
});

test('the composer prepares V\'s voice on the Omni worker only (the hidden warm-up), once the gender is known, and warms the renderer page', async () => {
  const {voice, seen, calls} = omniFeature();
  voice.noteGender(typed()); voice.warmUp(); await sleep(5);
  assert.deepEqual(seen.prepare, ['v-male']);
  assert.equal(calls.warm, 1);
  assert.deepEqual(seen.helper.concat(seen.main), []);
  const both = omniFeature();
  both.voice.warmUp(); await sleep(5);
  assert.deepEqual(both.seen.prepare, ['v-male', 'v-female'], 'two clips and nothing known: both, male first');
});

test('the end of the turn cancels V\'s OmniVoice render that has not started, and the reply is not held for it', async () => {
  const controller = new AbortController();
  const {voice, seen} = omniFeature({render: (key, text, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Error('cancelled')), {once: true});
  })});
  const made = voice.start(typed(), {signal: controller.signal});
  await until(() => seen.render.length === 1, 'the render');
  assert.equal(seen.render[0].signal.aborted, false);
  controller.abort();
  assert.equal(made.state, 'dropped'); assert.equal(made.reason, 'turn-ended');
  assert.equal(seen.render[0].signal.aborted, true, 'the queued job is told to stand down');
  assert.equal(made.holds(), false);
  await made.finished;
});

test('V\'s engine is read from the saved settings: OmniVoice only while the companions\' voice is OmniVoice with its pack, else Pocket (and back at once)', () => {
  const saved = {vVoice: true, vVoiceEngine: 'omni', voiceProvider: 'omni'};
  assert.equal(vSettingsFor(saved, {omniUsable: true}), saved, 'a usable engine is passed through untouched');
  assert.equal(vSettingsFor(saved, {omniUsable: false}).vVoiceEngine, 'pocket');
  assert.equal(saved.vVoiceEngine, 'omni', 'the saved value is left alone');
  assert.equal(vSettingsFor({vVoiceEngine: 'voxtral'}, {cloudUsable: false}).vVoiceEngine, 'pocket');
  assert.equal(vSettingsFor({vVoiceEngine: 'voxtral'}, {cloudUsable: true, omniUsable: false}).vVoiceEngine, 'voxtral', 'the Omni rule never touches Voxtral');
  assert.equal(vSettingsFor({vVoiceEngine: 'pocket'}, {}).vVoiceEngine, 'pocket');
  assert.equal(vSettingsFor(undefined, {}), undefined);
  // The companions' voice moves away from OmniVoice: V falls back to Pocket (and now wants its own Pocket worker, as any Pocket V does).
  const voice = new VVoice({voices: {male: {key: 'v-male'}}});
  assert.equal(voice.update(vSettingsFor(saved, {omniUsable: true})), true);
  assert.equal(voice.engine, 'omni'); assert.equal(voice.wantsPocket, false);
  assert.equal(voice.update(vSettingsFor({...saved, voiceProvider: 'pocket'}, {omniUsable: false})), true, 'the change is reported');
  assert.equal(voice.engine, 'pocket'); assert.equal(voice.wantsPocket, true);
  assert.equal(voice.update(vSettingsFor(saved, {omniUsable: true})), true); assert.equal(voice.engine, 'omni', 'back as soon as the companions are on OmniVoice again');
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

// ---- the wiring in the bridge (the parts a unit test cannot run) ----------------------------------------------------------

const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');

test('the bridge starts V\'s line at the top of the turn (before knowledge, admission and the transport hand-over), not for a look-ahead, and gates both reply paths', () => {
  const run = bridge.slice(bridge.indexOf('async function runInput'), bridge.indexOf('let lastAudioHeartbeat'));
  const started = run.indexOf('vVoice.start(input, {signal: controller.signal, clock})');
  assert.ok(started > 0);
  for (const later of ['knowledgeRouter.prepare(', 'admitPlayerConversation(', 'connections.setRequest(', 'const replying = respond(']) {
    assert.ok(run.indexOf(later) > started, `V's line starts before ${later}`);
  }
  assert.ok(run.indexOf('if (!profile || !ids[profile.key])') < started, 'only for a turn that is for a real companion');
  assert.match(run, /if \(!ahead\) vLine = vVoice\.start/);
  // Published shortly before V's end (the hand-off lead), its sound held until V has ended.
  assert.match(bridge, /hold: \(\) => ahead\?\.isHeld\(\) === true \|\| current\.vLine\?\.\(\)\?\.holdsPublish\(\) === true/);
  assert.match(bridge, /holdSound: \(\) => current\.vLine\?\.\(\)\?\.blocking === true/);
  assert.match(bridge, /current\.vLine\?\.\(\)\?\.whenNearEnd\?\.\(\(\) => speech\.wakeUp\(\)\)/);
  assert.match(bridge, /await current\.vLine\?\.\(\)\?\.waitClear\(signal\)/);
  // A saved Voxtral without a Mistral key is Pocket for V (the one row of V's voice offers Voxtral only with a key), and so is one beside Mature content
  // (owner decision 2026-10-20: no cloud voice with Mature content on).
  assert.match(bridge, /const vSettings = vSettingsFor\(settings, \{cloudUsable: matureAllowsCloudVoice\(matureContent\.enabled\), omniUsable: vOmniUsable\}\);/);
  assert.match(bridge, /const vOmniUsable = localVoice\.requestedProvider === 'omni' && localVoice\.omniPack\?\.installed !== false;/);
  assert.match(bridge, /if \(vVoice\.update\(vSettings\)\)/);
  assert.match(bridge, /vVoice\.warmUp\(\)/);
  assert.match(bridge, /extra: extraVoices\(vVoiceReferences\)/);
});

test('V\'s line is never given a local model of its own: Pocket goes through the voice selection, Voxtral through the cloud voice, OmniVoice through the companions\' own worker', () => {
  const block = bridge.slice(bridge.indexOf('const vVoice = new VVoice('), bridge.indexOf('// A returning shopkeeper\'s memory'));
  assert.match(block, /planFor: \(input, key\) => \(\{engine: vVoice\.engine,/, 'V\'s engine is its own setting');
  assert.match(block, /ready: key => localVoice\.vRouteSpeaks\(key\),/);
  assert.match(block, /localVoice\.synthesizeStream\(/);
  assert.match(block, /localVoice\.prepareProfile\(/);
  assert.match(block, /voxtralVoice\.synthesizeStream\(/);
  assert.match(block, /voxtralVoice\.reference\(key\)/, 'the cloud clip is prepared at warm-up');
  assert.doesNotMatch(block, /localVoice\.synthesize\(/, 'V never calls the Omni render directly: it goes through vOmniRender (16 steps, tags removed)');
  assert.match(block, /omni: \{problem: key => localVoice\.vOmniProblem\(key\), render: \(key, text, options\) => localVoice\.vOmniRender\(key, text, options\),/, 'V on OmniVoice is one more job on the companions\' worker');
  assert.match(block, /localVoice\.vOmniPrepare\(/);
  assert.doesNotMatch(block, /new (Pocket|Resident|Omni)/, 'no voice engine is constructed for V');
});

test('V\'s own Pocket worker is the voice selection\'s, and the settings poll tells it whether V wants Pocket', () => {
  const block = bridge.slice(bridge.indexOf('const vVoice = new VVoice('), bridge.indexOf('// A returning shopkeeper\'s memory'));
  assert.match(block, /helper: \{speaks: key => localVoice\.vHelperSpeaks\(key\), ready: key => localVoice\.vHelperReady\(key\)/);
  assert.match(block, /localVoice\.vHelperStream\(/);
  assert.match(block, /localVoice\.vHelperPrepare\(/);
  assert.match(bridge, /localVoice\.setVHelperWanted\(vVoice\.wantsPocket\)/);
  // Mature content on: no line goes to the cloud voice (the net behind the settings poll's Pocket); asked before any key or limit.
  assert.match(block, /problem: key => \{[^}]*?if \(!matureAllowsCloudVoice\(matureContent\.enabled\)\) return 'Mature content is on';[^}]*?if \(!voxtralVoice\.hasKey\) return 'no Mistral key';/s);
  assert.match(block, /mistralScheduler\.stats\(\)/, 'V never takes a Mistral start from the reply');
});

// ---- air at both ends (bridge/pcm-edges.mjs) ----------------------------------------------------------------------------------

const speech = (frames, level = 0.5) => Float32Array.from({length: frames}, (_, at) => level * Math.sin(at / 9));
const speechPacket = (pcm, index, offsetFrames) => ({version: 1, engine: 'pocket-tts', owner: 'a'.repeat(32), id: 1, profile: 'v-male', modelSha256: 'b'.repeat(64),
  sampleRate: 24000, channels: 1, format: 'f32le', index, offsetFrames, frames: pcm.length, pcm});

async function padded(sizes, options, make = speech) {
  const out = [], source = [];
  const edges = new PcmEdges(async item => { out.push(item); return {}; }, options);
  let offset = 0;
  for (const [at, size] of sizes.entries()) { const pcm = make(size); source.push(pcm); await edges.push(speechPacket(pcm, at + 1, offset)); offset += size; }
  await edges.finish();
  const pcm = new Float32Array(out.reduce((sum, item) => sum + item.frames, 0));
  let at = 0; for (const item of out) { pcm.set(item.pcm, at); at += item.frames; }
  return {out, pcm, voiced: offset, original: Float32Array.from(source.flatMap(part => [...part]))};
}

test('a line gets a 160 ms lead-in, a faded end and a 320 ms silent tail; the voiced samples in between are untouched', async () => {
  const {out, pcm, voiced, original} = await padded([1920, 1920, 1920, 1000]);
  assert.equal(pcm.length, 3840 + voiced + 7680);
  assert.ok(pcm.slice(0, 3840).every(value => value === 0), 'silent lead-in');
  assert.ok(pcm.slice(-7680).every(value => value === 0), 'silent tail');
  // Past the fade-in and before the fade-out the samples are exactly the engine's.
  for (let at = 400; at < voiced - 1000; at += 97) assert.equal(pcm[3840 + at], original[at]);
  // The first sample after the lead-in starts near zero and rises; the last voiced sample is near zero.
  assert.ok(Math.abs(pcm[3840]) < 0.01 && Math.abs(pcm[3840 + voiced - 1]) < 0.01);
  out.forEach((item, at) => { assert.equal(item.index, at + 1); assert.equal(item.frames, item.pcm.length); });
  assert.deepEqual(out.map(item => item.offsetFrames), out.map((_, at) => out.slice(0, at).reduce((sum, item) => sum + item.frames, 0)));
  assert.ok(out.every(item => item.owner === out[0].owner && item.modelSha256 === out[0].modelSha256 && item.format === 'f32le'));
});

test('no packet is held back for the end of the line: the first sound leaves with the first packet, minus only the last 40 ms', async () => {
  const out = [];
  const edges = new PcmEdges(async item => { out.push(item); });
  await edges.push(speechPacket(speech(1920), 1, 0));
  assert.equal(out.length, 1, 'the first packet is emitted at once');
  assert.equal(out[0].frames, 3840 + 1920 - 960, 'lead-in plus the packet, less the held 40 ms');
  await edges.push(speechPacket(speech(1920), 2, 1920));
  assert.equal(out.at(-1).frames, 1920, 'each later packet releases as many frames as it brought');
});

test('fades are smooth: no step larger than the fade slope at either edge, and a very short line stays finite and padded', async () => {
  const {pcm, voiced} = await padded([5000], undefined, size => new Float32Array(size).fill(0.5));
  for (let at = 3840 + 1; at < 3840 + 400; at++) assert.ok(Math.abs(pcm[at] - pcm[at - 1]) < 0.01, 'fade-in step ' + at);
  for (let at = 3840 + voiced - 960; at < 3840 + voiced + 5; at++) assert.ok(Math.abs(pcm[at] - pcm[at - 1]) < 0.01, 'fade-out step ' + at);
  const tiny = await padded([100]);
  assert.equal(tiny.pcm.length, 3840 + 100 + 7680);
  assert.ok(tiny.pcm.every(Number.isFinite));
  assert.equal(fadeGain(0, 0), 1);
  assert.ok(fadeGain(0, 360) < 0.01 && fadeGain(359, 360) > 0.99);
});

test('a packet larger than the renderer accepts is split; nothing is emitted when the engine gave no audio', async () => {
  const big = await padded([90000]);
  assert.ok(big.out.every(item => item.frames <= 48000));
  assert.equal(big.pcm.length, 3840 + 90000 + 7680);
  const none = await padded([]);
  assert.equal(none.out.length, 0);
});

test('a Pocket line is padded end to end: the renderer host receives lead-in, line and tail, and V is not cleared before the tail has played', async () => {
  const emitted = [];
  const host = async (config, producer, options) => {
    await producer(async item => { emitted.push(item); }, {signal: options.signal});
    options.onFrame({receivedFrames: 1, ended: false}); options.onFrame({receivedFrames: 1, ended: true});
  };
  const made = line({play: host, stream: async (key, text, options) => { await options.onPcm(speechPacket(speech(4800), 1, 0)); await options.onPcm(speechPacket(speech(4800), 2, 4800)); return {}; }});
  await made.line.clear; await made.line.finished;
  assert.equal(emitted.reduce((sum, item) => sum + item.frames, 0), 3840 + 9600 + 7680);
  assert.equal(made.line.state, 'done');
  for (const item of emitted) ownedLocalPcmPacket(item, {token: 'v-x', frames: item.offsetFrames, index: item.index - 1});
});

// ---- V's voice in an add-on conversation (live 2026-10-16: V typed to the Delamain cab and was never heard) ------------------------

test('an add-on conversation starts V\'s line beside the reply, never for a remark, and the composer warms V\'s voice for it', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  const body = bridge.slice(bridge.indexOf('async function runAddonTurn'), bridge.indexOf('async function runInput'));
  assert.match(body, /current\.vLine = \(\) => vLine;/, 'the reply\'s voice waits for V (continuousSpeech hold, publishResult waitClear)');
  assert.match(body, /if \(!remark && !ahead && !vLine\) vLine = vVoice\.start\(input,/, 'a conversation only');
  // The line starts after the text request is under way, on both paths.
  assert(body.indexOf('host.reply(config, {signal, stream})') < body.indexOf('startV();'), 'streamed path: the text request first');
  assert(body.indexOf('const making = ') < body.lastIndexOf('startV();'), 'whole-reply path: the text request first');
  // A composer opened for an add-on's voice leaves a voice-only hint; the bridge warms V's voice page for it (no connection is opened).
  const lua = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  assert.match(lua, /voiceOnly = true\}\)/);
  assert.match(bridge, /JSON\.parse\(hintRaw\)\?\.voiceOnly === true\) vVoice\.warmUp\(\)/);
});

// ---- The hand-off to the companion (docs/perf, LATENCY.md) ----------------------------------------------------------------------

// A renderer whose clock the test moves: one second of V's line (its silent tail included), the heard position set by the test.
function clockedRenderer() {
  const state = {position: 0, complete: false, end: false};
  const play = async (config, producer, options) => {
    const producing = producer(async () => {}, {signal: options.signal});
    while (await options.current()) {
      const ended = state.end && state.complete;
      options.onFrame({receivedFrames: 24000, sampleRate: 24000, sourceComplete: state.complete, positionSeconds: ended ? 1 : state.position, ended});
      if (ended) break;
      await sleep(1);
    }
    await producing;
  };
  return {play, state};
}
const handoffLine = (host, extra = {}) => new VLine({input: typed(), key: 'v-male', text: 'Hello Judy.', plan: {engine: 'pocket', language: 'en'},
  volume: 0.6, play: host.play, stream: async (key, text, options) => { await options.onPcm(packet()); return {}; }, graceMs: 0, ...extra});

test('V\'s hand-off: the time left is read from the renderer once the line is complete; publishing is allowed from the lead on, the sound only after the end', async () => {
  assert.equal(V_HANDOFF_LEAD_MS, 300, 'inside the 320 ms of silence V\'s line ends with');
  const host = clockedRenderer(), near = [];
  const made = handoffLine(host);
  made.whenNearEnd(() => near.push('near'));
  await until(() => made.state === 'playing', 'V to be audible');
  assert.equal(made.holdsPublish(), true, 'V\'s end is not known yet (synthesis running): the reply waits');
  host.state.position = 0.2; host.state.complete = true;
  await until(() => made.remainingMs < Infinity, 'the time left to be known');
  assert.equal(made.holdsPublish(), true, 'about 800 ms left: still held');
  assert.deepEqual(near, []);
  host.state.position = 0.75;
  await until(() => near.length === 1, 'the near-end signal');
  assert.equal(made.holdsPublish(), false, '250 ms left: the reply may be published');
  assert.equal(made.blocking, true, 'but its sound waits: V is still audible');
  host.state.position = 0.65;   // a clock report a little off never takes the permission back
  await sleep(5);
  assert.equal(made.holdsPublishPeek(), false);
  assert.equal(near.length, 1, 'the signal fires once');
  host.state.end = true;
  await made.clear;
  assert.equal(made.blocking, false);
  let late = 0; made.whenNearEnd(() => late++);
  assert.equal(late, 1, 'a listener added after the end runs at once');
});

test('V\'s hand-off: the time left is counted on between renderer reports; a dropped line signals at once; lead 0 is the old order', async () => {
  let now = 0;
  const host = clockedRenderer();
  const made = handoffLine(host, {now: () => now});
  await until(() => made.state === 'playing', 'V to be audible');
  host.state.position = 0.5; host.state.complete = true;
  await until(() => made.remainingMs < Infinity, 'the time left to be known');
  // No newer report counts here: 500 ms left at the report, 220 ms later it is under the lead.
  made.remainingAt = now; made.remainingMs = 500; now += 220;
  assert.equal(made.nearEnd(), true);
  made.remainingMs = 900;
  assert.equal(made.nearEnd(), true, 'sticky once reached: a later report never takes it back');
  host.state.end = true; await made.clear;
  // Not audible in time: dropped, which also releases anyone waiting for the near end.
  let release;
  const gate = new Promise(done => { release = done; });
  const slow = handoffLine(clockedRenderer(), {stream: async (key, text, options) => { await gate; await options.onPcm(packet()); return {}; }});
  let woke = 0; slow.whenNearEnd(() => woke++);
  assert.equal(slow.holdsPublish(), false, 'the reply never waits for V\'s synthesis');
  assert.equal(slow.state, 'dropped'); assert.equal(woke, 1);
  release(); await slow.finished;
});

test('the hand-off lead is a setting: CYBERPUNK_CONVAI_V_HANDOFF_MS=0 publishes only when V has ended, as before', () => {
  const source = readFileSync(new URL('./v-voice.mjs', import.meta.url), 'utf8');
  assert.match(source, /const requestedHandoff = Number\(process\.env\.CYBERPUNK_CONVAI_V_HANDOFF_MS\);/);
  assert.match(source, /requestedHandoff >= 0 && requestedHandoff <= 2000 \? requestedHandoff : 300;/);
  // With lead 0 the reply is held until nothing is left of V's line.
  const made = Object.assign(Object.create(VLine.prototype), {state: 'playing', remainingMs: 100, remainingAt: 0, nearReached: false, now: () => 0});
  assert.equal(made.holdsPublishPeek(0), true);
  made.remainingMs = 0;
  assert.equal(made.holdsPublishPeek(0), false);
});

test('V\'s hand-off end to end: the companion\'s reply is published before V ends, the lease is read, and the sound starts only when V has ended', async () => {
  const owner = {requestId: 'reply-1', entity: 'judy-copy-2', generation: 7};
  const events = [];
  let sequence = 0, leases = 0;
  const host = clockedRenderer();
  const vLine = handoffLine(host);
  const speech = new ConvaiContinuousSpeech({input: owner, profile: {key: 'judy-alvarez'}, token: 'continuous-1',
    signal: new AbortController().signal, current: async () => true,
    hold: () => vLine.holdsPublish(), holdPeek: () => vLine.holdsPublishPeek(), holdSound: () => vLine.blocking,
    onLease: () => leases++,
    readControl: async () => JSON.stringify({version: 1, id: 'continuous-1', ...owner, sequence: ++sequence, updated: Date.now(),
      allow: true, paused: false, volume: 0.8, pan: 0}),
    writeState: async () => { events.push('state'); return true; },
    writeReply: async () => { events.push('reply'); return true; }});
  vLine.whenNearEnd(() => speech.wakeUp());
  vLine.whenClear(() => speech.wakeUp());
  const snapshot = {version: 1, token: 'continuous-1', sampleRate: 24000, channels: 1, receivedFrames: 12000, positionSeconds: 0,
    text: 'Hey V.', textComplete: true, sourceComplete: false, ended: false, underruns: 0, state: 'buffering'};
  const QUIET = {allow: false, paused: true, volume: 0, pan: 0};
  await until(() => vLine.state === 'playing', 'V to be audible');
  host.state.position = 0.3; host.state.complete = true;
  await until(() => vLine.remainingMs < Infinity, 'V\'s time left to be known');
  assert.deepEqual(await speech.frame(snapshot), QUIET);
  assert.deepEqual(events, [], 'nothing is published while V has more than the lead left');
  const woken = speech.options.wake();
  host.state.position = 0.8;   // 200 ms left
  await woken;   // the near-end signal wakes the companion's poll at once
  assert.deepEqual(await speech.frame(snapshot), QUIET, 'published, silent');
  assert.ok(events.includes('reply'), 'the reply reaches the game before V ends');
  assert.deepEqual(await speech.frame({...snapshot, receivedFrames: 13000}), QUIET, 'the lease is read but the sound waits for V');
  assert.equal(leases, 1, 'the game\'s lease was accepted and is kept');
  const soundWake = speech.options.wake();
  assert.ok(soundWake instanceof Promise, 'the poll waits for V\'s end (or a lease)');
  host.state.end = true;
  await vLine.clear;
  await soundWake;
  const sound = await speech.frame({...snapshot, receivedFrames: 14000});
  assert.equal(sound.allow, true, 'the reply sounds the moment V has ended');
});

// ---- the grace, the warm voice and the totals (2026-10-19) -----------------------------------------------------------------
// Live finding: V's own Pocket worker was cold for the first line of the session (its voice not prepared: the game had not said who V
// is when the composer opened), V's first audio came 40 ms after the reply's, and the line was dropped on the spot.

/** Polls the way the continuous speech does once the reply's audio exists: the moment the reply may start is the first poll with no hold. */
async function replyMayStart(made, {limit = 4000} = {}) {
  const started = performance.now();
  while (made.holds() === true || made.blocking) {
    if (performance.now() - started > limit) assert.fail('the reply was held for too long');
    await sleep(1);
  }
  return performance.now() - started;
}
const late = ms => async (key, text, options) => { await sleep(ms); await options.onPcm(packet()); return {}; };

test('the grace: a reply that is ready a moment before V\'s first audio waits for it, V is heard, and the wait is on the stage clock', async () => {
  const {line: made, summaries, clock} = line({graceMs: 300, stream: late(40)}, {endAfter: 40});
  assert.equal(made.holds(), true, 'V is not audible yet but the grace is running: the reply is held');
  assert.equal(made.waiting, true); assert.equal(made.state, 'synth');
  assert.equal(made.holdsPublishPeek(), true, 'and it is not published to the game either');
  await until(() => made.state === 'playing', 'V to become audible inside the grace');
  assert.equal(made.waiting, false); assert.equal(made.holds(), true, 'audible now: the reply waits for V as before');
  await made.clear;
  assert.equal(made.state, 'done');
  assert.equal(summaries[0].result, 'played');
  assert.ok(summaries[0].waitedMs >= 20 && summaries[0].waitedMs < 300, `waited ${summaries[0].waitedMs} ms`);
  assert.ok('graceStart' in summaries[0].marks && 'audible' in summaries[0].marks && !('dropped' in summaries[0].marks));
  assert.ok(clock.snapshot().marks.graceStart < clock.snapshot().marks.audible);
});

test('the grace is a budget, not a promise: V\'s first audio that is later than graceMs is dropped, and the reply was never held longer', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const {line: made, summaries} = line({graceMs: 80, stream: async (key, text, options) => { await gate; await options.onPcm(packet()); return {}; }});
  let cleared = 0; made.whenClear(() => cleared++);
  const waited = await replyMayStart(made);
  assert.ok(waited >= 70 && waited < 400, `held ${Math.round(waited)} ms for a grace of 80`);
  assert.equal(made.state, 'dropped'); assert.equal(made.reason, 'slower-than-reply');
  await sleep(1); assert.equal(cleared, 1, 'whoever waits on V (the continuous speech wake, waitClear) is released by the drop');
  release(); await made.finished;
  assert.equal(summaries.length, 1); assert.equal(summaries[0].reason, 'slower-than-reply'); assert.ok(summaries[0].waitedMs >= 70);
  assert.equal(made.holds(), false);
});

test('asking again never extends the grace: the first ask starts it, polls only read it', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const {line: made} = line({graceMs: 90, stream: async (key, text, options) => { await gate; await options.onPcm(packet()); return {}; }});
  const started = performance.now();
  while (made.holds()) await sleep(5);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 250, `${Math.round(elapsed)} ms for a grace of 90 polled every 5 ms`);
  release(); await made.finished;
});

test('the turn ending, or the line failing, inside the grace releases it at once and leaves no timer', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const controller = new AbortController();
  const {line: made} = line({graceMs: 5000, signal: controller.signal, stream: async (key, text, options) => { await gate; await options.onPcm(packet()); return {}; }});
  assert.equal(made.holds(), true);
  controller.abort();
  assert.equal(made.state, 'dropped'); assert.equal(made.reason, 'turn-ended');
  assert.equal(made.waiting, false); assert.equal(made.holds(), false);
  assert.equal(made.graceTimer, null);
  release(); await made.finished;
  const broken = line({graceMs: 5000, stream: async () => { throw Error('voice failed'); }});
  broken.line.holds();
  await broken.line.clear;
  assert.equal(broken.line.reason, 'failed'); assert.equal(broken.line.graceTimer, null);
});

test('waitClear (a reply published as a whole) waits out the grace and then V\'s line when V makes it in time, or the grace alone when not', async () => {
  const quick = line({graceMs: 300, stream: late(30)}, {endAfter: 40});
  await quick.line.waitClear();
  assert.equal(quick.line.state, 'done');
  let release;
  const gate = new Promise(done => { release = done; });
  const slow = line({graceMs: 60, stream: async (key, text, options) => { await gate; await options.onPcm(packet()); return {}; }});
  const started = performance.now();
  await slow.line.waitClear();
  assert.equal(slow.line.reason, 'slower-than-reply'); assert.ok(performance.now() - started < 400);
  release(); await slow.line.finished;
});

test('the live case on the stage clock: V\'s first audio 40 ms after the reply\'s is heard; a cold voice seconds away costs the reply the grace and no more', async () => {
  // Without the grace (the old rule) the first case was lost; with it V plays first and the reply follows V's end, as it does for any audible V.
  const old = line({graceMs: 0, stream: late(40)});
  assert.equal(old.line.holds(), false); assert.equal(old.line.reason, 'slower-than-reply');
  await old.line.finished;
  const live = line({graceMs: 600, stream: late(40)}, {endAfter: 20});
  await replyMayStart(live.line);
  assert.equal(live.line.state, 'done', 'V was heard, then the reply may start');
  assert.ok(live.clock.snapshot().marks.audible < 300, `V audible ${live.clock.snapshot().marks.audible} ms after it started`);
  // A cold voice: first audio is seconds away. The reply is held for the grace and then goes on without V.
  let release;
  const gate = new Promise(done => { release = done; });
  const cold = line({graceMs: 120, stream: async (key, text, options) => { await gate; await options.onPcm(packet()); return {}; }});
  const coldWait = await replyMayStart(cold.line);
  assert.equal(cold.line.reason, 'slower-than-reply');
  assert.ok(coldWait >= 100 && coldWait < 300, `a reply is held ${Math.round(coldWait)} ms for a grace of 120, never the seconds the voice needs`);
  release(); await cold.line.finished;
});

test('the default grace is 600 ms, and VVoice passes its own to every line', async () => {
  assert.equal(V_GRACE_MS, 600);
  const {voice} = feature({graceMs: 250});
  const made = voice.start(typed());
  assert.equal(made.graceMs, 250);
  await made.finished;
  assert.equal(new VVoice({}).graceMs, V_GRACE_MS);
});

test('the turn\'s own stage clock shows that the reply waited for V: vGrace, then vAudible', async () => {
  const clock = new TurnClock();
  const {voice} = feature({graceMs: 300, stream: late(30), play: renderer({endAfter: 150}).play});
  const made = voice.start(typed(), {clock});
  assert.equal(made.holds(), true);
  await until(() => made.state === 'playing', 'V audible');
  const marks = clock.snapshot().marks;
  assert.ok(marks.vGrace <= marks.vAudible, JSON.stringify(marks));
  await made.finished;
});

test('the totals: spoken and not-heard lines are counted by reason, written to the log when a line is dropped (and for the first), and no text ever', async () => {
  const gates = [];
  const stream = (key, text, options) => new Promise(resolveStream => { gates.push(() => { options.onPcm(packet()); resolveStream({}); }); });
  const play = (config, producer, options) => renderer({endAfter: 3}).play(config, producer, options);
  const {voice, calls} = feature({graceMs: 0, play, stream: async (key, text, options) => { await options.onPcm(packet()); return {}; }});
  await voice.start(typed()).finished;
  assert.equal(calls.tally.length, 1, 'the first line of the session writes the totals');
  assert.match(calls.tally[0], /^this session: 1 typed line\(s\) spoken, 0 not heard$/);
  await voice.start(typed()).finished;
  assert.equal(calls.tally.length, 1, 'a spoken line after the first writes nothing');
  const slow = feature({graceMs: 0, stream});
  const made = slow.voice.start(typed()); assert.equal(made.holds(), false);
  await sleep(2);
  assert.match(slow.calls.tally.at(-1), /^this session: 0 typed line\(s\) spoken, 1 not heard \(slower-than-reply=1\)$/);
  assert.doesNotMatch(slow.calls.tally.join('\n'), /Hey Judy/);
  for (const gate of gates) gate();
  await made.finished;
});

test('a typed line that could not start is counted too (not loaded, not English, no volume), with the totals written for the first of each reason', () => {
  const own = engineFeature({own: true, ownReady: false});
  assert.equal(own.voice.start(typed()), null); assert.equal(own.voice.start(typed()), null);
  assert.equal(own.calls.tally.length, 1);
  assert.match(own.calls.tally[0], /not started \(voice-not-loaded=1\)/);
  assert.equal(own.voice.tally.skipped['voice-not-loaded'], 2);
  const english = engineFeature({language: 'de'});
  assert.equal(english.voice.start(typed()), null);
  assert.equal(english.voice.tally.skipped['not-english'], 1);
  const quiet = feature();
  assert.equal(quiet.voice.start(typed({turnContext: {version: 1, status: 'ready', gender: 'male'}})), null);
  assert.equal(quiet.voice.tally.skipped['volume-unknown'], 1);
  // The setting off is not "a line that could not start": it is not counted.
  const off = feature(); off.voice.update({vVoice: false, vVoiceChosen: true});
  assert.equal(off.voice.start(typed()), null); assert.deepEqual(off.voice.tally.skipped, {});
});

test('V\'s gender is remembered between sessions: the first warm-up of a session prepares that one voice, and it is saved only when it changes', async () => {
  const saved = [];
  const remembered = feature({remember: {gender: 'female', save: gender => saved.push(gender)}});
  assert.equal(remembered.voice.lastGender, 'female');
  remembered.voice.warmUp(); await sleep(5);
  assert.deepEqual(remembered.calls.prepare, ['v-female'], 'the remembered V, not both');
  remembered.voice.noteGender(typed({turnContext: {version: 1, status: 'ready', gender: 'female'}}));
  assert.deepEqual(saved, [], 'unchanged: nothing is written');
  remembered.voice.noteGender(typed({turnContext: {version: 1, status: 'ready', gender: 'male'}}));
  remembered.voice.noteGender(typed({turnContext: {version: 1, status: 'ready', gender: 'male'}}));
  assert.deepEqual(saved, ['male']);
  const fresh = feature({remember: {gender: undefined, save: gender => saved.push(gender)}});
  assert.equal(fresh.voice.lastGender, null);
  const broken = feature({remember: {get gender() { throw Error('unreadable'); }, save() { throw Error('read only'); }}});
  broken.voice.noteGender(typed()); assert.equal(broken.voice.lastGender, 'male');
});

test('warming with no V known prepares both voices in turn, but not the second one once a line has said which V it is; a worker that finished loading warms no renderer page', async () => {
  const order = [];
  let releaseFirst;
  const firstDone = new Promise(done => { releaseFirst = done; });
  const {voice, calls} = feature({prepare: async key => { order.push(key); if (key === 'v-male') await firstDone; }});
  voice.warmUp(); await sleep(5);
  assert.deepEqual(order, ['v-male']);
  voice.noteGender(typed({turnContext: {version: 1, status: 'ready', gender: 'male', dialogueVolume: 0.5}}));
  releaseFirst(); await sleep(5);
  assert.deepEqual(order, ['v-male'], 'the first line said V is male: the female voice is not prepared');
  assert.equal(calls.warm, 1);
  const worker = feature();
  worker.voice.warmUp({page: false}); await sleep(5);
  assert.equal(worker.calls.warm, 0, 'no renderer page for a worker that only finished loading');
  assert.deepEqual(worker.calls.prepare, ['v-male', 'v-female']);
});

test('V\'s own worker finishing its load prepares V\'s voice on it at once, in the bridge', () => {
  assert.match(bridge, /onVHelperReady: \(\) => vVoice\.warmUp\(\{page: false\}\)/);
  assert.match(bridge, /remember: vGenderMemory/);
  assert.match(bridge, /v-voice-gender\.json/);
});

test('the rescue budget: a late line is waited for only while the wait plus the line itself stays within V_RESCUE_BUDGET_MS; a long line is dropped at once', async () => {
  assert.equal(V_RESCUE_BUDGET_MS, 4000);
  const never = async (key, text, options) => { await new Promise(done => options.signal.addEventListener('abort', done, {once: true})); };
  // Two words (about 0.7 s and the 0.48 s of lead-in and tail): the whole grace fits.
  const short = line({graceMs: 600, text: 'Hello Judy.', stream: never});
  assert.equal(short.line.holds(), true); assert.equal(short.line.waiting, true);
  short.line.drop('test over'); await short.line.finished;
  // Nine words: 3.2 s + 0.48 s leaves about 300 ms of the 4 s.
  const mid = line({graceMs: 600, text: 'one two three four five six seven eight nine', stream: never});
  const started = performance.now();
  assert.equal(mid.line.holds(), true);
  await replyMayStart(mid.line);
  assert.ok(performance.now() - started < 450, 'the wait is what the budget leaves, not the whole grace');
  assert.equal(mid.line.reason, 'slower-than-reply');
  await mid.line.finished;
  // A long line (V_MAX_CHARS is about 40 words, 14 s): no room at all, dropped on the first ask like before.
  const long = line({graceMs: 600, text: 'word '.repeat(40).trim(), stream: never});
  assert.equal(long.line.holds(), false); assert.equal(long.line.reason, 'slower-than-reply'); assert.ok(!('graceStart' in long.clock.snapshot().marks));
  await long.line.finished;
});

test('each V line says which reference it speaks from: the bridge\'s label (manual, mod:<archive file name>), else the voice\'s source, else shipped', async () => {
  const run = async (voices, referenceLabel) => {
    const {voice, calls} = feature({voices, ...(referenceLabel ? {referenceLabel} : {})});
    await voice.start(typed()).finished;
    return calls.reports[0].reference;
  };
  assert.equal(await run({male: {key: 'v-male'}, female: {key: 'v-female'}}), 'shipped');
  assert.equal(await run({male: {key: 'v-male', source: 'mod:JCDentonAIVoice.archive'}, female: {key: 'v-female'}}), 'mod:JCDentonAIVoice.archive');
  assert.equal(await run({male: {key: 'v-male', source: 'mod:JCDentonAIVoice.archive'}, female: {key: 'v-female'}}, gender => gender === 'male' ? 'manual' : null), 'manual', 'the player\'s own clip wins');
  assert.equal(await run({male: {key: 'v-male'}, female: {key: 'v-female'}}, () => { throw Error('label failed'); }), 'shipped', 'a failing label never affects speech');
});

// 2026-10-22 review (R6): V on Voxtral with no Mistral key counted as Pocket and loaded a local Pocket worker for V. A cloud voice loads no local model.
test('a saved Voxtral for V stays Voxtral without a Mistral key: no Pocket worker is wanted, and the line is skipped with the reason (Mature content still makes it Pocket)', () => {
  const saved = {vVoice: true, vVoiceEngine: 'voxtral'};
  const voice = new VVoice({voices: {male: {key: 'v-male'}}});
  // The bridge passes only "cloud voices allowed" (Mature content off): the key is the voice's own business (its problem() says 'no Mistral key').
  assert.equal(voice.update(vSettingsFor(saved, {cloudUsable: true})), true);
  assert.equal(voice.engine, 'voxtral'); assert.equal(voice.wantsPocket, false, 'no local Pocket worker for a cloud voice');
  assert.equal(vSettingsFor(saved, {cloudUsable: true}), saved);
  // Mature content on: no cloud voice at all (owner decision 2026-10-20), V speaks with Pocket.
  const mature = new VVoice({voices: {male: {key: 'v-male'}}});
  mature.update(vSettingsFor(saved, {cloudUsable: false}));
  assert.equal(mature.engine, 'pocket'); assert.equal(mature.wantsPocket, true);
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /cloudUsable: voxtralVoice\.hasKey/, 'the saved key no longer turns V\'s Voxtral into Pocket');
});
