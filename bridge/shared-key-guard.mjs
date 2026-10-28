// The one limit on conversation turns that are paid for by the project's shared Convai key (never a player's own key, Local AI,
// Mistral or Custom, which get no limit from us at all).
//
//   * Daily cap: DAILY_LIMIT turns per local calendar day per installation (the day rolls over at local midnight). It is the ONLY
//     limit, and it counts everything that goes to Convai on the shared key, once per provider interaction, in RealtimeHost: a spoken
//     or typed turn, a phone message, a group speaker (look-ahead turns included, they are real responses), a call, a ride or
//     threat answer and every automatic reaction (Johnny's remarks, a companion speaking up, battle and loot comments). Opening or
//     warming a connection is not a turn. There are no shares for kinds of turns and no rate limit between turns.
//   * The count is kept in two signed copies (the bridge state folder and a second folder under the player's profile)
//     so deleting one file does not reset it. An unreadable, unsigned or edited copy is ignored: with none left the
//     count starts at 0 (a damaged file never blocks a player).
//
// Honest limits: the bridge ships as readable source, so someone who edits it, sets CYBERPUNK_CONVAI_DAILY_LIMIT=off in
// a copy they run themselves, or deletes both counter copies is not stopped. This raises the cost of casual abuse; it
// is not a defence against a determined one.
import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {readFile, writeFile, rename, rm, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {hostname, userInfo} from 'node:os';

export const DAILY_LIMIT = 500;       // turns per local day on the shared key until the sign-in backend says otherwise (auth-backend/ POST /api/admin/config)
export const LIMIT_MIN = 1, LIMIT_MAX = 10_000;  // the range of a limit the backend may set; the same bounds as auth-backend/api/_lib/config.js
export const LIMIT_MARKER = /\[convai-quota:daily\]/;

/** Thrown before a turn reaches Convai when the day's turns on the shared key are used up. `kind` is always 'daily'; the marker lets convai-quota.mjs classify it. */
export class TurnLimitError extends Error {
  constructor() {
    super('Daily conversation limit reached [convai-quota:daily]');
    this.name = 'TurnLimitError'; this.kind = 'daily';
  }
}

/** A daily limit the backend sent, as a whole number in [LIMIT_MIN, LIMIT_MAX], or null for anything else (missing, fractional, text, out of range). */
export const sanitizeLimit = value => {
  const number = typeof value === 'string' && /^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : value;
  return Number.isSafeInteger(number) && number >= LIMIT_MIN && number <= LIMIT_MAX ? number : null;
};

const PEPPER = 'cyberpunk-convai/usage/v1';
const pad = value => String(value).padStart(2, '0');
/** The local calendar day of `ms`, as YYYY-MM-DD. */
export const dayOf = ms => { const date = new Date(ms); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };

/** A stable per-computer string: the Windows machine GUID when readable, else the host and user names. */
export async function machineId({exec = execFile, timeoutMs = 3000} = {}) {
  const guid = await new Promise(resolve => {
    try {
      exec('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        {timeout: timeoutMs, windowsHide: true, encoding: 'utf8'}, (error, stdout) => resolve(error ? '' : /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(String(stdout))?.[1] ?? ''));
    } catch { resolve(''); }
  });
  let user = ''; try { user = userInfo().username; } catch { /* no user name */ }
  return guid || `${hostname()}|${user}`;
}

const mac = (secret, record) => createHmac('sha256', secret).update(`${record.v}|${record.day}|${record.count}|${record.seen}`).digest('hex');

function verified(text, secret) {
  try {
    const record = JSON.parse(text);
    if (record?.v !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(record.day) || !Number.isSafeInteger(record.count) || record.count < 0
        || !Number.isSafeInteger(record.seen) || typeof record.mac !== 'string' || record.mac.length !== 64) return null;
    const expected = Buffer.from(mac(secret, record), 'hex'), actual = Buffer.from(record.mac, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? {day: record.day, count: record.count, seen: record.seen} : null;
  } catch { return null; }
}

/** The counter on disk: the same signed record in every path. Reads never throw; a write that fails is ignored. */
export class UsageStore {
  constructor({paths, machine, read = path => readFile(path, 'utf8'), write = UsageStore.writeFile} = {}) {
    Object.assign(this, {paths: [...paths], read, write});
    this.secret = createHash('sha256').update(`${PEPPER}|${machine}`).digest();
  }
  static async writeFile(path, text) {
    await mkdir(dirname(path), {recursive: true});
    const temporary = `${path}.${process.pid}.tmp`;
    try { await writeFile(temporary, text, 'utf8'); await rename(temporary, path); }
    catch (error) { await rm(temporary, {force: true}).catch(() => {}); throw error; }
  }
  /** The newest valid record of any copy (later day first, then higher count), or null when none is valid. */
  async load() {
    const found = [];
    for (const path of this.paths) {
      let text; try { text = await this.read(path); } catch { continue; }
      const record = verified(text, this.secret);
      if (record) found.push(record);
    }
    return found.sort((a, b) => b.day.localeCompare(a.day) || b.count - a.count)[0] ?? null;
  }
  async save(record) {
    const body = {v: 1, day: record.day, count: record.count, seen: record.seen};
    const text = JSON.stringify({...body, mac: mac(this.secret, body)}) + '\n';
    await Promise.all(this.paths.map(path => this.write(path, text).catch(() => {})));
  }
}

/** The last daily limit the backend reported, kept in one signed file so a restart (or an unreachable backend) keeps the number the
 * player was last told. Reads never throw; a bad, unsigned or out-of-range file is ignored (the built-in DAILY_LIMIT applies). */
export class LimitStore {
  constructor({path, machine, read = file => readFile(file, 'utf8'), write = UsageStore.writeFile} = {}) {
    Object.assign(this, {path, read, write});
    this.secret = createHash('sha256').update(`${PEPPER}|limit|${machine}`).digest();
  }
  #mac(limit) { return createHmac('sha256', this.secret).update(`limit|${limit}`).digest('hex'); }
  async load() {
    try {
      const record = JSON.parse(await this.read(this.path));
      const limit = sanitizeLimit(record?.limit);
      if (limit === null || record?.v !== 1 || typeof record.mac !== 'string' || record.mac.length !== 64) return null;
      const expected = Buffer.from(this.#mac(limit), 'hex'), actual = Buffer.from(record.mac, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected) ? limit : null;
    } catch { return null; }
  }
  async save(limit) {
    const value = sanitizeLimit(limit);
    if (value === null) return;
    await this.write(this.path, JSON.stringify({v: 1, limit: value, mac: this.#mac(value)}) + '\n').catch(() => {});
  }
}

/**
 * The guard. `applies()` says whether the key in use is the shared one (false: nothing is counted or limited).
 * `limit` <= 0 turns the whole guard off (development). Methods are synchronous; saving is queued in the background.
 */
export class SharedKeyGuard {
  constructor({store, limit = DAILY_LIMIT, applies = () => true, now = Date.now, onChange = () => {}, onLimit = () => {}, limitStore, pinned = false} = {}) {
    Object.assign(this, {store, limit, applies, now, onChange, onLimit, limitStore, pinned});
    this.day = dayOf(now()); this.count = 0; this.seen = now();
    this.saving = Promise.resolve();
  }
  get enabled() { return this.limit > 0; }
  /** The backend's daily limit (docs/CONVAI_AUTH_BACKEND.md). Ignored when the guard is off or the limit is pinned by the developer's
   * environment variable, and for a value outside the accepted range. Returns true when the limit changed. Nothing here touches the
   * disk or the network except the queued save of the new value. */
  setLimit(value) {
    const next = sanitizeLimit(value);
    if (next === null || !this.enabled || this.pinned || next === this.limit) return false;
    this.limit = next;
    if (this.limitStore) this.saving = this.saving.then(() => this.limitStore.save(next)).catch(() => {});
    try { this.onLimit(next); } catch { /* an observer never stops a turn */ }
    return true;
  }
  /** Reads the saved count. Without a valid copy the count is 0. */
  async load() {
    const record = this.store ? await this.store.load().catch(() => null) : null;
    if (record) { this.day = record.day; this.count = record.count; this.seen = record.seen; this.#roll(); }
    return this;
  }
  // The day only moves forward: a clock set back does not return yesterday's allowance.
  #roll() {
    const now = this.now(), today = dayOf(Math.max(now, this.seen));
    if (today !== this.day && today > this.day) { this.day = today; this.count = 0; }
    this.seen = Math.max(this.seen, now);
  }
  /** Throws TurnLimitError when the day's turns are used up. Counts nothing. */
  check() {
    if (!this.enabled || !this.applies()) return;
    this.#roll();
    if (this.count >= this.limit) throw new TurnLimitError('daily');
  }
  /** Records a turn that is going to Convai. */
  consume() {
    if (!this.enabled || !this.applies()) return;
    this.#roll();
    this.count += 1;
    this.saving = this.saving.then(() => this.store?.save({day: this.day, count: this.count, seen: this.seen})).catch(() => {});
    try { this.onChange(); } catch { /* an observer never stops a turn */ }
  }
  /** check() then consume(): for a turn that is complete when it is sent. */
  admit() { this.check(); this.consume(); }
  /** For the settings page, or null when the guard is not limiting the key in use. */
  snapshot() {
    if (!this.enabled || !this.applies()) return null;
    this.#roll();
    return {limit: this.limit, left: Math.max(0, this.limit - this.count), blocked: this.count >= this.limit};
  }
  /** Resolves when queued saves have finished (tests, shutdown). */
  flush() { return this.saving; }
}

/** The cap for this run: CYBERPUNK_CONVAI_DAILY_LIMIT = a number of turns, or off/0/none to switch the guard off.
 * Unset: `fallback` (the full cap for the project's packaged key, off for a plain developer or player key file). */
export function limitFromEnvironment(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const text = value.trim().toLowerCase();
  if (['off', 'none', 'false', 'no', 'unlimited'].includes(text)) return 0;
  return /^\d{1,6}$/.test(text) ? Number(text) : fallback;
}
