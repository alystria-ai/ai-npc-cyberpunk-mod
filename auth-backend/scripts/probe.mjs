#!/usr/bin/env node
// Sends ONE correctly signed token request to a deployed backend and prints what came back, without ever printing the token.
// A successful run asks Convai for a token (or reuses the cached one), so it is a live call: run it only against your own
// deployment. Usage:
//   node auth-backend/scripts/probe.mjs https://<your-host>/api/convai/token --secret-file auth-backend/secrets/signing.secret [--turns 0] [--install <uuid>]
// The install id defaults to a fresh random one (so it counts as a new install for the address, once).
import {createHmac, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';

const args = process.argv.slice(2);
const url = args.find(arg => /^https?:\/\//.test(arg));
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const secretFile = option('--secret-file');
if (!url || !secretFile) { console.error('Usage: probe.mjs <token-url> --secret-file <file> [--turns N] [--install UUID]'); process.exit(2); }
const secret = readFileSync(secretFile, 'utf8').trim();
const body = JSON.stringify({installId: option('--install') ?? randomUUID(), modVersion: option('--version') ?? '0.0.0-probe',
  turnsSinceLast: Number(option('--turns') ?? 0), minLifeSeconds: 900});
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
const response = await fetch(url, {method: 'POST', headers: {'content-type': 'text/plain; charset=utf-8',
  'x-convai-timestamp': timestamp, 'x-convai-signature': signature}, body, signal: AbortSignal.timeout(20000)});
let data = null;
try { data = await response.json(); } catch { /* not JSON */ }
const {authToken, ...rest} = data ?? {};
console.log(JSON.stringify({status: response.status, tokenReceived: typeof authToken === 'string' && authToken.length > 0,
  tokenLength: typeof authToken === 'string' ? authToken.length : 0, ...rest}, null, 2));
process.exitCode = response.ok ? 0 : 1;
