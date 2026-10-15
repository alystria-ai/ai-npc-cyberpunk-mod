# Convai paid tier (Settings > Conversation provider > Convai paid tier)

Built 2026-10-15 on branch `convai-paid-tier`. Unit-tested with every Convai and backend endpoint mocked. No checkout was created, no payment was made and no live Convai turn ran. Not yet seen in the game.

Convai made "Gamer" plans for this mod. A player who wants more Convai conversations than the free tier gives can buy one from inside the mod, on their own Convai account, and the mod then uses that account's key. Conversations still go to the developer's account by default. Nothing changes for a player who never opens the page.

## What the player sees

- **Settings > Conversation provider** has a new row, **Convai paid tier** (Open), right under the **Convai API key** row.
- The page it opens has these rows:
  - **Your Convai plan:** the plan Convai reports for the saved key, "No key added", or "Not checked yet". The result of the latest action is the first paragraph of its help.
  - **Get your Convai API key** (only while no key is saved): opens convai.com in the browser.
  - **The Convai API key row:** the same Paste / Remove row as on the provider page.
  - **One row per plan:** "Gamer, $4 a month", "Gamer, $32 a year", "Gamer Pro, $8 a month" and "Gamer Pro, $64 a year", each with a **Buy** button. The help says what the plan gives (Gamer: 1000 Convai interactions a month; Gamer Pro: more), how it is billed, and that the payment happens on Convai's Stripe page. The buttons are greyed out until a key is saved.
  - **Check my plan:** asks Convai now.
  - **Manage or cancel plan:** opens the player's Convai billing page.
- **After Buy:** Stripe's checkout page opens in the browser. Once Convai reports the new plan, the Conversation provider becomes **Convai API key**, saved at once as an Apply would. One notice then says so in gameplay (`paid-tier-active`). If Convai has not confirmed the plan five minutes after the page opened, one notice points to **Check my plan** (`paid-tier-pending`). A later check that finds the plan makes the same switch.
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
  - `mod/mcm.lua` builds the page (view `paid-tier`, its own redraw signature). Its slow tick (4 Hz, already there) calls `paidTier.update()`, which returns at once while nothing is followed. On `active` it calls `manager.applySettings(player, {conversationProvider = 'convai', useOwnConvaiKey = true})`, the same path as the selector's Apply. Mature content goes off by the existing rule. The notice waits for gameplay.
- **Performance:** nothing runs per frame and nothing is loaded. While the page is closed and no purchase is followed, the Lua side does no work and the bridge does one small file read every half second.

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
  - **Needs a backend deploy, which needs the user's approval:** the endpoint and the admin field are on this branch only. Until it is deployed the URL answers 404 and the built-in list applies.

## What is left open

- **Convai Connect sign-in:** the mod has no Convai login. The player's key comes from the clipboard, through the existing Paste row. The page's **Get your Convai API key** row opens convai.com so the player can sign in there and copy it. A real Convai Connect flow, sign-in that hands the key to the app, needs Convai's documentation for it. None was found in the payments repository or the public docs.
- **Cancellation (Churnkey):** handled by opening Convai's billing page, where Convai's own Churnkey flow runs inside the player's convai.com session. No Churnkey key or snippet is needed in the mod. If Convai wants the flow inside the game, they need to give a client-usable token (the current one is encrypted with their server key) and confirm the app id.
- **Gamer Pro numbers:** Convai only said "more". The page says "More Convai interactions a month than Gamer" until a number is set (built in or through `interactions` in the server list).
- **Concurrency:** the Gamer plan's 6 concurrent connections are not used. A player's own key keeps the single-session rule (`ConvaiKeys.singleSession`, docs/OWN_CONVAI_KEY.md). That rule also stops look-ahead and warm-up turns from spending the player's 1000 monthly interactions. The page therefore does not advertise concurrency. Lifting the rule for paid keys is a separate decision.
- **Multilingual conversations** stay off on a player's key (free plans have no multilingual support). Whether the Gamer plans include it is unknown.
- **`get-user-details`:** on `main` of the payments repository it is unauthenticated and answers by e-mail address as well as by key. That is worth raising with Convai. Its branch `fix/beta-router-auth` puts a secret on the `/beta` admin routes; if that ever covers `get-user-details`, the plan check returns "could not be read" and the purchase still works. The mod tries `/get-user-details` first, then `/beta/get-user-details`.

## Tests

- `bridge/convai-paid-tier.test.mjs`: endpoint shapes, failures mapped to reasons, only Stripe or Convai pages opened, key and price ids never in the status file, polling cadence and five-minute stop, baseline comparison, duplicate price ids, server override limits, stale commands.
- `bridge/convai-paid-tier-ui.test.mjs`: the real `mcm.lua` and `manager.lua` in fengari. Covers the row position, the plan rows and their wording, no purchase without a key, the provider switch and one notice after a confirmed purchase, the timeout notice, a later check, and a refused checkout.
- `auth-backend/test/plans.test.mjs`: admin set, show and remove; the public read with its one-minute cache; refusal of duplicate prices or foreign hosts; a store that is down.
