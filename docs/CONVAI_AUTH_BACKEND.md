# Convai auth through a small backend: design and latency

**Second backend (2026-10-24, branch `feat/cf-signin-backup`):** players in Russia and China cannot reach `*.vercel.app`, so there is a backup on Cloudflare Workers' free plan, `auth-backend-cf/` (same API, same signing secret, own counters on Durable Objects, own error report store; design, free-plan fit and the owner's deploy steps in its README). The bridge (`TokenSource`, `backupUrl` in `convai-auth.json` / `CYBERPUNK_CONVAI_AUTH_BACKUP_URL` / the release variable `CONVAI_AUTH_BACKUP_URL`) asks the backend that answered last and tries the other when the first fails to answer (not on a refusal or rate limit; a first backend silent for 6 s gets the other asked as well); error reports do the same (`backupUrl` in `app/defaults/error-reports.json`). The Worker address is not known until the first deploy: with no `backupUrl` the Runtime behaves exactly as before. `scripts/Fetch-ErrorReports.mjs --backup-url <worker>` reads both stores.

**Build status (2026-10-22, branch `feat/token-backend`, the ship-side switch for 0.2.9):** from 0.2.9 the Runtime ships no Convai key and the bridge's backend mode is on in the package. What changed:

- **No key in the package.** The release build no longer writes `app/defaults/service.txt`. `--key-env` and `--key-file` are refused ("the Convai key is no longer shipped"), and the final archive guard refuses any `service.txt` or `convai-key.txt`. `bridge/key-codec.mjs` and `packaging/lib/packaged-key.mjs` (the scrambling) are deleted: nothing needs them. The statement in section 4 below that the key ships "as a scrambled line" describes releases up to 0.2.8 only.
- **What it ships instead:** `app/defaults/convai-auth.json`, `{"version": 1, "enabled": true, "url": "https://<backend>/api/convai/token", "secret": "<client request secret>", "fallback": false}`, written by the build from `CONVAI_AUTH_URL` and `CONVAI_AUTH_CLIENT_SECRET` (or `--auth-url` and `--auth-secret-env NAME`; validation in `packaging/lib/convai-auth.mjs`: https, path `/api/convai/token`, no query, secret of at least 32 printable characters; the secret is never printed and is masked with `::add-mask::` on GitHub Actions). A non-dry-run build of the Runtime without both fails before anything is written or downloaded; `--dry-run` may omit them. In the workflow (`.github/workflows/release.yml`) the address is the repository variable `CONVAI_AUTH_URL` and the secret is `CONVAI_AUTH_CLIENT_SECRET`; `CONVAI_API_KEY` is gone from the workflow.
- **Three sources, per setting, first one that has it wins:** the environment (`CYBERPUNK_CONVAI_AUTH_*`), then `convai-auth.json` in the state folder, then the package's `app/defaults/convai-auth.json` (`readAuthSettings`, `bridge/convai-credential.mjs`). So a developer's state-folder file with `"enabled": false` still switches a package's backend mode off. A plain `api-key=...` `convai-key.txt` in the state folder (a developer's, or a player's own typed in by hand) keeps the packaged file out: that key is used directly with no daily cap and no backend, exactly as before, unless the developer switches the backend on in the state-folder file or the environment. A development checkout has no packaged file, so nothing changes there.
- **The request secret is not the error reports' secret.** Error reports keep using `app/defaults/error-reports.json` (its own url and secret, added to the Runtime by hand; the build does not write it). `readBackendAddress` and `reportTarget` never read the packaged `convai-auth.json` (pinned by a test in `bridge/error-reports.test.mjs`); both shipped secrets are scrubbed from reports.
- **The shared key is optional in the bridge.** With no key file the bridge starts; on the shared source the credential is the backend token only, never an `apiKey`, and `fallbackAllowed` is false because there is no key to fall back to. A player's own key (`docs/OWN_CONVAI_KEY.md`) works exactly as before, with or without a shared key. A key file that is not a plain `api-key=...` line (the packed line of a release up to 0.2.8, or a damaged file) is ignored. The supervisor (`bridge/bridge-supervisor.mjs`) accepts a missing key file when the backend is on by the same three-source reading; with neither a key nor a backend it still reports `missing-key`, and a bridge that is started anyway fails each Convai turn with `[convai-auth:none]`.
- **The daily cap applies to the token path.** The guard is active whenever the backend is on and there is no plain key file; its limit is the backend's number (`daily-limit.json`, else 500). It is the only limit on conversation turns: 500 a day per installation, counting every turn the shared key serves once, with no sub-pools and no rate limit (see "Update 2026-10-28" at the end). A plain developer key, a player's own key, Local AI, Mistral and Custom stay uncapped.
- **Stale key from 0.2.8.** `prepare-state.mjs` removes a `convai-key.txt` in the data folder only when it is a packed `convai-key-v1` line (never a plain `api-key=` file) and logs that once without the value. `defaults/service.txt` of an updated installation is deleted through the existing removal list (`packaging/runtime-removals.json`, which every Runtime carries; an update zip also finds it by comparing the two Runtimes).
- **When the backend cannot be reached.** A turn with no token and no fallback fails at once (no waiting: `ready()` waits, for at most 4 seconds, only while the very first fetch of the run is in flight, and never for a retry), and the player gets one notice, `convai-unavailable` ("Convai could not sign in. Try again in a moment, or choose Mistral or Local AI in Settings > Conversation provider."), shown at most once every 5 minutes (`mod/notices.lua`), in all 16 languages, only for a turn the player asked for. Token fetches stay off the turn path.
- **Checks:** `bridge/convai-credential.test.mjs`, `bridge/error-reports.test.mjs`, `bridge/bridge-supervisor.test.mjs`, `packaging/release.test.mjs` and `packaging/scripts-package-layout.test.mjs` (the `packaging/test-release-install.mjs` checks need a real build). This note makes no claim about a live check of the token against Convai.

