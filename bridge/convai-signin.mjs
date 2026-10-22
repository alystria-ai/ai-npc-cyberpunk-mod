// Sign in with Convai (docs/CONVAI_PAID_TIER.md, "Sign in with Convai"): the player signs in on Convai's own login page in the system
// browser and the page hands the player's Convai API key back to this bridge, so the key does not have to be copied and pasted.
//
// It uses the desktop flow Convai's login page already has for its Unreal Engine plugin (Conv-AI/Convai-UnrealEngine-Auth, and the
// login page's AuthHandler in Conv-AI/ConvAI-Authentication, read on 2026-10-15):
//   1. A local listener is opened on a free port of this computer's loopback address (127.0.0.1, plus ::1 when it exists).
//   2. The browser opens  https://login.convai.com/?ue=true&port=<port>.  The player signs in (Google, e-mail, or a new account).
//   3. Convai's page sends the browser to  http://localhost:<port>/control?api_key=<encrypted key>&user_info=<encrypted account>.
//      Both values are Convai's own AES-encrypted login cookies, not the key itself.
//   4. This bridge asks  POST https://login.convai.com/api/decrypt {data: <encrypted value>}  -> {decryptedData}  for the key (the
//      account blob carries it too, as apiKey, and is used only when the key blob gives nothing usable).
// No Convai, Firebase or backend setting has to change for this, and nothing goes through the mod's own backend.
//
// What this file guarantees:
//   - Nothing runs until the player chooses Sign in with Convai. The listener accepts one sign-in, answers only on loopback, checks the
//     Host header, answers only a browser's own navigation (browserNavigation: no image, frame or fetch another page made), and closes as
//     soon as the sign-in ends, fails, is cancelled or times out (five minutes). No timer survives it.
//   - A web page cannot make the mod save someone else's key: the callback is taken at once only when the browser says it came from
//     Convai's own login page (the Referer header, which a page cannot set). A request that names another site is refused. A request
//     that names no site (a browser that sends no Referer, or a page that hides it) is held and shown to the player on a confirmation
//     page, with a one-time state value only that page carries: nothing is saved until the player confirms there.
//   - The key and the encrypted values are never logged, never written anywhere except through the caller's saveKey, and never put in
//     a URL by this bridge. (Convai's page puts the encrypted values in the loopback address; the answer to it is an immediate redirect
//     to a clean /done address, so they do not stay in the address bar.)
//   - The encrypted values go to login.convai.com only, over https.
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {parseKeyText} from './convai-key.mjs';
import {openInBrowser} from './character-editor-control.mjs';

export const CONVAI_SIGNIN = Object.freeze({
  loginUrl: 'https://login.convai.com/',
  decryptUrl: 'https://login.convai.com/api/decrypt',
  // Long enough to make a new Convai account and confirm its e-mail address; the listener costs nothing while it waits.
  timeoutMs: 300_000,
  decryptTimeoutMs: 10_000,
});

// One value from the loopback address: Convai's base64 (CryptoJS "Salted__" output), possibly percent-encoded. Never decoded here:
// the decrypt route decodes it once itself, and decoding '+' as a space would break it.
const BLOB = /^[A-Za-z0-9+/=%_.-]{10,10000}$/;

export class SignInError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const underConvai = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'convai.com' || url.hostname.endsWith('.convai.com')); }
  catch { return false; }
};

/** The raw (still encoded) values of `names` in a request target such as "/control?api_key=...&user_info=...". */
export function rawQuery(target, names) {
  const found = {};
  const query = typeof target === 'string' ? target.split('#')[0].split('?').slice(1).join('?') : '';
  for (const part of query.split('&')) {
    const at = part.indexOf('=');
    const name = at < 0 ? part : part.slice(0, at);
    if (names.includes(name) && found[name] === undefined) found[name] = at < 0 ? '' : part.slice(at + 1);
  }
  return found;
}

async function closeBody(response) { try { await response.body?.cancel(); } catch { /* already closed */ } }

// The decrypted text for one encrypted value. Convai's route answers {decryptedData}; a plain-text answer is taken as it is.
async function decrypt({fetchImpl, url, data, timeoutMs}) {
  let response;
  try {
    response = await fetchImpl(url, {method: 'POST', redirect: 'error', cache: 'no-store',
      headers: {'Content-Type': 'application/json', Accept: 'application/json'}, body: JSON.stringify({data}),
      signal: AbortSignal.timeout(timeoutMs)});
  } catch { throw new SignInError('unreachable'); }
  if (!response.ok) { await closeBody(response); throw new SignInError(response.status >= 500 ? 'unavailable' : 'refused'); }
  const text = await response.text().catch(() => '');
  if (!text || text.length > 20_000) return null;
  let value;
  try { value = JSON.parse(text); } catch { return text; }
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return null;
  for (const name of ['decryptedData', 'decrypted_data', 'decrypted', 'result', 'data']) {
    if (typeof value[name] === 'string' && value[name]) return value[name];
  }
  return null;
}

