// The credential for the project's shared Convai account: a short-lived token from the sign-in backend (auth-backend/,
// docs/CONVAI_AUTH_BACKEND.md) instead of the permanent key. A release package ships it switched ON (app/defaults/convai-auth.json,
// written by the release build) and ships no Convai key at all; a development checkout has it off unless switched on (see readAuthSettings).
//
// Latency: a turn NEVER waits on this. The token is fetched in the background when the bridge starts and renewed 8 to 10
// minutes before it expires; current() is a synchronous read of memory. The only wait is the very first connection of a
// session while the first fetch is still running (ready(), at most four seconds, usually already over).
//
// What it sends: a random install id this bridge made for itself (convai-install.json, not the memory user id), the mod
// version, and how many shared-key turns were counted since the last report. Requests are signed with an HMAC over the body
// and a timestamp. That signature is OBFUSCATION, not authentication: the secret ships inside the program, so anyone who
// reads the program can sign. It only stops casual replay of a copied request (auth-backend/README.md says the same).
//
// Failure handling: an unreachable or broken backend lets the bridge fall back to a key of the developer's own (only while the flag
// allows it and such a key exists; a release has neither); a backend that REFUSES (daily allowance used, rate limit, paused, outdated,
// blocked) is obeyed, never bypassed. With no token and no fallback a turn fails at once with a plain notice (unavailableError).
//
// Two backends (auth-backend-cf/): players whose network cannot reach the Vercel backend (Russia, China) are served by a second one with
// the same API on Cloudflare Workers, `backupUrl` beside `url` (convai-auth.json, the release's app/defaults/convai-auth.json, or
// CYBERPUNK_CONVAI_AUTH_BACKUP_URL). Only a FAILURE TO ANSWER switches: the request threw (DNS, reset, timeout, TLS), or the answer was
// a server error or not our backend's JSON (a proxy's block page). An answer from the backend (a refusal, a rate limit, the daily
// allowance, paused, outdated) is obeyed and never taken to the other one. The server that answered last is asked first from then on
// (kept for the run of the bridge). If the first is silent for STAGGER_MS the second is asked as well, so a line that drops packets
// does not cost a full timeout; whichever answers first wins and the other request is cancelled. At most one request per backend per
// attempt, so the attempt budget (and the backend's per-install hourly limit, which each server counts for itself) is unchanged.
import {createHmac, randomUUID} from 'node:crypto';
import {readFile, writeFile, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {TurnLimitError, sanitizeLimit} from './shared-key-guard.mjs';

export const INSTALL_FILE = 'convai-install.json';
export const AUTH_CONFIG_FILE = 'convai-auth.json';
// The release build's own copy of the same settings, inside the Runtime (app/defaults/convai-auth.json):
// {"version": 1, "enabled": true, "url": "https://<backend>/api/convai/token", "secret": "<client request secret>", "fallback": false}.
// The lowest-priority source of readAuthSettings. It is NOT the error reports' file (app/defaults/error-reports.json, bridge/error-reports.mjs):
// the two secrets are different on purpose and neither reader looks at the other's file.
export const PACKAGED_AUTH_FILE = join('defaults', 'convai-auth.json');
// The request-signing secret may be compiled in here by a release build; it is empty in the repository. Normally it comes from
// CYBERPUNK_CONVAI_AUTH_SECRET or from the "secret" field of convai-auth.json in the state folder.
const EMBEDDED_SECRET = '';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MINUTE = 60_000;
const RETRY_STEPS_MS = [5_000, 15_000, 60_000, 5 * MINUTE];
const LEAD_MIN_MS = 8 * MINUTE, LEAD_SPAN_MS = 2 * MINUTE;
const MIN_LIFE_SECONDS = 900;
const NEAR_EXPIRY_MS = 15_000;
// With a second backend: how long the first may stay silent before the second is asked as well.
export const STAGGER_MS = 6_000;
// A player turn (or invitation) that finds no token after a transport failure tries once at once instead of waiting for the retry
// schedule above, so a short network blip costs one turn, not up to five minutes. Bounded: only for failures of the network or the
// server (a refusal is obeyed), at the earliest this long after the last failure, a shorter timeout than the background fetch, at most
// this many turn-started attempts in a row without an answer, and only while the install has used fewer than this many requests in the
// last hour (the backend allows 12 an hour per install; the schedule and bridge restarts need the rest).
//
// Timeouts (2026-10-24 triage, installs on slow or filtered networks): the request itself is given 25 s, the attempt of a turn too. Neither
// makes a turn wait longer: a turn waits in ready() for at most four seconds whatever the request's timeout, and an attempt that is still
// running then goes on in the background and serves the next turn. A throttled line (a few kilobytes a second) cannot finish a TLS
// handshake and a signed POST in 6 or 10 s but can in 25; the price is only that a dead line holds the one-request-at-a-time slot (a
// scheduled retry waits behind it) for up to 25 s instead of 6 to 10.
const TURN_RETRY_AFTER_MS = 3_000;
const REQUEST_TIMEOUT_MS = 25_000;
const TURN_RETRY_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
const TURN_RETRY_MAX_FAILS = 3;
const HOURLY_BUDGET = 8;
const TURN_RETRY_KINDS = new Set(['unreachable', 'server']);
// Failures that mean "the backend is not working", where the embedded key may stand in. Everything else is an answer.
const FALLBACK_KINDS = new Set(['unreachable', 'server', 'unauthorized', 'rejected', 'stale', 'ok']);

const truthy = value => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
const falsy = value => ['0', 'false', 'no', 'off'].includes(String(value ?? '').trim().toLowerCase());

async function readJsonObject(readText, path) {
  if (!path) return {};
  // A byte-order mark (PowerShell and older Notepad write one) is not part of the JSON; the other settings readers strip it too.
  try { const parsed = JSON.parse((await readText(path)).replace(/^\uFEFF/, '')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; }
  catch { /* none, or unreadable: the file is optional */ }
  return {};
}
const asText = value => typeof value === 'string' ? value.trim() : '';

/** The second backend's token address as an https (or local) href, or '' when it is not set, not an address, or the same as the first. */
export function cleanBackupUrl(raw, primary = '') {
  try {
    const parsed = new URL(String(raw ?? '').trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local)) || parsed.username || parsed.password) return '';
    return parsed.href === primary ? '' : parsed.href;
  } catch { return ''; }
}

