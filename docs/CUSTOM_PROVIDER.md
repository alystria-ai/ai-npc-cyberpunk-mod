# Custom (OpenAI-compatible) provider

Companions can answer through any endpoint that speaks the OpenAI chat-completions protocol: OpenRouter, Nano-GPT, or a server on your own computer such as Ollama or LM Studio. In **Settings > Conversation provider** it is the fifth entry, **Custom (OpenAI-compatible)**. Convai free tier stays the default. Like Mistral and Local AI it replaces only the text a companion says; the voices, subtitles, face, emotions, Phone Chat and memory are the same code (see [MISTRAL.md](MISTRAL.md) for the shared route).

You give it three things: the endpoint's base address, an API key (optional: a server on your own computer wants none) and a model ID. Nothing is sent anywhere until you choose this provider, or press **Test connection**.

## What the player does

1. Open **Settings > Conversation provider**. Under the Mistral key row are four rows for this provider.
2. Copy the endpoint's base URL from your provider, then press **Paste endpoint URL**. Copy the API key, then **Paste API key**. Copy a model ID, then **Paste model ID**. Each press reads the clipboard once, checks its shape and saves it on this computer. A paste that cannot be used says why at the top of the row's help. Once a row holds a value its button reads **Remove**.
3. Press **Test connection**. It sends one tiny request and reads **OK**, or the provider's own error in plain words.
4. Choose **Custom (OpenAI-compatible)** as the provider and **Apply**. The switch waits until no conversation is running.

The order of the pastes does not matter. With the address or the model ID missing, conversations use Convai and one notice says so.

### OpenRouter

1. Make an account at openrouter.ai and create an API key (Keys page).
2. Endpoint URL: `https://openrouter.ai/api/v1`
3. API key: the key you created.
4. Model ID: copy one from openrouter.ai/models, in the form `vendor/model-name`, for example `meta-llama/llama-3.1-8b-instruct`. Some models are free to use and end in `:free`; they have tighter limits.

### Nano-GPT

1. Make an account at nano-gpt.com and create an API key.
2. Endpoint URL: `https://nano-gpt.com/api/v1`
3. API key: the key you created.
4. Model ID: copy one from Nano-GPT's model list, exactly as it is written there.

### A server on your own computer

Start the server before the game and load a model in it.

| Server | Endpoint URL | Model ID | API key |
|---|---|---|---|
| Ollama | `http://localhost:11434/v1` | the name you pulled, for example `llama3.2` | none |
| LM Studio (Developer tab, Start Server) | `http://localhost:1234/v1` | the model's identifier shown in LM Studio | none |
| Another OpenAI-compatible server | its address, ending in `/v1` | what it lists | only if it asks |

`http://` is accepted only for this computer (`localhost`, `127.0.0.1`) and your home network (`192.168.x.x`, `10.x.x.x`, a `.local` name). Any other host must use `https://`, so your key and chats are never sent in the clear. An address with a user name, a `?query` or a `#fragment` is refused, because a key must not travel in an address. A pasted `.../chat/completions` is cut back to the base, and an address with no path gets `/v1`.

### Saving by hand

All three values live in one small file in the conversation service's data folder, `%LOCALAPPDATA%\AiNpcCyberpunkMod\data\player-custom-endpoint.txt`:

```
# lines in any order; the key line is optional
endpoint=https://openrouter.ai/api/v1
model=meta-llama/llama-3.1-8b-instruct
api-key=<your key>
```

`#` starts a comment. A line that cannot be used is ignored and only its name (never its value) is written to the log. The file is read when the service starts, when you choose this provider and when you press **Test connection**. The paste buttons write the same file (through a temporary file), so the two ways mix freely. Only your Windows account can open it: it is in your data folder under %LOCALAPPDATA%, whose permissions protect it (a file mode such as 0600 does nothing on Windows).

## What the settings page shows

The row names carry the status in brackets: the endpoint's host (`openrouter.ai`, `localhost:11434`, never a path), the last four characters of a key of 16 or more characters ("Added" for a shorter one), the model ID, and while a test runs "Testing...". The key itself is never shown, logged, put in a status file or a support report.

## Requests

