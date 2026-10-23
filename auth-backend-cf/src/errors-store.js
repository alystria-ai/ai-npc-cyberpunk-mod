// The error reports' store, in its own SQLite-backed Durable Object (ERRORS). The Worker's counterpart of REPORT_SCRIPT in
// auth-backend/api/_lib/errors.js: the same checks in the same order (address counter, the install's duplicate check, the install's
// daily count, the index, then the body when the day's budget allows), the same majority vote for what a signature is, the same
// pinned earliest samples and the same caps. Bodies arrive already packed (base64 gzip) and are only moved.
//
// Records (all in the Durable Object's key-value storage; the `exp` of a record is when it is ignored and swept):
//   er:ip:<address hash>:<hour>       {n, exp}              reports from one address this hour
//   er:in:<install hash>:<day>        {n, sigs[], exp}      reports from one install today, and the signatures it already sent
//   er:day:<day>                      {n, exp}              bodies wanted today (the day's budget)
//   er:i:<signature>                  the index: kind, message, frame, votes, first, last, count, stored, versions{}, ids[] (newest first), exp
//   er:r:<signature>:<id>             {v: base64 gzip, exp} one kept body
//   er:sigs                           {m: {signature: last seen ms}}  every signature (the sorted set of the Redis version)
import { chunks, live, sweepExpired } from './state.js';

export const SIGNATURES_KEY = 'er:sigs';
export const indexKey = signature => `er:i:${signature}`;
export const bodyKey = (signature, id) => `er:r:${signature}:${id}`;
const SWEEP_KEY = 'er:meta:sweep';
const SWEEP_EVERY_MS = 6 * 3_600_000;
// HLEN of the Redis hash before any version field: first, kind, message, frame, votes, last, count (+ stored once a body was kept).
const FIXED_FIELDS = 7;

