// Every setting comes from an environment variable and is read on each request, so changing one in the Vercel
// dashboard or CLI takes effect on the next deployment without any code change.
const toInteger = (raw, fallback, { min = 0, max = 1_000_000 } = {}) => {
  const text = String(raw ?? '').trim();
  if (!/^\d{1,9}$/.test(text)) return fallback;
  return Math.min(max, Math.max(min, Number(text)));
};
const truthy = raw => ['1', 'true', 'yes', 'on'].includes(String(raw ?? '').trim().toLowerCase());
const text = raw => String(raw ?? '').trim();

export const DEFAULTS = Object.freeze({
  installPerHour: 4,
  ipPerHour: 20,
  newInstallsPerIpPerDay: 5,
  mintsPerDay: 500,
  dailyTurnCap: 100,
  remintMarginSeconds: 300,
});

/** Names of every variable the service reads, for the readiness report. Values are never reported. */
export const ENV_NAMES = Object.freeze([
  'CONVAI_API_KEY',
  'CONVAI_AUTH_SIGNING_SECRET',
  'CONVAI_AUTH_ADMIN_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
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
]);

export function readConfig(env = process.env) {
  const mode = text(env.CONVAI_AUTH_MODE).toLowerCase() === 'per-install' ? 'per-install' : 'shared';
  return {
    apiKey: text(env.CONVAI_API_KEY),
    signingSecret: text(env.CONVAI_AUTH_SIGNING_SECRET),
    adminSecret: text(env.CONVAI_AUTH_ADMIN_SECRET),
    storeUrl: text(env.UPSTASH_REDIS_REST_URL) || text(env.KV_REST_API_URL),
    storeToken: text(env.UPSTASH_REDIS_REST_TOKEN) || text(env.KV_REST_API_TOKEN),
    paused: truthy(env.CONVAI_AUTH_PAUSED),
    minVersion: text(env.CONVAI_AUTH_MIN_VERSION),
    mode,
    installPerHour: toInteger(env.CONVAI_AUTH_INSTALL_PER_HOUR, DEFAULTS.installPerHour, { min: 1 }),
    ipPerHour: toInteger(env.CONVAI_AUTH_IP_PER_HOUR, DEFAULTS.ipPerHour, { min: 1 }),
    newInstallsPerIpPerDay: toInteger(env.CONVAI_AUTH_NEW_INSTALLS_PER_IP_PER_DAY, DEFAULTS.newInstallsPerIpPerDay, { min: 1 }),
    mintsPerDay: toInteger(env.CONVAI_AUTH_MINTS_PER_DAY, DEFAULTS.mintsPerDay, { min: 1 }),
    dailyTurnCap: toInteger(env.CONVAI_AUTH_DAILY_TURN_CAP, DEFAULTS.dailyTurnCap, { min: 1 }),
    remintMarginSeconds: toInteger(env.CONVAI_AUTH_REMINT_MARGIN_SECONDS, DEFAULTS.remintMarginSeconds, { min: 30, max: 3000 }),
    blockedInstalls: new Set(text(env.CONVAI_AUTH_BLOCKED_INSTALLS).split(/[\s,]+/).filter(Boolean)),
    connectUrl: text(env.CONVAI_CONNECT_URL) || 'https://api.convai.com/user/connect',
    revokeUrl: text(env.CONVAI_REVOKE_URL) || 'https://api.convai.com/user/revoke-token',
  };
}

/** What is missing for the token endpoint to work, as a list of short names (empty when ready). */
export function missingSettings(config) {
  const missing = [];
  if (!config.apiKey) missing.push('CONVAI_API_KEY');
  if (config.signingSecret.length < 32) missing.push('CONVAI_AUTH_SIGNING_SECRET');
  if (!config.storeUrl || !config.storeToken) missing.push('UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN');
  return missing;
}
