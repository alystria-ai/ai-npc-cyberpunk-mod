// V speaks your microphone lines (setting vVoiceMic, off by default; bridge/mic-v-line.mjs, docs/V_VOICE.md): a spoken line behaves exactly like a typed one
// (owner, 2026-10-24: "it's fine to wait, we should respect player choice"). Nothing here plays a sound: the renderer, the Pocket voice and the microphone
// channel are stand-ins.
import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {VVoice, VLine} from './v-voice.mjs';
import {MicVLines} from './mic-v-line.mjs';
import {ConvaiContinuousSpeech, TRANSCRIPT_WAIT_MS} from './convai-continuous-speech.mjs';

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
// A spoken turn's input as the bridge holds it after the context refresh: the placeholder text, source 'microphone', V's gender and the dialogue volume.
const spokenInput = (extra = {}) => ({requestId: '1-2-3ULL', profileKey: 'judy-alvarez', text: '[Microphone]', source: 'microphone',
  turnContext: {version: 1, status: 'ready', gender: 'male', dialogueVolume: 0.8}, ...extra});
const typedInput = (extra = {}) => ({requestId: 'r1', profileKey: 'judy-alvarez', text: 'Hey Judy, how are you holding up?',
  turnContext: {version: 1, status: 'ready', gender: 'male', dialogueVolume: 0.8}, ...extra});

// A renderer stand-in whose line plays until the test ends it (`state.end = true`), so "V is still speaking when the reply is ready" is real.
const renderers = [];
afterEach(() => { for (const host of renderers.splice(0)) host.state.end = true; });   // no line outlives its test
function openRenderer() {
  const state = {end: false, aborted: false, played: 0};
  const play = async (config, producer, options) => {
    state.played++; state.config = config;
    options.signal.addEventListener('abort', () => { state.aborted = true; }, {once: true});
    let produced = false, emitted = 0;
    const producing = producer(async () => { emitted++; }, {signal: options.signal}).then(() => { produced = true; }, () => {});
    for (let poll = 0; poll < 3000 && await options.current(); poll++) {
      const ended = produced && state.end;
      options.onFrame({receivedFrames: emitted ? 120000 : 0, sampleRate: 24000, sourceComplete: produced, positionSeconds: ended ? 5 : 0.1, ended});
      if (ended) break;
      await sleep(1);
    }
    await producing;
  };
  const host = {play, state};
  renderers.push(host);
  return host;
}

function feature(extra = {}) {
  const host = openRenderer();
  const calls = {stream: [], logs: [], tally: [], reports: []};
  const voice = new VVoice({
    voices: {male: {key: 'v-male'}, female: {key: 'v-female'}},
    planFor: () => ({engine: 'pocket', language: 'en'}),
    ready: () => true, isLocal: () => true,
    stream: async (key, text, options) => { calls.stream.push([key, text]); await options.onPcm(packet({profile: key})); return {frames: 4800}; },
    play: host.play, prepare: async () => {}, warm: async () => {},
    log: line => (/^this session:/.test(line) ? calls.tally : calls.logs).push(line), graceMs: 0,
    report: (input, summary) => calls.reports.push(summary), ...extra});
  voice.update({vVoice: true, ...extra.settings});
  return {voice, calls, host};
}
const micOn = {vVoiceMic: true};

// ---- the setting --------------------------------------------------------------------------------------------------------

