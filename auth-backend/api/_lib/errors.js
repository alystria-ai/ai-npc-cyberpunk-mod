import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { missingErrorReportSettings, readConfig } from './config.js';
import { checkSignature, pseudonym } from './crypto.js';
import { clientAddress, headerValue, readRawBody, sendJson } from './http.js';
import { createUpstashStore } from './store.js';
import { parseVersion } from './version.js';

// Automatic error reports from the mod's bridge: POST /api/errors/report. The whole decision and every write is ONE Redis script
// (one command on Upstash). Every key has a TTL, so nothing needs cleaning up. Written to run on Redis's Lua 5.1 and, in the
// tests, on fengari's Lua 5.3, so like admit.js it uses no tostring on numbers, no unpack and no integer division; every computed
// string (the age cut-offs, the id, the lifetime) is built in JavaScript and arrives as ARGV.
//
// KEYS  1 address counter, per hour        2 install hash, per UTC day: n (reports today) and s:<signature> (already sent)
//       3 bodies kept today (counter)      4 index hash of the signature (what it is, counts, versions)
//       5 report bodies of the signature (hash: id -> base64 gzip)            6 ids of the signature, newest first (list)
//       7 all signatures (zset: signature -> last seen ms)
// ARGV  1 address limit per hour           2 install limit per day       3 bodies kept per day, whole service
//       4 bodies kept per signature        5 lifetime of every key (seconds)
//       6 signature                        7 kind        8 message (cut)        9 frame (cut, may be empty)
//       10 version field 'v:<modVersion>'  11 now (ms)   12 report id           13 base64 gzip of the body
//       14 oldest id time still kept (13 digits, zero padded)                  15 zset cut-off ('(' + ms)
//       16 most signatures listed          17 most fields in an index hash
//       18 how many of the earliest bodies are pinned (never evicted by newer ones; the rest of the list is newest first)
//
// Order: the address counter, then the install's duplicate check (a signature is taken once per install per UTC day, and a
// duplicate counts nowhere else), then the install's daily count, then the index, and only then the body (kept when the day's
// budget of bodies allows). Returns {code, count}: rate_ip, duplicate, rate_install, counted (index updated, body not kept) or
// stored; count is the index's report count for the signature (0 for the first three).
export const REPORT_SCRIPT = `
local function bump(key, ttl)
  local n = redis.call('INCR', key)
  if n == 1 then redis.call('EXPIRE', key, ttl) end
  return n
end
local ttl = ARGV[5]
local sig = ARGV[6]
if bump(KEYS[1], 7200) > tonumber(ARGV[1]) then return {'rate_ip', 0} end
if redis.call('HEXISTS', KEYS[2], 's:' .. sig) == 1 then return {'duplicate', 0} end
local today = redis.call('HINCRBY', KEYS[2], 'n', 1)
if today == 1 then redis.call('EXPIRE', KEYS[2], 172800) end
if today > tonumber(ARGV[2]) then return {'rate_install', 0} end
redis.call('HSET', KEYS[2], 's:' .. sig, '1')
local keep = bump(KEYS[3], 172800) <= tonumber(ARGV[3])

redis.call('HSETNX', KEYS[4], 'first', ARGV[11])
-- What the signature is (kind, message, frame) is the value most reports agree on, not the first writer's: a running majority vote
-- (one candidate and a counter), so one early forged report cannot fix the text for good.
local candidate = redis.call('HGET', KEYS[4], 'kind')
if not candidate then
  redis.call('HSET', KEYS[4], 'kind', ARGV[7], 'message', ARGV[8], 'frame', ARGV[9], 'votes', '1')
elseif candidate == ARGV[7] and redis.call('HGET', KEYS[4], 'message') == ARGV[8] and (redis.call('HGET', KEYS[4], 'frame') or '') == ARGV[9] then
  redis.call('HINCRBY', KEYS[4], 'votes', 1)
else
  local votes = tonumber(redis.call('HGET', KEYS[4], 'votes') or '1') - 1
  if votes <= 0 then
    redis.call('HSET', KEYS[4], 'kind', ARGV[7], 'message', ARGV[8], 'frame', ARGV[9], 'votes', '1')
  else
    redis.call('HSET', KEYS[4], 'votes', votes)
  end
end
redis.call('HSET', KEYS[4], 'last', ARGV[11])
local count = redis.call('HINCRBY', KEYS[4], 'count', 1)
if keep then redis.call('HINCRBY', KEYS[4], 'stored', 1) end
if redis.call('HEXISTS', KEYS[4], ARGV[10]) == 1 or redis.call('HLEN', KEYS[4]) < tonumber(ARGV[17]) then
  redis.call('HINCRBY', KEYS[4], ARGV[10], 1)
end
redis.call('EXPIRE', KEYS[4], ttl)

if keep then
  redis.call('HSET', KEYS[5], ARGV[12], ARGV[13])
  redis.call('EXPIRE', KEYS[5], ttl)
  redis.call('LPUSH', KEYS[6], ARGV[12])
  local samples = tonumber(ARGV[4])
  local pinned = tonumber(ARGV[18])
  -- Over the limit: drop the oldest body that is not one of the pinned earliest (the pinned ones sit at the tail).
  while redis.call('LLEN', KEYS[6]) > samples do
    local victim = redis.call('LINDEX', KEYS[6], -1 - pinned)
    redis.call('LREM', KEYS[6], -1, victim)
    redis.call('HDEL', KEYS[5], victim)
  end
  while true do
    local oldest = redis.call('LINDEX', KEYS[6], -1)
    if not oldest or string.sub(oldest, 1, 13) >= ARGV[14] then break end
    redis.call('RPOP', KEYS[6])
    redis.call('HDEL', KEYS[5], oldest)
  end
  redis.call('EXPIRE', KEYS[6], ttl)
end

redis.call('ZADD', KEYS[7], ARGV[11], sig)
redis.call('ZREMRANGEBYSCORE', KEYS[7], '-inf', ARGV[15])
local listed = redis.call('ZCARD', KEYS[7])
local most = tonumber(ARGV[16])
if listed > most then redis.call('ZREMRANGEBYRANK', KEYS[7], 0, listed - most - 1) end
redis.call('EXPIRE', KEYS[7], ttl)

if keep then return {'stored', count} end
return {'counted', count}
`;

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

