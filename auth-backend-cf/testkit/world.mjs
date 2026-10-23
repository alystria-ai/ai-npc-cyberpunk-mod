// A world for the Worker's tests: a clock, an in-memory stand-in for a Durable Object's storage, a fake Convai, and the router wired to
// them. Fake secrets only: nothing here is, or looks enough like, a real credential to be one.
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { signBody } from '../src/crypto.js';
import { ErrorsEngine } from '../src/errors-store.js';
import { StateEngine } from '../src/state.js';

export const FAKE_API_KEY = 'fake-convai-api-key-for-tests-0000';
export const SIGNING_SECRET = 'signing-secret-for-tests-'.padEnd(48, 'x');
export const REPORT_SECRET = 'report-secret-for-tests-'.padEnd(48, 'r');
export const PSEUDONYM_SECRET = 'pseudonym-secret-for-tests-'.padEnd(48, 'p');
export const ADMIN_SECRET = 'admin-secret-for-tests-'.padEnd(48, 'y');
export const START = Date.UTC(2026, 9, 14, 10, 0, 0);
export const asAdmin = { authorization: `Bearer ${ADMIN_SECRET}` };

/** The part of a Durable Object's storage API the engines use (get/put/delete/list, one key or many), over a Map, with the same copy semantics and the 128-key limit. */
export class MemoryStorage {
  data = new Map();
  calls = { get: 0, put: 0, delete: 0, list: 0 };

  async get(keys) {
    this.calls.get += 1;
    if (Array.isArray(keys)) {
      if (keys.length > 128) throw new Error('get takes at most 128 keys');
      return new Map(keys.filter(key => this.data.has(key)).map(key => [key, structuredClone(this.data.get(key))]));
    }
    return this.data.has(keys) ? structuredClone(this.data.get(keys)) : undefined;
  }

  async put(keyOrEntries, value) {
    this.calls.put += 1;
    const entries = typeof keyOrEntries === 'string' ? { [keyOrEntries]: value } : keyOrEntries;
    if (Object.keys(entries).length > 128) throw new Error('put takes at most 128 entries');
    for (const [key, item] of Object.entries(entries)) this.data.set(key, structuredClone(item));
  }

  async delete(keys) {
    this.calls.delete += 1;
    if (Array.isArray(keys)) {
      if (keys.length > 128) throw new Error('delete takes at most 128 keys');
      return keys.filter(key => this.data.delete(key)).length;
    }
    return this.data.delete(keys);
  }

  async list({ prefix = '' } = {}) {
    this.calls.list += 1;
    return new Map([...this.data].filter(([key]) => key.startsWith(prefix)).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, item]) => [key, structuredClone(item)]));
  }
}

/** A stand-in for a Durable Object stub: the engine's methods, called with a structured copy of the arguments, as an RPC would. */
function stubOf(engine) {
  return new Proxy({}, {
    get: (target, method) => async (...args) => engine[method](...args.map(argument => structuredClone(argument))),
  });
}

