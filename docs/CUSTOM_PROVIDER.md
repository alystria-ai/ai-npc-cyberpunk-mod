# Custom (OpenAI-compatible) provider

Companions can answer through any endpoint that speaks the OpenAI chat-completions protocol: OpenRouter, Nano-GPT, or a server on your own computer such as Ollama or LM Studio. In **Settings > Conversation provider** it is the fifth entry, **Custom (OpenAI-compatible)**. Convai free tier stays the default. Like Mistral and Local AI it replaces only the text a companion says; the voices, subtitles, face, emotions, Phone Chat and memory are the same code (see [MISTRAL.md](MISTRAL.md) for the shared route).

You give it three things: the endpoint's base address, an API key (optional: a server on your own computer wants none) and a model ID. Nothing is sent anywhere until you choose this provider, or press **Test connection**.

## What the player does

1. Open **Settings > Conversation provider**. Under the Mistral key row are four rows for this provider.
2. Copy the endpoint's base URL from your provider, then press **Paste endpoint URL**. Copy the API key, then **Paste API key**. Copy a model ID, then **Paste model ID**. Each press reads the clipboard once, checks its shape and saves it on this computer. A paste that cannot be used says why at the top of the row's help; an API key pressed into the model row is refused, so it is never shown as the model ID. Once a row holds a value its button reads **Remove**.
3. Press **Test connection**. It sends one tiny request and reads **OK**, or the provider's own error in plain words.
4. Choose **Custom (OpenAI-compatible)** as the provider and **Apply**. The switch waits until no conversation is running.

The order of the pastes does not matter. With the address or the model ID missing, conversations use Convai and one notice says so.

**The key stays with the address it was saved for.** Pasting a new address on another host or port (or `http://` against `https://`) forgets the saved key, in memory and in the file, so it is never sent to a host you did not give it to. When the new address is a remote one, the key row says "New address saved. Paste your API key again for it." until a key is saved. A new path on the same host (`/v1` instead of `/api/v1`, or none) keeps the key, and a server on this computer or your home network needs no key, so nothing is asked there. Removing the address and pasting another one does not get round this: the key is bound to its address, not to what happens to be saved beside it.

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
key-origin=https://openrouter.ai
```

The `key-origin=` line is written by Settings: it records the scheme and host of the address the key was saved for. If you change `endpoint=` to another host and leave the `api-key=` line as it is, the key is forgotten at the next read or start and the file is written without it; a new key written in the same edit as the new address is kept (it is your word for that address). A file you wrote yourself has no such line: its key is taken to belong to the address beside it, and is forgotten if that address changes while the service runs, so change both lines together.

`#` starts a comment, on a line of its own or after a space at the end of a line. A line that cannot be used is ignored and only its name (never its value) is written to the log. A file that exists but cannot be read for a moment (another program has it open) changes nothing, and a paste is refused until it can be read, so nothing in it is lost. The file is read when the service starts, when you choose this provider and when you press **Test connection**. The paste buttons write the same file (through a temporary file), so the two ways mix freely. Only your Windows account can open it: it is in your data folder under %LOCALAPPDATA%, whose permissions protect it (a file mode such as 0600 does nothing on Windows).

## What the settings page shows

The row names carry the status in brackets: the endpoint's host (`openrouter.ai`, `localhost:11434`, never a path), the last four characters of a key of 16 or more characters ("Added" for a shorter one), the model ID, and while a test runs "Testing...". The key itself is never shown, logged, put in a status file or a support report. The provider row's last paragraph says "Custom: free daily limit reached" while a daily limit is on (besides "rate limited for now", "key not accepted", "model unavailable" and "out of credits"), and the key row says to paste the key again after an address on another host was saved (see above).

## Requests

