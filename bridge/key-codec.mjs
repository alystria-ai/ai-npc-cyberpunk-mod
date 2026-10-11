// How the project's Convai key travels inside the release package: scrambled, never a greppable `api-key = ...` line.
//
// This is obfuscation, not secrecy. A key that ships inside a program can always be recovered by someone who runs that
// program, so the aim is only to keep it out of plain-text searches, file previews and log or screenshot leaks. The
// bridge decodes it in memory at start-up; nothing writes the decoded value anywhere or prints it.
//
// Format of the packaged file (one line):  convai-key-v1 <base64url of salt(12) + masked key + check(4)>
//   masked key  the key bytes XOR a SHA-256 counter stream seeded with a fixed pepper and the salt
//   check       the first four bytes of SHA-256 of the key, so a damaged file is refused instead of used
// A plain `api-key=<value>` file (a developer's runtime/convai-key.txt, or a player's own convai-key.txt) still works
// and is never treated as the project's key (see isPackedKeyText: only a packed file is subject to the daily cap).
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';

export const PACKED_PREFIX = 'convai-key-v1';
const PEPPER = 'cyberpunk-convai/package-key/v1';
const PACKED = new RegExp(`^${PACKED_PREFIX}\\s+([A-Za-z0-9_-]{24,1400})$`);
const PLAIN = /^api-key\s*=\s*(\S+)$/i;
const SALT = 12, CHECK = 4;

const stream = (salt, length) => {
  const parts = [];
  for (let counter = 0; parts.length * 32 < length; counter++) {
    parts.push(createHash('sha256').update(PEPPER).update(salt).update(String(counter)).digest());
  }
  return Buffer.concat(parts).subarray(0, length);
};
const check = key => createHash('sha256').update(key, 'utf8').digest().subarray(0, CHECK);
const mask = (bytes, salt) => { const pad = stream(salt, bytes.length); return Buffer.from(bytes.map((byte, index) => byte ^ pad[index])); };

/** The packaged-file text for `key`. `salt` is for tests only. */
export function packKey(key, {salt = randomBytes(SALT)} = {}) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(key)) throw Error('The key has an unexpected format (value not shown).');
  const body = Buffer.concat([salt, mask(Buffer.from(key, 'utf8'), salt), check(key)]);
  return `${PACKED_PREFIX} ${body.toString('base64url')}\n`;
}

/** True for the packaged format (whether or not it decodes). */
export const isPackedKeyText = text => typeof text === 'string' && text.length <= 4096 && PACKED.test(text.replace(/^﻿/, '').trim());

/**
 * What a key file holds: {key, packed} or null when it is neither format (or a packed file is damaged).
 * packed === true means the key came from the release package, i.e. the project's shared key.
 */
export function readKeyFileText(text) {
  if (typeof text !== 'string' || text.length > 4096) return null;
  const trimmed = text.replace(/^﻿/, '').trim();
  const plain = PLAIN.exec(trimmed);
  if (plain) return {key: plain[1], packed: false};
  const packed = PACKED.exec(trimmed);
  if (!packed) return null;
  try {
    const body = Buffer.from(packed[1], 'base64url');
    if (body.length < SALT + CHECK + 8) return null;
    const salt = body.subarray(0, SALT), tail = body.subarray(body.length - CHECK);
    const key = mask(body.subarray(SALT, body.length - CHECK), salt).toString('utf8');
    return key.length >= 8 && timingSafeEqual(check(key), tail) ? {key, packed: true} : null;
  } catch { return null; }
}

/** Whether a key file is usable without revealing or returning the key (for preflight checks). */
export const isKeyFileText = text => readKeyFileText(text) !== null;