/**
 * Whether backend mode is on, and how. Per field, the first source that has it: the environment, then convai-auth.json in the state
 * folder (`path`), then the release package's app/defaults/convai-auth.json (`packagedPath`). So a developer's own state-folder file
 * with "enabled": false still switches a package's backend mode off. Off when no source switches it on: nothing changes for a
 * development checkout until a deployed backend is enabled. `usePackaged: false` leaves the package's file out (the bridge does that
 * when the state folder holds a plain developer key: that key is used directly, as it always was). Returns {enabled, url, backupUrl,
 * secret, fallback, problem} (backupUrl: the second backend's token address, '' when there is none, see cleanBackupUrl); `problem` says why a requested backend mode could not start (it never contains a secret).
 */
export async function readAuthSettings({env = process.env, readText = path => readFile(path, 'utf8'), path, packagedPath, usePackaged = true} = {}) {
  const file = await readJsonObject(readText, path);
  const packaged = usePackaged ? await readJsonObject(readText, packagedPath) : {};
  const set = name => env[name] !== undefined && env[name] !== '';
  const asked = set('CYBERPUNK_CONVAI_AUTH_BACKEND') ? truthy(env.CYBERPUNK_CONVAI_AUTH_BACKEND)
    : typeof file.enabled === 'boolean' ? file.enabled : packaged.enabled === true;
  const url = String(env.CYBERPUNK_CONVAI_AUTH_URL || asText(file.url) || asText(packaged.url) || '').trim();
  const secret = String(env.CYBERPUNK_CONVAI_AUTH_SECRET || asText(file.secret) || asText(packaged.secret) || EMBEDDED_SECRET || '').trim();
  const backupRaw = env.CYBERPUNK_CONVAI_AUTH_BACKUP_URL || asText(file.backupUrl) || asText(packaged.backupUrl) || '';
  const fallback = set('CYBERPUNK_CONVAI_AUTH_FALLBACK') ? !falsy(env.CYBERPUNK_CONVAI_AUTH_FALLBACK)
    : typeof file.fallback === 'boolean' ? file.fallback : typeof packaged.fallback === 'boolean' ? packaged.fallback : true;
  if (!asked) return {enabled: false, url: '', backupUrl: '', secret: '', fallback, problem: null};
  let parsedUrl = null;
  try { parsedUrl = new URL(url); } catch { /* reported below */ }
  const local = parsedUrl && ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname);
  if (!parsedUrl || !(parsedUrl.protocol === 'https:' || (parsedUrl.protocol === 'http:' && local))) {
    return {enabled: false, url: '', backupUrl: '', secret: '', fallback, problem: 'the sign-in backend address is missing or not https'};
  }
  if (secret.length < 16) return {enabled: false, url: '', backupUrl: '', secret: '', fallback, problem: 'the sign-in backend secret is not set'};
  return {enabled: true, url: parsedUrl.href, backupUrl: cleanBackupUrl(backupRaw, parsedUrl.href), secret, fallback, problem: null};
}

