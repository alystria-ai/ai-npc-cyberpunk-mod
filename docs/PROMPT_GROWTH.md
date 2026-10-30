# How the prompt grows over a long session, and where its start changes

Written 2026-10-31 on branch `perf/prompt-growth`. It covers the text providers: Local AI, Google Gemini, the Custom endpoint and the Mistral preset. They share one
prompt builder (`bridge/mistral-prompt.mjs`, `bridge/text-provider-host.mjs`). Convai keeps its own history on its servers and is not part of this.

The question was whether the prompt gets longer and slower as a session goes on (history, memories, facts, bond and quest notes, world blocks), and whether a change early
in the prompt throws away the server's cache. A server that caches (llama.cpp locally, the implicit prefix caches of Gemini and OpenAI-style endpoints) reuses the text up to
the first difference from the last request, so a change in front costs a re-read of everything behind it.

## The short answer

- **The prompt does not grow with the length of the session.** It reaches about 6,500 tokens by the tenth turn of a talk and stays there: 5,900 at turn 1, 6,560 at turn 10,
  6,700 at turn 30, 6,900 at turns 60 and 100. Every part has a cap (below), and the history, the memory summary and the retrieved facts are all bounded.
- **What a turn costs is set by how often the early parts change, not by the length of the session.** Tokens a server read new per turn, mean over a 100 turn talk: 897 for
  turns 2 to 10, 1,044 for turns 11 to 30, 957 for turns 31 to 60, 887 for turns 61 to 100. That is flat. The floor is about 350 (the new exchange and the notes before V's words).
- **Most of the avoidable cost is game state changing, not memory.** Of the new tokens over 100 turns, 28 percent follow a change in the world knowledge block, 25 percent a change
  in the world blocks (journal, jobs, place), 19 percent a new memory summary, 8 percent the history window moving, 19 percent the new exchange itself.
- **Nothing in the layout was worth changing.** Four layout or memory changes were tried in the study and each came out equal or worse (the section "Tried and not shipped").
- **What was added:** the cloud providers' own count of cached prompt tokens is now read and logged (`[CloudTurn]`), and a Custom endpoint on the internet is asked for it.
  Before this the bridge could say nothing about the prefix cache of Gemini or a Custom endpoint.

## How it was measured

`scripts/Study-PromptGrowth.mjs` drives the real `TextProviderHost` with the real `MistralMemory`, `PersonaBook`, `buildMessages`, the prompt budget and the real conversation blocks of
`bridge/quest-context.mjs` (the right-now block, the journal, gear, group, scenery). A fake provider server captures every request body, so the numbers are the bytes a provider
would be sent. Judy talks for 100 turns, with Panam and Jackie interleaved (about 1.6 turns of others per Judy turn). The clock moves a minute a turn, the place changes every 25 turns,
the quest step every 15, V's clothes every 40, and V keeps to one topic for eight lines and then moves on.

What is stood in, and so is only as good as the stand-in: the game's world snapshot (the "knowledge", "story", "history" and "jobs" blocks are text of the sizes the real ones have,
about 700, 600, 1,300 and 450 tokens, chosen from the words of the whole talk the way the real ones are since 29 Oct) and the memory store's retrieval (a list of facts per character
that grows by one every third turn, ranked by the words of V's line). The replies are about 200 characters. Tokens are counted at four characters a token, the measured ratio for the
shipped models is 4.2 to 4.5, so the figures are a little high. The block change rates follow from the topic and event cadence above and are the least certain part: a player who
changes topic every turn gets more world knowledge changes, one who stays on a quest gets fewer.

Run it: `node scripts/Study-PromptGrowth.mjs [--turns 100] [--slide 3] [--window 8] [--batch 8]`. With `--serve <llama-server.exe> --model <gguf>` it starts a real llama-server with the mod's
flags and records the server's own numbers (new and cached prompt tokens, first word) per turn. With `--gemini` it makes real calls to Google (paced, 30 turns is about 35 calls).

## Tokens of each part of Judy's prompt

| Turn | Persona and rules | Format notes | World blocks | Summary | World knowledge | Right now | History | Last message | Total |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2,769 | 215 | 1,870 | 0 | 685 | 157 | 0 | 221 | 5,919 |
| 10 | 2,769 | 215 | 1,870 | 0 | 683 | 157 | 481 | 339 | 6,556 |
| 30 | 2,769 | 215 | 1,871 | 140 | 703 | 160 | 502 | 310 | 6,714 |
| 60 | 2,769 | 215 | 1,871 | 142 | 712 | 161 | 644 | 310 | 6,875 |
| 100 | 2,769 | 215 | 1,871 | 146 | 690 | 160 | 626 | 341 | 6,872 |

Panam and Jackie, who are talked to less, reach 6,309 and 6,285 tokens at their tenth turn. The history is the only part that grows, from nothing to eight to eleven exchanges and then
it stays there. The summary starts at turn 17 and stays at about 140 tokens (its cap is 1,400 characters). A street resident has no journal, history or world facts and a prompt of about 2,200 tokens.