- **Streaming.** The reply is streamed (server-sent events) like Mistral's, and the stream stops at the sentence cap. A server that answers with one plain JSON body instead is accepted: the whole reply arrives as one piece.
- **Fields a server refuses.** The request carries `model`, `messages`, `stream`, `max_tokens` and `temperature` (and `response_format` for the background fact extraction). When a server answers 400 or 422 saying a field is unsupported (OpenAI's newer models refuse `temperature`, and want `max_completion_tokens` for `max_tokens`; some refuse `stream_options`, `response_format` or `stream`), the same request is sent once more without it, or with the new name, at once, and the choice is remembered for the session for that address and model. No `prompt_cache_key` and no end-user ID is sent.
- **Headers.** `Authorization: Bearer <key>` (none when there is no key), `Content-Type`, `Accept`. For `openrouter.ai` alone, the two optional attribution headers `HTTP-Referer` (the mod's Hugging Face page) and `X-Title` (`AI NPC Cyberpunk Mod`) are added. The key goes only to the saved endpoint's origin; a redirect to another address is an error, not something to follow.
- **Waits.** A cloud endpoint gets 20 s to start answering (25 s on the one retry) and 15 s of silence before a stream is cut; a server on this computer or home network gets 90 s, because its first reply may be loading the model. A slow answer is an error with a notice, never an in-character "hang on" line, so a wrong address is not hidden.
- **Connection.** An https endpoint's connection is opened when the provider is applied and kept for 60 seconds, so the first reply does not pay the handshake. The warm-up is a `HEAD` of the origin root with no key. A server on this computer needs none.
- **One request at a time** for a server on this computer or home network: the companion-action decision does not run beside the reply.

### Errors the player sees

| The endpoint answers | Notice | What the player should do |
|---|---|---|
| 401, 403 | The custom provider did not accept your key | Paste the key again |
| 402, or 429 saying the quota or credit is used up | The account is out of credits | Add credits at the provider |
| 404, or 400/422 about the model | The provider does not know that model ID | Paste a model ID from its list |
| 429 | The provider is rate limiting you | A `Retry-After` of up to 8 seconds is waited out and the request sent again once. A longer one is not waited for: the turn fails at once with the notice, and no request goes out before the time the server named has passed (the next turns get the notice without waiting) |
| 5xx, no answer in time, nothing listening, a stream cut off, a redirect | The provider did not answer | Check the address, or try again |
| anything else (a refused prompt, an empty answer) | the usual "no answer" | |

An automatic battle or loot comment that fails just stops; only a turn you asked for shows a notice. **Test connection** shows the same classes with the provider's own words (at most 160 characters, the key removed).

## Voice, microphone, memory

The same rules as Mistral. A cloud voice loads no local model: Voxtral needs a Mistral key (the custom key is never given to it), and the Convai cloud voice is replaced by Pocket with one notice (`custom-voice`). The microphone is recognised on this computer, in English. Memory and summaries stay on this computer; the summary and fact requests go to the same endpoint (and are not sent while the key was refused or the account has no credit). Add-on speakers still answer only through Mistral or Local AI. Convai's cloud voice, vision of the surroundings and long-term memory are Convai-only.

**Mature content stays with Local AI.** Choosing this provider turns Mature content off, and the setting never reaches this route: the crude persona layer and the hard-limit guard are the local route's (`#matureLevel` and `#guardOn` in `bridge/text-provider-host.mjs` answer only for `local`).

## Setup check and support report

**Settings > Help > Setup check** looks up the chosen endpoint's host (and port) and connects to it, only while this provider is the chosen one, and the light first check at start makes no connection at all. A server on this computer that is not running reads as "cannot reach localhost:11434": start it. The support report names the provider, the endpoint's host (no path, no query) and the model ID, and the result code of the last test; never the key, not even its last four characters.

## Files

| Item | Where |
|---|---|
| Provider setting | `conversationProvider` = `custom` in `settings.json` |
| Address, model, key | `<state folder>/player-custom-endpoint.txt` |
| Commands | `runtime/custom-provider-command.json`: `{version: 1, id: '<session>:cust:<n>', action, issuedAt}` with action `paste-url`, `paste-key`, `paste-model`, `clear-url`, `clear-key`, `clear-model` or `test` (the game writes, the bridge reads) |
| Status | `runtime/custom-provider-state.json`: `{ready, host, secure, local, model, keySaved, tail, result: {id, field, state, reason}, test: {id, state, code, status, waitS, detail, ms}, limit}` |
| Provider and the applied route | `runtime/mistral-state.json` (`provider` and `effective` may be `custom`) |

## Design

| Module | Job |
|---|---|
| `bridge/custom-endpoint.mjs` | Parsing and checking of the three values, the file, the commands, the status, and the connection test. |
| `bridge/mistral-client.mjs` | The one chat client; `provider: 'custom'` adds the optional key, the refused-field retry (`adapt`), the plain-JSON reply, 402, Retry-After and the OpenRouter headers. Mistral and local requests are built as before. |
| `bridge/text-provider-host.mjs` | `customRoute`: one model, no pacing, the Retry-After gate, per-session refusals. The host, prompt, memory, streaming and reply checks are shared with Mistral. |
| `bridge/mistral-key.mjs` | `MistralProvider` knows the `custom` preference and when it is ready; notices `custom-no-setup` and `custom-voice`. |
| `mod/custom-provider.lua` | The game side: the state file, the commands, the row texts. `mod/mcm.lua` only draws them. |

## Testing

`bridge/custom-endpoint.test.mjs` (what may be entered, the file, the commands, the connection test), `bridge/custom-provider.test.mjs` (the client and a whole turn against a mock) and `bridge/custom-provider-bridge.test.mjs` (a real bridge process whose guard refuses every outward request, the setup check, the support report) run against `bridge/openai-mock-server.mjs`, a loopback OpenAI-compatible server: streaming, the plain-JSON fallback, the refused-field retry, each error code, Retry-After, key redaction. There is no real network in any test. In game: paste the three values, press **Test connection**, choose the provider, **Apply**, and talk. Try a wrong model ID and a wrong key to see the notices.
