// The list of files the pinned Pocket TTS revision ships (path -> SHA-256), which the Pocket worker checks the installed source against.
// It lives in bridge/pocket_voice_runtime.py (SOURCE_FILES, between the BEGIN/END marker lines), so it travels with the worker and needs
// no file of its own in the Runtime. The release builder compares it with the files it is about to ship.
import {createHash} from 'node:crypto';

const BEGIN = '# BEGIN POCKET SOURCE MANIFEST';
const END = '# END POCKET SOURCE MANIFEST';

// Reads SOURCE_FILES out of the Python text: Map of relative path -> hash.
export function parsePocketSourceList(pythonText) {
  const text = pythonText.replace(/\r\n/g, '\n');
  const start = text.indexOf(BEGIN), end = text.indexOf(END);
  if (start < 0 || end < start) throw Error('bridge/pocket_voice_runtime.py has no Pocket source manifest block.');
  const list = new Map();
  for (const line of text.slice(start + BEGIN.length, end).split('\n')) {
    const match = /^\s*("(?:[^"\\]|\\.)*"): "([0-9a-f]{64})",\s*$/.exec(line);
    if (match) list.set(JSON.parse(match[1]), match[2]);
  }
  if (list.size === 0) throw Error('The Pocket source manifest block is empty.');
  return list;
}

// The digest of a list in the form bridge/pocket_voice_runtime.py digest_manifest() uses (path, NUL, raw hash, newline), by path order.
export function pocketSourceListDigest(list) {
  const digest = createHash('sha256');
  for (const rel of [...list.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    digest.update(Buffer.from(`${rel}\0`, 'utf8'));
    digest.update(Buffer.concat([Buffer.from(list.get(rel), 'hex'), Buffer.from('\n')]));
  }
  return digest.digest('hex');
}

// Throws unless the files about to ship ([{rel, sha}]) are exactly the list.
export function checkPocketSourceList(list, files) {
  const shipped = new Map(files.map(({rel, sha}) => [rel, sha]));
  const problems = [];
  for (const [rel, sha] of shipped) if (!list.has(rel)) problems.push(`${rel} is shipped but not listed`);
  for (const [rel, sha] of list) if (!shipped.has(rel)) problems.push(`${rel} is listed but not shipped`); else if (shipped.get(rel) !== sha) problems.push(`${rel} differs from the list`);
  if (problems.length) throw Error(`The Pocket source list in bridge/pocket_voice_runtime.py does not match the files shipped in app/pocket-tts: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; +${problems.length - 5} more` : ''}.`);
}
