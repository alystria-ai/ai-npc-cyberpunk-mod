// Cloudflare Workers' fetch accepts only redirect 'follow' or 'manual' and throws on 'error' (Node accepts all three), so a
// redirect: 'error' passes every Node test and fails every Convai call on Cloudflare (seen at the first deploy, 2026-10-24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));

test('no fetch in the Worker asks for redirect: error', () => {
  for (const name of readdirSync(src).filter(file => file.endsWith('.js'))) {
    assert.doesNotMatch(readFileSync(src + name, 'utf8'), /redirect:\s*['"]error['"]/, name);
  }
});
