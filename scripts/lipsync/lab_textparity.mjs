// Dev check: bridge/jali-face-text.mjs + FaceModelStream against the Python reference (lab_textpipe.py fixture).
//   node lab_textparity.mjs <model-dir> <fixture.json>
// Streams every case in 80 ms packets and in odd 333-sample packets; reports the largest row difference,
// normalization agreement and whether streaming changed anything. Exit code 1 on failure.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseFaceModel, FaceModelStream} from '../../bridge/jali-face-model.mjs';
import {parseFaceText, normalizeText, buildStates} from '../../bridge/jali-face-text.mjs';

const [dir, fixturePath] = process.argv.slice(2);
const model = parseFaceModel(JSON.parse(readFileSync(join(dir, 'face-model.json'), 'utf8')), readFileSync(join(dir, 'face-model.bin')));
const text = parseFaceText(JSON.parse(readFileSync(join(dir, 'face-text.json'), 'utf8')), readFileSync(join(dir, 'face-text.bin')),
  readFileSync(join(dir, 'face-lexicon.txt.gz')), model);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
let failed = false;
for (const vector of fixture.normalize) {
  const tokens = normalizeText(vector.text), states = buildStates(tokens, text.lexicon);
  const same = JSON.stringify(tokens) === JSON.stringify(vector.tokens) && JSON.stringify([states.phones, states.kinds]) === JSON.stringify(vector.states);
  if (!same) { failed = true; console.log('normalization differs:', vector.text, tokens, vector.tokens); }
}
for (const c of fixture.cases) {
  const audio = Float32Array.from(c.audio), expected = Float32Array.from(c.rows), results = [];
  for (const packet of [1280, 333]) {
    const session = c.text ? text.session({mode: c.mode, text: c.text}) : undefined;
    const stream = new FaceModelStream(model, 16000, {text: session});
    for (let at = 0; at < audio.length; at += packet) stream.push(audio.slice(at, at + packet));
    stream.finish();
    results.push(stream.values.subarray(0, stream.ready * stream.outputs));
  }
  let worst = 0, streamDiff = 0, over = 0;
  if (results[0].length !== expected.length) { failed = true; console.log(c.key, c.mode, 'row count', results[0].length, expected.length); continue; }
  for (let i = 0; i < expected.length; i++) { worst = Math.max(worst, Math.abs(results[0][i] - expected[i])); if (Math.abs(results[0][i] - expected[i]) > 1e-4) over++; streamDiff = Math.max(streamDiff, Math.abs(results[0][i] - results[1][i])); }
  // Float rounding differs (BLAS vs JS loops); the quantile maps have near-vertical steps (many equal predictions,
  // inputs spaced 1e-6) that magnify it to ~1e-3 on a few values. Alignment labels were checked identical.
  if (worst > 5e-3 || over > expected.length * 1e-2 || streamDiff > 0) failed = true;
  console.log(`${c.key} ${c.mode}: rows ${expected.length / c.outputs}, max |JS - Python| ${worst.toExponential(2)} (${over} values > 1e-4), packet-size difference ${streamDiff}`);
}
const started = performance.now(), bench = Float32Array.from(fixture.cases[0].audio);
let seconds = 0;
for (let k = 0; k < 6; k++) {
  for (const mode of [null, 'stream']) {
    const t0 = performance.now();
    const stream = new FaceModelStream(model, 16000, {text: mode ? text.session({mode, text: fixture.cases[0].text}) : undefined});
    for (let at = 0; at < bench.length; at += 1280) stream.push(bench.slice(at, at + 1280));
    stream.finish();
    if (k) (mode ? (bench.text = (bench.text || 0) + performance.now() - t0) : (bench.base = (bench.base || 0) + performance.now() - t0));
  }
  if (k) seconds += bench.length / 16000;
}
console.log(`CPU per audio second: audio model ${(bench.base / 1000 / seconds).toFixed(3)} s, with text ${(bench.text / 1000 / seconds).toFixed(3)} s (+${((bench.text / bench.base - 1) * 100).toFixed(0)} %)`);
process.exit(failed ? 1 : 0);
