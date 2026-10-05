import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {AnalysisPcm, decodeAnalysisPcm} from './analysis-pcm.mjs';
import {parseFaceModel, FaceModelStream} from './jali-face-model.mjs';
import {JALI_TIMELINE_TRACKS} from './jali-face.mjs';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';
import {syntheticModel, speechLike} from './jali-face-fixture.mjs';

const pcm16 = (samples, channels = 1) => {
  const bytes = new Uint8Array(samples.length * 2 * channels), view = new DataView(bytes.buffer);
  samples.forEach((v, i) => { for (let c = 0; c < channels; c++) view.setInt16((i * channels + c) * 2, Math.round(v * 32767) + c, true); });
  return bytes;
};

test('analysis PCM is addressed by absolute frame, downmixed without gain and decoded exactly', () => {
  const tone = speechLike(.3, 16000), stereo = new AnalysisPcm(2);
  stereo.append(pcm16(tone.subarray(0, 1000), 2), 0);
  stereo.append(pcm16(tone.subarray(1000), 2), 1000);
  assert.throws(() => stereo.append(pcm16(tone.subarray(0, 10), 2), 10), /out of order/);
  const first = stereo.slice(0, 1500), rest = stereo.slice(1500);
  assert.equal(first.frames, 1500); assert.equal(rest.offsetFrames, 1500); assert.equal(rest.frames, tone.length - 1500);
  assert.equal(stereo.slice(tone.length), undefined); assert.equal(stereo.slice(tone.length + 1), undefined);
  const decoded = [...decodeAnalysisPcm(first, 0), ...decodeAnalysisPcm(rest, 1500)];
  // Channels differ by one LSB; their average rounds to within one LSB of the source.
  decoded.forEach((v, i) => assert(Math.abs(v - Math.round(tone[i] * 32767) / 32768) <= 1.5 / 32768, `${i}`));
  assert.throws(() => decodeAnalysisPcm(rest, 1499), /Invalid analysis PCM/);
  assert.throws(() => decodeAnalysisPcm({...rest, data: rest.data.slice(4)}, 1500), /Invalid analysis PCM/);
});

const owner = {requestId: 'reply-1', entity: 'judy-copy-2', generation: 7};
const poses = duration => Array.from({length: Math.round(duration * 60) + 1}, (_, i) => {
  const values = Array(61).fill(0); values[17] = .3; values[44] = .5; // jaw + a brow expression channel
  return {at: i / 60, values};
});
function fixture({jaliFace} = {}) {
  const f = {states: [], abort: new AbortController(), now: 10000};
  f.raw = JSON.stringify({version: 1, id: 'continuous-1', ...owner, sequence: 1, updated: f.now,
    allow: true, paused: false, volume: 1, pan: 0});
  f.stream = new ConvaiContinuousSpeech({input: owner, profile: {key: 'judy-alvarez'}, token: 'continuous-1',
    signal: f.abort.signal, now: () => f.now, current: async () => true, jaliFace,
    readControl: async () => f.raw, writeState: async value => { f.states.push(structuredClone(value)); return true; },
    writeReply: async () => true});
  return f;
}
function inProcessFace(model) {
  const sessions = [];
  return {sessions, begin: rate => {
    const stream = new FaceModelStream(model, rate), session = {frames: stream, onUpdate() {}, closed: false,
      push: pcm => { stream.push(pcm); session.onUpdate(); }, finish: () => { stream.finish(); session.onUpdate(); },
      close: () => { session.closed = true; }};
    sessions.push(session); return session;
  }};
}

test('Convai continuous speech drives the mouth from its PCM via the model and keeps provider expressions', async () => {
  const {meta, buffer} = syntheticModel({lookahead: 3}), model = parseFaceModel(meta, buffer);
  const jaliFace = inProcessFace(model), f = fixture({jaliFace}), audio = speechLike(1, 24000);
  const source = new AnalysisPcm(1); source.append(pcm16(audio), 0);
  const snap = (received, position, complete = false) => ({version: 1, token: 'continuous-1', sampleRate: 24000, channels: 1,
    receivedFrames: received, positionSeconds: position, text: 'Hey V.', textComplete: complete, sourceComplete: complete,
    ended: false, underruns: 0, state: 'playing', faces: poses(received / 24000), facesFormat: 'arkit61', facesTimebase: 'audio-seconds',
    ...(f.stream.pcmCursor() !== undefined ? {pcm: source.slice(f.stream.pcmCursor(), received - f.stream.pcmCursor())} : {})});
  assert.equal(f.stream.options.pcmCursor(), undefined, 'no request before the model session exists');
  await f.stream.frame(snap(9600, 0));
  assert.equal(f.stream.pcmCursor(), 0, 'first snapshot opens the session; PCM is requested from frame 0');
  await f.stream.frame(snap(9600, 0));
  assert.equal(f.stream.pcmCursor(), 9600);
  let face = f.states.at(-1).face;
  assert.deepEqual(face.tracks, [...JALI_TIMELINE_TRACKS]);
  assert.equal(face.source, 'local-jali'); assert.equal(face.articulation, 'jali-audio-v1');
  assert.equal(face.providerExpressions.frames.length, face.frames.length);
  await f.stream.frame(snap(24000, .2, true));
  assert.equal(jaliFace.sessions[0].frames.finished, true);
  face = f.states.at(-1).face;
  assert.equal(face.complete, true); assert.equal(face.frames.at(-1).slice(1).every(v => v === 0), true);
  runLua(face);
  await f.stream.frame({...snap(24000, 1, true), ended: true});
  assert.equal(jaliFace.sessions[0].closed, true, 'the model session is released when playback drains');
});