const keyFromText = text => {
  if (typeof text !== 'string') return null;
  let value = text.trim();
  if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { return null; } }
  return parseKeyText(value);
};
const keyFromAccount = text => {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  return value && typeof value === 'object' ? keyFromText(String(value.apiKey ?? value.api_key ?? '')) : null;
};

/**
 * The player's Convai API key from the two encrypted values Convai's login page sent: the key value first, then the account value.
 * Throws SignInError: 'unreachable', 'unavailable' (5xx), 'refused' (4xx) or 'bad-answer' (no plausible key in either).
 */
export async function exchangeSignIn({apiKey, userInfo, fetchImpl = globalThis.fetch, config = CONVAI_SIGNIN}) {
  if (!underConvai(config.decryptUrl)) throw new SignInError('refused');
  let failure = null;
  for (const [blob, read] of [[apiKey, keyFromText], [userInfo, keyFromAccount]]) {
    if (typeof blob !== 'string' || !BLOB.test(blob)) continue;
    let text;
    try { text = await decrypt({fetchImpl, url: config.decryptUrl, data: blob, timeoutMs: config.decryptTimeoutMs}); }
    catch (error) { failure = error instanceof SignInError ? error.code : 'unreachable'; continue; }
    const key = read(text);
    if (key) return key;
    failure = 'bad-answer';
  }
  throw new SignInError(failure ?? 'bad-answer');
}

const PAGE_STYLE = 'body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#f2f2f2;display:flex;justify-content:center;'
  + 'align-items:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}main{max-width:460px;text-align:center}'
  + 'h1{font-size:22px;font-weight:500}p{color:#a0a0a0;line-height:1.6}';
const page = (title, line) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
  + `<title>${title}</title><style>${PAGE_STYLE}</style></head><body><main><h1>${title}</h1><p>${line}</p></main></body></html>`;
const confirmPage = state => page('Confirm sign-in', 'Convai’s sign-in page did not say where this came from. Only continue if you chose Sign in with Convai in the game a moment ago '
  + `and just signed in on Convai’s page. <a href="/confirm?state=${state}" style="color:#f2f2f2">Yes, save my sign-in</a><br>If you did not, close this tab: nothing was saved.`);
const SIGNED_IN = page('Signed in', 'Your Convai API key is saved in the mod. You can close this tab and go back to the game.');
const NOT_SIGNED_IN = page('Sign-in did not finish', 'Go back to the game and choose Sign in with Convai again, or copy your key from convai.com and choose Paste.');
const PAGE_HEADERS = {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff'};

/**
 * Convai's page hands the key back by sending the browser itself to the loopback address: a top-level navigation. A browser marks every
 * request with what made it (Sec-Fetch-Mode and Sec-Fetch-Dest, which a page cannot set or change), so a request that some other web page
 * made in the background (an image, a frame, a fetch: how a page would look for the port and slip its own Convai account's values in while a
 * sign-in waits) is refused. A request without these headers (an older browser) is let through as before.
 */
export function browserNavigation(headers = {}) {
  const mode = headers['sec-fetch-mode'], dest = headers['sec-fetch-dest'];
  return (mode === undefined || mode === 'navigate') && (dest === undefined || dest === 'document');
}

/**
 * Where the browser says a callback came from, by its Referer header (set by the browser, never by a page): 'convai' for Convai's own login
 * pages, 'foreign' for any other site, 'unknown' when there is none (a browser that sends no Referer, or a page that hides it).
 */
export function callbackSource(headers = {}) {
  const referer = headers.referer;
  if (referer === undefined || referer === '') return 'unknown';
  return underConvai(String(referer)) ? 'convai' : 'foreign';
}

/**
 * Opens a listener on a free loopback port: 127.0.0.1, and ::1 on the same port when this computer has it (browsers may try either
 * for "localhost"). A port whose ::1 side is taken by another program is never used. Resolves {port, servers}.
 */
export async function listenLoopback(handler, {create = createServer, attempts = 5} = {}) {
  const bind = (server, port, host) => new Promise(resolve => {
    const failed = error => resolve(error ?? new Error('listen failed'));
    server.once('error', failed);
    server.listen(port, host, () => { server.off('error', failed); resolve(null); });
  });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const first = create(handler);
    if (await bind(first, 0, '127.0.0.1')) break;
    const port = first.address().port;
    const second = create(handler);
    const error = await bind(second, port, '::1');
    if (!error) return {port, servers: [first, second]};
    if (error.code === 'EADDRINUSE') { first.close(); continue; }
    return {port, servers: [first]}; // no IPv6 loopback here, so no browser can reach ::1 either
  }
  throw new SignInError('listen-failed');
}

/**
 * Starts one sign-in. Returns {opened, key, cancel}:
 *   opened  resolves once the listener is up and the browser was asked to open Convai's page; rejects 'listen-failed' or 'open-failed'
 *   key     resolves with the player's key; rejects SignInError 'timeout', 'cancelled', 'listen-failed', 'open-failed', or an exchange code
 *   cancel  ends it at once (the listener closes); the key promise rejects 'cancelled'
 */
