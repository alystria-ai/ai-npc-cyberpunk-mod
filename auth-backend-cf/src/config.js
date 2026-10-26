// Every setting comes from the Worker's environment (wrangler.toml [vars] and `wrangler secret put`), read on each request. The
// names, defaults and limits are those of auth-backend/api/_lib/config.js, so the two servers are set up the same way.
const toInteger = (raw, fallback, { min = 0, max = 1_000_000 } = {}) => {
  const text = String(raw ?? '').trim();
  if (!/^\d{1,9}$/.test(text)) return fallback;
  return Math.min(max, Math.max(min, Number(text)));
};
const truthy = raw => ['1', 'true', 'yes', 'on'].includes(String(raw ?? '').trim().toLowerCase());
const text = raw => String(raw ?? '').trim();

export const DEFAULTS = Object.freeze({
  installPerHour: 12,
  ipPerHour: 60,
  newInstallsPerIpPerDay: 5,
  mintsPerDay: 500,
  dailyTurnCap: 100,
  remintMarginSeconds: 300,
  // Error reports (errors.js)
  errorInstallPerDay: 40,
  errorIpPerHour: 30,
  errorStorePerDay: 300,
  errorSamples: 10,
  errorTtlDays: 30,
});

/** The per-install daily limit can be changed at run time (POST /api/admin/config, stored under CAP_KEY). Same bounds as on Vercel. */
export const CAP_KEY = 'cfg:dailyInteractionLimit';
export const CAP_BOUNDS = Object.freeze({ min: 1, max: 10_000 });
export const validCap = value => {
  const number = typeof value === 'string' && /^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : value;
  return Number.isSafeInteger(number) && number >= CAP_BOUNDS.min && number <= CAP_BOUNDS.max ? number : null;
};

/** Names of every variable the service reads, for the readiness report. Values are never reported. */
export const ENV_NAMES = Object.freeze([
  'CONVAI_API_KEY',
  'CONVAI_AUTH_SIGNING_SECRET',
  'CONVAI_AUTH_ADMIN_SECRET',
  'CONVAI_AUTH_PSEUDONYM_SECRET',
  'ERROR_REPORT_SECRET',
  'CONVAI_AUTH_PAUSED',
  'CONVAI_AUTH_MIN_VERSION',
  'CONVAI_AUTH_MODE',
  'CONVAI_AUTH_INSTALL_PER_HOUR',
  'CONVAI_AUTH_IP_PER_HOUR',
  'CONVAI_AUTH_NEW_INSTALLS_PER_IP_PER_DAY',
  'CONVAI_AUTH_MINTS_PER_DAY',
  'CONVAI_AUTH_DAILY_TURN_CAP',
  'CONVAI_AUTH_REMINT_MARGIN_SECONDS',
  'CONVAI_AUTH_BLOCKED_INSTALLS',
  'ERROR_REPORTS_OFF',
  'ERROR_REPORTS_INSTALL_PER_DAY',
  'ERROR_REPORTS_IP_PER_HOUR',
  'ERROR_REPORTS_STORE_PER_DAY',
  'ERROR_REPORTS_SAMPLES',
  'ERROR_REPORTS_TTL_DAYS',
]);

export function readConfig(env = {}) {
  const mode = text(env.CONVAI_AUTH_MODE).toLowerCase() === 'per-install' ? 'per-install' : 'shared';
  return {
    apiKey: text(env.CONVAI_API_KEY),
    signingSecret: text(env.CONVAI_AUTH_SIGNING_SECRET),
    adminSecret: text(env.CONVAI_AUTH_ADMIN_SECRET),
    // Three separate secrets, as on Vercel (docs/CONVAI_AUTH_BACKEND.md). An unset report or pseudonym secret falls back to the signing secret.
    reportSecret: text(env.ERROR_REPORT_SECRET) || text(env.CONVAI_AUTH_SIGNING_SECRET),
    pseudonymSecret: text(env.CONVAI_AUTH_PSEUDONYM_SECRET) || text(env.CONVAI_AUTH_SIGNING_SECRET),
    paused: truthy(env.CONVAI_AUTH_PAUSED),
    minVersion: text(env.CONVAI_AUTH_MIN_VERSION),
    mode,
    installPerHour: toInteger(env.CONVAI_AUTH_INSTALL_PER_HOUR, DEFAULTS.installPerHour, { min: 1 }),
    ipPerHour: toInteger(env.CONVAI_AUTH_IP_PER_HOUR, DEFAULTS.ipPerHour, { min: 1 }),
    newInstallsPerIpPerDay: toInteger(env.CONVAI_AUTH_NEW_INSTALLS_PER_IP_PER_DAY, DEFAULTS.newInstallsPerIpPerDay, { min: 1 }),
    mintsPerDay: toInteger(env.CONVAI_AUTH_MINTS_PER_DAY, DEFAULTS.mintsPerDay, { min: 1 }),
    dailyTurnCap: toInteger(env.CONVAI_AUTH_DAILY_TURN_CAP, DEFAULTS.dailyTurnCap, { min: CAP_BOUNDS.min, max: CAP_BOUNDS.max }),
    remintMarginSeconds: toInteger(env.CONVAI_AUTH_REMINT_MARGIN_SECONDS, DEFAULTS.remintMarginSeconds, { min: 30, max: 3000 }),
    errorReportsOff: truthy(env.ERROR_REPORTS_OFF),
    errorInstallPerDay: toInteger(env.ERROR_REPORTS_INSTALL_PER_DAY, DEFAULTS.errorInstallPerDay, { min: 1 }),
    errorIpPerHour: toInteger(env.ERROR_REPORTS_IP_PER_HOUR, DEFAULTS.errorIpPerHour, { min: 1 }),
    // 0 is allowed: every report is then only counted in the index and no body is kept.
    errorStorePerDay: toInteger(env.ERROR_REPORTS_STORE_PER_DAY, DEFAULTS.errorStorePerDay, { min: 0 }),
    errorSamples: toInteger(env.ERROR_REPORTS_SAMPLES, DEFAULTS.errorSamples, { min: 1, max: 100 }),
    errorTtlDays: toInteger(env.ERROR_REPORTS_TTL_DAYS, DEFAULTS.errorTtlDays, { min: 1, max: 90 }),
    blockedInstalls: new Set(text(env.CONVAI_AUTH_BLOCKED_INSTALLS).split(/[\s,]+/).filter(Boolean)),
    connectUrl: text(env.CONVAI_CONNECT_URL) || 'https://api.convai.com/user/connect',
    revokeUrl: text(env.CONVAI_REVOKE_URL) || 'https://api.convai.com/user/revoke-token',
  };
}

/** What is missing for the token endpoint to work, as a list of short names (empty when ready). `hasStore`: the STATE binding exists. */
export function missingSettings(config, hasStore) {
  const missing = [];
  if (!config.apiKey) missing.push('CONVAI_API_KEY');
  if (config.signingSecret.length < 32) missing.push('CONVAI_AUTH_SIGNING_SECRET');
  if (!hasStore) missing.push('STATE');
  return missing;
}

/** What is missing for the error-report endpoint to work (it does not need the Convai key). `hasStore`: the ERRORS binding exists. */
export function missingErrorReportSettings(config, hasStore) {
  const missing = [];
  if (config.reportSecret.length < 32) missing.push('ERROR_REPORT_SECRET');
  if (!hasStore) missing.push('ERRORS');
  return missing;
}
