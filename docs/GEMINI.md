# Google Gemini as a conversation provider

Since 2026-10-30 companions can answer through Google's free Gemini plan. Mistral stopped giving free API keys to new accounts, so Google Gemini took the third place in **Settings > Conversation provider**, the spot Mistral had: Convai free tier, Convai API key, **Google Gemini (free plan)**, Local AI, Custom (OpenAI-compatible). Mistral became a preset on the Custom endpoint page ([MISTRAL.md](MISTRAL.md), [CUSTOM_PROVIDER.md](CUSTOM_PROVIDER.md), "Presets"). Convai free tier stays the default.

It is the free cloud option: fast replies (about a second to the first words), light on the PC because nothing runs there, and a free key from Google AI Studio. It replaces only the text a companion says. The voices, subtitles, face, emotions, Phone Chat and memory are the same code as for every other text provider.

## What the player does

1. Make a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). A Google account is enough, no card. Keys start with `AQ.` (the newer ones, 53 characters) or `AIza`.
2. Copy it, open **Settings > Conversation provider** and press **Add** on the **Google Gemini API key** row. The service reads the key from the clipboard, checks its shape and saves it. The button then reads **Remove**, which deletes the key.
3. Choose **Google Gemini (free plan)** as the provider. The switch waits until no conversation is running, so a conversation never mixes two providers.
4. Optional: press **Test connection** on the same page. It sends one tiny request and says OK or what Google answered, in plain words.

With Google Gemini chosen but no key saved, conversations use Convai and one notice says so (`gemini-no-key`). Nothing is sent to Google until the provider is chosen or Test connection is pressed.

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
| Pictures | companions can see: with Companions can see on, the picture goes along with the turn as an `image_url` part |
| Characters | it writes for the characters players make and for add-on speakers, like the Custom provider (`ADDON_ROUTES` in `bridge/addons.mjs` lists `gemini`) |
| Voice and microphone | the same rules as the Custom provider: a cloud voice loads no local model, the Convai cloud voice is replaced by a local voice with one notice (`gemini-voice`), and the microphone is recognised on this computer (English, other languages with a Microphone pack). The Voxtral voice needs a Mistral key (the Mistral preset on the Custom page), never the Gemini key |

### Status files

The same protocol as [CUSTOM_PROVIDER.md](CUSTOM_PROVIDER.md), on its own pair of files in `runtime/`:

| File | Writer | Content |
|---|---|---|
| `runtime/gemini-provider-command.json` | the game (`mod/custom-provider.lua`, the second instance, `kind = 'gemini'`) | one command with a session-scoped id: `preset-gemini` (Add: read the key from the clipboard, save the fixed endpoint, model and key), `clear-preset-gemini` (Remove: delete the key and both fixed fields), `test` |
| `runtime/gemini-provider-state.json` | the bridge | whether the key is saved and its last four characters, whether the provider is ready, the answer to the latest command (only the answer to the latest command id is ever shown) |

The page has two rows: the key (Add or Remove) and Test connection.

### Failures

- A **400 with `API_KEY_INVALID`** ("API key not valid"), and "API key expired" or "Missing API key" on a 400, is read as **key not accepted** (`code: 'key'`). Google answers a wrong key with 400, not 401, so this is read in `bridge/mistral-client.mjs` and is not shown as a refused request.
- A **429** names the quota ("limit: 15 ... Please retry in 21 s", measured with 30 parallel requests). The client waits it out or reports "Google Gemini: limit reached for now".
- An unknown model is "Google Gemini: model unavailable".
- Test connection with no key saved makes no request and says to paste the key first.
- The reply budget is small and the model ID does not look like a reasoning model, so no reasoning field is sent (Gemini refuses `reasoning_effort: "none"` for this model with a 400).

### Limits

The free plan has a daily and a per-minute cap per key. Measured with the owner's key: 15 requests a minute. Google does not publish the exact daily number (trackers say 500 to 1,500 for Flash-Lite), so the player documents say about 1,000 replies a day, up to 15 a minute, and that Google sets the exact number. The plan is not offered in every country (Russia is not on Google's list), and Google may use free-plan chats to improve its products. Replies start in about 1 to 1.5 s, with an occasional slow one. Research and numbers: [FREE_CLOUD_OPTION_RESEARCH.md](FREE_CLOUD_OPTION_RESEARCH.md), "Update 2026-10-30".

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
