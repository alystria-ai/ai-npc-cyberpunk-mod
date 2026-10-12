# Mistral as a conversation provider

For a player who has used up the shared Convai conversations (or who prefers it), companions can answer through
[Mistral](https://mistral.ai) (La Plateforme, `api.mistral.ai`) with the player's own free Mistral key. Convai free tier stays the default and
the recommended choice, with better quality responses. Mistral replaces only the text that companions say; everything after the
text is the same code. Local speech-to-text for the voice key is documented in `docs/LOCAL_STT.md`.

## What the player does

1. Get a free key from Mistral (the free plan, "Experiment", needs phone verification at signup).
2. Settings > Development > **Paste Mistral key** (copies it from the clipboard, checks it with Mistral, saves it on this computer).
   Or save the key by hand in `player-mistral-key.txt` in the conversation service's state folder (`api-key=<key>` or just the key).
   The page shows only the last four characters.
3. **Conversation provider** > Mistral (free plan), then Apply. The switch waits until no conversation is running, so a conversation
   never mixes two providers.

This is the free route the daily-limit notice points to (a fully local option is planned). A player's own Convai key (docs/OWN_CONVAI_KEY.md)
is no longer offered to players: the notice, the settings text and the player documents do not mention it.

## Settings and files

| Item | Where |
|---|---|
| Provider setting | `conversationProvider` in `settings.json` (`convai` default, `mistral`, `local` for the optional Local AI pack, `groq` for Groq's free plan; anything else reads as `convai`) |
| Key | `<state folder>/player-mistral-key.txt`, written with mode 0600 through a temporary file |
| Paste / Remove commands | `runtime/mistral-key-command.json` (the game writes, the bridge reads; ids `<session>:mkey:<n>`; the same protocol as the Convai key) |
| Groq key | Same as the Mistral key, handled the same way: `<state folder>/player-groq-key.txt`; commands in `runtime/groq-key-command.json` (ids `<session>:gkey:<n>`, `paste` or `clear`); the bridge adds a `groq` object to `runtime/mistral-state.json`: `{saved, tail, limit, result}` (`limit` is `rate`, `daily`, `invalid`, `model` or `null`; `result` is `{id, state}` with `state` one of `checking`, `saved`, `cleared`, `invalid`, `unreadable`, `failed`). When Groq cannot answer a turn and a Mistral key exists, the bridge answers that turn with Mistral; otherwise the reply carries `errorCode` `groq-key`, `groq-limit` or `groq-model`, and the first reply with Groq chosen and no key carries `keyNotice` `groq-no-key`. |
| Status for the settings page | `runtime/mistral-state.json`: `{version, updated, provider, effective, saved, tail, pending, result, limit, model, stt, localAi}` (`provider` and `effective` are `convai`, `mistral`, `groq` or `local`; `localAi` is `ready`, `warming`, `not-installed`, `no-memory` or `failed`, shown as the Local AI row) |
| Local memory | `<state folder>/mistral-memory.json` (bounded, see Memory) |

The key is never printed, logged, written to a status file or sent anywhere except `api.mistral.ai`. It is scrubbed from the support
report (`mistral.secrets()`), from error texts and from log lines (`redact` in `bridge/mistral-client.mjs`). The client refuses any
endpoint other than `https://api.mistral.ai` (loopback hosts are allowed for tests). The bridge sends no end-user id to Mistral and
keeps no state there.

If the provider is Mistral and there is no key, conversations use Convai and a one-time notice says so (the setting stays as the
player chose it; adding the key and applying switches over).

## Design

| Module | Job |
|---|---|
| `bridge/mistral-client.mjs` | Streaming chat completions (SSE), first-byte and total timeouts, retries with backoff on 429 and 5xx, error mapping, the key check (`GET /v1/models`). |
| `bridge/mistral-key.mjs` | The key file, the provider state (setting, requested/applied, one-time notices) and the Paste/Remove control. |
| `bridge/mistral-prompt.mjs` | The system prompt, the message list, reply cleaning and caps, the summary request. |
| `bridge/mistral-memory.mjs` | The old rolling history and summaries (kept as the base of the memory store, and migrated once). |
| `bridge/memory-store.mjs` | The memory the text providers share (Mistral, Groq, local): the same history and summaries plus lasting records with embeddings (docs/LOCAL_AI.md). |
| `bridge/text-provider-host.mjs` | One host for every text provider: `TextProviderHost.reply(config)` over a route per provider (`mistralRoute`, `groqRoute`, `localRoute`), and `attachTextProvider(host, ...)`, which makes the bridge's realtime hosts use it while a text provider is active. |
| `bridge/mistral-host.mjs` | `MistralHost` (the shared host with only the Mistral route) and `attachMistral`, kept under their old names. |

A turn reaches `MistralHost.reply` with the same configuration the Convai host gets (the bridge adds a `local` field with the
character's profile key, channel and, for an ordinary NPC, an ambient key). The result has the same shape as a Convai reply (`text`,
`sessionID`, `timing`, then `transformReply`: Natural speech tags and Expressive emotions are processed exactly as for Convai), so
subtitles, Phone Chat, Pocket/Omni voices, lip sync, the emotion selector and group rounds see no difference. The reply is streamed;
the stream stops at the sentence cap and the connection is dropped, so a long reply costs only what is read.

### Prompt

System message (from the character data given to Convai: `characters/roster.json` and `characters/archetype-roster.json`, i.e. the
same bio, appearance, speaking style and example lines the profile build uploads): who you are, how you talk, examples of your voice,
what you remember of V from earlier talks (the summary), then the output rules (first person, no stage directions or markdown or
emoji, one to three sentences, never an AI, no invented facts or shared history, language, tags only if the live context asks, do not
repeat the rules). Ordinary NPCs get no name and are told they are an ordinary person.

Then the recent history (last 8 exchanges, as alternating user/assistant messages), then one user message: the live context (exactly
the context string the bridge sends Convai each turn. It opens with a short "right now" block (`bridge/turn-context.mjs`, at most 450
characters, first so the 20000-character cap below can never cut it: the game clock as a part of the day and the nearest hour, the
district, who else is with V, whether V is in a vehicle, V's gender and lifepath; in-person turns only, not Phone Chat yet and not
automatic reactions). Then quest and world knowledge, relationship style, gear, game dialogue, battle and loot, Natural speech and
Expressive emotion tag instructions, follow-up hook, first-person reminder, language. An ordinary NPC (resident, vendor or other
archetype) is a stranger to V: it gets the time, the place, whether V is in a vehicle or has company, V's apparent gender and what
V visibly wears and holds, but none of V's journal, jobs, world facts or gear list. There is no weather, health or wanted-level
line yet),
`V says: <text>`, and a one-line reminder of the rules the models drift from most (`closing` in the prompt module). A battle or loot
reaction is marked `[EVENT, not spoken by V]` and is not remembered. Temperature is 0.65.

Caps (`LIMITS`): persona 16000 characters (examples are dropped first, then the end of the backstory), context 20000 (head and tail
kept, where the format notes are), summary 1400, 8 turns, V's message 1200, reply 6 sentences and 700 characters, 600 output tokens.

Reply cleaning: reasoning blocks, `Name:` labels, `*actions*`, short parentheticals, markdown, emoji, unknown `{}`/`[]` groups and
quotes are removed; real emotion and voice tags are kept for the post-processing. A reply that says it is an AI (or is reasoning, or
stops on a comma) gets one more try with a short reminder; reasoning twice is never spoken (it counts as an empty answer).

### Prompt order (layout v2)

When the bridge supplies the context in tiers (`contextParts`), the prompt is ordered from what never changes to what changes every turn, so
a prefix cache keeps working on Mistral, Groq and the local model:

1. system: the persona and the output rules (the persona prefix; the local AI loads it ahead on an invitation);
2. system: the format notes for tags (Expressive emotions), then the world and quest context (slow), then what the character
   remembers (the summary);
3. system: the "right now" block (the clock, the place, who is with V). It used to open the context; it is now the last thing in the
   system message because it changes every few minutes and one changed word early in a prompt invalidates the cache after it;
4. the recent exchanges, verbatim, as alternating messages;
5. the last user message: the volatile notes (language, Natural speech dice, follow-up hook), up to four remembered facts found for this
   message, then `V says: <text>`.

Convai keeps its own order (dynamic information as before). A bridge that does not supply `contextParts` gets the old layout.

### Models and limits

- Models, best first (`DEFAULT_MODELS`): `ministral-8b-latest`, `ministral-14b-latest`, `ministral-3b-latest`. The bridge uses the
  first one the account may use (8B first: it is the fastest of the two big ones, and its allowance is the largest). Measured on 11 Oct 2026 with a free-plan key: Small and Medium answered 429 with a request
  allowance of 0 (`x-ratelimit-limit-req-minute: 0`), Large answered 403 (not in the plan), while `ministral-14b-latest` (30
  requests a minute, about 940k tokens a minute), `ministral-8b-latest` (188 a minute) and `ministral-3b-latest` (750 a minute)
  worked. A 429 with an allowance of 0 is not retried: the model is skipped for ten minutes and the next one is used.
- Other 429s (the per-minute limit) are retried with backoff; the host also starts requests at least 1.1 s apart, and the summary of
  older talk is queued behind the reply that triggered it, so it never lands within a second of a chat request.
- Every request carries a stable `prompt_cache_key` (`cyberpunk-convai:<hash of the state folder>:<character>`: no key and no name of the player) so the long persona prefix is cached on Mistral's side. Measured: about 98% of the prompt cached and about 20% faster, and cached tokens do not count against the token budget. The cache only helps if the start of the prompt is the same every turn; see "Prompt order" below.
- Typical answer time with `ministral-14b-latest` was 1.3 to 1.8 s for a full reply.
- Every Mistral text request is paced in one place, `TextProviderHost.#request`, through the shared scheduler (`bridge/mistral-rate.mjs`, the same one the Voxtral voice uses, because a free key may allow about one request a second for the whole workspace): starts are not spaced (the live probe found no per-second limit), a reply (priority text) goes before speech and before background work (summaries, fact extraction) whenever requests have to wait, the per-minute rate-limit headers of every answer are passed to it and slow starts only when an allowance is nearly used up, and a 429 pauses every start for its retry-after and keeps starts about a second apart for a minute. Without a scheduler (tests) requests start at least `gapMs` apart. Groq and the local server are not paced.
- Third-party figures put the free plan at about one request a second and about a billion tokens a month per model; the headers
  above are what an account actually reports.

A summary costs one extra request per 8 exchanges that rolled out of the history.

### Errors

| Condition | Code to the game | Notice |
|---|---|---|
| Key refused (401, 403) | `mistral-key` | Mistral: key not accepted |
| Rate limit or no allowance (429) | `mistral-limit` | Mistral: free limit reached for now |
| Model not found or not allowed (404, 400/422 about the model) | `mistral-model` | Mistral: model unavailable |
| Network, timeout, server fault (5xx), empty answer | generic failure | the usual "no answer" behaviour |

The notices are in `mod/notices.lua` (see docs/NOTIFICATIONS.md). Failures of automatic battle and loot reactions are silent.

### Memory

Convai keeps history and long-term memory on its servers; with Mistral the bridge keeps a small, bounded version in
`mistral-memory.json`:

- the last 8 exchanges per character and channel (private, phone, group);
- a summary (at most 1400 characters) of older private and phone exchanges, written by the same model, shown to the character as what
  it remembers of V, never to a group conversation; group overflow is dropped;
- ordinary NPCs keep a short in-memory history for the conversation only;
- at most 120 characters are remembered; the file is capped at 1 MB and saved with a short delay off the speech path.

**Forget** (the Memory page, one character or all) clears this memory too (`quiescePlayerMemory` calls `mistralMemory.forget`). A
summary requested before a Forget is ignored when it arrives. Nothing is synchronised with Convai memory in either direction: a
conversation held on Mistral is not known to Convai, and the other way round.

### Voice

Replies are spoken by Pocket or Omni like any text. If the voice setting is the Convai cloud voice, Mistral replies use Pocket and a
one-time notice says so. Phone Chat works.

The microphone needs speech recognition, which Convai does server side. With Mistral the voice key uses the local engine in
`bridge/local-stt.mjs` when it is available (docs/LOCAL_STT.md); otherwise the key shows "needs Convai for now" and nothing is
recorded. The bridge publishes `stt` in `runtime/mistral-state.json` (refreshed every 10 s) and the game reads it on a key press only.

Hook contract (the object `mistralSpeech` in `bridge/convai-bridge.mjs`): `available()` returns whether local recognition can run now;
`voiceChannel({reply})` returns the voice channel (`beginVoice`, `finishVoice`, `heard`, `close`) that turns a recording into text and
answers it with `reply(config, options)`, the Mistral route. While the provider is Mistral and `available()` is false,
`host.voiceChannel()` returns a channel that refuses with `[mistral:voice]`, which the game turns into the notice.

## What works and what does not

Works: text talk, Phone Chat, group conversations, battle and loot reactions, subtitles, Pocket/Omni voices, lip sync, emotions,
Natural speech and Expressive emotion tags, follow-up hooks, quest and world knowledge in the prompt, Forget, and the voice key when
local speech-to-text is available.

Does not: Convai long-term memory and its cloud voices (use Convai for those); Multilingual conversations (the setting is off while
Mistral is active); speculative preparation and look-ahead (a single session, like a free Convai plan); memory is local to this
computer and much simpler than Convai's.

Model variability: the smaller free models hold a persona less tightly than Convai: expect plainer replies, now and then a made-up
detail about the character (the prompt forbids it and the temperature is low, which reduces it) and an occasional retry.

## Testing

- `npm test` includes `mistral-{client,prompt,memory,key,host}.test.mjs` (SSE parser, error mapping, prompt assembly and caps,
  memory, provider switching and fallback, the key never logged, model fallback on a zero allowance, request pacing, and the
  pipeline handoff against a fake Mistral server).
- `node scripts/Test-MistralPrompts.mjs` runs sample exchanges for Judy, Johnny, Panam, Jackie, a street resident and a food vendor
  against the real service and saves the transcripts in `runtime/mistral-prompt-tests/` (git-ignored). It reads the key from the
  developer's `Commonly used Keys.txt` (the line labelled mistral) or `MISTRAL_API_KEY`, in memory only. `--dry` shows prompt sizes
  without any request; `--only judy,panam` limits it; `--model <id>` pins one model. It sends about 24 requests.
- In game: save the key (Paste Mistral key), set Conversation provider to Mistral (free plan), choose Apply, then talk by text and Phone
  Chat. Try the Memory page's Forget afterwards.