/**
 * The sign-in backend's address and request-signing secret as configured, whether or not backend mode is on: the automatic error
 * reports (bridge/error-reports.mjs) go to the same deployment. Sources: the environment, then convai-auth.json in the state folder, then a
 * secret compiled into a release. It never reads the package's app/defaults/convai-auth.json (PACKAGED_AUTH_FILE): that request secret is
 * not the error reports' secret (their own file is app/defaults/error-reports.json). Returns {url, secret} (url '' when none is set, or when it is not https
 * and not a local address), or null when there is no secret.
 */
export async function readBackendAddress({env = process.env, readText = path => readFile(path, 'utf8'), path} = {}) {
  let file = {};
  if (path) {
    try { const parsed = JSON.parse((await readText(path)).replace(/^﻿/, '')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) file = parsed; }
    catch { /* none, or unreadable: the file is optional */ }
  }
  const secret = String(env.CYBERPUNK_CONVAI_AUTH_SECRET || (typeof file.secret === 'string' ? file.secret : '') || EMBEDDED_SECRET || '').trim();
  if (secret.length < 16) return null;
  const raw = String(env.CYBERPUNK_CONVAI_AUTH_URL || (typeof file.url === 'string' ? file.url : '') || '').trim();
  let url = '';
  try {
    const parsed = new URL(raw);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local)) url = parsed.href;
  } catch { /* none set */ }
  // The second backend, for the error reports to fall back to (only its origin is used there).
  const backupUrl = cleanBackupUrl(env.CYBERPUNK_CONVAI_AUTH_BACKUP_URL || (typeof file.backupUrl === 'string' ? file.backupUrl : ''), url);
  return {url, secret, ...(backupUrl ? {backupUrl} : {})};
}

async function writePrivate(path, text) {
  const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  try { await writeFile(temporary, text, {encoding: 'utf8', mode: 0o600}); await rename(temporary, path); }
  catch (error) { await rm(temporary, {force: true}).catch(() => {}); throw error; }
}

/** The random id of this installation (UUID v4), made once and kept in `path`. It is not the memory user id. A file that
 * cannot be written still yields an id for this run. */
export async function loadInstallId({path, readText = file => readFile(file, 'utf8'), writeText = writePrivate, generate = randomUUID} = {}) {
  try {
    const saved = JSON.parse(await readText(path));
    if (saved?.version === 1 && typeof saved.installId === 'string' && UUID_V4.test(saved.installId)) return saved.installId;
  } catch { /* none yet, or damaged: make a new one */ }
  const installId = generate();
  try { await writeText(path, JSON.stringify({version: 1, installId}) + '\n'); } catch { /* kept in memory for this run only */ }
  return installId;
}

export const signRequest = (secret, timestamp, body) => 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

/**
 * A short, safe word for why a request to the backend threw, from the error and its causes: a network error code (ENOTFOUND for DNS,
 * ECONNRESET for a reset, ETIMEDOUT or UND_ERR_CONNECT_TIMEOUT for a connection that never completed, ECONNREFUSED, a TLS or certificate
 * code), TimeoutError when our own timer ended the request, 'redirect' when the backend answered with a redirect (the request refuses
 * them), else 'fetch-failed' or 'unknown'. Only a code of capitals, digits and underscores is ever returned: never a host name, an
 * address, a message or any text of the error, so it can go into the log and a report.
 */