**Live check against Convai (2026-10-22, the deployed backend, a throwaway end user, a handful of interactions):**

- **Deployment.** One Vercel project serves both the token endpoint and the error reports (`cyberpunk-convai-auth`, `https://cyberpunk-convai-auth.vercel.app`). Three separate secrets now: `CONVAI_AUTH_SIGNING_SECRET` (new on 2026-10-22: the client request secret that ships in `convai-auth.json`), `ERROR_REPORT_SECRET` (the old signing value, which already shipped in `error-reports.json`, so reports from installed Runtimes keep working) and `CONVAI_AUTH_PSEUDONYM_SECRET` (server-only, keys every hash). A report signed with the signing secret is refused, a token request signed with the report secret is refused (`auth-backend/test/separate-secrets.test.mjs`). `ERROR_REPORTS_INSTALL_PER_DAY` follows the code default, 40, above the client's 20 a day.
- **Follow-ups after the first pass:** the per-install hourly limit default is 12 (was 4: every bridge start asks once, and relaunches or a crash-looping bridge would lock a player out for the rest of the hour with no embedded key to fall back on). `/api/readyz` reports `secretsSeparate` (all three secrets set and different, never a value). A turn that finds the token expired after a good answer (the computer slept) starts one background fetch (`TokenSource.kick`, at most every 30 s, never after a failure) and waits for it at most four seconds. The memory REST calls no longer follow redirects. `--auth-secret-env` must name a variable with CONVAI in its name, so a mistyped flag cannot ship another token.
- **Token mint through the backend:** 0.3 to 0.7 s warm from the dev machine, 0.7 to 1.1 s on a cold function. The bridge's own `TokenSource` was ready 0.4 to 0.5 s after start, in the background. A repeated request returns the same token (shared mode). Life 60 minutes. The fifth request of an install inside an hour is refused (`rate`), as designed.
- **Realtime turns with the token** (`RealtimeHost` with `authToken`, text only, a throwaway end user): `/connect` accepted, first turn 6.7 s (cold connection), second 0.8 s. A conversation turn never waits on the backend.
- **Which REST calls accept the token.** All of them that were tried: `/memory/list` and `/memory/delete-all` (the throwaway user), `/character/get`, `/character/list`, `/user/end-users/list` (50 end users on one page, `has_more` true) and `/character/update` (a nonexistent character id answered 500 from the update handler, where an invalid token answers 502 from the gateway, so it is not refused at the door; a real update was deliberately not attempted). `/character/getResponse` answered 500 for both ids tried and is not used by the bridge. An invalid token is refused with 400 on the calls that were tested.
- **What that means.** The design assumed some of these calls would refuse the token, so they could be routed through the backend or dropped. None refuse. The runtime no longer lists, reads or updates characters (backend mode skips them), but **a token is account-wide**: whoever can mint one (the client request secret is public by nature) can, for its hour, list the account's end users and read or wipe their memories, and probably edit characters. Routing the bridge's own calls through the backend would not close that, because the attacker calls Convai directly with the token. What bounds it today is the per-install and per-address mint limits and the one-hour life. What closes it is Convai scoping a token, or a different design for memory (not storing anything the player would not want read). This is the first question for Convai (item 1 of "Unknowns about Convai" in section 5), and is in TODO.md under "Needs the owner".

