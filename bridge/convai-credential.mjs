// The credential for the project's shared Convai account: a short-lived token from the sign-in backend (auth-backend/,
// docs/CONVAI_AUTH_BACKEND.md) instead of the permanent key. Off unless switched on (see readAuthSettings).
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
// Failure handling: an unreachable or broken backend lets the bridge fall back to the embedded key (while the flag allows
// it); a backend that REFUSES (daily allowance used, rate limit, paused, outdated, blocked) is obeyed, never bypassed.
import {createHmac, randomUUID} from 'node:crypto';
import {readFile, writeFile, rename, rm} from 'node:fs/promises';
import {TurnLimitError, sanitizeLimit} from './shared-key-guard.mjs';

export const INSTALL_FILE = 'convai-install.json';
export const AUTH_CONFIG_FILE = 'convai-auth.json';
// The request-signing secret may be compiled in here by a release build; it is empty in the repository. Normally it comes from
// CYBERPUNK_CONVAI_AUTH_SECRET or from the "secret" field of convai-auth.json in the state folder.
const EMBEDDED_SECRET = '';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MINUTE = 60_000;
const RETRY_STEPS_MS = [5_000, 15_000, 60_000, 5 * MINUTE];
const LEAD_MIN_MS = 8 * MINUTE, LEAD_SPAN_MS = 2 * MINUTE;
const MIN_LIFE_SECONDS = 900;
const NEAR_EXPIRY_MS = 15_000;
// Failures that mean "the backend is not working", where the embedded key may stand in. Everything else is an answer.
const FALLBACK_KINDS = new Set(['unreachable', 'server', 'unauthorized', 'rejected', 'stale', 'ok']);

const truthy = value => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
const falsy = value => ['0', 'false', 'no', 'off'].includes(String(value ?? '').trim().toLowerCase());

/**
 * Whether backend mode is on, and how. Environment first, then convai-auth.json. Off by default: nothing changes for a player
 * until a deployed backend is enabled. Returns {enabled, url, secret, fallback, problem}; `problem` says why a requested
 * backend mode could not start (it never contains a secret).
 */
export async function readAuthSettings({env = process.env, readText = path => readFile(path, 'utf8'), path} = {}) {
  let file = {};
  if (path) {
    // A byte-order mark (PowerShell and older Notepad write one) is not part of the JSON; the other settings readers strip it too.
    try { const parsed = JSON.parse((await readText(path)).replace(/^﻿/, '')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) file = parsed; }
    catch { /* none, or unreadable: the file is optional */ }
  }
  const asked = env.CYBERPUNK_CONVAI_AUTH_BACKEND !== undefined && env.CYBERPUNK_CONVAI_AUTH_BACKEND !== ''
    ? truthy(env.CYBERPUNK_CONVAI_AUTH_BACKEND) : file.enabled === true;
  const url = String(env.CYBERPUNK_CONVAI_AUTH_URL || file.url || '').trim();
  const secret = String(env.CYBERPUNK_CONVAI_AUTH_SECRET || file.secret || EMBEDDED_SECRET || '').trim();
  const fallback = env.CYBERPUNK_CONVAI_AUTH_FALLBACK !== undefined && env.CYBERPUNK_CONVAI_AUTH_FALLBACK !== ''
    ? !falsy(env.CYBERPUNK_CONVAI_AUTH_FALLBACK) : file.fallback !== false;
  if (!asked) return {enabled: false, url: '', secret: '', fallback, problem: null};
  let parsedUrl = null;
  try { parsedUrl = new URL(url); } catch { /* reported below */ }
  const local = parsedUrl && ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname);
  if (!parsedUrl || !(parsedUrl.protocol === 'https:' || (parsedUrl.protocol === 'http:' && local))) {
    return {enabled: false, url: '', secret: '', fallback, problem: 'the sign-in backend address is missing or not https'};
  }
  if (secret.length < 16) return {enabled: false, url: '', secret: '', fallback, problem: 'the sign-in backend secret is not set'};
  return {enabled: true, url: parsedUrl.href, secret, fallback, problem: null};
}

