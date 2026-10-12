import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { signBody } from '../api/_lib/crypto.js';
import { createTokenHandler } from '../api/_lib/token-handler.js';
import { FakeStore, createFakeConvai } from './fake-store.mjs';

// Fake secrets only. Nothing here is, or looks enough like, a real credential to be one.
export const FAKE_API_KEY = 'fake-convai-api-key-for-tests-0000';
export const SIGNING_SECRET = 'signing-secret-for-tests-'.padEnd(48, 'x');
export const ADMIN_SECRET = 'admin-secret-for-tests-'.padEnd(48, 'y');
export const START = Date.UTC(2026, 9, 14, 10, 0, 0);

export function makeEnv(extra = {}) {
  return {
    CONVAI_API_KEY: FAKE_API_KEY,
    CONVAI_AUTH_SIGNING_SECRET: SIGNING_SECRET,
    CONVAI_AUTH_ADMIN_SECRET: ADMIN_SECRET,
    UPSTASH_REDIS_REST_URL: 'https://store.invalid',
    UPSTASH_REDIS_REST_TOKEN: 'fake-store-token',
    // Wide limits unless a test narrows one, so each test exercises one protection.
    CONVAI_AUTH_INSTALL_PER_HOUR: '100',
    CONVAI_AUTH_IP_PER_HOUR: '1000',
    CONVAI_AUTH_NEW_INSTALLS_PER_IP_PER_DAY: '1000',
    CONVAI_AUTH_MINTS_PER_DAY: '1000',
    ...extra,
  };
}

export function mockResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    text: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(text = '') { this.text = text; },
  };
  Object.defineProperty(response, 'json', { get() { return JSON.parse(this.text); } });
  return response;
}

/** A world: a clock, a store, a Convai, and a handler wired to them. */
export function createWorld(envExtra = {}, { handlerOptions = {} } = {}) {
  const clock = { now: START };
  const now = () => clock.now;
  const store = new FakeStore({ now });
  const convai = createFakeConvai({ now });
  const env = makeEnv(envExtra);
  const handler = createTokenHandler({ env, store, fetchImpl: convai.fetchImpl, now, ...handlerOptions });
  const world = {
    clock, store, convai, env, handler,
    advance(ms) { clock.now += ms; },
    /** Sends one correctly signed request (the fields can be overridden to test the refusals). */
    async send(fields = {}) {
      const body = fields.body ?? JSON.stringify({
        installId: fields.installId ?? world.defaultInstall,
        modVersion: fields.version ?? '0.2',
        turnsSinceLast: fields.turns ?? 0,
      });
      const timestamp = fields.timestamp ?? String(Math.floor(clock.now / 1000));
      const request = {
        method: fields.method ?? 'POST',
        headers: {
          'x-convai-timestamp': timestamp,
          'x-convai-signature': fields.signature ?? signBody(SIGNING_SECRET, timestamp, body),
          'x-vercel-forwarded-for': fields.ip ?? '203.0.113.7',
          ...(fields.headers ?? {}),
        },
        body,
      };
      const response = mockResponse();
      await world.handler(request, response);
      return response;
    },
    defaultInstall: randomUUID(),
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

export function streamedRequest(body, headers) {
  const stream = Readable.from([Buffer.from(body)]);
  stream.method = 'POST';
  stream.headers = headers;
  return stream;
}