## What caps and trims exist

| Part | Cap | Where |
|---|---|---|
| Persona and rules | 16,000 characters, example lines go first, then the end of the backstory | `LIMITS.persona`, `systemHead` |
| World blocks | 16,000 characters, head and tail kept, stable blocks cut in the middle | `LIMITS.world`, `capContext` |
| World knowledge | half the world cap, ranked by the words of the whole talk (40 words at most, forgotten after ten quiet minutes) | `topic-words.mjs`, `systemPrompt` |
| Format notes, right-now block | 3,000 and 900 characters | `LIMITS.notes`, `LIMITS.now` |
| Summary of older talk | 1,400 characters, one request for every 8 exchanges that leave the history, overflow at most 24 | `MEMORY_LIMITS.summary`, `batch`, `overflow` |
| History | 8 exchanges, grows to 11 and is cut back to 8 in one step, 400 and 600 characters a line | `MEMORY_LIMITS.turns`, `slide`, `LIMITS.userLine` |
| Retrieved memories | 4 records, 240 characters each, 1,200 in all | `LIMITS.remembered`, `MemoryStore.retrieve` |
| This turn's notes | 6,000 characters | `LIMITS.volatile` |
| Small context (8k and below) | the prompt budget cuts, in a fixed order, the jobs and older journal, memories, older exchanges in blocks of 3, the summary, then world facts | `prompt-budget.mjs` |
| Characters remembered | 120, least recently talked to dropped | `MEMORY_LIMITS.characters` |

At the largest every cap allows, a prompt is about 17,000 tokens. Typical is 6,500.

## Where the start of the prompt changes

For each Judy turn the first character where her prompt differs from her previous prompt, named by the part it falls in, and the tokens a server then reads new (all three providers
alike, because the byte stream is the same):

| First difference in | Turns of 99 | New tokens over the 99 turns | A turn |
|---|---|---|---|
| World knowledge | 18 | 26,272 | 1,460 |
| World blocks (journal step, place, jobs) | 11 | 23,190 | 2,108 |
| Summary | 10 | 17,587 | 1,759 |
| The new exchange (the previous last message becomes a history line) | 49 | 17,247 | 352 |
| First exchange of the history (the window moved) | 10 | 7,872 | 787 |
| Right-now block | 1 | 967 | 967 |

Findings:

1. **The previous last message never matches.** It carried the notes and V's words, and in the next prompt it is only V's line, so the cached text ends there: about 350 tokens are
   new on every turn however well everything else holds. This is the 49 turns with the cheap difference.
2. **The right-now block almost never breaks the prefix.** The clock is not in it, the place and the weather are said only when new (`scenery-memory.mjs`).
3. **A summary change costs the most for its size** (1,759 tokens for a 140 token block) because the summary sits before the world knowledge, the right-now block and the whole
   history. It is written when 8 exchanges have left the history, which happens on the turn the window moves, so the two already share one re-read.
4. **A change in a game block re-reads the history too**, because the history is after the system message in every chat format. A larger history makes every such change dearer.

## Tried and not shipped

All with the study, same 100 turns, mean new tokens per turn for turns 11 to 30 / 31 to 60 / 61 to 100:

| Setting | 11 to 30 | 31 to 60 | 61 to 100 | Unseen exchanges, mean |
|---|---|---|---|---|
| Today: window 8 to 11, summary batch 8 | 1,044 | 957 | 887 | 1.8 |
| Batch 12 (fewer summaries: 7 against 11) | 1,034 | 892 | 847 | 3.6 |
| Window 12 to 19, batch 12 | 1,132 | 955 | 974 | 3.6 |
| Window 16 to 23, batch 16 | 1,057 | 1,151 | 1,017 | 3.2 |

- **A longer history window costs more**, not less: it halves the number of times the window moves but every game block change then re-reads a longer history. Equal or worse.
- **A bigger summary batch** saves about 3 percent and leaves the character unable to see 3.6 exchanges on average (8 at worst) instead of 1.8, so older talk is forgotten for longer. Not worth it.
- **Holding a new summary back until the window moves** was built and measured. It changed nothing, because the summary is already written on the turn the window moves. Removed again.
- **Moving the world knowledge and the right-now block out of the system message into the last message**, so the system message and the history stay put: the last message would then be about
  1,200 tokens new on every turn (the knowledge changes on 18 turns of 99, not on every one), against 900 to 1,000 now. Worse by arithmetic, not built.
- **Reordering the system message** (summary after the world knowledge) saves about 4 percent by arithmetic and moves a block a small model weighs by its place. Not built.

Open: the world knowledge and world block changes are 53 percent of the new tokens. They follow the game (a quest step, a new place, a new topic) and the quality of the facts matters
more than a stable prefix, so no hysteresis was added. A cheaper change would have to come from the game side (fewer, larger snapshot updates) and needs a live play test.

