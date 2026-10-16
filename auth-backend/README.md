# Convai token backend

A small Vercel service that hands the AI NPC Cyberpunk Mod a short-lived Convai auth token, so the project's permanent Convai key never ships on players' machines. The design and its research are in `docs/CONVAI_AUTH_BACKEND.md`; this folder is the built service. **It was first deployed to Vercel on 2026-10-13** (address in the project's private notes, not here; `GET /api/healthz` answers `{"status":"ok"}`), and the bridge's backend mode is switched on per machine through `runtime/convai-auth.json`. Every test in this folder still uses a fake Convai and a fake Redis; the repository never calls the live service.

```
auth-backend/
  api/convai/token.js       POST /api/convai/token   the only endpoint players' machines call
  api/admin/turns.js        GET  /api/admin/turns    per-install daily turn totals (admin secret)
  api/admin/config.js       GET/POST /api/admin/config  the daily limit and the paid tier's plans in force, and changing them (admin secret)
  api/convai/plans.js       GET  /api/convai/plans   public: the paid tier's plan list, or null (the mod's built-in list applies)
  api/healthz.js            GET  /api/healthz        always 200, touches nothing
  api/readyz.js             GET  /api/readyz         booleans: which settings are present
  api/_lib/                 the code (not deployed as functions)
  test/, testkit/           node --test suite with a fake Convai and a fake Redis
  scripts/probe.mjs         sends one signed request to a deployment (a live call, see below)
```

## What it does

1. The bridge sends `POST /api/convai/token` once when it starts and again about every 50 minutes. The body says: a random install id (UUID v4 the bridge made for itself), the mod version, and how many shared-key turns it counted since its last report. It is signed (below).
2. The service checks, in this order and in one Redis round trip: per-address and per-install hourly limits, new installs per address per day, the install's reported turns for the UTC day against the daily cap, and the global mint budget.
3. If everything passes it answers `{authToken, expiresAt, allowance}`. The token comes from Convai (`POST /user/connect` with the key, held only in a Vercel environment variable). The key is never returned and never logged; neither is a token.

## Two modes (`CONVAI_AUTH_MODE`, default `shared`)

| | `shared` (default) | `per-install` |
|---|---|---|
| Tokens | One Convai token per warm function instance, given to every install. Re-minted when 5 minutes or less remain (or 15, when a renewal asks for it, see below). | One token per install, kept in Redis for its lifetime. |
| Convai mints | Roughly one per 45 minutes per instance. | About one per install per hour. Convai documents a mint limit per key by plan and publishes no number, so this mode needs a live test first. |
| Redis commands per token request | 1 | 1 on a cache hit, 2 on a mint |
| Daily turn cap | Refuses **new tokens** to an install that reported 100 turns today. Cannot take the token away: it is everyone's token. | Same, and also calls `/user/revoke-token` on that install's cached token (once, best effort). |
| What the cap really does | Stops an honest or lazy client from renewing. A client holding a valid token keeps working until it expires (up to an hour). | Same, except the revoked token cannot start a **new** connection. |

**Revoking does not end a session already running.** Convai says a token is not checked again once a session has started, so a revoke only stops the token opening new conversations. A modified client that keeps one conversation open indefinitely is not cut off by a revoke.

Which to choose: start with `shared`. It is cheaper (half the Redis commands, a handful of Convai mints) and has no dependency on an undocumented Convai limit. Switch to `per-install` only after the live test in "What could not be verified", and if abuse shows up in `/api/admin/turns` that the `shared` mode cannot answer. The two modes are the same code path; only the env var differs.

## What each protection stops, and what it does not

The goal is **not** to make abuse impossible. Nothing a client program does can: the program that holds a token can be modified. The goal is to keep the permanent key off players' machines, bound what a scraper can get, and let you rotate the key and stop the service without a mod update.

| Protection | Stops | Does not stop |
|---|---|---|
| **Key only on the server** (Vercel env var) | Anyone recovering the permanent key from the mod files. That key could edit and delete all 308 characters. | A token itself is still a bearer credential for about an hour. |
| **Signed requests** (HMAC-SHA256 over `timestamp.body`, within 120 s) | Casual `curl`, a copied request replayed later, a request body edited in flight, a random scanner finding the URL. | Anyone who reads the bridge source: the signing secret ships in the program. **It is obfuscation, not authentication.** Rotating the secret needs a mod update. |
| **Per-install hourly limit** (default 4) | One install asking over and over. | A new install id (they cost nothing to make). |
| **Per-address hourly limit** (default 20) | One machine or network flooding with many install ids. | An attacker with many addresses (VPN, botnet), or players behind one shared address if it is set too low. |
| **New install ids per address per day** (default 5) | Minting fresh ids to dodge the per-install limit from one address. | Many addresses. LAN events with more than 5 new players behind one address in a day are told to wait. |
| **Global mints per day** (default 500) | Bounds the worst case: after 500 Convai mints in a UTC day the answer is "busy, try later" and nothing more is minted. In `shared` mode it bounds the effect of a forced-mint flood; in `per-install` mode it bounds how many installs can get tokens. | It is a ceiling, not a filter: an attacker who reaches it also locks out honest players until the next UTC day (`shared` mode still hands out the token already minted). |
| **Kill switch** (`CONVAI_AUTH_PAUSED=1`) | All new tokens, with a clean "service paused" answer, before any other work. | Tokens already handed out, and sessions already running, until they expire (up to an hour). The bridge obeys a pause; it does not fall back to the embedded key on one. |
| **Minimum mod version** (`CONVAI_AUTH_MIN_VERSION`) | A compromised or abandoned old client, cut off with an "update the mod" answer. | A modified client that sends a newer version number. |
| **Daily turn backstop** (default 100 reported turns per install per UTC day, changeable at run time: see "Changing the daily limit") | An install that reports its turns honestly: once its report reaches the cap it gets no new token until the next UTC day, and the bridge shows the same "daily limit reached" notice as the local gate. | **A modified client can report fewer turns than it makes, or none.** Turns happen between the player and Convai directly; this service never sees one. So for a modified client the real bounds are the per-install and per-address token limits, the global mint cap, and the one-hour life of a token, not this cap. |
| **Blocklist** (`CONVAI_AUTH_BLOCKED_INSTALLS`) | A named install's new tokens. | A fresh install id. |
| **Admin list** (`/api/admin/turns`) | Nothing by itself. It lets you see heavy reporters (by hash) and block them. | Installs that under-report look quiet. |
| **Fail closed** | If Redis cannot be reached, nobody gets a token. | Players already holding a token keep going until it expires. |

Two things to know about the 100 a day: the local gate in the bridge (`SharedKeyGuard`) is unchanged and counts per **local** day, while this service counts per **UTC** day, so a player far from UTC can have up to two local days' worth of turns inside one UTC day and be refused early. If that shows up, raise `CONVAI_AUTH_DAILY_TURN_CAP` (the design note suggests 150). The service also cannot tell a shared token's holders apart: in `shared` mode a refused install can still use the token it already has.

What the bridge does with each answer: a daily/rate/paused/busy/outdated/refused answer is **obeyed** (no fallback to the embedded key, turns stop with a notice). An unreachable backend, a 5xx, a 404 or a bad signature setup is treated as "the backend is down", and, while `CYBERPUNK_CONVAI_AUTH_FALLBACK` is not `0`, the embedded key stands in, reported only in `runtime/bridge.stderr.log`. Remove the embedded key in a later release and the fallback disappears with it.

## Request and answer

Request (`Content-Type: text/plain`, so the platform leaves the raw bytes alone), headers `x-convai-timestamp` (whole seconds) and `x-convai-signature` (`v1=` + hex HMAC-SHA256 of `"<timestamp>.<body>"` with the signing secret):

```json
{"installId": "<uuid v4>", "modVersion": "0.2", "turnsSinceLast": 3, "minLifeSeconds": 900}
```

`minLifeSeconds` (optional, at most 900 is honoured): "give me a token with at least this much life left". The bridge renews 8 to 10 minutes before expiry and asks for 15, so a renewal always gets a fresh token even though the server's own re-mint margin is 5 minutes.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{authToken, expiresAt, allowance:{used,limit,resetAt}, dailyInteractionLimit, serverTime, minClient?}` | A token. `dailyInteractionLimit` (same number as `allowance.limit`) is the per-install daily limit in force right now; the bridge uses it for what it enforces and shows. |
| 400 / 413 | `{error:"bad_request" \| "too_large"}` | Malformed body. |
| 401 | `{error:"unauthorized"}` or `{error:"stale", serverTime}` | Bad signature, or a clock more than 120 s off (the bridge corrects itself from `serverTime` and retries once). |
| 403 | `{error:"refused"}` | Blocked install. |
| 426 | `{error:"outdated", minClient}` | Mod too old. |
| 429 | `{error:"rate" \| "install_limit", retryAfterSeconds}` | A rate limit. |
| 429 | `{error:"daily", allowance, dailyInteractionLimit, resetAt}` | The install's reported turns reached the cap for the UTC day. |
| 502 | `{error:"convai_unavailable"}` | Convai would not mint. |
| 503 | `{error:"paused"}`, `{error:"busy"}`, `{error:"unavailable"}`, `{error:"unconfigured"}` | Kill switch, mint budget spent, Redis down, or settings missing. |

Turns are recorded when a request passes the rate limits, so a reply the client did not receive is reported again on its retry (a small over-count, in the safe direction). A request refused earlier (signature, version, kill switch, rate limit) records nothing, and the bridge keeps the count for next time.

## Settings (environment variables)

Secrets (add with `--sensitive`, values from files, see the deploy steps):

| Variable | Required | What |
|---|---|---|
| `CONVAI_API_KEY` | yes | The project's Convai key. Only ever used server side. |
| `CONVAI_AUTH_SIGNING_SECRET` | yes, 32+ characters | The request-signing secret. The same value goes into the bridge (`CYBERPUNK_CONVAI_AUTH_SECRET`, or `secret` in `runtime/convai-auth.json`). Also keys the hashes of install ids and addresses. Changing it resets all counters. |
| `CONVAI_AUTH_ADMIN_SECRET` | optional, 32+ characters | Enables `/api/admin/turns` and `/api/readyz?ping=1`. Unset: the admin endpoint answers 404. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | yes | The Redis store. The Vercel Marketplace integration may instead set `KV_REST_API_URL` and `KV_REST_API_TOKEN`; either pair works. |

Settings (all optional; defaults shown):

| Variable | Default | What |
|---|---|---|
| `CONVAI_AUTH_MODE` | `shared` | `shared` or `per-install`. |
| `CONVAI_AUTH_PAUSED` | off | `1` stops all minting: "service paused". |
| `CONVAI_AUTH_MIN_VERSION` | none | Mod versions below this get "outdated" (compared as numbers: `0.10` is above `0.9`; a `-rc` suffix is ignored). |
| `CONVAI_AUTH_INSTALL_PER_HOUR` | 4 | Token requests per install per hour. |
| `CONVAI_AUTH_IP_PER_HOUR` | 20 | Token requests per address per hour. |
| `CONVAI_AUTH_NEW_INSTALLS_PER_IP_PER_DAY` | 5 | New install ids per address per UTC day. |
| `CONVAI_AUTH_MINTS_PER_DAY` | 500 | Convai mints per UTC day, whole service. Then "busy". |
| `CONVAI_AUTH_DAILY_TURN_CAP` | 100 | Reported turns per install per UTC day before new tokens are refused (1 to 10000). This is the **default**: a value stored with `POST /api/admin/config` (below) wins over it, so changing the limit needs no redeploy. |
| `CONVAI_AUTH_REMINT_MARGIN_SECONDS` | 300 | Re-mint the cached token when this many seconds or fewer remain. |
| `CONVAI_AUTH_BLOCKED_INSTALLS` | none | Comma-separated install hashes (from the admin list) to refuse. |
| `CONVAI_CONNECT_URL`, `CONVAI_REVOKE_URL` | Convai's | Only for testing against a stand-in. |

`/api/readyz` reports, for every variable above, only whether it is set (`true`/`false`), never a value. It touches no Redis unless called as `/api/readyz?ping=1` with the admin secret, which spends exactly one `PING`. `/api/healthz` touches nothing.

## Changing the daily limit (no redeploy, no mod update)

The per-install daily limit ("Convai free tier: N turns a day") lives in the store under `cfg:dailyInteractionLimit`. Both calls need `Authorization: Bearer <CONVAI_AUTH_ADMIN_SECRET>`; the secret stays in `secrets/admin.secret`, never on a command line you share:

```
# what is in force (stored value, the environment default, the accepted range 1 to 10000)
curl -H "Authorization: Bearer $(cat secrets/admin.secret)" https://<address>/api/admin/config

# set it to 150
curl -X POST -H "Authorization: Bearer $(cat secrets/admin.secret)" -H "Content-Type: application/json" \
     -d '{"dailyInteractionLimit": 150}' https://<address>/api/admin/config

# remove the stored value: the CONVAI_AUTH_DAILY_TURN_CAP default (100 unless set) applies again
curl -X POST -H "Authorization: Bearer $(cat secrets/admin.secret)" -H "Content-Type: application/json" \
     -d '{"dailyInteractionLimit": null}' https://<address>/api/admin/config
```

On Windows PowerShell use `curl.exe` (not the `curl` alias) and `(Get-Content -Raw secrets\admin.secret).Trim()`. A number outside 1 to 10000, a fraction, text or a body without the field is refused with 400 and changes nothing. `GET /api/admin/turns` shows the limit in force as `dailyTurnCap`.

How it takes effect:

- **The server** reads the stored value inside its single admission script (no extra Redis command per request) and compares it with the install's reported turns. The new limit applies from the next token request. A value in the store that is not a whole number in range (edited by hand) is ignored and the environment default applies.
- **Players' bridges** learn it from the next token answer (`dailyInteractionLimit`, also on a "daily" refusal), within about 50 minutes, and from then on use it for the count and the notice ("{left} of {limit} left today"). A bridge that is blocked for the day asks again every half hour, so raising the limit lets it through within about 30 minutes. The last value is kept in the bridge's state folder (`daily-limit.json`, signed per computer); with no answer yet, or the backend unreachable, the bridge uses the last value it was told, then 100. A value that is missing, not a whole number or outside 1 to 10000 is ignored.
- **Lowering it** below what a player has already used today blocks that player at the next answer; their count is not reset.
- **What it does not change:** enforcement is no stronger than before. The server counts only the turns an install reports, and the bridge counts its own turns locally, so a modified client can ignore either number (see the table above). Players who never switched the backend on (`convai-auth.json`) keep the built-in 100 until they do.

## Changing the Convai paid tier's plans (no redeploy, no mod update)

The mod's Settings > Convai paid tier page (docs/CONVAI_PAID_TIER.md) has the plans built in (`DEFAULT_PAID_TIER` in `bridge/convai-paid-tier.mjs`). A list stored here under `cfg:paidPlans` replaces them for bridges that know this backend's address (backend mode on, or `CYBERPUNK_CONVAI_PLANS_URL`), read when the page opens, at most every ten minutes. Only public data: plan names, prices and Stripe *price* ids. Never a key or a secret.

```
# store a list (1 to 8 plans; ids and price ids must each be unique, or the whole list is refused)
curl -X POST -H "Authorization: Bearer $(cat secrets/admin.secret)" -H "Content-Type: application/json" \
     -d '{"paidPlans": {"plans": [
           {"id": "gamer-monthly", "name": "Gamer", "period": "monthly", "price": "$4", "priceId": "price_...", "interactions": 1000, "concurrency": 6},
           {"id": "pro-yearly", "name": "Gamer Pro", "period": "yearly", "price": "$64", "priceId": "price_..."}]}}' \
     https://<address>/api/admin/config

# remove it: the list built into the mod applies again
curl -X POST -H "Authorization: Bearer $(cat secrets/admin.secret)" -H "Content-Type: application/json" \
     -d '{"paidPlans": null}' https://<address>/api/admin/config
```

Optional fields beside `plans`: `manageUrl`, `keyPageUrl`, `paymentBase`, `successUrl`, `cancelUrl` (https on convai.com only), `checkoutPath`, `detailsPaths`. Anything else is dropped. `GET /api/admin/config` shows the stored list as `paidPlans`. `GET /api/convai/plans` is public and costs at most one Redis command per warm instance a minute; with no store, or the store down, it answers `{"config": null}`. The bridge checks every field again and never sends a player's key anywhere but a convai.com host.

## Deploy steps (all from a terminal)

You sign in to the Vercel CLI once with the device code (`vercel login`); everything below is then scriptable. Steps 1 and 2 start at the repository root; from step 2 on you are inside `auth-backend/` (so secret paths read `secrets/...`), except where a command says `auth-backend/...` (run those from the root). Nothing below has been run.

**Prerequisites:** Node 20+, the Vercel CLI (`npm i -g vercel`, or prefix each command with `npx`), a Vercel account (Hobby is fine; Hobby is for non-commercial use, check the fit), and the Convai key in a file you create yourself.

1. **Secret files** (kept in `auth-backend/secrets/`, which git ignores; nothing is echoed). The signing and admin secrets are random; the Convai key file is the key alone on one line (write it with an editor, never with `echo`):

   ```
   mkdir auth-backend/secrets
   node -e "require('fs').writeFileSync('auth-backend/secrets/signing.secret', require('crypto').randomBytes(32).toString('hex'))"
   node -e "require('fs').writeFileSync('auth-backend/secrets/admin.secret', require('crypto').randomBytes(32).toString('hex'))"
   ```

   Then create `auth-backend/secrets/convai-key.secret` containing the Convai key (a spare key held in reserve is a good choice for the first run).

2. **Link a Vercel project** (creates it on first use; `auth-backend` is its root directory):

   ```
   cd auth-backend
   vercel link --yes --project cyberpunk-convai-auth
   ```

3. **Redis through the Vercel Marketplace (Upstash).** If your CLI has the command (`vercel integration --help` lists it), run `vercel integration add upstash` and choose Redis on the free plan, a region near the function's (`iad1` by default). The integration then injects its REST variables into the project. The CLI may open your browser once to accept Upstash's terms: that is the one browser step. If your CLI has no `integration add`, do the same in the dashboard: project, Storage, Create, Upstash Redis, Free, connect to this project. Check afterwards:

   ```
   vercel env ls
   ```

   You should see `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or the `UPSTASH_REDIS_REST_*` pair). Either works.

4. **Add the secrets**, each piped from its file so the value never appears on a screen or in shell history (add `--sensitive` if your CLI version supports it; the first form is for Git Bash, the second for PowerShell):

   ```
   vercel env add CONVAI_API_KEY production --sensitive < secrets/convai-key.secret
   vercel env add CONVAI_AUTH_SIGNING_SECRET production --sensitive < secrets/signing.secret
   vercel env add CONVAI_AUTH_ADMIN_SECRET production --sensitive < secrets/admin.secret
   ```

   ```
   Get-Content -Raw secrets\convai-key.secret | vercel env add CONVAI_API_KEY production --sensitive
   Get-Content -Raw secrets\signing.secret | vercel env add CONVAI_AUTH_SIGNING_SECRET production --sensitive
   Get-Content -Raw secrets\admin.secret | vercel env add CONVAI_AUTH_ADMIN_SECRET production --sensitive
   ```

   Values are trimmed by the service, so a trailing newline is harmless. The signing secret file is also what the bridge needs (step 8).

5. **Optional settings**, for example `CONVAI_AUTH_MIN_VERSION` or a different cap (a plain number piped in; not secret):

   ```
   echo 100 | vercel env add CONVAI_AUTH_DAILY_TURN_CAP production
   ```

6. **Deploy:**

   ```
   vercel deploy --prod
   ```

   The command prints the deployment address. `vercel env` changes reach only deployments made after them, so after any later change run `vercel deploy --prod` again (about half a minute).

7. **Check it** (replace the address; none of these mints a token):

   ```
   curl https://<address>/api/healthz
   curl https://<address>/api/readyz
   curl -H "Authorization: Bearer $(cat secrets/admin.secret)" "https://<address>/api/readyz?ping=1"
   ```

   `readyz` must say `"status":"ready"` with `true` for `CONVAI_API_KEY`, `CONVAI_AUTH_SIGNING_SECRET` and the Redis pair. **The first real token** (a live Convai call, one mint): `node auth-backend/scripts/probe.mjs https://<address>/api/convai/token --secret-file auth-backend/secrets/signing.secret`. It prints the status, expiry and allowance, and only whether a token arrived, never the token.

8. **Turn the bridge on** (off by default; nothing changes for players until you do). In the bridge's environment, or in `runtime/convai-auth.json` (git ignored): `CYBERPUNK_CONVAI_AUTH_BACKEND=1`, `CYBERPUNK_CONVAI_AUTH_URL=https://<address>/api/convai/token`, `CYBERPUNK_CONVAI_AUTH_SECRET=<contents of signing.secret>`, and optionally `CYBERPUNK_CONVAI_AUTH_FALLBACK=0` to remove the embedded-key fallback. Shipping the secret to players means a release step that writes `convai-auth.json` into the package; that packaging step is not part of this change.

9. **Before players use it,** run `node scripts/Enable-CharacterMemory.mjs` (plan) and then with `--apply`, on the developer machine. In backend mode the bridge no longer lists, reads or updates characters, so memory has to be switched on for every mod character beforehand.

**Pausing and rotating.** Pause: `echo 1 | vercel env add CONVAI_AUTH_PAUSED production` (use `vercel env rm` first if it exists), then `vercel deploy --prod`. If you cannot wait for the build, Vercel's Instant Rollback to a deployment made before the change also works. Remember tokens already issued live up to an hour. Rotate the Convai key: pipe the new key into `CONVAI_API_KEY` the same way, redeploy; tokens minted from the old key keep working until they expire (an hour) unless the old key itself is deleted in Convai's dashboard.

## Redis commands and invocations (free tiers)

Vercel Hobby allows about 1,000,000 function invocations a month. Upstash's free tier allows 500,000 commands a month. Figures below assume Upstash counts a Lua script (`EVAL`) as one command, as it is understood to; **check the usage graph in the Upstash console after the first day**, because if it bills each call made inside a script the numbers are about ten times higher.

Per request:

- `POST /api/convai/token`: one invocation. **One Redis command** (the whole admission is one script), plus one more only in `per-install` mode when a token is minted (saving it). Requests refused before the store (kill switch, bad signature, stale clock, bad body, old version, blocked install, in-instance flood guard) cost an invocation and **zero** commands.
- `GET /api/healthz`: one invocation, zero commands, never touches Redis or Convai.
- `GET /api/readyz`: one invocation, zero commands (one `PING` only with `?ping=1` and the admin secret). Do not point a monitor at `?ping=1` more than a few times a day.
- `GET /api/admin/turns`: one invocation, four commands (one pipelined request). Rarely used.
- `GET` or `POST /api/admin/config`: one invocation, two or three commands (set or remove, then read back). Rarely used. Reading the limit during a token request adds no command (it happens inside the admission script).
- Every Redis key has a TTL (hours to days), so there is no cleanup job and nothing grows without bound.

Per active player a day: the bridge asks once at start and renews about every 51 minutes (a token lives an hour and the bridge renews 8 to 10 minutes early). A two hour session and a game restart is about **3 requests a day** (range 2 to 6). That is 3 invocations, and 3 commands in `shared` mode or about 5.5 in `per-install` mode.

Monthly (30 days of that many players every day, 3 requests each):

| Daily players | Invocations / month | Share of Hobby 1M | Redis commands, `shared` | Share of Upstash 500K | Redis commands, `per-install` |
|---|---|---|---|---|---|
| 100 | 9,000 | 0.9% | 9,000 | 1.8% | about 16,500 (3.3%) |
| 1,000 | 90,000 | 9% | 90,000 | 18% | about 165,000 (33%) |
| 10,000 | 900,000 | 90% | 900,000 | **180%, over the free tier** | about 1,650,000 (**330%**) |

The Upstash free tier is exhausted at about 5,500 daily players in `shared` mode (3,000 in `per-install`); Hobby invocations at about 11,000. Past that, Upstash's pay-as-you-go price is small (on the order of a dollar or two a month at 10,000 daily players), but check it. Each attack request that passes the signature costs one command, so the in-instance flood guard (60 a minute per address per instance) and the hourly limits are also what protect the Redis allowance. If it runs out, Redis fails, the service fails closed, and the bridge falls back or stops as described above.

## What is stored

Redis holds only keyed hashes (HMAC of the install id or the address with the signing secret; the raw values are never stored or logged), counters and the day's per-install turn totals, all with TTLs (the one exception is the stored daily limit, `cfg:dailyInteractionLimit`, a single number with no TTL that you set yourself) (hours; install-seen markers 5 weeks). In `per-install` mode it also holds each install's token until it expires: a token is a bearer credential, so protect the Upstash console and treat it like the Vercel project. Vercel's own request logs (kept about an hour on Hobby) see addresses as every host does. No conversation text, character or audio ever reaches this service.

## Tests

`node --test test/` in this folder, or `node scripts/run-tests.mjs` from the repository root (it includes this folder). The admission script is the real Lua text, executed by the `fengari` Lua VM (a dev dependency, already in the repository's `node_modules`) against an in-memory Redis with a controllable clock, so the limits are tested as they will run, not as a JavaScript copy. The bridge's own tests run the real handler against the bridge's `TokenSource`, so the signature format cannot drift apart.

## What could not be verified without a live call

- That Convai accepts `API-AUTH-TOKEN` for `/memory/list` and `/memory/delete-all` (the SDK sends it there; untested).
- That a token cannot call `/character/update` or `/character/list`.
- The `/user/revoke-token` request and answer shape (the body `{"apiAuthToken": "<token>"}` is from Convai's page; the answer is undocumented) and what Convai's per-key mint limit is, which decides whether `per-install` mode is workable.
- That Vercel passes the raw body of a `text/plain` POST untouched (the code reads the request stream itself before the platform helper does; the bridge test and `probe.mjs` against the first deployment settle it), and that `x-vercel-forwarded-for` carries the client address.
- That Upstash bills a script as one command, and the exact Marketplace CLI syntax for adding Upstash (it depends on the CLI version).
- Cold-start and round-trip latency of the deployed function (the design doc measured 0.3 to 0.7 s for a trivial Vercel function from the dev machine; the bridge does this in the background, never on a turn).
