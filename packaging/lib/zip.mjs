// Deterministic ZIP writer for release packages.
//
// The same entries in the same order always give byte-identical archives: entries are
// added in the caller's (sorted) order, every entry carries one fixed DOS timestamp and
// no extra fields, and deflate runs with one fixed level (6 by default: close to the size of
// level 9 in a fraction of the time on large CUDA libraries). Data is streamed from disk, so
// multi-gigabyte inputs never sit in memory. Entries can be byte ranges of a file, which
// lets one large file be split across archives without temporary copies.
//
// ZIP64 only where it is needed: an archive whose entries and offsets all fit the classic format
// stays a plain ZIP, byte for byte as before. An entry that may reach 4 GiB (a large model file, which
// the optional packs now ship whole) gets ZIP64 sizes in its headers; an archive that grows past
// 4 GiB or 65,535 entries gets the ZIP64 end records. Windows Explorer, 7-Zip and tar read both.
// A non-ZIP64 entry that still outgrows 4 GiB throws instead of writing a broken archive.
import {open, stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {crc32, createDeflateRaw} from 'node:zlib';
import {createHash} from 'node:crypto';

const LIMIT = 0xFFFFFFFF;
// An entry of at least this size (known before it is written) is a ZIP64 entry: deflate can grow incompressible data a little,
// so the margin below 4 GiB keeps the compressed size inside the classic field for every other entry.
const ZIP64_ENTRY = 0xF0000000;
const NAME = /^[^\\:*?"<>|\x00-\x1f]+$/;

// Formats that are already compressed (or are dense model weights) are stored as-is.
const STORED = /\.(?:safetensors|npz|gz|zip|7z|png|jpe?g|webp|woff2?|pt|pth|ckpt|onnx|whl)$|\.gguf(?:\.part\d+)?$/i;

export function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export class ZipWriter {
  // `zip64Entry` (tests only) lowers the size from which an entry is written as ZIP64, so the ZIP64 paths run on small files.
  static async create(path, {timestamp = new Date(Date.UTC(2026, 0, 1)), level = 6, zip64Entry = ZIP64_ENTRY} = {}) {
    const handle = await open(path, 'w');
    return new ZipWriter(handle, path, dosDateTime(timestamp), level, zip64Entry);
  }

  constructor(handle, path, stamp, level, zip64Entry = ZIP64_ENTRY) {
    Object.assign(this, {handle, path, stamp, level, zip64Entry});
    this.offset = 0; this.entries = []; this.names = new Set();
  }

  get size() { return this.offset; }
  get count() { return this.entries.length; }

  async write(buffer) {
    let written = 0;
    while (written < buffer.length) {
      const {bytesWritten} = await this.handle.write(buffer, written, buffer.length - written, this.offset);
      written += bytesWritten; this.offset += bytesWritten;
    }
  }

  checkName(name) {
    if (typeof name !== 'string' || !name || !NAME.test(name) || name.startsWith('/') || name.endsWith('/')
        || name.split('/').some(part => !part || part === '.' || part === '..')) {
      throw Error(`Invalid archive entry name: ${name}`);
    }
    const key = name.toLowerCase();
    if (this.names.has(key)) throw Error(`Duplicate archive entry: ${name}`);
    this.names.add(key);
  }

  // Adds `name` from `source` (a file path) or from `buffer`. `start`/`length` select a byte range.
  async add(name, {source, buffer, start = 0, length, store} = {}) {
    this.checkName(name);
    const nameBytes = Buffer.from(name, 'utf8');
    const method = (store ?? STORED.test(name)) ? 0 : 8;
    const headerOffset = this.offset;
    const knownSize = buffer !== undefined ? (length ?? buffer.length - start) : length ?? (await stat(source)).size - start;
    const zip64 = knownSize >= this.zip64Entry;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(this.stamp.time, 10);
    header.writeUInt16LE(this.stamp.date, 12);
    header.writeUInt16LE(nameBytes.length, 26);
    // A ZIP64 entry: both sizes read 0xFFFFFFFF and the real ones sit in a 16-byte extra field, filled in below.
    if (zip64) { header.writeUInt32LE(LIMIT, 18); header.writeUInt32LE(LIMIT, 22); header.writeUInt16LE(20, 28); }
    await this.write(Buffer.concat([header, nameBytes, ...(zip64 ? [Buffer.from([0x01, 0x00, 0x10, 0x00]), Buffer.alloc(16)] : [])]));
    let crc = 0, uncompressed = 0;
    const hash = createHash('sha256');
    const dataStart = this.offset;
    const chunks = buffer !== undefined
      ? [buffer.subarray(start, length === undefined ? undefined : start + length)]
      : createReadStream(source, {start, ...(length === undefined ? {} : {end: start + length - 1}),
        highWaterMark: 4 * 1024 * 1024});
    if (method === 0) {
      for await (const chunk of chunks) {
        crc = crc32(chunk, crc); uncompressed += chunk.length; hash.update(chunk);
        await this.write(chunk);
      }
    } else {
      const deflate = createDeflateRaw({level: this.level});
      const pending = [];
      deflate.on('data', chunk => pending.push(chunk));
      const flush = async () => { while (pending.length) await this.write(pending.shift()); };
      for await (const chunk of chunks) {
        crc = crc32(chunk, crc); uncompressed += chunk.length; hash.update(chunk);
        await new Promise((resolve, reject) => deflate.write(chunk, error => error ? reject(error) : resolve()));
        await flush();
      }
      await new Promise((resolve, reject) => { deflate.once('end', resolve); deflate.once('error', reject); deflate.end(); });
      await flush();
    }
    const compressed = this.offset - dataStart;
    if (!zip64 && (uncompressed > LIMIT || compressed > LIMIT)) throw Error(`${name} is larger than 4 GiB and its size was not known up front.`);
    if (length !== undefined && uncompressed !== length) throw Error(`${name}: expected ${length} bytes, read ${uncompressed}.`);
    if (zip64) {
      const sizes = Buffer.alloc(16);
      sizes.writeBigUInt64LE(BigInt(uncompressed), 0); sizes.writeBigUInt64LE(BigInt(compressed), 8);
      await this.handle.write(sizes, 0, 16, headerOffset + 30 + nameBytes.length + 4);
      const crcBytes = Buffer.alloc(4); crcBytes.writeUInt32LE(crc >>> 0, 0);
      await this.handle.write(crcBytes, 0, 4, headerOffset + 14);
    } else {
      const sizes = Buffer.alloc(12);
      sizes.writeUInt32LE(crc >>> 0, 0); sizes.writeUInt32LE(compressed, 4); sizes.writeUInt32LE(uncompressed, 8);
      await this.handle.write(sizes, 0, 12, headerOffset + 14);
    }
    this.entries.push({nameBytes, method, crc: crc >>> 0, compressed, uncompressed, headerOffset, zip64});
    return {name, method, compressed, uncompressed, sha256: hash.digest('hex')};
  }

  async close() {
    const directoryOffset = this.offset;
    for (const entry of this.entries) {
      // The central record carries a ZIP64 extra field for what does not fit its 32-bit fields: the sizes of a ZIP64 entry, and an
      // offset of 4 GiB or more, in that order.
      const bigOffset = entry.headerOffset >= LIMIT;
      const fields = [];
      if (entry.zip64) { const sizes = Buffer.alloc(16); sizes.writeBigUInt64LE(BigInt(entry.uncompressed), 0); sizes.writeBigUInt64LE(BigInt(entry.compressed), 8); fields.push(sizes); }
      if (bigOffset) { const at = Buffer.alloc(8); at.writeBigUInt64LE(BigInt(entry.headerOffset)); fields.push(at); }
      let extraBytes = Buffer.alloc(0);
      if (fields.length) {
        const head = Buffer.from([0x01, 0x00, 0, 0]);
        head.writeUInt16LE(fields.reduce((sum, item) => sum + item.length, 0), 2);
        extraBytes = Buffer.concat([head, ...fields]);
      }
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(fields.length ? 45 : 20, 4); // made by: MS-DOS / FAT attributes, version 2.0 (4.5 with ZIP64)
      record.writeUInt16LE(fields.length ? 45 : 20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(entry.method, 10);
      record.writeUInt16LE(this.stamp.time, 12);
      record.writeUInt16LE(this.stamp.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.zip64 ? LIMIT : entry.compressed, 20);
      record.writeUInt32LE(entry.zip64 ? LIMIT : entry.uncompressed, 24);
      record.writeUInt16LE(entry.nameBytes.length, 28);
      record.writeUInt16LE(extraBytes.length, 30);
      record.writeUInt32LE(0, 38); // external attributes: a normal file
      record.writeUInt32LE(bigOffset ? LIMIT : entry.headerOffset, 42);
      await this.write(Buffer.concat([record, entry.nameBytes, extraBytes]));
    }
    const directorySize = this.offset - directoryOffset, count = this.entries.length;
    const big = count >= 0xFFFF || directoryOffset >= LIMIT || directorySize >= LIMIT;
    if (big) {
      const zip64End = this.offset;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(count), 24); record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(directorySize), 40); record.writeBigUInt64LE(BigInt(directoryOffset), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(zip64End), 8); locator.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([record, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(big ? 0xFFFF : count, 8);
    end.writeUInt16LE(big ? 0xFFFF : count, 10);
    end.writeUInt32LE(big ? LIMIT : directorySize, 12);
    end.writeUInt32LE(big ? LIMIT : directoryOffset, 16);
    await this.write(end);
    await this.handle.close();
    return {path: this.path, bytes: this.offset, entries: count};
  }
}

// A reader over a local file for listZip: {size, label, read(position, length) -> Buffer, close()}. Another reader (the release tools use
// one that asks a web server for byte ranges, so a pack on Hugging Face is listed without downloading it) has the same shape.
export async function fileReader(path) {
  const handle = await open(path, 'r');
  const {size} = await handle.stat();
  return {size, label: path, close: () => handle.close(), async read(position, length) {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, position);
    return buffer;
  }};
}

// Reads an archive's central directory (names, sizes, methods, CRC-32). Used by tests and the install check to inspect exactly what a
// player downloads. `source` is a path or a reader (fileReader); only the end record, the ZIP64 records and the directory are read.
export async function listZip(source) {
  const reader = typeof source === 'string' ? await fileReader(source) : source;
  const path = reader.label ?? 'the archive';
  try {
    const {size} = reader;
    const tailLength = Math.min(size, 22 + 0xFFFF);
    const tail = await reader.read(size - tailLength, tailLength);
    const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (at < 0) throw Error(`${path} is not a ZIP archive.`);
    let count = tail.readUInt16LE(at + 10), length = tail.readUInt32LE(at + 12), offset = tail.readUInt32LE(at + 16);
    if (count === 0xFFFF || length === LIMIT || offset === LIMIT) {
      // ZIP64: the locator sits just before the end record and points at the ZIP64 end record with the real values.
      const locator = at - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw Error(`${path} has a damaged ZIP64 directory.`);
      const record = await reader.read(Number(tail.readBigUInt64LE(locator + 8)), 56);
      if (record.readUInt32LE(0) !== 0x06064b50) throw Error(`${path} has a damaged ZIP64 directory.`);
      count = Number(record.readBigUInt64LE(32)); length = Number(record.readBigUInt64LE(40)); offset = Number(record.readBigUInt64LE(48));
    }
    const directory = await reader.read(offset, length);
    const entries = [];
    for (let position = 0, index = 0; index < count; index++) {
      if (directory.readUInt32LE(position) !== 0x02014b50) throw Error(`${path} has a damaged directory.`);
      const nameLength = directory.readUInt16LE(position + 28), extra = directory.readUInt16LE(position + 30);
      const comment = directory.readUInt16LE(position + 32);
      let compressed = directory.readUInt32LE(position + 20), uncompressed = directory.readUInt32LE(position + 24);
      if (compressed === LIMIT || uncompressed === LIMIT) {
        // The ZIP64 extra field: the fields that read 0xFFFFFFFF, in the order uncompressed, compressed, offset.
        const extraStart = position + 46 + nameLength;
        for (let at = extraStart; at + 4 <= extraStart + extra;) {
          const id = directory.readUInt16LE(at), size = directory.readUInt16LE(at + 2);
          if (id === 1) {
            let field = at + 4;
            if (uncompressed === LIMIT) { uncompressed = Number(directory.readBigUInt64LE(field)); field += 8; }
            if (compressed === LIMIT) compressed = Number(directory.readBigUInt64LE(field));
          }
          at += 4 + size;
        }
      }
      entries.push({name: directory.toString('utf8', position + 46, position + 46 + nameLength),
        method: directory.readUInt16LE(position + 10), crc: directory.readUInt32LE(position + 16), compressed, uncompressed});
      position += 46 + nameLength + extra + comment;
    }
    return entries;
  } finally { if (typeof source === 'string') await reader.close(); }
}
