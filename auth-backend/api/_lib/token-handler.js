import { ADMIT_SCRIPT } from './admit.js';
import { readConfig, missingSettings } from './config.js';
import { createConvaiClient } from './convai.js';
import { checkSignature, pseudonym } from './crypto.js';
import { clientAddress, headerValue, readRawBody, sendJson } from './http.js';
import { createUpstashStore } from './store.js';
import { compareVersions, parseVersion } from './version.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TURNS_PER_REPORT = 1000;
const PREFILTER_PER_MINUTE = 60;
const STALE_SERVE_MS = 60_000;

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const nextUtcMidnight = ms => Math.floor(ms / 86_400_000 + 1) * 86_400_000;
const nextHour = ms => Math.floor(ms / 3_600_000 + 1) * 3_600_000;

/**
 * POST /api/convai/token. One call per token request to the store (a single script), at most one more to save a
 * per-install token, and one to Convai when a token has to be minted.
 *
 * Request: body {installId, modVersion, turnsSinceLast}, headers x-convai-timestamp (whole seconds) and
 * x-convai-signature (v1=HMAC-SHA256 over "<timestamp>.<body>"). See README.md for what each check does and does not stop.
 */
export function createTokenHandler(options = {}) {
  const getEnv = () => options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
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

  // One Convai token per warm instance (shared mode), and de-duplicated concurrent mints.
  let sharedToken = null, sharedMint = null;
  const installMints = new Map();
  // Advisory per-instance flood guard in front of the store, so a hammering client costs no Redis commands on the
  // instance it hits. The store's counters are the real limits; this one is not shared between instances.
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

  async function mintOnce(convai, config, remember) {
    const minted = await convai.mint(config.apiKey);
    remember?.(minted);
    return minted;
  }

  return async function tokenHandler(request, response) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'POST' });
      return;
    }
    const config = readConfig(getEnv());
    // The kill switch answers before anything else is looked at or paid for.
    if (config.paused) {
      sendJson(response, 503, { error: 'paused', message: 'The conversation sign-in service is paused. Try again later.' },
        { 'Retry-After': '900' });
      return;
    }
    if (missingSettings(config).length) {
      sendJson(response, 503, { error: 'unconfigured' });
      return;
    }

    const body = await readRawBody(request);
    if (body === null) {
      sendJson(response, 413, { error: 'too_large' });
      return;
    }
    const nowMs = now();
    const signature = checkSignature({ secret: config.signingSecret, timestamp: headerValue(request, 'x-convai-timestamp'),
      signature: headerValue(request, 'x-convai-signature'), body, nowMs });
    if (signature === 'stale') {
      sendJson(response, 401, { error: 'stale', serverTime: Math.floor(nowMs / 1000) });
      return;
    }
    if (signature !== 'ok') {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }

    let request_;
    try {
      request_ = JSON.parse(body);
    } catch {
      request_ = null;
    }
    const turns = request_?.turnsSinceLast ?? 0;
    if (!request_ || typeof request_ !== 'object' || Array.isArray(request_)
        || typeof request_.installId !== 'string' || !UUID_V4.test(request_.installId)
        || !parseVersion(request_.modVersion)
        || !Number.isSafeInteger(turns) || turns < 0 || turns > MAX_TURNS_PER_REPORT) {
      sendJson(response, 400, { error: 'bad_request' });
      return;
    }

    const installKey = pseudonym(config.signingSecret, 'install', request_.installId.toLowerCase());
    if (config.blockedInstalls.has(installKey)) {
      sendJson(response, 403, { error: 'refused' });
      return;
    }
    if (config.minVersion && (compareVersions(request_.modVersion, config.minVersion) ?? 0) < 0) {
      sendJson(response, 426, { error: 'outdated', minClient: config.minVersion });
      return;
    }

    const ipKey = pseudonym(config.signingSecret, 'ip', clientAddress(request));
    if (flooded(ipKey)) {
      sendJson(response, 429, { error: 'rate', retryAfterSeconds: 60 }, { 'Retry-After': '60' });
      return;
    }

    const hour = Math.floor(nowMs / 3_600_000), day = isoDay(nowMs);
    const marginMs = config.remintMarginSeconds * 1000;
    const perInstall = config.mode === 'per-install';
    const sharedFresh = !!sharedToken && sharedToken.expiresAtMs - marginMs > nowMs;
    const keys = [`ip:${ipKey}:${hour}`, `in:${installKey}:${hour}`, `seen:${installKey}`, `ipnew:${ipKey}:${day}`,
      `turns:${day}`, `mint:${day}`, `tok:${installKey}`];
    const args = [config.ipPerHour, config.installPerHour, config.newInstallsPerIpPerDay, config.dailyTurnCap, turns, installKey,
      config.mode, sharedFresh ? '0' : '1', config.mintsPerDay, nowMs, marginMs];

    let store, verdict;
    try {
      store = storeFor(config);
      verdict = await store.evalScript(ADMIT_SCRIPT, keys, args);
    } catch {
      // Fail closed: without the counters nobody gets a token.
      console.error('[convai-auth] store unavailable');
      sendJson(response, 503, { error: 'unavailable' }, { 'Retry-After': '30' });
      return;
    }
    if (!Array.isArray(verdict) || typeof verdict[0] !== 'string') {
      console.error('[convai-auth] unexpected store answer');
      sendJson(response, 503, { error: 'unavailable' }, { 'Retry-After': '30' });
      return;
    }
    const [code, turnsRaw, extra] = verdict;
    const used = Number(turnsRaw) || 0;
    const allowance = { used, limit: config.dailyTurnCap, resetAt: new Date(nextUtcMidnight(nowMs)).toISOString() };
    const deliver = ({ token, expiresAtMs }) => sendJson(response, 200, {
      authToken: token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      allowance,
      serverTime: Math.floor(nowMs / 1000),
      ...(config.minVersion ? { minClient: config.minVersion } : {}),
    });

    if (code === 'rate_ip' || code === 'rate_install') {
      const retry = Math.max(1, Math.ceil((nextHour(nowMs) - nowMs) / 1000));
      sendJson(response, 429, { error: 'rate', retryAfterSeconds: retry }, { 'Retry-After': String(retry) });
      return;
    }
    if (code === 'new_install_limit') {
      const retry = Math.max(1, Math.ceil((nextUtcMidnight(nowMs) - nowMs) / 1000));
      sendJson(response, 429, { error: 'install_limit', retryAfterSeconds: retry }, { 'Retry-After': String(retry) });
      return;
    }
    if (code === 'daily') {
      // Per-install mode: the install's own token is revoked (best effort). A session already running is not ended by this.
      if (perInstall && typeof extra === 'string' && extra.includes('|')) {
        const convai = createConvaiClient({ fetchImpl, connectUrl: config.connectUrl, revokeUrl: config.revokeUrl, now });
        await convai.revoke(config.apiKey, extra.slice(extra.indexOf('|') + 1));
      }
      sendJson(response, 429, { error: 'daily', allowance, resetAt: allowance.resetAt });
      return;
    }

    if (code === 'cached' && typeof extra === 'string' && extra.includes('|')) {
      deliver({ token: extra.slice(extra.indexOf('|') + 1), expiresAtMs: Number(extra.slice(0, extra.indexOf('|'))) });
      return;
    }
    if (code === 'ok' && sharedToken) {
      deliver(sharedToken);
      return;
    }
    if (code === 'busy') {
      // The day's mint budget is spent. A still valid shared token is not a mint, so it can still be handed out.
      if (!perInstall && sharedToken && sharedToken.expiresAtMs - STALE_SERVE_MS > nowMs) {
        deliver(sharedToken);
        return;
      }
      sendJson(response, 503, { error: 'busy', message: 'The service is busy. Try again later.', retryAfterSeconds: 900 },
        { 'Retry-After': '900' });
      return;
    }
    if (code !== 'mint' && code !== 'ok') {
      sendJson(response, 503, { error: 'unavailable' }, { 'Retry-After': '30' });
      return;
    }

    // A token has to be minted (or the shared one went stale between the check and now).
    const convai = createConvaiClient({ fetchImpl, connectUrl: config.connectUrl, revokeUrl: config.revokeUrl, now });
    try {
      if (!perInstall) {
        sharedMint ??= mintOnce(convai, config, minted => { sharedToken = minted; }).finally(() => { sharedMint = null; });
        deliver(await sharedMint);
        return;
      }
      let pending = installMints.get(installKey);
      if (!pending) {
        pending = mintOnce(convai, config).finally(() => installMints.delete(installKey));
        installMints.set(installKey, pending);
      }
      const minted = await pending;
      try {
        const lifetime = Math.max(60, Math.ceil((minted.expiresAtMs - nowMs) / 1000));
        await store.command(['SET', keys[6], `${minted.expiresAtMs}|${minted.token}`, 'EX', String(lifetime)]);
      } catch {
        console.error('[convai-auth] could not save a token');
      }
      deliver(minted);
    } catch (error) {
      console.error('[convai-auth] mint failed:', error instanceof Error ? error.message : 'unknown failure');
      if (!perInstall && sharedToken && sharedToken.expiresAtMs - STALE_SERVE_MS > nowMs) {
        deliver(sharedToken);
        return;
      }
      sendJson(response, 502, { error: 'convai_unavailable' }, { 'Retry-After': '30' });
    }
  };
}
