import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeSegmentedFace, SEGMENT_ROWS} from './continuous-face-file.mjs';

// A face like the bridge builds: frames (t + one weight per track), model frames on the same times, expression keys.
function face(count, {complete = false, keys = 3} = {}) {
  return {
    version: 1, continuous: true, complete, requestId: 'r', entity: 'e', generation: 1, duration: (count - 1) / 60,
    source: 'convai-arkit61', tracks: ['jaw_mid_open', 'lips_together_up'],
    frames: Array.from({length: count}, (_, i) => [i / 60, ((i * 7) % 10) / 20, ((i * 3) % 10) / 20]),
    modelExpressions: {version: 1, format: 'jali-upper-v1',
      frames: Array.from({length: count}, (_, i) => [i / 60, ((i * 3) % 10) / 20, 0])},
    expressionTrack: {version: 1, format: 'emotion-mix-v1', families: ['joy', 'trust'],
      keys: Array.from({length: keys}, (_, i) => [i, 0.5, 0]), segments: [{start: 0, text: 'Hi'}]},
    coverage: {version: 1, phoneticIntervals: [[0, 1]]},
  };
}
const doc = (count, revision = 1, options) => ({version: 1, id: 'i', requestId: 'r', generation: 1, entity: 'e', revision, face: face(count, options)});

const KINDS = {f: [['frames'], true], m: [['modelExpressions', 'frames'], true], k: [['expressionTrack', 'keys'], true],
  t: [['tracks'], false], a: [['expressionTrack', 'families'], false], s: [['expressionTrack', 'segments'], false]};
// What the game does with the text (mod/continuous-speech.lua, segmentedFace), in JavaScript.
function readLikeTheGame(text) {
  const skeleton = [], segments = [];
  for (const line of text.split('\n')) (line.startsWith('[') ? segments : skeleton).push(line);
  const value = JSON.parse(skeleton.join(''));
  let used = 0;
  for (const kind of value.seg.order) {
    const [path, rows] = KINDS[kind];
    const parts = [];
    for (let index = 0; index < value.seg[kind]; index++) parts.push(JSON.parse(segments[used++].replace(/,$/, '')));
    let parent = value.face;
    for (const step of path.slice(0, -1)) parent = parent[step];
    parent[path.at(-1)] = rows ? parts.flat() : parts[0];
  }
  assert.equal(used, segments.length);
  const {seg: _seg, ...rest} = value;
  return rest;
}

test('the segmented file is one JSON value whose lists come back exactly', () => {
  for (const count of [0, 1, SEGMENT_ROWS, SEGMENT_ROWS + 1, 40, 163]) {
    const original = doc(count);
    const text = encodeSegmentedFace(original);
    JSON.parse(text); // still a single valid JSON document (the native IO worker needs that)
    assert.deepEqual(readLikeTheGame(text), original, `${count} rows`);
  }
});

test('only list lines start with a bracket, and a finished segment is byte-identical in the next revision', () => {
  const a = encodeSegmentedFace(doc(100, 1)).split('\n');
  const b = encodeSegmentedFace(doc(140, 2)).split('\n');
  const lists = lines => lines.filter(line => line.startsWith('['));
  const first = lists(a), second = lists(b);
  assert.ok(second.length > first.length);
  // order: tracks line, frames (7 segments for 100 rows, 6 full), model frames, ...: the full segments repeat.
  const full = first.filter(line => line.startsWith('[[') && line.split('],[').length === 16);
  assert.ok(full.length >= 12, `${full.length} full segments`);
  for (const line of full) assert.ok(second.includes(line), 'a finished segment changed');
  // The skeleton carries no row data and none of the long names.
  const skeleton = a.filter(line => !line.startsWith('[')).join('');
  assert.ok(skeleton.length < 700, `skeleton is ${skeleton.length} bytes`);
  assert.equal(skeleton.includes('0.0166'), false);
  assert.equal(skeleton.includes('jaw_mid_open'), false);
});

test('seg.order follows the key order of the document, not a fixed order', () => {
  const swapped = doc(40);
  const {frames, modelExpressions, ...others} = swapped.face;
  swapped.face = {...others, modelExpressions, frames};
  const text = encodeSegmentedFace(swapped);
  const order = JSON.parse(text.split('\n').filter(line => !line.startsWith('[')).join('')).seg.order;
  assert.ok(order.indexOf('m') < order.indexOf('f'), order);
  assert.deepEqual(readLikeTheGame(text), swapped);
});

test('an earlier row that changes only changes its own segment', () => {
  const original = doc(80);
  const edited = structuredClone(original);
  edited.face.frames[20][1] = 0.99; // segment 2 of 5
  const a = encodeSegmentedFace(original).split('\n'), b = encodeSegmentedFace(edited).split('\n');
  assert.equal(a.length, b.length);
  const differing = a.map((line, i) => line === b[i] ? null : i).filter(i => i !== null);
  assert.equal(differing.length, 1);
  assert.deepEqual(readLikeTheGame(encodeSegmentedFace(edited)), edited);
});

test('absent and empty lists are marked, not invented', () => {
  const bare = doc(20); delete bare.face.modelExpressions; delete bare.face.expressionTrack;
  const text = encodeSegmentedFace(bare);
  const seg = JSON.parse(text).seg;
  assert.equal(seg.m, null); assert.equal(seg.k, null); assert.equal(seg.a, null); assert.equal(seg.f, 2); assert.equal(seg.t, 1);
  assert.deepEqual(readLikeTheGame(text), bare);
  const empty = doc(0);
  assert.equal(JSON.parse(encodeSegmentedFace(empty)).seg.f, 0);
  assert.deepEqual(readLikeTheGame(encodeSegmentedFace(empty)), empty);
});
