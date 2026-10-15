// The Convai paid tier's plan list (docs/CONVAI_PAID_TIER.md), so prices and Stripe price ids can change without a mod update.
//
//   POST /api/admin/config {"paidPlans": {...}}   store a list (admin secret; {"paidPlans": null} removes it)
//   GET  /api/convai/plans                         public: {config: <stored list> | null}; null means "use the list built into the mod"
//
// Only public data lives here: plan names, prices and Stripe *price* ids (which Stripe shows on every checkout page). No key, no
// secret. The mod checks everything again (bridge/convai-paid-tier.mjs) and only ever sends the player's key to a convai.com host.
import { readConfig } from './config.js';
import { sendJson } from './http.js';
import { createUpstashStore } from './store.js';

export const PLANS_KEY = 'cfg:paidPlans';
const PLAN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PRICE_ID = /^price_[A-Za-z0-9]{8,64}$/;
const PRICE = /^[$€£]?\d{1,4}(?:[.,]\d{2})?(?:\s?(?:USD|EUR|GBP|[$€£]))?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,31}$/;
const PATH = /^\/[A-Za-z0-9/_-]{1,80}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const convaiUrl = value => {
  if (typeof value !== 'string' || value.length > 300) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && (host === 'convai.com' || host.endsWith('.convai.com')) ? url.href.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
};
const count = (value, max) => (Number.isSafeInteger(value) && value > 0 && value <= max ? value : undefined);

/**
 * The list as it may be stored, or null when it is not acceptable as a whole: 1 to 8 plans, each id and each price id used once (a
 * copy error must never put two prices on one charge), optional convai.com https addresses, nothing else kept.
 */
export function validPaidPlans(value) {
  if (!plain(value) || !Array.isArray(value.plans) || value.plans.length < 1 || value.plans.length > 8) return null;
  const ids = new Set(), prices = new Set(), plans = [];
  for (const item of value.plans) {
    if (!plain(item) || !PLAN_ID.test(item.id ?? '') || !NAME.test(item.name ?? '') || !['monthly', 'yearly'].includes(item.period)
        || typeof item.price !== 'string' || !PRICE.test(item.price.trim()) || !PRICE_ID.test(item.priceId ?? '')) return null;
    if (ids.has(item.id) || prices.has(item.priceId)) return null;
    ids.add(item.id); prices.add(item.priceId);
    const interactions = count(item.interactions, 10_000_000), concurrency = count(item.concurrency, 1000);
    plans.push({ id: item.id, name: item.name, period: item.period, price: item.price.trim(), priceId: item.priceId,
      ...(interactions ? { interactions } : {}), ...(concurrency ? { concurrency } : {}) });
  }
  const result = { plans };
  for (const name of ['paymentBase', 'manageUrl', 'keyPageUrl', 'successUrl', 'cancelUrl']) {
    if (value[name] === undefined) continue;
    const url = convaiUrl(value[name]);
    if (!url) return null;
    result[name] = url;
  }
  if (value.checkoutPath !== undefined) {
    if (typeof value.checkoutPath !== 'string' || !PATH.test(value.checkoutPath)) return null;
    result.checkoutPath = value.checkoutPath;
  }
  if (value.detailsPaths !== undefined) {
    if (!Array.isArray(value.detailsPaths) || value.detailsPaths.length < 1 || value.detailsPaths.length > 3
        || !value.detailsPaths.every(path => typeof path === 'string' && PATH.test(path))) return null;
    result.detailsPaths = [...value.detailsPaths];
  }
  return result;
}

/** A stored value (JSON text) read back: the list, or null for nothing stored or anything no longer valid. */
export function storedPaidPlans(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return validPaidPlans(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * GET /api/convai/plans. One store read, kept for a minute per warm instance, so a busy caller costs nothing extra. Never touches
 * Convai. Without a store (not configured, or down) it answers {config: null} and the mod keeps its built-in list.
 */
export function createPlansHandler(options = {}) {
  const getEnv = () => options.env ?? process.env;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 60_000;
  let cached = null; // {at, config}
  return async function plansHandler(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      return;
    }
    if (cached && now() - cached.at < cacheMs && now() >= cached.at) {
      sendJson(response, 200, { version: 1, config: cached.config });
      return;
    }
    const config = readConfig(getEnv());
    let stored = null;
    if (options.store || (config.storeUrl && config.storeToken)) {
      try {
        const store = options.store ?? createUpstashStore({ url: config.storeUrl, token: config.storeToken, fetchImpl: options.fetchImpl ?? fetch });
        stored = storedPaidPlans(await store.command(['GET', PLANS_KEY]));
        cached = { at: now(), config: stored };
      } catch {
        stored = null; // not cached: the next caller tries the store again
      }
    }
    sendJson(response, 200, { version: 1, config: stored });
  };
}
