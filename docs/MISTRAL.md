# Mistral as a conversation provider

For a player who has used up the shared Convai conversations (or who prefers it), companions can answer through
[Mistral](https://mistral.ai) (La Plateforme, `api.mistral.ai`) with the player's own free Mistral key. Convai free tier stays the default.
It works with no setup and gives better quality responses. Mistral replaces only the text that companions say; everything after the
text is the same code. Local speech-to-text for the voice key is documented in `docs/LOCAL_STT.md`.

## What the player does

1. Get a free key from Mistral (the free plan, "Experiment", needs phone verification at signup).
2. Settings > Conversation provider > the Mistral key row, button **Paste** (copies the key from the clipboard, checks it with Mistral, saves it on this computer; once a key is saved the button reads **Remove**). The Remove help says "Deletes the saved key." and then what the key powers now: "Conversations go back to Convai free tier." (Mistral is the provider), "Companions switch from Voxtral to the Convai voice." (the companion voice is Voxtral), "V's voice switches from Voxtral to Pocket." (V's voice is on with the Voxtral engine); with none of these, "Nothing you use now depends on it."
   Or save the key by hand in `player-mistral-key.txt` in the conversation service's state folder (`api-key=<key>` or just the key).
   The row name shows the status in brackets: the last four characters, "(Added)", "(Checking...)" or "(Not added)"; only the last four characters are ever shown.
3. **Conversation provider** > Mistral (free plan), then Apply. The switch waits until no conversation is running, so a conversation
   never mixes two providers.

Any other OpenAI-style endpoint (OpenRouter, Nano-GPT, Ollama, LM Studio) is the Custom provider, which shares this route's prompt, memory, streaming and reply checks: see [CUSTOM_PROVIDER.md](CUSTOM_PROVIDER.md).

**Mature content works with Mistral** (owner decision 2026-10-20). With the setting on, a Mistral turn gets the same Mature layer, word palette and closing line the Local AI gets, every turn, through the shared text host (`TextProviderHost`), with the hard-limit guard on the input and the reply. A Mistral model is in no row of the allowance table, so it gets the `suggestive` level (crude and forward, the act itself cut away). The lines go to Mistral as every turn does, and Mistral's own terms apply: its Usage Policy neither bans nor permits consensual adult text (read 2026-10-20, `deliverables/mature-cloud-check-2026-10-20.md`), and it may add output filters of its own. Mature content changes no voice, with any provider: V's Voxtral voice stays allowed (since 2026-10-20). Turning Mature on while Convai is the provider selects Local AI when its pack is installed, else Mistral when a key is saved, else Custom when it is set up, else the switch stays off; "Also changed" then names "Mistral (free plan)". Details: [LOCAL_AI.md](LOCAL_AI.md), "Mature content on Mistral and Custom".

This is the free route the daily-limit notice points to (a fully local option is planned). A player's own Convai key (docs/OWN_CONVAI_KEY.md)
is the provider entry "Convai API key" in the same selector; the daily-limit notice and the player documents do not promote it.

## Settings and files

| Item | Where |
|---|---|
| Provider setting | `conversationProvider` in `settings.json` (`convai` default, `mistral`, `local` for the optional Local AI pack; anything else reads as `convai`, including the `groq` of an old settings file: Groq was removed as a provider by the user on 2026-10-14, and a saved `player-groq-key.txt` is left alone and never read) |
| Key | `<state folder>/player-mistral-key.txt`, written through a temporary file; on Windows it is protected by the state folder's permissions (%LOCALAPPDATA%: only the player's account), not by a file mode |
| Paste / Remove commands | `runtime/mistral-key-command.json` (the game writes, the bridge reads; ids `<session>:mkey:<n>`; the same protocol as the Convai key) |
| Status for the settings page | `runtime/mistral-state.json`: `{version, updated, provider, effective, saved, tail, pending, result, limit, model, stt, localAi}` (`provider` and `effective` are `convai`, `mistral` or `local`; `localAi` is `ready`, `warming`, `not-installed`, `no-memory` or `failed`, shown as a bracket in the Local AI model row's name when not ready) |
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
| `bridge/memory-store.mjs` | The memory the text providers share (Mistral, local): the same history and summaries plus lasting records with embeddings (docs/LOCAL_AI.md). |
| `bridge/text-provider-host.mjs` | One host for every text provider: `TextProviderHost.reply(config)` over a route per provider (`mistralRoute`, `localRoute`), and `attachTextProvider(host, ...)`, which makes the bridge's realtime hosts use it while a text provider is active. |
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

Then the recent history (the last 8 to 11 exchanges, cut back to 8 in one step so its start holds for several turns, as alternating user/assistant messages), then one user message: the live context (exactly
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
a prefix cache keeps working on Mistral and the local model:

1. system: the persona and the output rules (the persona prefix; the local AI loads it ahead on an invitation);
2. system: the format notes for tags (Expressive emotions), then the world and quest context (slow), then what the character
   remembers (the summary). Inside the world context the blocks that only change on game events come first (recency, history, jobs,
   journal, gear) and the world facts come after them (`worldBlocksInCacheOrder`, `bridge/mistral-prompt.mjs`): the facts are ranked by
   the words V just said, so their text changes with every turn, and placed first they made the first changed token sit right after the
   persona (first player reports, 2026-10-19: 2,350 cached and about 3,000 new tokens on every turn). The Convai context keeps its own
   order;
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

### Companion actions (drive, attack, follow, leave)

Convai characters can carry out four game actions: drive V to the map waypoint ("Drive To Waypoint"), attack the enemy V tagged or aims at,
follow V (a world character joining the party) and leave V's party. The game offers them per turn (`chauffeurOffer`, `tacticOffer`,
`followOffer`, `leaveOffer` in the turn input, parsed by `bridge/protocol.mjs`; the bridge's `CompanionActions` arms the turn and
`configFor()` gives every route `config.companionAction`). Before this, the text path ignored that config, so "drive for me" only ever
produced words. There is no wait, stay, sit or stop action in the game; only those four exist.

How it works on Mistral and Local AI (`bridge/text-actions.mjs`, used by `TextProviderHost`):

1. When an offer exists, a tiny separate request (max 12 tokens, temperature 0, no retries, 8 s cap) reads V's message and answers one
   word: `DRIVE`, `FIGHT`, `FOLLOW`, `DISMISSED` or `NONE`. It runs in parallel with the memory lookup, so it adds almost nothing. A failed or
   unclear answer is `NONE`: the turn is plain talk.
2. The reply prompt gets a `GAME ACTIONS` note in the volatile block, after V's other notes and before "V says:" (the stable prefix and its
   cache do not change). It says either "V is asking you to ... agree briefly" or that nothing is asked, and states what is impossible right
   now ("you cannot drive V anywhere (no destination is marked on the map)", "you cannot wait on a spot, stay behind or sit on command"), so
   the character says what V has to do first instead of promising it.
3. After the reply succeeds, the host delivers the same message the Convai client would send (`runtime/companion-actions.json`). It
   is fire and forget; a failure is logged and never fails the reply. Stray codes (`[DRIVE]`, `[NONE]`) in a reply are stripped before the voice.
4. The Lua side now also reports why a ride is not possible (`driveUnavailable`: `player-driving`, `player-seated`, `no-waypoint`, `no-car`,
   `car-moving`, `combat`, `busy`), only to the text routes; Convai's text is unchanged.

#### Which provider decides how (checked 2026-10-20)

| Provider | How an action is decided | Fired by |
| --- | --- | --- |
| Convai | Convai's own action list: the context names the exact offered action (`Drive To Waypoint <token>`, `Attack Marked Target`, `Follow V`, `Leave V's Party`) and the Convai model asks for it in its reply; `bridge/realtime-client.mjs` accepts only the offered one | `CompanionActionWindow` publishes `runtime/companion-actions.json` |
| Mistral, Local AI, Custom | the decision request above (`bridge/text-actions.mjs`), the same for all three: `TextProviderHost` serves them with one code path | `CompanionActions.deliver`, the same file |

Custom (OpenRouter, KoboldCpp, Ollama, LM Studio, any OpenAI-compatible endpoint) takes exactly the Mistral and Local AI path. A server on this
computer or home network (`custom.local`) answers one request at a time, so the decision runs before the reply, like on Local AI.
The game side (`mod/gameplay-actions.lua`) does not know the provider: it offers what the game allows, and the bridge's `CompanionActions.admit`
arms the turn for any provider (it needs the turn's identified player route, which every provider has; it is not Convai's identity).

What the game must offer, whatever the provider (the model can only choose among these, never create one):

- **Drive**: a managed companion in V's party who can drive (not Alt), V's own car standing still, and a destination marked on the map.
  Either V is on foot with the car within about 20 m, or (seated drive, 2026-10-20) V is sitting in their own car, as driver or
  passenger, with the companion in the car or outside it (`offer.seated` = `driver` or `passenger`; see `docs/COMPANION_CHAUFFEUR.md`,
  "Seated drive"). V sitting in a vehicle that is not their own car, or no marked destination, offers nothing and the character says
  what is needed. The seated request words ("you drive", "swap seats", "take over") are in `bridge/text-action-words.mjs`.
- **Fight**: a tagged enemy (scanner) or one in V's sights, and the companion in V's party.
- **Follow**: a world character the game judged safe to adopt (not in a quest scene, not in combat, not on duty).
- **Leave**: a current party member.

Two safety nets under the model, both for the text routes (2026-10-20):

- When the decision request fails, times out, is unreadable or answers none, a few plain English requests are still honoured ("drive me",
  "take the wheel", "attack him", "follow me", "come with me"; `explicitRequest` in `bridge/text-action-words.mjs`). Only drive, attack and
  follow, never leave; only for lines the word screen already let through; questions, conditions, negations and look-alikes ("do you know how
  to drive?", "if you drive me there", "attack of the clones") are not requests. The game still checks the exact offer. It costs nothing on a
  normal turn (it runs only after the decision gave nothing). Measured need: Gemma 4 E4B recall was 81% on Local AI, Mistral 3b 97%.
- A custom server whose model thinks first answered the one-word decision with thinking only on the first turn that showed it thinks, which read
  as "no action". It is now asked again once with the fields that ask for no thinking (same 12-token budget); the remembered setting then
  applies from the start.

Why not tool calls: on action turns `ministral-8b` returned only a tool call with no speech, picked the wrong tool, called several or filled
the arguments with garbage; speech would need a second request and the tool definitions sit before the cacheable prefix. Why not a code at the
start of the reply: the small model either never wrote it (recall 12%) or wrote it for plain talk (precision 58%).

Measured with `node scripts/Eval-MistralPrompt.mjs --actions` (6 characters, 27 situations, 3 samples each, `--report-actions <label>`;
`--no-actions` is the old behaviour): before, 0 of 196 asked-for actions fired; after, precision 100% (195/195) and recall 99% (195/197),
no false trigger in 288 plain, impossible or look-alike turns ("do you know how to drive?", "let's leave this place", "wait here").

The decision request uses `ministral-3b` (`DECISION_MODELS` in `bridge/mistral-client.mjs`, 8b as the fallback); the reply keeps 8b. Measured
on 14 Oct 2026 with `--actions --decision-only --models ministral-8b-latest,ministral-3b-latest` (54 lines: 35 asked-for, 31 plain or look-alike
once the word screen is applied; temperature 0, about 325 short requests in all): 3b recall 97% (34/35, "Walk with me for a bit?" is the one miss),
precision 100%, false triggers 0/31, latency p50 475 ms, p90 760 ms; 8b recall 99-100%, one false trigger ("My driver quit last week."),
p50 510-590 ms, p90 940 ms.

### Memory

Convai keeps history and long-term memory on its servers; with Mistral the bridge keeps a small, bounded version in
`mistral-memory.json`:

- the last 8 to 11 exchanges per character and channel (private, phone, group);
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
`bridge/local-stt.mjs` for English when it is available (docs/LOCAL_STT.md), and Mistral's own transcription with the same key for any other language ("Other languages" there); otherwise the key shows "needs Convai for now" and nothing is
recorded. The bridge publishes `stt` in `runtime/mistral-state.json` (refreshed every 10 s) and the game reads it on a key press only.

Hook contract (the object `mistralSpeech` in `bridge/convai-bridge.mjs`): `available()` returns whether local recognition can run now;
`voiceChannel({reply})` returns the voice channel (`beginVoice`, `finishVoice`, `heard`, `close`) that turns a recording into text and
answers it with `reply(config, options)`, the Mistral route. While the provider is Mistral and `available()` is false,
`host.voiceChannel()` returns a channel that refuses with `[mistral:voice]`, which the game turns into the notice.

## What works and what does not

Works: text talk, Phone Chat, group conversations, battle and loot reactions, subtitles, Pocket/Omni voices, lip sync, emotions,
Natural speech and Expressive emotion tags (Natural speech also works with the Convai voice selection: the bridge plays Pocket for it here), follow-up hooks, quest and world knowledge in the prompt, Forget, and the voice key when
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
- In game: save the key (Paste on the Mistral key row), set Conversation provider to Mistral (free plan), choose Apply, then talk by text and Phone
  Chat. Try the Memory page's Forget afterwards.