// The keys, shared with the admin calls (errors-admin.js).
export const SIGNATURES_KEY = 'er:sigs';
export const indexKey = signature => `er:i:${signature}`;
export const bodiesKey = signature => `er:r:${signature}`;
export const idsKey = signature => `er:o:${signature}`;

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const nextUtcMidnight = ms => Math.floor(ms / DAY_MS + 1) * DAY_MS;
const nextHour = ms => Math.floor(ms / 3_600_000 + 1) * 3_600_000;
// Cut by characters, not code units, so a pair is never split; a lone half is replaced, since the store speaks UTF-8.
const wellFormed = text => (typeof text.toWellFormed === 'function' ? text.toWellFormed() : text);
const cut = (text, length) => wellFormed(Array.from(text).slice(0, length).join(''));

const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** The parsed body when it is a valid report (see README.md, "Error reports"), else null. Extra top-level fields are allowed. */
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

/**
 * POST /api/errors/report. One call per report to the store (a single script) and none for a request refused earlier.
 *
 * Request: Content-Type text/plain, body JSON {schema: 1, install, signature, kind, message, frame?, modVersion, count?, report?},
 * at most 65536 bytes, signed exactly like the token request (x-convai-timestamp, x-convai-signature). install is the client's
 * own hash of its install id; the server hashes it again before it is used in a key, and the stored body carries that second
 * hash instead of the value that was sent. The address is only ever used as a keyed hash. Never echoes the body.
 */