export function startConvaiSignIn({openBrowser = openInBrowser, fetchImpl = globalThis.fetch, config = CONVAI_SIGNIN, listen = listenLoopback,
  setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  let resolveKey, rejectKey, servers = [], port = null, timer = null, finished = false, claimed = null, closeTimer = null;
  const held = new Map(); // state -> {apiKey, userInfo}: callbacks that did not say where they came from, waiting for the player to confirm
  const key = new Promise((resolve, reject) => { resolveKey = resolve; rejectKey = reject; });
  key.catch(() => {}); // a sign-in nobody waits for any more is not an unhandled rejection
  const closeAll = () => {
    if (closeTimer) { clearTimer(closeTimer); closeTimer = null; }
    for (const server of servers.splice(0)) { try { server.close(); server.closeAllConnections?.(); } catch { /* already closed */ } }
  };
  const finish = (error, value, {linger = false} = {}) => {
    if (finished) return;
    finished = true;
    if (timer) { clearTimer(timer); timer = null; }
    // After a sign-in the listener stays a few seconds for the browser's /done page, then closes; otherwise it closes now.
    if (linger) { closeTimer = setTimer(closeAll, 15_000); closeTimer?.unref?.(); } else closeAll();
    if (error) rejectKey(error); else resolveKey(value);
  };
  const allowedHosts = () => new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const claim = ({apiKey, userInfo}, response) => {
    claimed = exchangeSignIn({apiKey, userInfo, fetchImpl, config});
    claimed.then(value => finish(null, value, {linger: true}), error => finish(error instanceof SignInError ? error : new SignInError('bad-answer'), null, {linger: true}));
    response.writeHead(303, {Location: '/done', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'}).end();
  };
  const handler = (request, response) => {
    const target = request.url ?? '', path = target.split('?')[0];
    response.setHeader('Connection', 'close'); // no idle connection keeps the listener alive after the sign-in
    if (request.method !== 'GET' || !allowedHosts().has(String(request.headers.host ?? '').toLowerCase()) || !browserNavigation(request.headers)) {
      response.writeHead(403, {'Cache-Control': 'no-store'}).end(); return;
    }
    if (path === '/control' && !claimed && !finished) {
      const {api_key: apiKey, user_info: userInfo} = rawQuery(target, ['api_key', 'user_info']);
      const source = callbackSource(request.headers);
      // Another site sent the browser here: not Convai's login page, so never a sign-in of the player's.
      if (source === 'foreign') { response.writeHead(403, {'Cache-Control': 'no-store'}).end(); return; }
      if (!(apiKey && BLOB.test(apiKey)) && !(userInfo && BLOB.test(userInfo))) {
        response.writeHead(400, PAGE_HEADERS).end(NOT_SIGNED_IN); return;
      }
      if (source === 'unknown') {
        // Held, not saved: the player confirms on a page that carries a state value no other page can read.
        const state = randomBytes(16).toString('hex');
        if (held.size >= 5) held.delete(held.keys().next().value);
        held.set(state, {apiKey, userInfo});
        response.writeHead(200, PAGE_HEADERS).end(confirmPage(state));
        return;
      }
      claim({apiKey, userInfo}, response);
      return;
    }
    if (path === '/confirm' && !claimed && !finished) {
      // Only a click on the confirmation page (same origin), with the state that page was given.
      const site = request.headers['sec-fetch-site'];
      const state = rawQuery(target, ['state']).state;
      const values = typeof state === 'string' && /^[0-9a-f]{32}$/.test(state) ? held.get(state) : undefined;
      if ((site !== undefined && site !== 'same-origin') || !values) { response.writeHead(403, {'Cache-Control': 'no-store'}).end(); return; }
      held.clear();
      claim(values, response);
      return;
    }
    if (path === '/done' && claimed) {
      claimed.then(() => SIGNED_IN, () => NOT_SIGNED_IN).then(body => {
        response.once('finish', () => { if (finished) closeAll(); });
        response.writeHead(200, PAGE_HEADERS).end(body);
      });
      return;
    }
    response.writeHead(404, {'Cache-Control': 'no-store'}).end();
  };
  const opened = (async () => {
    let bound;
    try { bound = await listen(handler); } catch { throw new SignInError('listen-failed'); }
    servers = bound.servers; port = bound.port;
    if (finished) { closeAll(); throw new SignInError('cancelled'); }
    for (const server of servers) server.unref?.();
    timer = setTimer(() => { timer = null; finish(new SignInError('timeout')); }, config.timeoutMs);
    timer?.unref?.();
    const url = new URL(config.loginUrl);
    if (!underConvai(url.href)) throw new SignInError('open-failed');
    url.searchParams.set('ue', 'true');
    url.searchParams.set('port', String(port));
    try { await openBrowser(url.href); } catch { throw new SignInError('open-failed'); }
  })();
  opened.catch(error => finish(error instanceof SignInError ? error : new SignInError('open-failed')));
  return {opened, key, cancel: () => finish(new SignInError('cancelled'))};
}
