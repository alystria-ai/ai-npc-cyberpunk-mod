# Own Convai API key (Settings > Conversation provider)

A developer, or a player who has a Convai API key of their own, can use it instead of the key the installation provides. Conversations then use that account and its allowance. Nothing else about the mod changes.

This route is not promoted to players (decision of 2026-10-12): the daily-limit notice and the player documents do not point to it, and players are pointed to the free Mistral option instead (docs/MISTRAL.md), and later to a fully local option. Since 2026-10-14 it is a normal entry of the Conversation provider selector: the entry **Convai API key** and its one key row are always listed in Settings > Conversation provider (also with Mistral or Local chosen); the old switch "Use my own Convai API key" and the Developer-mode gating of the rows are gone. The code path stays for development and for a possible paid tier later.

## Can another account's key talk to our characters?

Yes, with no setup by the player. Evidence:

- A read-only probe of the character list on October 10, 2026 found that all 308 mod characters are `listing=public`. (`/character/list` run with the shipped key; no turn was sent and nothing was changed.)
- Convai's realtime `/connect` answers for a character that belongs to the key's account, or a character whose listing is public or unlisted, and answers 404 otherwise. This comes from reading the service code, which is private and not reproduced here. A connection with a made-up key answers 401 `{"detail":"Invalid API key"}` (probed once, zero cost).
- The plan, the interaction count and the speakers (memory users) are charged to the key's account, not to the character's owner. That is why a player key spends the player's allowance.

Not verified, because it needs a real free key: whether the free plan's long-term-memory flag changes memory behaviour.

Found in the first live test (October 10, bridge log): the first conversation on a real free key failed with `LTM speaker limit reached`. That is a plan limit on how many people the plan may remember, not a used-up plan: the free plan allows one long-term-memory speaker (a speaker is one end-user id; the mod uses one per install) and Convai counts every speaker the account was active with in the last 30 days, so an account that already used memory elsewhere has no room for a new one. The first version of this feature wrongly showed it as "plan limit reached". It is now handled as described under "Plan without room for memory".

Plan facts used by the design: Free is 100 interactions a month with one concurrent connection and no multilingual support. The Gamer plan is 4000 interactions a month with one concurrent connection and a long-term-memory speaker limit of 5.