- **Streaming.** The reply is streamed (server-sent events) like Mistral's, and the stream stops at the sentence cap. A server that answers with one plain JSON body instead is accepted: the whole reply arrives as one piece.
- **Fields a server refuses.** The request carries `model`, `messages`, `stream`, `max_tokens` and `temperature` (and `response_format` for the background fact extraction). When a server answers 400 or 422 saying a field is unsupported (OpenAI's newer models refuse `temperature`, and want `max_completion_tokens` for `max_tokens`; some refuse `stream_options`, `response_format` or `stream`), the same request is sent once more without it, or with the new name, at once, and the choice is remembered for the session for that address and model. A server that refuses one field per answer (max_tokens, then temperature) is asked again after each refusal that changes the request, at most four times; a refusal that changes nothing is an error at once. Renaming `max_tokens` drops nothing else. LM Studio's "`response_format.type` must be `json_schema`" drops `response_format` from the fact extraction. A refusal that is about the fields that ask a model to think less (see "Models that think first") moves that request to the next step of them and drops nothing else. No `prompt_cache_key` and no end-user ID is sent.
- **Headers.** `Authorization: Bearer <key>` (none when there is no key), `Content-Type`, `Accept`. For `openrouter.ai` alone, the two optional attribution headers `HTTP-Referer` (the mod's Hugging Face page) and `X-Title` (`AI NPC Cyberpunk Mod`) are added. The key goes only to the saved endpoint's origin; a redirect to another address is an error, not something to follow.
- **Waits.** A cloud endpoint gets 20 s to start answering (25 s on the one retry) and 15 s of silence before a stream is cut; a server on this computer or home network gets 90 s, because its first reply may be loading the model. A slow answer is an error with a notice, never an in-character "hang on" line, so a wrong address is not hidden.
- **Connection.** An https endpoint's connection is opened when the provider is applied and kept for 60 seconds, so the first reply does not pay the handshake. The warm-up is a `HEAD` of the origin root with no key. A server on this computer needs none.
- **One request at a time** for a server on this computer or home network: the companion-action decision does not run beside the reply.
- **Companion actions** (drive to the map marker, attack the tagged enemy, follow, leave) work on this provider like on Mistral and Local AI: a one-word decision request, a note in the reply prompt, and the same message to the game as Convai's (docs/MISTRAL.md, "Companion actions"). The game still has to offer the action (companion in V's party; V on foot beside their stopped car and a marker on the map for a ride; a tagged enemy for an attack). A plain request ("drive me") is honoured when a small model's decision fails.

### Models that think first

DeepSeek R1, Qwen3 in thinking mode, gpt-oss and the reasoning models of OpenRouter write their thoughts before the answer, and the thoughts count against the same `max_tokens` as the answer. A reply budget is small, so such a model can spend all of it on thinking and return an empty reply. Four things keep that from ending a talk. They are for this provider only: a Mistral or Local AI request is built and read exactly as before.

**1. Ask for no thinking, or little**, where the provider documents a field for it. The first step is sent; a server that refuses it moves the request to the next step, and after the last step nothing is sent.

| Endpoint | Sent first | If the server refuses it |
|---|---|---|
| `openrouter.ai`, every model | `"reasoning": {"effort": "none"}` | `{"effort": "low"}` (a model that must reason refuses "none": "Reasoning is mandatory for this endpoint and cannot be disabled."), then nothing |
| `api.deepseek.com` | `"thinking": {"type": "disabled"}` | `"reasoning_effort": "low"`, then nothing |
| A server on this computer or home network (Ollama, LM Studio, llama.cpp), when the model ID looks like a reasoning model | `"reasoning_effort": "none"` | `"low"`, then nothing |
| Any other host, when the model ID looks like a reasoning model | `"reasoning_effort": "low"` | nothing |
| Any other model | nothing: an ordinary model is sent exactly what it was before | |

OpenRouter is sent the field for every model because its providers ignore a parameter they do not know by default. Elsewhere an id has to look like a reasoning model (`o1`, `o3`, `o4`, `gpt-5`, `gpt-oss`, `r1`, `deepseek-reasoner`, `qwen3`, `qwq`, `magistral`, `glm-4.5` and later, `kimi-k2`, `grok-3-mini`, `gemini-2.5`, `claude-3.7` and later, `nemotron`, or "reason" or "think" in the name: the list is in `bridge/reasoning.mjs`), so an ordinary model is never sent a field it might refuse. `exclude` is not used: the model would still think, and the thoughts would still use the budget. The refusal is recognised from the field's name (`reasoning`, `reasoning_effort`, `thinking`) or from words such as "mandatory" and "does not support thinking", never from a model ID that merely contains "thinking". The step is remembered for the session for that address and model.

**2. Never say the thoughts.** A `reasoning`, `reasoning_content` or `reasoning_details` field of a message or of a streamed piece, a content part of type `thinking` or `reasoning`, and `<think>…</think>` text (also `<thinking>`, `<thought>` and `<reasoning>`) are not part of the reply, in a stream or in one plain JSON body. A tag cut between two pieces (`<thi` and `nk>`) is held back until it is known to be a tag, so no half tag is ever shown or spoken, and everything between an opening and its closing tag is dropped however many pieces it takes. A block that never closes was all thinking. A `</think>` with no opening tag (a server whose template opened the block): what comes before it was thinking.

**3. Empty because the budget went to thinking: ask again, once, with more room.** A reply with no text that was cut at its limit (`finish_reason: "length"`), or that thought and then ended without a word, is sent again once with five times the budget (at least 1500 tokens, at most 4096). For the original Qwen3 models (not Qwen3.5, not the 2507 releases) the second request also puts Qwen's documented `/no_think` switch at the end of the last message. What worked is remembered for the session for that address and model, so later replies start with it and no turn pays for the empty first try again. An empty reply that is not this (the model stopped on its own) is retried as before, with the same budget.

**3b. A model whose id gave no hint.** The first request carries no reasoning field, so a model of an unlisted name thinks through its budget. The retry of step 3 then also carries the fields that ask for no thinking at all (`reasoning_effort`, `chat_template_kwargs: {enable_thinking: false}`, and on a server on this computer or the home network `think: false`; `noThinkingFields` in `bridge/reasoning.mjs`; OpenRouter and DeepSeek are asked on every request already), and the endpoint is remembered for the session as one that thinks: later requests carry them from the start. A server that refuses one by name loses just that field.

**4. Still empty: say so.** An empty reply again, after more room, ends the turn with the notice `custom-reasoning`: "This model spends its reply on thinking. Choose a non-reasoning model in Settings." **Test connection** says the same.

Sources (read 19 Oct 2026): OpenRouter, [reasoning tokens](https://openrouter.ai/docs/use-cases/reasoning-tokens) (`reasoning: {effort}`, "none" disables it, `mandatory` models reject it, `exclude` still reasons and bills, reasoning shares `max_tokens` and can leave `content` empty) and [provider selection](https://openrouter.ai/docs/guides/routing/provider-selection) (unknown parameters are ignored); the refusal text is from [claude-code-router issue 1238](https://github.com/musistudio/claude-code-router/issues/1238). OpenAI, [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) (`reasoning_effort`, values depend on the model, reasoning tokens use the output budget before any visible text). Ollama, [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) (`reasoning_effort`, "none" requests no thinking). DeepSeek, [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode) (`thinking: {type: "enabled" | "disabled"}`, the thoughts in `reasoning_content`). Qwen, [Qwen3 blog](https://qwenlm.github.io/blog/qwen3/) (the `/think` and `/no_think` soft switch).

### Free models and their daily limit

OpenRouter's free models (ids ending in `:free`) allow 20 requests a minute and 50 requests a day (1,000 a day once 10 credits have been bought; [limits](https://openrouter.ai/docs/api-reference/limits)). The daily cap answers 429 with the message "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", and `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` both in the response headers and in `error.metadata.headers` (the reset has been seen as milliseconds since 1970, at midnight UTC; the documentation names no unit). The mod finds a daily limit from the words of the answer (`free-models-per-day`, "per day", "daily", TPD, RPD), or from the headers (nothing remaining and the reset more than 15 minutes away), and then:

- **does not retry and does not wait**: one request, then the notice `custom-daily`. When the server gave a reset time that is still to come within two days (`X-RateLimit-Reset` as milliseconds or seconds since 1970, as seconds from now or as an HTTP date; or a `Retry-After` of more than a minute) it reads "The free daily limit for this model was reached. It resets at 02:30." in your computer's clock; otherwise "The free daily limit for this model was reached. Try again after it resets." Phone Chat shows the second sentence.
- **tells the settings page** ("Custom: free daily limit reached") and sends no summary or fact request until a reply works again.
- **asks again on the next turn**, once: the day may have turned, or you may have added credits.

A per-minute limit (a few seconds' wait) and "temporarily rate-limited upstream" are not daily: they are waited out and retried as before. **Test connection** reports the daily limit and its reset the same way.

### Errors the player sees

| The endpoint answers | Notice | What the player should do |
|---|---|---|
| 401, 403 | The custom provider did not accept your key | Paste the key again |
| 402, or 429 saying the quota or credit is used up | The account is out of credits | Add credits at the provider |
| 404 or 400/422 about the model (OpenRouter's "No endpoints found" too) | The provider does not know that model ID | Paste a model ID from its list |
| 404 that names no model (a web page, "404 page not found") | The provider did not answer | Check the address: usually a path without `/v1`, or Ollama's `/api` instead of `/v1`. Not retried |
| 429 that is a daily allowance (`free-models-per-day`, "per day", or no requests left with the reset hours away) | The free daily limit for this model was reached, with the reset time when the server gave one | Wait for the reset, choose another model, or add credits. Not retried, not waited for |
| 429 | The provider is rate limiting you | A `Retry-After` of up to 8 seconds is waited out and the request sent again once. A longer one is not waited for: the turn fails at once with the notice, and no request goes out before the time the server named has passed (the next turns get the notice without waiting). The pause belongs to that address, model and key: a new key or model is asked at once |
| 5xx, no answer in time, nothing listening, a stream cut off, a redirect | The provider did not answer | Check the address, or try again |
| a reasoning model that answers nothing twice, the second time with more room | This model spends its reply on thinking | Choose a non-reasoning model (see "Models that think first") |
| anything else (a refused prompt, an empty answer) | the usual "no answer" | |

An automatic battle or loot comment that fails just stops; only a turn you asked for shows a notice. A new key, model ID or address ends the provider's "key not accepted", "out of credits" or "model unavailable" note at once (summaries run again too). **Test connection** shows the same classes with the provider's own words (at most 160 characters, the key removed).

## Voice, microphone, memory

The same rules as Mistral. A cloud voice loads no local model: Voxtral needs a Mistral key (the custom key is never given to it), and the Convai cloud voice is replaced by Pocket with one notice (`custom-voice`). The microphone is recognised on this computer: English by Moonshine, other languages by an installed multilingual pack (never sent to Mistral from this route; without a pack the recogniser stays English with one notice, docs/LOCAL_STT.md "Other languages"). Memory and summaries stay on this computer; the summary and fact requests go to the same endpoint (and are not sent while the key was refused or the account has no credit). Add-on speakers still answer only through Mistral or Local AI. Convai's cloud voice, vision of the surroundings and long-term memory are Convai-only.

**Mature content works with this provider** (owner decision 2026-10-20). Choosing it leaves Mature content as it was, and with the setting on the route gets the same Mature layer, word palette and closing line as the Local AI, every turn, through the shared text host (`#matureLevel` and `#guardOn` in `bridge/text-provider-host.mjs` answer for `custom` as for `local`), plus the hard-limit guard on the input and the reply. The level comes from the model ID like a local model's (`allowanceFor`: a Qwen or Gemma 4 model gets `full`, an unlisted one `suggestive`; the manifest hints of a model added by hand are Local AI's only). A server on this computer or the home network keeps the lines local; a cloud endpoint (OpenRouter and similar) receives them, and that model's own terms still apply. With Mature on and this provider chosen, V's Voxtral voice is allowed (the lines are sent to the endpoint anyway); with Local AI it is not. Details: [LOCAL_AI.md](LOCAL_AI.md), "Mature content on Mistral and Custom".

## Setup check and support report

**Settings > Help > Setup check** looks up the chosen endpoint's host (and port) and connects to it, only while this provider is the chosen one, and the light first check at start makes no connection at all. A server on this computer that is not running reads as "cannot reach localhost:11434": start it. The support report names the provider, the endpoint's host (no path, no query) and the model ID, and the result code of the last test; never the key, not even its last four characters.

## Files

| Item | Where |
|---|---|
| Provider setting | `conversationProvider` = `custom` in `settings.json` |
| Address, model, key | `<state folder>/player-custom-endpoint.txt` (`endpoint=`, `model=`, `api-key=`, and `key-origin=`, the address the key belongs to) |
| Commands | `runtime/custom-provider-command.json`: `{version: 1, id: '<session>:cust:<n>', action, issuedAt}` with action `paste-url`, `paste-key`, `paste-model`, `clear-url`, `clear-key`, `clear-model` or `test` (the game writes, the bridge reads) |
| Status | `runtime/custom-provider-state.json`: `{ready, host, secure, local, model, keySaved, tail, result: {id, field, state, reason}, test: {id, state, code, status, waitS, resetTime, detail, ms}, limit, keyForgotten}`: `limit` is `rate`, `daily`, `invalid`, `model` or `credits`; `keyForgotten` is present (true) only while a key was forgotten because the address moved and none is saved; `resetTime` is "HH:MM" on this computer's clock |
| Provider and the applied route | `runtime/mistral-state.json` (`provider` and `effective` may be `custom`) |

## Design

| Module | Job |
|---|---|
| `bridge/custom-endpoint.mjs` | Parsing and checking of the three values, the file, the commands, the status, and the connection test. |
| `bridge/mistral-client.mjs` | The one chat client; `provider: 'custom'` adds the optional key, the refused-field retry (`adapt`), the plain-JSON reply, 402, Retry-After, the daily limit and the OpenRouter headers. Mistral and local requests are built as before. |
| `bridge/reasoning.mjs` | Models that think first: the field that asks for less thinking and its steps, the filter that drops thoughts from a stream, the evidence that a reply went to thinking, the larger budget and `/no_think`. |
| `bridge/text-provider-host.mjs` | `customRoute`: one model, no pacing, the Retry-After gate, per-session refusals. The host, prompt, memory, streaming and reply checks are shared with Mistral. |
| `bridge/mistral-key.mjs` | `MistralProvider` knows the `custom` preference and when it is ready; notices `custom-no-setup` and `custom-voice`. |
| `mod/custom-provider.lua` | The game side: the state file, the commands, the row texts. `mod/manager-ui.lua` only draws them. |

## Testing

`bridge/custom-endpoint.test.mjs` (what may be entered, the file, the commands, the connection test), `bridge/custom-provider.test.mjs` (the client and a whole turn against a mock) and `bridge/custom-provider-bridge.test.mjs` (a real bridge process whose guard refuses every outward request, the setup check, the support report) and `bridge/custom-reasoning.test.mjs` (reasoning fields and think tags in streams cut at every point, the empty reply retried with more room, the refusal steps, the daily 429 from body and headers) run against `bridge/openai-mock-server.mjs`, a loopback OpenAI-compatible server: streaming, the plain-JSON fallback, the refused-field retry, each error code, Retry-After, key redaction. There is no real network in any test. In game: paste the three values, press **Test connection**, choose the provider, **Apply**, and talk. Try a wrong model ID and a wrong key to see the notices.
