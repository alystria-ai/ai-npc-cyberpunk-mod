import { readConfig, missingSettings, validCap } from './config.js';
import { createConvaiClient } from './convai.js';
import { checkSignature, pseudonym } from './crypto.js';
import { clientAddress, headerValue, readRawBody, reply } from './http.js';
import { compareVersions, parseVersion } from './version.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TURNS_PER_REPORT = 1000;
const MAX_MIN_LIFE_SECONDS = 900;
const PREFILTER_PER_MINUTE = 60;
const STALE_SERVE_MS = 60_000;

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const nextUtcMidnight = ms => Math.floor(ms / 86_400_000 + 1) * 86_400_000;
const nextHour = ms => Math.floor(ms / 3_600_000 + 1) * 3_600_000;

/** "expiresMs|token" as the store keeps a token, or null. */
function parseKept(text) {
  if (typeof text !== 'string') return null;
  const bar = text.indexOf('|');
  if (bar < 0) return null;
  const expiresAtMs = Number(text.slice(0, bar)), token = text.slice(bar + 1);
  return Number.isFinite(expiresAtMs) && token ? { token, expiresAtMs } : null;
}

/**
 * POST /api/convai/token: the Worker's version of auth-backend/api/_lib/token-handler.js. The same checks in the same order, the same
 * answers. One call to the STATE Durable Object per request (the admission decision), at most one more to keep a token, and one to
 * Convai when a token has to be minted.
 */
