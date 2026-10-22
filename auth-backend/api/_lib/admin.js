import { CAP_BOUNDS, CAP_KEY, ENV_NAMES, readConfig, missingSettings, validCap } from './config.js';
import { safeEqual } from './crypto.js';
import { headerValue, readRawBody, sendJson } from './http.js';
import { createUpstashStore } from './store.js';
import { PLANS_KEY, storedPaidPlans, validPaidPlans } from './plans.js';

const text = value => String(value ?? '').trim();

const DAY = /^\d{4}-\d{2}-\d{2}$/;

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

/** GET /api/admin/turns?day=YYYY-MM-DD&limit=50 with `Authorization: Bearer <CONVAI_AUTH_ADMIN_SECRET>`. */
export function createAdminTurnsHandler(options = {}) {
  const getEnv = () => options.env ?? process.env;
  const now = options.now ?? Date.now;
  return async function adminTurnsHandler(request, response) {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
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
    const day = DAY.test(query.get('day') ?? '') ? query.get('day') : new Date(now()).toISOString().slice(0, 10);
    const limit = Math.min(200, Math.max(1, Number.parseInt(query.get('limit') ?? '50', 10) || 50));
    try {
      const store = options.store ?? createUpstashStore({ url: config.storeUrl, token: config.storeToken, fetchImpl: options.fetchImpl ?? fetch });
      const [rows, active, mints, stored] = await store.pipeline([
        ['ZREVRANGE', `turns:${day}`, '0', String(limit - 1), 'WITHSCORES'],
        ['ZCARD', `turns:${day}`],
        ['GET', `mint:${day}`],
        ['GET', CAP_KEY],
      ]);
      const installs = [];
      for (let index = 0; index + 1 < (rows?.length ?? 0); index += 2) {
        installs.push({ install: String(rows[index]), turns: Number(rows[index + 1]) });
      }
      sendJson(response, 200, {
        day,
        mode: config.mode,
        dailyTurnCap: validCap(stored) ?? config.dailyTurnCap,
        installsReporting: Number(active) || 0,
        tokenMintsAttempted: Number(mints) || 0,
        top: installs,
        note: 'install is a keyed hash of the install id; add it to CONVAI_AUTH_BLOCKED_INSTALLS to refuse that install.',
      });
    } catch {
      sendJson(response, 503, { error: 'unavailable' });
    }
  };
}

/**
 * The per-install daily limit and the Convai paid tier's plan list, changed at run time. Both need
 * `Authorization: Bearer <CONVAI_AUTH_ADMIN_SECRET>`.
 *   GET  /api/admin/config                                  what is in force (one pipelined request, two Redis commands)
 *   POST /api/admin/config  {"dailyInteractionLimit": 150}  store a new limit (1 to 10000); {"dailyInteractionLimit": null} removes it,
 *                                                           so the CONVAI_AUTH_DAILY_TURN_CAP value (default 100) applies again
 *   POST /api/admin/config  {"paidPlans": {"plans": [...]}} store the paid tier's plans (plans.js says what is accepted); null removes
 *                                                           them, so the list built into the mod applies again. Both keys may be sent together.
 * The token endpoint reads the stored value inside its admission script, so the change applies from the next token request and no
 * redeploy is needed. Players' bridges learn it with their next token (within about 50 minutes) and keep the last value they were told.
 */
