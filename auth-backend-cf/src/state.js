// The counters of the token endpoint, kept in a SQLite-backed Durable Object's key-value storage (the free plan has no other kind).
// This is the Worker's counterpart of auth-backend/api/_lib/admit.js (the Lua script): the same checks in the same order with the
// same limits, the same keys' lifetimes, and the same verdict codes. One StateEngine lives in one Durable Object, which runs one
// request at a time, and admit() is additionally serialised in code, so a request is counted atomically exactly as the script was.
//
// Storage use per token request: one batched read of 10 keys and one batched write of the 3 or 4 that changed. Every record carries an
// `exp` (ms) and is ignored once it has passed; expired records are swept at most every 6 hours (one listing).
import { CAP_BOUNDS, CAP_KEY, validCap } from './config.js';

export const PLANS_KEY = 'cfg:paidPlans';
export const SHARED_KEY = 'shared';
const SWEEP_KEY = 'meta:sweep';
const SWEEP_EVERY_MS = 6 * 3_600_000;
const SEEN_TTL_MS = 3_024_000_000; // 35 days: an install is "known" for five weeks after its last request
const SEEN_REFRESH_AFTER_MS = 86_400_000; // the marker is rewritten at most once a day (the script rewrote it every time)

/** A record that has not expired, else null. */
export const live = (record, now) => (record && typeof record === 'object' && typeof record.exp === 'number' && record.exp > now ? record : null);

/** Splits a list into pieces of at most 128: the most keys one storage call takes. */
export function chunks(list, size = 128) {
  const pieces = [];
  for (let at = 0; at < list.length; at += size) pieces.push(list.slice(at, at + size));
  return pieces;
}

/** Deletes every record under `prefixes` (or all records) whose `exp` has passed. */
export async function sweepExpired(storage, now, prefixes = [undefined]) {
  const stale = [];
  for (const prefix of prefixes) {
    const all = await storage.list(prefix ? { prefix } : {});
    for (const [key, record] of all) {
      if (record && typeof record === 'object' && typeof record.exp === 'number' && record.exp <= now) stale.push(key);
    }
  }
  for (const piece of chunks(stale)) await storage.delete(piece);
  return stale.length;
}

export class StateEngine {
  #storage;
  #chain = Promise.resolve();

  constructor(storage) {
    this.#storage = storage;
  }

