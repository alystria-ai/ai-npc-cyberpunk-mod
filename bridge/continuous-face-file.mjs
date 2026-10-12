// runtime/continuous-face.json, segmented layout (speech-state continuousFaceSegments).
//
// A continuous reply's facial timeline grows while the audio arrives, and the bridge rewrites the whole
// document on every revision (up to ~13 a second). The game used to json.decode all of it each time: a
// 9 s reply is ~80 KB, the pure-Lua decoder costs ~0.5 ms per KB, so a decode took 20-50 ms on the game
// thread (perf capture 2026-10-12: 60-110 ms/s while speaking, single calls up to 48 ms).
//
// The document is still ONE valid JSON value (the native IO worker only delivers a .json file that parses),
// but its long lists are written one line each, or, for the three row lists, one SEGMENT_ROWS-row segment
// per line, and a top-level `seg` object names them:
//
//   {"version":1,...,"revision":7,"seg":{"size":16,"order":"tfm","t":1,"f":94,"m":94,"k":1,"a":1,"s":null},"face":{...,"tracks":[
//   ["jaw_mid_open",...]
//   ],...,"frames":[
//   [[t,w,...],...16 rows],
//   ...
//   [[t,w,...],...]
//   ],"modelExpressions":{...,"frames":[
//   ...
//   ]},...}}
//
// Every list line starts with "[" and no other line does. `order` says which list each run of lines is, in
// the order they appear; seg.<kind> is the number of lines (null: the list is absent from this document).
// The game joins the other lines (the skeleton, with the long lists cut out) and decodes just that, then
// decodes a list line only when its text differs from the line it decoded last time. A finished segment is
// byte-identical in every later revision, so a poll decodes the newest segment or two instead of the whole
// timeline. Anything the game cannot read this way falls back to decoding the whole document and
// flattening the lists (mod/continuous-speech.lua, segmentedFace).
export const SEGMENT_ROWS = 16;
// kind: [path, how]. rows: number rows, SEGMENT_ROWS per line. blob: the whole array on one line (names that
// stay the same for the whole reply, so the game decodes them once).
const LISTS = {
  f: [['frames'], 'rows'],
  m: [['modelExpressions', 'frames'], 'rows'],
  k: [['expressionTrack', 'keys'], 'rows'],
  t: [['tracks'], 'blob'],
  a: [['expressionTrack', 'families'], 'blob'],
  s: [['expressionTrack', 'segments'], 'blob'],
};
const MARK = '@@continuous-face-list@@';

// doc: {version, id, requestId, generation, entity, revision, face}. Returns the file's text.
export function encodeSegmentedFace(doc, size = SEGMENT_ROWS) {
  const face = {...doc.face};
  const seg = {size, order: ''};
  const lines = {};
  for (const [kind, [path, how]] of Object.entries(LISTS)) {
    let parent = face;
    for (let step = 0; step < path.length - 1; step++) {
      const next = parent[path[step]];
      if (!next || typeof next !== 'object' || Array.isArray(next)) { parent = null; break; }
      parent = parent[path[step]] = {...next};
    }
    const key = path[path.length - 1];
    if (!parent || !Array.isArray(parent[key])) { seg[kind] = null; continue; }
    const list = parent[key];
    if (how === 'blob') {
      seg[kind] = 1; lines[kind] = [JSON.stringify(list)];
    } else {
      seg[kind] = Math.ceil(list.length / size);
      if (seg[kind] === 0) continue;
      lines[kind] = [];
      for (let at = 0; at < list.length; at += size) lines[kind].push(JSON.stringify(list.slice(at, at + size)));
    }
    parent[key] = `${MARK}${kind}`;
  }
  const {face: _face, ...rest} = doc;
  // The order the lists appear in the text is their key order in the document; the game reads it from seg.order.
  const probe = JSON.stringify({...rest, seg, face});
  seg.order = Object.keys(lines).sort((a, b) => probe.indexOf(`"${MARK}${a}"`) - probe.indexOf(`"${MARK}${b}"`)).join('');
  let text = JSON.stringify({...rest, seg, face});
  for (const [kind, segments] of Object.entries(lines)) {
    text = text.replace(`"${MARK}${kind}"`, () => `[\n${segments.join(',\n')}\n]`);
  }
  return text;
}
