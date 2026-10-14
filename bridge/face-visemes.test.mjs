import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VisemeOverlay, VISEME_CONFIG, OUT, CAPS, RECIPES, warmVisemes} from './face-visemes.mjs';
import {PHONES} from './jali-face-text.mjs';
import {JALI_LIMITS, JALI_TRACKS} from './jali-face.mjs';

const O = 23, id = name => PHONES.indexOf(name);

// A fake aligner that decides `lag` rows behind the audio, like the stream mode of TextSession.
function fakeAligner(plan, {margin = .1, lag = 3} = {}) {
  const all = plan.flatMap(([name, rows]) => Array(rows).fill(id(name)));
  const aligner = {labels: [], codes: [], margins: [], lost: false, delta: {}, decided: 0,
    decideTo(rows) { while (aligner.labels.length < Math.min(all.length, rows)) { const j = aligner.labels.length; aligner.labels.push(all[j]); aligner.codes.push(1); aligner.margins.push(margin); } },
    finish() { aligner.decideTo(all.length); }};
  return {aligner, length: all.length};
}
function modelRows(count, {jaw = .25, up = 0, dn = 0, closure = []} = {}) {
  const rows = new Float32Array(count * O);
  for (let r = 0; r < count; r++) { rows[r * O + OUT.jaw] = jaw; rows[r * O + OUT.up] = up; rows[r * O + OUT.dn] = dn; }
  for (const [at, height, columns = [OUT.up, OUT.dn]] of closure) for (const c of columns) rows[at * O + c] = height;
  return rows;
}
// Feed `rows` in packets; the aligner has decided (rows seen - lag) rows when a packet arrives.
function feed(overlay, aligner, rows, packet = 7, lag = 3) {
  const parts = [];
  for (let at = 0; at < rows.length / O; at += packet) {
    const seen = Math.min(rows.length / O, at + packet);
    aligner.decideTo(seen - lag);
    parts.push(overlay.run(rows.slice(at * O, seen * O), aligner));
  }
  parts.push(overlay.run(new Float32Array(0), aligner, {final: true}));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const col = (rows, c) => Array.from({length: rows.length / O}, (_, r) => rows[r * O + c]);
const max = values => Math.max(...values);

test('caps equal the playback limits of the controls they cap', () => {
  const limit = name => JALI_LIMITS[name] ?? .5;
  assert.equal(CAPS.jaw, limit('jaw_mid_open')); assert.equal(CAPS.up, limit('lips_together_up')); assert.equal(CAPS.dn, limit('lips_together_dn'));
  assert.equal(CAPS.purse, limit('lips_l_purse')); assert.equal(CAPS.funnel, limit('lips_l_funnel')); assert.equal(CAPS.suckDn, limit('lips_suck_dn'));
  const at = name => JALI_TRACKS.indexOf(name);
  assert.equal(at('lips_l_funnel'), 5); assert.equal(at('lips_l_purse'), 3); // native track order vs the model's output order, left side
  for (const name of Object.keys(RECIPES)) assert.ok(PHONES.includes(name), name);
});

test('a rounded vowel gets funnel and purse on top of the model, at its own place and never past the cap', () => {
  const plan = [['SIL', 20], ['UW', 12], ['SIL', 20], ['AA', 12], ['SIL', 20]];
  const {aligner, length} = fakeAligner(plan), overlay = new VisemeOverlay({phones: PHONES, outputs: O});
  const rows = modelRows(length), out = feed(overlay, aligner, rows);
  assert.equal(out.length, rows.length);
  const funnel = col(out, OUT.funnel), purse = col(out, OUT.purse);
  assert.ok(funnel[26] > .25 && funnel[26] <= CAPS.funnel, `funnel at the vowel ${funnel[26]}`);
  assert.ok(purse[26] > .25 && purse[26] <= CAPS.purse);
  assert.equal(funnel[3], 0); assert.equal(funnel[70], 0); assert.equal(purse[70], 0); // silence and an unrounded vowel
  assert.ok(funnel[17] > 0 && funnel[17] < funnel[26], 'a ramp leads into the vowel'); // before it starts (row 20)
  // Only the shape controls moved.
  for (let r = 0; r < length; r++) for (const c of [OUT.jaw, OUT.up, OUT.dn, 5, 6, 7, 8, 9, 11, 12, 13, 14]) assert.equal(out[r * O + c], rows[r * O + c]);
  assert.ok(overlay.stats().rowsChanged > 0);
});

test('it never lowers the model: a model above the shape is kept, a model above the cap too', () => {
  const plan = [['SIL', 10], ['W', 14], ['SIL', 10]], {aligner, length} = fakeAligner(plan);
  const rows = modelRows(length);
  for (let r = 0; r < length; r++) { rows[r * O + OUT.funnel] = .45; rows[r * O + OUT.purse] = .55; rows[r * O + OUT.up] = 1.04; }
  const out = feed(new VisemeOverlay({phones: PHONES, outputs: O}), aligner, rows);
  for (let i = 0; i < out.length; i++) assert.ok(out[i] >= rows[i], `entry ${i}`);
  assert.equal(max(col(out, OUT.purse)), Math.fround(.55)); assert.equal(max(col(out, OUT.up)), Math.fround(1.04));
});

test('nothing is added to a mouth the model keeps shut, or where the alignment is not trusted', () => {
  const plan = [['SIL', 10], ['UW', 14], ['SIL', 10]];
  { const {aligner, length} = fakeAligner(plan), out = feed(new VisemeOverlay({phones: PHONES, outputs: O}), aligner, modelRows(length, {jaw: 0}));
    assert.equal(max(col(out, OUT.funnel)), 0); assert.equal(max(col(out, OUT.purse)), 0); }
  { const {aligner, length} = fakeAligner(plan, {margin: 2.5}), out = feed(new VisemeOverlay({phones: PHONES, outputs: O}), aligner, modelRows(length));
    assert.equal(max(col(out, OUT.funnel)), 0); }
  { const {aligner, length} = fakeAligner(plan, {margin: 1.3}), out = feed(new VisemeOverlay({phones: PHONES, outputs: O}), aligner, modelRows(length));
    const full = feed(new VisemeOverlay({phones: PHONES, outputs: O}), fakeAligner(plan).aligner, modelRows(length));
    assert.ok(max(col(out, OUT.funnel)) > 0 && max(col(out, OUT.funnel)) < max(col(full, OUT.funnel)), 'partial trust, partial height'); }
  { // A run of one row is not a phone.
    const {aligner, length} = fakeAligner([['SIL', 10], ['UW', 1], ['SIL', 10]]), out = feed(new VisemeOverlay({phones: PHONES, outputs: O}), aligner, modelRows(length));
    assert.equal(max(col(out, OUT.funnel)), 0); }
});

test('M B P and F V lift the model\'s own contact where it has one, and add none where it has none', () => {
  const plan = [['SIL', 10], ['B', 8], ['SIL', 10], ['F', 8], ['SIL', 10], ['P', 8], ['SIL', 10]];
  const {aligner, length} = fakeAligner(plan);
  // B: a half closure at the model's own time; F: lower-lip contact only; P: the model shows nothing.
  const rows = modelRows(length, {closure: [[14, .45], [15, .5], [16, .45], [32, .5, [OUT.dn]], [33, .55, [OUT.dn]]]});
  const out = feed(new VisemeOverlay({phones: PHONES, outputs: O}), aligner, rows);
  assert.ok(Math.max(col(out, OUT.up)[15], 0) >= .95, 'closure lifted to full'); assert.ok(col(out, OUT.dn)[15] >= .95);
  assert.equal(col(out, OUT.up)[14] > .45, true); // the shoulders rise with it
  assert.ok(col(out, OUT.dn)[33] >= .95, 'lower lip lifted'); assert.equal(col(out, OUT.up)[33], 0, 'the upper lip is left alone');
  assert.ok(col(out, OUT.suckDn)[33] > .2, 'with the lip roll');
  assert.equal(max(col(out.slice(50 * O), OUT.up)), 0); // the P the model did not close: nothing invented
  assert.equal(col(out, OUT.up)[11], 0); // timing is the model's: no closure appears before it
});

test('stream packets give the same rows as one pass; rows leave a few rows behind the decisions and all leave at the end', () => {
  const plan = [['SIL', 8], ['HH', 5], ['UW', 11], ['M', 6], ['AA', 9], ['V', 7], ['OW', 12], ['SIL', 9]];
  const rows = modelRows(plan.reduce((n, [, k]) => n + k, 0), {closure: [[26, .6], [27, .6]]});
  const whole = feed(new VisemeOverlay({phones: PHONES, outputs: O}), fakeAligner(plan).aligner, rows, 1000, 0);
  for (const packet of [1, 4, 7, 16]) {
    const overlay = new VisemeOverlay({phones: PHONES, outputs: O}), {aligner} = fakeAligner(plan);
    let released = 0;
    const out = [];
    for (let at = 0; at < rows.length / O; at += packet) {
      const seen = Math.min(rows.length / O, at + packet); aligner.decideTo(seen - 3);
      const part = overlay.run(rows.slice(at * O, seen * O), aligner); released += part.length / O; out.push(part);
      assert.ok(released <= Math.max(0, seen - 3 - VISEME_CONFIG.look), `held back ${seen - released} rows`);
    }
    out.push(overlay.run(new Float32Array(0), aligner, {final: true}));
    const joined = new Float32Array(out.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of out) { joined.set(p, at); at += p.length; }
    assert.equal(joined.length, rows.length, `packet ${packet}`);
    // Shapes agree with the whole pass wherever its runs were already known; the final rows may differ in the last ramp only.
    let worst = 0; for (let i = 0; i < joined.length - 6 * O; i++) worst = Math.max(worst, Math.abs(joined[i] - whole[i]));
    // The open run's trust and contact peak are provisional until it closes, so the last rows of a run can differ a little.
    assert.ok(worst < .1, `packet ${packet}: ${worst}`);
  }
});

test('a lost alignment, no aligner or a failure releases the rows at once and unchanged', () => {
  const plan = [['SIL', 10], ['UW', 14], ['SIL', 10]], {aligner, length} = fakeAligner(plan), rows = modelRows(length);
  const overlay = new VisemeOverlay({phones: PHONES, outputs: O});
  aligner.decideTo(20);
  assert.equal(overlay.run(rows.slice(0, 20 * O), aligner).length / O, 20 - VISEME_CONFIG.look, 'held back by the look-ahead while the alignment is live');
  aligner.lost = true;
  assert.equal(overlay.run(rows.slice(20 * O), aligner).length / O, length - (20 - VISEME_CONFIG.look), 'everything held comes out when the alignment is given up');
  assert.deepEqual(Array.from(new VisemeOverlay({phones: PHONES, outputs: O}).run(rows, null)), Array.from(rows), 'no aligner: the model as it is');
  const failing = new VisemeOverlay({phones: PHONES, outputs: O}), live = fakeAligner(plan).aligner; live.decideTo(8);
  const first = failing.run(rows.slice(0, 12 * O), live).length / O;
  assert.equal(first, 8 - VISEME_CONFIG.look);
  assert.deepEqual(Array.from(failing.release()), Array.from(rows.slice(first * O, 12 * O)), 'release returns the held rows, unchanged');
});

test('cost: a long reply adds well under 5 ms once warm, and warming itself is cheap', () => {
  const started = performance.now(); warmVisemes(PHONES, O); assert.ok(performance.now() - started < 50);
  const words = ['UW', 'M', 'AA', 'B', 'F', 'OW', 'S', 'T', 'W', 'P', 'IY', 'V'], plan = [];
  for (let i = 0; i < 60; i++) plan.push([words[i % words.length], 8], ['SIL', 2]);
  // Best of three: a busy test machine (the files run in parallel) must not fail a timing bound.
  const costs = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const {aligner, length} = fakeAligner(plan), rows = modelRows(length, {closure: [[40, .5]]}), overlay = new VisemeOverlay({phones: PHONES, outputs: O});
    feed(overlay, aligner, rows, 10); // length = 600 rows = 6 s of speech
    costs.push(overlay.stats().ms);
  }
  assert.ok(Math.min(...costs) < 5, `${costs} ms`);
});