export function createTokenHandler(deps) {
  const { now, fetchImpl } = deps;
  // De-duplicated concurrent mints within one isolate. The token itself is kept in the Durable Object, so every isolate shares it.
  let sharedMint = null;
  const installMints = new Map();
  // Advisory per-isolate flood guard in front of the store, so a hammering client costs no Durable Object request on the isolate it hits.
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

  return async function tokenHandler(request, env) {
    if (request.method !== 'POST') return reply(request, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    const config = readConfig(env);
    // The kill switch answers before anything else is looked at or paid for.
    if (config.paused) {
      return reply(request, 503, { error: 'paused', message: 'The conversation sign-in service is paused. Try again later.' }, { 'Retry-After': '900' });
    }
    const state = deps.stateFor(env);
    if (missingSettings(config, !!state).length) return reply(request, 503, { error: 'unconfigured' });

    let body;
    try {
      body = await readRawBody(request);
    } catch {
      return reply(request, 400, { error: 'bad_request' });
    }
    if (body === null) return reply(request, 413, { error: 'too_large' });
    const nowMs = now();
    const signature = await checkSignature({ secret: config.signingSecret, timestamp: headerValue(request, 'x-convai-timestamp'),
      signature: headerValue(request, 'x-convai-signature'), body, nowMs });
    if (signature === 'stale') return reply(request, 401, { error: 'stale', serverTime: Math.floor(nowMs / 1000) });
    if (signature !== 'ok') return reply(request, 401, { error: 'unauthorized' });

    let request_;
    try {
      request_ = JSON.parse(body);
    } catch {
      request_ = null;
    }
    const turns = request_?.turnsSinceLast ?? 0;
    const minLife = request_?.minLifeSeconds ?? 0;
    if (!request_ || typeof request_ !== 'object' || Array.isArray(request_)
        || typeof request_.installId !== 'string' || !UUID_V4.test(request_.installId)
        || !parseVersion(request_.modVersion)
        || !Number.isSafeInteger(turns) || turns < 0 || turns > MAX_TURNS_PER_REPORT
        || !Number.isSafeInteger(minLife) || minLife < 0 || minLife > 3600) {
      return reply(request, 400, { error: 'bad_request' });
    }

    const installKey = await pseudonym(config.pseudonymSecret, 'install', request_.installId.toLowerCase());
    if (config.blockedInstalls.has(installKey)) return reply(request, 403, { error: 'refused' });
    if (config.minVersion && (compareVersions(request_.modVersion, config.minVersion) ?? 0) < 0) {
      return reply(request, 426, { error: 'outdated', minClient: config.minVersion });
    }

    const ipKey = await pseudonym(config.pseudonymSecret, 'ip', clientAddress(request));
    if (flooded(ipKey)) return reply(request, 429, { error: 'rate', retryAfterSeconds: 60 }, { 'Retry-After': '60' });

    const hour = Math.floor(nowMs / 3_600_000), day = isoDay(nowMs);
    // The bridge renews 8 to 10 minutes before expiry and says so (minLifeSeconds, at most 15 minutes is honoured), so a
    // renewal always returns a token with a fresh life even though the server's own margin is only five minutes.
    const marginMs = Math.max(config.remintMarginSeconds, Math.min(minLife, MAX_MIN_LIFE_SECONDS)) * 1000;
    const perInstall = config.mode === 'per-install';

    let verdict;
    try {
      verdict = await state.admit({ now: nowMs, ipKey, installKey, hour, day, ipPerHour: config.ipPerHour, installPerHour: config.installPerHour,
        newInstallsPerIpPerDay: config.newInstallsPerIpPerDay, dailyTurnCap: config.dailyTurnCap, turns, mode: config.mode, marginMs,
        mintsPerDay: config.mintsPerDay });
    } catch {
      // Fail closed: without the counters nobody gets a token.
      console.error('[convai-auth] store unavailable');
      return reply(request, 503, { error: 'unavailable' }, { 'Retry-After': '30' });
    }
    if (!verdict || typeof verdict.code !== 'string') {
      console.error('[convai-auth] unexpected store answer');
      return reply(request, 503, { error: 'unavailable' }, { 'Retry-After': '30' });
    }
    const { code, extra } = verdict;
    const used = Number(verdict.turns) || 0;
    // The limit in force: the stored value (POST /api/admin/config) when there is one, else the environment's. The admission read it
    // atomically with the count, so the number reported is the number enforced.
    const limit = validCap(verdict.limit) ?? config.dailyTurnCap;
    const allowance = { used, limit, resetAt: new Date(nextUtcMidnight(nowMs)).toISOString() };
    const deliver = ({ token, expiresAtMs }) => reply(request, 200, {
      authToken: token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      allowance,
      dailyInteractionLimit: limit,
      serverTime: Math.floor(nowMs / 1000),
      ...(config.minVersion ? { minClient: config.minVersion } : {}),
    });
    const staleShared = () => {
      const kept = parseKept(verdict.shared);
      return !perInstall && kept && kept.expiresAtMs - STALE_SERVE_MS > nowMs ? kept : null;
    };

    if (code === 'rate_ip' || code === 'rate_install') {
      const retry = Math.max(1, Math.ceil((nextHour(nowMs) - nowMs) / 1000));
      return reply(request, 429, { error: 'rate', retryAfterSeconds: retry }, { 'Retry-After': String(retry) });
    }
    if (code === 'new_install_limit') {
      const retry = Math.max(1, Math.ceil((nextUtcMidnight(nowMs) - nowMs) / 1000));
      return reply(request, 429, { error: 'install_limit', retryAfterSeconds: retry }, { 'Retry-After': String(retry) });
    }
    if (code === 'daily') {
      // Per-install mode: the install's own token is revoked (best effort). A session already running is not ended by this.
      const kept = parseKept(extra);
      if (perInstall && kept) {
        const convai = createConvaiClient({ fetchImpl, connectUrl: config.connectUrl, revokeUrl: config.revokeUrl, now });
        await convai.revoke(config.apiKey, kept.token);
      }
      return reply(request, 429, { error: 'daily', allowance, dailyInteractionLimit: limit, resetAt: allowance.resetAt });
    }

    if (code === 'cached') {
      const kept = parseKept(extra);
      if (kept) return deliver(kept);
    }
    if (code === 'ok') {
      const kept = parseKept(extra);
      if (kept) return deliver(kept);
    }
    if (code === 'busy') {
      // The day's mint budget is spent. A still valid shared token is not a mint, so it can still be handed out.
      const kept = staleShared();
      if (kept) return deliver(kept);
      return reply(request, 503, { error: 'busy', message: 'The service is busy. Try again later.', retryAfterSeconds: 900 }, { 'Retry-After': '900' });
    }
    if (code !== 'mint' && code !== 'ok') return reply(request, 503, { error: 'unavailable' }, { 'Retry-After': '30' });

    // A token has to be minted (or the shared one went stale between the check and now).
    const convai = createConvaiClient({ fetchImpl, connectUrl: config.connectUrl, revokeUrl: config.revokeUrl, now });
    try {
      if (!perInstall) {
        sharedMint ??= convai.mint(config.apiKey).then(async minted => {
          try {
            await state.saveShared({ expiresAtMs: minted.expiresAtMs, token: minted.token });
          } catch {
            console.error('[convai-auth] could not save the shared token');
          }
          return minted;
        }).finally(() => { sharedMint = null; });
        return deliver(await sharedMint);
      }
      let pending = installMints.get(installKey);
      if (!pending) {
        pending = convai.mint(config.apiKey).finally(() => installMints.delete(installKey));
        installMints.set(installKey, pending);
      }
      const minted = await pending;
      try {
        const lifetimeSeconds = Math.max(60, Math.ceil((minted.expiresAtMs - nowMs) / 1000));
        await state.saveToken({ now: nowMs, installKey, expiresAtMs: minted.expiresAtMs, token: minted.token, lifetimeSeconds });
      } catch {
        console.error('[convai-auth] could not save a token');
      }
      return deliver(minted);
    } catch (error) {
      console.error('[convai-auth] mint failed:', error instanceof Error ? error.message : 'unknown failure');
      const kept = staleShared();
      if (kept) return deliver(kept);
      return reply(request, 502, { error: 'convai_unavailable' }, { 'Retry-After': '30' });
    }
  };
}
