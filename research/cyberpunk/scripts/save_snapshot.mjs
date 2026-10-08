// Offline, read-only reader for a Cyberpunk 2077 sav.dat. It rebuilds the
// world-knowledge snapshot the Lua collector (mod/world-knowledge.lua) would
// capture for a reviewed pack, so rules can be checked against real saves
// without running the game. It never writes a save.
//
// Format notes (verified on 2.01-2.31 saves): trailing int32 offset + "ENOD";
// node table "EDON" + VLQ count + {name, nextId, childId, offset, size};
// "FZLC" chunk table, each chunk "4ZLX" + size + LZ4 block (or stored raw).
// The first FactsTable holds named quest facts as FNV-1a32(name) -> int32.
// JournalManager stores 15-byte entries: uint32 Murmur3_32(path, 0x5EEDBA5E),
// uint32 state (1 inactive, 2 active, 3 succeeded, 4 failed), uint32 game
// seconds of the entry's last state change (GetEntryTimestamp), uint16 change
// sequence within that second, 1 flag byte. TimeSystem holds the current game
// seconds as a uint32 at node offset 12. Both verified on six 2.31 autosaves:
// the clock advances with play and sequential objectives order as played.
// A live 2.31 capture and this reader agreed on all 527 observations.
import {readFileSync, createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash >>> 0;
}

export function murmur3(text, seed = 0x5EEDBA5E) {
  const data = Buffer.from(text, 'utf8');
  let h = seed >>> 0; const c1 = 0xcc9e2d51, c2 = 0x1b873593, n = data.length & ~3;
  for (let i = 0; i < n; i += 4) {
    let k = data.readUInt32LE(i); k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }
  let k = 0; const r = data.length & 3;
  if (r === 3) k ^= data[n + 2] << 16;
  if (r >= 2) k ^= data[n + 1] << 8;
  if (r >= 1) { k ^= data[n]; k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2); h ^= k; }
  h ^= data.length; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

export function lz4Block(src, size) {
  const dst = Buffer.alloc(size);
  let s = 0, d = 0;
  while (s < src.length) {
    const token = src[s++];
    let literal = token >> 4;
    if (literal === 15) { let b; do { b = src[s++]; literal += b; } while (b === 255); }
    src.copy(dst, d, s, s + literal); s += literal; d += literal;
    if (s >= src.length) break;
    const offset = src[s] | (src[s + 1] << 8); s += 2;
    let match = token & 15;
    if (match === 15) { let b; do { b = src[s++]; match += b; } while (b === 255); }
    match += 4;
    if (offset <= 0 || d - offset < 0) throw Error('Invalid LZ4 back-reference');
    for (let i = 0, m = d - offset; i < match; i++) dst[d++] = dst[m + i];
  }
  if (d !== size) throw Error('LZ4 size mismatch');
  return dst;
}

function vlq(buffer, position) {
  let b = buffer[position++];
  const negative = (b & 0x80) !== 0;
  let value = b & 0x3f;
  if (b & 0x40) { let shift = 6; do { b = buffer[position++]; value |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80); }
  return [negative ? -value : value, position];
}

export function readSave(path) {
  const file = readFileSync(path);
  if (file.toString('ascii', 0, 4) !== 'VASC' || file.toString('ascii', file.length - 4) !== 'ENOD') throw Error('Not a Cyberpunk save');
  let p = file.readInt32LE(file.length - 8);
  if (file.toString('ascii', p, p + 4) !== 'EDON') throw Error('Missing node table');
  let count; [count, p] = vlq(file, p + 4);
  const nodes = [];
  for (let i = 0; i < count; i++) {
    let length; [length, p] = vlq(file, p);
    const name = length < 0 ? file.toString('utf8', p, p - length) : file.toString('utf16le', p, p + length * 2);
    p += length < 0 ? -length : length * 2;
    nodes.push({name, nextId: file.readInt32LE(p), childId: file.readInt32LE(p + 4), offset: file.readInt32LE(p + 8), size: file.readInt32LE(p + 12)});
    p += 16;
  }
  const table = file.indexOf('FZLC');
  if (table < 0) throw Error('Missing chunk table');
  const chunks = [];
  for (let i = 0, n = file.readInt32LE(table + 4); i < n; i++) {
    const at = table + 8 + i * 12;
    chunks.push({offset: file.readInt32LE(at), compressed: file.readInt32LE(at + 4), decompressed: file.readInt32LE(at + 8)});
  }
  const data = Buffer.concat(chunks.map(c => file.toString('ascii', c.offset, c.offset + 4) === '4ZLX'
    ? lz4Block(file.subarray(c.offset + 8, c.offset + c.compressed), c.decompressed)
    : file.subarray(c.offset, c.offset + c.compressed)));
  return {nodes, data, dataStart: chunks[0].offset};
}

const STATES = {1: 'inactive', 2: 'active', 3: 'succeeded', 4: 'failed'};