test('a gap in analysis PCM drops the model for that stream and keeps the provider fallback in the same layout', async () => {
  const {meta, buffer} = syntheticModel(), jaliFace = inProcessFace(parseFaceModel(meta, buffer)), f = fixture({jaliFace});
  const source = new AnalysisPcm(1); source.append(pcm16(speechLike(.5, 24000)), 0);
  const base = {version: 1, token: 'continuous-1', sampleRate: 24000, channels: 1, receivedFrames: 12000, positionSeconds: 0,
    text: 'Hey V.', textComplete: false, sourceComplete: false, ended: false, underruns: 0, state: 'playing',
    faces: poses(.5), facesFormat: 'arkit61', facesTimebase: 'audio-seconds'};
  await f.stream.frame(base);
  await f.stream.frame({...base, pcm: source.slice(100)});
  assert.equal(f.stream.pcmCursor(), undefined); assert.equal(jaliFace.sessions[0].closed, true);
  const face = f.states.at(-1).face;
  assert.deepEqual(face.tracks, [...JALI_TIMELINE_TRACKS]); assert.equal(face.source, 'convai-arkit61');
  assert(face.frames[10][1] > 0, 'provider jaw continues');
  f.abort.abort();
});

test('without a model the Convai provider timeline is unchanged', async () => {
  const f = fixture();
  await f.stream.frame({version: 1, token: 'continuous-1', sampleRate: 24000, channels: 1, receivedFrames: 12000,
    positionSeconds: 0, text: 'Hey V.', textComplete: false, sourceComplete: false, ended: false, underruns: 0,
    state: 'playing', faces: poses(.5), facesFormat: 'arkit61', facesTimebase: 'audio-seconds'});
  const face = f.states.at(-1).face;
  assert.equal(face.source, 'convai-arkit61'); assert.equal(face.tracks.length, 22); assert.equal(f.stream.pcmCursor(), undefined);
});

test('the quantile map restores authored ranges monotonically and clamps at both ends', () => {
  const {meta, buffer} = syntheticModel({quantiles: [[0, .01, 1], [0, .5, .9]]}), model = parseFaceModel(meta, buffer);
  assert.equal(model.remap(0, -1), 0); assert(Math.abs(model.remap(0, 5) - .9) < 1e-6);
  assert(Math.abs(model.remap(0, .005) - .25) < 1e-6); assert(Math.abs(model.remap(3, .505) - .7) < 1e-6);
  const stream = new FaceModelStream(model, 16000); stream.push(speechLike(.4, 16000)); stream.finish();
  for (let i = 0; i < stream.ready * stream.outputs; i++) assert(stream.values[i] >= 0 && stream.values[i] <= .9 + 1e-6);
});

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const facial = readFileSync(new URL('../mod/facial-playback.lua', import.meta.url), 'utf8');
const luaLiteral = value => Array.isArray(value) ? `{${value.map(luaLiteral).join(',')}}` :
  value && typeof value === 'object' ? `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .map(([key, item]) => `[${JSON.stringify(key)}]=${luaLiteral(item)}`).join(',')}}` : value === null ? 'nil' : JSON.stringify(value);
function runLua(face) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const body = `NewObject=function() return {} end
    local judy={frames={},resets=0}
    function judy:GetEntityID() return {hash='judy-copy-2'} end
    function judy:IsAttached() return true end
    function judy:IsDeadNoStatPool() return false end
    function judy:ConvaiFaceReady() return true end
    function judy:ConvaiFaceApply(f) local c={};for k,v in pairs(f) do c[k]=v end;self.frames[#self.frames+1]=c;return true end
    function judy:ConvaiFaceReset() self.resets=self.resets+1;return true end
    convaiCompanions={owns=function() return true end}
    local face=(function() ${facial} end)()
    local context={requestId='reply-1',entity='judy-copy-2',generation=7}
    assert(face.updateContinuous(context,${luaLiteral(face)},judy,${face.duration}),face.error)
    assert(face.providerExpressions~=nil,'provider expressions stay with the model mouth')
    face.sync(judy,.3,'reply-1');assert(#judy.frames==1 and judy.frames[1].eye_l_brows_raise_out~=nil)
    face.sync(judy,${face.duration},'reply-1');assert(not face.active and judy.resets==1)`;
  const result = lauxlib.luaL_dostring(state, to_luastring(body));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