test('the setting is off by default and only an explicit true turns it on; it is independent of V\'s voice for typed lines', () => {
  const voice = new VVoice({voices: {male: {key: 'v-male'}}});
  assert.equal(voice.micEnabled, false, 'until the settings are read');
  voice.update({});
  assert.equal(voice.enabled, true); assert.equal(voice.micEnabled, false, 'a file that never stored it: off');
  for (const value of ['yes', 1, null, false]) { voice.update({vVoiceMic: value}); assert.equal(voice.micEnabled, false, String(value)); }
  assert.equal(voice.update({vVoiceMic: true}), true, 'a change is reported'); assert.equal(voice.micEnabled, true);
  assert.equal(voice.update({vVoiceMic: true}), false);
  assert.equal(voice.micWanted, true);
  voice.update({vVoice: false, vVoiceChosen: true, vVoiceMic: true, vVoiceMicOwn: true});
  assert.equal(voice.enabled, false);
  assert.equal(voice.micEnabled, true, 'the saved choice is kept'); assert.equal(voice.micWanted, true, 'typed lines Off does not stop microphone lines');
  assert.equal(voice.active, true);
  voice.update({vVoice: true, vVoiceMic: false});
  assert.equal(voice.micWanted, false);
  const bare = new VVoice({voices: {}});
  bare.update({vVoiceMic: true});
  assert.equal(bare.micWanted, false, 'no clips: nothing to say');
});

