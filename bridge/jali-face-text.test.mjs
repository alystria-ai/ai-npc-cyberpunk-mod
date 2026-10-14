import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {parseFaceModel, FaceModelStream} from './jali-face-model.mjs';
import {parseFaceText, normalizeText, buildStates, parseLexicon, TextAligner, PHONES, FACE_TEXT_FORMAT, GARBAGE} from './jali-face-text.mjs';
import {JaliFace} from './jali-face.mjs';
import {syntheticModel, speechLike} from './jali-face-fixture.mjs';

// Test-only lexicon and synthetic text model (production layout; real weights are game-derived and never in tests).
const LEXICON = `hello HH AH L OW\nworld W ER L D\nchoom CH UW M\nyeah Y AE\nno N OW\nway W EY\ntwenty T W EH N T IY\nseventy S EH V AH N T IY\nseven S EH V AH N\nfive F AY V\npoint P OY N T\npercent P ER S EH N T\ndollars D AA L ER Z\nof AH V\nthree TH R IY\nhundred HH AH N D R AH D\nit's IH T S\nb B IY\n`;
function syntheticText(model, {seed = 3, threshold = 99, sha = ''} = {}) {
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648) - .5;
  const C1 = model.channels, P = PHONES.length, O = model.outputs, tensors = [], parts = [];
  let offset = 0;
  const add = (name, shape, fill) => {
    const count = shape.reduce((a, b) => a * b, 1), data = new Float32Array(count);
    for (let i = 0; i < count; i++) data[i] = fill(i);
    tensors.push({name, offset, shape}); parts.push(Buffer.from(data.buffer)); offset += count * 4;
  };
  add('head.w', [P, C1, 1], () => random() * 2); add('head.b', [P], () => random());
  add('log_prior', [P], () => Math.log(1 / P));
  const nets = {};
  for (const [mode, prefix, shift] of [['stream', 's2s.', 3], ['phrase', 's2p.', -3]]) {
    const C = 5, dil = [1, 2];
    add(prefix + 'inp.w', [C, C1 + P, 3], () => random() * .4); add(prefix + 'inp.b', [C], () => random() * .1);
    dil.forEach((_, b) => {
      add(`${prefix}b${b}.c1.w`, [C, C, 3], () => random() * .5); add(`${prefix}b${b}.c1.b`, [C], () => random() * .1);
      add(`${prefix}b${b}.c2.w`, [C, C, 1], () => random() * .5); add(`${prefix}b${b}.c2.b`, [C], () => random() * .1);
    });
    add(prefix + 'out.w', [O, C, 1], () => random()); add(prefix + 'out.b', [O], () => .1 + random() * .1);
    add(prefix + 'qmap_in', [O, 2], i => i % 2 ? 10 : 0); add(prefix + 'qmap_out', [O, 2], i => i % 2 ? 10 : 0);
    nets[mode] = {prefix, channels: C, dilations: dil, shift, lag: Math.max(0, shift), decide: shift > 0 ? 'lag' : 'full'};
  }
  const meta = {format: FACE_TEXT_FORMAT, version: 1, stage1Sha256: sha, phones: PHONES, lexicon: 'face-lexicon.txt.gz',
    lookahead: model.lookahead, nets, tensors, stay: .8, priorWeight: .5, garbagePenalty: 2, tailPenalty: 4, confidenceWindow: 100,
    confidenceMinRows: 20, confidenceThreshold: threshold, blendRows: 6, mouthOutputs: 15, maxStates: 4000};
  return {meta, buffer: Buffer.concat(parts), lexicon: gzipSync(LEXICON)};
}
function setup(options = {}) {
  const {meta, buffer} = syntheticModel(), model = parseFaceModel(meta, buffer);
  const t = syntheticText(model, options);
  return {model, text: parseFaceText(t.meta, t.buffer, t.lexicon, model), files: {meta, buffer}};
}
function run(model, audio, packet, session) {
  const stream = new FaceModelStream(model, 16000, {text: session});
  for (let at = 0; at < audio.length; at += packet) stream.push(audio.slice(at, at + packet));
  stream.finish();
  return {stream, rows: Array.from(stream.values.subarray(0, stream.ready * stream.outputs))};
}

