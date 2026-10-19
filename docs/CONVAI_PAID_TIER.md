# Convai paid tier (Settings > Conversation provider > Convai paid tier)

Built 2026-10-15 on branch `convai-paid-tier`. Unit-tested with every Convai and backend endpoint mocked. No checkout was created, no payment was made and no live Convai turn ran. Seen in the game on 2026-10-16: the page works, a Gamer monthly plan was bought, the plan updated and replies work on the player's key (see "Changes after the first live look").

Convai made "Gamer" plans for this mod. A player who wants more Convai conversations than the free tier gives can buy one from inside the mod, on their own Convai account, and the mod then uses that account's key. Conversations still go to the developer's account by default. Nothing changes for a player who never opens the page.

## What the player sees

- **Settings > Conversation provider** has a new row, **Convai paid tier** (Open), right under the **Convai API key** row.
- The page it opens has these rows:
  - **Your Convai plan:** the plan Convai reports for the saved key in plain words ("Gamer, monthly", "Gamer Pro, yearly", "Free"), "No key added", or "Not checked yet". The result of the latest action is the first paragraph of its help and is also on the status line (see "Changes after the first live look").
  - **Sign in with Convai** (Sign in; only while no key is saved): opens Convai's login page in the browser. After the player signs in (or makes a free account), the key is saved as Paste saves it. See "Sign in with Convai" below.
  - **Get your Convai API key** (only while no key is saved): opens convai.com in the browser, for copying the key by hand.
  - **The Convai API key row:** the same Paste / Remove row as on the provider page.
  - **One row per plan:** "Gamer, $4 a month", "Gamer, $32 a year", "Gamer Pro, $8 a month" and "Gamer Pro, $64 a year", each with a **Buy** button. The help says what the plan gives (Gamer: 500 Convai interactions a month; Gamer Pro: 1000 a month), how it is billed, and that the payment happens on Convai's Stripe page. The buttons are greyed out until a key is saved. The row of the plan the key has now shows **Current plan** (greyed out, no action) instead of Buy; the other plans stay buyable for a change or an upgrade.
  - **Check my plan:** asks Convai now.
  - **Manage or cancel plan:** opens the player's Convai billing page.
- **After Buy:** Stripe's checkout page opens in the browser. Once Convai reports the new plan, the Conversation provider becomes **Convai API key**, saved at once as an Apply would. One notice then says so in gameplay (`paid-tier-active`). If Convai has not confirmed the plan five minutes after the page opened, one notice points to **Check my plan** (`paid-tier-pending`). A later check that finds the plan makes the same switch.
- **On a paid plan** several companions can talk and generate at once (up to six connections); see "Conversations at once" below.
- **Wording rules:** no option is called recommended. The text never mentions a shared or embedded key, or Inworld. The README mentions the paid tier in one spot only: its Convai API key section.

## Convai's endpoints (from the private `Conv-AI/Convai_Payments` repository, read 2026-10-15)

Prod base: `https://payment.convai.com`, the address Convai's own dashboard uses (`PAYMENT_URL` in its deployment values). `GET /health` answers `{"status":"ok"}`. That health GET is the only request made to it during this work.

| Call | Auth | Body | Answer |
|---|---|---|---|
| `POST /new-transaction` | header `CONVAI-API-KEY: <player key>` (checked against Convai's key table; 401 "Invalid API key provided") | `{price_id, coupon_id?, success_url?, cancel_url?, tolt_referral_id?}`; both URLs default to `https://convai.com/pricing` | `{customer_id, "Reference ID", checkout_url, convai_payment_transaction_id}`; `checkout_url` is a Stripe-hosted subscription checkout. Errors: `{"ERROR": "..."}` with 500 |
| `POST /beta/get-user-details` (Convai says it moves to `/get-user-details`) | none (body only) | `{api_key}` or `{email}`, not both | `{api_key, email, user_id, username, organization_id, plan_name, start_ts, expiry_ts, stripe_subscription_id, customer_id, STATUS}` |
| `POST /get-portal-url` | `CONVAI-API-KEY` | `{action: OPEN_PORTAL / OPEN_TO_CANCEL_SUB / OPEN_TO_UPGRADE_DOWNGRADE_SUB}` | `{"redirect-url", STATUS}`, a Stripe billing portal session that returns to `https://convai.com/management/billing` (not used by the mod) |
| `POST /cancel-subscription` | `CONVAI-API-KEY` | none | `{churnkey_security_token, customer_id}`: an HMAC of the customer id with Convai's Churnkey secret, encrypted with a Convai server key. Convai's web dashboard decrypts it in the player's signed-in session and starts the Churnkey widget (Convai's public Churnkey app id) on its billing page. The mod cannot use it and does not call it |

