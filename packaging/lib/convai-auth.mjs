// The sign-in settings a Runtime package ships: app/defaults/convai-auth.json. From 0.2.9 the Runtime carries NO Convai key; the bridge reaches
// the project's shared Convai account with short-lived tokens from the token backend (auth-backend/, bridge/convai-credential.mjs). The file is
//
//   {"version": 1, "enabled": true, "url": "https://<backend>/api/convai/token", "backupUrl": "https://<worker>/api/convai/token", "secret": "<client request secret>", "fallback": false}
//
// `backupUrl` is optional: the second sign-in backend (auth-backend-cf/, Cloudflare Workers), tried when the first cannot be reached (players in Russia and China
// cannot reach Vercel). Same API and the same client secret. Not secret. It comes from CONVAI_AUTH_BACKUP_URL (a repository variable in CI) or --auth-backup-url;
// without it the Runtime has one backend. A value that is set but not a valid address fails the build.
//
// The secret is the backend's client request secret (obfuscation, not authentication: it ships inside the program, auth-backend/README.md). It
// is NOT the error reports' secret: those go to app/defaults/error-reports.json, a file the owner adds to the Runtime by hand and the build never
// writes. Nothing here prints a secret.
export const AUTH_URL_ENV = 'CONVAI_AUTH_URL';
export const AUTH_SECRET_ENV = 'CONVAI_AUTH_CLIENT_SECRET';
export const AUTH_BACKUP_URL_ENV = 'CONVAI_AUTH_BACKUP_URL';
export const AUTH_PATH = '/api/convai/token';
export const AUTH_FILE = 'defaults/convai-auth.json';
const SECRET = /^[\x21-\x7e]{32,512}$/;

/** The validated https address (a string), or throws a plain error that names no secret. */
export function validateAuthUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { throw Error('The sign-in backend address is not a valid URL.'); }
  if (url.protocol !== 'https:') throw Error('The sign-in backend address must be https.');
  if (url.username || url.password || url.search || url.hash) throw Error('The sign-in backend address must have no credentials, query or fragment.');
  if (url.pathname !== AUTH_PATH) throw Error(`The sign-in backend address must end with ${AUTH_PATH}.`);
  return url.href;
}

/** The validated second backend's address (same rules as the first), or '' when none is given. */
export function validateBackupUrl(raw, primary = '') {
  if (!String(raw ?? '').trim()) return '';
  const url = validateAuthUrl(raw);
  if (url === primary) throw Error('The backup sign-in backend address is the same as the first one.');
  return url;
}

/** The validated secret (a string of at least 32 printable characters, no spaces), or throws without showing it. */
export function validateAuthSecret(raw) {
  const secret = String(raw ?? '').trim();
  if (!SECRET.test(secret)) throw Error('The sign-in client secret is too short (at least 32 characters, no spaces) or has an unexpected format (value not shown).');
  return secret;
}

/**
 * The build's sign-in settings from its inputs ({url, secret}, each possibly empty), or null when neither is given and `required` is false.
 * `required` (a non-dry-run build of the Runtime): both must be given. Giving only one is always an error.
 */
export function readAuthInputs({url, secret, backupUrl, required, urlName = AUTH_URL_ENV, secretName = AUTH_SECRET_ENV} = {}) {
  // Only a variable that is meant to hold the client secret may be shipped: a mistyped --auth-secret-env must not publish some other token.
  if (!/^[A-Z0-9_]*CONVAI[A-Z0-9_]*$/.test(String(secretName))) throw Error('--auth-secret-env must name a variable meant for the Convai sign-in client secret (its name contains CONVAI).');
  const hasUrl = !!String(url ?? '').trim(), hasSecret = !!String(secret ?? '').trim();
  if (!hasUrl && !hasSecret) {
    if (required) throw Error(`The Runtime ships no Convai key and needs the sign-in backend: set ${urlName} (--auth-url) and ${secretName} (--auth-secret-env), or build with --dry-run.`);
    return null;
  }
  if (!hasUrl || !hasSecret) throw Error(`The sign-in backend needs both its address (${urlName}) and its client secret (${secretName}).`);
  const checked = validateAuthUrl(url);
  const backup = validateBackupUrl(backupUrl, checked);
  return {url: checked, ...(backup ? {backupUrl: backup} : {}), secret: validateAuthSecret(secret)};
}

/** The settings object the bridge reads (bridge/convai-credential.mjs readAuthSettings): on, and never falling back to a key. */
export const packagedAuthSettings = ({url, backupUrl, secret}) => ({version: 1, enabled: true, url, ...(backupUrl ? {backupUrl} : {}), secret, fallback: false});

/** Adds app/defaults/convai-auth.json to `pkg` (anything with json(name, value), like the builder's package object). */
export function addPackagedAuth(pkg, app, auth) {
  pkg.json(`${app}/${AUTH_FILE}`, packagedAuthSettings(auth));
}

// A key of any shape: the files a release must not carry (the Runtime ships no Convai key from 0.2.9; the key was defaults/service.txt before).
export const SHIPPED_KEY_FILE = /(?:^|\/)(?:service\.txt|convai-key\.txt)$/i;
const KEY_LINE = /(?:api-key\s*=\s*\S{8,}|convai-key-v1\s+[A-Za-z0-9_-]{24,})/i;
/** True when text carries a Convai key line (a plain api-key=... line or a packed key). */
export const hasKeyLine = text => KEY_LINE.test(String(text));
