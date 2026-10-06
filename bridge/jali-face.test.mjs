import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fengari from 'fengari';
import {parseFaceModel, FaceModelStream, FaceModelFrames, Resampler, FACE_MODEL_FORMAT} from './jali-face-model.mjs';
import {JaliFace, JALI_TRACKS, JALI_TIMELINE_TRACKS, JALI_LEAD_SECONDS, JALI_LIMITS} from './jali-face.mjs';
import {buildFacialTimeline} from './facial-timeline.mjs';
import {PocketFacialStream, ownedPocketFace} from './pocket-facial-stream.mjs';
import {syntheticModel, speechLike} from './jali-face-fixture.mjs';

function rows(frames) {
  return Array.from({length: frames.ready}, (_, r) => Array.from(frames.values.subarray(r * frames.outputs, (r + 1) * frames.outputs)));
}

// Plain reference: features left-padded with silence, unpadded convolutions.
function reference(model, audio16) {
  const n = audio16.length < 400 ? 0 : Math.floor((audio16.length - 400) / 160) + 1, mels = model.mels, R = model.receptive;
  const feats = [];
  for (let r = 0; r < R - 1; r++) feats.push(Array.from(model.silence));
  for (let r = 0; r < n; r++) { const row = new Float32Array(mels); model.melFrame(audio16, r * 160, row, 0); feats.push(Array.from(row)); }
  const conv = (x, layer, d, relu) => {
    const out = [];
    for (let t = 0; t + (layer.k - 1) * d < x.length; t++) {
      out.push(Array.from({length: layer.out}, (_, o) => {
        let sum = layer.bias[o];
        for (let j = 0; j < layer.k; j++) for (let i = 0; i < layer.inp; i++) sum += x[t + j * d][i] * layer.weights[(j * layer.out + o) * layer.inp + i];
        return relu ? Math.max(0, sum) : sum;
      }));
    }
    return out;
  };
  let h = conv(feats, model.input, 1, true);
  for (const block of model.blocks) {
    const inner = conv(h, block.c1, block.dilation, true), mixed = conv(inner, block.c2, 1, false);
    h = mixed.map((row, t) => row.map((v, o) => Math.max(0, v + h[t + 2 * block.dilation][o])));
  }
  return conv(h, model.output, 1, true).map(row => row.map((v, o) => v * model.scale[o]));
}

test('streaming facial model matches a plain whole-utterance reference and is packet-invariant', () => {
  const {meta, buffer} = syntheticModel(), model = parseFaceModel(meta, buffer);
  const audio = speechLike(1.3, 16000), expected = reference(model, Float32Array.from([...audio, ...new Float32Array(meta.lookahead * 160 + 400)]));
  for (const packet of [audio.length, 1280, 333]) {
    const stream = new FaceModelStream(model, 16000);
    for (let at = 0; at < audio.length; at += packet) stream.push(audio.slice(at, at + packet));
    stream.finish();
    const actual = rows(stream);
    assert.equal(actual.length, expected.length);
    actual.forEach((row, r) => row.forEach((value, o) => assert(Math.abs(value - expected[r][o]) < 1e-4, `${packet}:${r}:${o}`)));
    assert(Math.abs(stream.duration - 1.3) < 1e-9 && stream.coveredSeconds() === stream.duration);
  }
});

test('stream coverage trails received audio by the model lookahead and never claims unheard rows', () => {
  const {meta, buffer} = syntheticModel({lookahead: 5}), model = parseFaceModel(meta, buffer);
  const stream = new FaceModelStream(model, 24000), audio = speechLike(.5, 24000);
  stream.push(audio.subarray(0, 4800));
  const covered = stream.coveredSeconds();
  assert(covered > 0 && covered < .2 - .05 + .02, `covered ${covered}`);
  stream.push(audio.subarray(4800)); stream.finish();
  assert.equal(stream.coveredSeconds(), .5);
  assert.throws(() => stream.push(audio), /finished/);
});

