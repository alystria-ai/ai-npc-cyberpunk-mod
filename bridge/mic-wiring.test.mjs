import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RealtimeHost} from './realtime-host.mjs';
import {MicTap, TAP} from './mic-tap.mjs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bridge = read('./convai-bridge.mjs');
const tick = (ms = 5) => new Promise(done => setTimeout(done, ms));

// ---- the bridge's wiring (the bridge is a script, so its shape is checked in its source) -------------------------------------------------------
test('the bridge gives every start command its tap, every finish its stop, every cancel its release, and keeps no minimum recording', () => {
  assert.match(bridge, /micTap\.open\(input\.requestId, \{holdId, vad: voiceTurn,/);
  assert.match(bridge, /else if \(command\.action === 'finish'\) void micTap\.stop\(input\.requestId\);/);
  assert.match(bridge, /else void micTap\.release\(input\.requestId, 'cancelled by the game'\);/);
  assert.match(bridge, /const mic = new MicrophoneSession\(\{hostFactory: addonVoice\.hostFactory\(\(\) => realtime\.voiceChannel\(\)\),\n[^\n]*\n  minRecordMs: 0,/);
  // the tap is opened before any preparation of the turn
  assert.ok(bridge.indexOf('micTap.open(input.requestId') < bridge.indexOf("await providerForTurn(input, {mic: true})"));
});

test('what microphone-live.json held before this bridge started is never acted on', () => {
  assert.match(bridge, /micLive\.observed = await readFile\(resolve\(runtime, 'microphone-live\.json'\), 'utf8'\)\.catch\(\(\) => ''\);/);
});

test('the local recogniser, Mistral transcription and Convai\'s page all take their audio from the one tap', () => {
  assert.match(bridge, /capture: new TapCapture\(\{tap: micTap\}\)/);
  assert.match(bridge, /realtime\.micTap = micTap;/);
  assert.match(bridge, /realtime\.onClosed = \(\) => \{ void micTap\.release\(undefined, 'the voice browser closed'\); micLive\.afterRelease\(\); \};/);
  assert.match(bridge, /realtime\.onStarted = \(\) => \{ void micCapture\.ensurePage\(\)\.catch\(\(\) => \{\}\); \};/);
  assert.match(bridge, /const micCapture = new LocalSttCapture\(\{getBrowser: hostBrowser\(realtime\)\}\);/);
});

test('Voice activation is read from the settings file, honoured only while on, and the detector state rides on the microphone state file', () => {
  assert.match(bridge, /if \(settings\) micLive\.setAllowed\(settings\.voiceActivation === true\);/);
  assert.match(bridge, /\{\.\.\.micStateLast, \.\.\.\(micVad \? \{vad: micVad\} : \{\}\), \.\.\.\(micCue \? \{cue: micCue\} : \{\}\), updated: Date\.now\(\)\}/);
  assert.match(bridge, /'microphone-live\.json': \(\) => micLive\.poll\(\)/);
  assert.match(bridge, /if \(state === 'off'\) void micTap\.release\(input\.requestId, 'the recording is over'\);/);
});

test('the Convai page microphone path still exists as the fallback and the relay can be switched off', () => {
  const host = read('./realtime-host.mjs');
  assert.match(host, /process\.env\.CYBERPUNK_CONVAI_MIC_RELAY !== '0'/);
  assert.match(host, /grantPermissions\(\['microphone'\]/);
  assert.match(host, /result\?\.relay !== true/);
});

// ---- the Convai route's pump ---------------------------------------------------------------------------------------------------------------
function fakeCapture() {
  let sink = null;
  return {emit: chunk => sink?.(chunk), begin: async onChunk => { sink = onChunk; return {device: 'Fake microphone'}; }, end: async () => { sink = null; }, abort: async () => { sink = null; }};
}
function fakeLease({acceptFrom = 0} = {}) {
  const calls = [];
  let closed = false;
  return {calls, close: () => { closed = true; },
    value: {isClosed: () => closed, evaluate: async (fn, text) => { calls.push(text); return calls.length > acceptFrom; }}};
}

test('the relay pump sends the kept audio first, then the live audio, in order, one call at a time', async () => {
  const capture = fakeCapture(), tap = new MicTap({capture});
  const host = new RealtimeHost({launchBrowser: async () => { throw Error('no browser in this test'); }});
  await tap.open('req-1');
  const spoken = [1, 2, 3, 4, 5].map(i => Buffer.alloc(1280, i));
  capture.emit(spoken[0]); capture.emit(spoken[1]);          // before the page exists
  const lease = fakeLease();
  const pump = host.startRelayPump(lease, tap, 'req-1');
  capture.emit(spoken[2]); capture.emit(spoken[3]); capture.emit(spoken[4]);
  await pump.idle();
  assert.deepEqual(lease.calls.map(text => Buffer.from(text, 'base64')[0]), [1, 2, 3, 4, 5]);
  assert.equal(pump.pushed, 5 * 1280);
});

test('a push the page refuses before its relay exists is offered again, in order; after the page answered a refusal is final', async () => {
  const capture = fakeCapture(), tap = new MicTap({capture});
  const host = new RealtimeHost({launchBrowser: async () => { throw Error('no browser in this test'); }});
  await tap.open('req-2');
  capture.emit(Buffer.alloc(1280, 1));
  const lease = fakeLease({acceptFrom: 3});       // the page refuses the first three offers
  const pump = host.startRelayPump(lease, tap, 'req-2');
  capture.emit(Buffer.alloc(1280, 2));
  await pump.idle();
  assert.deepEqual(lease.calls.map(text => Buffer.from(text, 'base64')[0]), [1, 1, 1, 1, 2], 'the first chunk waited for the relay and nothing overtook it');
  assert.equal(pump.failed, 0);
  const refusing = fakeLease({acceptFrom: 1000});
  const final = host.startRelayPump(refusing, new MicTap({capture: fakeCapture()}), 'nobody');
  assert.equal(final.closed, true, 'a pump for a tap this request does not own does nothing');
});

test('stopping the tap at the key release flushes the last block into the pump before the page is told to finish', async () => {
  let sink = null;
  const capture = {begin: async onChunk => { sink = onChunk; return {}; }, end: async () => { sink(Buffer.alloc(640, 9)); sink = null; }, abort: async () => {}};
  const tap = new MicTap({capture});
  const host = new RealtimeHost({launchBrowser: async () => { throw Error('no browser in this test'); }});
  await tap.open('req-3');
  sink(Buffer.alloc(1280, 1));
  const lease = fakeLease();
  lease.owner = 'o'; lease.tapOwner = 'req-3'; lease.pump = host.startRelayPump(lease, tap, 'req-3');
  host.voiceLease = lease; host.micTap = tap;
  await host.endVoiceCapture('o');
  assert.deepEqual(lease.calls.map(text => Buffer.from(text, 'base64')[0]), [1, 9], 'the last block reached the page');
  assert.equal(tap.state, 'ended');
  assert.ok(TAP.chunkMs > 0);
});

test('the request id reaches the voice channel beside the config, so the tap it owns is the one the channel takes', async () => {
  const seen = [];
  const host = new RealtimeHost({launchBrowser: async () => { throw Error('no browser in this test'); }});
  host.beginVoice = (config, options) => { seen.push([config, options]); return Promise.resolve({}); };
  await host.voiceChannel().beginVoice({characterId: 'x'}, {requestId: '7-1-9ULL'});
  assert.equal(seen[0][1].requestId, '7-1-9ULL');
  assert.deepEqual(seen[0][0], {characterId: 'x'}, 'the config itself is not touched (it keys the connection pool)');
  const session = read('./microphone-session.mjs');
  assert.match(session, /session\.host\.beginVoice\(config, \{requestId: input\.requestId\}\)/);
});

test('the hidden browser is not closed as idle while the microphone tap is open, and may be once it is closed', async () => {
  const capture = fakeCapture(), tap = new MicTap({capture});
  const host = new RealtimeHost({launchBrowser: async () => { throw Error('no browser in this test'); }});
  host.micTap = tap; host.browser = {isConnected: () => true}; host.close = async () => {};
  await tap.open('vad', {listen: true});
  assert.equal(await host.releaseIfIdle({idleMs: 0}), false, 'a listening microphone keeps it');
  await tap.release('vad');
  assert.equal(await host.releaseIfIdle({idleMs: 0}), true, 'a closed one does not');
});

test('the cold-start cue travels in microphone-state.json beside the vad field, keyed by the key press', () => {
  assert.match(bridge, /\.\.\.\(micCue \? \{cue: micCue\} : \{\}\)/);
  assert.match(bridge, /onCue: cue => \{ micCue = \{id: BOOT_ID \+ ':cue:' \+ \(\+\+micCueSeq\), hold: cue\.hold, phase: cue\.phase, cold: true\}/);
});

// ---- a key let go before the microphone opened --------------------------------------------------------------------------------------------------
// Live 2026-10-24 (a Bluetooth headset opens in 1.5 to 2.5 s): a hold of 2.2 s ended before the device opened, so nothing at all was captured; Convai
// then waited out its 15 s recognition window before saying "No speech was heard". The turn has no audio to recognise: it says so at once.
function finishFixture({captured}) {
  const capture = fakeCapture(), tap = new MicTap({capture});
  const host = new RealtimeHost({launchBrowser: async () => { throw Error('no browser in this test'); }});
  const pageCalls = [];
  const lease = {value: {isClosed: () => false, context: () => ({clearPermissions: async () => {}}),
    evaluate: async (fn, text) => { pageCalls.push(text); return true; }},
    release: async () => {}, unpin: () => {}, owner: 'o', epoch: host.epoch, config: {characterId: 'x'}, tapOwner: 'req-f'};
  host.voiceLease = lease; host.micTap = tap;
  host.evaluateSpeech = async () => { pageCalls.push('finishVoice'); throw Error('the page was asked to finish'); };
  return {capture, tap, host, lease, pageCalls, async run() {
    await tap.open('req-f');
    lease.pump = host.startRelayPump(lease, tap, 'req-f');
    for (let ms = 0; ms < captured; ms += TAP.chunkMs) capture.emit(Buffer.alloc(1280, 5));
    return host.finishVoice('o', undefined, {});
  }};
}

test('a recording that captured nothing (the key was let go before the device opened) fails as no speech without asking Convai', async () => {
  const f = finishFixture({captured: 0});
  await assert.rejects(f.run(), /^Error: No speech was heard$/);
  assert.equal(f.pageCalls.includes('finishVoice'), false, 'the page is never asked to finish, so nothing waits for Convai');
  assert.equal(f.tap.state, 'closed', 'the tap is given back');
  assert.equal(f.host.voiceLease, null);
});

test('a recording of a real length still goes to the page', async () => {
  const f = finishFixture({captured: 400});
  await assert.rejects(f.run(), /the page was asked to finish/);
});
