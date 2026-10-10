# Own Convai API key (Settings > Development)

A player whose game has run out of the shared conversation allowance can add their own free Convai API key. Conversations then use their account and their allowance. Nothing else about the mod changes.

## Can another account's key talk to our characters?

Yes, with no setup by the player. Evidence:

- A read-only probe of the character list on October 10, 2026 found that all 308 mod characters are `listing=public`. (`/character/list` run with the shipped key; no turn was sent and nothing was changed.)
- Convai's realtime `/connect` answers for a character that belongs to the key's account, or a character whose listing is public or unlisted, and answers 404 otherwise. This comes from reading the service code, which is private and not reproduced here. A connection with a made-up key answers 401 `{"detail":"Invalid API key"}` (probed once, zero cost).
- The plan, the interaction count and the speakers (memory users) are charged to the key's account, not to the character's owner. That is why a player key spends the player's allowance.

Not verified, because it needs a real free key: whether the free plan's long-term-memory flag changes memory behaviour.

Found in the first live test (October 10, bridge log): the first conversation on a real free key failed with `LTM speaker limit reached`. That is a plan limit on how many people the plan may remember, not a used-up plan: the free plan allows one long-term-memory speaker (a speaker is one end-user id; the mod uses one per install) and Convai counts every speaker the account was active with in the last 30 days, so an account that already used memory elsewhere has no room for a new one. The first version of this feature wrongly showed it as "plan limit reached". It is now handled as described under "Plan without room for memory".

Plan facts used by the design: Free is 100 interactions a month with one concurrent connection and no multilingual support. The Gamer plan is 4000 interactions a month with one concurrent connection and a long-term-memory speaker limit of 5.

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

The game says so once per session (`key-memory`, shown with the first reply that ran without memory) and the settings line reads "Your own key, without memory". A different key, or switching the setting off and on, starts again with memory on. Voice turns cannot be repeated midway: the first voice turn adopts or switches memory off and the next turn uses the result.

The anonymous request is refused too for the characters of this mod: they are shipped with long-term memory on, and Convai answers 400 `Missing end_user_id. end_user_id is required when the character has Long Term Memory enabled.` (seen in the bridge log, October 10). Then the key cannot hold the conversations at all; the game says to free a memory user in the Convai account or use another key (`quota-exhausted`, shown once) and tries the identified request again next time. That is why adopting an existing user is the primary answer.

## What the player sees

- Settings > Development has five rows: `Use my own Convai API key` (switch), `Convai API key` (status: Not added, or Added with the last four characters), `Paste Convai API key`, `Remove my Convai API key`, `Conversations use` (which plan is paying and whether it is used up or refused). MCM has no text field, so the key is pasted from the clipboard.
- When a reply fails because the plan is used up, one notice (`quota-exhausted`, once per game session) says to get a free API key at convai.com and add it in Settings > Development. The text differs for the player's own key (limit reached, or key not accepted). The notice never says where the shared key comes from.

## How it works

- Paste: the Lua side writes `runtime/own-key-command.json` (`{version:1,id,action:'paste'|'clear',issuedAt}`). The bridge reads the clipboard with PowerShell once, checks the shape of the key, lists characters with it (`/character/list`, no conversation turn), and saves it in its own state folder as `player-convai-key.txt`. An offline check does not block saving; a 401 or 403 does.
- Status: the bridge writes `runtime/own-key-state.json` (`preference`, `saved`, `tail`, `active`, `pending`, `result`, `limit`). It never contains the key. The key is never in `settings.json`, in any log, or in a support report (it is added to the report's scrub list).
- Switch: `settings.json` carries the boolean `useOwnConvaiKey`. The bridge changes the key in use only when no turn, microphone, preparation or route change is running. It then drops look-ahead state, closes both realtime hosts, clears conversation sessions (and phone sessions) and keeps the transcript.
- Single session: a free key allows one connection at a time. With a player key nothing is pre-opened (no warm connections, group look-ahead or prefetch), an invited companion counts as ready, a request first closes the other idle connections, and a concurrency refusal is retried once after 1.5 s.
- Multilingual conversations are turned off on a player key (the free plan has multilingual support off). Memory management is unavailable: the characters belong to the developer's account, so clearing and inspecting memories is refused and enabling is skipped.
- Cost: nothing runs per frame. The status file is read by the settings page about once a second while it is open.

## Testing

1. `npm run build:voice` (rebuilds `runtime/realtime-client.js` with the quota marker), restart the bridge, CET reload.
2. In Settings > Development choose Paste Convai API key with a free key copied from convai.com. The status should read Added with the last four characters.
3. Turn on Use my own Convai API key and choose Apply. `Conversations use` should read Your own key once nothing is running. Talk to a companion.
4. A used-up plan cannot be forced. Unit tests cover the wire message and the notice codes; a free key near its allowance shows the notice for real.