test('reply text is normalized like the Python reference: tags, emotions, numbers, money, growing text', () => {
  assert.deepEqual(normalizeText('Hey, choom - got 2,077 eddies? [laughter] {joy} Yeah.'),
    ['hey', 'choom', 'got', 'two', 'thousand', 'seventy', 'seven', 'eddies', GARBAGE, 'yeah']);
  assert.deepEqual(normalizeText("It's 5.5% of $300 in 2077."), ["it's", 'five', 'point', 'five', 'percent', 'of', 'three', 'hundred',
    'dollars', 'in', 'twenty', 'seventy', 'seven']);
  assert.deepEqual(normalizeText('1905 and 2000'), ['nineteen', 'oh', 'five', 'and', 'two', 'thousand']);
  assert.deepEqual(normalizeText('{anger:strong}No [sigh] [sigh] way [B EY1 S]'), ['no', GARBAGE, 'way', GARBAGE]);
  assert.deepEqual(normalizeText('Señor, 東京 ok'), ['señor', GARBAGE, 'ok']);
  assert.deepEqual(normalizeText('hello wor', {complete: false}), ['hello']);
  assert.deepEqual(normalizeText('hello world.', {complete: false}), ['hello', 'world']);
  assert.deepEqual(normalizeText(''), []);
});

test('states put optional silence between words and garbage for tags and unknown words', () => {
  const lexicon = parseLexicon(gzipSync(LEXICON)), ph = name => PHONES.indexOf(name);
  const {phones, kinds} = buildStates(['hello', GARBAGE, 'zzyzx', 'no'], lexicon);
  assert.deepEqual(kinds, [1, 0, 0, 0, 0, 2, 0, 0, 1]);
  assert.deepEqual(phones, [0, ph('HH'), ph('AH'), ph('L'), ph('OW'), 0, ph('N'), ph('OW'), 0]);
  // Growing text never rewrites earlier states.
  assert.deepEqual(buildStates(['hello', GARBAGE], lexicon, {incremental: true}).kinds, [1, 0, 0, 0, 0, 1, 2]);
});

test('Viterbi follows the phones the scores favour; fixed-lag decisions equal the final path on clear input', () => {
  const lexicon = parseLexicon(gzipSync(LEXICON)), states = buildStates(['no', 'way'], lexicon);
  const plan = [0, 0, 'N', 'N', 'N', 'OW', 'OW', 'OW', 'OW', 0, 0, 'W', 'W', 'EY', 'EY', 'EY', 0, 0, 0];
  const rows = plan.map(p => Float32Array.from(PHONES, (_, i) => i === (p === 0 ? 0 : PHONES.indexOf(p)) ? -0.1 : -6));
  const config = {stay: .8, garbagePenalty: 2, tailPenalty: 4, confidenceWindow: 100, confidenceMinRows: 5, confidenceThreshold: 99};
  const lagged = new TextAligner(states, config, {lag: 3, keep: 4}), whole = new TextAligner(states, config);
  for (const row of rows) { lagged.push(row); whole.push(row); }
  lagged.finish(); whole.finish();
  const expected = plan.map(p => p === 0 ? 0 : PHONES.indexOf(p));
  assert.deepEqual(whole.labels, expected);
  assert.deepEqual(lagged.labels, expected);
  assert(whole.codes.every(code => code === 1) && !whole.lost);
  assert.equal(lagged.back.length, 4, 'streaming keeps only the traceback window');
});

test('text-conditioned stream is packet-invariant and only changes mouth outputs; no text or no known word = audio model', () => {
  const {model, text} = setup(), audio = speechLike(1.2, 16000);
  const plain = run(model, audio, 1280).rows;
  const streamed = [audio.length, 1280, 333].map(packet => run(model, audio, packet, text.session({text: 'hello world, no way'})).rows);
  assert.deepEqual(streamed[1], streamed[0]); assert.deepEqual(streamed[2], streamed[0]);
  assert.equal(streamed[0].length, plain.length);
  let changed = 0;
  for (let i = 0; i < plain.length; i++) {
    if (i % model.outputs >= 15) assert.equal(streamed[0][i], plain[i], 'brows stay on the audio model');
    else if (streamed[0][i] !== plain[i]) changed++;
  }
  assert(changed > 100, 'the text path changed the mouth');
  for (const empty of ['', '{joy} [laughter]', 'zzyzx qwfp']) assert.deepEqual(run(model, audio, 1280, text.session({text: empty})).rows, plain, empty);
});

