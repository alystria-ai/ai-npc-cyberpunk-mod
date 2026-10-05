import {deflateRawSync, inflateRawSync} from 'node:zlib';

// A minimal, dependency-free ZIP writer for the support report. It writes only
// regular files with UTF-8 names (no directories, no zip64, no encryption) and
// is deliberately small enough to review. readZip exists so the report can be
// verified, and so tests can inspect exactly what a player would send.

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let value = 0xFFFFFFFF;
  for (let index = 0; index < buffer.length; index++) value = TABLE[(value ^ buffer[index]) & 0xFF] ^ (value >>> 8);
  return (value ^ 0xFFFFFFFF) >>> 0;
}

const NAME = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const MAX_ENTRIES = 1000, MAX_BYTES = 0x7FFFFFFF;

function dosTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** entries: [{name, data: string | Buffer}]. Returns the archive as a Buffer. */
export function createZip(entries, {date = new Date()} = {}) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw Error('Invalid ZIP entry list');
  const stamp = dosTime(date), locals = [], central = [], seen = new Set();
  let offset = 0;
  for (const entry of entries) {
    if (typeof entry?.name !== 'string' || !NAME.test(entry.name) || entry.name.split('/').some(part => part === '..' || part === '.')
        || seen.has(entry.name.toLowerCase())) throw Error('Invalid ZIP entry name');
    seen.add(entry.name.toLowerCase());
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const packed = deflateRawSync(data, {level: 9});
    const stored = packed.length >= data.length, body = stored ? data : packed;
    if (data.length > MAX_BYTES || offset + body.length > MAX_BYTES) throw Error('ZIP entry is too large');
    const name = Buffer.from(entry.name, 'utf8'), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014B50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(stored ? 0 : 8, 10);
    header.writeUInt16LE(stamp.time, 12); header.writeUInt16LE(stamp.date, 14);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(body.length, 20); header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    locals.push(local, name, body); central.push(header, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Reads an archive made by createZip (and ordinary single-disk ZIPs). */
export function readZip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054B50) end--;
  if (end < 0) throw Error('Not a ZIP archive');
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const result = [];
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014B50) throw Error('Corrupt ZIP directory');
    const method = buffer.readUInt16LE(cursor + 10), crc = buffer.readUInt32LE(cursor + 16);
    const size = buffer.readUInt32LE(cursor + 20), original = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30);
    const comment = buffer.readUInt16LE(cursor + 32), local = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if (data.length !== original || crc32(data) !== crc) throw Error(`ZIP entry failed its check: ${name}`);
    result.push({name, data});
    cursor += 46 + nameLength + extra + comment;
  }
  return result;
}
