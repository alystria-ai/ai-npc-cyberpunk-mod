// The Worker's router: the same paths as the Vercel service. Nothing here imports `cloudflare:workers`, so the tests can run it in node.
import { createAdminConfigHandler, createAdminTurnsHandler, createReadyHandler, healthHandler } from './admin.js';
import { createAdminErrorsHandler, createErrorReportHandler } from './errors.js';
import { reply } from './http.js';
import { createPlansHandler } from './plans.js';
import { createTokenHandler } from './token.js';

const stubOf = (namespace, name, hint) => {
  if (!namespace || typeof namespace.idFromName !== 'function') return null;
  return namespace.get(namespace.idFromName(name), hint ? { locationHint: hint } : undefined);
};

/**
 * `options`: now (clock), fetchImpl (Convai), stateFor(env) and errorsFor(env) (the Durable Object stubs; the tests give fakes).
 * Returns `handle(request, env)`, which answers with a Response.
 */
export function createApp(options = {}) {
  const deps = {
    now: options.now ?? Date.now,
    fetchImpl: options.fetchImpl ?? ((...args) => fetch(...args)),
    cacheMs: options.cacheMs,
    maxSignatures: options.maxSignatures,
    stateFor: options.stateFor ?? (env => stubOf(env.STATE, 'main', String(env.STATE_LOCATION_HINT ?? '').trim())),
    errorsFor: options.errorsFor ?? (env => stubOf(env.ERRORS, 'main', String(env.STATE_LOCATION_HINT ?? '').trim())),
  };
  const routes = new Map([
    ['/api/convai/token', createTokenHandler(deps)],
    ['/api/convai/plans', createPlansHandler(deps)],
    ['/api/errors/report', createErrorReportHandler(deps)],
    ['/api/admin/turns', createAdminTurnsHandler(deps)],
    ['/api/admin/config', createAdminConfigHandler(deps)],
    ['/api/admin/errors', createAdminErrorsHandler(deps)],
    ['/api/readyz', createReadyHandler(deps)],
    ['/api/healthz', healthHandler],
  ]);
  return async function handle(request, env) {
    let path;
    try {
      path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    } catch {
      return reply(request, 400, { error: 'bad_request' });
    }
    const route = routes.get(path);
    if (!route) return reply(request, 404, { error: 'not_found' });
    try {
      return await route(request, env);
    } catch (error) {
      console.error('[convai-auth] unhandled:', error instanceof Error ? error.name : 'error');
      return reply(request, 500, { error: 'internal' });
    }
  };
}
