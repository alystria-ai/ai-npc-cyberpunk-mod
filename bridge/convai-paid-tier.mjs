// Settings > Conversation provider > Convai paid tier (docs/CONVAI_PAID_TIER.md): the plans Convai made for this mod, bought with the
// player's own Convai API key, which conversations then use through the existing "Convai API key" path (bridge/convai-key.mjs).
//
// Convai's payment service (its Convai_Payments repository, read on 2026-10-15):
//   POST {paymentBase}/new-transaction       header CONVAI-API-KEY, body {price_id[, success_url, cancel_url]}
//                                            -> {checkout_url, customer_id, "Reference ID", ...}: a Stripe-hosted checkout page
//   POST {paymentBase}/get-user-details      body {api_key} -> {plan_name, start_ts, expiry_ts, ...} (today still under /beta)
// Stripe's success is handled by Convai's own webhook; the plan is active about 15 seconds after the payment. Changing or cancelling a
// plan happens on Convai's billing page (its cancellation flow runs there, inside the player's Convai web session), so the mod only
// opens that page.
//
// What this file guarantees:
//   - The player's key is sent to one host only, the payment service (a convai.com host), and only for the two calls above. It never
//     enters a status file, a log line or an error text. Nothing here reads the shared key.
//   - Nothing runs unless the player asks: a command file written by the settings page (read every half second, like the other
//     settings actions). After a purchase the plan is read a few times (every 6 s for a minute, then every 20 s up to five minutes)
//     and the check stops at the first confirmation. No timer is left running otherwise.
//   - Only a Stripe or Convai https page is ever opened in the browser, whatever a server answers.
//   - Sign in with Convai (bridge/convai-signin.mjs) runs only when the player chooses it; its key is checked with Convai and saved
//     through saveKey, the same path as Paste.
//   - Prices and price ids live in DEFAULT_PAID_TIER below; the sign-in backend can replace them (GET /api/convai/plans, set with
//     POST /api/admin/config {"paidPlans": ...}) so they change without a mod update. A plan whose price id repeats an earlier
//     plan's is dropped, so a copy error can never put two prices on one charge.
import {readFile} from 'node:fs/promises';
import {openInBrowser} from './character-editor-control.mjs';

export const DEFAULT_PAID_TIER = Object.freeze({
  paymentBase: 'https://payment.convai.com',
  checkoutPath: '/new-transaction',
  // Convai said get-user-details moves to the main path; until it does, the /beta one answers. A 404 or 405 tries the next.
  detailsPaths: Object.freeze(['/get-user-details', '/beta/get-user-details']),
  manageUrl: 'https://convai.com/management/billing',
  keyPageUrl: 'https://convai.com',
  successUrl: null,
  cancelUrl: null,
  plans: Object.freeze([
    Object.freeze({id: 'gamer-monthly', name: 'Gamer', period: 'monthly', price: '$4', priceId: 'price_1UQj9YHC9LzXKZDPTHUfkDuj', interactions: 500, concurrency: 6}),
    Object.freeze({id: 'gamer-yearly', name: 'Gamer', period: 'yearly', price: '$32', priceId: 'price_1UQjA5HC9LzXKZDPPqOe4ji3', interactions: 500, concurrency: 6}),
    Object.freeze({id: 'pro-monthly', name: 'Gamer Pro', period: 'monthly', price: '$8', priceId: 'price_1UQjPvHC9LzXKZDP2lrHSw6j', interactions: 1000}),
    Object.freeze({id: 'pro-yearly', name: 'Gamer Pro', period: 'yearly', price: '$64', priceId: 'price_1UQjPvHC9LzXKZDPXqfCGpP0', interactions: 1000}),
  ]),
});

