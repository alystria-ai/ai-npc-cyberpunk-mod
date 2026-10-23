// V speaks your microphone lines (setting vVoiceMic, off by default; bridge/mic-v-line.mjs, the soft VLine in bridge/v-voice.mjs, docs/V_VOICE.md).
// Nothing here plays a sound: the renderer, the Pocket voice and the microphone channel are stand-ins.
import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {VVoice, VLine} from './v-voice.mjs';
import {MicVLines} from './mic-v-line.mjs';
import {TurnClock, markStage} from './turn-clock.mjs';

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
    let produced = false;
    const producing = producer(async () => {}, {signal: options.signal}).then(() => { produced = true; }, () => {});
    for (let poll = 0; poll < 3000 && await options.current(); poll++) {
      const ended = produced && state.end;
      options.onFrame({receivedFrames: 4800, sampleRate: 24000, sourceComplete: produced, positionSeconds: ended ? 1 : 0.1, ended});
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

test('the setting is off by default and only an explicit true turns it on; it means nothing while V\'s voice is off', () => {
  const voice = new VVoice({voices: {male: {key: 'v-male'}}});
  assert.equal(voice.micEnabled, false, 'until the settings are read');
  voice.update({});
  assert.equal(voice.enabled, true); assert.equal(voice.micEnabled, false, 'a file that never stored it: off');
  for (const value of ['yes', 1, null, false]) { voice.update({vVoiceMic: value}); assert.equal(voice.micEnabled, false, String(value)); }
  assert.equal(voice.update({vVoiceMic: true}), true, 'a change is reported'); assert.equal(voice.micEnabled, true);
  assert.equal(voice.update({vVoiceMic: true}), false);
  assert.equal(voice.micWanted, true);
  voice.update({vVoice: false, vVoiceChosen: true, vVoiceMic: true});
  assert.equal(voice.micEnabled, true, 'the saved choice is kept'); assert.equal(voice.micWanted, false, 'but V\'s voice is off: nothing is wanted');
  voice.update({vVoice: true, vVoiceMic: false});
  assert.equal(voice.micWanted, false);
  const bare = new VVoice({voices: {}});
  bare.update({vVoiceMic: true});
  assert.equal(bare.micWanted, false, 'no clips: nothing to say');
});

test('Settings > Voices carries the setting under V\'s voice, off by default, with the reason push-to-talk never replayed V in its description, in all 15 languages', () => {
  const ui = readFileSync(new URL('../mod/manager-ui.lua', import.meta.url), 'utf8');
  const row = /setting\('vVoiceMic', 'V speaks your microphone lines', 'bool', snapshot\.settings\.vVoiceMic == true, false,\s*\n\s*'([^\n]*)'\)/.exec(ui);
  assert(row, 'the row exists, default false');
  assert(ui.indexOf("setting('vVoice', ") < ui.indexOf("setting('vVoiceMic', "), 'under V\'s voice');
  assert.match(row[1], /Needs V’s voice on/);
  assert.match(row[1], /Off by default, because you just said it yourself/, 'the reason for the default');
  assert.match(row[1], /reply never waits for V/);
  assert(row[1].length < 420, 'fits the description area without being cut');
  for (const code of ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko']) {
    const file = readFileSync(new URL(`../mod/locales/${code}.lua`, import.meta.url), 'utf8');
    assert(file.includes('["V speaks your microphone lines"] = "'), code + ' label');
    assert(file.includes('["After you speak (hold to talk or Voice activation)'), code + ' description');
  }
  const lua = readFileSync(new URL('../mod/manager.lua', import.meta.url), 'utf8');
  assert.match(lua, /if type\(settings\.vVoiceMic\) ~= 'boolean' then settings\.vVoiceMic, settingsNeedSave = false, true end/, 'saved off by default');
  assert.match(lua, /vVoiceMic = settings\.vVoiceMic == true,/);
});

// ---- what gets a V line ---------------------------------------------------------------------------------------------------

test('with the setting off a spoken turn gets no V line and nothing is loaded; typed lines are untouched either way', async () => {
  const {voice, calls, host} = feature();
  assert.equal(voice.startSpoken(spokenInput(), 'Hey Judy, how are you?'), null);
  assert.equal(voice.start(spokenInput({text: 'Hey Judy, how are you?'}), {spoken: true}), null);
  assert.equal(host.state.played, 0); assert.deepEqual(calls.stream, []);
  const typed = voice.start(typedInput()); await typed.finished;
  assert.equal(typed.soft, false); assert.equal(calls.stream.length, 1, 'a typed line is spoken as before');
  voice.update({vVoice: true, ...micOn});
  const typedAgain = voice.start(typedInput()); await typedAgain.finished;
  assert.equal(typedAgain.soft, false, 'a typed line is never soft');
});

test('with the setting on, the final transcript reaches V\'s voice path: the same engine, volume and voice as a typed line', async () => {
  const {voice, calls, host} = feature({settings: micOn});
  const made = voice.startSpoken(spokenInput(), 'Hey Judy, how are you doing tonight?');
  assert(made, 'a line was started'); assert.equal(made.soft, true);
  await until(() => made.state === 'playing' || made.settled, 'the line to play');
  assert.deepEqual(calls.stream, [['v-male', 'Hey Judy, how are you doing tonight?']], 'the transcript, not the placeholder, in V\'s male voice');
  assert.equal(host.state.config.text, 'Hey Judy, how are you doing tonight?');
  assert.equal(made.volume, 0.8, 'the game\'s dialogue volume, as for a typed line');
  assert.equal(made.plan.engine, 'pocket');
  host.state.end = true; await made.finished;
  assert.equal(calls.reports.at(-1).spoken, true, 'the record says it was a spoken line');
  assert.equal(calls.reports.at(-1).result, 'played');
  // The female V, and the cloud engine, follow the turn exactly as a typed line does.
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

test('OmniVoice never speaks a spoken line: its render would sit in front of the reply\'s on the one GPU worker. The reason is logged once', () => {
  const omni = {problem: () => null, render: async () => ({audio: ''}), prepare: async () => {}};
  const {voice, calls, host} = feature({settings: {...micOn, vVoiceEngine: 'omni'}, omni, planFor: () => ({engine: 'omni', language: 'en'})});
  assert.equal(voice.startSpoken(spokenInput(), 'Hey Judy, how are you?'), null);
  assert.equal(voice.startSpoken(spokenInput(), 'Hey Judy, how are you?'), null);
  assert.equal(host.state.played, 0);
  assert.equal(calls.logs.filter(line => /OmniVoice would make the reply wait/.test(line)).length, 1);
  // A typed line on OmniVoice is still the waited-for one.
  const typed = voice.start(typedInput());
  assert(typed && typed.patient === true && typed.soft === false); typed.drop('test over');
});

test('an empty transcript, or one with nothing to say, produces no V line', () => {
  const {voice, host} = feature({settings: micOn});
  for (const text of ['', '   ', '...', '?!', undefined, null, 42]) assert.equal(voice.startSpoken(spokenInput(), text), null, String(text));
  assert.equal(host.state.played, 0);
});

// ---- the reply is never delayed -------------------------------------------------------------------------------------------

test('a spoken line never holds the reply: no hold, no publish hold, no sound hold, no wait, whatever state it is in', async () => {
  const { voice, host } = feature({settings: micOn});
  const made = voice.startSpoken(spokenInput(), 'Hey Judy, how are you doing tonight?');
  await until(() => made.state === 'playing', 'V to be audible');
  // Audible and long: a typed line would hold the reply here. This one does not.
  assert.equal(made.blocking, false); assert.equal(made.waiting, false);
  assert.equal(made.holdsPublishPeek(), false, 'peeking costs the line nothing');
  assert.equal(made.state, 'playing');
  const started = performance.now();
  assert.equal(made.holdsPublish(), false);
  await made.waitClear();
  assert(performance.now() - started < 50, 'the reply did not wait for V');
  assert.equal(made.state, 'dropped'); assert.equal(made.reason, 'cut-for-reply', 'an audible line is cut short');
  await made.clear; await made.finished;
  assert.equal(host.state.aborted, true, 'the renderer stopped playing it');
  assert.equal(made.holds(), false);
});

test('the contrast: the same audible line as a typed one holds the reply for as long as it plays', async () => {
  const host = openRenderer();
  const typed = new VLine({input: typedInput(), key: 'v-male', text: 'Hello Judy.', plan: {engine: 'pocket', language: 'en'}, volume: 0.6, play: host.play,
    stream: async (key, text, options) => { await options.onPcm(packet()); return {}; }, graceMs: 0});
  await until(() => typed.state === 'playing', 'audible');
  assert.equal(typed.holds(), true); assert.equal(typed.blocking, true);
  host.state.end = true; await typed.finished;
});

test('the reply ready before V is audible drops a spoken line at once (reply-ready), however slow its synthesis is', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const {voice, calls} = feature({settings: micOn, stream: async (key, text, options) => { await gate; await options.onPcm(packet()); return {}; }});
  const made = voice.startSpoken(spokenInput(), 'Hey Judy, how are you doing tonight?');
  assert.equal(made.state, 'synth');
  const started = performance.now();
  await made.waitClear();
  assert(performance.now() - started < 50);
  assert.equal(made.state, 'dropped'); assert.equal(made.reason, 'reply-ready');
  assert.equal(made.graceStarted, false, 'no grace is ever started for it');
  release(); await made.finished;
  assert.equal(calls.reports.at(-1).reason, 'reply-ready');
});

test('a line that is already over when the reply asks is left alone, and the reply is not held either', async () => {
  const { voice, host } = feature({settings: micOn});
  const made = voice.startSpoken(spokenInput(), 'Yes.');
  await until(() => made.state === 'playing', 'audible');
  host.state.end = true; await made.clear;
  assert.equal(made.state, 'done');
  assert.equal(made.holdsPublish(), false); assert.equal(made.state, 'done', 'a finished line is not turned into a drop');
});

test('the companion\'s voice request on the worker V shares ends a spoken line at once (it would queue behind V); a worker of its own or the cloud is left to play', async () => {
  const shared = feature({settings: micOn, isLocal: () => true});
  const sharedLine = shared.voice.startSpoken(spokenInput(), 'Hey Judy, how are you doing tonight?');
  await until(() => sharedLine.state === 'playing', 'audible');
  sharedLine.companionVoiceStarted();
  assert.equal(sharedLine.state, 'dropped'); assert.equal(sharedLine.reason, 'cut-for-reply');
  await sharedLine.finished;
  const own = feature({settings: micOn, isLocal: () => true, helper: {speaks: () => true, ready: () => true, stream: async (key, text, options) => { await options.onPcm(packet()); return {}; }, prepare: async () => {}}});
  const ownLine = own.voice.startSpoken(spokenInput(), 'Hey Judy, how are you doing tonight?');
  await until(() => ownLine.state === 'playing', 'audible');
  ownLine.companionVoiceStarted();
  assert.equal(ownLine.state, 'playing', 'V\'s own worker shares nothing with the reply');
  own.host.state.end = true; await ownLine.finished;
});

// ---- the turn: transcript callback, cancel, no speech ---------------------------------------------------------------------

// The microphone channel stand-in: prepareReply -> options (with onTranscript like the streamed route), then finishVoice calls onTranscript with the recognised words.
function turn(voiceOptions = {}, {textRoute = true, own = false, prepare} = {}) {
  const made = feature({settings: micOn, ...voiceOptions});
  const micV = new MicVLines({vVoice: made.voice});
  const asked = [];
  const base = prepare ?? (async () => ({stream: {}, onTranscript: text => asked.push(text)}));
  const wrapped = micV.wrapPrepare(base, {own: () => own, textRoute: () => textRoute});
  return {...made, micV, wrapped, asked};
}

test('the transcript callback starts V\'s line beside the reply and passes the transcript on to the reply\'s own listener', async () => {
  const t = turn();
  const controller = new AbortController();
  const input = spokenInput();
  const options = await t.wrapped(input, controller.signal);
  assert.equal(t.micV.lineOf(input.requestId), null, 'nothing is spoken before the words are known');
  assert.equal(typeof options.onTranscript, 'function'); assert(options.stream, 'the reply\'s own options are kept');
  options.onTranscript('  Hey Judy, how are you doing tonight?  ');
  assert.deepEqual(t.asked, ['  Hey Judy, how are you doing tonight?  '], 'the reply\'s listener still gets the words');
  const line = t.micV.lineOf(input.requestId);
  assert(line && line.soft, 'a soft line exists for the turn');
  await until(() => line.state === 'playing', 'audible');
  assert.deepEqual(t.calls.stream, [['v-male', 'Hey Judy, how are you doing tonight?']]);
  options.onTranscript('a second call changes nothing');
  assert.equal(t.micV.lineOf(input.requestId), line); assert.equal(t.calls.stream.length, 1);
  // The reply asks (current.vLine is this lookup): the line yields, nothing waits.
  assert.equal(t.micV.lineOf(input.requestId).holds(), false);
  await line.finished;
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

test('nothing changes with the setting off, for an add-on\'s voice turn (it starts V itself) or on the Convai provider (no transcript before the reply, logged once)', async () => {
  const base = async () => ({stream: {}});
  const off = turn({settings: {vVoiceMic: false}}, {prepare: base});
  assert.deepEqual(await off.wrapped(spokenInput(), new AbortController().signal), {stream: {}}, 'the very same options');
  const addon = turn({}, {own: true, prepare: base});
  assert.deepEqual(await addon.wrapped(spokenInput(), new AbortController().signal), {stream: {}});
  const convai = turn({}, {textRoute: false, prepare: base});
  assert.deepEqual(await convai.wrapped(spokenInput(), new AbortController().signal), {stream: {}});
  await convai.wrapped(spokenInput({requestId: '9-9-9ULL'}), new AbortController().signal);
  assert.equal(convai.calls.logs.filter(line => /Convai provider recognises speech together with the reply/.test(line)).length, 1, 'said once');
  assert.equal(convai.host.state.played, 0);
});

test('the reply is made inside the turn\'s clock, so its voice request marks ttsSent there and a V line on the shared worker steps aside (never delaying the reply)', async () => {
  let inside = null;
  const t = turn({}, {prepare: async () => { inside = true; markStage('ttsSent'); return {}; }});
  const input = spokenInput();
  await t.wrapped(input, new AbortController().signal);
  const clock = t.micV.clockOf(input.requestId);
  assert(clock instanceof TurnClock); assert.equal(inside, true);
  assert('ttsSent' in clock.snapshot().marks, 'the reply\'s voice request marked the turn\'s clock');
  // The companion's voice request that went out BEFORE V's line exists (a fast reply) ends the line the moment it starts: it would queue behind it.
  const fast = await t.wrapped(spokenInput({requestId: '6-6-6ULL'}), new AbortController().signal);
  fast.onTranscript('Hey Judy, how are you doing tonight?');
  assert.equal(t.micV.lineOf('6-6-6ULL'), null, 'the line was ended at once and is forgotten');
  assert.equal(t.calls.reports.at(-1).reason, 'reply-ready');
  // After the words: the voice request of the companion goes out later, the V line is cut.
  const quiet = turn({}, {prepare: async () => ({})});
  const options = await quiet.wrapped(spokenInput({requestId: '5-5-5ULL'}), new AbortController().signal);
  options.onTranscript('Hey Judy, how are you doing tonight?');
  const line = quiet.micV.lineOf('5-5-5ULL'); await until(() => line.state === 'playing', 'audible');
  quiet.micV.clockOf('5-5-5ULL').mark('ttsSent');
  assert.equal(line.state, 'dropped'); assert.equal(line.reason, 'cut-for-reply');
  await line.finished;
  // The non-streamed reply is made inside the clock as well.
  let seen = null;
  await t.micV.wrapReply(async () => { seen = true; })({requestId: input.requestId}, {}, undefined);
  assert.equal(seen, true);
});

test('the bridge wires it: a spoken turn\'s two currents look the line up, a new turn drops it, an add-on or made character\'s voice turn starts V as spoken, and the reply path was not changed', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(bridge, /mic\.prepareReply = micV\.wrapPrepare\(mic\.prepareReply, \{own: input => addonVoice\.voice\(input\), textRoute: \(\) => mistral\.active\}\);/);
  assert.match(bridge, /mic\.onReply = micV\.wrapReply\(mic\.onReply\);/);
  assert.equal(bridge.split('current.vLine = () => micV.lineOf(input.requestId);').length - 1, 2, 'prepareReply\'s current and onReply\'s current');
  const cancel = bridge.slice(bridge.indexOf('async function cancelMicrophone()'));
  assert(cancel.indexOf("micV.dropAll('turn-ended')") > 0 && cancel.indexOf("micV.dropAll('turn-ended')") < cancel.indexOf('await mic.cancel()'), 'a new turn ends the previous line');
  assert.equal(bridge.split('vLine = vVoice.start(input, {signal, clock, spoken: Boolean(userText)});').length - 1, 2, 'add-on and made-character voice turns');
  assert.match(bridge, /if \(vVoice\.micWanted\) \{ vVoice\.noteGender\(prepared\.input\); vVoice\.warmUp\(\); \}/, 'V\'s voice is warmed while the player talks');
  // Nothing about how the reply is held or ordered changed: the holds still read current.vLine, a line that yields returns false.
  assert.match(bridge, /hold: \(\) => ahead\?\.isHeld\(\) === true \|\| current\.vLine\?\.\(\)\?\.holdsPublish\(\) === true,/);
  assert.match(bridge, /await current\.vLine\?\.\(\)\?\.waitClear\(signal\);/);
  // The typed turn is untouched: V starts at the top of runInput, not soft.
  assert.match(bridge, /if \(!ahead\) vLine = vVoice\.start\(input, \{signal: controller\.signal, clock\}\);/);
  // The new module does no work per frame and touches no file or network.
  const module = readFileSync(new URL('./mic-v-line.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /setInterval|requestAnimationFrame|readFile|writeFile|fetch\(/);
});
