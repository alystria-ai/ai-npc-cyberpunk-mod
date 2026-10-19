// Reads one entry's bytes out of a zip, given its entry from listZip (packaging/lib/zip.mjs). Used by the Runtime update builder to copy
// the files that changed from the new full Runtime into the update zip, and to read the small JSON files it compares.
import {createReadStream, createWriteStream} from 'node:fs';
import {open} from 'node:fs/promises';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {crc32, createInflateRaw} from 'node:zlib';

// Where the entry's data starts: its local header (30 bytes, then the name and an extra field whose lengths may differ from the directory's).
async function dataStart(zip, entry) {
  const handle = await open(zip, 'r');
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.offset);
    if (header.readUInt32LE(0) !== 0x04034b50) throw Error(`${zip}: no local header for ${entry.name}.`);
    return entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally { await handle.close(); }
}

// The entry's bytes, checked against the size and CRC-32 of its directory record, as a stream of chunks.
async function* entryChunks(zip, entry) {
  if (entry.method !== 0 && entry.method !== 8) throw Error(`${entry.name}: unsupported compression method ${entry.method}.`);
  const start = await dataStart(zip, entry);
  let source = [];
  if (entry.compressed > 0) {
    const raw = createReadStream(zip, {start, end: start + entry.compressed - 1, highWaterMark: 4 * 1024 * 1024});
    source = raw;
    if (entry.method === 8) { const inflate = createInflateRaw(); raw.on('error', error => inflate.destroy(error)); source = raw.pipe(inflate); }
  }
  let crc = 0, bytes = 0;
  for await (const chunk of source) { crc = crc32(chunk, crc); bytes += chunk.length; yield chunk; }
  if (bytes !== entry.uncompressed || (crc >>> 0) !== (entry.crc >>> 0)) throw Error(`${entry.name} in ${zip} failed its size or CRC-32 check.`);
}

// Writes the entry to `destination` (a file) and returns its size.
export async function extractEntry(zip, entry, destination) {
  let bytes = 0;
  await pipeline(entryChunks(zip, entry), new Transform({transform(chunk, _encoding, done) { bytes += chunk.length; done(null, chunk); }}), createWriteStream(destination));
  return bytes;
}

// The entry's bytes in memory (for small files; `limit` guards against a large one).
export async function readEntry(zip, entry, {limit = 16 * 1024 * 1024} = {}) {
  if (entry.uncompressed > limit) throw Error(`${entry.name} is larger than ${limit} bytes.`);
  const chunks = [];
  for await (const chunk of entryChunks(zip, entry)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