export class ErrorsEngine {
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
   * One report. `p`: {now, ipKey, installKey, hour, day, ipPerHour, installPerDay, storePerDay, samples, ttlSeconds, signature, kind,
   * message, frame, version, id, kept, cutoffMs, maxSignatures, maxFields, pinned}.
   * Returns {code, count}: rate_ip, duplicate, rate_install, counted (index updated, body not kept) or stored.
   */
  report(p) {
    return this.#exclusive(async () => {
      const now = p.now;
      const ipKey = `er:ip:${p.ipKey}:${p.hour}`, installKey = `er:in:${p.installKey}:${p.day}`, dayKey = `er:day:${p.day}`;
      const sigKey = indexKey(p.signature);
      const got = await this.#storage.get([ipKey, installKey, dayKey, sigKey, SIGNATURES_KEY, SWEEP_KEY]);
      const writes = {}, deletes = [];
      const bump = (name, ttlSeconds) => {
        const current = live(got.get(name), now);
        const record = { n: (current?.n ?? 0) + 1, exp: current ? current.exp : now + ttlSeconds * 1000 };
        writes[name] = record;
        return record.n;
      };
      const done = async result => {
        if (Object.keys(writes).length) await this.#storage.put(writes);
        for (const piece of chunks(deletes)) await this.#storage.delete(piece);
        const swept = got.get(SWEEP_KEY);
        if (!(swept && typeof swept.n === 'number' && now >= swept.n && now - swept.n < SWEEP_EVERY_MS)) {
          await sweepExpired(this.#storage, now, ['er:ip:', 'er:in:', 'er:day:']);
          await this.#storage.put(SWEEP_KEY, { n: now });
        }
        return result;
      };

      if (bump(ipKey, 7200) > p.ipPerHour) return done({ code: 'rate_ip', count: 0 });
      const install = live(got.get(installKey), now);
      if (install?.sigs?.includes(p.signature)) return done({ code: 'duplicate', count: 0 });
      const today = (install?.n ?? 0) + 1;
      const installRecord = { n: today, sigs: install?.sigs ?? [], exp: install ? install.exp : now + 172_800_000 };
      writes[installKey] = installRecord;
      if (today > p.installPerDay) return done({ code: 'rate_install', count: 0 });
      installRecord.sigs = [...installRecord.sigs, p.signature];
      const keep = bump(dayKey, 172_800) <= p.storePerDay;

      // The index. What the signature is (kind, message, frame) is the value most reports agree on, not the first writer's: a running
      // majority vote (one candidate and a counter), so one early forged report cannot fix the text for good.
      const old = live(got.get(sigKey), now);
      const index = old ? { ...old, versions: { ...old.versions }, ids: [...old.ids] }
        : { first: now, kind: null, message: '', frame: '', votes: 0, last: now, count: 0, stored: 0, versions: {}, ids: [], exp: 0 };
      if (index.kind === null) {
        Object.assign(index, { kind: p.kind, message: p.message, frame: p.frame, votes: 1 });
      } else if (index.kind === p.kind && index.message === p.message && index.frame === p.frame) {
        index.votes += 1;
      } else {
        const votes = index.votes - 1;
        if (votes <= 0) Object.assign(index, { kind: p.kind, message: p.message, frame: p.frame, votes: 1 });
        else index.votes = votes;
      }
      index.last = now;
      index.count += 1;
      if (keep) index.stored += 1;
      const field = p.version;
      const fields = FIXED_FIELDS + (index.stored > 0 ? 1 : 0) + Object.keys(index.versions).length;
      if (field in index.versions || fields < p.maxFields) index.versions[field] = (index.versions[field] ?? 0) + 1;
      index.exp = now + p.ttlSeconds * 1000;

      if (keep) {
        writes[bodyKey(p.signature, p.id)] = { v: p.kept }; // no `exp`: a body goes with its index or when it is pushed out
        index.ids.unshift(p.id);
        // Over the limit: drop the oldest body that is not one of the pinned earliest (the pinned ones sit at the tail).
        while (index.ids.length > p.samples) {
          const [victim] = index.ids.splice(index.ids.length - 1 - p.pinned, 1);
          deletes.push(bodyKey(p.signature, victim));
          delete writes[bodyKey(p.signature, victim)];
        }
        const oldestAllowed = String(p.cutoffMs).padStart(13, '0');
        while (index.ids.length && index.ids.at(-1).slice(0, 13) < oldestAllowed) {
          const oldest = index.ids.pop();
          deletes.push(bodyKey(p.signature, oldest));
          delete writes[bodyKey(p.signature, oldest)];
        }
      }
      writes[sigKey] = index;

      // The list of signatures: this one now, the expired ones out, and at most `maxSignatures` (the least recently seen go first).
      const map = { ...(got.get(SIGNATURES_KEY)?.m ?? {}), [p.signature]: now };
      const dropped = [];
      for (const [signature, last] of Object.entries(map)) if (last < p.cutoffMs) dropped.push(signature);
      for (const signature of dropped) delete map[signature];
      const listed = Object.entries(map);
      if (listed.length > p.maxSignatures) {
        listed.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
        for (const [signature] of listed.slice(0, listed.length - p.maxSignatures)) {
          dropped.push(signature);
          delete map[signature];
        }
      }
      writes[SIGNATURES_KEY] = { m: map };
      for (const signature of dropped) {
        if (signature === p.signature) continue;
        const gone = await this.#storage.get(indexKey(signature));
        deletes.push(indexKey(signature));
        for (const id of gone?.ids ?? []) deletes.push(bodyKey(signature, id));
      }
      return done({ code: keep ? 'stored' : 'counted', count: index.count });
    });
  }

  /** The signatures seen since `minLastMs`, newest first, at most `limit`, each with its index record: [{signature, score, record}], and the total. */
  async list({ now, limit, minLastMs }) {
    const map = (await this.#storage.get(SIGNATURES_KEY))?.m ?? {};
    const entries = Object.entries(map).filter(([, last]) => last >= minLastMs)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
    const rows = [];
    for (const piece of chunks(entries.slice(0, limit))) {
      const got = await this.#storage.get(piece.map(([signature]) => indexKey(signature)));
      for (const [signature, last] of piece) rows.push({ signature, score: last, record: live(got.get(indexKey(signature)), now) });
    }
    return { total: entries.length, rows };
  }

  /** One kept body (base64 gzip text), or null. */
  async body({ signature, id }) {
    return (await this.#storage.get(bodyKey(signature, id)))?.v ?? null;
  }

  /** Forgets one body: 1 when something was removed, else 0. */
  async deleteBody({ signature, id }) {
    return this.#exclusive(async () => {
      const removed = await this.#storage.delete(bodyKey(signature, id));
      const index = await this.#storage.get(indexKey(signature));
      let listed = false;
      if (index?.ids?.includes(id)) {
        listed = true;
        await this.#storage.put(indexKey(signature), { ...index, ids: index.ids.filter(other => other !== id) });
      }
      return removed || listed ? 1 : 0;
    });
  }

  /** Forgets a signature: its index, its bodies and its place in the list. True when something was removed. */
  async deleteSignature({ signature }) {
    return this.#exclusive(async () => {
      const index = await this.#storage.get(indexKey(signature));
      const keys = [indexKey(signature), ...(index?.ids ?? []).map(id => bodyKey(signature, id))];
      let removed = false;
      for (const piece of chunks(keys)) if (await this.#storage.delete(piece) > 0) removed = true;
      const listed = await this.#storage.get(SIGNATURES_KEY);
      let inList = false;
      if (listed?.m && signature in listed.m) {
        inList = true;
        const { [signature]: ignored, ...rest } = listed.m;
        await this.#storage.put(SIGNATURES_KEY, { m: rest });
      }
      return removed || inList;
    });
  }

  async ping() {
    await this.#storage.get('er:meta:ping');
    return 'PONG';
  }
}
