import { missingErrorReportSettings, readConfig } from './config.js';
import { checkSignature, pseudonym, safeEqual } from './crypto.js';
import { clientAddress, headerValue, queryOf, readRawBody, reply } from './http.js';
import { compareVersions, parseVersion } from './version.js';

// Automatic error reports from the mod's bridge: POST /api/errors/report, and the admin calls that read them. The Worker's version of
// auth-backend/api/_lib/errors.js and errors-admin.js: the same request, the same checks and limits, the same answers. The reports
// are kept in the ERRORS Durable Object (errors-store.js) instead of Redis.

export const MAX_BODY_BYTES = 65536;
export const MAX_SIGNATURES = 5000;
export const MAX_INDEX_FIELDS = 48;
// The earliest bodies of a signature that newer ones never evict (at most half of the samples), so a flood cannot push out the first real reports.
export const PINNED_SAMPLES = 3;
export const SIGNATURE_PATTERN = /^[0-9a-f]{16}$/;
export const REPORT_ID_PATTERN = /^\d{13}-[0-9a-f]{6}$/;
const INSTALL_PATTERN = /^[0-9a-f]{32}$/;
const KIND_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const PREFILTER_PER_MINUTE = 60;
const DAY_MS = 86_400_000;
const MAX_UNPACKED_BYTES = 1_048_576;

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const nextUtcMidnight = ms => Math.floor(ms / DAY_MS + 1) * DAY_MS;
const nextHour = ms => Math.floor(ms / 3_600_000 + 1) * 3_600_000;
// Cut by characters, not code units, so a pair is never split; a lone half is replaced, since the store speaks UTF-8.
const wellFormed = text => (typeof text.toWellFormed === 'function' ? text.toWellFormed() : text);
const cut = (text, length) => wellFormed(Array.from(text).slice(0, length).join(''));
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** The parsed body when it is a valid report (see auth-backend/README.md, "Error reports"), else null. Extra top-level fields are allowed. */
export function parseReportBody(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!plainObject(body)) return null;
  const { schema, install, signature, kind, message, frame, modVersion, count, report } = body;
  if (schema !== 1) return null;
  if (typeof install !== 'string' || !INSTALL_PATTERN.test(install)) return null;
  if (typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) return null;
  if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) return null;
  if (typeof message !== 'string' || message.length < 1 || message.length > 400) return null;
  if (frame !== undefined && (typeof frame !== 'string' || frame.length > 240)) return null;
  if (!parseVersion(modVersion)) return null;
  if (count !== undefined && !(Number.isSafeInteger(count) && count >= 1 && count <= 100_000)) return null;
  if (report !== undefined && !plainObject(report)) return null;
  return body;
}

function toBase64(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary);
}