- **Payment outcome:** Convai's Stripe webhook (`/payments-webhook`) records it. Convai says the plan is active about 15 seconds after the payment. There is no client-side success callback, which is why the mod polls the plan.
- **Rate limits:** none in the payments service itself. Convai's API gateway (`ConvAI_Middleman`) has a per-path rate-limit registry. Its numbers were not read. The mod makes at most a few calls per purchase.

## How it works

- **Bridge (`bridge/convai-paid-tier.mjs`, wired in `bridge/convai-bridge.mjs`):**
  - `PaidTierControl` reads `runtime/paid-tier-command.json` every 500 ms, like the other settings actions. Commands are `{version: 1, id, action, plan?, issuedAt}` with action `refresh`, `buy`, `check`, `manage` or `key-page`. A command older than 30 s, or one left from an earlier session, is ignored.
  - It answers in `runtime/paid-tier-state.json`: `{version, updated, keySaved, plans (without price ids), plan: {name, paid, checkedAt}, watch: {state: watching|active|timeout, plan, startedAt}, result: {id, state}}`.
  - **buy:** reads the account's current plan (the baseline), asks `/new-transaction` for the plan's price id, and opens the answer only if it is an https page on stripe.com or convai.com. The browser opener is the editor's `openInBrowser`, with no shell. It then follows the plan: every 6 s for the first minute, then every 20 s, for five minutes at most. "Active" means a paid plan name (not free or trial, not expired) that differs from the baseline in name or expiry, so an existing plan is not mistaken for the new one. The timer stops at the first confirmation, at the timeout and at shutdown.
  - **refresh** (the page opens): reloads the backend plan list (at most every 10 minutes) and reads the plan (at most once a minute). **check:** reads the plan now. **manage / key-page:** open `https://convai.com/management/billing` / `https://convai.com`.
- **Key handling:** the key used is the player's saved key (`ConvaiKeys.player`, `player-convai-key.txt`), never the shared one. It goes only to the payment host, which must be a convai.com https address even when the server list says otherwise. It never enters a state file, a log or an error. Convai's details answer includes the account's e-mail address and the key; only `plan_name` and `expiry_ts` are kept. Times without a zone are read as UTC.
- **Lua:**
  - `mod/convai-paid-tier.lua` writes the command (temporary file and rename) and reads the state, at most every 1.5 s while the page asks.
  - After a Buy or a Check it reads the state every 2 s until the outcome is known, for seven minutes at most. Reopening the page does not end an open purchase.
  - `mod/manager-ui.lua` builds the page (view `paid-tier`, its own redraw signature). Its slow tick (4 Hz, already there) calls `paidTier.update()`, which returns at once while nothing is followed. On `active` it calls `manager.applySettings(player, {conversationProvider = 'convai', useOwnConvaiKey = true})`, the same path as a change made in the selector. Mature content goes off by the existing rule. The notice waits for gameplay.