export function createAdminConfigHandler(options = {}) {
  const getEnv = () => options.env ?? process.env;
  return async function adminConfigHandler(request, response) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
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
    let change; // undefined: no change, null: remove, number: set
    let plansChange; // undefined: no change, null: remove, object: set
    if (request.method === 'POST') {
      let raw;
      try {
        raw = await readRawBody(request, 8192);
      } catch { /* the stream failed while being read: reported below as an unreadable body */ }
      let parsed = null;
      try { parsed = JSON.parse(raw ?? ''); } catch { /* reported below */ }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('dailyInteractionLimit' in parsed || 'paidPlans' in parsed)) {
        sendJson(response, 400, { error: 'bad_request', message: 'Send {"dailyInteractionLimit": <whole number> | null} and/or {"paidPlans": {"plans": [...]} | null}.' });
        return;
      }
      if ('dailyInteractionLimit' in parsed) {
        change = parsed.dailyInteractionLimit === null ? null : validCap(parsed.dailyInteractionLimit);
        if (change === null && parsed.dailyInteractionLimit !== null) {
          sendJson(response, 400, { error: 'out_of_range', min: CAP_BOUNDS.min, max: CAP_BOUNDS.max });
          return;
        }
      }
      if ('paidPlans' in parsed) {
        plansChange = parsed.paidPlans === null ? null : validPaidPlans(parsed.paidPlans);
        if (plansChange === null && parsed.paidPlans !== null) {
          sendJson(response, 400, { error: 'bad_plans', message: '1 to 8 plans, each {id, name, period: monthly|yearly, price, priceId: price_...}, ids and price ids unique; addresses https on convai.com.' });
          return;
        }
      }
    }
    try {
      const store = options.store ?? createUpstashStore({ url: config.storeUrl, token: config.storeToken, fetchImpl: options.fetchImpl ?? fetch });
      if (change === null) await store.command(['DEL', CAP_KEY]);
      else if (change !== undefined) await store.command(['SET', CAP_KEY, String(change)]);
      if (plansChange === null) await store.command(['DEL', PLANS_KEY]);
      else if (plansChange !== undefined) await store.command(['SET', PLANS_KEY, JSON.stringify(plansChange)]);
      const [cap, plans] = await store.pipeline([['GET', CAP_KEY], ['GET', PLANS_KEY]]);
      const stored = validCap(cap);
      sendJson(response, 200, {
        dailyInteractionLimit: stored ?? config.dailyTurnCap,
        stored,
        environmentDefault: config.dailyTurnCap,
        min: CAP_BOUNDS.min,
        max: CAP_BOUNDS.max,
        paidPlans: storedPaidPlans(plans),
      });
    } catch {
      sendJson(response, 503, { error: 'unavailable' });
    }
  };
}

/** GET /api/readyz: only booleans for which variables are set. `?ping=1` with the admin secret adds one PING. */
export function createReadyHandler(options = {}) {
  const getEnv = () => options.env ?? process.env;
  return async function readyHandler(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      return;
    }
    const env = getEnv();
    const config = readConfig(env);
    const missing = missingSettings(config);
    const body = {
      status: missing.length ? 'not_ready' : 'ready',
      mode: config.mode,
      paused: config.paused,
      env: Object.fromEntries(ENV_NAMES.map(name => [name, String(env[name] ?? '').trim() !== ''])),
      // True only when the token signing, error report and hashing secrets are all set and all different (never reports a value).
      secretsSeparate: new Set([config.signingSecret, text(env.ERROR_REPORT_SECRET), text(env.CONVAI_AUTH_PSEUDONYM_SECRET)]).size === 3
        && [config.signingSecret, text(env.ERROR_REPORT_SECRET), text(env.CONVAI_AUTH_PSEUDONYM_SECRET)].every(value => value.length >= 32),
    };
    // The store is only touched on request, by the holder of the admin secret, so the public can never spend Redis commands here.
    if (!missing.length && queryOf(request).get('ping') === '1' && authorised(request, config)) {
      try {
        const store = options.store ?? createUpstashStore({ url: config.storeUrl, token: config.storeToken, fetchImpl: options.fetchImpl ?? fetch });
        body.store = (await store.command(['PING'])) === 'PONG' ? 'ok' : 'unexpected';
      } catch {
        body.store = 'unreachable';
      }
    }
    sendJson(response, missing.length || body.store === 'unreachable' ? 503 : 200, body);
  };
}

export function healthHandler(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
    return;
  }
  // Never touches the store or Convai.
  sendJson(response, 200, { status: 'ok' });
}