/** Text -> base64 of its gzip (the format the Vercel version keeps, so one tool reads both). */
export async function packReport(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return toBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

/** The reverse of packReport. Throws when the text is not gzip or unpacks past the size seatbelt (what is stored is at most 64 KB before packing). */
export async function unpackReport(packed) {
  const bytes = Uint8Array.from(atob(packed), character => character.charCodeAt(0));
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_UNPACKED_BYTES) {
      reader.cancel().catch(() => {});
      throw new Error('too large');
    }
    parts.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** POST /api/errors/report. Signed exactly like the token request, with the report secret. Never echoes the body. */
export function createErrorReportHandler(deps) {
  const { now } = deps;
  const maxSignatures = deps.maxSignatures ?? MAX_SIGNATURES;
  const prefilter = new Map();
  const flooded = ipKey => {
    const at = now();
    if (prefilter.size > 5000) prefilter.clear();
    const entry = prefilter.get(ipKey);
    if (!entry || entry.resetAt <= at) {
      prefilter.set(ipKey, { count: 1, resetAt: at + 60_000 });
      return false;
    }
    entry.count += 1;
    return entry.count > PREFILTER_PER_MINUTE;
  };

  return async function errorReportHandler(request, env) {
    if (request.method !== 'POST') return reply(request, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    const config = readConfig(env);
    // The bridge reads 404 as "this backend has no error endpoint": it stops sending for the session.
    if (config.errorReportsOff) return reply(request, 404, { error: 'not_found' });
    const store = deps.errorsFor(env);
    if (missingErrorReportSettings(config, !!store).length) return reply(request, 503, { error: 'unconfigured' });

    let text;
    try {
      text = await readRawBody(request, MAX_BODY_BYTES);
    } catch {
      return reply(request, 400, { error: 'bad_request' });
    }
    if (text === null) return reply(request, 413, { error: 'too_large' });
    const nowMs = now();
    const checked = await checkSignature({ secret: config.reportSecret, timestamp: headerValue(request, 'x-convai-timestamp'),
      signature: headerValue(request, 'x-convai-signature'), body: text, nowMs });
    if (checked === 'stale') return reply(request, 401, { error: 'stale', serverTime: Math.floor(nowMs / 1000) });
    if (checked !== 'ok') return reply(request, 401, { error: 'unauthorized' });
    const body = parseReportBody(text);
    if (!body) return reply(request, 400, { error: 'bad_request' });

    const ipKey = await pseudonym(config.pseudonymSecret, 'error-ip', clientAddress(request, { prefixGroups: 3 }));
    if (flooded(ipKey)) return reply(request, 429, { error: 'rate', retryAfterSeconds: 60 }, { 'Retry-After': '60' });

    const installKey = await pseudonym(config.pseudonymSecret, 'error-install', body.install);
    const ttlSeconds = config.errorTtlDays * 86_400;
    const id = `${String(nowMs).padStart(13, '0')}-${randomHex(3)}`;
    // What is kept is the body with the client's install hash swapped for the server's second hash (still one value per install,
    // so reports can be grouped, but not the value the client sent).
    const kept = await packReport(JSON.stringify({ ...body, install: installKey }));

    let verdict;
    try {
      verdict = await store.report({ now: nowMs, ipKey, installKey, hour: Math.floor(nowMs / 3_600_000), day: isoDay(nowMs),
        ipPerHour: config.errorIpPerHour, installPerDay: config.errorInstallPerDay, storePerDay: config.errorStorePerDay,
        samples: config.errorSamples, ttlSeconds, signature: body.signature, kind: body.kind, message: cut(body.message, 200),
        frame: cut(body.frame ?? '', 160), version: `v:${body.modVersion}`, id, kept, cutoffMs: Math.max(0, nowMs - ttlSeconds * 1000),
        maxSignatures, maxFields: MAX_INDEX_FIELDS, pinned: Math.min(PINNED_SAMPLES, Math.floor(config.errorSamples / 2)) });
    } catch {
      // Fail closed: without the counters nothing is kept (a report is not worth an unbounded store).
      console.error('[error-reports] store unavailable');
      return reply(request, 503, { error: 'unavailable' }, { 'Retry-After': '30' });
    }
    const code = verdict && typeof verdict.code === 'string' ? verdict.code : null;
    if (code === 'rate_ip') {
      const retry = Math.max(1, Math.ceil((nextHour(nowMs) - nowMs) / 1000));
      return reply(request, 429, { error: 'rate', retryAfterSeconds: retry }, { 'Retry-After': String(retry) });
    }
    if (code === 'rate_install') {
      const retry = Math.max(1, Math.ceil((nextUtcMidnight(nowMs) - nowMs) / 1000));
      return reply(request, 429, { error: 'rate', retryAfterSeconds: retry }, { 'Retry-After': String(retry) });
    }
    if (code === 'duplicate') return reply(request, 200, { ok: true, stored: false, reason: 'duplicate' });
    if (code === 'counted') return reply(request, 200, { ok: true, stored: false, reason: 'counted' });
    if (code === 'stored') return reply(request, 200, { ok: true, stored: true, id });
    console.error('[error-reports] unexpected store answer');
    return reply(request, 503, { error: 'unavailable' }, { 'Retry-After': '30' });
  };
}

// --- Admin ----------------------------------------------------------------------------------------------------------------------

export function authorised(request, config) {
  if (config.adminSecret.length < 32) return false;
  const header = headerValue(request, 'authorization');
  return header.startsWith('Bearer ') && safeEqual(header.slice(7), config.adminSecret);
}

const isoOrNull = ms => {
  const number = Number(ms);
  return Number.isFinite(number) && number > 0 && number <= 8.64e15 ? new Date(number).toISOString() : null;
};

function summary(signature, score, record) {
  if (!record) return null; // the index expired while the signature was still listed
  const versions = Object.entries(record.versions ?? {}).map(([name, count]) => [name.slice(2), Number(count) || 0])
    .sort((a, b) => (compareVersions(b[0], a[0]) ?? 0) || (a[0] < b[0] ? 1 : -1));
  return {
    signature,
    kind: String(record.kind ?? ''),
    message: String(record.message ?? ''),
    frame: record.frame ? String(record.frame) : null,
    reports: Number(record.count) || 0,
    stored: Number(record.stored) || 0,
    firstSeen: isoOrNull(record.first),
    lastSeen: isoOrNull(record.last ?? score),
    versions: Object.fromEntries(versions),
    ids: Array.isArray(record.ids) ? record.ids.map(String) : [],
  };
}

/**
 * The error reports, for the developer: the same four calls as auth-backend (`Authorization: Bearer <CONVAI_AUTH_ADMIN_SECRET>`).
 *   GET    /api/admin/errors?limit=N               newest signatures first (1 to 200, default 100)
 *   GET    /api/admin/errors?signature=S&id=ID     one kept body, unpacked
 *   DELETE /api/admin/errors?signature=S           forget a signature
 *   DELETE /api/admin/errors?signature=S&id=ID     forget one body
 */
export function createAdminErrorsHandler(deps) {
  const { now } = deps;
  return async function adminErrorsHandler(request, env) {
    if (request.method !== 'GET' && request.method !== 'DELETE') return reply(request, 405, { error: 'method_not_allowed' }, { Allow: 'GET, DELETE' });
    const config = readConfig(env);
    if (config.adminSecret.length < 32) return reply(request, 404, { error: 'not_found' });
    if (!authorised(request, config)) return reply(request, 401, { error: 'unauthorized' });
    const query = queryOf(request);
    const signature = query.get('signature'), id = query.get('id');
    const wrongSignature = signature !== null && !SIGNATURE_PATTERN.test(signature);
    const wrongId = id !== null && !REPORT_ID_PATTERN.test(id);
    // Reading one body needs both; deleting needs at least the signature (and then also removes the whole signature without an id).
    const incomplete = request.method === 'GET' && (signature === null) !== (id === null);
    if (wrongSignature || wrongId || incomplete || (request.method === 'DELETE' && signature === null)) {
      return reply(request, 400, { error: 'bad_request', message: 'signature is 16 hex characters, id is <13 digits>-<6 hex>.' });
    }

    try {
      const store = deps.errorsFor(env);
      if (!store) return reply(request, 503, { error: 'unavailable' });
      if (request.method === 'DELETE') {
        if (id !== null) return reply(request, 200, { deleted: await store.deleteBody({ signature, id }) });
        return reply(request, 200, { deleted: await store.deleteSignature({ signature }) });
      }
      if (signature !== null) {
        const stored = await store.body({ signature, id });
        if (typeof stored !== 'string') return reply(request, 404, { error: 'not_found' });
        let report;
        try {
          report = JSON.parse(await unpackReport(stored));
        } catch {
          return reply(request, 500, { error: 'corrupt' });
        }
        return reply(request, 200, { signature, id, receivedAt: isoOrNull(Number(id.slice(0, 13))), report });
      }
      const limit = Math.min(200, Math.max(1, Number.parseInt(query.get('limit') ?? '100', 10) || 100));
      const nowMs = now();
      const { total, rows } = await store.list({ now: nowMs, limit, minLastMs: Math.max(0, nowMs - config.errorTtlDays * DAY_MS) });
      const signatures = rows.map(row => summary(row.signature, row.score, row.record)).filter(Boolean);
      return reply(request, 200, { total: Number(total) || 0, signatures });
    } catch {
      return reply(request, 503, { error: 'unavailable' });
    }
  };
}
