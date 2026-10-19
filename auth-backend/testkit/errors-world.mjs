// A world for the error-report tests: a clock, a fake Redis, and the report and admin handlers wired to them (the counterpart of
// createWorld in harness.mjs for the token endpoint). Fake secrets only: the ones from harness.mjs.
import { signBody } from '../api/_lib/crypto.js';
import { createAdminErrorsHandler } from '../api/_lib/errors-admin.js';
import { createErrorReportHandler } from '../api/_lib/errors.js';
import { FakeStore } from './fake-store.mjs';
import { ADMIN_SECRET, SIGNING_SECRET, START, makeEnv, mockResponse } from './harness.mjs';

// Test identifiers are built from a number, so no long hex literal ever sits in the source.
const hex = (number, length) => number.toString(16).padStart(length, '0');
export const installHash = number => hex(number, 32);
export const signatureOf = number => hex(number, 16);
export const DEFAULT_ADDRESS = '203.0.113.7';
export const asAdmin = { authorization: `Bearer ${ADMIN_SECRET}` };

export function createErrorWorld(envExtra = {}, { handlerOptions = {} } = {}) {
  const clock = { now: START };
  const now = () => clock.now;
  const store = new FakeStore({ now });
  const env = makeEnv(envExtra);
  const handler = createErrorReportHandler({ env, store, now, ...handlerOptions });
  const admin = createAdminErrorsHandler({ env, store, now });
  const world = {
    clock, store, env, handler, admin,
    advance(ms) { clock.now += ms; },
    /** A valid report body; `fields` overrides (a field set to undefined is left out). */
    body(fields = {}) {
      return {
        schema: 1,
        install: installHash(1),
        signature: signatureOf(1),
        kind: 'lua-error',
        message: 'attempt to index a nil value (field x)',
        frame: 'mod/example.lua:12',
        modVersion: '0.2.2',
        count: 1,
        report: { note: 'opaque to the server', lines: ['one', 'two'] },
        ...fields,
      };
    },
    /** Sends one correctly signed report (`extra` overrides the raw body, the headers, the address or the method to test refusals). */
    async send(fields = {}, extra = {}) {
      const body = extra.body ?? JSON.stringify(world.body(fields));
      const timestamp = extra.timestamp ?? String(Math.floor(clock.now / 1000));
      const request = {
        method: extra.method ?? 'POST',
        headers: {
          'x-convai-timestamp': timestamp,
          'x-convai-signature': extra.signature ?? signBody(SIGNING_SECRET, timestamp, body),
          'x-vercel-forwarded-for': extra.ip ?? DEFAULT_ADDRESS,
          ...(extra.headers ?? {}),
        },
        body,
      };
      const response = mockResponse();
      await world.handler(request, response);
      return response;
    },
    /** One admin call (the admin secret unless `headers` says otherwise). */
    async ask(url, { method = 'GET', headers = asAdmin } = {}) {
      const response = mockResponse();
      await world.admin({ method, url, headers }, response);
      return response;
    },
    /** The keys the store holds, and everything in them as plain text (hash fields and values, list items, set members). */
    contents() {
      const lines = [];
      for (const [key, entry] of world.store.data) {
        lines.push(key);
        const value = entry.value;
        if (typeof value === 'string') lines.push(value);
        else if (Array.isArray(value)) lines.push(...value);
        else if (value instanceof Map) for (const [field, item] of value) lines.push(String(field), String(item));
      }
      return lines.join('\n');
    },
  };
  return world;
}
