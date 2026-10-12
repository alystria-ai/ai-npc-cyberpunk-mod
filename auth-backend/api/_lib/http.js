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

/**
 * The client address. Vercel sets x-vercel-forwarded-for (and overwrites x-forwarded-for) itself, so a caller
 * cannot choose it. Falls back to the socket address, then to one shared "unknown" bucket (strictest outcome).
 */
export function clientAddress(request) {
  const forwarded = headerValue(request, 'x-vercel-forwarded-for') || headerValue(request, 'x-forwarded-for');
  const first = forwarded.split(',')[0].trim();
  return first || request.socket?.remoteAddress || 'unknown';
}

/** The raw request body as text, at most `limit` bytes, or null when it is larger. */
export async function readRawBody(request, limit = 4096) {
  // A Vercel function receives a not yet consumed stream until request.body is touched; read it ourselves so the
  // signature is checked over the exact bytes the client sent.
  if (request.readable === true && typeof request.on === 'function' && request.body === undefined) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) return null;
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
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
