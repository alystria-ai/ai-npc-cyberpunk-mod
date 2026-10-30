# Google Gemini as a conversation provider

Since 2026-10-30 companions can answer through Google's free Gemini plan. Mistral stopped giving free API keys to new accounts, so Google Gemini took the third place in **Settings > Conversation provider**, the spot Mistral had: Convai free tier, Convai API key, **Google Gemini (free plan)**, Local AI, Custom (OpenAI-compatible). Mistral became a preset on the Custom endpoint page ([MISTRAL.md](MISTRAL.md), [CUSTOM_PROVIDER.md](CUSTOM_PROVIDER.md), "Presets"). Convai free tier stays the default.

It is the free cloud option: fast replies (about a second to the first words), light on the PC because nothing runs there, and a free key from Google AI Studio. It replaces only the text a companion says. The voices, subtitles, face, emotions, Phone Chat and memory are the same code as for every other text provider.

## What the player does

1. Make a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). A Google account is enough, no card. Keys start with `AQ.` (the newer ones, 53 characters) or `AIza`.
2. Copy it, open **Settings > Conversation provider** and press **Add** on the **Google Gemini API key** row. The service reads the key from the clipboard, checks its shape and saves it. The button then reads **Remove**, which deletes the key.
3. Choose **Google Gemini (free plan)** as the provider. The switch waits until no conversation is running, so a conversation never mixes two providers.

