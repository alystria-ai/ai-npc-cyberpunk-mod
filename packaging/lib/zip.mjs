// Deterministic ZIP writer for release packages.
//
// The same entries in the same order always give byte-identical archives: entries are
// added in the caller's (sorted) order, every entry carries one fixed DOS timestamp and
// no extra fields, and deflate runs with one fixed level (6 by default: close to the size of
// level 9 in a fraction of the time on large CUDA libraries). Data is streamed from disk, so
// multi-gigabyte inputs never sit in memory. Entries can be byte ranges of a file, which
// lets one large file be split across archives without temporary copies.
//
// Plain ZIP only (no ZIP64): every entry and every archive stays below 4 GiB and 65,535
// entries, which the release builder already guarantees by keeping archives under the
// 2 GiB GitHub asset limit. Exceeding a limit throws instead of writing a broken archive.
import {open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {crc32, createDeflateRaw} from 'node:zlib';
import {createHash} from 'node:crypto';

const LIMIT = 0xFFFFFFFF;
const MAX_ENTRIES = 0xFFFF;
const NAME = /^[^\\:*?"<>|\x00-\x1f]+$/;

// Formats that are already compressed (or are dense model weights) are stored as-is.
const STORED = /\.(?:safetensors|npz|gz|zip|7z|png|jpe?g|webp|woff2?|pt|pth|ckpt|onnx|whl)$/i;

export function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export class ZipWriter {
  static async create(path, {timestamp = new Date(Date.UTC(2026, 0, 1)), level = 6} = {}) {
    const handle = await open(path, 'w');
    return new ZipWriter(handle, path, dosDateTime(timestamp), level);
  }

  constructor(handle, path, stamp, level) {
    Object.assign(this, {handle, path, stamp, level});
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
    if (this.offset > LIMIT) throw Error(`${this.path} grew past 4 GiB; split it further.`);
  }

  checkName(name) {
    if (typeof name !== 'string' || !name || !NAME.test(name) || name.startsWith('/') || name.endsWith('/')
        || name.split('/').some(part => !part || part === '.' || part === '..')) {
      throw Error(`Invalid archive entry name: ${name}`);
    }
    const key = name.toLowerCase();
    if (this.names.has(key)) throw Error(`Duplicate archive entry: ${name}`);
    if (this.entries.length >= MAX_ENTRIES) throw Error(`${this.path} has too many entries; split it further.`);
    this.names.add(key);
  }

  // Adds `name` from `source` (a file path) or from `buffer`. `start`/`length` select a byte range.
  async add(name, {source, buffer, start = 0, length, store} = {}) {
    this.checkName(name);
    const nameBytes = Buffer.from(name, 'utf8');
    const method = (store ?? STORED.test(name)) ? 0 : 8;
    const headerOffset = this.offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(this.stamp.time, 10);
    header.writeUInt16LE(this.stamp.date, 12);
    header.writeUInt16LE(nameBytes.length, 26);
    await this.write(Buffer.concat([header, nameBytes]));
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
    if (uncompressed > LIMIT || compressed > LIMIT) throw Error(`${name} is larger than 4 GiB; split it first.`);
    if (length !== undefined && uncompressed !== length) throw Error(`${name}: expected ${length} bytes, read ${uncompressed}.`);
    const sizes = Buffer.alloc(12);
    sizes.writeUInt32LE(crc >>> 0, 0); sizes.writeUInt32LE(compressed, 4); sizes.writeUInt32LE(uncompressed, 8);
    await this.handle.write(sizes, 0, 12, headerOffset + 14);
    this.entries.push({nameBytes, method, crc: crc >>> 0, compressed, uncompressed, headerOffset});
    return {name, method, compressed, uncompressed, sha256: hash.digest('hex')};
  }

  async close() {
    const directoryOffset = this.offset;
    for (const entry of this.entries) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4); // made by: MS-DOS / FAT attributes, version 2.0
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(entry.method, 10);
      record.writeUInt16LE(this.stamp.time, 12);
      record.writeUInt16LE(this.stamp.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressed, 20);
      record.writeUInt32LE(entry.uncompressed, 24);
      record.writeUInt16LE(entry.nameBytes.length, 28);
      record.writeUInt32LE(0, 38); // external attributes: a normal file
      record.writeUInt32LE(entry.headerOffset, 42);
      await this.write(Buffer.concat([record, entry.nameBytes]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - directoryOffset, 12);
    end.writeUInt32LE(directoryOffset, 16);
    await this.write(end);
    await this.handle.close();
    return {path: this.path, bytes: this.offset, entries: this.entries.length};
  }
}

// Reads an archive's central directory (names, sizes, methods). Used by tests and the
// install check to inspect exactly what a player downloads.
export async function listZip(path) {
  const handle = await open(path, 'r');
  try {
    const {size} = await handle.stat();
    const tailLength = Math.min(size, 22 + 0xFFFF);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (at < 0) throw Error(`${path} is not a ZIP archive.`);
    const count = tail.readUInt16LE(at + 10), length = tail.readUInt32LE(at + 12), offset = tail.readUInt32LE(at + 16);
    const directory = Buffer.alloc(length);
    await handle.read(directory, 0, length, offset);
    const entries = [];
    for (let position = 0, index = 0; index < count; index++) {
      if (directory.readUInt32LE(position) !== 0x02014b50) throw Error(`${path} has a damaged directory.`);
      const nameLength = directory.readUInt16LE(position + 28), extra = directory.readUInt16LE(position + 30);
      const comment = directory.readUInt16LE(position + 32);
      entries.push({name: directory.toString('utf8', position + 46, position + 46 + nameLength),
        method: directory.readUInt16LE(position + 10), crc: directory.readUInt32LE(position + 16),
        compressed: directory.readUInt32LE(position + 20), uncompressed: directory.readUInt32LE(position + 24)});
      position += 46 + nameLength + extra + comment;
    }
    return entries;
  } finally { await handle.close(); }
}