test('Settings > Voice AI and microphone carries the setting inside V\'s voice, a three-choice list (Off, Typed lines, Typed and spoken lines) with no row of its own for microphone lines, and the reason push-to-talk never replayed V', () => {
  const ui = readFileSync(new URL('../mod/manager-ui.lua', import.meta.url), 'utf8');
  const row = /setting\('vVoice', 'V’s voice', 'select', vModeIndex, 2,\s*\r?\n\s*'([^\r\n]*)',\s*\r?\n\s*\{'Off', 'Typed lines', 'Typed and spoken lines'\}\)/.exec(ui);
  assert(row, 'the row exists, a select over Off, Typed lines and Typed and spoken lines, default 2 (Typed lines)');
  assert(!/setting\('vVoiceMic'/.test(ui), 'there is no row of its own for microphone lines any more');
  assert.match(ui, /local vModeIndex = snapshot\.settings\.vVoiceMic == true and 3 or snapshot\.settings\.vVoice == true and 2 or 1/, 'spoken lines on reads as Typed and spoken lines');
  assert.match(row[1], /Typed and spoken lines: what you say by microphone \(hold to talk or Voice activation\) is also spoken by V, and the reply follows V’s line\./);
  assert.match(row[1], /V’s line is always waited for/, 'the reply follows V’s line');
  for (const dropped of [/never waits/i, /cut short/i, /Convai/, /Not available/]) assert.doesNotMatch(row[1], dropped, 'the old promise and exclusions are gone: ' + dropped);
  assert(row[1].length < 520, 'fits the description area without being cut');
  const lua = readFileSync(new URL('../mod/manager.lua', import.meta.url), 'utf8');
  assert.match(lua, /if type\(settings\.vVoiceMic\) ~= 'boolean' then settings\.vVoiceMic, settingsNeedSave = false, true end/, 'saved off by default');
  assert.match(lua, /vVoiceMic = settings\.vVoiceMic == true,/);
  // The list writes both stored keys: Off = neither, Typed lines = typed only, Typed and spoken lines = both.
  assert.match(ui, /values\.vVoice, values\.vVoiceMic = change\.value ~= 1, change\.value == 3/, 'the list sets vVoice (typed) and vVoiceMic (spoken) together');
});

test('the new V\'s voice texts (label, the three choices, the engine row) are in all 15 dictionaries', () => {
  for (const code of ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko']) {
    const file = readFileSync(new URL(`../mod/locales/${code}.lua`, import.meta.url), 'utf8');
    for (const text of ['Typed lines', 'Typed and spoken lines', 'V’s voice engine']) assert(file.includes('["' + text + '"] = "'), code + ': ' + text);
    assert(!file.includes('V speaks your microphone lines'), code + ': no old label left');
  }
});

// ---- what gets a V line ---------------------------------------------------------------------------------------------------

test('with the setting off a spoken turn gets no V line and nothing is loaded; typed lines are untouched either way', async () => {
  const {voice, calls, host} = feature();
  assert.equal(voice.startSpoken(spokenInput(), 'Hey Judy, how are you?'), null);
  assert.equal(voice.start(spokenInput({text: 'Hey Judy, how are you?'}), {spoken: true}), null);
  assert.equal(host.state.played, 0); assert.deepEqual(calls.stream, []);
  const typed = voice.start(typedInput()); await typed.finished;
  assert.equal(typed.spoken, false); assert.equal(calls.stream.length, 1, 'a typed line is spoken as before');
  voice.update({vVoice: true, ...micOn});
  const typedAgain = voice.start(typedInput()); await typedAgain.finished;
  assert.equal(typedAgain.spoken, false, 'a typed line is never a spoken one');
});

test('with the setting on, the final transcript reaches V\'s voice path: the same engine, volume and voice as a typed line', async () => {
  const {voice, calls, host} = feature({settings: micOn});
  const made = voice.startSpoken(spokenInput(), 'Hey Judy, how are you doing tonight?');
  assert(made, 'a line was started'); assert.equal(made.spoken, true);
  await until(() => made.state === 'playing' || made.settled, 'the line to play');
  assert.deepEqual(calls.stream, [['v-male', 'Hey Judy, how are you doing tonight?']], 'the transcript, not the placeholder, in V\'s male voice');
  assert.equal(host.state.config.text, 'Hey Judy, how are you doing tonight?');
  assert.equal(made.volume, 0.8, 'the game\'s dialogue volume, as for a typed line');
  assert.equal(made.plan.engine, 'pocket');
  host.state.end = true; await made.finished;
  assert.equal(calls.reports.at(-1).spoken, true, 'the record says it was a spoken line');
  assert.equal(calls.reports.at(-1).result, 'played');
  const female = voice.startSpoken(spokenInput({turnContext: {version: 1, status: 'ready', gender: 'female', dialogueVolume: 0.5}}), 'Hi.');
  host.state.end = true; await female.finished;
  assert.equal(calls.stream.at(-1)[0], 'v-female');
});

test('the same gates as a typed line: a reaction, a phone chat and a later group speaker never get one; no gender or volume says nothing', () => {
  const {voice, host} = feature({settings: micOn});
  for (const extra of [{reaction: {kind: 'battle'}}, {channel: 'phone'}, {group: {index: 2, total: 2}}])
    assert.equal(voice.startSpoken(spokenInput(extra), 'Hello there.'), null, JSON.stringify(extra));
  assert.equal(voice.startSpoken(spokenInput({turnContext: {version: 1, status: 'ready', dialogueVolume: 0.5}}), 'Hello there.'), null, 'V\'s gender unknown');
  assert.equal(voice.startSpoken(spokenInput({turnContext: {version: 1, status: 'ready', gender: 'male'}}), 'Hello there.'), null, 'volume unknown');
  assert.equal(voice.startSpoken(spokenInput({turnContext: {version: 1, status: 'ready', gender: 'male', dialogueVolume: 0}}), 'Hello there.'), null, 'game muted');
  assert.equal(host.state.played, 0);
  const first = voice.startSpoken(spokenInput({group: {index: 1, total: 2}}), 'Hello there.');
  assert(first, 'the first speaker of a group round does');
  first.drop('test over');
});

test('language rules are the typed line\'s: Pocket skips a language it cannot speak, Voxtral speaks the ones its model lists', () => {
  const pocket = feature({settings: micOn, planFor: () => ({engine: 'pocket', language: 'de'})});
  assert.equal(pocket.voice.startSpoken(spokenInput(), 'Wie geht es dir heute Abend?'), null);
  assert.equal(pocket.host.state.played, 0);
  const cloud = {problem: () => null, stream: async (key, text, options) => { await options.onPcm(packet()); return {}; }, speaks: language => language === 'de', languageSet: () => null};
  const voxtral = feature({settings: {...micOn, vVoiceEngine: 'voxtral'}, cloud, planFor: () => ({engine: 'voxtral', language: 'de'})});
  const spokenGerman = voxtral.voice.startSpoken(spokenInput(), 'Wie geht es dir heute Abend?');
  assert(spokenGerman, 'a language the cloud voice lists is spoken'); spokenGerman.drop('test over');
  const french = feature({settings: {...micOn, vVoiceEngine: 'voxtral'}, cloud, planFor: () => ({engine: 'voxtral', language: 'fr'})});
  assert.equal(french.voice.startSpoken(spokenInput(), 'Comment vas-tu ce soir ?'), null, 'a language it does not list is skipped');
});

test('OmniVoice speaks a spoken line like a typed one: queued on the worker at once, waited for, the reply follows it', async () => {
  const rendered = [];
  const omni = {problem: () => null, render: async (key, text) => { rendered.push([key, text]); return {audio: ''}; }, prepare: async () => {}};
  const {voice} = feature({settings: {...micOn, vVoiceEngine: 'omni'}, omni, planFor: () => ({engine: 'omni', language: 'en'})});
  const spoken = voice.startSpoken(spokenInput(), 'Hey Judy, how are you?');
  const typed = voice.start(typedInput());
  assert(spoken && typed, 'both start');
  assert.equal(spoken.patient, true, 'waited for, with no grace and no budget, exactly as a typed line');
  assert.equal(spoken.patient, typed.patient);
  assert.equal(spoken.holds(), true, 'the reply waits behind V\'s render');
  await until(() => rendered.length > 0, 'the render to be queued');
  assert.deepEqual(rendered[0], ['v-male', 'Hey Judy, how are you?'], 'the transcript was queued on the Omni worker at once');
  spoken.drop('test over'); typed.drop('test over');
});

test('an empty transcript, or one with nothing to say, produces no V line', () => {
  const {voice, host} = feature({settings: micOn});
  for (const text of ['', '   ', '...', '?!', undefined, null, 42]) assert.equal(voice.startSpoken(spokenInput(), text), null, String(text));
  assert.equal(host.state.played, 0);
});

// ---- the reply follows V, exactly as for a typed line -------------------------------------------------------------------

test('an audible spoken line holds the reply until it has ended, and is never cut: the same states as a typed line', async () => {
  const {voice, host} = feature({settings: micOn});
  const spoken = voice.startSpoken(spokenInput(), 'Hey Judy, how are you doing tonight?');
  // A typed line on a voice of its own (one line at a time per voice: a second waits for the first).
  const other = feature({settings: micOn});
  const typed = other.voice.start(typedInput({requestId: 'r2'}));
  await until(() => spoken.state === 'playing' && typed.state === 'playing', 'both audible');
  for (const made of [spoken, typed]) {
    assert.equal(made.holds(), true, 'the reply waits while V is audible');
    assert.equal(made.holdsPublish(), true, 'V\'s end is not known yet: the reply waits');
    assert.equal(made.holdsPublishPeek(), true);
    assert.equal(made.blocking, true, 'and its sound too');
  }
  // The reply asks to be published as a whole: it waits for V, it does not cut it.
  let released = false;
  const waiting = spoken.waitClear().then(() => { released = true; });
  await sleep(30);
  assert.equal(released, false, 'the reply is still waiting');
  assert.equal(spoken.state, 'playing', 'V was not cut');
  assert.equal(host.state.aborted, false);
  host.state.end = true;
  await waiting;
  assert.equal(released, true, 'the reply follows once V has finished');
  assert.equal(spoken.state, 'done'); assert.equal(spoken.reason, null);
  assert.equal(spoken.holds(), false);
  other.host.state.end = true;
  await typed.finished;
});

test('the reply ready before V is audible waits for V\'s first audio and follows V\'s end, as for a typed line; only a stuck line is given up', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const slowStream = async (key, text, options) => { await gate; await options.onPcm(packet()); return {}; };
  const {voice, host} = feature({settings: micOn, graceMs: 5000, stream: slowStream});
  const spoken = voice.startSpoken(spokenInput(), 'Hey Judy, how are you doing tonight?');
  assert.equal(spoken.state, 'synth');
  assert.equal(spoken.holds(), true, 'not audible yet: the reply waits for the first audio (the grace)');
  assert.equal(spoken.state, 'synth', 'and the line is not dropped');
  release();
  await until(() => spoken.state === 'playing', 'V to become audible');
  assert.equal(spoken.holds(), true);
  host.state.end = true; await spoken.clear;
  assert.equal(spoken.state, 'done');
  assert.equal(spoken.holds(), false);
  // A line that never gives audio is given up after the grace, as a typed line is (here 60 ms).
  const stuck = feature({settings: micOn, graceMs: 60, stream: async (key, text, options) => { await new Promise(done => options.signal.addEventListener('abort', done, {once: true})); }});
  const stuckLine = stuck.voice.startSpoken(spokenInput(), 'Hey Judy, how are you doing tonight?');
  assert.equal(stuckLine.holds(), true);
  await stuckLine.clear;
  assert.equal(stuckLine.state, 'dropped'); assert.equal(stuckLine.reason, 'slower-than-reply');
  assert.equal(stuckLine.holds(), false, 'the reply goes on without it');
});