export function createFakeConvai({ now = () => Date.now(), lifetimeMs = 3_600_000 } = {}) {
  const state = { mints: 0, revokes: [], failing: false, calls: [] };
  const fetchImpl = async (url, init = {}) => {
    state.calls.push({ url: String(url), headers: init.headers, body: init.body });
    if (state.failing) return new Response('{}', { status: 500 });
    if (String(url).endsWith('/user/connect')) {
      state.mints += 1;
      return Response.json({ apiAuthToken: `fake-token-${state.mints}`, expirationTime: new Date(now() + lifetimeMs).toISOString() });
    }
    if (String(url).endsWith('/user/revoke-token')) {
      state.revokes.push(JSON.parse(init.body).apiAuthToken);
      return Response.json({});
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, state };
}

export function makeEnv(extra = {}) {
  return {
    CONVAI_API_KEY: FAKE_API_KEY,
    CONVAI_AUTH_SIGNING_SECRET: SIGNING_SECRET,
    ERROR_REPORT_SECRET: REPORT_SECRET,
    CONVAI_AUTH_PSEUDONYM_SECRET: PSEUDONYM_SECRET,
    CONVAI_AUTH_ADMIN_SECRET: ADMIN_SECRET,
    // Wide limits unless a test narrows one, so each test exercises one protection.
    CONVAI_AUTH_INSTALL_PER_HOUR: '100',
    CONVAI_AUTH_IP_PER_HOUR: '1000',
    CONVAI_AUTH_NEW_INSTALLS_PER_IP_PER_DAY: '1000',
    CONVAI_AUTH_MINTS_PER_DAY: '1000',
    ...extra,
  };
}

/** The result of a request, read once: status, headers (lower-case names) and the JSON body (null when there is none). */
async function settle(response) {
  const text = await response.text();
  return { status: response.status, headers: Object.fromEntries(response.headers), text, json: text ? JSON.parse(text) : null };
}

export const hex = (number, length) => number.toString(16).padStart(length, '0');
export const installHash = number => hex(number, 32);
export const signatureOf = number => hex(number, 16);
export const DEFAULT_ADDRESS = '203.0.113.7';

export function createWorld(envExtra = {}, { appOptions = {} } = {}) {
  const clock = { now: START };
  const now = () => clock.now;
  const stateStorage = new MemoryStorage(), errorsStorage = new MemoryStorage();
  const stateEngine = new StateEngine(stateStorage), errorsEngine = new ErrorsEngine(errorsStorage);
  const convai = createFakeConvai({ now });
  const env = makeEnv(envExtra);
  const handle = createApp({ now, fetchImpl: convai.fetchImpl, stateFor: () => stubOf(stateEngine), errorsFor: () => stubOf(errorsEngine), ...appOptions });
  const world = {
    stubFor: stubOf, clock, stateStorage, errorsStorage, stateEngine, errorsEngine, convai, env, handle,
    advance(ms) { clock.now += ms; },
    /** Any request to the router. */
    async call(path, { method = 'GET', headers = {}, body, ip = DEFAULT_ADDRESS, envOverride } = {}) {
      const request = new Request(`https://backup.example.invalid${path}`, {
        method, headers: { 'cf-connecting-ip': ip, ...headers }, ...(body === undefined ? {} : { body }),
      });
      return settle(await handle(request, envOverride ?? env));
    },
    /** One correctly signed token request (the fields can be overridden to test the refusals). */
    async send(fields = {}) {
      const body = fields.body ?? JSON.stringify({
        installId: fields.installId ?? world.defaultInstall,
        modVersion: fields.version ?? '0.2',
        turnsSinceLast: fields.turns ?? 0,
        ...(fields.minLife === undefined ? {} : { minLifeSeconds: fields.minLife }),
      });
      const timestamp = fields.timestamp ?? String(Math.floor(clock.now / 1000));
      return world.call('/api/convai/token', {
        method: fields.method ?? 'POST', body: (fields.method ?? 'POST') === 'POST' ? body : undefined, ip: fields.ip,
        headers: { 'x-convai-timestamp': timestamp, 'x-convai-signature': fields.signature ?? await signBody(SIGNING_SECRET, timestamp, body), ...(fields.headers ?? {}) },
        envOverride: fields.env,
      });
    },
    defaultInstall: randomUUID(),
    /** A valid error report body; `fields` overrides (a field set to undefined is left out). */
    reportBody(fields = {}) {
      const body = { schema: 1, install: installHash(1), signature: signatureOf(1), kind: 'bridge-crash', message: 'the bridge stopped',
        frame: 'bridge/x.mjs:10', modVersion: '0.2.9', report: { detail: 'detail' }, ...fields };
      for (const [name, value] of Object.entries(body)) if (value === undefined) delete body[name];
      return body;
    },
    /** POSTs one signed error report. */
    async report(fields = {}, options = {}) {
      const body = options.rawBody ?? JSON.stringify(world.reportBody(fields));
      const timestamp = options.timestamp ?? String(Math.floor(clock.now / 1000));
      return world.call('/api/errors/report', {
        method: 'POST', body, ip: options.ip,
        headers: { 'x-convai-timestamp': timestamp, 'x-convai-signature': options.signature ?? await signBody(REPORT_SECRET, timestamp, body) },
      });
    },
  };
  return world;
}

/** Runs `fn` while recording everything written with console.error, so tests can prove secrets never reach a log. */
export async function captureErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...parts) => { lines.push(parts.map(String).join(' ')); };
  try { await fn(); } finally { console.error = original; }
  return lines.join('\n');
}