test('phrase mode releases every row at finish and is packet-invariant', () => {
  const {model, text} = setup(), audio = speechLike(.9, 16000);
  const session = text.session({mode: 'phrase', text: 'yeah no way'}), stream = new FaceModelStream(model, 16000, {text: session});
  assert.equal(stream.push(audio.slice(0, 8000)).length, 0);
  stream.push(audio.slice(8000)); stream.finish();
  const whole = run(model, audio, audio.length, text.session({mode: 'phrase', text: 'yeah no way'})).rows;
  assert.deepEqual(Array.from(stream.values.subarray(0, stream.ready * stream.outputs)), whole);
  assert.equal(stream.ready, run(model, audio, 1280).stream.ready);
});

test('lost confidence, a late worker and a failing text path all return the mouth to the audio model', () => {
  const audio = speechLike(1.5, 16000);
  {
    const {model, text} = setup({threshold: -1}), plain = run(model, audio, 1280).rows;
    const {stream, rows} = run(model, audio, 1280, text.session({text: 'hello world no way'}));
    assert.equal(stream.text.info().reason, 'confidence');
    const tail = plain.length - 30 * model.outputs; // after the 6-row ramp the rows are the audio model's
    assert.deepEqual(rows.slice(tail), plain.slice(tail));
  }
  {
    const {model, text} = setup(), plain = run(model, audio, 1280).rows;
    const stream = new FaceModelStream(model, 16000, {text: text.session({text: 'hello world'})});
    stream.push(audio.slice(0, 1280), {sentAt: performance.timeOrigin + performance.now() - 1000});
    for (let at = 1280; at < audio.length; at += 1280) stream.push(audio.slice(at, at + 1280));
    stream.finish();
    assert.equal(stream.text.info().reason, 'behind');
    assert.deepEqual(Array.from(stream.values.subarray(0, stream.ready * stream.outputs)), plain);
  }
  {
    // Phrase mode pushes a finished phrase at once, so a slice always waits behind the earlier ones: that is queue time,
    // not a worker that fell behind real time, and it must not drop the text path (it did, on every phrase over ~1.5 s).
    const {model, text} = setup(), long = speechLike(4, 16000);
    const stream = new FaceModelStream(model, 16000, {text: text.session({mode: 'phrase', text: 'hello world no way'})});
    const sentAt = performance.timeOrigin + performance.now() - 5000;
    for (let at = 0; at < long.length; at += 16000) stream.push(long.slice(at, at + 16000), {sentAt});
    stream.finish();
    assert.equal(stream.text.lost, false); assert.equal(stream.text.info().lost, false);
    assert.equal(stream.textFailed, undefined);
    // The same lag on a real stream still falls back to the audio model.
    const live = new FaceModelStream(model, 16000, {text: text.session({mode: 'stream', text: 'hello world no way'})});
    live.push(long.slice(0, 1280), {sentAt});
    assert.equal(live.text.info().reason, 'behind');
  }
  {
    const {model, text} = setup(), plain = run(model, audio, 1280).rows;
    for (const mode of ['stream', 'phrase']) {
      const session = text.session({mode, text: 'hello world'});
      let calls = 0; const original = session.process.bind(session);
      session.process = (...args) => { if (++calls === 3) throw Error('boom'); return original(...args); };
      const {stream, rows} = run(model, audio, 1280, session);
      assert.equal(stream.textFailed, 'error');
      assert.equal(rows.length, plain.length, mode);
      if (mode === 'phrase') assert.deepEqual(rows, plain);
    }
  }
});

test('growing Convai text aligns as it arrives; a revised text gives the alignment up', () => {
  const {model, text} = setup(), audio = speechLike(1.5, 16000);
  const session = text.session({text: '', complete: false}), stream = new FaceModelStream(model, 16000, {text: session});
  stream.push(audio.slice(0, 4000));
  assert(!session.active);
  stream.setText('hello wor', false); assert(session.active); assert.deepEqual(session.tokens, ['hello']);
  stream.push(audio.slice(4000, 12000));
  stream.setText('hello world, no', false); assert.deepEqual(session.tokens, ['hello', 'world']);
  stream.setText('hello world, no way.', true); assert.deepEqual(session.tokens, ['hello', 'world', 'no', 'way']);
  stream.push(audio.slice(12000)); stream.finish();
  assert(!session.lost && session.warmUntil > 0);
  const revised = text.session({text: 'hello world ', complete: false});
  revised.setText('yeah world ', false);
  assert.equal(revised.reason, 'text-revised');
});

