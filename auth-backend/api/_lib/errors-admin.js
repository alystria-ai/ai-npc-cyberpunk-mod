import { gunzipSync } from 'node:zlib';
import { readConfig } from './config.js';
import { safeEqual } from './crypto.js';
import { REPORT_ID_PATTERN, SIGNATURES_KEY, SIGNATURE_PATTERN, bodiesKey, idsKey, indexKey } from './errors.js';
import { headerValue, sendJson } from './http.js';
import { createUpstashStore } from './store.js';
import { compareVersions } from './version.js';

// The same check as admin.js: a short or missing secret never authorises anything.
function authorised(request, config) {
  if (config.adminSecret.length < 32) return false;
  const header = headerValue(request, 'authorization');
  return header.startsWith('Bearer ') && safeEqual(header.slice(7), config.adminSecret);
}

function queryOf(request) {
  try {
    return new URL(request.url ?? '/', 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

// HGETALL arrives as a flat [field, value, ...] list over Upstash's REST interface, or as an object through other clients.
function fieldsOf(raw) {
  const fields = new Map();
  if (Array.isArray(raw)) {
    for (let index = 0; index + 1 < raw.length; index += 2) fields.set(String(raw[index]), raw[index + 1]);
  } else if (raw && typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) fields.set(name, value);
  }
  return fields;
}

const isoOrNull = ms => {
  const number = Number(ms);
  return Number.isFinite(number) && number > 0 && number <= 8.64e15 ? new Date(number).toISOString() : null;
};

function summary(signature, score, rawFields, rawIds) {
  const fields = fieldsOf(rawFields);
  if (!fields.size) return null; // the index expired while the signature was still listed
  const versions = [...fields].filter(([name]) => name.startsWith('v:')).map(([name, count]) => [name.slice(2), Number(count) || 0])
    .sort((a, b) => (compareVersions(b[0], a[0]) ?? 0) || (a[0] < b[0] ? 1 : -1));
  return {
    signature,
    kind: String(fields.get('kind') ?? ''),
    message: String(fields.get('message') ?? ''),
    frame: fields.get('frame') ? String(fields.get('frame')) : null,
    reports: Number(fields.get('count')) || 0,
    stored: Number(fields.get('stored')) || 0,
    firstSeen: isoOrNull(fields.get('first')),
    lastSeen: isoOrNull(fields.get('last') ?? score),
    versions: Object.fromEntries(versions),
    ids: Array.isArray(rawIds) ? rawIds.map(String) : [],
  };
}

/**
 * The error reports, for the developer. Every call needs `Authorization: Bearer <CONVAI_AUTH_ADMIN_SECRET>` (404 when that secret is
 * unset or short, like the other admin calls).
 *   GET    /api/admin/errors?limit=N               newest signatures first (1 to 200, default 100): what each is, counts, versions and
 *                                                  the ids of its kept bodies. Two Redis commands plus two per signature listed.
 *   GET    /api/admin/errors?signature=S&id=ID     one kept body, unpacked
 *   DELETE /api/admin/errors?signature=S           forget a signature: index, bodies and its place in the list
 *   DELETE /api/admin/errors?signature=S&id=ID     forget one body
 */
export function createAdminErrorsHandler(options = {}) {
  const getEnv = () => options.env ?? process.env;
  return async function adminErrorsHandler(request, response) {
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, DELETE' });
      return;
    }
    const config = readConfig(getEnv());
    if (config.adminSecret.length < 32) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    if (!authorised(request, config)) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    const query = queryOf(request);
    const signature = query.get('signature'), id = query.get('id');
    const wrongSignature = signature !== null && !SIGNATURE_PATTERN.test(signature);
    const wrongId = id !== null && !REPORT_ID_PATTERN.test(id);
    // Reading one body needs both; deleting needs at least the signature (and then also removes the whole signature without an id).
    const incomplete = request.method === 'GET' && (signature === null) !== (id === null);
    if (wrongSignature || wrongId || incomplete || (request.method === 'DELETE' && signature === null)) {
      sendJson(response, 400, { error: 'bad_request', message: 'signature is 16 hex characters, id is <13 digits>-<6 hex>.' });
      return;
    }

    try {
      const store = options.store ?? createUpstashStore({ url: config.storeUrl, token: config.storeToken, fetchImpl: options.fetchImpl ?? fetch });

      if (request.method === 'DELETE') {
        if (id !== null) {
          const [removed, listed] = await store.pipeline([['HDEL', bodiesKey(signature), id], ['LREM', idsKey(signature), '0', id]]);
          sendJson(response, 200, { deleted: Number(removed) > 0 || Number(listed) > 0 ? 1 : 0 });
          return;
        }
        const [removed, listed] = await store.pipeline([['DEL', indexKey(signature), bodiesKey(signature), idsKey(signature)],
          ['ZREM', SIGNATURES_KEY, signature]]);
        sendJson(response, 200, { deleted: Number(removed) > 0 || Number(listed) > 0 });
        return;
      }

      if (signature !== null) {
        const stored = await store.command(['HGET', bodiesKey(signature), id]);
        if (typeof stored !== 'string') {
          sendJson(response, 404, { error: 'not_found' });
          return;
        }
        let report;
        try {
          // The size bound is only a seatbelt: what is in the store was written by the report handler, at most 64 KB before packing.
          report = JSON.parse(gunzipSync(Buffer.from(stored, 'base64'), { maxOutputLength: 1_048_576 }).toString('utf8'));
        } catch {
          sendJson(response, 500, { error: 'corrupt' });
          return;
        }
        sendJson(response, 200, { signature, id, receivedAt: isoOrNull(Number(id.slice(0, 13))), report });
        return;
      }

      const limit = Math.min(200, Math.max(1, Number.parseInt(query.get('limit') ?? '100', 10) || 100));
      const [rows, total] = await store.pipeline([['ZREVRANGE', SIGNATURES_KEY, '0', String(limit - 1), 'WITHSCORES'], ['ZCARD', SIGNATURES_KEY]]);
      const listed = [];
      for (let index = 0; index + 1 < (rows?.length ?? 0); index += 2) {
        if (SIGNATURE_PATTERN.test(String(rows[index]))) listed.push({ signature: String(rows[index]), score: rows[index + 1] });
      }
      const details = listed.length
        ? await store.pipeline(listed.flatMap(row => [['HGETALL', indexKey(row.signature)], ['LRANGE', idsKey(row.signature), '0', '-1']]))
        : [];
      const signatures = listed.map((row, index) => summary(row.signature, row.score, details[index * 2], details[index * 2 + 1])).filter(Boolean);
      sendJson(response, 200, { total: Number(total) || 0, signatures });
    } catch {
      sendJson(response, 503, { error: 'unavailable' });
    }
  };
}