The Gamer plans Convai made for this mod (2026-10-15, bought from Settings > Convai paid tier, docs/CONVAI_PAID_TIER.md) differ: Gamer V2 is 500 interactions a month with 6 concurrent connections, Gamer Pro V2 is 1000 a month (Convai's figures, from the user, 2026-10-16). On a confirmed paid plan a player's key may hold up to six conversation connections at once, so several companions can talk and generate together; warm-up turns stay off, so they do not spend the player's interactions. Group look-ahead is on for it (2026-10-17, `docs/GROUP_VOICE.md`): the next speaker's turn is the turn that would be sent anyway, only earlier. Characters another mod or a spawner created are connected when the game first lists them near V (up to three, fewer on a smaller plan; `docs/SPAWNED_CHARACTERS.md`), so the first talk to them does not wait for the connection. A free, unknown or unread plan keeps the single-session rule below.

## What Convai returns when a plan is used up

- At session start and every 15 seconds the service checks the quota. When it is used up it sends one data-channel message inside a server message, then closes the session:
  `{"type":"usage-limit-reached","quota_type":"interaction"|"tts"|"error","message":"..."}`.
  `quota_type: "error"` is a service configuration fault and is not treated as a used-up plan.
- At connect time: 401 invalid key, 429 `Concurrency limit reached`, 429 `LTM speaker limit reached` or `speaker limit reached` (503 `LTM speaker allowance is not configured for this plan` is treated the same), 403 realtime access not allowed, 404 character not found, and 400 `Missing end_user_id` when a memory-enabled character is connected without an end user.

`bridge/realtime-client.mjs` turns the usage-limit message into the failure text `Convai usage limit reached [convai-quota:interaction|tts|plan]`. `bridge/convai-quota.mjs` classifies failures by their text: `quota` (interactions used up), `speaker` (the memory-user limit), `memory` (an identity is required and unavailable), `rejected` (key or realtime access refused) and `busy` (concurrency). Only `quota` is shown as "limit used up"; the others have their own wording.

## Plan without room for memory

Every conversation of the mod carries one end-user id so Convai can keep long-term memory. The id is the mod's own (a UUID in `player-memory.json`) for the installation's key. Convai's plan counts memory users (end users) per account, and the free plan allows very few (the first live test: an account that already held two users, made in Convai's own playground, refused the mod's new id). So a player's key does not insist on a new user:

1. When the key's account refuses the id ("LTM speaker limit reached"), the bridge lists the account's end users (read-only `POST /user/end-users/list`), takes the most recently active one that was not tried yet, and repeats the request with it. `ConvaiKeys.adoptUser` and `memoryRecovery` in `bridge/convai-key.mjs`, the host's (async) `recover` hook.
2. That id becomes the player's one id on that key: every request on the key carries it from then on (`ConvaiKeys.identify`, applied by `memoryPolicy` in `bridge/convai-bridge.mjs` to the realtime, phone and microphone configurations), and it is saved in `player-convai-user.json` in the bridge state folder, tagged with a one-way hash of the key, never with the key. The next session reuses it without a lookup. Pasting another key, or removing the key, forgets it. The local identity (`player-memory.json`, its guards and epochs) is unchanged; only the id sent to Convai is replaced, and only on the player's key. The installation's key keeps the mod's id.
3. Sessions and phone threads opened under the old id start afresh once (the visible transcript stays). The player sees no notice: memory works.
4. An adopted id that the account refuses later is dropped and the next user is tried. Only when there is none (an empty account, or the list cannot be read) does the bridge fall back to the anonymous request below.

Because the adopted id is a user the account already had, its memories are shared with whatever else used it (for example the Convai playground chats). To use a clean id instead, delete the account's end users in Convai first and let the mod create its own.

### Anonymous fallback

Only when no memory user can be adopted, the bridge repeats that one request without the end-user id and runs the rest of the key's conversations the same way (`withoutIdentity`). What is reduced, and nothing else:

- Companions do not keep long-term memory of conversations on that key.
- Offered companion actions that need an identified session (for example asking the companion to drive) are not offered in conversations.
- Sessions and phone threads started under the identity start afresh; the visible transcript stays.

The game says so once per session (`key-memory`, shown with the first reply that ran without memory) and the provider note at the end of the Conversation provider row's help reads "running without memory". A different key, or choosing another provider entry and back, starts again with memory on. Voice turns cannot be repeated midway: the first voice turn adopts or switches memory off and the next turn uses the result.

The anonymous request is refused too for the characters of this mod: they are shipped with long-term memory on, and Convai answers 400 `Missing end_user_id. end_user_id is required when the character has Long Term Memory enabled.` (seen in the bridge log, October 10). Then the key cannot hold the conversations at all; the game says to free a memory user in the Convai account or use another key (`quota-exhausted`, shown once) and tries the identified request again next time. That is why adopting an existing user is the primary answer.

## Daily limit on the shared plan

The release package's own Convai key is shared by every player, so it is limited. Code: `bridge/shared-key-guard.mjs`, `bridge/key-codec.mjs`; wired in `bridge/convai-bridge.mjs` and `bridge/realtime-host.mjs`.

- **What counts.** One per turn that goes to Convai, counted at the single choke point (`RealtimeHost`): a typed or spoken turn, a Phone Chat message, each speaker of a group round, a look-ahead turn (it is a real response even if the game later discards it) and an automatic reaction. A microphone turn is checked when the recording starts and counted when it is finished. Opening, warming or retrying a connection is not a turn. A failed turn is still counted (the bridge cannot tell what Convai billed). Never counted: a player's own Convai key, and any other provider.
- **Cap.** `DAILY_LIMIT` = 500 turns per **local calendar day** (resets at local midnight; a clock set back does not return the allowance). The one place to change it is `DAILY_LIMIT` in `bridge/shared-key-guard.mjs`.
- **Rate limit.** A token bucket of 15 turns refilled at 12 a minute, and at least 250 ms between turns. It also applies when no counter file can be read. A normal evening (a few turns a minute, a five-person group round) never meets it.
- **When the cap is reached.** The bridge refuses the turn before any connection is opened, with the failure text `Daily conversation limit reached [convai-quota:daily]`; `convai-quota.mjs` turns it into the reply code `daily-limit`. The game shows the `daily-limit` notice (once per game session): Convai (better quality responses) is back tomorrow; to keep talking now the player adds a free Mistral key and sets Conversation provider to Mistral in Settings > Conversation provider; a fully local option is coming. Phone Chat shows the same line on its status row. Automatic reactions (battle, loot) just stop: no code is sent and the game shows nothing. With the Convai free tier chosen, the last paragraph of the Conversation provider row's help reads "x of y left today" and, at the cap, the limit-reached note (the bridge publishes `daily` in `runtime/own-key-state.json`).
- **Counter storage.** Two signed copies: `<state folder>/daily-usage.json` and `%LOCALAPPDATA%\CyberpunkConvai\daily-usage.json`. Each holds `{v, day, count, seen, mac}` with an HMAC-SHA-256 keyed from the computer's machine GUID, so a hand-edited or copied record is ignored. The newest valid copy wins, so deleting one copy changes nothing. If no valid copy exists the count starts at 0: a damaged file never blocks a player.
- **Packaged key.** `packaging/build-release.mjs` writes `app/defaults/service.txt` as `convai-key-v1 <base64url>` (key XOR a SHA-256 stream, salted, with a check value) instead of an `api-key = ...` line; the bridge decodes it in memory only. A plain `api-key=...` file (a developer's `runtime/convai-key.txt`, or a player's own `data/convai-key.txt`) is **not** limited: only a packed key is the shared one.
- **Development.** A checkout with a plain `runtime/convai-key.txt` is not limited. To test the limit with a plain key: `CYBERPUNK_CONVAI_DAILY_LIMIT=3` (any number) before starting the bridge. `CYBERPUNK_CONVAI_DAILY_LIMIT=off` (or `0`) switches the guard off. The packaged launcher removes this variable from the service environment.

What this does not stop: the bridge ships as readable source and the key ships inside the package, so someone who edits the code, deobfuscates the key or deletes both counter copies is not stopped. The bridge accepts turns only through files in the game folder (there is no port that accepts turns; its one local HTTP listener serves static client scripts on 127.0.0.1 and holds no key) and stops when the game exits, but a local process can write those files as well, so no token would add protection. The measures only make casual abuse (looping the packaged program for thousands of turns) slow and conspicuous.

## What the player sees

- Settings > Conversation provider has the selector **Conversation provider** with four entries: Convai free tier (default), **Convai API key**, Mistral (free plan) and Local AI. Choosing "Convai API key" stores `conversationProvider = 'convai'` with `useOwnConvaiKey = true`. Below it is one key row, always listed, with one button: **Paste** while no key is saved, **Remove** once one is. The status is in brackets in the row name: `Convai API key (...a1F9)` (the last four characters), `(Added)` when a key is saved but no tail is known, `(Checking...)` while it is checked, `(Not added)` after a failed paste (the failure message is then the first paragraph of the row's help). Which plan is paying and whether it is used up or refused is the last paragraph of the selector row's help (the former `Conversations use` row is gone). The mod's menu (Native Settings UI, drawn by the game) has no text field, so the key is pasted from the clipboard.
- Migration (once, on load, marker `convaiProviderChoice` in `settings.json`): an old switch that was on with a key saved becomes "Convai API key"; otherwise "Convai free tier". A saved Mistral or Local choice is untouched.
- When a reply fails because the plan is used up, one notice (`quota-exhausted`, once per game session) says to try again later or use a free Mistral key (Conversation provider in Settings > Conversation provider). The text differs for an own key (limit reached, or key not accepted). The notice never says where the shared key comes from.

## How it works

- Paste: the Lua side writes `runtime/own-key-command.json` (`{version:1,id,action:'paste'|'clear',issuedAt}`). The bridge reads the clipboard with PowerShell once, checks the shape of the key, lists characters with it (`/character/list`, no conversation turn), and saves it in its own state folder as `player-convai-key.txt`. An offline check does not block saving; a 401 or 403 does.
- Status: the bridge writes `runtime/own-key-state.json` (`preference`, `saved`, `tail`, `active`, `pending`, `result`, `limit`). It never contains the key. The key is never in `settings.json`, in any log, or in a support report (it is added to the report's scrub list).
- Provider entry: `settings.json` carries the boolean `useOwnConvaiKey` (true for the "Convai API key" entry). The bridge changes the key in use only when no turn, microphone, preparation or route change is running. It then drops look-ahead state, closes both realtime hosts, clears conversation sessions (and phone sessions) and keeps the transcript.
- Single session: a free key allows one connection at a time (a confirmed paid Gamer plan allows six: docs/CONVAI_PAID_TIER.md, "Conversations at once"; everything else in this item still applies to it). With a player key background maintenance pre-opens nothing (no warm party connections or prefetch); group look-ahead stays off on a one-connection plan and runs on a confirmed paid plan (a round also opens its other speakers' pages at once, `warmRoundAhead`). The one exception is a joining companion: her invitation opens her own connection, one at a time and only while no conversation is running, and is ready once it is open (so "joined" follows a prepared connection); a failed or cooling-down attempt does not fail the invitation, and later probes report it ready without swapping pages. The other party members connect when V talks to them. The spawned lane is the one other pre-open on a player's key (a confirmed plan with room only, never a message or memory write). A request first closes the other idle connections, and a concurrency refusal is retried once after 1.5 s.
- The multilingual twins are not used on a player key (the free plan has multilingual support off). Memory management is unavailable: the characters belong to the developer's account, so clearing and inspecting memories is refused and enabling is skipped.
- Cost: nothing runs per frame. The status file is read by the settings page about once a second while it is open.

## Testing

1. `npm run build:voice` (rebuilds `runtime/realtime-client.js` with the quota marker), restart the bridge, CET reload.
2. In Settings > Conversation provider, with a Convai key copied to the clipboard, press **Paste** on the Convai key row. The row name should read `Convai API key (...` followed by the last four characters) and the button should now read **Remove**.
3. Set the Conversation provider selector to **Convai API key** and choose Apply. Once nothing is running, the last paragraph of the selector's help should not show a limit or rejection note. Talk to a companion.
4. A used-up plan cannot be forced. Unit tests cover the wire message and the notice codes; a free key near its allowance shows the notice for real.