export function saveState(path) {
  const save = readSave(path), at = offset => offset - save.dataStart;
  const factsNode = save.nodes.find(n => n.name === 'FactsTable');
  const journalNode = save.nodes.find(n => n.name === 'JournalManager');
  if (!factsNode || !journalNode) throw Error('Save lacks FactsTable or JournalManager');
  const facts = new Map();
  {
    let [count, p] = vlq(save.data, at(factsNode.offset) + 4);
    const hashes = [];
    for (let i = 0; i < count; i++, p += 4) hashes.push(save.data.readUInt32LE(p));
    for (let i = 0; i < count; i++, p += 4) facts.set(hashes[i], save.data.readInt32LE(p));
  }
  const journal = new Map(), journalTimes = new Map();
  {
    let p = at(journalNode.offset) + 4;
    const count = save.data.readUInt32LE(p); p += 4;
    for (let i = 0; i < count; i++, p += 15) {
      const hash = save.data.readUInt32LE(p);
      journal.set(hash, save.data.readUInt32LE(p + 4));
      journalTimes.set(hash, {seconds: save.data.readUInt32LE(p + 8), sequence: save.data.readUInt16LE(p + 12)});
    }
  }
  const timeNode = save.nodes.find(n => n.name === 'TimeSystem');
  const gameTimeSeconds = timeNode && timeNode.size >= 16 ? save.data.readUInt32LE(at(timeNode.offset) + 12) : undefined;
  let metadata = null;
  try { metadata = JSON.parse(readFileSync(join(dirname(path), 'metadata.9.json'), 'utf8')).Data.metadata; } catch {}
  return {facts, journal, journalTimes, gameTimeSeconds, metadata};
}

const research = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function loadJournalTypes(index = join(research, 'cache/game/index/journal.jsonl')) {
  const types = new Map();
  for await (const line of createInterface({input: createReadStream(index)})) {
    const row = JSON.parse(line);
    if (row.path !== undefined) types.set(row.path, row.type);
  }
  return types;
}

const revealed = value => value === 'active' || value === 'succeeded' || value === 'failed';
const journalValue = (state, path) => STATES[state.journal.get(murmur3(path))];

// Mirrors world-knowledge.lua: own state, then revealed ancestry to the owning
// quest (quest entries) or contact (phone entries).
export function journalObservation(state, selector, types) {
  const path = selector.nativePath, value = journalValue(state, path), parts = path.split('/');
  const seconds = state.journalTimes?.get(murmur3(path))?.seconds;
  const known = () => ({status: 'known', value, revealed: true, questKey: selector.questKey,
    sourceId: 'offline-save-journal', evidenceRefs: ['offline-save:journal'],
    ...(Number.isSafeInteger(seconds) ? {gameTimeSeconds: seconds} : {})});
  if (!revealed(value)) return {status: 'unknown', reason: 'journal-not-revealed'};
  if (selector.nativeClass === 'gameJournalPhoneChoiceEntry' || selector.nativeClass === 'gameJournalPhoneMessage') {
    if (selector.nativeClass === 'gameJournalPhoneChoiceEntry' && value !== 'succeeded') return {status: 'unknown', reason: 'phone-choice-not-sent'};
    if (selector.nativeClass === 'gameJournalPhoneMessage' && value === 'failed') return {status: 'unknown', reason: 'phone-message-not-received'};
    for (let i = parts.length - 1; i >= 1; i--) {
      const ancestorPath = parts.slice(0, i).join('/'), ancestor = journalValue(state, ancestorPath);
      const retired = selector.allowRetiredChoiceGroup === true && ancestor === 'inactive' && types.get(ancestorPath) === 'gameJournalPhoneChoiceGroup';
      if (ancestor !== 'active' && ancestor !== 'succeeded' && !retired) return {status: 'unknown', reason: 'phone-parent-unrevealed'};
      if (types.get(ancestorPath) === 'gameJournalContact') return known();
    }
    return {status: 'unknown', reason: 'phone-parent-missing'};
  }
  if (types.get(path) === 'gameJournalQuest') return known();
  for (let i = parts.length - 1; i >= 1; i--) {
    const ancestor = parts.slice(0, i).join('/');
    if (!revealed(journalValue(state, ancestor))) return {status: 'unknown', reason: 'journal-parent-unrevealed'};
    if (types.get(ancestor) === 'gameJournalQuest') return known();
  }
  return {status: 'unknown', reason: 'journal-parent-missing'};
}

export function snapshotFromSave(state, pack, types, {profileKeys, channel = 'private'} = {}) {
  const facts = {}, journal = {};
  for (const key of Object.keys(pack.factAllowlist)) {
    const value = state.facts.get(fnv1a32(key));
    facts[key] = Number.isInteger(value) && value !== 0
      ? {status: 'known', value, present: true, sourceId: 'offline-save-facts', evidenceRefs: ['offline-save:facts']}
      : {status: 'unknown', reason: 'fact-zero-presence-unknown'};
  }
  for (const [key, selector] of Object.entries(pack.journalAllowlist)) journal[key] = journalObservation(state, selector, types);
  const lifepath = {Nomad: 'nomad', StreetKid: 'streetkid', Corporate: 'corpo'}[state.metadata?.lifePath];
  const active = [...new Set(Object.entries(journal).filter(([key, row]) => row.status === 'known' && row.value === 'active'
    && pack.journalAllowlist[key].nativeClass === 'gameJournalQuest').map(([key]) => pack.journalAllowlist[key].questKey))].sort().slice(0, 32);
  return {version: 1, status: 'ready', gameVersion: pack.gameVersions[0], generation: 1, worldToken: 'offline-save',
    capturedAt: new Date().toISOString(), identity: {status: 'unknown'}, audience: {channel, profileKeys},
    facts, journal, ...(active.length ? {activeQuestKeys: active} : {}),
    ...(Number.isSafeInteger(state.gameTimeSeconds) ? {gameTimeSeconds: state.gameTimeSeconds} : {}),
    lifepath: lifepath ? {status: 'known', value: lifepath, sourceId: 'offline-save-metadata', evidenceRefs: ['offline-save:metadata']} : {status: 'unknown'}};
}