## Provider rules for a prefix cache

- **Gemini.** Implicit caching is on by default for Gemini 2.5 and newer. The minimum input is 2,048 tokens for 2.5 Flash and 2.5 Pro and 4,096 for the newer Flash and Pro models. Hits come
  from a shared prefix: put large common content at the start and send similar prefixes close together in time. Our stable start (persona, rules, notes, world blocks) is about 4,800 tokens
  and the whole prompt 6,500, above both minima. The count of cached tokens is in the usage of the reply. Source: https://ai.google.dev/gemini-api/docs/caching
- **OpenAI-style endpoints.** A hit needs the whole rendered prefix to match. Newer models cache from 1,024 tokens, older ones in steps of 128 (the cached count is rounded down to a multiple of 128).
  Changing content before a breakpoint, or summarising or truncating history, breaks it. `prompt_cache_key` helps route related requests to the same machine, and the Mistral route already
  sends one per character. The cached count is `usage.prompt_tokens_details.cached_tokens` in chat completions. Source: https://developers.openai.com/api/docs/guides/prompt-caching
- **llama.cpp, locally.** One slot, the prompt cache in RAM (`--cache-ram`) brings back a character that was left, a model with a sliding window (Gemma) needs `--swa-full` or a checkpoint to continue a
  prompt, and a hybrid model (Qwen3.5, Bonsai) continues only from a checkpoint. See docs/LOCAL_AI.md and docs/LOCAL_AI_PERFORMANCE.md.

The same rule holds for all of them: the text up to the first difference is reused, so the order stable first, volatile last is the whole game, and the layout already follows it.

## What changed in the code

- `promptUsage(usage)` in `bridge/text-provider-host.mjs` reads the prompt size and the cached part from the reply's usage object (OpenAI-style `prompt_tokens_details.cached_tokens`, the Responses API
  `input_tokens_details`, DeepSeek's `prompt_cache_hit_tokens`, Gemini's own names). A cloud turn logs `[CloudTurn] <route> prompt N new + M cached tokens (P% from the provider's prefix cache), first word T ms`,
  and the slow-turn report gets the same two counts as a local turn does.
- A Custom endpoint on the internet is sent `stream_options: {include_usage: true}` (not a server on this computer), so the closing chunk carries the usage. An endpoint that refuses the field has it
  dropped and is asked again, as for every optional field, so the only cost is one retry on such an endpoint.
- `scripts/Study-PromptGrowth.mjs`, and tests in `bridge/prompt-usage.test.mjs`.

## Measured on a local llama-server (2026-10-31, RTX 4080 Laptop, Balanced power plan, game closed)

The study with `--serve`: the real llama-server b11782 with the mod's flags (Gemma with `--swa-full`, Bonsai without), Judy only, 100 turns, the stood-in world blocks described above, summaries
written by the model itself. No prompt layout changed in this branch, so this is the "before" and the "after" at once. Other agents were running small unit tests at times, so single turns are noisy.

Gemma 4 E4B (standard), time to the first word and prompt tokens read new on chosen turns:

| Turn | New tokens | Cached | First word | What changed first |
|---|---|---|---|---|
| 1 | 5,091 | 0 | 1,010 ms | first turn |
| 10 | 372 | 5,391 | 139 ms | new exchange |
| 30 | 1,979 | 3,950 | 448 ms | world blocks |
| 60 | 68 | 5,960 | 106 ms | world blocks |
| 100 | 1,572 | 4,517 | 397 ms | knowledge block |

Means: turns 2 to 10 173 ms, 11 to 30 327 ms, 31 to 60 347 ms, 61 to 100 333 ms. Bonsai 2 4B (lite): turn 1 1,134 ms, turn 10 197 ms, turn 30 159 ms, turn 60 160 ms, turn 100 166 ms,
means 523 / 359 / 474 / 486 ms for the four ranges (it read more new tokens in the early range because it has no `--swa-full` and resumes only from a checkpoint).

So the time to the first word at turn 100 is the same as at turns 11 to 60, and 3 times faster than the first turn of a talk. It does not grow with the session. What decides a single
turn is whether a game block changed that turn (a turn that reads 1,500 to 2,000 new tokens takes 400 ms, one that reads 70 to 370 takes about 110 to 140 ms).

## Measured against Gemini

Not done: the free key's daily quota was already spent (the first call of the run was answered 429, "daily", reset at about 12:30 IST), so no cached-token count from Gemini exists yet. The
reading of the usage field is tested against OpenAI-shaped replies only. After the reset, `node scripts/Study-PromptGrowth.mjs --gemini --turns 30` makes about 35 calls, five and a half seconds
apart, and prints for each turn the tokens read new, the tokens cached, the share and the first word time. The expectation from the rules above: turn 1 has no hits, later turns hit the 4,800
token start unless a game block changed.