const PLAN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PRICE_ID = /^price_[A-Za-z0-9]{8,64}$/;
const PRICE = /^[$€£]?\d{1,4}(?:[.,]\d{2})?(?:\s?(?:USD|EUR|GBP|[$€£]))?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,31}$/;
const PATH = /^\/[A-Za-z0-9/_-]{1,80}$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const COMMAND_MAX_BYTES = 4096, COMMAND_MAX_AGE_MS = 30_000;
const ACTIONS = new Set(['refresh', 'buy', 'check', 'manage', 'key-page', 'sign-in']);

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hostOf = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.hostname.toLowerCase() : null; } catch { return null; } };
const underConvai = host => host === 'convai.com' || (typeof host === 'string' && host.endsWith('.convai.com'));
const underStripe = host => host === 'stripe.com' || (typeof host === 'string' && host.endsWith('.stripe.com'));
const count = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max ? value : undefined;

/** A convai.com https address (no credentials), or null. The player's key only ever goes to such a host. */
export function convaiUrl(value) {
  return typeof value === 'string' && value.length <= 300 && underConvai(hostOf(value)) ? new URL(value).href.replace(/\/$/, '') : null;
}

/** A page the browser may open after a checkout request: https on stripe.com or convai.com only. */
export function safeCheckoutUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const host = hostOf(value);
  return host && (underStripe(host) || underConvai(host)) ? value : null;
}

/** The plans in `value` that are well formed, in order, at most eight, each price id used once. [] when none. */
export function parsePlans(value) {
  if (!Array.isArray(value)) return [];
  const plans = [], ids = new Set(), prices = new Set();
  for (const item of value.slice(0, 16)) {
    if (!plain(item) || !PLAN_ID.test(item.id ?? '') || !NAME.test(item.name ?? '') || !['monthly', 'yearly'].includes(item.period)
        || typeof item.price !== 'string' || !PRICE.test(item.price.trim()) || !PRICE_ID.test(item.priceId ?? '')) continue;
    if (ids.has(item.id) || prices.has(item.priceId)) continue;
    ids.add(item.id); prices.add(item.priceId);
    plans.push({id: item.id, name: item.name, period: item.period, price: item.price.trim(), priceId: item.priceId,
      ...(count(item.interactions, 10_000_000) ? {interactions: item.interactions} : {}),
      ...(count(item.concurrency, 1000) ? {concurrency: item.concurrency} : {})});
    if (plans.length === 8) break;
  }
  return plans;
}

/** The built-in configuration with whatever a server sent that is valid laid over it. Invalid parts are ignored, never half-used. */
export function resolvePaidTier(override) {
  const base = {...DEFAULT_PAID_TIER, detailsPaths: [...DEFAULT_PAID_TIER.detailsPaths], plans: parsePlans(DEFAULT_PAID_TIER.plans)};
  if (!plain(override)) return base;
  const plans = parsePlans(override.plans);
  if (plans.length) base.plans = plans;
  const paymentBase = convaiUrl(override.paymentBase);
  if (paymentBase) base.paymentBase = paymentBase;
  if (typeof override.checkoutPath === 'string' && PATH.test(override.checkoutPath)) base.checkoutPath = override.checkoutPath;
  if (Array.isArray(override.detailsPaths)) {
    const paths = override.detailsPaths.filter(path => typeof path === 'string' && PATH.test(path)).slice(0, 3);
    if (paths.length) base.detailsPaths = paths;
  }
  for (const name of ['manageUrl', 'keyPageUrl']) { const url = convaiUrl(override[name]); if (url) base[name] = url; }
  for (const name of ['successUrl', 'cancelUrl']) { const url = convaiUrl(override[name]); if (url) base[name] = url; }
  return base;
}

/** A plan name Convai uses for a plan nobody pays for. */
export function isFreePlan(name) {
  return typeof name !== 'string' || !name.trim() || name.trim() === '-1' || /^none$/i.test(name.trim()) || /free|trial/i.test(name);
}