test('the companion\'s voice request does not stop a spoken line: it plays on and the reply follows it', async () => {
  const {voice, host} = feature({settings: micOn, isLocal: () => true});
  const made = voice.startSpoken(spokenInput(), 'Hey Judy, how are you doing tonight?');
  await until(() => made.state === 'playing', 'audible');
  made.companionVoiceStarted();
  assert.equal(made.state, 'playing'); assert.equal(host.state.aborted, false);
  host.state.end = true; await made.finished;
  assert.equal(made.state, 'done');
});

// ---- the turn: transcript callback, cancel, no speech ---------------------------------------------------------------------

// The microphone channel stand-in: prepareReply -> options (with onTranscript like the streamed route), then finishVoice calls onTranscript with the recognised words.
function turn(voiceOptions = {}, {own = false, prepare} = {}) {
  const made = feature({settings: micOn, ...voiceOptions});
  const micV = new MicVLines({vVoice: made.voice});
  const asked = [];
  const base = prepare ?? (async () => ({stream: {}, onTranscript: text => asked.push(text)}));
  const wrapped = micV.wrapPrepare(base, {own: () => own});
  return {...made, micV, wrapped, asked};
}

test('the transcript callback starts V\'s line beside the reply and passes the transcript on to the reply\'s own listener; the reply\'s lookup holds for it', async () => {
  const t = turn();
  const controller = new AbortController();
  const input = spokenInput();
  const options = await t.wrapped(input, controller.signal);
  assert.equal(t.micV.lineOf(input.requestId), null, 'nothing is spoken before the words are known');
  assert.equal(typeof options.onTranscript, 'function'); assert(options.stream, 'the reply\'s own options are kept');
  options.onTranscript('  Hey Judy, how are you doing tonight?  ');
  assert.deepEqual(t.asked, ['  Hey Judy, how are you doing tonight?  '], 'the reply\'s listener still gets the words');
  const line = t.micV.lineOf(input.requestId);
  assert(line && line.spoken, 'a line exists for the turn');
  await until(() => line.state === 'playing', 'audible');
  assert.deepEqual(t.calls.stream, [['v-male', 'Hey Judy, how are you doing tonight?']]);
  options.onTranscript('a second call changes nothing');
  assert.equal(t.micV.lineOf(input.requestId), line); assert.equal(t.calls.stream.length, 1);
  // The reply asks (current.vLine is this lookup): it waits for V.
  assert.equal(t.micV.lineOf(input.requestId).holds(), true);
  t.host.state.end = true;
  await line.finished;
  assert.equal(line.state, 'done');
  assert.equal(t.micV.lineOf(input.requestId), null, 'a settled line is forgotten');
});