test('resampler keeps duration and frequency and is independent of packet size', () => {
  const tone = Float32Array.from({length: 24000}, (_, i) => Math.sin(2 * Math.PI * 440 * i / 24000));
  const whole = new Resampler(24000, 16000), a = [...whole.push(tone), ...whole.flush()];
  const pieces = new Resampler(24000, 16000), b = [];
  for (let at = 0; at < tone.length; at += 977) b.push(...pieces.push(tone.subarray(at, at + 977)));
  b.push(...pieces.flush());
  assert.equal(a.length, 16000); assert.equal(b.length, 16000);
  a.forEach((v, i) => assert(Math.abs(v - b[i]) < 1e-6));
  let crossings = 0; for (let i = 1000; i < 15000; i++) if (a[i - 1] < 0 && a[i] >= 0) crossings++;
  assert(Math.abs(crossings - 440 * 14000 / 16000) <= 2);
  for (let i = 2000; i < 14000; i += 997) assert(Math.abs(a[i] - Math.sin(2 * Math.PI * 440 * i / 16000)) < .01);
});

test('model files are validated: wrong format, truncated tensors and mismatched controls are rejected', async () => {
  const {meta, buffer} = syntheticModel();
  assert.throws(() => parseFaceModel({...meta, format: 'other'}, buffer), /Unsupported/);
  assert.throws(() => parseFaceModel(meta, buffer.subarray(0, 1000)), /tensor/);
  const nan = Buffer.from(buffer); nan.writeFloatLE(NaN, 0);
  assert.throws(() => parseFaceModel(meta, nan), /Non-finite/);
  const folder = mkdtempSync(join(tmpdir(), 'jali-face-'));
  try {
    writeFileSync(join(folder, 'face-model.json'), JSON.stringify({...meta, controls: meta.controls.slice().reverse()}));
    writeFileSync(join(folder, 'face-model.bin'), buffer);
    await assert.rejects(JaliFace.load(folder), /controls do not match/);
    assert.equal(await JaliFace.load(join(folder, 'missing')), null);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

test('worker client returns the same rows as in-process analysis and cancels cleanly', async () => {
  const {meta, buffer} = syntheticModel(), folder = mkdtempSync(join(tmpdir(), 'jali-face-'));
  writeFileSync(join(folder, 'face-model.json'), JSON.stringify(meta)); writeFileSync(join(folder, 'face-model.bin'), buffer);
  const face = await JaliFace.load(folder);
  try {
    assert.deepEqual(JALI_TRACKS, meta.controls.map(([, name]) => name));
    const audio = speechLike(.9, 24000), local = new FaceModelStream(parseFaceModel(meta, buffer), 24000);
    local.push(audio); local.finish();
    const frames = await face.analyse(audio, 24000);
    assert(frames instanceof FaceModelFrames && frames.finished && Math.abs(frames.duration - .9) < 1e-9);
    assert.deepEqual(rows(frames), rows(local));
    const controller = new AbortController(), pending = face.analyse(speechLike(3, 24000), 24000, {signal: controller.signal});
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(face.sessions.size, 0);
  } finally { await face.close(); rmSync(folder, {recursive: true, force: true}); }
});

test('an unexpected worker exit fails active analysis, then the model worker respawns', async () => {
  const {meta, buffer} = syntheticModel(), folder = mkdtempSync(join(tmpdir(), 'jali-face-'));
  writeFileSync(join(folder, 'face-model.json'), JSON.stringify(meta)); writeFileSync(join(folder, 'face-model.bin'), buffer);
  const face = await JaliFace.load(folder, {respawnMs: 10});
  try {
    const session = face.begin(16000);
    await face.worker.terminate();
    await assert.rejects(session.done, /stopped/);
    assert.throws(() => face.begin(16000), /unavailable/);
    await new Promise(done => setTimeout(done, 50));
    await face.ready;
    const frames = await face.analyse(speechLike(.3, 16000), 16000);
    assert.equal(frames.finished, true);
  } finally { await face.close(); rmSync(folder, {recursive: true, force: true}); }
});

const wavBase64 = pcm => {
  const bytes = Buffer.alloc(44 + pcm.length * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(pcm.length * 2, 40); pcm.forEach((v, i) => bytes.writeInt16LE(Math.round(v * 32767), 44 + i * 2));
  return bytes.toString('base64');
};

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const facial = readFileSync(new URL('../mod/facial-playback.lua', import.meta.url), 'utf8');
const luaLiteral = value => Array.isArray(value) ? `{${value.map(luaLiteral).join(',')}}` :
  value && typeof value === 'object' ? `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .map(([key, item]) => `[${JSON.stringify(key)}]=${luaLiteral(item)}`).join(',')}}` : value === null ? 'nil' : JSON.stringify(value);
function runLua(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const setup = `NewObject=function() return {} end
    local judy={frames={},resets=0}
    function judy:GetEntityID() return {hash='Judy-1'} end
    function judy:IsAttached() return true end
    function judy:IsDeadNoStatPool() return false end
    function judy:ConvaiFaceReady() return true end
    function judy:ConvaiFaceApply(f) local c={};for k,v in pairs(f) do c[k]=v end;self.frames[#self.frames+1]=c;return true end
    function judy:ConvaiFaceReset() self.resets=self.resets+1;return true end
    convaiCompanions={owns=function() return true end}
    local face=(function() ${facial} end)()
  `;
  const result = lauxlib.luaL_dostring(state, to_luastring(setup + body));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

test('Omni phrase: model frames become a local-jali timeline the native adapter applies without extra easing', async () => {
  const {meta, buffer} = syntheticModel({lookahead: 2}), model = parseFaceModel(meta, buffer);
  const pcm = speechLike(1.2, 24000), stream = new FaceModelStream(model, 24000);
  stream.push(pcm); stream.finish();
  const owner = {requestId: 'omni-jali', entity: 'Judy-1'};
  const timeline = buildFacialTimeline({audio: wavBase64(pcm), jaliFrames: stream}, owner);
  assert.equal(timeline.source, 'local-jali'); assert.equal(timeline.articulation, 'jali-audio-v1');
  assert.equal(timeline.motion, undefined); assert.deepEqual(timeline.tracks, [...JALI_TIMELINE_TRACKS]);
  assert.equal(timeline.frames[0].slice(1).every(v => v === 0), true, 'utterance start rests');
  assert.equal(timeline.frames.at(-1).slice(1).every(v => v === 0), true, 'utterance end rests');
  const at = timeline.frames[36], expected = stream.sample(36 / 60 + JALI_LEAD_SECONDS);
  const limit = name => JALI_LIMITS[name] ?? .5;
  expected.forEach((value, index) => assert(Math.abs(at[index + 1] - Math.round(Math.min(limit(JALI_TRACKS[index]), value) * 1e4) / 1e4) < 1e-9));
  // A duration mismatch or provider faces keep the older builders.
  assert.notEqual(buildFacialTimeline({audio: wavBase64(pcm.subarray(0, 12000)), jaliFrames: stream}, owner).source, 'local-jali');
  runLua(`
    local timeline=${luaLiteral(timeline)}
    local context={requestId='omni-jali',entity='Judy-1',generation=1}
    assert(face.start(context,timeline,judy,timeline.duration),face.error)
    face.sync(judy,.6,'omni-jali')
    local applied=judy.frames[#judy.frames]
    assert(math.abs(applied.jaw_mid_open-${at[1]})<1e-6,'jaw applied directly')
    assert(math.abs(applied.lips_puff_up-${at[1 + JALI_TIMELINE_TRACKS.indexOf('lips_puff_up')]})<1e-6)
    assert(face.status().source=='local-jali' and face.status().articulation=='jali-audio-v1')
    face.sync(judy,timeline.duration,'omni-jali');assert(not face.active and judy.resets==1)
  `);
});

test('model brows reach the expression layer on the audio clock, bounded and softened against the emotion', () => {
  const {meta, buffer} = syntheticModel({lookahead: 2, upper: true}), model = parseFaceModel(meta, buffer);
  const pcm = speechLike(1.2, 24000), stream = new FaceModelStream(model, 24000);
  stream.push(pcm); stream.finish();
  const timeline = buildFacialTimeline({audio: wavBase64(pcm), jaliFrames: stream}, {requestId: 'brows', entity: 'Judy-1'});
  const upper = timeline.modelExpressions;
  assert.equal(upper.format, 'jali-upper-v1'); assert.equal(upper.frames.length, timeline.frames.length);
  upper.frames.forEach((row, index) => assert.equal(row[0], timeline.frames[index][0]));
  const at = upper.frames.reduce((best, row, index) => row[1] > upper.frames[best][1] ? index : best, 1), [, raise] = upper.frames[at];
  assert(raise > 0, 'synthetic model raises the brows');
  runLua(`
    local timeline=${luaLiteral(timeline)}
    local context={requestId='brows',entity='Judy-1',generation=1}
    assert(face.start(context,timeline,judy,timeline.duration),face.error)
    face.sync(judy,${at / 60},'brows')
    local applied=judy.frames[#judy.frames]
    assert(math.abs(applied.eye_l_brows_raise_in-math.min(.15,.5*math.max(0,${raise}-.25)))<1e-4,'model brow raise, reduced and capped')
    assert(applied.eye_r_brows_raise_out==applied.eye_l_brows_raise_in)
    for k,v in pairs(applied) do assert(v<=1) end
    local bad=${luaLiteral({...timeline, modelExpressions: {...upper, frames: upper.frames.slice(1)}})}
    assert(face.start(context,bad,judy,timeline.duration) and face.modelExpressions==nil,'misaligned curves are ignored, speech continues')
  `);
});

test('native ranges of the game lipsync pass validation; out-of-range or unknown model data is rejected', () => {
  const tracks = [...JALI_TIMELINE_TRACKS], row = time => [time, ...tracks.map(() => 0)];
  const base = {version: 1, requestId: 'r', entity: 'Judy-1', duration: 1, source: 'local-jali', articulation: 'jali-audio-v1', tracks};
  const strong = row(.5); strong[1] = .66; strong[2] = 1; strong[3] = 1; strong[1 + tracks.indexOf('lips_suck_dn')] = .72;
  strong[1 + tracks.indexOf('lips_suck_up')] = .29; strong[1 + tracks.indexOf('lips_puff_up')] = .38;
  const frames = [row(0), strong, [1, ...tracks.map(() => 0)]];
  const tooOpen = structuredClone(frames); tooOpen[1][1] = .8;
  runLua(`
    local context={requestId='r',entity='Judy-1',generation=1}
    assert(face.start(context,${luaLiteral({...base, frames})},judy,1),face.error)
    assert(not face.start(context,${luaLiteral({...base, frames: tooOpen})},judy,1) and face.error:find('weight'))
    assert(not face.start(context,${luaLiteral({...base, articulation: 'other', frames})},judy,1) and face.error:find('articulation'))
  `);
});

test('Pocket stream switches from the envelope to model coverage once heard audio is covered', async () => {
  const {meta, buffer} = syntheticModel({lookahead: 4}), model = parseFaceModel(meta, buffer);
  // In-process stand-in for the worker client, same session surface.
  const jaliFace = {begin: rate => {
    const stream = new FaceModelStream(model, rate), session = {frames: stream, onUpdate() {},
      push: pcm => { stream.push(pcm); session.onUpdate(); }, finish: () => { stream.finish(); session.onUpdate(); }, close() {}};
    return session;
  }};
  const input = {requestId: 'pocket-jali', entity: 'Judy-1', generation: 3}, pocket = new PocketFacialStream({input, jaliFace});
  const pcm = speechLike(1.6, 24000);
  let offset = 0, index = 0;
  const push = frames => { pocket.push({sampleRate: 24000, channels: 1, offsetFrames: offset, index: ++index,
    frames, pcm: pcm.slice(offset, offset + frames)}); offset += frames; };
  push(1920);
  const early = pocket.snapshot(offset, false, 0);
  assert.equal(early.source, 'audio-envelope'); assert.deepEqual(early.tracks, [...JALI_TIMELINE_TRACKS]);
  while (offset < 24000) push(1920);
  const mid = pocket.snapshot(offset, false, .3);
  assert.equal(mid.source, 'local-jali');
  assert(ownedPocketFace({face: mid, sourceComplete: false, duration: offset / 24000, positionSeconds: .3}, input));
  while (offset < pcm.length) push(Math.min(1920, pcm.length - offset));
  pocket.finish();
  const done = pocket.snapshot(pcm.length, true, 1.0);
  assert.equal(done.complete, true); assert.equal(done.frames.at(-1).slice(1).every(v => v === 0), true);
  assert.throws(() => ownedPocketFace({face: {...mid, source: 'local-phonetic'}, sourceComplete: false,
    duration: mid.duration, positionSeconds: .3}, input), /changed|covered/);
  runLua(`
    local context={requestId='pocket-jali',entity='Judy-1',generation=3}
    assert(face.updateContinuous(context,${luaLiteral({...early, generation: 3})},judy,${early.duration}),face.error)
    assert(face.updateContinuous(context,${luaLiteral({...mid, generation: 3})},judy,${mid.duration}),face.error)
    face.sync(judy,.3,'pocket-jali');assert(#judy.frames==1 and judy.frames[1].jaw_mid_open>=0)
    assert(face.updateContinuous(context,${luaLiteral({...done, generation: 3})},judy,${done.duration}),face.error)
    face.sync(judy,${done.duration},'pocket-jali');assert(not face.active and judy.resets==1)
  `);
  await pocket.close();
});
