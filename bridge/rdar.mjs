// A small reader for the game's RDAR archives (the .archive files in archive/pc/mod and archive/pc/content), made for one job: find out, cheaply,
// whether an archive holds certain files (by the hash of their depot path) and read a few of them back. Prototype for docs/V_VOICE_MODS.md's
// question "does a mod replace V's voice-over?" (bridge/v-voice-mods.mjs).
//
// The format (version 12; the same fields scripts/Extract-VoiceReferences.py reads):
//   header (40 bytes)   'RDAR', version u32, index offset u64, index size u32, 4 bytes, debug offset u64, file size u64
//   index (at its offset) u32, u32, u64 (table offset/size/crc), entry count u32, segment count u32, dependency count u32, then
//     entries   56 bytes each: path hash u64 (FNV-1a 64 of the lower-case depot path with backslashes), timestamp i64, inline segments u32,
//               first segment u32, end segment u32, dependencies start u32, dependencies end u32, SHA-1 of the decoded file (20 bytes)
//     segments  16 bytes each: offset u64, stored size u32, decoded size u32 (equal when the data is stored as is; otherwise Oodle Kraken)
//     dependencies  8 bytes each
// No file names are stored: a name is looked up by hashing it. A mod that replaces a voice-over file carries the hash of the game's own depot path.
//
// An archive is untrusted input (a download): every size is checked against the file before anything is allocated, nothing is executed, and only
// the index (a few megabytes at most) is ever read for a scan. Reading a file's bytes reads exactly its segment.
import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export const RDAR = Object.freeze({headerBytes: 40, entryBytes: 56, segmentBytes: 16, version: 12, maxIndexBytes: 96 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024});

/** The SHA-1 of zero bytes: what archives written by WolvenKit's pack command store in every entry. */
export const EMPTY_SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
const FNV_OFFSET = 0xcbf29ce484222325n, FNV_PRIME = 0x100000001b3n, MASK = (1n << 64n) - 1n;

/** The archive's hash of a depot path (backslashes, any case): FNV-1a 64 over the lower-case UTF-8 bytes, as a 16-digit lower-case hex string. */
export function depotHash(path) {
  let hash = FNV_OFFSET;
  for (const byte of Buffer.from(String(path).toLowerCase(), 'utf8')) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK;
  return hash.toString(16).padStart(16, '0');
}

const word = (buffer, at) => buffer.readUInt32LE(at);
/** An entry's hash as 16 hex digits (high word first), without making a BigInt. */
const hexAt = (buffer, at) => word(buffer, at + 4).toString(16).padStart(8, '0') + word(buffer, at).toString(16).padStart(8, '0');

/**
 * Opens an archive and reads its index. Resolves to {size, entries (number), segments (number), scan(wanted), entry(hex), read(hex, options), close()}.
 * Rejects with an Error whose `code` is 'not-rdar', 'bad-index' or 'too-large'.
 */
export async function openArchive(path) {
  const handle = await open(path, 'r');
  try {
    const {size} = await handle.stat();
    const head = Buffer.alloc(RDAR.headerBytes);
    const got = (await handle.read(head, 0, head.length, 0)).bytesRead;
    const fail = (code, text) => Object.assign(Error(text), {code});
    if (got < head.length || head.toString('latin1', 0, 4) !== 'RDAR') throw fail('not-rdar', 'not an RDAR archive');
    const indexAt = Number(head.readBigUInt64LE(8)), indexSize = word(head, 16);
    if (word(head, 4) !== RDAR.version) throw fail('not-rdar', `archive version ${word(head, 4)} is not supported`);
    if (indexSize > RDAR.maxIndexBytes) throw fail('too-large', 'the archive index is larger than a scan reads');
    if (indexSize < 28 || !Number.isSafeInteger(indexAt) || indexAt + indexSize > size) throw fail('bad-index', 'the index lies outside the file');
    const index = Buffer.alloc(indexSize);
    if ((await handle.read(index, 0, indexSize, indexAt)).bytesRead !== indexSize) throw fail('bad-index', 'short read of the index');
    const entries = word(index, 16), segments = word(index, 20), dependencies = word(index, 24);
    if (28 + entries * RDAR.entryBytes + segments * RDAR.segmentBytes + dependencies * 8 > indexSize) throw fail('bad-index', 'the index counts do not fit its size');
    const segmentsAt = 28 + entries * RDAR.entryBytes;

    const archive = {
      size, entries, segments,
      /**
       * Which of `wanted` (an iterable of 16-digit hex hashes) the archive holds: a Map hex -> {first, end, sha1}. One pass over the index with
       * two integer reads per entry (no BigInt), so a large archive is a few milliseconds.
       */
      scan(wanted) {
        const byHigh = new Map();
        for (const hex of wanted) {
          const high = parseInt(hex.slice(0, 8), 16);
          if (!byHigh.has(high)) byHigh.set(high, []);
          byHigh.get(high).push(parseInt(hex.slice(8), 16));
        }
        const found = new Map();
        for (let at = 28, i = 0; i < entries; i++, at += RDAR.entryBytes) {
          const lows = byHigh.get(word(index, at + 4));
          if (lows && lows.includes(word(index, at))) found.set(hexAt(index, at), {first: word(index, at + 20), end: word(index, at + 24), sha1: index.toString('hex', at + 36, at + 56)});
        }
        return found;
      },
      /** The entry of one hash, or null. */
      entry(hex) { return archive.scan([hex]).get(hex) ?? null; },
      /**
       * The decoded bytes of one file, checked against the SHA-1 in the index. Only a file in one segment and stored as is can be read (the
       * voice-over in the archives we have seen is); a compressed one rejects with code 'compressed' (the caller decides: a decoder with
       * Oodle is not part of the prototype).
       */
      async read(hex, {maxBytes = RDAR.maxFileBytes} = {}) {
        const found = archive.entry(hex);
        if (!found) throw fail('missing', 'the archive does not hold that file');
        if (found.end !== found.first + 1 || found.end > segments) throw fail('unsupported', 'the file is in more than one segment');
        const at = segmentsAt + found.first * RDAR.segmentBytes;
        const offset = Number(index.readBigUInt64LE(at)), stored = word(index, at + 8), decoded = word(index, at + 12);
        if (stored !== decoded) throw fail('compressed', 'the file is compressed');
        if (stored === 0 || stored > maxBytes || offset + stored > size) throw fail('bad-index', 'the file lies outside the archive or is too large');
        const bytes = Buffer.alloc(stored);
        if ((await handle.read(bytes, 0, stored, offset)).bytesRead !== stored) throw fail('bad-index', 'short read of a file');
        // WolvenKit-packed mod archives store the SHA-1 of nothing (da39a3ee...) instead of the file's: only a real digest can be checked.
        if (found.sha1 !== EMPTY_SHA1 && createHash('sha1').update(bytes).digest('hex') !== found.sha1) throw fail('bad-hash', 'the file does not match its SHA-1');
        return bytes;
      },
      close: () => handle.close(),
    };
    return archive;
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}
