// Small helpers shared by every function. No dependencies.
export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

export function sendJson(response, status, body, extraHeaders = {}) {
  for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...extraHeaders })) {
    response.setHeader(name, value);
  }
  response.statusCode = status;
  if (response.req?.method === 'HEAD') {
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

export function headerValue(request, name) {
  const value = request.headers?.[name];
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return typeof value === 'string' ? value.trim() : '';
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
 * The caller as the rate limits count it. An IPv4 address is itself. An IPv6 address counts as its /64 network: one home line or one
 * cloud machine is normally handed a whole /64 (2^64 addresses), so counting single addresses would let one caller step around the
 * per-address limits (and the new-installs-per-address limit) at will. An IPv4 address written as IPv6 (::ffff:a.b.c.d) is the IPv4 one.
 * `prefixGroups` is how many 16-bit groups of an IPv6 address are kept (4 = /64, the default; 3 = /48, which the error reports use,
 * since a site is normally handed a /48 and a /64 is cheap to step through inside it).
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
 * The client address, as addressBucket counts it. Vercel sets x-vercel-forwarded-for (and overwrites x-forwarded-for) itself, so a caller
 * cannot choose it. Falls back to the socket address, then to one shared "unknown" bucket (strictest outcome).
 */
export function clientAddress(request, options) {
  const forwarded = headerValue(request, 'x-vercel-forwarded-for') || headerValue(request, 'x-forwarded-for');
  const first = forwarded.split(',')[0].trim();
  return addressBucket(first || request.socket?.remoteAddress || 'unknown', options);
}

/** The raw request body as text, at most `limit` bytes, or null when it is larger. */
export async function readRawBody(request, limit = 4096) {
  // A Vercel function receives a not yet consumed stream until request.body is touched; read it ourselves so the
  // signature is checked over the exact bytes the client sent.
  if (request.readable === true && typeof request.on === 'function' && request.body === undefined) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      // A stream with an encoding set delivers text; count the bytes it stands for, not its characters.
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      if (size > limit) return null;
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const body = request.body;
  let text;
  if (typeof body === 'string') text = body;
  else if (Buffer.isBuffer(body)) text = body.toString('utf8');
  else if (body && typeof body === 'object') text = JSON.stringify(body); // already parsed by the platform: only matches if re-serialising is byte-identical
  else text = '';
  return Buffer.byteLength(text, 'utf8') > limit ? null : text;
}