export function createErrorReportHandler(options = {}) {
  const getEnv = () => options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxSignatures = options.maxSignatures ?? MAX_SIGNATURES;
  let upstash = null, upstashFor = '';
  const storeFor = config => {
    if (options.store) return options.store;
    const identity = `${config.storeUrl}|${config.storeToken}`;
    if (!upstash || upstashFor !== identity) {
      upstash = createUpstashStore({ url: config.storeUrl, token: config.storeToken, fetchImpl });
      upstashFor = identity;
    }
    return upstash;
  };

  // Advisory per-instance flood guard in front of the store (the token handler's, with its own map), so a hammering client costs
  // no Redis commands on the instance it hits. The store's counters are the real limits; this one is not shared between instances.
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

  return async function errorReportHandler(request, response) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
      return;
    }
    const config = readConfig(getEnv());
    // The bridge reads 404 as "this backend has no error endpoint": it stops sending for the session.
    if (config.errorReportsOff) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    if (missingErrorReportSettings(config).length) {
      sendJson(response, 503, { error: 'unconfigured' });
      return;
    }

    let text;
    try {
      text = await readRawBody(request, MAX_BODY_BYTES);
    } catch {
      // The client went away or the stream failed while the body was being read: answer, do not reject the handler.
      sendJson(response, 400, { error: 'bad_request' });
      return;
    }
    if (text === null) {
      sendJson(response, 413, { error: 'too_large' });
      return;
    }
    const nowMs = now();
    const checked = checkSignature({ secret: config.reportSecret, timestamp: headerValue(request, 'x-convai-timestamp'),
      signature: headerValue(request, 'x-convai-signature'), body: text, nowMs });
    if (checked === 'stale') {
      sendJson(response, 401, { error: 'stale', serverTime: Math.floor(nowMs / 1000) });
      return;
    }
    if (checked !== 'ok') {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    const body = parseReportBody(text);
    if (!body) {
      sendJson(response, 400, { error: 'bad_request' });
      return;
    }

    const ipKey = pseudonym(config.pseudonymSecret, 'error-ip', clientAddress(request, { prefixGroups: 3 }));
    if (flooded(ipKey)) {
      sendJson(response, 429, { error: 'rate', retryAfterSeconds: 60 }, { 'Retry-After': '60' });
      return;
    }

    const installKey = pseudonym(config.pseudonymSecret, 'error-install', body.install);
    const ttlSeconds = config.errorTtlDays * 86_400;
    const id = `${String(nowMs).padStart(13, '0')}-${randomBytes(3).toString('hex')}`;
    // What is kept is the body with the client's install hash swapped for the server's second hash (still one value per install,
    // so reports can be grouped, but not the value the client sent). Compressed here: the script only moves the text.
    const kept = gzipSync(Buffer.from(JSON.stringify({ ...body, install: installKey }), 'utf8')).toString('base64');
    const keys = [`er:ip:${ipKey}:${Math.floor(nowMs / 3_600_000)}`, `er:in:${installKey}:${isoDay(nowMs)}`, `er:day:${isoDay(nowMs)}`,
      indexKey(body.signature), bodiesKey(body.signature), idsKey(body.signature), SIGNATURES_KEY];
    const args = [config.errorIpPerHour, config.errorInstallPerDay, config.errorStorePerDay, config.errorSamples, ttlSeconds,
      body.signature, body.kind, cut(body.message, 200), cut(body.frame ?? '', 160), `v:${body.modVersion}`, nowMs, id, kept,
      String(Math.max(0, nowMs - ttlSeconds * 1000)).padStart(13, '0'), `(${Math.max(0, nowMs - ttlSeconds * 1000)}`,
      maxSignatures, MAX_INDEX_FIELDS, Math.min(PINNED_SAMPLES, Math.floor(config.errorSamples / 2))];

    let verdict;
    try {
      verdict = await storeFor(config).evalScript(REPORT_SCRIPT, keys, args);
    } catch {
      // Fail closed: without the counters nothing is kept (a report is not worth an unbounded store).
      console.error('[error-reports] store unavailable');
      sendJson(response, 503, { error: 'unavailable' }, { 'Retry-After': '30' });
      return;
    }
    const code = Array.isArray(verdict) ? verdict[0] : null;
    if (code === 'rate_ip') {
      const retry = Math.max(1, Math.ceil((nextHour(nowMs) - nowMs) / 1000));
      sendJson(response, 429, { error: 'rate', retryAfterSeconds: retry }, { 'Retry-After': String(retry) });
    } else if (code === 'rate_install') {
      const retry = Math.max(1, Math.ceil((nextUtcMidnight(nowMs) - nowMs) / 1000));
      sendJson(response, 429, { error: 'rate', retryAfterSeconds: retry }, { 'Retry-After': String(retry) });
    } else if (code === 'duplicate') {
      sendJson(response, 200, { ok: true, stored: false, reason: 'duplicate' });
    } else if (code === 'counted') {
      sendJson(response, 200, { ok: true, stored: false, reason: 'counted' });
    } else if (code === 'stored') {
      sendJson(response, 200, { ok: true, stored: true, id });
    } else {
      console.error('[error-reports] unexpected store answer');
      sendJson(response, 503, { error: 'unavailable' }, { 'Retry-After': '30' });
    }
  };
}
