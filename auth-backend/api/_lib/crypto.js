import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_PREFIX = 'v1=';
export const MAX_CLOCK_SKEW_SECONDS = 120;

/** Hex HMAC-SHA256 over `${timestamp}.${body}`. The bridge computes the same value. */
export function signBody(secret, timestamp, body) {
  return SIGNATURE_PREFIX + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * 'ok', 'stale' (timestamp outside the window) or 'bad' (malformed or wrong signature).
 * The timestamp is in whole seconds since the epoch.
 */
export function checkSignature({ secret, timestamp, signature, body, nowMs }) {
  if (!/^\d{10}$/.test(String(timestamp ?? ''))) return 'bad';
  if (typeof signature !== 'string' || !signature.startsWith(SIGNATURE_PREFIX)) return 'bad';
  const seconds = Number(timestamp);
  if (Math.abs(Math.floor(nowMs / 1000) - seconds) > MAX_CLOCK_SKEW_SECONDS) return 'stale';
  return safeEqual(signature, signBody(secret, timestamp, body)) ? 'ok' : 'bad';
}

/** A short stable pseudonym for an install id or an address, so the store never holds either in the clear. */
export function pseudonym(secret, kind, value) {
  return createHmac('sha256', secret).update(`${kind}:${value}`).digest('hex').slice(0, 24);
}