// The plan_name values of the four plans Convai made for this mod (confirmed on a live purchase of GamerPlanV2-Monthly, 2026-10-16).
export const KNOWN_PAID_PLANS = Object.freeze(['GamerPlanV2-Monthly', 'GamerPlanV2-Yearly', 'GamerProPlanV2-Monthly', 'GamerProPlanV2-Yearly']);

/** A plan name that means a paid plan: one of the four known names, or (a name this list does not know yet) anything that is not free. */
export function isPaidPlanName(name) {
  return typeof name === 'string' && (KNOWN_PAID_PLANS.includes(name.trim()) || !isFreePlan(name));
}

async function closeBody(response) { try { await response.body?.cancel(); } catch { /* already closed */ } }

async function postJson(fetchImpl, url, {headers = {}, body, timeoutMs}) {
  const response = await fetchImpl(url, {method: 'POST', redirect: 'error', cache: 'no-store',
    headers: {'Content-Type': 'application/json', Accept: 'application/json', ...headers}, body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)});
  let value = null;
  if (response.ok) { try { value = await response.json(); } catch { value = null; } } else await closeBody(response);
  return {status: response.status, ok: response.ok, value};
}

/**
 * Asks Convai for a Stripe checkout page for one plan. {ok: true, url} or {ok: false, reason} where reason is 'invalid-key' (401/403),
 * 'refused' (another 4xx), 'unavailable' (5xx), 'unreachable' (no answer) or 'bad-answer' (no usable https Stripe/Convai address).
 */
export async function requestCheckout({key, priceId, config = resolvePaidTier(), fetchImpl = globalThis.fetch, timeoutMs = 15_000}) {
  const base = convaiUrl(config.paymentBase);
  if (!base || typeof key !== 'string' || !key || !PRICE_ID.test(priceId ?? '')) return {ok: false, reason: 'refused'};
  const body = {price_id: priceId};
  if (config.successUrl) body.success_url = config.successUrl;
  if (config.cancelUrl) body.cancel_url = config.cancelUrl;
  let answer;
  try { answer = await postJson(fetchImpl, base + config.checkoutPath, {headers: {'CONVAI-API-KEY': key, Source: 'cyberpunk-convai-mod'}, body, timeoutMs}); }
  catch { return {ok: false, reason: 'unreachable'}; }
  if (answer.status === 401 || answer.status === 403) return {ok: false, reason: 'invalid-key'};
  if (answer.status >= 500) return {ok: false, reason: 'unavailable'};
  if (!answer.ok) return {ok: false, reason: 'refused'};
  const url = safeCheckoutUrl(plain(answer.value) ? answer.value.checkout_url : null);
  return url ? {ok: true, url} : {ok: false, reason: 'bad-answer'};
}

/**
 * The plan of the account behind `key`: {plan, expiresAt, paid}, or null when it could not be read. Only these fields are kept; the
 * rest of Convai's answer (it includes the account's e-mail address and the key itself) is dropped here and never stored.
 */
export async function readPlanState({key, config = resolvePaidTier(), fetchImpl = globalThis.fetch, timeoutMs = 10_000, now = Date.now}) {
  const base = convaiUrl(config.paymentBase);
  if (!base || typeof key !== 'string' || !key) return null;
  for (const path of config.detailsPaths) {
    let answer;
    try { answer = await postJson(fetchImpl, base + path, {body: {api_key: key}, timeoutMs}); } catch { return null; }
    if (answer.status === 404 || answer.status === 405) continue;
    if (!answer.ok || !plain(answer.value)) return null;
    const details = answer.value;
    if (details.STATUS !== undefined && details.STATUS !== 'Successful') return null;
    const plan = typeof details.plan_name === 'string' ? details.plan_name.trim().slice(0, 64) : null;
    // Convai writes times as "YYYY-MM-DDTHH:MM:SS" without a zone (UTC in its database); read them as UTC, not as local time.
    const rawExpiry = typeof details.expiry_ts === 'string' ? details.expiry_ts.trim().slice(0, 40) : null;
    const expiry = rawExpiry && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(rawExpiry) ? rawExpiry.replace(' ', 'T') + 'Z' : rawExpiry;
    const expiresAt = expiry && Number.isFinite(Date.parse(expiry)) ? new Date(Date.parse(expiry)).toISOString() : null;
    const current = !expiresAt || Date.parse(expiresAt) > now();
    return {plan: plan || null, expiresAt, paid: isPaidPlanName(plan) && current};
  }
  return null;
}

