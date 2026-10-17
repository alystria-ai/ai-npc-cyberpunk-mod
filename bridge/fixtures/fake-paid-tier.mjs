// Test double for convai-paid-tier.mjs (loaded in its place by fake-hooks.mjs): the real module, except that the plan is never
// read from Convai's payment service. The connection limit is whatever FAKE_PAID_CONNECTIONS says (one when unset), which is
// what a player's key on a free (1) or a confirmed paid Gamer plan (6) would give.
import {PaidTierControl as RealPaidTierControl} from '../convai-paid-tier.mjs';
export * from '../convai-paid-tier.mjs';

export class PaidTierControl extends RealPaidTierControl {
  connectionLimit() { return Number(process.env.FAKE_PAID_CONNECTIONS) || 1; }
  async poll() { /* no plan read, no command file */ }
}