test('a cancelled turn, or a recording that ended with no speech, produces no V line', async () => {
  // Cancelled before the words are known (the microphone session aborts its signal): the callback starts nothing.
  const early = turn(); const earlyController = new AbortController();
  const earlyOptions = await early.wrapped(spokenInput(), earlyController.signal);
  earlyController.abort();
  earlyOptions.onTranscript('Hey Judy, how are you?');
  assert.equal(early.micV.lineOf('1-2-3ULL'), null); assert.equal(early.host.state.played, 0);
  // Cancelled while V is speaking: the line is dropped with the turn.
  const late = turn(); const lateController = new AbortController();
  const lateOptions = await late.wrapped(spokenInput(), lateController.signal);
  lateOptions.onTranscript('Hey Judy, how are you doing tonight?');
  const line = late.micV.lineOf('1-2-3ULL');
  await until(() => line.state === 'playing', 'audible');
  lateController.abort();
  await line.finished;
  assert.equal(line.state, 'dropped'); assert.equal(line.reason, 'turn-ended'); assert.equal(late.host.state.aborted, true);
  // No speech: the channel fails before the callback is ever called, and an empty or blank callback starts nothing.
  const none = turn(); const noneOptions = await none.wrapped(spokenInput(), new AbortController().signal);
  noneOptions.onTranscript(''); noneOptions.onTranscript('   '); noneOptions.onTranscript(undefined);
  assert.equal(none.micV.lineOf('1-2-3ULL'), null); assert.equal(none.host.state.played, 0);
  // A new turn (a typed message, a new recording) ends the previous turn's line.
  const next = turn(); const nextOptions = await next.wrapped(spokenInput(), new AbortController().signal);
  nextOptions.onTranscript('Hey Judy, how are you doing tonight?');
  const speaking = next.micV.lineOf('1-2-3ULL'); await until(() => speaking.state === 'playing', 'audible');
  next.micV.dropAll('turn-ended'); await speaking.finished;
  assert.equal(speaking.reason, 'turn-ended'); assert.equal(next.micV.lineOf('1-2-3ULL'), null);
});