/** The plan list the sign-in backend publishes (GET {url}), or null. Read on demand, never more than every ten minutes. */
export async function fetchPlanOverride({url, fetchImpl = globalThis.fetch, timeoutMs = 6000}) {
  if (typeof url !== 'string' || !hostOf(url)) return null;
  try {
    const response = await fetchImpl(url, {method: 'GET', redirect: 'error', cache: 'no-store', headers: {Accept: 'application/json'},
      signal: AbortSignal.timeout(timeoutMs)});
    if (!response.ok) { await closeBody(response); return null; }
    const value = await response.json();
    return plain(value) && plain(value.config) ? value.config : null;
  } catch { return null; }
}

export function parsePaidTierCommand(raw, now = Date.now()) {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw, 'utf8') > COMMAND_MAX_BYTES) return null;
  let value; try { value = JSON.parse(raw); } catch { return null; }
  if (!plain(value) || value.version !== 1 || !COMMAND_ID.test(value.id ?? '') || !ACTIONS.has(value.action)
      || !Number.isFinite(value.issuedAt) || value.issuedAt > now + 5000 || now - value.issuedAt > COMMAND_MAX_AGE_MS) return null;
  if (value.action === 'buy' && !PLAN_ID.test(value.plan ?? '')) return null;
  return {id: value.id, action: value.action, ...(value.action === 'buy' ? {plan: value.plan} : {})};
}

// After the checkout page opens: every 6 s for the first minute, then every 20 s, five minutes at most. Paying takes a minute or two,
// and Convai activates the plan about 15 s after the payment.
export const WATCH = Object.freeze({fastMs: 6000, fastForMs: 60_000, slowMs: 20_000, totalMs: 300_000});

// Conversation connections a player's own key may hold at once on a paid Gamer plan (Convai: 6). A free, unknown or unread plan has one.
export const PAID_CONNECTIONS = 6;
// The plan behind a player's key in use: read on demand (when the key is in use and the last answer is missing, for another key,
// or older than six hours), never per frame. A failed read retries after ten minutes; an answer older than twelve hours is not trusted.
export const PLAN_TIMING = Object.freeze({refreshMs: 6 * 3600_000, trustMs: 12 * 3600_000, retryMs: 600_000});