**Build status (2026-10-13, branch `convai-auth`):** the backend is built in `auth-backend/` (see its README for what each protection stops and does not, the settings and the deploy steps) and the bridge side is built behind an off-by-default switch. Where the build differs from the text below: the token is not persisted to disk (one request per bridge start instead); the server margin is 5 minutes with a client hint (`minLifeSeconds`, 15 minutes) so renewals always get a fresh token; limits and counters run as one Redis script (one command per request); a `per-install` token mode with revoke exists beside the default `shared` one; `/v1/*` paths became `/api/convai/token`, `/api/admin/turns`, `/api/healthz`, `/api/readyz`; the key-only runtime calls are removed in backend mode as section 2 proposes. Not deployed, not run against Convai.

Research and design only, 2026-10-13. Nothing was built, installed or run against Convai: no conversation turn, no end-user creation, no token minted. The only network calls were read-only GETs (the chess backend's `/healthz` and `/readyz`, the two Convai host names with no key, and the public documentation).

Question: the release package ships the project's shared Convai key inside the bridge (`bridge/key-codec.mjs`, scrambled, not secret). Could the bridge ask a small backend for a short-lived Convai token instead, as the chess game does, and would that add noticeable latency?

## Short answer

- **Latency: no, not on any conversation turn.** A token is fetched when the bridge starts and renewed in the background about every 50 minutes. A live Convai session does not look at its token again once it has started, and our warm connections are not keyed by credential. The cost is one round trip (measured 0.3 to 0.7 s warm for the Vercel hop alone from the dev machine, 1.2 s on a first cold call) paid in the background at start-up and renewal, never per turn.
- **It is feasible for the realtime path**, which is the whole conversation. Convai documents the pattern and the SDK we already ship supports it.
- **It does not give a hard server-side daily cap.** A token is a bearer for about an hour; Convai's realtime media goes straight to Convai, so the backend never sees a turn. The backend can bound who gets a token and when, and see reported counts, but a modified client holding a valid token can still talk until it expires. What it removes is the permanent key.
- **Recommendation:** ship v0.2 on Sun 18 Oct as planned, build the backend the following week and ship it as v0.2.1, then rotate the key once most players have updated. Effort 4 to 5 working days (a minimum version, 2.5 to 3).

## 1. What the chess backend does (read-only)

Repo: `E:\misc\misc1\playtika\Classic-Chess-vercel-worktree`. Vercel project `chessbuddy`, custom domain `chessbuddy.live`, Hobby plan, deployed from a local checkout with the Vercel CLI (`docs/vercel-deployment.md`). It is a static Vite site plus Node functions under `api/`.

| Piece | File | What it does |
|---|---|---|
| Token endpoint | `api/convai/token.js` | `POST /api/convai/token`. Calls `POST https://api.convai.com/user/connect` with the `CONVAI-API-KEY` header and an empty JSON body. Convai answers `apiAuthToken` plus `expirationTime`. The endpoint returns `{authToken, expiresAt}` and nothing else. |
| Key location | Vercel Environment Variables (Production) | An env var named `CONVAI_API_KEY` holds the key. A second one, `CONVAI_SESSION_SECRET`, belongs to the dormant sign-in feature. Neither has a `VITE_` prefix, so neither reaches the browser. `/readyz` reports only whether they are set. |
| Token lifetime | Convai | One hour (Convai's auth-token page: "valid for 1 hour"). The code falls back to one hour if no expiry comes back. |
| Server cache | module variable in `token.js` | One token for every caller of a warm instance, reminted when under 5 minutes remain, concurrent mints de-duplicated. The cache lives and dies with the serverless instance. |
| Client | `src/convaiAuthToken.ts`, `src/convaiManager.ts` | Fetches before a connection, caches until 4 minutes before expiry, one request in flight at a time, a 404 or non-JSON answer marks the endpoint unavailable. The token goes to `new ConvaiClient({authToken, characterId, endUserId, ...})` (`@convai/web-sdk` 1.7.0-beta.0). No token means "Voice coaching is temporarily unavailable". |
| What is not proxied | | Conversation traffic goes browser to Convai directly. Only the dormant Character Crafting calls (`api/convai/creator/*`) are proxied, with a user-owned key sealed in an encrypted HttpOnly cookie. |
| Health | `api/healthz.js`, `api/readyz.js` | Plain GETs, no upstream call. |

Things in the chess backend that should not be copied:

- **The token endpoint is open.** Anyone on the internet can POST to it. Its only protections are a same-origin check (meaningless for a native client, which sends no Origin header) and a rate limit held in a per-instance `Map`. On serverless every instance has its own counter, so it limits almost nothing.
- **One shared token for all callers.** Fine for chess, but it means the token carries no player identity at all.

## 2. Does Convai's token work for our calls?

Convai's own documentation recommends this pattern: the server calls `/user/connect` with the key and gives the client `authToken`; "the API key never leaves your server". The Unity SDK documents "Auth Token mode" for shipped games, and its "Ship a secure build" page says the stored key is only obfuscated and that API-key builds should not go to audiences you do not control. The token is sent as an `API-AUTH-TOKEN` header. Other facts from the docs: `POST /user/extend-token` and `POST /user/revoke-token` exist (both need the key); revoking does not end a session already running; a new token can be minted while another is live; token issuance is limited per key by plan with no published number.

What the documentation does not state is **which REST endpoints accept the token**. The evidence below is therefore the SDK source we already ship (`node_modules/@convai/web-sdk` 1.7.0) and the chess game's production use. Nothing was tested live.

| Our call | Where | Token support | Plan |
|---|---|---|---|
| Realtime connect, `realtime-api.convai.com/connect`, which also creates the memory end user from `end_user_id` | `bridge/realtime-client.mjs`: `new ConvaiClient({apiKey: config.key, ...})` in the hidden browser | **Yes.** `ConvaiClient` sends `API-AUTH-TOKEN` when given `authToken`, else `X-API-Key`. The chess game connects this way with an end user id and memory. | Pass `authToken`. `installConvaiAudioRoute` in `realtime-host.mjs` rewrites only the request body, so it is unaffected. |
| `/memory/list`, `/memory/delete-all` ("Forget all", the empty check) | `bridge/player-memory-api.mjs` | **Probably.** The SDK's `MemoryManager` sends `API-AUTH-TOKEN` for `/memory/add|list|get|delete|delete-all`. | Same call with the other header. Verify live. If refused, proxy through the backend. |
| `/character/get` | `PlayerMemoryApi.#owned` | **Probably.** The SDK's character-info hook sends `API-AUTH-TOKEN` to it. | Not needed at run time if the ownership check is replaced (below). |
| `/character/list` | `PlayerMemoryApi.#owned`, `validateKey`, `knowledge-cloud.mjs` | **No evidence.** | Remove from the shared-key path (below). |
| `/character/update` (`memorySettings.enabled`, once on invite) | `PlayerMemoryApi.enableMemory` | **No evidence.** | Remove from the shared-key path (below). |
| `/user/end-users/list` | `bridge/convai-key.mjs` `listEndUsers` | Not documented. Only used to recover on a player's own free key. | Stays with a player's own key; not part of the shared path. |
| `/character/getResponse` | `bridge/convai-client.mjs` | The Convai Connect text says tokens work for it. | Nothing imports this file in the bridge, so it does not matter. |
| Developer scripts (`scripts/Provision-Characters.mjs`, `cleanup-test-end-users.mjs` and similar) | developer machine only | Need the key | Unchanged. They never ship. |

**Removing the key-only calls from the player path.** Today a player's machine uses the shared key to list the account's characters, read one, and update it, so that it can verify the character is ours before enabling memory. Those are the calls with no token evidence, and they are also the most dangerous ones to hand to a client. Both can leave the runtime:

1. Set memory on for every mod character once, from the developer machine, as part of provisioning.
2. Replace the runtime roster check on the shared path with the character id list the bridge already ships (`relationshipRoutes.providerIds`).

That leaves realtime connect and two memory calls on the token, and nothing on the raw key at run time. If the memory calls refuse the token, the backend proxies exactly two allow-listed operations (list and delete-all, for ids in the shipped allowlist).

**Token scope.** Nothing documents a scope. Assume the token is a bearer for the account's interaction APIs for its lifetime: any character, any `end_user_id`. A holder can therefore spend interactions and create end users within the hour, but, as far as the evidence goes, cannot create, edit or delete characters (to be tested, step 0 below).

## 3. Latency

### What happens per turn

Nothing. Trace of a conversation:

1. **Bridge start:** `TokenSource` starts a fetch in the background, in parallel with everything else the bridge does at start-up.
2. **First connection (invite or warm-up):** uses the cached token. If the fetch is still running, the connection waits for it, at most about 4 s, and in practice it is already done because start-up takes seconds.
3. **Reconnects, re-warms, the connection pool:** use the cached token, no network. Connection identity in `bridge/transport-pool.mjs` is character, end user, scope and voice, not credential, so a new token does not invalidate warm pages.
4. **Each turn:** the existing local gate (`SharedKeyGuard`) runs as before. No backend call.
5. **Renewal:** the background refresh runs 8 to 10 minutes before expiry. Live sessions keep going on their old token (Convai: once a session starts the token is no longer checked).
6. **Turn counts** are reported inside the renewal request, batched, so there is no extra call.

A server-side check on every turn is the only design that puts the backend on the turn path. It would add the full round trip to every reply, and the replies already take 2 to 3.5 s (`docs/LATENCY_2026-10-12.md`). Rejected.

### Measured (GET only, no key)

From the dev machine, which Vercel routes to its Mumbai edge. `X-Vercel-Id` read `bom1::iad1`: edge in Mumbai, function in Washington DC, the default region. Times are curl totals over a fresh TLS connection.

| Request | Samples (s) |
|---|---|
| `chessbuddy.live/healthz`, first call of the run | 1.16 |
| `chessbuddy.live/healthz`, warm | 0.66, 0.66, 0.33, 0.33, 0.56, 0.41, 0.33 |
| `chessbuddy.live/readyz` | 0.80, 0.61 |
| `api.convai.com/` (404, no key, for comparison) | 0.75, 0.43, 1.14 |
| `realtime-api.convai.com/` (404, no key) | 0.58, 0.46, 0.54 |

Reading it:

- A **warm trivial function costs 0.3 to 0.7 s from here**. That is more than the 100 to 300 ms one would assume from a US or EU player, because the Mumbai edge forwards to Washington. It is the same order as a bare Convai request from the same machine.
- The first call was about 0.5 s slower, consistent with a Vercel cold start plus a cold TLS connection. One sample only, so treat it as indicative.
- **A real mint** is that hop plus one Convai `/user/connect` call from the function. That call was not measured (it needs the key, and a POST). Estimate: 0.7 to 1.5 s from here, 0.2 to 0.6 s from a US or EU player. Cached copies come from Redis in a few ms of function time plus the same network hop.
- All of it is background work, outside the turn path.

Cold starts: Vercel's default Fluid compute reuses instances, but a project with a few requests an hour will often be cold for the next caller. That caller pays about +0.5 s once, in the background. Nothing to mitigate. Setting the function region near most players (and near Convai) would trim the hop; the player base is unknown, so leave the default until the stats say otherwise.

### Free tier against our scale

Hobby limits (Vercel docs, read 2026-10-13): 1,000,000 function invocations a month, 4 active-CPU hours, 360 GB-hours of memory, 100 GB fast data transfer, 5 minute function duration, logs kept 1 hour, 3 custom WAF rules and 3 IP blocks. Hobby is for non-commercial use under Vercel's fair-use guidelines, so check that the project fits before launch.

Our load is tiny. The backend is called about once per active player-hour. The Convai budget (100,000 interactions a month) caps the whole project, and each backend call covers many turns, so even at full budget the calls are in the tens of thousands a month at most. A response is under 1 KB. None of the Hobby limits is close. The one thing Hobby does not include is a durable counter store (its storage is Blob only), so rate limiting needs an external Redis (Upstash through the Vercel Marketplace, or similar). Check that service's free quota when setting it up.

An alternative that is better for players far from Washington: a Cloudflare Worker (no cold start, runs at the nearest edge). The Vercel account already exists and the chess code is a ready template, so the default stays Vercel.

## 4. What it buys

1. **The key is not in the shipped files.** Today the key is in the release zip on GitHub as a scrambled line (`defaults/service.txt`, `bridge/key-codec.mjs` says itself "obfuscation, not secrecy"). Anyone can recover it by running the bridge. With it they can spend the monthly 100,000 interactions, burn the 10,000 memory end users with random ids, and call every account API, including editing or deleting the 308 characters (the bridge itself calls `/character/update`). Convai's docs say misuse of the API leads to a ban of the account and key. With the backend the shipped files hold a URL and an install id, nothing else.
2. **Rotation without a mod update.** Today a leaked key means a new build and every old install breaks. With a backend the key changes in one env var.
3. **Server-side control, with honest limits.** The server decides who gets a token, can refuse an install, an IP range or everyone (kill switch), and counts reported turns per install. It cannot see turns itself, and a token cannot be capped or bound to a player by us. So the daily cap (500 a day since 2026-10-28) stays a client rule, backed by a server backstop (section 6). A modified client with a live token can exceed it for the token's remaining life; it can no longer extract anything permanent, and it cannot get a new token once the install is refused.
4. **Usage stats.** Tokens issued, active installs a day, reported turns, and a running estimate against the 100,000 budget, none of which the Convai dashboard gives per install. Self-reported, so approximate.

## 5. What it costs

- **A server dependency.** If the backend is down: a cached token keeps working for up to an hour and live sessions do not notice; after that, Convai conversations fail with a plain notice, and players on a free or local provider are unaffected. There must be no hidden fall-back to a shipped key. That would put the key back.
- **Work.** 4 to 5 days (section 7), most of it in the bridge and the tests, not the server.
- **Privacy.** The backend sees the player's IP address, a random install id, timestamps and turn counts. Never text, never character, never audio. Convai already sees the IP on every realtime connection. Store the IP only as a salted daily hash for rate limiting, keep no logs beyond Vercel's one hour, and say it in the player README.
- **Terms.** No clause against it was found, and none against shipping the key either: only excerpts of Convai's terms were readable (a general confidentiality section that does not name keys), the dashboard says never to share the key publicly, and the docs recommend tokens for shipped apps. Ask Convai to confirm.
- **Operations.** The Vercel account and the Redis store become the place to protect (two-factor, a spare key held in reserve). Hobby's non-commercial terms must be checked before launch.
- **Unknowns about Convai**, all to ask them: scope of a token and whether it can be bound to a character or end user; whether `/user/connect` accepts a TTL; the mint rate limit per key; whether a per-end-user usage figure exists that the server could poll to enforce turns.

## 6. Concrete design

### Backend (Vercel project, Node functions, default region first)

| Endpoint | Purpose |
|---|---|
| `POST /v1/token` | Body `{install, client, turns, since}`. Returns `{token, expiresAt, allowance: {used, limit, resetAt}, minClient, notice}` or an error below. The only endpoint that matters. |
| `GET /v1/status` | Unauthenticated `{ok, killSwitch, minClient}`; health check and early "update the mod" signal. |
| `POST /v1/memory/forget` | Only if the memory calls refuse tokens: allow-listed `/memory/delete-all` on behalf of the install. Not built unless needed. |
| Admin | No HTTP admin. A local script reads and writes Redis (ban, kill switch, stats) with its own credentials. |

Errors: `429 {error: "daily" | "rate", resetAt}` (a `rate` answer also says which limit fired, `limit: "address" | "install"`, and the bridge carries it into the report as `authCause` `RATE_ADDRESS` / `RATE_INSTALL`), `403 {error: "refused" | "outdated"}`, `503 {error: "unavailable"}`. The bridge maps `daily` to its existing `[convai-quota:daily]` notice, so the player sees the same message as today.

**Token minting and cache.** One Convai token shared by all installs, kept in Redis with its expiry. The first request that finds under 15 minutes left takes a lock (`SET NX`, 10 s), mints with `/user/connect`, stores it and releases; others wait or use the still-valid one. Every response therefore carries at least 15 minutes of life, and Convai sees about one mint every 45 minutes, not one per player, which also keeps clear of the unpublished mint rate limit. The cost of sharing one token: it cannot be revoked per player (revoking it stops new connections for everyone until the next mint). Per-install tokens with `revoke-token` on abuse are a later option if abuse appears.

**Secrets.** Env vars on Vercel: `CONVAI_API_KEY`, the Redis credentials. Nothing is logged except hashed identifiers.

**Rate limiting and abuse** (all in Redis, atomic counters with expiry; not in memory):

- Per install: 12 token calls an hour (a real install makes about 1 to 2).
- Per IP (hashed with a daily salt): 60 calls an hour and 30 new installs a day (LAN events, shared households).
- Per install, UTC day: reported turns. The server limit is **150**, a backstop above the client's 100, so the local-midnight versus UTC difference never shows a false refusal. The client's own gate stays the real 100.
- Global: a running estimate of turns this month. At 90% of the budget stop issuing tokens to new installs and tell existing ones (`notice`); at 100% the kill switch.
- Kill switch and ban list: Redis keys read on every call.

**Anonymous player id.** `install`: 128 random bits from `crypto.randomBytes`, written once to `convai-install.json` in the bridge state folder (mode 0600). It is deliberately not the end-user id in `player-memory.json`, so the backend cannot be correlated with long-term memory. A user can delete it for a new identity; that is why the per-IP caps and the global breaker exist. It is accounting, not authentication.

### Bridge

- New `bridge/convai-credential.mjs`: a `TokenSource` with `current()` (synchronous, returns the cached token), `ready({timeoutMs: 4000})`, a background refresh at expiry minus 8 minutes with random jitter, one request in flight, retries at 5 s, 15 s, 60 s, then every 5 minutes, and the install id. The last good token is persisted (`convai-token.json`, 0600) so a restart reuses an unexpired one. It never prints the token. Add it to `ConvaiKeys.secrets()` so reports scrub it (the report scrubber already recognises `token` and `auth-token`).
- `ConvaiKeys` gains a credential kind: the shared source returns `{authToken}`, a player's own (developer) key still returns `{apiKey}`. `memoryPolicy` builds configs from `currentKey()`, so it moves from `key` to `credential`. `realtime-client.mjs` passes `authToken`. `PlayerMemoryApi` and `ConvaiMemoryAdapter` choose the header by kind.
- `SharedKeyGuard` is unchanged; its count (`consume()`) feeds the `turns` field of the next renewal.
- **Fallback when the backend is down:** (1) keep using the cached token until it expires; (2) a first connection waits at most about 4 s for a token; (3) with no token and no backend, Convai replies fail through the existing failure path with the plain notice, and a player who has chosen the free or local provider is not affected; (4) never fall back to a shipped key.
- Packaging: drop the packed key from the release build (`packagedKeyText` in `packaging/build-release.mjs`, the key check in `packaging/runtime-layout.mjs`, `prepare-state.mjs`, the install test), ship the backend URL in `defaults/service.txt`. `runtime/convai-key.txt` stays for developers and means "use this key directly, no daily cap", as now.

### Rollout and rotation

1. Verify (step 0 below), build, deploy, release v0.2.1 token-only.
2. Keep the old key alive for about two weeks so v0.2 installs keep working.
3. Rotate the key (the spare held in reserve). v0.2 installs then get the existing "key not accepted" failure; the release notes and the Nexus page say to update.
4. If the memory or character calls refuse tokens, the proxy endpoint above is the fall-back, not the key.

**Step 0, before any code (about half a day, a handful of interactions):** with the real key, mint one token and test with a throwaway character only: realtime connect with an `end_user_id` and memory on; `/memory/list` and `/memory/delete-all` on an existing test end user; confirm `/character/update` and `/character/list` are refused for a token; read `expirationTime` and the response to a repeated `/user/connect`. Do not run this against the 308 live characters.

## 7. Effort and timing

| Piece | Days |
|---|---|
| Step 0: live verification of the token on each call | 0.5 |
| Backend: `/v1/token`, `/v1/status`, Redis counters and lock, tests with a fake Convai, deploy, env, admin script | 1 to 1.5 |
| Bridge: `TokenSource`, `ConvaiKeys` credential kind, realtime client, memory calls, notices, fallback, test updates (many fixtures use a key) | 1.5 to 2 |
| Pre-provision memory on all characters, allowlist replaces the runtime roster check | 0.5 |
| Packaging and install test, README privacy line, release notes | 0.5 |
| **Total** | **4 to 5** (minimum version, mint plus IP limit, no turn reporting: 2.5 to 3) |

**Timing: after the 18 Oct release.** Five days remain, and the open items before release already include a first real-game test of the packaged build. This change touches the realtime connect path, the one thing that must stay stable, and it depends on three behaviours of Convai that have not been seen live. Doing it first would put an untested credential path into the first public build. Suggested order:

- Now to 18 Oct: ship v0.2 as planned. Cheap hedges that need no code: hold a second key in reserve, set a usage alert on the Convai account, ask Convai the questions in section 5.
- 19 to 24 Oct: step 0, then build.
- 25 Oct: v0.2.1 with the add-on release, then rotate about two weeks later.

If a public key is judged unacceptable even for one week, the minimum version is feasible but would displace release polish, and would still go out with step 0 done the day before.

## Update 2026-10-14: the daily limit is set by the server

Status note: the backend was deployed to Vercel on 2026-10-13 (the "Not deployed" line in the build status above is out of date), and the bridge's backend mode is switched on per machine in `runtime/convai-auth.json`.

The per-install daily limit ("Convai free tier: N turns a day", 100 until now) is no longer fixed in the mod:

- **Where it lives:** in the backend's store under `cfg:dailyInteractionLimit`, set with `POST /api/admin/config {"dailyInteractionLimit": 150}` (admin secret). The environment variable `CONVAI_AUTH_DAILY_TURN_CAP` stays as the default (100). No redeploy is needed to change it, and players do not update the mod. `auth-backend/README.md` has the commands.
- **How the server uses it:** the admission script reads the stored value in the same single Redis round trip and compares it with the install's reported turns, so the number enforced is the number reported (`dailyInteractionLimit`, also `allowance.limit`) on every token answer and every "daily" refusal.
- **How the bridge uses it:** `bridge/convai-credential.mjs` validates the value (a whole number from 1 to 10000, else ignored) and hands it to `SharedKeyGuard.setLimit`, which changes what is counted, enforced and shown in the settings ("{left} of {limit} left today"). The last value is kept in `daily-limit.json` in the bridge state folder (signed per computer, like the daily counter), so a restart or an unreachable backend keeps it; with no value ever received the limit is 100. `CYBERPUNK_CONVAI_DAILY_LIMIT` (a developer's own number or `off`) still wins over the server. A bridge that was blocked for the day asks again every 30 minutes, so a raised limit lets it through without waiting for the UTC midnight.
- **What it does not change:** the server only counts turns an install reports, and the bridge counts locally, so a modified client can still ignore both, exactly as before (see the README table). Without the backend switched on there is no server value and the built-in 100 applies.
- **Tests:** `auth-backend/test/admin.test.mjs` (set, show, remove, refuse bad values, applies on the next request, no extra command), `bridge/convai-credential.test.mjs` (the value reaches the bridge, bad values ignored, raising unblocks), `bridge/shared-key-guard.test.mjs` (range, signed file, pinned and off guards).

## Update 2026-10-28: one cap, 500 a day, on both servers

Owner decision: the shared pool and every other cap go; the only limit is 500 interactions a day per installation on the shared Convai key, and everything else is unlimited.

- **Client:** `bridge/shared-key-guard.mjs` keeps the daily counter (UTC day since 0.3.5, two signed copies) and nothing else: the unprompted-lines pool (a tenth), the battle and loot pool (a fifth) and the turn rate limit (15 at once, 12 a minute, 250 ms apart) are removed. A group round of 3 to 5 provider turns, a speak-up, a reaction, a ride or threat answer and a call each count once, in `RealtimeHost`. The notice when the 500 are used up is unchanged.
- **Both servers:** the default of `CONVAI_AUTH_DAILY_TURN_CAP` (`dailyTurnCap` in `auth-backend/api/_lib/config.js` and `auth-backend-cf/src/config.js`) is 500, the same as the bridge's built-in number.
- **What overrides the code default (nothing is deployed by the code change alone):** (1) the environment variable `CONVAI_AUTH_DAILY_TURN_CAP` on Vercel or in the Worker's variables, if it was ever set; (2) the stored value `cfg:dailyInteractionLimit` set with `POST /api/admin/config`, which wins over both and is per server. Both servers must be redeployed to carry the new default, and a stored value or variable of 100 or 150 must be removed or set to 500 (`{"dailyInteractionLimit": null}` removes the stored one). Until then the bridge adopts whatever number the server reports, so an old server keeps players at its old number.
- **The throttles that stay** protect the backend, not the budget: sign-in requests per install (12 an hour), per address (60 an hour), new installs per address (5 a day) and token mints (500 a day, whole service). A bridge asks for a token about once an hour, so none of them can hold a player below 500 turns a day.
- **The day boundary (fixed in the bridge for 0.3.5):** the bridge used to count per local day and the servers count per UTC day, so a player east of UTC (India: the server's day starts at 5:30 AM) saw turns left at local midnight while the server still held the day's reported turns and refused new tokens, and the notice said "tomorrow". The bridge now counts per UTC day too (a counter written with the local day is moved onto the UTC day it was last used in), so the settings page and the server run out and reset together. Players far from the Greenwich meridian now see the reset at an odd local hour, which is what the server always did. The notices still say "tomorrow"; a reset time in them (the server sends `resetAt`) or a server day that follows the player's own midnight would need a backend change (not deployed).

## Update 2026-10-31: a key rotated while tokens are in memory

The owner rotated the shared Convai key on 31 Oct around 08:00 UTC and the backends began to hand out tokens for the new key. Between 08:15 and 08:25 UTC three installs on 0.4.0 reported `turn-failed` with `convai: page.evaluate: Error: Invalid API key`: they still held a token from before the rotation (a token lives about an hour and is renewed 8 to 10 minutes before it expires), and nothing made them ask again.

- **What the bridge does now (`bridge/convai-key.mjs` `credentialRecovery`, `bridge/convai-credential.mjs` `TokenSource.refreshRejected`).** A shared-account turn that Convai refuses as rejected (`classifyFailure` in `bridge/convai-quota.mjs`: `Invalid API key`, `API key is invalid` or `rejected`, `Realtime access not allowed`) drops the credential in memory, fetches a new one from the backend and asks the turn once more. Nothing is observed in between, so a retry that works makes no error report and no notice. The retry rides the host's existing `recover` hook (`bridge/realtime-host.mjs` `run`), which applies the credential again on every attempt.
- **When it keeps today's behaviour.** The backend gives the same credential again (`same`), is asked too soon (`limited`), does not answer within 8 s or refuses (`unavailable`), or the retried turn is refused as well: the turn fails exactly as before and is reported once. A fresh credential that was refused on its retry ends the "fresh a moment ago" shortcut, so the next failing turn does not retry again.
- **Rate limit.** One forced fetch per five minutes whatever the answer, and none once the install has made 8 token requests in the last hour (the backend allows 12 an hour per install; the renewal schedule and bridge restarts need the rest). Turns that fail in the same moment share one fetch, and a fetch that gave a different credential less than 30 s ago also serves the turns that failed on the old one, without another request. A real outage of the backend or a key that stays refused therefore costs at most one request per five minutes.
- **A turn waits for it only after it has failed,** at most 8 s. The ordinary turn path is unchanged: the token is read from memory.
- **A path that cannot retry (a voice turn)** drops the refused credential too (`onFailure` in `bridge/convai-bridge.mjs`), so its next turn gets a fresh one.
- **Never for a player's own key** (`keys.source === 'player'`) and never without a sign-in backend. `bridge/convai-rejected-key.test.mjs` runs all of this over the real `TokenSource` and the real host loop.
