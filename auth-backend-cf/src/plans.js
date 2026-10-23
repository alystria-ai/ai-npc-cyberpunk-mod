// The Convai paid tier's plan list (docs/CONVAI_PAID_TIER.md): what may be stored, and the public GET /api/convai/plans.
// validPaidPlans and storedPaidPlans are identical to auth-backend/api/_lib/plans.js (test/parity.test.mjs compares their answers).
import { readConfig } from './config.js';
import { reply } from './http.js';

const PLAN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PRICE_ID = /^price_[A-Za-z0-9]{8,64}$/;
const PRICE = /^[$€£]?\d{1,4}(?:[.,]\d{2})?(?:\s?(?:USD|EUR|GBP|[$€£]))?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,31}$/;
const PATH = /^\/[A-Za-z0-9/_-]{1,80}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// RegExp.test turns its argument into text, so a number, a boolean or a one-item array would pass: only a real string may match.
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
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
    if (!plain(item) || !matches(PLAN_ID, item.id) || !matches(NAME, item.name) || !['monthly', 'yearly'].includes(item.period)
        || typeof item.price !== 'string' || !PRICE.test(item.price.trim()) || !matches(PRICE_ID, item.priceId)) return null;
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
 * GET /api/convai/plans. One store read, kept for a minute per warm isolate. Never touches Convai. Without a store (not bound, or
 * down) it answers {config: null} and the mod keeps its built-in list.
 */
export function createPlansHandler(deps) {
  const { now } = deps;
  const cacheMs = deps.cacheMs ?? 60_000;
  let cached = null; // {at, config}
  return async function plansHandler(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply(request, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
    }
    if (cached && now() - cached.at < cacheMs && now() >= cached.at) return reply(request, 200, { version: 1, config: cached.config });
    readConfig(env);
    let stored = null;
    const state = deps.stateFor(env);
    if (state) {
      try {
        stored = storedPaidPlans(await state.getPlans());
        cached = { at: now(), config: stored };
      } catch {
        stored = null; // not cached: the next caller tries the store again
      }
    }
    return reply(request, 200, { version: 1, config: stored });
  };
}