/**
 * The sign-in backend's address and request-signing secret as configured, whether or not backend mode is on: the automatic error
 * reports (bridge/error-reports.mjs) go to the same deployment. Same sources and order as readAuthSettings (environment, then
 * convai-auth.json, then a secret compiled into a release). Returns {url, secret} (url '' when none is set, or when it is not https
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
  return {url, secret};
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

const clampSeconds = (value, fallback, min, max) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export class TokenSource {
  #token = null; #seen = []; #inflight = null; #timer = null; #stopped = false; #started = false; #usingFallback = false;
  #failures = 0; #clockOffsetMs = 0; #clockRetried = false; #announced = '';

  constructor({url, secret, installId, version = '0.0.0-dev', fetchImpl = globalThis.fetch, now = Date.now, setTimer = setTimeout,
    clearTimer = clearTimeout, random = Math.random, log = () => {}, timeoutMs = 10_000, fallback = true, onLimit = () => {}} = {}) {
    if (typeof url !== 'string' || !url || typeof secret !== 'string' || !secret || !UUID_V4.test(String(installId))
        || typeof fetchImpl !== 'function') throw Error('Invalid sign-in backend configuration');
    Object.defineProperty(this, 'secret', {value: secret}); // not enumerable: never in a snapshot or a JSON dump
    Object.assign(this, {url, installId, version, fetchImpl, now, setTimer, clearTimer, random, log, timeoutMs, fallback, onLimit});
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
  /** Resolves true when a token is available. It waits only while the first fetch of this run is still in flight, at most
   * `timeoutMs`; with a token already held, or no fetch running, it answers at once. */
  ready({timeoutMs = 4000} = {}) {
    if (this.current()) return Promise.resolve(true);
    if (!this.#inflight) return Promise.resolve(false);
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
    if (this.lastKind === 'rate') return new TurnLimitError('rate');
    return Error(`Convai sign-in is unavailable (${this.lastKind ?? 'not answered yet'}) [convai-auth:${this.lastKind ?? 'pending'}]`);
  }
  /** Values to scrub from reports: the tokens held now and recently, and the request-signing secret. */
  secrets() { return [...this.#seen, this.secret]; }
  /** For status displays: never contains a token. */
  snapshot() {
    return {installTail: this.installId.slice(-4), expiresAt: this.#token?.expiresAt ?? null, lastKind: this.lastKind ?? null,
      blocked: this.blocked ? {...this.blocked} : null, allowance: this.allowance, pendingTurns: this.pending, minClient: this.minClient,
      usingFallback: this.#usingFallback, dailyLimit: this.dailyLimit};
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
    this.#inflight = this.#run().catch(() => {}).finally(() => { this.#inflight = null; });
    return this.#inflight;
  }
  #schedule(delayMs) {
    if (this.#stopped) return;
    if (this.#timer !== null) this.clearTimer(this.#timer);
    this.#timer = this.setTimer(() => { this.#timer = null; void this.#attempt(); }, Math.max(0, delayMs));
    this.#timer?.unref?.();
  }
  async #run() {
    // The backend refuses a report above 1000 turns (400), which would repeat for ever; the rest follows in the next answer.
    const sent = Math.min(this.pending, 1000);
    let outcome;
    try { outcome = await this.#post(sent); } catch { outcome = {kind: 'unreachable'}; }
    this.#apply(outcome, sent);
  }
  async #post(turns) {
    const body = JSON.stringify({installId: this.installId, modVersion: this.version, turnsSinceLast: turns, minLifeSeconds: MIN_LIFE_SECONDS});
    const timestamp = String(Math.floor((this.now() + this.#clockOffsetMs) / 1000));
    const response = await this.fetchImpl(this.url, {method: 'POST', redirect: 'error', cache: 'no-store',
      headers: {'content-type': 'text/plain; charset=utf-8', accept: 'application/json', 'x-convai-timestamp': timestamp,
        'x-convai-signature': signRequest(this.secret, timestamp, body)},
      body, signal: AbortSignal.timeout(this.timeoutMs)});
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
    return {kind, data: object};
  }
  #announce(kind, message) {
    if (this.#announced === kind) return;
    this.#announced = kind;
    this.log(message);
  }
  #apply({kind, data}, sent) {
    const now = this.now();
    this.lastKind = kind;
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
      this.#announce(kind, `Sign-in backend ${kind === 'unreachable' ? 'could not be reached' : `failed (${kind})`}; retrying`);
      this.#schedule(delay);
    }
  }
}