/** File IPC between the settings page (mod/convai-paid-tier.lua) and Convai. The key never enters either file. */
export class PaidTierControl {
  /**
   *   keys         ConvaiKeys (bridge/convai-key.mjs): its saved player key is the one used; the shared key is never touched
   *   commandPath  runtime/paid-tier-command.json      publish  (value) => Promise, writes runtime/paid-tier-state.json
   *   plansUrl     the backend's GET /api/convai/plans, or null (the built-in plans)
   *   wantPlan     () => boolean: the player's key is the one in use, so its plan decides how many connections it may hold
   *   signIn       Sign in with Convai (bridge/convai-signin.mjs): () => {opened, key, cancel}. `opened` settles once Convai's login
   *                page was asked to open, `key` with the player's key when the sign-in ends (or a SignInError code), `cancel` ends it.
   *                Absent, "Sign in with Convai" opens the key page instead and the player pastes the key.
   *   saveKey      async (key) => void, saves a key from signIn the way Paste does (the bridge passes the own-key path)
   *   validate     async (key) => 'valid' | 'invalid' | 'unknown' (convai-key.mjs validateKey); a key Convai refuses is not saved
   */
  constructor({keys, commandPath, publish, plansUrl = null, openBrowser = openInBrowser, fetchImpl = globalThis.fetch, read = path => readFile(path, 'utf8'),
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, watch = WATCH, planTiming = PLAN_TIMING, wantPlan = () => false,
    signIn = null, saveKey = null, validate = null, log = () => {}} = {}) {
    if (!keys || typeof commandPath !== 'string' || typeof publish !== 'function') throw Error('Invalid paid tier configuration');
    Object.assign(this, {keys, commandPath, publish, plansUrl, openBrowser, fetchImpl, read, now, setTimer, clearTimer, watchTiming: watch,
      planTiming, wantPlan, signIn: typeof signIn === 'function' ? signIn : null, saveKey: typeof saveKey === 'function' ? saveKey : null,
      validate: typeof validate === 'function' ? validate : null, log});
    this.config = resolvePaidTier();
    this.overrideAt = null; this.observed = ''; this.busy = false; this.closed = false; this.writing = Promise.resolve();
    this.result = null; this.plan = null; this.planAt = null; this.planFor = null; this.watch = null; this.timer = null;
    this.planReading = null; this.planRetryAt = 0; this.wasPaid = false; this.signInSession = null;
  }
  /**
   * Whether the player's saved key is on a paid plan now: the last answer was for this very key, says paid, has not expired and is
   * at most twelve hours old. Synchronous and memory-only (asked before each conversation request). Anything else: false.
   */
  paidPlanActive() {
    const key = this.keys.player, plan = this.plan, now = this.now();
    if (!key || !plan?.paid || this.planFor !== key || this.planAt === null || now - this.planAt > this.planTiming.trustMs) return false;
    return !plan.expiresAt || Date.parse(plan.expiresAt) > now;
  }
  /** Connections the player's key may hold at once: PAID_CONNECTIONS on a confirmed paid plan, else one. */
  connectionLimit() { return this.paidPlanActive() ? PAID_CONNECTIONS : 1; }
  #planDue() {
    if (this.closed || this.planReading || !this.keys.player || this.now() < this.planRetryAt) return false;
    let wanted = false; try { wanted = !!this.wantPlan(); } catch { wanted = false; }
    return wanted && (this.planFor !== this.keys.player || this.planAt === null || this.now() - this.planAt > this.planTiming.refreshMs);
  }
  #notePaid() {
    const paid = this.paidPlanActive();
    if (paid !== this.wasPaid) this.log(paid ? `paid Convai plan: up to ${PAID_CONNECTIONS} conversations at once` : 'Convai plan: one conversation at a time');
    this.wasPaid = paid;
  }
  // Starts one background plan read when one is due. Never awaited by the caller's tick.
  #readPlanIfDue() {
    if (!this.#planDue()) return;
    this.planReading = this.#readPlan()
      .then(state => { this.planRetryAt = state ? 0 : this.now() + this.planTiming.retryMs; })
      .catch(() => { this.planRetryAt = this.now() + this.planTiming.retryMs; })
      .then(() => { this.#notePaid(); return this.publishStatus(); })
      .catch(() => {})
      .finally(() => { this.planReading = null; });
  }
  async open() {
    this.observed = await this.read(this.commandPath).catch(() => '');
    await this.publishStatus();
    return this;
  }
  status() {
    const plans = this.config.plans.map(({priceId, ...shown}) => shown);
    return {version: 1, updated: this.now(), keySaved: !!this.keys.player, plans,
      ...(this.plan ? {plan: {name: this.plan.plan, paid: this.plan.paid, checkedAt: this.planAt}} : {}),
      ...(this.watch ? {watch: {state: this.watch.state, plan: this.watch.planId, startedAt: this.watch.startedAt}} : {}),
      ...(this.result ? {result: this.result} : {})};
  }
  publishStatus() {
    this.writing = this.writing.catch(() => {}).then(() => this.publish(this.status()));
    return this.writing;
  }
  async poll() {
    if (this.closed) return;
    this.#readPlanIfDue();
    if (this.busy) return;
    const raw = await this.read(this.commandPath).catch(() => '');
    if (raw === this.observed) return;
    this.observed = raw;
    const command = parsePaidTierCommand(raw, this.now());
    if (!command) return;
    this.busy = true;
    try {
      this.result = {id: command.id, state: 'working'};
      await this.publishStatus();
      const state = await this.run(command);
      // A sign-in that already ended (its outcome came in while this command finished) keeps that outcome.
      if (this.result?.id !== command.id || this.result.state === 'working') this.result = {id: command.id, state};
    } catch (error) {
      this.log('paid tier: ' + (error?.code ?? 'error'));
      this.result = {id: command.id, state: 'failed'};
    } finally { this.busy = false; }
    await this.publishStatus();
  }
  async #loadOverride() {
    if (!this.plansUrl || (this.overrideAt !== null && this.now() - this.overrideAt < 600_000)) return;
    this.overrideAt = this.now();
    const override = await fetchPlanOverride({url: this.plansUrl, fetchImpl: this.fetchImpl});
    if (override) this.config = resolvePaidTier(override);
  }
  async #readPlan() {
    const key = this.keys.player;
    if (!key) { this.plan = null; this.planAt = null; return null; }
    const state = await readPlanState({key, config: this.config, fetchImpl: this.fetchImpl, now: this.now});
    // A read that failed forgets the last answer: the key falls back to one conversation at a time until a read succeeds.
    if (state) { this.plan = state; this.planAt = this.now(); this.planFor = key; }
    else { this.plan = null; this.planAt = null; this.planFor = null; }
    this.#notePaid();
    return state;
  }
  async run(command) {
    switch (command.action) {
      case 'refresh': {
        await this.#loadOverride();
        // The plan is read when the page opens, at most once a minute.
        if (this.keys.player && (this.planAt === null || this.now() - this.planAt > 60_000)) await this.#readPlan();
        else if (!this.keys.player) { this.plan = null; this.planAt = null; this.planFor = null; this.#notePaid(); }
        return 'ready';
      }
      case 'check': {
        if (!this.keys.player) return 'no-key';
        const state = await this.#readPlan();
        if (!state) return 'unknown';
        if (state.paid && this.watch?.state === 'watching') this.#finishWatch('active');
        return state.paid ? 'active' : 'not-yet';
      }
      case 'manage': return await this.#openPage(this.config.manageUrl);
      case 'key-page': return await this.#openPage(this.config.keyPageUrl);
      case 'sign-in': return await this.#startSignIn(command.id);
      case 'buy': return await this.#buy(command.plan);
      default: return 'failed';
    }
  }
  // Sign in with Convai: opens Convai's login page and returns 'signing-in' at once, so other commands are not held up while the player
  // signs in. The outcome arrives later as this command's result: 'saved' (the key went through saveKey, the same path as Paste),
  // 'invalid-key', 'signin-timeout' or 'signin-failed'. A new sign-in cancels one still waiting. Without a sign-in, the key page opens.
  async #startSignIn(id) {
    if (!this.signIn || !this.saveKey) return await this.#openPage(this.config.keyPageUrl);
    this.#cancelSignIn();
    let session;
    try { session = this.signIn(); } catch { return 'signin-failed'; }
    if (!session || typeof session.then === 'function' || !session.opened || !session.key) return 'signin-failed';
    this.signInSession = session;
    try { await session.opened; } catch (error) {
      if (this.signInSession === session) this.signInSession = null;
      return error?.code === 'open-failed' ? 'open-failed' : 'signin-failed';
    }
    session.key.then(async key => {
      const verdict = this.validate ? await this.validate(key).catch(() => 'unknown') : 'unknown';
      if (verdict === 'invalid') return 'invalid-key';
      await this.saveKey(key);
      return 'saved';
    }, error => error?.code === 'cancelled' ? null : error?.code === 'timeout' ? 'signin-timeout' : 'signin-failed')
      .catch(() => 'signin-failed')
      .then(state => {
        if (this.signInSession !== session) return;
        this.signInSession = null;
        if (!state || this.closed) return;
        this.log(state === 'saved' ? 'Convai sign-in: key saved' : 'Convai sign-in: ' + state);
        // Only this command's own result is replaced: a later command (the page reopening) keeps its answer.
        if (!this.result || this.result.id === id) this.result = {id, state};
        void this.publishStatus().catch(() => {});
      });
    return 'signing-in';
  }
  #cancelSignIn() {
    const session = this.signInSession;
    this.signInSession = null;
    try { session?.cancel?.(); } catch { /* already over */ }
  }
  async #openPage(url) {
    const safe = convaiUrl(url);
    if (!safe) return 'failed';
    try { await this.openBrowser(safe); return 'opened'; } catch { return 'open-failed'; }
  }
  async #buy(planId) {
    const key = this.keys.player;
    if (!key) return 'no-key';
    await this.#loadOverride();
    const plan = this.config.plans.find(item => item.id === planId);
    if (!plan) return 'no-plan';
    // What the account had before, so a renewal or an upgrade is told apart from the plan it already has.
    const before = await readPlanState({key, config: this.config, fetchImpl: this.fetchImpl, now: this.now});
    const checkout = await requestCheckout({key, priceId: plan.priceId, config: this.config, fetchImpl: this.fetchImpl});
    if (!checkout.ok) return checkout.reason;
    try { await this.openBrowser(checkout.url); } catch { return 'open-failed'; }
    this.#startWatch(plan.id, before);
    return 'opened';
  }
  #startWatch(planId, before) {
    this.#stopTimer();
    this.watch = {state: 'watching', planId, startedAt: this.now(), before: before ? {plan: before.plan, expiresAt: before.expiresAt, paid: before.paid} : null};
    this.#schedule();
  }
  #schedule() {
    if (this.closed || this.watch?.state !== 'watching') return;
    const elapsed = this.now() - this.watch.startedAt, timing = this.watchTiming;
    if (elapsed >= timing.totalMs) { this.#finishWatch('timeout'); void this.publishStatus().catch(() => {}); return; }
    const delay = elapsed < timing.fastForMs ? timing.fastMs : timing.slowMs;
    this.timer = this.setTimer(() => { this.timer = null; void this.#watchStep(); }, delay);
    this.timer?.unref?.();
  }
  async #watchStep() {
    if (this.closed || this.watch?.state !== 'watching') return;
    const before = this.watch.before;
    const state = await this.#readPlan().catch(() => null);
    if (this.closed || this.watch?.state !== 'watching') return;
    const changed = state?.paid && (!before || !before.paid || state.plan !== before.plan || state.expiresAt !== before.expiresAt);
    if (changed) { this.#finishWatch('active'); await this.publishStatus().catch(() => {}); return; }
    this.#schedule();
  }
  #finishWatch(state) {
    this.#stopTimer();
    if (this.watch) this.watch = {...this.watch, state, endedAt: this.now()};
  }
  #stopTimer() { if (this.timer) { this.clearTimer(this.timer); this.timer = null; } }
  /** Service shutdown: no timer survives it. */
  close() { this.closed = true; this.#stopTimer(); this.#cancelSignIn(); }
}

/** The backend's plan list address for a sign-in backend token URL (…/api/convai/token -> …/api/convai/plans), or null. */
export function plansUrlFor(tokenUrl) {
  try {
    const url = new URL(tokenUrl);
    if (url.protocol !== 'https:') return null;
    return new URL('/api/convai/plans', url.origin).href;
  } catch { return null; }
}