test('bridge client loads the text model only beside its own audio model and honours FACE_TEXT=off', async () => {
  const {model, files} = setup(), folder = mkdtempSync(join(tmpdir(), 'jali-text-'));
  const write = sha => {
    writeFileSync(join(folder, 'face-model.json'), JSON.stringify(files.meta)); writeFileSync(join(folder, 'face-model.bin'), files.buffer);
    const t = syntheticText(model, {sha});
    writeFileSync(join(folder, 'face-text.json'), JSON.stringify(t.meta)); writeFileSync(join(folder, 'face-text.bin'), t.buffer);
    writeFileSync(join(folder, 'face-lexicon.txt.gz'), t.lexicon);
  };
  try {
    write(createHash('sha256').update(files.buffer).digest('hex'));
    let face = await JaliFace.load(folder);
    try {
      assert(face.textReady);
      const audio = speechLike(.8, 24000), plain = await face.analyse(audio, 24000), aligned = await face.analyse(audio, 24000, {text: 'hello world'});
      assert.equal(aligned.ready, plain.ready);
      assert(aligned.text?.active && aligned.text.mode === 'phrase');
      assert.notDeepEqual(Array.from(aligned.values.subarray(0, aligned.ready * aligned.outputs)), Array.from(plain.values.subarray(0, plain.ready * plain.outputs)));
      const session = face.begin(24000, {text: '', textComplete: false});
      session.push(audio.subarray(0, 4800)); session.setText('hello world', true); session.push(audio.subarray(4800)); session.finish();
      const frames = await session.done;
      assert(frames.text?.active);
    } finally { await face.close(); }
    write('0'.repeat(64));
    face = await JaliFace.load(folder);
    try { assert.equal(face.info.text, 'mismatched-model'); assert(!face.textReady); } finally { await face.close(); }
    write(createHash('sha256').update(files.buffer).digest('hex'));
    process.env.CYBERPUNK_CONVAI_FACE_TEXT = 'off';
    face = await JaliFace.load(folder);
    try { assert.equal(face.info.text, 'absent'); } finally { await face.close(); delete process.env.CYBERPUNK_CONVAI_FACE_TEXT; }
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

test('text visemes (bridge/face-visemes.mjs): off by default, same row count, only adds, a failing pass hands its rows back', () => {
  const audio = speechLike(2.5, 16000), {model, text} = setup();
  const off = run(model, audio, 1280, text.session({text: 'no way choom hello world'}));
  assert.equal(off.stream.text.info().visemes, undefined);
  for (const mode of ['stream', 'phrase']) {
    const base = run(model, audio, 1280, text.session({mode, text: 'no way choom hello world'}));
    const on = run(model, audio, 1280, text.session({mode, text: 'no way choom hello world', visemes: true}));
    assert.equal(on.rows.length, base.rows.length, mode);
    assert.equal(on.stream.ready, base.stream.ready, mode);
    assert.equal(typeof on.stream.text.info().visemes.rowsChanged, 'number');
    const O = model.outputs;
    for (let i = 0; i < on.rows.length; i++) {
      const column = i % O;
      if (![1, 2, 3, 4, 10].includes(column)) assert.equal(on.rows[i], base.rows[i], `${mode} column ${column}`);
      else assert.ok(on.rows[i] >= base.rows[i] - 1e-6, `${mode} never lowers column ${column}`);
    }
  }
  // A pass that throws releases what it held, unchanged, and the stream keeps its clock.
  const session = text.session({text: 'no way choom hello world', visemes: true});
  const original = session.overlay.run.bind(session.overlay); let calls = 0;
  session.overlay.run = (...args) => { if (++calls === 4) throw Error('boom'); return original(...args); };
  const failed = run(model, audio, 1280, session), reference = run(model, audio, 1280, text.session({text: 'no way choom hello world'}));
  assert.equal(failed.rows.length, reference.rows.length);
  assert.equal(failed.stream.text.info().visemes, 'failed');
});

