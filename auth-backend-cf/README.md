# Backup sign-in backend on Cloudflare Workers

The same sign-in service as `auth-backend/` (Vercel), on Cloudflare Workers' free plan. Players in Russia and China often cannot reach `*.vercel.app`, and since 0.2.9 the Runtime ships no Convai key, so for them Convai sign-in fails. The mod tries the Vercel backend first and this Worker second (the client side is in `bridge/convai-credential.mjs`, `bridge/error-reports.mjs`).

**Same API, same answers.** Same paths (`/api/convai/token`, `/api/errors/report`, `/api/convai/plans`, `/api/admin/turns`, `/api/admin/config`, `/api/admin/errors`, `/api/readyz`, `/api/healthz`), same requests and responses, same limits, same error codes, same request signature (HMAC-SHA256 over `timestamp.body`, `v1=` prefix). `auth-backend/README.md` describes every call and every protection; it all applies here. `test/parity.test.mjs` runs the same random requests through both servers and compares status and body (the Vercel side uses the real Redis Lua script on the Lua VM), so the two cannot drift apart unnoticed. The one visible difference is a response header, `X-Auth-Backend: cloudflare-worker`.

```
src/index.js         entry point (wrangler.toml: main)
src/app.js           router, no cloudflare imports, so node can test it
src/token.js         POST /api/convai/token
src/errors.js        POST /api/errors/report and GET/DELETE /api/admin/errors
src/admin.js         admin turns, admin config, readyz, healthz
src/plans.js         the paid tier's plan list (validation + the public GET)
src/state.js         the counters (admission decision), in the STATE Durable Object
src/errors-store.js  the error reports' store, in the ERRORS Durable Object
src/do.js            the two Durable Object classes (thin wrappers)
src/config.js, crypto.js (WebCrypto), http.js, convai.js, version.js
test/, testkit/      node --test, no dependencies
```

## Design decisions

- **Storage: two SQLite-backed Durable Objects** (the only kind the free plan has), one for the token counters (`STATE`), one for the error reports (`ERRORS`), each a single instance that handles one request at a time. KV is not used: its free quota is about 1,000 writes a day, and every token request writes counters. The Redis Lua script that made each admission atomic becomes `StateEngine.admit()`: one batched read, one batched write, serialised, the same checks in the same order. Every record carries an expiry and is ignored after it; expired records are swept at most every 6 hours.
- **Signing and hashing: WebCrypto** (`crypto.subtle`), no Node modules. The client address is `CF-Connecting-IP` (set by Cloudflare, not by the caller); `X-Forwarded-For` is not trusted.
- **The shared Convai token is kept in the STATE object**, so every Worker isolate shares one mint (the Vercel version holds it per warm instance). Per-install mode works too (`CONVAI_AUTH_MODE=per-install`).
- **Counters are separate from Vercel's. Decision: each server has its own budgets and counters.** Sharing them would put Vercel (or its Redis) in the critical path of the server that exists for when Vercel is unreachable. The consequences, accepted:
  - Mint budget (`CONVAI_AUTH_MINTS_PER_DAY`, default 500) is per server: at most 500 mints a day on each, in practice about 24 each (one token an hour, shared). Lower it on the Worker if you want a smaller total.
  - The per-install daily turn cap (default 100) is counted by whichever server an install talks to. An install that uses both on one day could report up to twice the cap. The bridge's own gate and the client's turn count are what players meet; the server cap is a backstop for honest clients, as `auth-backend/README.md` says, and a modified client was never bound by it.
  - The stored daily limit and the paid plan list (`POST /api/admin/config`) are per server: **send a change to both** (or set `CONVAI_AUTH_DAILY_TURN_CAP` in `wrangler.toml` for the default).
  - Hourly and per-address limits are per server. A caller who alternates servers gets each server's allowance; the new-installs-per-address limit and the hourly limits still bound each.
- **Error reports are stored in the Worker** (the `ERRORS` object, same limits, same majority vote for what a signature is, same pinned earliest samples, bodies kept as base64 gzip). They are not forwarded to Vercel: Vercel would see the Worker's address for every forwarded report and its per-address limit would then throttle all of them together. `scripts/Fetch-ErrorReports.mjs --backup-url https://<worker>` reads both servers into one folder and one index (see "Reading the error reports").
- **Secrets: use the same values as Vercel** for `CONVAI_AUTH_SIGNING_SECRET` and `ERROR_REPORT_SECRET` (the client signs once, whichever server it reaches; a different value would mean 401 from this server). `CONVAI_AUTH_PSEUDONYM_SECRET` and `CONVAI_AUTH_ADMIN_SECRET` may be the same or different; the same pseudonym secret gives the same install hashes on both servers, so one blocklist (`CONVAI_AUTH_BLOCKED_INSTALLS`) and one admin view fit both, and the same admin secret lets one fetch command read both.

## Does it fit the free plan?

Limits as Cloudflare publishes them for the free plan (check the dashboard; they change): Workers 100,000 requests a day and 10 ms CPU per request, 50 subrequests per request; Durable Objects (SQLite) 100,000 requests a day, 100,000 rows written and 5,000,000 rows read a day, 5 GB stored.