test('nothing changes with the setting off, or for an add-on\'s voice turn (it starts V itself)', async () => {
  const base = async () => ({stream: {}});
  const off = turn({settings: {vVoiceMic: false}}, {prepare: base});
  assert.deepEqual(await off.wrapped(spokenInput(), new AbortController().signal), {stream: {}}, 'the very same options');
  assert.equal(off.micV.convaiHooks(spokenInput(), new AbortController().signal), null, 'and no hooks for the Convai provider');
  const addon = turn({}, {own: true, prepare: base});
  assert.deepEqual(await addon.wrapped(spokenInput(), new AbortController().signal), {stream: {}});
  assert.equal(addon.micV.convaiHooks(spokenInput(), new AbortController().signal), null);
});

// ---- the Convai provider: the transcript arrives in the stream, the buffered reply is held behind V like a typed line's -------------

test('Convai hooks: the reply waits for the transcript until V\'s line starts from it, and the speech is woken when the line nears its end or clears', async () => {
  const t = turn({}, {prepare: async () => undefined});
  const input = spokenInput();
  const signal = new AbortController().signal;
  await t.wrapped(input, signal);
  let woken = 0;
  const hooks = t.micV.convaiHooks(input, signal, () => { woken++; });
  assert(hooks, 'the turn has hooks');
  assert.equal(hooks.awaitTranscript(), true, 'no transcript yet: the reply waits');
  hooks.onTranscript('Hey Judy, how are you doing tonight?');
  assert.equal(hooks.awaitTranscript(), false, 'the line started: nothing more to wait for');
  const line = t.micV.lineOf(input.requestId);
  assert(line);
  await until(() => line.state === 'playing', 'audible');
  t.host.state.end = true;
  await line.finished;
  assert(woken >= 1, 'the speech was woken when the line cleared');
  // A transcript V cannot speak (a language Pocket does not speak) ends the wait too: nothing to hold for.
  const german = turn({planFor: () => ({engine: 'pocket', language: 'de'})}, {prepare: async () => undefined});
  await german.wrapped(input, signal);
  const germanHooks = german.micV.convaiHooks(input, signal);
  assert.equal(germanHooks.awaitTranscript(), true);
  germanHooks.onTranscript('Wie geht es dir heute Abend?');
  assert.equal(germanHooks.awaitTranscript(), false);
  assert.equal(german.micV.lineOf(input.requestId), null);
});

