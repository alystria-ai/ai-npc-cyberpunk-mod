# Custom (OpenAI-compatible) provider

Companions can answer through any endpoint that speaks the OpenAI chat-completions protocol: OpenRouter, Nano-GPT, or a server on your own computer such as Ollama or LM Studio. In **Settings > Conversation provider** it is the fifth entry, **Custom (OpenAI-compatible)**. Convai free tier stays the default. Like Google Gemini (see [GEMINI.md](GEMINI.md), which is this provider's client on a second, fixed endpoint), Mistral and Local AI it replaces only the text a companion says; the voices, subtitles, face, emotions, Phone Chat and memory are the same code (see [MISTRAL.md](MISTRAL.md) for the shared route).

You give it three things: the endpoint's base address, an API key (optional: a server on your own computer wants none) and a model ID. Nothing is sent anywhere until you choose this provider, or press **Test connection**.

## What the player does

1. Open **Settings > Conversation provider** and press **Open** on the **Custom endpoint** row (right after the Google Gemini key row). It opens a page of its own with the rows for this provider: the Mistral preset (see "Presets" below), endpoint URL, API key, model ID and Test connection. **Back to settings** returns to Settings.
2. Copy the endpoint's base URL from your provider, then press **Paste endpoint URL**. Copy the API key, then **Paste API key**. Copy a model ID, then **Paste model ID**. Each press reads the clipboard once, checks its shape and saves it on this computer. A paste that cannot be used says why at the top of the row's help; an API key pressed into the model row is refused, so it is never shown as the model ID. Once a row holds a value its button reads **Remove**.
3. Press **Test connection**. It sends one tiny request and reads **OK**, or the provider's own error in plain words.
4. Go back, choose **Custom (OpenAI-compatible)** as the provider and **Apply**. The switch waits until no conversation is running.

The order of the pastes does not matter. With the address or the model ID missing, conversations use Convai and one notice says so.

**The key stays with the address it was saved for.** Pasting a new address on another host or port (or `http://` against `https://`) forgets the saved key, in memory and in the file, so it is never sent to a host you did not give it to. When the new address is a remote one, the key row says "New address saved. Paste your API key again for it." until a key is saved. A new path on the same host (`/v1` instead of `/api/v1`, or none) keeps the key, and a server on this computer or your home network needs no key, so nothing is asked there. Removing the address and pasting another one does not get round this: the key is bound to its address, not to what happens to be saved beside it.

### Presets: Mistral (2026-10-30)

Mistral stopped activating API keys of new free accounts in October 2026. On 2026-10-30 it left the provider list and became the preset on this page, and the Google Gemini preset that this page had earlier the same day became the Google Gemini provider of its own ([GEMINI.md](GEMINI.md)). Copy the key first, then press **Add** on the **Mistral** row. It sends `preset-mistral`: the service reads the key from the clipboard and saves the address `https://api.mistral.ai/v1`, the model ID `ministral-8b-latest` (`PRESETS` in `bridge/custom-endpoint.mjs`) and the key in one go, bound to Mistral's host (a clipboard with no key saves nothing: the row says so). The button then reads **Remove**, which sends `clear-preset-mistral` and deletes the endpoint, the model ID and the key. The preset also keeps the Voxtral cloud voice's key (`player-mistral-key.txt`, `bridge/voxtral-voice.mjs`) in step: Add saves the key there too, Remove deletes it, so Voxtral loses its key. It is still the Custom provider: the same request code, the same key rule (a key stays only with its own host, so a key saved for another address is forgotten), the same notices. The preset does not choose the provider and does not touch Mature content or any voice setting. The status file carries `preset` (`mistral` or null) when the saved address and model ID are exactly a preset's, and then that row's button reads Remove. The `PRESETS` table also holds the `gemini` entry, but only the Google Gemini provider uses it: this page offers the Mistral row only.

Players who had Mistral before: a player who chose the Mistral provider keeps it (the internal `mistral` provider stays, see [MISTRAL.md](MISTRAL.md)), and a saved Mistral key fills the Mistral preset of this page when the service starts and the Custom provider is still empty (`migrateEarlierSetups` in `bridge/gemini-provider.mjs`). Groq's free plan was measured too, but it is not offered: its allowance of about one reply a minute and a few dozen a day is too small to talk on (owner, 30 Oct 2026).

**Test connection with no key (2026-10-30).** For a host on the internet (a preset, any https address) with no key saved, Test connection makes no request and answers `no-key`: "No API key is saved yet. Copy your key from your provider, press Paste API key, then test again." A server on this computer or the home network needs none and is still asked. Google answers a missing or wrong key with HTTP 400 (reason `API_KEY_INVALID`, "API key not valid"), not 401: `bridge/mistral-client.mjs` reads that, and "API key expired", "Missing API key" and the like on a 400, as a key problem (`code: 'key'`, "The endpoint did not accept your API key."), so it is not shown as a refused request. This is shared with the Google Gemini provider.

| Preset | Address | Model ID | Key from |
|---|---|---|---|
| Mistral | `https://api.mistral.ai/v1` | `ministral-8b-latest` | console.mistral.ai |

Mistral's allowance is Mistral's to change. Its free key used to give about 5,000 turns a day and about one message a second, but new accounts do not seem to get a free key any more, so a new key may need a paid plan.

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

## What the Custom endpoint page shows

The row names carry the status in brackets: the endpoint's host (`openrouter.ai`, `localhost:11434`, never a path), the last four characters of a key of 16 or more characters ("Added" for a shorter one), the model ID, and while a test runs "Testing...". The key itself is never shown, logged, put in a status file or a support report. The Conversation provider row's last paragraph says "Custom: free daily limit reached" while a daily limit is on (besides "rate limited for now", "key not accepted", "model unavailable" and "out of credits"), and the key row says to paste the key again after an address on another host was saved (see above).

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

**3a. A model that must reason** (OpenRouter's "Reasoning is mandatory for this endpoint and cannot be disabled.", seen in a turn or in **Test connection**; the Test button and the turns share one memory per address and model). Such a model thinks for 100 to 1500 tokens before its first word whatever effort it is asked for, so the route is remembered as one that must reason: no request sends "none" again, every request carries the field at its next step and a reply budget of 2500 tokens (the reply's own length cap still ends the stream as soon as the reply is long enough, so the room costs no time when the model answers normally), and the content streams as soon as it starts. If a reply still comes back with only thinking, the retry of step 3 uses the bigger budget and OpenRouter's least effort (`"minimal"`), not the same request again, and both are remembered for the next turns (a server that refuses `"minimal"` is not asked again). Only a route that said it must reason gets this; an ordinary model is sent exactly what it was.

**3b. A model whose id gave no hint.** The first request carries no reasoning field, so a model of an unlisted name thinks through its budget. The retry of step 3 then also carries the fields that ask for no thinking at all (`reasoning_effort`, `chat_template_kwargs: {enable_thinking: false}`, and on a server on this computer or the home network `think: false`; `noThinkingFields` in `bridge/reasoning.mjs`; OpenRouter and DeepSeek are asked on every request already), and the endpoint is remembered for the session as one that thinks: later requests carry them from the start. A server that refuses one by name loses just that field.

**4. Still empty: say so.** An empty reply again, after more room, ends the turn with the notice `custom-reasoning`: "This model spends its reply on thinking. Choose a non-reasoning model in Settings." **Test connection** says the same.

Sources (read 19 Oct 2026): OpenRouter, [reasoning tokens](https://openrouter.ai/docs/use-cases/reasoning-tokens) (`reasoning: {effort}`, "none" disables it, `mandatory` models reject it, `exclude` still reasons and bills, reasoning shares `max_tokens` and can leave `content` empty) and [provider selection](https://openrouter.ai/docs/guides/routing/provider-selection) (unknown parameters are ignored); the refusal text is from [claude-code-router issue 1238](https://github.com/musistudio/claude-code-router/issues/1238). OpenAI, [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) (`reasoning_effort`, values depend on the model, reasoning tokens use the output budget before any visible text). Ollama, [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) (`reasoning_effort`, "none" requests no thinking). DeepSeek, [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode) (`thinking: {type: "enabled" | "disabled"}`, the thoughts in `reasoning_content`). Qwen, [Qwen3 blog](https://qwenlm.github.io/blog/qwen3/) (the `/think` and `/no_think` soft switch).

### Free models and their daily limit

OpenRouter's free models (ids ending in `:free`) allow 20 requests a minute and 50 requests a day (1,000 a day once 10 credits have been bought; [limits](https://openrouter.ai/docs/api-reference/limits)). The daily cap answers 429 with the message "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", and `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` both in the response headers and in `error.metadata.headers` (the reset has been seen as milliseconds since 1970, at midnight UTC; the documentation names no unit). The mod finds a daily limit from the words of the answer (`free-models-per-day`, "per day", "daily", TPD, RPD), or from the headers (nothing remaining and the reset more than 15 minutes away), and then:

- **does not retry and does not wait**: one request, then the notice `custom-daily`. When the server gave a reset time that is still to come within two days (`X-RateLimit-Reset` as milliseconds or seconds since 1970, as seconds from now or as an HTTP date; or a `Retry-After` of more than a minute) it reads "The free daily limit for this model was reached. It resets at 02:30." in your computer's clock; otherwise "The free daily limit for this model was reached. Try again after it resets." Phone Chat shows the second sentence.
- **tells the settings page** ("Custom: free daily limit reached") and sends no summary or fact request until a reply works again.
- **asks again on the next turn**, once: the day may have turned, or you may have added credits.

A per-minute limit (a few seconds' wait) and "temporarily rate-limited upstream" are not daily: they are waited out and retried as before. **Test connection** reports the daily limit and its reset the same way.

### A prompt longer than the endpoint takes (2026-10-27)

A free plan can take less than one prompt: Groq's free tier took 8,000 tokens a minute and the prompt of a companion's turn was 8,626 (reports of 27 Oct). When an endpoint (or the Mistral route) refuses a prompt as too long and names the limit, the mod reads it (`contextRefusal`, `bridge/mistral-client.mjs`: Groq and OpenAI-style "Request too large ... Limit 8000, Requested 8626", "maximum context length is N tokens", llama.cpp "exceeds the available context size", Mistral's "too large for model with N maximum context length", "prompt is too long: N tokens > M maximum"), cuts the prompt to it with the fit the Local AI uses (`bridge/prompt-budget.mjs`: the lowest-priority knowledge first, then the retrieved memories, the older exchanges and the older-talk summary; never the persona and output rules, the world rules, the "right now" block or the player's words), and sends the request again **once**. The limit is remembered per provider, address and model for the session and in `prompt-limits.json` in the state folder for three days (`bridge/prompt-fit.mjs`), so later turns are built to fit from the start. Nothing changes on a normal turn: with no limit known the request goes out as it was. One log line per learned refusal: `[PromptFit] provider=custom model=openai/gpt-oss-120b limit=8000 sent=7400 trimmed=jobs:1,older-exchanges:4 retried=ok`. A persona that alone is longer than the limit fails with the plain "does not fit" error. A 429 (a rate limit with a wait) is not a size refusal and is waited out as before.

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

The same rules as Mistral. A cloud voice loads no local model: Voxtral needs a Mistral key (the Mistral preset saves it for the voice, and no other custom key is ever given to it), and the Convai cloud voice is replaced by Pocket with one notice (`custom-voice`), so Natural speech works here with the Convai voice selection (it is turned off only when Convai is the provider). The microphone is recognised on this computer: English by Moonshine, other languages by an installed multilingual pack (never sent to Mistral from this route; without a pack the recogniser stays English with one notice, docs/LOCAL_STT.md "Other languages"). Memory and summaries stay on this computer; the summary and fact requests go to the same endpoint (and are not sent while the key was refused or the account has no credit). Add-on speakers follow the Custom provider while it is the conversation provider and set up (docs/ADDON_API.md, "Text providers"). Convai's cloud voice, vision of the surroundings and long-term memory are Convai-only.

**Mature content works with this provider** (owner decision 2026-10-20). Choosing it leaves Mature content as it was, and with the setting on the route gets the same Mature layer, word palette and closing line as the Local AI, every turn, through the shared text host (`#matureLevel` and `#guardOn` in `bridge/text-provider-host.mjs` answer for `custom` as for `local`), plus the hard-limit guard on the input and the reply. The level comes from the model ID like a local model's (`allowanceFor`: a Qwen or Gemma 4 model gets `full`, an unlisted one `suggestive`; the manifest hints of a model added by hand are Local AI's only). A server on this computer or the home network keeps the lines local; a cloud endpoint (OpenRouter and similar) receives them, and that model's own terms still apply. No Voxtral voice is used beside Mature content, with this provider or with Local AI (since 2026-10-20): a companion voice or V on Voxtral moves to Pocket when the setting goes on and comes back when it goes off. Mature content works with Local AI and Custom only, never Mistral. Turning Mature on while Convai or Mistral is the provider selects Custom only when Local AI has no pack and this provider is set up (never Mistral, key or not); "Also changed" then names "Custom (OpenAI-compatible)", and with neither the switch stays off ("Needs Local AI or Custom."). Details: [LOCAL_AI.md](LOCAL_AI.md), "Mature content on Custom, never on Mistral".

## Setup check and support report

**Settings > Help > Setup check** looks up the chosen endpoint's host (and port) and connects to it, only while this provider is the chosen one, and the light first check at start makes no connection at all. A server on this computer that is not running reads as "cannot reach localhost:11434": start it. The support report names the provider, the endpoint's host (no path, no query) and the model ID, and the result code of the last test; never the key, not even its last four characters.

## Prompt profile of an endpoint (2026-10-22)

Every Custom endpoint and model has its own prompt profile (`bridge/prompt-profiles.mjs`, "Prompt profiles" in `docs/LOCAL_AI.md`): the output rules, the closing line, the example replies, where the turn's notes sit and the sampling.
Its id is `custom-<host and port>-<model id>` in lower case (`custom-openrouter-ai-qwen-qwen3-30b-a3b`, `custom-127-0-0-1-1234-gemma-3-4b-it`; a long one is cut and ends in a short hash).
It starts from the default of the model's **family**, read from the model id: `qwen`, `gemma` and `mistral` have the wording measured on a model of that family (Qwen3.5-4B, Gemma 4 E4B and ministral-8b, the first two behind a local server),
`llama` and any other model get the base wording, the safe default for a model nobody here has measured. Nothing is sent that the server may not know: the shipped Custom defaults add no `top_p`, `repeat_penalty` or `stop` (the player can add them in the
character editor; a server that refuses one by name loses it and is asked again, as with `temperature`). The facts the character gets, the hard-limit guard and the Mature layer (Custom may have it, Mistral never) are not part of the profile, so a player's change to
the rules cannot remove them. The player's own change is stored in `<state>/prompt-overrides/<profile id>.json`, one file per endpoint and model, so another model starts from its own default again and the first one's change is still there when the player comes back.

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
