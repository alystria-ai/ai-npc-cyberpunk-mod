// Request signatures and pseudonyms with WebCrypto (no node:crypto, so this runs unchanged in a Worker). The formats are those of
// auth-backend/api/_lib/crypto.js: the same signing secret gives the same signature on both servers.
export const SIGNATURE_PREFIX = 'v1=';
export const MAX_CLOCK_SKEW_SECONDS = 120;

const encoder = new TextEncoder();
const keys = new Map(); // imported HMAC keys by secret, so a warm isolate imports each once
const toHex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');

async function hmacHex(secret, message) {
  let key = keys.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    if (keys.size >= 8) keys.clear();
    keys.set(secret, key);
  }
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Hex HMAC-SHA256 over `${timestamp}.${body}`, prefixed `v1=`. The bridge computes the same value. */
export async function signBody(secret, timestamp, body) {
  return SIGNATURE_PREFIX + await hmacHex(secret, `${timestamp}.${body}`);
}

/** Equal-length strings compared without stopping at the first difference. */
export function safeEqual(a, b) {
  const left = encoder.encode(String(a)), right = encoder.encode(String(b));
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

/**
 * 'ok', 'stale' (timestamp outside the window) or 'bad' (malformed or wrong signature).
 * The timestamp is in whole seconds since the epoch.
 */
export async function checkSignature({ secret, timestamp, signature, body, nowMs }) {
  if (!/^\d{10}$/.test(String(timestamp ?? ''))) return 'bad';
  if (typeof signature !== 'string' || !signature.startsWith(SIGNATURE_PREFIX)) return 'bad';
  const seconds = Number(timestamp);
  if (Math.abs(Math.floor(nowMs / 1000) - seconds) > MAX_CLOCK_SKEW_SECONDS) return 'stale';
  return safeEqual(signature, await signBody(secret, timestamp, body)) ? 'ok' : 'bad';
}

/** A short stable pseudonym for an install id or an address, so the store never holds either in the clear. */
export async function pseudonym(secret, kind, value) {
  return (await hmacHex(secret, `${kind}:${value}`)).slice(0, 24);
}