- **Conversations at once:**
  - A player's key on a confirmed paid plan may hold up to `PAID_CONNECTIONS` (6) conversation connections at once, so several companions can talk and generate together. A free, unknown or unread plan keeps one, as before.
  - **Where:** `exclusive.limit()` in `bridge/realtime-host.mjs`. Before a request, idle connections in the phone and party hosts are closed, least recently used first, until the request fits under the limit. A busy connection is never closed. A "Concurrency limit reached" answer is still retried once after 1.5 s.
  - **Source:** the bridge's `connectionLimit()` asks `PaidTierControl.connectionLimit()`, which is memory-only and runs before each request. It is 6 only when the last plan answer was for this very key, says paid (not free or trial), has not expired and is at most 12 hours old. With Mistral active it is 1.
  - **When the plan is read:** only while the player's key is in use (`wantPlan`). The control's 500 ms poll starts one background read when there is no answer yet, the answer was for another key, or it is more than 6 hours old. A page check and a purchase update it too. A failed read forgets the answer, so the key falls back to one connection, and it retries after 10 minutes (`PLAN_TIMING`). One log line marks each change.
  - **What stays off:** prefetch and the pre-opened party, phone and ambient connections stay off for any player key, paid or not (`singleSession()` in the bridge is unchanged). That saves the player's monthly interactions. Multilingual conversations also stay off on a player's key. The one exception is the spawned lane (2026-10-17, `docs/SPAWNED_CHARACTERS.md`, "First talk without the connection wait"): up to `min(3, connectionLimit - 1)` characters another mod or a spawner created are connected when the game first lists them near V, so the first talk skips the 3 to 5 s connection. Opening is not a turn, so it spends no interaction; a free, unknown or unread plan gets none.
  - **What is on from 2026-10-17 (branch `group-latency`): group look-ahead on a confirmed paid plan.** A live group round on the player's own key on `GamerPlanV2-Monthly` paid 8 to 9 s at every speaker change, because look-ahead was off for every player's key. It is now off only where the plan allows one connection (free, unknown or unread; `lookaheadAllowed` in `bridge/group-lookahead.mjs`, asked with `connectionLimit()`), and with Mistral or the local AI. On a paid plan the next speaker's turn runs while the previous one is heard, and the first speaker's request opens the other speakers' conversation pages at once (`warmRoundAhead` in the bridge: sends nothing, writes no memory). A look-ahead turn is a real turn and counts as one interaction; it costs one that is never heard only when the round is interrupted after the next speaker was requested (a new message, a dismissal, an audience change). A solo turn and a private chat change in nothing. See `docs/GROUP_VOICE.md`, "Look-ahead on a player's own key".
- **Performance:** nothing runs per frame and nothing is loaded. While the page is closed and no purchase is followed, the Lua side does no work and the bridge does one small file read every half second.

## Changes after the first live look (2026-10-16, branch `paid-tier-fixes`)

The user opened the page, bought the Gamer monthly plan with Buy, saw the plan update on Convai's dashboard and on the page, and had replies on their own key. Four things came out of it:

- **The status line stuck.** MCM's status text (the line under the mod list on the left) was set once, from the answer to the click ("Asking Convai for the payment page…", "Checking your plan…"). `mod/mcm.lua` only rewrites that line in place for the party's preparation notices; the paid tier page redrew its rows when the service answered (the plan row's help changed) but nothing touched the status widget, and a redraw does not bring back an action's text. Now a paid tier action keeps its text in `paidStatus`, and the 1 s look in `M.update` (`followPaidStatus`) takes the sentence for the latest result from `mod/convai-paid-tier.lua` (`message`) and `updatePreparationBanner` writes it to the line in place: contacting Convai, the payment page open, plan active (once the bridge's watch reports it) or not confirmed in time, a check's answer, refusals. It reads the state file only while the answer is awaited (`settled` ends it: a final result, the page left, or seven minutes). Nothing is added per frame.
- **Friendly plan names.** The plan row reads "Gamer, monthly", "Gamer, yearly", "Gamer Pro, monthly", "Gamer Pro, yearly" and "Free" (a free, trial or used-up plan); an unknown paid name is shown as Convai wrote it. All in the 15 locales.
- **Quotas** in the plan rows (the page takes them from its own table in `mod/convai-paid-tier.lua`, `QUOTAS`, not from the number the running service published: after a CET reload without a service restart the service still sent 1000 for Gamer and none for Gamer Pro, and the user saw the wrong numbers; a plan family the table does not know shows the service's number): Gamer 500, Gamer Pro 1000 interactions a month (the "More Convai interactions a month than Gamer" string is gone).
- **Provider settings order (2026-10-16):** the key row "Mistral free API key" (was "Mistral API key") now sits above the "Convai API key" row; the paid tier entry stays right under the Convai key row.
- **Current plan.** The row of the plan the key has now says **Current plan** and does nothing. A used-up plan (`paid` false) marks no row.
- **Six connections:** the bridge log showed `paid Convai plan: up to 6 conversations at once` once after the purchase, right before `Conversation key: the player's own`, so the switch from one connection to six happened for `GamerPlanV2-Monthly`. No fix was needed.
- **Sign in with Convai** stays hidden while a key is saved (the key was pasted, so the row is gone, as designed).

## Sign in with Convai

Built 2026-10-15 on branch `convai-signin`. Unit-tested with Convai's login page and decrypt route mocked. Not yet tried against the live login page and not seen in the game.

**Where the flow comes from.** Convai's login page (`login.convai.com`, private repository `Conv-AI/ConvAI-Authentication`, `frontend/src/components/AuthHandler.tsx` on its `prod` branch, read 2026-10-15) already has a desktop hand-back that Convai's own Unreal Engine plugin uses (`Conv-AI/Convai-UnrealEngine-Auth`). The mod uses the same flow, so no Convai, Firebase, Vercel or backend setting changes:

1. The bridge opens a listener on a free loopback port: `127.0.0.1`, plus `::1` on the same port when the computer has IPv6 loopback. A port whose `::1` side another program holds is never used.
2. It opens `https://login.convai.com/?ue=true&port=<port>` in the system browser (the same opener as the other pages, no shell).
3. The player signs in on Convai's page (Google, e-mail, or a new account). If they are already signed in to convai.com, this step is skipped.
4. Convai's page sends the browser to `http://localhost:<port>/control?api_key=<encrypted key>&user_info=<encrypted account>`. Both values are Convai's AES-encrypted login cookies (`CONVAI_API_KEY`, `CONVAI_AUTH`), not the key itself.
5. The listener answers at once with a redirect to `/done`, so the encrypted values leave the address bar. It reads the values raw (a `+` stays a `+`; Convai's route decodes them once itself).
6. `POST https://login.convai.com/api/decrypt` with `{"data": <encrypted key>}` answers `{"decryptedData": <key>}`. If that gives no plausible key, the account value is decrypted the same way; its JSON carries `apiKey` (and the e-mail address, plan and so on, which are dropped at once).
7. The key is checked with Convai (`validateKey`, the same check Paste uses: `POST https://api.convai.com/character/list`, no interaction used). A refused key is not saved. Otherwise it goes through `saveKey`, the same path as Paste: the key file, the quota reset and the own-key status. A sign-in alone changes no setting, as with Paste.
8. `/done` shows "Signed in" or "Sign-in did not finish" and the listener closes.

**The pieces.**
- `bridge/convai-signin.mjs`: the listener, the hand-back and the decrypt call. `startConvaiSignIn()` returns `{opened, key, cancel}`.
- `PaidTierControl` (`bridge/convai-paid-tier.mjs`): a new command action `sign-in`. It answers `signing-in` as soon as Convai's page was asked to open, so other commands are not held up while the player signs in. The outcome comes later as the same command's result: `saved`, `invalid-key`, `signin-timeout`, `signin-failed` or `open-failed`. A new sign-in cancels one still waiting, and so does the service stopping. Without a sign-in function, `sign-in` opens the key page. `key-page` now only opens the key page.
- `mod/convai-paid-tier.lua` and `mod/manager-ui.lua`: the **Sign in with Convai** row and one message per outcome, shown in the help of **Your Convai plan**. No new polling: the page reads the state file as before (at most every 1.5 s while it is open).

**Guarantees.**
- Nothing runs until the player chooses Sign in. Nothing runs per frame. The listener exists only while a sign-in waits: at most five minutes (long enough to make an account and confirm the e-mail address), then it closes. One sign-in per listener; the first good `/control` request wins and later ones get 404.
- The listener answers only on loopback, only `GET`, only with a `Host` of `localhost`, `127.0.0.1` or `[::1]` on its port (a guard against DNS rebinding). Its pages are `no-store`, `no-referrer`, with a CSP that allows no script.
- The key and the encrypted values are never logged, never put in a URL by the mod, and never written anywhere except through `saveKey`. The encrypted values go only to `https://login.convai.com` (any other decrypt address is refused).
- Latency: one decrypt call (two at most) and one key check after the browser comes back, a second or less.

**What remains (Convai's design, not changeable from the mod).**
- The encrypted values travel in the loopback URL, so they can stay in the browser's history. Convai's decrypt route answers any caller that does not send a browser `Origin` (its CORS list only limits browsers), so an encrypted value is as good as the key to whoever reads it. The mod cannot change this; it is a question for Convai below.
- The hand-back carries no `state` value, so a page on the same computer could in principle send the browser to the listener with someone else's encrypted key during the five minutes. The worst outcome is that the player's mod gets another account's working key; the random port, the one-shot listener and the short window keep this unlikely.
- The flow depends on the login page keeping its `ue=true&port=` parameters. Convai's own Unreal plugin depends on them too.

**Fallback if Convai ever closes this flow.** A page of our own (on the Vercel backend) can sign in against Convai's Firebase project and exchange the Firebase ID token for the key with `POST {Convai user service}/user/login` (header `IdToken: <Firebase ID token>`, body `{"email": ...}`; the answer has `api_key`, `plan_name` and more). That is what Convai's login service itself does (`backend/internal/convaiHelpers/login.go`). It needs outside changes (our domain added to the Firebase project's authorized domains, the Firebase web config, and Convai's agreement that `/user/login` may be called this way), so it was not built.

## Price ids and where they can change

- **Built in:** `DEFAULT_PAID_TIER` in `bridge/convai-paid-tier.mjs` (prod, from Convai 2026-10-15):

  | Plan | Price | Price id |
  |---|---|---|
  | GamerPlanV2-Monthly | $4 | `price_1UQj9YHC9LzXKZDPTHUfkDuj` |
  | GamerPlanV2-Yearly | $32 | `price_1UQjA5HC9LzXKZDPPqOe4ji3` |
  | GamerProPlanV2-Monthly | $8 | `price_1UQjPvHC9LzXKZDP2lrHSw6j` |
  | GamerProPlanV2-Yearly | $64 | `price_1UQjPvHC9LzXKZDPXqfCGpP0` |

  Convai first sent the same id for both Pro plans and corrected the yearly one the same day.
- **Duplicate guard:** a list in which a price id repeats drops the later plan in the mod and is refused whole by the backend. A copy error can never put a yearly label on the monthly charge.
- **Server override (no mod update):**
  - Set with `POST /api/admin/config {"paidPlans": {...}}` on `auth-backend/`, read publicly at `GET /api/convai/plans`. See `auth-backend/README.md`, "Changing the Convai paid tier's plans".
  - A bridge uses it when it knows the backend address: backend mode on in `convai-auth.json`, or `CYBERPUNK_CONVAI_PLANS_URL`. Every other bridge uses the built-in list.
  - **Not deployed, by the user's decision (2026-10-15):** the release uses the built-in list. The endpoint and the admin field stay on this branch for later. Until a deploy, the URL answers 404 and the built-in list applies.

## What is left open

- **Sign in with Convai** (branch `convai-signin`): built and unit-tested, not yet tried against the live login page. Questions for Convai:
  - May the mod use the login page's `ue=true&port=` hand-back, and will it stay?
  - Could the hand-back carry a `state` value we pass in, and hand back a short-lived one-time code (exchanged server to server) instead of the encrypted cookies in the URL?
  - `/api/decrypt` decrypts for any non-browser caller. Is that intended? If it ever needs a secret or an allowlist, the sign-in stops working.
  - Can the plan check (`get-user-details`) and conversations accept something narrower than the permanent key, for example the personal access tokens or OAuth tokens the login service has started to issue?
- **Cancellation (Churnkey):** handled by opening Convai's billing page, where Convai's own Churnkey flow runs inside the player's convai.com session. No Churnkey key or snippet is needed in the mod. If Convai wants the flow inside the game, they need to give a client-usable token (the current one is encrypted with their server key) and confirm the app id.
- **Quotas (from the user, 2026-10-16):** Gamer gives 500 interactions a month and Gamer Pro 1000. They are built in (`interactions` in `DEFAULT_PAID_TIER`, or in the server list) and shown in the plan rows' help. A plan without a number shows no quota sentence.
- **Plan names (confirmed 2026-10-16):** a live purchase of the Gamer monthly plan made `get-user-details` answer `plan_name` `GamerPlanV2-Monthly`. The four names are `GamerPlanV2-Monthly`, `GamerPlanV2-Yearly`, `GamerProPlanV2-Monthly` and `GamerProPlanV2-Yearly` (`KNOWN_PAID_PLANS`, recognised by name in `isPaidPlanName`). The old rule stays as the fallback: any other name that is not empty, `-1`, `none`, or containing "free" or "trial" is paid, so a plan Convai adds later still counts.
- **Multilingual conversations** stay off on a player's key (free plans have no multilingual support). Whether the Gamer plans include it is unknown.
- **`get-user-details`:** on `main` of the payments repository it is unauthenticated and answers by e-mail address as well as by key. That is worth raising with Convai. Its branch `fix/beta-router-auth` puts a secret on the `/beta` admin routes; if that ever covers `get-user-details`, the plan check returns "could not be read" and the purchase still works. The mod tries `/get-user-details` first, then `/beta/get-user-details`.

## Tests

- `bridge/convai-paid-tier.test.mjs`: endpoint shapes, failures mapped to reasons, only Stripe or Convai pages opened, key and price ids never in the status file, polling cadence and five-minute stop, baseline comparison, duplicate price ids, server override limits, stale commands.
- `bridge/convai-paid-tier.test.mjs`, V2 names (2026-10-16): the four names are paid by name, free and empty names are not, an unknown non-free name is still paid, the built-in quotas are 500 and 1000, and a key on `GamerPlanV2-Monthly` goes from one connection to six with one log line for each change.
- `bridge/convai-paid-tier.test.mjs`, connections: the plan is read only while the key is in use, once, and refreshed after six hours; a paid plan gives six and a free one gives one; a failed read gives one and retries after ten minutes; another key, an expired plan or an answer older than 12 hours gives one; the key never reaches the state file; and the old sign-in seam test is replaced by the sign-in tests below.
- `bridge/realtime-single-session.test.mjs`: with a limit of six only the excess idle connections close, oldest first, across both hosts; a busy one never closes; a broken limit means one.
- `bridge/convai-paid-tier-ui.test.mjs`: the real `manager-ui.lua` and `manager.lua` in fengari. Covers the row position, the plan rows and their wording, no purchase without a key, the provider switch and one notice after a confirmed purchase, the timeout notice, a later check, and a refused checkout. Added 2026-10-16: the plan row's friendly names, the Current plan row, the status line following working, opened, active, not-yet, timeout and refusal (and stopping after a final answer or seven minutes).
- `bridge/convai-signin.test.mjs`: the login page address and port; a real loopback listener receiving Convai's hand-back; the encrypted value passed on unchanged (with `+`); the account value as the fallback; a bad answer; the timeout and cancel closing the listener; wrong Host, wrong path, empty or malformed values and a second hand-back refused; a browser that will not open; a port whose `::1` side is taken; decrypt errors mapped to reasons; a decrypt address off convai.com refused.
- `bridge/convai-paid-tier.test.mjs`, sign-in: `signing-in` at once, then `saved` through the Paste path with the key checked first; `invalid-key`, `signin-timeout`, `signin-failed`, `open-failed`; a new sign-in or shutdown cancels the waiting one; without a sign-in the key page opens. The key never reaches the state file.
- `bridge/convai-paid-tier-ui.test.mjs`, sign-in: the row sends `sign-in`, each outcome is worded on the page, and the row goes once a key is saved.
- `auth-backend/test/plans.test.mjs`: admin set, show and remove; the public read with its one-minute cache; refusal of duplicate prices or foreign hosts; a store that is down.
