// Small helpers shared by every route. No dependencies.
export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // Which server answered, for the client's cause logging. Not a secret and not used for any decision.
  'X-Auth-Backend': 'cloudflare-worker',
};

/** A JSON Response with the security headers. A HEAD request gets the status and headers only, like auth-backend/api/_lib/http.js. */
export function reply(request, status, body, extraHeaders = {}) {
  const headers = { ...SECURITY_HEADERS, ...extraHeaders };
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

export function headerValue(request, name) {
  return (request.headers.get(name) ?? '').trim();
}

// The eight 16-bit groups of an IPv6 address, or null. Accepts the compressed form (::), an embedded IPv4 tail and a zone (%eth0).
function ipv6Groups(text) {
  let value = text.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  const four = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (four) {
    if (four.slice(1).some(part => Number(part) > 255)) return null;
    const [a, b, c, d] = four.slice(1).map(Number);
    value = value.slice(0, four.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  if (!/^[0-9a-f:]+$/.test(value) || (value.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = value.includes('::') ? value.split('::') : [value, null];
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  if (tail === null && left.length !== 8) return null;
  if (tail !== null && left.length + right.length > 7) return null;
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map(group => parseInt(group, 16));
}

/**
 * The caller as the rate limits count it: an IPv4 address is itself, an IPv6 address is its /64 (the error reports use /48:
 * `prefixGroups: 3`), an IPv4 address written as IPv6 is the IPv4 one. Identical to addressBucket in auth-backend/api/_lib/http.js.
 */
export function addressBucket(address, { prefixGroups = 4 } = {}) {
  const text = String(address ?? '').trim();
  if (!text.includes(':')) return text;
  const groups = ipv6Groups(text);
  if (!groups) return text;
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups.slice(0, prefixGroups).map(group => group.toString(16)).join(':')}::/${prefixGroups * 16}`;
}

/**
 * The client address, as addressBucket counts it. Cloudflare sets CF-Connecting-IP itself and a caller cannot choose it; it is the only
 * header trusted here (X-Forwarded-For can be written by the caller). Without it, one shared "unknown" bucket (strictest outcome).
 */
export function clientAddress(request, options) {
  return addressBucket(headerValue(request, 'cf-connecting-ip') || 'unknown', options);
}

/** The raw request body as text, at most `limit` bytes, or null when it is larger. Read as a stream so a huge body is never held. */
export async function readRawBody(request, limit = 4096) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // ignoreBOM keeps a leading byte order mark in the text, like Buffer.toString('utf8') does on the other server.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(joined);
}

export function queryOf(request) {
  try {
    return new URL(request.url).searchParams;
  } catch {
    return new URLSearchParams();
  }
}