function convaiSpeech(hooks, vLineOf, clock) {
  const owner = {requestId: 'reply-1', entity: 'judy-copy-2', generation: 7};
  const events = [];
  const speech = new ConvaiContinuousSpeech({input: owner, profile: {key: 'judy-alvarez'}, token: 'continuous-1', now: () => clock.now,
    signal: new AbortController().signal, current: async () => true,
    hold: () => vLineOf()?.holdsPublish() === true, holdPeek: () => vLineOf()?.holdsPublishPeek() === true, holdSound: () => vLineOf()?.blocking === true,
    onTranscript: hooks.onTranscript, awaitTranscript: hooks.awaitTranscript,
    readControl: async () => JSON.stringify({version: 1, id: 'continuous-1', ...owner, sequence: 1, updated: clock.now, allow: true, paused: false, volume: 0.8, pan: 0}),
    writeState: async () => true,
    writeReply: async () => { events.push('reply'); return true; }});
  return {speech, events};
}
const replySnapshot = (extra = {}) => ({version: 1, token: 'continuous-1', sampleRate: 24000, channels: 1, receivedFrames: 12000, positionSeconds: 0,
  text: 'Hey V.', textComplete: false, sourceComplete: false, ended: false, underruns: 0, state: 'buffering', ...extra});

test('Convai: the buffered reply stays quiet until the transcript is in, V\'s line starts from it, and the reply is published only after V has ended', async () => {
  const t = turn({graceMs: 5000}, {prepare: async () => undefined});
  const input = spokenInput();
  const signal = new AbortController().signal;
  await t.wrapped(input, signal);
  const clock = {now: 10000};
  const hooks = t.micV.convaiHooks(input, signal);
  const {speech, events} = convaiSpeech(hooks, () => t.micV.lineOf(input.requestId), clock);
  // Audio is already buffering but the words are not here: quiet, nothing published.
  assert.deepEqual(await speech.frame(replySnapshot()), {allow: false, paused: true, volume: 0, pan: 0});
  clock.now += 400;
  assert.deepEqual(await speech.frame(replySnapshot()), {allow: false, paused: true, volume: 0, pan: 0});
  assert.deepEqual(events, []);
  // The words arrive: V's line starts from them and holds the reply.
  const withWords = replySnapshot({userText: 'Hey Judy, how are you doing tonight?'});
  assert.deepEqual(await speech.frame(withWords), {allow: false, paused: true, volume: 0, pan: 0});
  const line = t.micV.lineOf(input.requestId);
  assert(line, 'V\'s line started from the transcript in the stream');
  await until(() => line.state === 'playing', 'V to be audible');
  assert.deepEqual(await speech.frame(withWords), {allow: false, paused: true, volume: 0, pan: 0}, 'held while V is audible');
  assert.deepEqual(events, [], 'nothing published while V is audible');
  t.host.state.end = true; await line.clear;
  const control = await speech.frame(withWords);
  assert.equal(control.allow, true, 'the reply starts once V has ended');
  assert.ok(events.includes('reply'));
});