| What | Cost per request | Limit | Reached at |
|---|---|---|---|
| Worker requests | 1 per call | 100,000 / day | about 33,000 players a day (about 3 token calls each) |
| Durable Object requests | 1 per token call or report (the plans list is cached a minute) | 100,000 / day | about 33,000 players a day |
| Rows written | token call: the address and install counters, the turns, sometimes the new-install marker: 3 to 4 (a mint adds 1); report: 6 to 10 | 100,000 / day | about 25,000 token calls a day, **the first limit to bind**, about 8,000 daily players |
| Rows read | about 10 per token call (one batched read), a sweep reads everything every 6 hours | 5,000,000 / day | far away |
| CPU | an HMAC or three, JSON, a gzip of at most 64 KB for a report: well under 5 ms; waiting for Convai or storage is not CPU | 10 ms | not at risk. The heaviest call is a report close to 64 KB |
| Storage | counters live 2 hours to 5 weeks and are swept; reports: at most 300 bodies a day for 30 days at about 8 KB | 5 GB | about 72 MB at the worst |

**Expected use:** this is a backup used by players who cannot reach Vercel, and by anyone while Vercel is down. If 300 players use it a day that is about 1,000 requests, 4,000 rows written and a handful of reports: 1% of each limit. If the free quota ever runs out, the Worker answers with errors until the next UTC day, the client falls back to its other server or to a non-Convai provider as it does for any outage, and nothing is billed (the free plan has no overage).

## Setting it up

### What the owner does (once, about ten minutes, no card needed)

1. **Make a free Cloudflare account** at dash.cloudflare.com (an email address and a password; skip any prompt to add a site or buy a plan).
2. **Log in from this folder**, in your own terminal:
   ```
   cd auth-backend-cf
   npx wrangler login
   ```
   A browser tab opens; sign in and press Allow. Nothing is stored in the repository. (`npx` downloads Wrangler, Cloudflare's own tool, the first time.)
3. **Tell me when it says you are logged in.** I run the first `npx wrangler deploy`. It will ask once to pick the free `workers.dev` name for your account (that name becomes part of the address `https://cyberpunk-convai-auth-backup.<your-name>.workers.dev`; you may have to answer that prompt yourself), creates the Worker and its two Durable Objects, and prints the address.
4. **Set the secrets, pasting the values yourself.** Each command asks for the value (nothing is echoed); use the same values as on Vercel. From `auth-backend-cf`:
   ```
   npx wrangler secret put CONVAI_API_KEY
   npx wrangler secret put CONVAI_AUTH_SIGNING_SECRET
   npx wrangler secret put ERROR_REPORT_SECRET
   npx wrangler secret put CONVAI_AUTH_PSEUDONYM_SECRET
   npx wrangler secret put CONVAI_AUTH_ADMIN_SECRET
   ```
   PowerShell can read a value from a secret file instead of pasting it: `Get-Content -Raw ..\auth-backend\secrets\signing.secret | npx wrangler secret put CONVAI_AUTH_SIGNING_SECRET`. The signing secret is the `secret` in the shipped `convai-auth.json`; the Convai key is the one the Vercel project holds. If you no longer have the pseudonym secret, any new random 32+ character value does (the install hashes then differ from Vercel's). Every secret is 32+ characters except the Convai key; the three secrets and the admin secret must differ from each other.
5. **Send me the address** printed in step 3.

### What I run

- First deploy and every later one, from `auth-backend-cf`: `npx wrangler deploy`.
- Check: `curl https://<address>/api/readyz` (must say `"status":"ready"`, `secretsSeparate: true`), `curl -H "Authorization: Bearer <admin secret>" "https://<address>/api/readyz?ping=1"`, then one real token: `node auth-backend/scripts/probe.mjs https://<address>/api/convai/token --secret-file <signing secret file>`.
- The address then goes in as the mod's second backend (the Part B change in `bridge/`, `docs/CONVAI_AUTH_BACKEND.md`).

No secret is ever written in `wrangler.toml` or anywhere in this folder (`.gitignore` also keeps `.dev.vars`, `*.secret` and `secrets/` out). `wrangler.toml` `[vars]` holds only public settings.

### Local run (optional)

`npx wrangler dev` runs the Worker and both objects on your machine with a `.dev.vars` file (git ignored) holding test values, never the real ones.

## Reading the error reports

Reports sent while a player was on the Worker are kept on the Worker. The fetch tool reads both servers into the same folder and index (a signature both servers saw is one row with the counts added):

```
node scripts/Fetch-ErrorReports.mjs --backup-url https://<worker address>
```

The first server is the one in `runtime/convai-auth.json` (or `--url`); the admin secret is the same for both unless `--backup-admin-secret-file` is given. One server being down does not stop the other (exit code 1 and a line naming it). `--delete-fetched` deletes each report on the server it came from.

## Tests

`node --test auth-backend-cf/test/` (or `node scripts/run-tests.mjs`). No download: the Durable Object storage is replaced by an in-memory stand-in with the same calls (`testkit/world.mjs`), the Convai service by a fake. `test/parity.test.mjs` needs `fengari` (already in the repository's `node_modules` for the Vercel tests) and is skipped without it. What the tests cannot show: that Cloudflare's runtime accepts the code and the free quotas are what is published. The first deploy and the probe above are that check.