export function networkCause(error) {
  let fallback = 'unknown';
  const seen = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return null;
    seen.add(value);
    if (typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{2,39}$/.test(value.code)) return value.code;
    if (value.name === 'TimeoutError') return 'TimeoutError';
    if (value.name === 'AbortError' && depth === 0) fallback = 'aborted';
    if (typeof value.message === 'string' && /redirect/i.test(value.message) && depth > 0) fallback = 'redirect';
    if (value.name === 'TypeError' && depth === 0 && fallback === 'unknown') fallback = 'fetch-failed';
    if (Array.isArray(value.errors)) for (const inner of value.errors.slice(0, 3)) { const found = visit(inner, depth + 1); if (found) return found; }
    return visit(value.cause, depth + 1);
  };
  return visit(error, 0) ?? fallback;
}

const clampSeconds = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export class TokenSource {
  #token = null; #seen = []; #inflight = null; #timer = null; #stopped = false; #started = false; #usingFallback = false;
  #failures = 0; #clockOffsetMs = 0; #clockRetried = false; #announced = ''; #lastKick = 0;
  #failedKind = ''; #failedAt = 0; #cause = ''; #altCause = ''; #turnRetrying = false; #turnFails = 0; #attemptTimes = [];
  #urls = []; #preferred = 0; // the backends' token addresses (the second only with a backupUrl) and the index of the one asked first

  constructor({url, backupUrl = '', secret, installId, version = '0.0.0-dev', fetchImpl = globalThis.fetch, now = Date.now, setTimer = setTimeout,
    clearTimer = clearTimeout, random = Math.random, log = () => {}, timeoutMs = REQUEST_TIMEOUT_MS, fallback = true, onLimit = () => {},
    staggerMs = STAGGER_MS} = {}) {
    if (typeof url !== 'string' || !url || typeof secret !== 'string' || !secret || !UUID_V4.test(String(installId))
        || typeof fetchImpl !== 'function') throw Error('Invalid sign-in backend configuration');
    Object.defineProperty(this, 'secret', {value: secret}); // not enumerable: never in a snapshot or a JSON dump
    Object.assign(this, {url, installId, version, fetchImpl, now, setTimer, clearTimer, random, log, timeoutMs, fallback, onLimit, staggerMs});
    const backup = cleanBackupUrl(backupUrl, url);
    this.backupUrl = backup;
    this.#urls = backup ? [url, backup] : [url];
    this.dailyLimit = null; // the per-install daily limit the backend last reported (a whole number in the accepted range), or null
    this.pending = 0; this.lastKind = undefined; this.blocked = null; this.allowance = null; this.minClient = null;
    this.attempts = 0;
  }

  /** Begins the background fetch and renewals. Returns at once; never throws. */
  start() {
    if (this.#started || this.#stopped) return this;
    this.#started = true;
    void this.#attempt();
    return this;
  }
  stop() {
    this.#stopped = true;
    if (this.#timer !== null) this.clearTimer(this.#timer);
    this.#timer = null;
  }
  /** One counted shared-key turn, reported with the next renewal. Costs an integer increment. */
  noteTurn() { if (this.pending < 100_000) this.pending += 1; }

  /** The token in memory, or null when there is none or it is about to expire. Synchronous: no network, no waiting. */
  current() {
    return this.#token && this.#token.expiresAt - this.now() > NEAR_EXPIRY_MS ? {token: this.#token.value, expiresAt: this.#token.expiresAt} : null;
  }
  /** A turn found no token although the last answer was good (or there was none yet): the token expired while no renewal ran, for example
   * after the computer slept. Starts one fetch in the background, at most every 30 s. After a failure the retry schedule (5 s, 15 s, 60 s,
   * 5 min) decides, with one bounded exception: a network or server failure older than 3 s gets one attempt for this turn (#retryForTurn),
   * so a short blip does not cost minutes of Convai. A refusal or rate limit is never retried by a turn. Returns at once. */
  kick() {
    if (this.#stopped || !this.#started || this.#inflight || this.current()) return;
    const now = this.now();
    if (this.lastKind !== undefined && this.lastKind !== 'ok') { this.#retryForTurn(now); return; }
    if (now - this.#lastKick < 30_000) return;
    this.#lastKick = now;
    void this.#attempt();
  }
  /** After a network or server failure, one attempt for this turn: the turn waits for it (ready(), four seconds at most). Not while the
   * backend refused or rate limited (that wait is the backend's to set), not within 3 s of the last failure, not after three such
   * attempts in a row failed, not once the hour's budget of requests is used. */
  #retryForTurn(now) {
    if (!TURN_RETRY_KINDS.has(this.#failedKind) || now - this.#failedAt < TURN_RETRY_AFTER_MS || this.#turnFails >= TURN_RETRY_MAX_FAILS) return;
    this.#attemptTimes = this.#attemptTimes.filter(time => now - time < 60 * MINUTE);
    if (this.#attemptTimes.length >= HOURLY_BUDGET) return;
    this.#turnRetrying = true;
    void this.#attempt();
  }
  /** Resolves true when a token is available. It waits (at most `timeoutMs`) only while a fetch is in flight and no answer so far was a
   * failure: the first fetch of a run, or the fetch a turn started (because the token had run out after a good answer, or to retry at
   * once after a network failure, see kick()). With a token held, no fetch running, or an earlier failure (a scheduled retry runs in the
   * background and is never waited for), it answers at once. */
  ready({timeoutMs = 4000} = {}) {
    if (this.current()) return Promise.resolve(true);
    if (!this.#inflight || (this.lastKind !== undefined && this.lastKind !== 'ok' && !this.#turnRetrying)) return Promise.resolve(false);
    return new Promise(resolve => {
      const timer = this.setTimer(() => resolve(false), timeoutMs);
      timer?.unref?.();
      this.#inflight.then(() => { this.clearTimer(timer); resolve(!!this.current()); });
    });
  }

  /** Throws the daily-limit failure while the backend says this install's day is used up, so the game shows the same notice as
   * the local gate. Synchronous. */
  assertAllowed() {
    if (!this.blocked) return;
    if (this.now() >= this.blocked.until) { this.blocked = null; return; }
    throw new TurnLimitError('daily');
  }
  /** True when the embedded key may stand in: the backend is not answering usefully and the flag allows it. */
  fallbackAllowed() { return this.fallback && (this.lastKind === undefined || FALLBACK_KINDS.has(this.lastKind)); }
  /** Records (once per episode, in the bridge log only) that the embedded key is being used. */
  noteFallbackUse() {
    if (this.#usingFallback) return;
    this.#usingFallback = true;
    this.log(`Sign-in backend unavailable (${this.lastKind ?? 'not answered yet'}): conversations use the embedded key`);
  }
  /** The error for a turn that has neither a token nor a permitted fallback. */
  unavailableError() {
    if (this.lastKind === 'daily') return new TurnLimitError('daily');
    // The backend's per-address token limit is a sign-in state, not "turns are coming too quickly" (that is the local guard's own
    // message, bridge/shared-key-guard.mjs): it carries the sign-in marker so the game says Convai sign-in is unavailable.
    if (this.lastKind === 'rate') return Object.assign(Error('Convai sign-in is rate limited by the sign-in backend [convai-auth:rate]'), {authKind: 'rate'});
    // authCause (a code like ENOTFOUND, see networkCause) is not in the message: the message is what the error report's signature is made
    // of, so the cause rides in the report's detail (bridge/error-events.mjs turnFailed) and one signature keeps counting every case.
    return Object.assign(Error(`Convai sign-in is unavailable (${this.lastKind ?? 'not answered yet'}) [convai-auth:${this.lastKind ?? 'pending'}]`),
      {authKind: this.lastKind ?? 'pending', ...(this.#cause ? {authCause: this.#cause} : {})});
  }
  /** Values to scrub from reports: the tokens held now and recently, and the request-signing secret. */
  secrets() { return [...this.#seen, this.secret]; }
  /** For status displays: never contains a token. */
  snapshot() {
    return {installTail: this.installId.slice(-4), expiresAt: this.#token?.expiresAt ?? null, lastKind: this.lastKind ?? null,
      blocked: this.blocked ? {...this.blocked} : null, allowance: this.allowance, pendingTurns: this.pending, minClient: this.minClient,
      usingFallback: this.#usingFallback, dailyLimit: this.dailyLimit, lastCause: this.#cause || null,
      backup: this.#urls.length > 1 ? {host: this.#host(1), usingBackup: this.#preferred === 1, lastCause: this.#altCause || null} : null};
  }
  /** The backend's daily limit travels with every token and every daily refusal: the top-level `dailyInteractionLimit`, else the
   * `allowance.limit` an older deployment sends. A value that is missing, not a whole number or out of range is ignored (the last
   * good one stays). onLimit hears every good value; it never throws into the renewal. */
  #noteLimit(data) {
    const value = sanitizeLimit(data?.dailyInteractionLimit) ?? sanitizeLimit(data?.allowance?.limit);
    if (value === null) return;
    this.dailyLimit = value;
    try { this.onLimit(value); } catch { /* an observer never stops a renewal */ }
  }

  #attempt() {
    if (this.#stopped) return Promise.resolve();
    if (this.#inflight) return this.#inflight;
    if (this.#timer !== null) { this.clearTimer(this.#timer); this.#timer = null; }
    this.attempts += 1;
    this.#attemptTimes.push(this.now());
    const turn = this.#turnRetrying;
    this.#inflight = this.#run(turn).catch(() => {}).finally(() => { this.#inflight = null; this.#turnRetrying = false; });
    return this.#inflight;
  }
  #schedule(delayMs) {
    if (this.#stopped) return;
    if (this.#timer !== null) this.clearTimer(this.#timer);
    this.#timer = this.setTimer(() => { this.#timer = null; void this.#attempt(); }, Math.max(0, delayMs));
    this.#timer?.unref?.();
  }
  async #run(turn = false) {
    // The backend refuses a report above 1000 turns (400), which would repeat for ever; the rest follows in the next answer.
    const sent = Math.min(this.pending, 1000);
    let outcome;
    const timeout = turn ? TURN_RETRY_TIMEOUT_MS : this.timeoutMs;
    try { outcome = this.#urls.length > 1 ? await this.#postBoth(sent, timeout) : await this.#postTo(0, sent, timeout); }
    catch (error) { outcome = {kind: 'unreachable', cause: networkCause(error)}; }
    this.#apply(outcome, sent, turn);
  }
  /** True when the outcome is a failure to get an answer from the backend (so the other backend may be tried), not an answer of the backend. */
  static #silent(outcome) { return outcome.kind === 'unreachable' || outcome.kind === 'server' || outcome.foreign === true; }
  #host(index) { try { return new URL(this.#urls[index]).host; } catch { return 'unknown'; } }
  /** One request to backend `index`, never throwing: a thrown error becomes an unreachable outcome with its cause. */
  #postSafe(index, turns, timeoutMs, signal) {
    return this.#postTo(index, turns, timeoutMs, signal).then(outcome => ({...outcome, via: index}),
      error => ({kind: 'unreachable', cause: networkCause(error), via: index}));
  }
  /**
   * Two backends: the one that answered last is asked first. If it fails to answer, or is silent for staggerMs, the other is asked too
   * (at most one request each); the first real answer wins and the request still running is cancelled. When neither answers, the first
   * one's failure is reported (with the other's cause beside it). Resolves with the outcome, `via` naming the backend that gave it.
   */
  #postBoth(turns, timeoutMs) {
    const first = this.#preferred, second = 1 - this.#preferred;
    const stop = new AbortController();
    const results = [];
    return new Promise(resolve => {
      let started = 1, finished = false, timer = null;
      const finish = outcome => {
        if (finished) return;
        finished = true;
        if (timer !== null) this.clearTimer(timer);
        timer = null;
        stop.abort();
        resolve(outcome);
      };
      const begin = index => {
        void this.#postSafe(index, turns, timeoutMs, stop.signal).then(outcome => {
          if (finished) return;
          results.push(outcome);
          if (!TokenSource.#silent(outcome)) finish(outcome);
          else if (results.length === 2) {
            const head = results.find(result => result.via === first) ?? results[0], other = results.find(result => result !== head);
            finish({...head, altCause: other?.cause ?? (other ? other.kind : '')});
          } else startSecond();
        });
      };
      const startSecond = () => {
        if (started === 2 || finished) return;
        started = 2;
        if (timer !== null) { this.clearTimer(timer); timer = null; }
        begin(second);
      };
      begin(first);
      if (!finished && started === 1) { timer = this.setTimer(() => { timer = null; startSecond(); }, this.staggerMs); timer?.unref?.(); }
    });
  }
  async #postTo(index, turns, timeoutMs = this.timeoutMs, cancel = null) {
    const body = JSON.stringify({installId: this.installId, modVersion: this.version, turnsSinceLast: turns, minLifeSeconds: MIN_LIFE_SECONDS});
    const timestamp = String(Math.floor((this.now() + this.#clockOffsetMs) / 1000));
    const signal = cancel && typeof AbortSignal.any === 'function' ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel]) : AbortSignal.timeout(timeoutMs);
    const response = await this.fetchImpl(this.#urls[index], {method: 'POST', redirect: 'error', cache: 'no-store',
      headers: {'content-type': 'text/plain; charset=utf-8', accept: 'application/json', 'x-convai-timestamp': timestamp,
        'x-convai-signature': signRequest(this.secret, timestamp, body)},
      body, signal});
    let data = null;
    try { const text = await response.text(); if (text.length <= 16384) data = JSON.parse(text); } catch { /* not JSON: a server or proxy page */ }
    const object = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const error = typeof object.error === 'string' ? object.error : '';
    const status = response.status;
    if (status === 200 && typeof object.authToken === 'string' && object.authToken.length >= 8 && object.authToken.length <= 4096
        && Number.isFinite(Date.parse(object.expiresAt))) return {kind: 'ok', data: object};
    if (status === 200) return {kind: 'server'};
    const kind = status === 401 ? (error === 'stale' ? 'stale' : 'unauthorized')
      : status === 400 || status === 413 ? 'rejected'
        : status === 403 ? 'refused'
          : status === 426 ? 'outdated'
            : status === 429 ? (error === 'daily' ? 'daily' : 'rate')
              : status === 503 && error === 'paused' ? 'paused'
                : status === 503 && error === 'busy' ? 'busy' : 'server';
    // An answer that is not our backend's JSON (a proxy's or an ISP's block page, a bare gateway error) is no answer: with a second backend it is
    // handled like an unreachable one. Our backends always send {"error": ...} with a refusal.
    return {kind, data: object, foreign: !error};
  }
  #announce(kind, message) {
    if (this.#announced === kind) return;
    this.#announced = kind;
    this.log(message);
  }
  #apply(outcome, sent, turn = false) {
    const {kind, data, cause, altCause, via} = outcome;
    const now = this.now();
    this.lastKind = kind;
    this.#cause = kind === 'unreachable' && typeof cause === 'string' ? cause : '';
    this.#altCause = typeof altCause === 'string' && /^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(altCause) ? altCause : '';
    // The backend that really answered (anything but a failure to answer) is asked first from now on.
    if (via !== undefined && via !== this.#preferred && !TokenSource.#silent(outcome)) {
      this.#preferred = via;
      this.log(`Sign-in backend: ${this.#host(via)} is answering; asked first from now on`);
    }
    this.#failedKind = kind === 'ok' ? '' : kind; this.#failedAt = now; // the real kind: lastKind may be turned into 'server' below
    this.#turnFails = kind === 'ok' ? 0 : turn ? this.#turnFails + 1 : this.#turnFails;
    if (typeof data?.minClient === 'string') this.minClient = data.minClient.slice(0, 20);
    if (kind === 'ok' || kind === 'daily') this.#noteLimit(data);
    if (typeof data?.serverTime === 'number' && Number.isFinite(data.serverTime)) {
      const offset = data.serverTime * 1000 - now;
      if (kind === 'stale' || Math.abs(offset) > 30_000) this.#clockOffsetMs = offset;
    }
    if (kind === 'ok') {
      const expiresAt = Date.parse(data.expiresAt), value = data.authToken;
      const same = this.#token?.value === value || (this.#token && expiresAt <= this.#token.expiresAt + MINUTE);
      this.#token = {value, expiresAt};
      if (!this.#seen.includes(value)) this.#seen = [...this.#seen, value].slice(-4);
      this.pending = Math.max(0, this.pending - sent);
      this.#failures = 0; this.blocked = null; this.#clockRetried = false;
      if (data.allowance && typeof data.allowance === 'object') this.allowance = {used: Number(data.allowance.used) || 0, limit: Number(data.allowance.limit) || 0};
      if (this.#usingFallback) this.log('Sign-in backend answered again: conversations use its token');
      this.#usingFallback = false; this.#announced = '';
      const life = expiresAt - now;
      const lead = LEAD_MIN_MS + this.random() * LEAD_SPAN_MS;
      // A backend that returned the same token (an older deployment) is asked again only once it re-mints, a few minutes before expiry.
      this.#schedule(same ? Math.max(30_000, life - 4 * MINUTE) : life > LEAD_MIN_MS + LEAD_SPAN_MS + 2 * MINUTE ? life - lead : Math.max(30_000, life / 2));
      return;
    }
    if (kind === 'stale' && !this.#clockRetried && Number.isFinite(data?.serverTime)) {
      this.#clockRetried = true; // the clock was off: sign again with the server's time
      this.#schedule(0);
      return;
    }
    const limitedBy = seconds => Math.round(clampSeconds(Number(seconds), 300, 30, 3600) * 1000);
    if (kind === 'daily') {
      this.pending = Math.max(0, this.pending - sent); // the backend recorded those turns
      const until = Date.parse(data?.resetAt);
      const resets = Number.isFinite(until) && until > now ? until : (Math.floor(now / 86_400_000) + 1) * 86_400_000;
      this.blocked = {kind: 'daily', until: resets};
      this.#announce(kind, 'Sign-in backend: this installation has used today\'s allowance; no new conversation token until it resets');
      // Asked again every half hour (not only at the reset): when the owner raises the daily limit the backend stops refusing and an
      // install that was blocked is let through without waiting for midnight. One small request per blocked install per 30 minutes.
      this.#schedule(Math.min(resets - now, 30 * MINUTE) + Math.round(this.random() * MINUTE));
    } else if (kind === 'rate') {
      // After failed attempts the install's own retries (4 an hour are allowed) can be what the backend is limiting: that is an outage,
      // not a refusal, so the embedded key may stand in as it does for any other failure.
      if (this.#failures > 0) this.lastKind = 'server';
      this.#announce(kind, 'Sign-in backend: too many token requests from this installation or address; waiting');
      this.#schedule(limitedBy(data?.retryAfterSeconds));
    } else if (kind === 'paused') {
      this.#announce(kind, 'Sign-in backend is paused by its owner');
      this.#schedule(5 * MINUTE);
    } else if (kind === 'busy') {
      this.pending = Math.max(0, this.pending - sent); // counted before the mint budget was checked: asking again must not add them twice
      this.#announce(kind, 'Sign-in backend is busy for today');
      this.#schedule(limitedBy(data?.retryAfterSeconds ?? 900));
    } else if (kind === 'outdated') {
      this.#announce(kind, `Sign-in backend needs a newer mod version${this.minClient ? ` (${this.minClient} or later)` : ''}`);
      this.#schedule(60 * MINUTE);
    } else if (kind === 'refused') {
      this.#announce(kind, 'Sign-in backend refused this installation');
      this.#schedule(60 * MINUTE);
    } else {
      const delay = RETRY_STEPS_MS[Math.min(this.#failures, RETRY_STEPS_MS.length - 1)];
      this.#failures += 1;
      const causes = this.#cause ? ` (${this.#cause}${this.#altCause ? `; backup: ${this.#altCause}` : ''})` : '';
      this.#announce(`${kind}:${this.#cause}:${this.#altCause}`, `Sign-in backend ${kind === 'unreachable' ? `could not be reached${causes}` : `failed (${kind})`}; retrying`);
      this.#schedule(delay);
    }
  }
}