  #exclusive(work) {
    const run = this.#chain.then(work);
    this.#chain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * The whole admission decision for one token request. `p`: {now, ipKey, installKey, hour, day, ipPerHour, installPerHour,
   * newInstallsPerIpPerDay, dailyTurnCap, turns, mode, marginMs, mintsPerDay}.
   * Returns {code, turns, extra, limit, shared}: the script's {code, turnsToday, extra, limit} plus `shared`, the stored shared token
   * ("expiresMs|token", or '') so the caller can still serve it when the mint budget is spent or a mint fails.
   * Codes: rate_ip, rate_install, new_install_limit, daily (extra: the install's cached token, deleted here), cached (extra:
   * "expiresMs|token"), ok (shared token still fine; extra is it), mint, busy.
   */
  admit(p) {
    return this.#exclusive(async () => {
      const now = p.now;
      const key = {
        ip: `ip:${p.ipKey}:${p.hour}`, install: `in:${p.installKey}:${p.hour}`, seen: `seen:${p.installKey}`,
        ipnew: `ipnew:${p.ipKey}:${p.day}`, turns: `turns:${p.day}:${p.installKey}`, mint: `mint:${p.day}`,
        token: `tok:${p.installKey}`, cap: CAP_KEY, shared: SHARED_KEY, sweep: SWEEP_KEY,
      };
      const got = await this.#storage.get(Object.values(key));
      const writes = {}, deletes = [];
      const bump = (name, ttlSeconds) => {
        const current = live(got.get(name), now);
        const record = { n: (current?.n ?? 0) + 1, exp: current ? current.exp : now + ttlSeconds * 1000 };
        got.set(name, record);
        writes[name] = record;
        return record.n;
      };
      const finish = async result => {
        if (Object.keys(writes).length) await this.#storage.put(writes);
        for (const piece of chunks(deletes)) await this.#storage.delete(piece);
        const swept = got.get(key.sweep);
        if (!(swept && typeof swept.n === 'number' && now >= swept.n && now - swept.n < SWEEP_EVERY_MS)) {
          await sweepExpired(this.#storage, now);
          await this.#storage.put(key.sweep, { n: now });
        }
        return result;
      };

      const sharedRecord = live(got.get(key.shared), now);
      const shared = typeof sharedRecord?.v === 'string' ? sharedRecord.v : '';
      const early = (code) => finish({ code, turns: 0, extra: '', limit: 0, shared });

      if (bump(key.ip, 7200) > p.ipPerHour) return early('rate_ip');
      if (bump(key.install, 7200) > p.installPerHour) return early('rate_install');
      const seen = live(got.get(key.seen), now);
      if (!seen) {
        // A new install: it counts once against its address for the day, and is not remembered when the address is over its limit.
        if (bump(key.ipnew, 172_800) > p.newInstallsPerIpPerDay) return early('new_install_limit');
        writes[key.seen] = { exp: now + SEEN_TTL_MS };
      } else if (seen.exp < now + SEEN_TTL_MS - SEEN_REFRESH_AFTER_MS) {
        writes[key.seen] = { exp: now + SEEN_TTL_MS };
      }

      let cap = p.dailyTurnCap;
      const storedCap = got.get(key.cap)?.n;
      if (Number.isInteger(storedCap) && storedCap >= CAP_BOUNDS.min && storedCap <= CAP_BOUNDS.max) cap = storedCap;
      const turnsRecord = live(got.get(key.turns), now);
      const turns = (turnsRecord?.n ?? 0) + p.turns;
      writes[key.turns] = { n: turns, exp: turnsRecord ? turnsRecord.exp : now + 259_200_000 };

      const perInstall = p.mode === 'per-install';
      const cachedRecord = perInstall ? live(got.get(key.token), now) : null;
      const cached = typeof cachedRecord?.v === 'string' ? cachedRecord.v : null;
      if (turns >= cap) {
        if (cached) deletes.push(key.token);
        return finish({ code: 'daily', turns, extra: cached ?? '', limit: cap, shared });
      }
      if (cached) {
        const bar = cached.indexOf('|');
        if (bar >= 0) {
          const expires = Number(cached.slice(0, bar));
          if (Number.isFinite(expires) && expires - p.marginMs > now) return finish({ code: 'cached', turns, extra: cached, limit: cap, shared });
        }
      }
      if (!perInstall) {
        const expires = Number(shared.slice(0, Math.max(0, shared.indexOf('|'))));
        if (shared.includes('|') && Number.isFinite(expires) && expires - p.marginMs > now) {
          return finish({ code: 'ok', turns, extra: shared, limit: cap, shared });
        }
      }
      if (bump(key.mint, 172_800) > p.mintsPerDay) return finish({ code: 'busy', turns, extra: '', limit: cap, shared });
      return finish({ code: 'mint', turns, extra: '', limit: cap, shared });
    });
  }

  /** Per-install mode: keeps an install's token until it expires (best effort on the caller's side). */
  async saveToken({ now, installKey, expiresAtMs, token, lifetimeSeconds }) {
    await this.#storage.put(`tok:${installKey}`, { v: `${expiresAtMs}|${token}`, exp: now + lifetimeSeconds * 1000 });
  }

  /** Shared mode: keeps the one token for everybody until it expires, so every isolate of the Worker shares one mint. */
  async saveShared({ expiresAtMs, token }) {
    await this.#storage.put(SHARED_KEY, { v: `${expiresAtMs}|${token}`, exp: expiresAtMs });
  }

  /** The admin turns report: the day's per-install totals, the number of installs reporting, and the mints attempted. */
  async turns({ day, limit }) {
    const rows = await this.#storage.list({ prefix: `turns:${day}:` });
    const installs = [];
    for (const [key, record] of rows) installs.push({ install: key.slice(`turns:${day}:`.length), turns: Number(record?.n) || 0 });
    installs.sort((a, b) => b.turns - a.turns || (a.install < b.install ? -1 : 1));
    const mints = await this.#storage.get(`mint:${day}`);
    return { top: installs.slice(0, limit), installsReporting: installs.length, tokenMintsAttempted: Number(mints?.n) || 0 };
  }

  async getConfig() {
    const got = await this.#storage.get([CAP_KEY, PLANS_KEY]);
    return { cap: validCap(got.get(CAP_KEY)?.n), plans: typeof got.get(PLANS_KEY)?.v === 'string' ? got.get(PLANS_KEY).v : null };
  }

  /** `cap`: undefined (no change), null (remove) or a number. `plans`: undefined, null or a JSON text already validated. */
  async setConfig({ cap, plans }) {
    if (cap === null) await this.#storage.delete(CAP_KEY);
    else if (cap !== undefined) await this.#storage.put(CAP_KEY, { n: cap });
    if (plans === null) await this.#storage.delete(PLANS_KEY);
    else if (plans !== undefined) await this.#storage.put(PLANS_KEY, { v: plans });
    return this.getConfig();
  }

  async getPlans() {
    return (await this.#storage.get(PLANS_KEY))?.v ?? null;
  }

  async ping() {
    await this.#storage.get('meta:ping');
    return 'PONG';
  }
}