**Add** also tries the key once, right away, with one tiny request in the background (the same request the Custom page's Test connection sends). The key row says the result in plain words, in the first line of its help: Google accepted the key, Google did not accept it (and to check it in Google AI Studio, then Remove it and Add the right one), the free allowance is used up for now, Gemini is not available in your region, or Google could not be reached to check it. There is no Test connection row on this page.

With Google Gemini chosen but no key saved, conversations use Convai and one notice says so (`gemini-no-key`). Nothing is sent to Google until the provider is chosen or a key is added.

## Design

It is the Custom provider's client on a second endpoint, not a new client.

| Item | Value |
|---|---|
| Client | `bridge/mistral-client.mjs` with `provider: 'custom'`: OpenAI-style chat completions, server-sent-event streaming, vision as `image_url` parts, Retry-After and daily-limit handling, the refused-field retry |
| Endpoint | fixed: `https://generativelanguage.googleapis.com/v1beta/openai` |
| Model | fixed: `gemini-flash-lite-latest` (an alias, so it follows Google's current Flash-Lite model. Fixed model ids go away: `gemini-2.5-flash-lite` already answers 404) |
| Saved key file | `player-gemini-endpoint.txt` in the conversation service's state folder, written like the Custom provider's `player-custom-endpoint.txt`. It holds the fixed endpoint, the fixed model ID and the key. The Custom provider keeps its own file and stays free for any other endpoint at the same time |
| Key binding | the key is bound to Google's address (`CustomEndpoint`): it goes nowhere else, and a key saved for another address is forgotten. Only the last four characters are ever shown |
| Module | `bridge/gemini-provider.mjs`: `openGeminiEndpoint`, `activeEndpoint` (a view that follows `provider.applied`, so the switch happens at the provider's idle boundary), `migrateEarlierSetups` |
| Route name | `gemini` (`customRoute` in `bridge/text-provider-host.mjs`). `MATURE_PROVIDERS` in `bridge/mature-content.mjs` has no entry for it, so **Mature content never goes to Gemini** (or to any cloud provider, as with Mistral before). Choosing it turns Mature content off, like Convai |
| Prompt | the generic profile a Custom endpoint gets, chosen from the endpoint and the model ID (`bridge/prompt-profiles.mjs`). The character editor's Prompting tab works with it, as with Custom |
| Vision | with Companion vision on, vision goes along with the turn as an `image_url` part |
| Characters | it writes for the characters players make and for add-on speakers, like the Custom provider (`ADDON_ROUTES` in `bridge/addons.mjs` lists `gemini`) |
| Voice and microphone | the same rules as the Custom provider: a cloud voice loads no local model, the Convai cloud voice is replaced by a local voice with one notice (`gemini-voice`), and the microphone is recognised on this computer (English, other languages with a Microphone pack). The Voxtral voice needs a Mistral key (the Mistral preset on the Custom page), never the Gemini key |

### Status files

The same protocol as [CUSTOM_PROVIDER.md](CUSTOM_PROVIDER.md), on its own pair of files in `runtime/`:

| File | Writer | Content |
|---|---|---|
| `runtime/gemini-provider-command.json` | the game (`mod/custom-provider.lua`, the second instance, `kind = 'gemini'`) | one command with a session-scoped id: `preset-gemini` (Add: read the key from the clipboard, save the fixed endpoint, model and key, then check the key once), `clear-preset-gemini` (Remove: delete the key and both fixed fields). A `test` command is refused by both sides |
| `runtime/gemini-provider-state.json` | the bridge | whether the key is saved and its last four characters, whether the provider is ready, the answer to the latest command (only the answer to the latest command id is ever shown), and `check`: `{id, state: 'checking' | 'ok' | 'failed', code?, status?}` for the key just added (a code and an HTTP status only, never Google's words or the key) |

The page has one row: the key (Add or Remove).

### Failures

- A **400 with `API_KEY_INVALID`** ("API key not valid"), and "API key expired" or "Missing API key" on a 400, is read as **key not accepted** (`code: 'key'`). Google answers a wrong key with 400, not 401, so this is read in `bridge/mistral-client.mjs` and is not shown as a refused request.
- A **429** is Google's free allowance, never credit, whatever "You exceeded your current quota" suggests (the Custom provider reads that sentence from other servers as "out of credits", so Google's shape is read first). Its answer is a list of one object with `status: RESOURCE_EXHAUSTED`, a `QuotaFailure` detail whose `quotaId` names the quota and a `RetryInfo` detail with `retryDelay` ("21s"):
  - a quota with `PerDay` in its id (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`) is the **daily allowance** (`daily`, not retried). Google resets it at midnight on the US Pacific clock (ai.google.dev/gemini-api/docs/rate-limits), so the notice says when, on this computer's clock (`errorResetTime`);
  - any other quota (per minute, tokens per minute, or one that names none) is the **per-minute limit** (`limit`). The wait Google names is used as Retry-After when the response has no such header: up to 8 seconds is waited out once, a longer one ends the turn at once with the notice.
- A **400 `FAILED_PRECONDITION`** that says the location is not supported ("User location is not supported for the API use", "free tier is not available in your country") is **region** (`region`, not retried).
- A **5xx** (500 `INTERNAL`, 503 `UNAVAILABLE` overloaded, 504 `DEADLINE_EXCEEDED`), a stalled stream or an answer that cannot be read is **server** (busy or an error on Google's side). No connection at all (no network, DNS, TLS) is **unreachable**.
- A 404 `NOT_FOUND` for the model is **model** (the fixed model was retired or renamed).
- The Gemini route marks these errors in `customRoute` (`tagGemini`, `bridge/mistral-client.mjs`): the message gets a second marker `[gemini:<code>]`, and the game's notice code is `gemini-<code>`. The kind and the first marker are unchanged, so every other reader (the provider's limit, the phone log, the connection test) works as before. The Custom provider keeps its own wording for the same answers.
- The settings page says the same in its note on the provider row, while Google Gemini answers: "rate limited for a minute", "free allowance used up for today", "key not accepted", "not available in your region", "model unavailable".
- Each notice says the next step: check the key in Google AI Studio, wait a minute, or use Convai or Local AI. The texts and when each is shown are in [NOTIFICATIONS.md](NOTIFICATIONS.md) (`gemini-key`, `gemini-daily`, `gemini-limit`, `gemini-region`, `gemini-server`, `gemini-unreachable`, `gemini-model`). Convai is still not used as a fallback after a failed turn; it only answers when Google Gemini has no key.
- The reply budget is small and the model ID does not look like a reasoning model, so no reasoning field is sent (Gemini refuses `reasoning_effort: "none"` for this model with a 400).

### Limits

The free plan has a daily and a per-minute cap per key. Measured with the owner's key: 15 requests a minute. Google does not publish the exact daily number, but its 429 names it: on 30 Oct 2026 a used-up key answered `limit: 500` with quotaId `GenerateRequestsPerDayPerProjectPerModel-FreeTier` for `gemini-flash-lite-latest` (the same for `gemini-3.5-flash-lite`). So the player documents say about 500 replies a day, up to 15 a minute, and that Google sets the exact number. The allowance is per model: `gemini-3.5-flash` still answered on the same key. The plan is not offered in every country (Russia is not on Google's list), and Google may use free-plan chats to improve its products. Replies start in about 1 to 1.5 s, with an occasional slow one. Research and numbers: [FREE_CLOUD_OPTION_RESEARCH.md](FREE_CLOUD_OPTION_RESEARCH.md), "Update 2026-10-30".

## Moving earlier setups (`migrateEarlierSetups`)

Run once when the service starts. Each move is idempotent and never overwrites something the player set up.

- A **Google Gemini preset saved on the Custom page** by a test build of 2026-10-30 moves to the Gemini provider: its key becomes the Gemini provider's key, and the Custom page's address, model and key are cleared (`gemini-preset-to-provider`).
- A **saved Mistral key** (`player-mistral-key.txt`) with nothing in the Custom provider fills the **Mistral preset** of the Custom page (`mistral-key-to-preset`), so the preset row shows it and the Voxtral voice keeps its key.
- The **internal `mistral` provider remains** for players who chose it before. It is not touched: the Settings list shows it as "Mistral (your key)" in the third place only while it is the saved choice.

## Files

| File | Role |
|---|---|
| `bridge/gemini-provider.mjs` | the fixed endpoint, the key file, the active-endpoint view, the migration |
| `bridge/custom-endpoint.mjs` | `CustomEndpoint` and the `PRESETS` table (`gemini` and `mistral`), the commands `preset-gemini`, `clear-preset-gemini`, `preset-mistral`, `clear-preset-mistral` |
| `bridge/text-provider-host.mjs` | `customRoute`, named `gemini` for this provider |
| `bridge/mature-content.mjs` | `MATURE_PROVIDERS` has no `gemini` |
| `mod/custom-provider.lua` | the page logic for both the Custom page and the Gemini page (`kind`) |
