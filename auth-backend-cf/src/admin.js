import { CAP_BOUNDS, ENV_NAMES, readConfig, missingSettings, validCap } from './config.js';
import { authorised } from './errors.js';
import { queryOf, readRawBody, reply } from './http.js';
import { storedPaidPlans, validPaidPlans } from './plans.js';

const text = value => String(value ?? '').trim();
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/admin/turns?day=YYYY-MM-DD&limit=50 with `Authorization: Bearer <CONVAI_AUTH_ADMIN_SECRET>`. */
export function createAdminTurnsHandler(deps) {
  const { now } = deps;
  return async function adminTurnsHandler(request, env) {
    if (request.method !== 'GET') return reply(request, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const config = readConfig(env);
    if (config.adminSecret.length < 32) return reply(request, 404, { error: 'not_found' });
    if (!authorised(request, config)) return reply(request, 401, { error: 'unauthorized' });
    const query = queryOf(request);
    const day = DAY.test(query.get('day') ?? '') ? query.get('day') : new Date(now()).toISOString().slice(0, 10);
    const limit = Math.min(200, Math.max(1, Number.parseInt(query.get('limit') ?? '50', 10) || 50));
    try {
      const state = deps.stateFor(env);
      const [report, stored] = await Promise.all([state.turns({ day, limit }), state.getConfig()]);
      return reply(request, 200, {
        day,
        mode: config.mode,
        dailyTurnCap: stored.cap ?? config.dailyTurnCap,
        installsReporting: report.installsReporting,
        tokenMintsAttempted: report.tokenMintsAttempted,
        top: report.top,
        note: 'install is a keyed hash of the install id; add it to CONVAI_AUTH_BLOCKED_INSTALLS to refuse that install.',
      });
    } catch {
      return reply(request, 503, { error: 'unavailable' });
    }
  };
}

/**
 * The per-install daily limit and the Convai paid tier's plan list, changed at run time (the same calls as auth-backend; this server
 * keeps its own copy, so a change has to be made on both servers). Both need `Authorization: Bearer <CONVAI_AUTH_ADMIN_SECRET>`.
 *   GET  /api/admin/config
 *   POST /api/admin/config  {"dailyInteractionLimit": 150 | null}   and/or   {"paidPlans": {"plans": [...]} | null}
 */
export function createAdminConfigHandler(deps) {
  return async function adminConfigHandler(request, env) {
    if (request.method !== 'GET' && request.method !== 'POST') return reply(request, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
    const config = readConfig(env);
    if (config.adminSecret.length < 32) return reply(request, 404, { error: 'not_found' });
    if (!authorised(request, config)) return reply(request, 401, { error: 'unauthorized' });
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
        return reply(request, 400, { error: 'bad_request', message: 'Send {"dailyInteractionLimit": <whole number> | null} and/or {"paidPlans": {"plans": [...]} | null}.' });
      }
      if ('dailyInteractionLimit' in parsed) {
        change = parsed.dailyInteractionLimit === null ? null : validCap(parsed.dailyInteractionLimit);
        if (change === null && parsed.dailyInteractionLimit !== null) {
          return reply(request, 400, { error: 'out_of_range', min: CAP_BOUNDS.min, max: CAP_BOUNDS.max });
        }
      }
      if ('paidPlans' in parsed) {
        plansChange = parsed.paidPlans === null ? null : validPaidPlans(parsed.paidPlans);
        if (plansChange === null && parsed.paidPlans !== null) {
          return reply(request, 400, { error: 'bad_plans', message: '1 to 8 plans, each {id, name, period: monthly|yearly, price, priceId: price_...}, ids and price ids unique; addresses https on convai.com.' });
        }
      }
    }
    try {
      const state = deps.stateFor(env);
      const stored = await state.setConfig({ cap: change, plans: plansChange === undefined ? undefined : plansChange === null ? null : JSON.stringify(plansChange) });
      return reply(request, 200, {
        dailyInteractionLimit: stored.cap ?? config.dailyTurnCap,
        stored: stored.cap,
        environmentDefault: config.dailyTurnCap,
        min: CAP_BOUNDS.min,
        max: CAP_BOUNDS.max,
        paidPlans: storedPaidPlans(stored.plans),
      });
    } catch {
      return reply(request, 503, { error: 'unavailable' });
    }
  };
}

/** GET /api/readyz: only booleans for which variables are set. `?ping=1` with the admin secret adds one round trip to each store. */
export function createReadyHandler(deps) {
  return async function readyHandler(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply(request, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
    const config = readConfig(env);
    const state = deps.stateFor(env), errors = deps.errorsFor(env);
    const missing = missingSettings(config, !!state);
    const body = {
      status: missing.length ? 'not_ready' : 'ready',
      mode: config.mode,
      paused: config.paused,
      env: Object.fromEntries(ENV_NAMES.map(name => [name, text(env[name]) !== ''])),
      // True only when the token signing, error report and hashing secrets are all set and all different (never reports a value).
      secretsSeparate: new Set([config.signingSecret, text(env.ERROR_REPORT_SECRET), text(env.CONVAI_AUTH_PSEUDONYM_SECRET)]).size === 3
        && [config.signingSecret, text(env.ERROR_REPORT_SECRET), text(env.CONVAI_AUTH_PSEUDONYM_SECRET)].every(value => value.length >= 32),
    };
    // The stores are only touched on request, by the holder of the admin secret, so the public can never spend requests here.
    if (!missing.length && queryOf(request).get('ping') === '1' && authorised(request, config)) {
      try {
        const answers = await Promise.all([state.ping(), errors ? errors.ping() : 'PONG']);
        body.store = answers.every(answer => answer === 'PONG') ? 'ok' : 'unexpected';
      } catch {
        body.store = 'unreachable';
      }
    }
    return reply(request, missing.length || body.store === 'unreachable' ? 503 : 200, body);
  };
}

export function healthHandler(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return reply(request, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
  // Never touches a store or Convai.
  return reply(request, 200, { status: 'ok' });
}
