import { ENV_NAMES, readConfig, missingSettings } from './config.js';
import { safeEqual } from './crypto.js';
import { headerValue, sendJson } from './http.js';
import { createUpstashStore } from './store.js';

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
      const [rows, active, mints] = await store.pipeline([
        ['ZREVRANGE', `turns:${day}`, '0', String(limit - 1), 'WITHSCORES'],
        ['ZCARD', `turns:${day}`],
        ['GET', `mint:${day}`],
      ]);
      const installs = [];
      for (let index = 0; index + 1 < (rows?.length ?? 0); index += 2) {
        installs.push({ install: String(rows[index]), turns: Number(rows[index + 1]) });
      }
      sendJson(response, 200, {
        day,
        mode: config.mode,
        dailyTurnCap: config.dailyTurnCap,
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