test('Convai: the wait for the transcript is bounded, and never once the whole reply is in: then the reply goes on without V', async () => {
  const quietControl = {allow: false, paused: true, volume: 0, pan: 0};
  const make = () => {
    const t = turn({}, {prepare: async () => undefined});
    return t.wrapped(spokenInput(), new AbortController().signal).then(() => {
      const hooks = t.micV.convaiHooks(spokenInput(), new AbortController().signal);
      const clock = {now: 10000};
      return {t, clock, ...convaiSpeech(hooks, () => t.micV.lineOf('1-2-3ULL'), clock)};
    });
  };
  const bounded = await make();
  assert.deepEqual(await bounded.speech.frame(replySnapshot()), quietControl);
  bounded.clock.now += TRANSCRIPT_WAIT_MS - 100;
  assert.deepEqual(await bounded.speech.frame(replySnapshot()), quietControl, 'still inside the bound');
  bounded.clock.now += 200;
  assert.equal((await bounded.speech.frame(replySnapshot())).allow, true, 'the bound passed: the reply goes on without V');
  assert.equal(bounded.t.host.state.played, 0);
  const complete = await make();
  assert.equal((await complete.speech.frame(replySnapshot({textComplete: true, sourceComplete: true}))).allow, true, 'a reply that is entirely in does not wait');
  // A turn that wants no V line waits for nothing.
  const none = convaiSpeech({onTranscript: () => {}, awaitTranscript: () => false}, () => null, {now: 10000});
  assert.equal((await none.speech.frame(replySnapshot())).allow, true);
});

// ---- the wiring ------------------------------------------------------------------------------------------------------------

test('the bridge wires it: a spoken turn\'s two currents look the line up, a new turn drops it, the Convai speech gets the hooks, an add-on or made character\'s voice turn starts V as spoken, and the reply path was not changed', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(bridge, /mic\.prepareReply = micV\.wrapPrepare\(mic\.prepareReply, \{own: input => addonVoice\.voice\(input\)\}\);/);
  assert.doesNotMatch(bridge, /micV\.wrapReply|mic\.onReply = |textRoute: \(\) => mistral\.active/, 'no clock plumbing and no provider exclusion any more');
  assert.equal(bridge.split('current.vLine = () => micV.lineOf(input.requestId);').length - 1, 2, 'prepareReply\'s current and onReply\'s current');
  const cancel = bridge.slice(bridge.indexOf('async function cancelMicrophone()'));
  assert(cancel.indexOf("micV.dropAll('turn-ended')") > 0 && cancel.indexOf("micV.dropAll('turn-ended')") < cancel.indexOf('await mic.cancel()'), 'a new turn ends the previous line');
  assert.match(bridge, /\{mic: micV\.convaiHooks\(input, signal, \(\) => speech\.wakeUp\(\)\) \?\? undefined\}/, 'the Convai provider\'s continuous speech');
  assert.match(bridge, /\.\.\.\(mic \? \{onTranscript: mic\.onTranscript, awaitTranscript: mic\.awaitTranscript\} : \{\}\),/);
  assert.equal(bridge.split('vLine = vVoice.start(input, {signal, clock, spoken: Boolean(userText)});').length - 1, 2, 'add-on and made-character voice turns');
  assert.match(bridge, /if \(vVoice\.micWanted\) \{ vVoice\.noteGender\(prepared\.input\); vVoice\.warmUp\(\); \}/, 'V\'s voice is warmed while the player talks');
  // The reply is held by the very same lookups as a typed turn's.
  assert.match(bridge, /hold: \(\) => ahead\?\.isHeld\(\) === true \|\| current\.vLine\?\.\(\)\?\.holdsPublish\(\) === true,/);
  assert.match(bridge, /await current\.vLine\?\.\(\)\?\.waitClear\(signal\);/);
  assert.match(bridge, /if \(!ahead\) vLine = vVoice\.start\(input, \{signal: controller\.signal, clock\}\);/, 'the typed turn is untouched');
  const voice = readFileSync(new URL('./v-voice.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(voice, /soft|yieldToReply|cut-for-reply|reply-ready|mic-omni|micUnavailable/, 'the cut-short rule is gone');
  const module = readFileSync(new URL('./mic-v-line.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /setInterval|requestAnimationFrame|readFile|writeFile|fetch\(/, 'no per-frame work, no file or network');
});
