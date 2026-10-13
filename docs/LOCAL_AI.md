# Local AI

The fully local conversation option: the characters' replies are written by a small language model that runs on the player's own
graphics card. It needs no account and no internet connection. This page has two parts: what a player sees, and notes for developers.
The design and the measurements behind it are in `docs/LOCAL_OPTION_DESIGN.md` and `docs/LOCAL_MODEL_CHOICE.md`.

## For players

### What it is

Choose **Local** as the Conversation provider (Settings > Development) and the characters answer with an AI model that runs on your
computer. Replies are spoken by the local voices (Pocket or OmniVoice) and the characters keep a memory of your talks, stored on your
computer. Convai free tier gives better quality responses; Local is for playing without an account or without the internet.

The models are optional downloads, like the OmniVoice pack. There are two, and you can install neither, one or both:

| Pack | Model | Download | Best for |
|---|---|---|---|
| **Local AI standard** | Gemma 4 E4B | about 5.3 GB | Named characters and companions: it stays closest to what the character knows and invents the least |
| **Local AI lite** | Qwen3.5-2B | about 1.5 GB | Smaller graphics cards, or a game that already uses most of the video memory. Plainer replies; fine for ordinary NPCs |

Extract each download into your Cyberpunk 2077 folder (the same way as the OmniVoice pack), then pick **Local** in Settings > Development.
The Local AI row there shows one of: Ready, Warming up, Not installed, Not enough graphics memory, Unavailable.

The first start after installing takes about a minute while the graphics card prepares the model (the row says "Warming up"). After
that the model loads in a few seconds when you start talking, and it is unloaded again after ten minutes without a conversation so the
game gets its video memory back.

### When it does not fit

The voice matters more than the text. If the graphics card is short of memory, the mod steps down in this order and never asks you to
do anything:

1. It keeps your chosen voice (OmniVoice loads first) and uses the **lite** model instead of the standard one.
2. If even the lite model does not fit beside OmniVoice, it keeps the voice and uses a cloud provider for the text: Mistral if you saved a
   Mistral account key, otherwise Convai. You see one notice, once.
3. The voice is only changed as a last resort.

If the pack is missing or the model cannot start, the same fallback applies. Choosing Local again tries again.

If Local AI cannot answer one particular turn (for example the model went away mid-reply), that turn is answered by your cloud provider
(Mistral with a saved key, else Groq with a saved key) and you see "Local AI could not answer that one, so a cloud provider did." at most
once every ten minutes. With no cloud account saved you see "Local AI could not answer that. Try again in a moment." instead of silence.
Local AI stays the chosen provider either way.

### Which combination to pick

Graphics memory (video memory) each part adds on top of what the game itself uses. These are estimates from measurements on one
RTX 4080 Laptop (12 GB); the game's own use depends on your settings (ray tracing and high textures use the most) and is not included.

| Voice | Text | Extra video memory | Notes |
|---|---|---|---|
| Pocket | Convai or Mistral (no Local AI) | 0 GB | Pocket runs on the processor |
| Pocket | Local AI lite | about 1.5 GB | |
| Pocket | Local AI standard | about 3.1 GB | |
| OmniVoice | Convai or Mistral (no Local AI) | about 2 GB (up to 4 GB) | |
| OmniVoice | Local AI lite | about 3.7 GB (up to 5.8 GB) | |
| OmniVoice | Local AI standard | about 5.2 GB (up to 7.3 GB) | |

Lower settings means medium textures and no ray tracing; higher settings means high textures or ray tracing. The same table is in the
player README (`packaging/PLAYER_README.md`); keep the two in step.

| Your card | What fits | When it is short |
|---|---|---|
| **6 GB** | Pocket with Convai or Mistral. Local AI lite only on lower settings. | The text moves to Mistral or Convai; the voice stays Pocket. |
| **8 GB** | Pocket with Local AI lite, or OmniVoice with Convai or Mistral, both on lower settings. | The lite model gives way to Mistral or Convai text; OmniVoice stays if chosen. |
| **12 GB** | OmniVoice with Local AI lite on any settings. Pocket with Local AI standard on lower settings. | Standard becomes lite, lite becomes Mistral or Convai text; the voice stays. |
| **16 GB** | OmniVoice with Local AI standard on lower settings, with Local AI lite on higher settings. | Standard becomes lite, lite becomes Mistral or Convai text; the voice stays. |
| **24 GB** | Anything; OmniVoice with Local AI standard has plenty of room. | |

When the card is short, the voice is kept before the text: standard gives way to lite, lite gives way to Mistral or Convai, and the
voice only changes as a last resort.

A note on the start rule, found while writing the table: the tier check needs free video memory of at least the model file plus
headroom (standard: the 5.15 GB model file plus 1200 MiB, so about 6 GB free; lite: the 1.28 GB file plus 700 MiB), although standard measures about 3.1 GB
once loaded. A 6 GB card therefore always starts lite or falls back, even when the standard model would have fitted at runtime. The rule
is deliberate (a margin so the game keeps its textures), and the player README states "about 6 GB free" for standard.

You also need about 5 GB more system memory than with Convai (16 GB total at least, 32 GB is better) and an NVIDIA or AMD graphics
card that supports Vulkan. A computer without a separate graphics card cannot use Local AI.

## For developers

### Switching it on in development

No pack is needed: point the bridge at the folder of models you already have.

```
set CYBERPUNK_CONVAI_LOCAL_AI_DEV=E:\CyberpunkConvai-offload\work\local-llm
```

The folder is shaped like the model-choice benchmark's: `llama-vulkan\llama-server.exe`, the single `.gguf` in `dl-gemma4-e4b\`
(else `dl-qwen35-4b\`) for the standard tier, `dl-qwen35-2b\` for lite, `dl-granite-emb\` for the embedding model. Each file can be
replaced by an environment variable, and the model is only ever configuration:

| Variable | Meaning |
|---|---|
| `CYBERPUNK_CONVAI_LOCAL_AI` | The pack folder (default `<project>\local-ai`) |
| `CYBERPUNK_CONVAI_LOCAL_AI_DEV` | A developer folder as above (used when the pack has no manifest) |
| `CYBERPUNK_CONVAI_LOCAL_SERVER` | `llama-server.exe` |
| `CYBERPUNK_CONVAI_LOCAL_MODEL` / `..._LITE_MODEL` | The standard / lite chat model file |
| `CYBERPUNK_CONVAI_LOCAL_EMBED_MODEL` | The embedding model file |
| `CYBERPUNK_CONVAI_LOCAL_CACHE_RAM` | `--cache-ram` in MiB (default from free system memory: 4096 at 12 GB free, 2048 at 8 GB, else 1024) |

Then set `conversationProvider` to `local` in Settings > Development (or in `settings.json`) and Apply. Nothing is copied into the
repository.

### The pack

`manifest.json` (version 1) in the pack folder names the files, relative to it (absolute paths and `..` are refused):
`server`, `standard: {file, name}`, `lite: {file, name}`, `embed: {file, dim, id}`. The two optional downloads each carry a fragment,
`manifest.standard.json` or `manifest.lite.json`, with the shared `server` and `embed` entries; the detector merges whatever it finds,
so either one alone works and a hand-deleted model only removes its own tier. Another model is only another manifest. Detection is in
`bridge/local-ai-pack.mjs` and is the same kind of check as `bridge/omni-pack.mjs`: it only stats files.

Packaging: `packaging/build-release.mjs --packages localai-standard` (or `localai-lite`) builds each download, and the release workflow
runs both as a matrix job (`localai`). Every file is the unmodified upstream file, pinned by URL, revision and SHA-256 in the
`localAi` block of `packaging/release.config.json`: the `llama-server` Vulkan build b11560 (MIT; only `llama-server.exe` and its
DLLs are kept, no other command line tools), the Q8_0 granite embedding model (Apache-2.0), and one chat model: Gemma 4 E4B QAT q4_0
(Apache-2.0, 5.15 GB, split into 1 GB parts joined by `app/launcher/assemble-parts.mjs` on the first start) or Qwen3.5-2B Q4_K_M by
Unsloth (Apache-2.0, 1.28 GB). Each pack unpacks to `red4ext/plugins/CyberpunkConvai/app/local-ai/` with its manifest fragment, the
licence texts and `THIRD-PARTY-NOTICES.txt`; `prepare-state.mjs` points `CYBERPUNK_CONVAI_LOCAL_AI` there. With `--models local` the
developer folder (`--local-ai-source`, default `CYBERPUNK_CONVAI_LOCAL_AI_DEV`) supplies the files, each still checked against its
pinned hash. See `docs/PACKAGING.md`.

### Modules

| Module | Job |
|---|---|
| `bridge/local-ai-pack.mjs` | Detects the pack: server, tiers, embedding model, what is missing. |
| `bridge/local-llm-server.mjs` | The supervisor of `llama-server` (Vulkan). Random loopback port; the per-session API key goes through a private file (`--api-key-file`), never the command line, a log or a status file. Chooses the tier by free VRAM (standard needs its file size plus 1.2 GB, lite plus 0.7 GB), runs warm-up requests of the bridge's batch shapes on the first start (a progress state, not an error), unloads after ten idle minutes, restarts a crashed server twice, and reports one `failed` event. `begin()`/`end()` mark a request in flight so the idle stop never cuts a reply. |
| `bridge/local-embed.mjs` | The embedding model (granite-embedding-107m-multilingual, 384 dimensions) as a CPU-only `llama-server` (`--device none -ngl 0`, one thread), started on demand and exiting after 90 idle seconds. About 14 ms a query. |
| `bridge/text-provider-host.mjs` | The host shared by Mistral, Groq and Local (see `docs/MISTRAL.md`). `localRoute` calls `server.ensure()` for a connection, no pacing, JSON-schema fact extraction, persona-prefix prewarm on an invitation. Background work never starts the server. |
| `bridge/memory-store.mjs` | The memory shared by the text providers. |
| `bridge/groq-key.mjs` | The Groq key file (see `docs/MISTRAL.md`). |

### Ordering with OmniVoice

Omni loads first and the tier is chosen from what is left: the supervisor's `beforeStart` hook (set in `convai-bridge.mjs`) waits, for
at most two minutes, until the requested voice has settled, and then reads the free video memory. Standard fits if free memory is at
least its file size plus 1.2 GB, else lite if it is at least its file size plus 0.7 GB, else the supervisor fails with `low-memory`,
`MistralProvider.noteLocalFailure` is called once, and the provider falls back to Mistral (with a key) or Convai at the next idle boundary
with the single `local-fallback` notice.

### Context budget

A prompt must never be longer than the server's context (n_ctx), or the request is refused (HTTP 400, `exceed_context_size_error`) and the
player hears nothing. That was the live bug of 2026-10-12: a fixed 8,192-token server context against a prompt that was bounded only in
characters (a named character's persona and the output rules are about 4.5k tokens on their own, and the world blocks, history and
memories could add more than 4k), so one turn at a busy place sent 8,790 tokens, was refused, and was neither retried nor handed to
another provider.

`bridge/prompt-budget.mjs` fits every Local and Groq request before it is sent (`budgetedChat`, wrapped around the route's `chat` in
`localRoute` and `groqRoute`). `buildMessages` leaves its arguments on the messages (a non-enumerable symbol property, never sent), so the
budget rebuilds the prompt with less in it instead of cutting a string.

- **The limit.** `n_ctx` from the server (`GET /props`, in the supervisor's handle as `contextSize`; Groq: 8,000 tokens, the free plan's
  per-minute allowance, which is also the most one request may carry) minus a reply reserve (320 tokens; 256 for Groq) minus a safety
  margin (the larger of 48 tokens and 1.5% of n_ctx). Mistral's cloud models have contexts of 128k and more, so they are not fitted.
- **The count.** An estimate first: characters per token learned from the server's own counts (`TokenMeter`: the lowest recent ratio times
  0.97; 3.6 before anything is learned, the prompt really measures about 4.2), plus the chat template's cost per message; Chinese,
  Japanese and Korean count about a token a character, other scripts about half a token. A prompt that is clearly under the limit is sent
  as it is. One that is near it or over it is counted by the server (`POST /tokenize`, about 50 to 150 ms for 30,000 characters) and the cut
  is decided on that count. The reply's closing chunk carries `usage.prompt_tokens` (`stream_options.include_usage`), which the meter learns
  from.
- **The order of cuts**, lowest priority first, each step only while the prompt is still too long: the jobs block, the journal-history
  block, the recent-events block and the gear block (each halved once, then dropped), the retrieved memories (one at a time), the older
  turns of the conversation (never the last two), the older-talk summary (halved once, then dropped), the tracked-quest block, the world
  facts (halved once), the volatile notes (capped), the last turns, the world block as a whole (capped), and the persona's example lines.
  Never cut: the persona and rules, the format notes, the "Right now" block and the player's words. A prompt that does not fit with all of
  that gone is a failed request (`PromptTooLarge`, kind `request`), which takes the fallback path below.
- **Prefix caching.** The layout (stable first, changing last) is kept, and the cuts are discrete and deterministic: a block is halved once
  and then dropped, never trimmed a little more each turn, so the early part of the prompt changes only when a threshold is crossed and not
  on every turn (hybrid models such as Qwen3.5 and Gemma 4 lose every cache checkpoint after one changed early token).
- **A refusal anyway.** If the server still refuses (`error.overflow`: its `n_prompt_tokens` and `n_ctx`), the count is learned into the
  meter and the same turn is fitted again and sent once more. A second refusal is final.
- Every cut is logged as `[TextProvider] The local AI: prompt N of M tokens; cut: ...`.

### Context size

The supervisor starts `llama-server` with the largest context of a ladder whose extra KV cache fits the free video memory
(`chooseContext` in `bridge/local-llm-server.mjs`: 16,384, 12,288, 8,192) and then reads the real `n_ctx` from `/props`. Measured on the
RTX 4080 Laptop (Vulkan, `-fa on`, one slot, f16 KV cache), video memory after the model is loaded and the context is allocated:

| Model | n_ctx 8,192 | 12,288 | 16,384 | KV cost per 1,000 tokens |
|---|---|---|---|---|
| Standard (Gemma 4 E4B) | 3,008 MiB | 3,076 MiB | 3,144 MiB | 17 MiB |
| Lite (Qwen3.5-2B) | 1,399 MiB | 1,451 MiB | 1,503 MiB | 13 MiB |

Both models keep a small cache (sliding-window or hybrid attention), so 16k costs only 136 MiB (standard) or 104 MiB (lite) more than 8k.
That is why 16,384 is the default for both tiers wherever the tier itself fits. OmniVoice is never pushed out by it: the ladder is checked
against the free memory after OmniVoice has loaded (the order in "When it does not fit" is unchanged) and steps down to 12,288 or 8,192
only when that extra 70 to 140 MiB is not free. The player-facing table's "about 3.1 GB" and "about 1.5 GB" cover the 8k to 16k range. A
quantised cache (`q8_0`) was measured too: it saves only another 75 to 90 MiB, and the first long prompt prefilled slower on the Vulkan
build, so it is not used. A fuller prompt costs prefill time, not memory: a 15,700-token prompt prefilled in about 7 s (standard) and 3 s
(lite) cold; with the stable prefix cached a normal turn sends only its new tail.

`CYBERPUNK_CONVAI_LOCAL_CTX` (or the constructor's `contextSize`) fixes the context for development and tests.

### When Local AI cannot answer a turn

`localRoute` falls back for any failure of a turn (a prompt that cannot fit, a server that went away, no first byte in time): to Mistral
when a key is saved, else to Groq when a Groq key is saved and not blocked (`TextProviderHost#candidates`). The turn's reply is the cloud
provider's, and `MistralProvider.noteLocalTurnFallback()` queues the `local-turn-fallback` notice (sent as `keyNotice` on that reply; the
game shows it at most every ten minutes). With no cloud provider the turn fails with the game code `local-failed` (`errorCodeFor`), shown
as "Local AI could not answer that. Try again in a moment." (the phone shows the same words). Automatic reactions show neither notice.
A server that could not start keeps its own path (`local-fallback`, see "Provider state"). Both notices are in `docs/NOTIFICATIONS.md`; the
strings are in the 15 locale files and `localization/en.json`.

### The knowledge status file (EPERM in the bridge log)

`Knowledge poll: EPERM ... rename 'runtime\knowledge-status.json.<id>.tmp'` is the bridge's atomic write (temp file, then rename over the
target, twice a second) meeting a reader that has the target open without the delete share: Windows refuses the rename for as long as it
is open (reproduced with a C-runtime-style open held for a moment). The reader is the game's own heartbeat check, `mod/service-status.lua`,
when it reads through CET's `io.open` (the C runtime, no `FILE_SHARE_DELETE`). With the native core on, that read is the worker's, which
opens with `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE` (`native/core/src/core/FileIo.cpp`), so the plugin needs no change. The
rename is retried with backoff for about 300 ms (`bridge/guarded-file.mjs`), the previous file stays intact and the next poll writes
again, so a miss costs one heartbeat and nothing else. The log line is written at most once a minute per message (`logKnowledgePoll` in
`bridge/convai-bridge.mjs`, with a count of the ones left out). If it keeps coming with the native core on, look for `Native core: io=lua`
in the CET log (a tripped switch or `runtime/native-off.txt`): CET's `io.open` cannot be given a share mode, so the only cure for a Lua
reader is to read through the native core.

### Provider state

`conversationProvider` is `convai | mistral | local | groq`. `MistralProvider` (`bridge/mistral-key.mjs`) keeps `preference` (the
setting), `requested` and `applied`; a switch happens only at an idle boundary. `local` is requested while it works; after
`noteLocalFailure(reason)` it is Mistral when a key exists, else Convai, until the setting is chosen again. The status file
`runtime/mistral-state.json` carries `localAi`: `ready | warming | not-installed | no-memory | failed`.

### Memory

`bridge/memory-store.mjs` replaces `MistralMemory` for all text providers. Per character there is one file,
`<state>/local-memory/player/<profileKey>.json`: the last exchanges and a summary (as before), the exchanges waiting for extraction, and
lasting records (facts, events, preferences, relationships, promises) with their embeddings. The old `mistral-memory.json` is migrated once
(and renamed). Retrieval is one embedding call (hard timeout 400 ms) plus a flat scan: cosine similarity plus small recency, importance
and pinned bonuses, a threshold of 0.40, at most four records and 1,200 characters, injected into the last user message. Extraction
and summaries run on the host's `gate` only: no combat for 30 s, nothing in flight, speaking or recording, and 20 s since the last turn;
they are interrupted by the next turn. Forget (the Memory page) forgets per character or all, records and vectors included. If the
embedding model is missing, memory behaves like the old last-8-plus-summary memory.

Deviation from the brief: the brief asked for ONNX. The embedding model runs as a GGUF in `llama-server` instead, because the pack
already ships that executable (no second runtime, no Python on the hot path) and it measured about 14 ms on one CPU core. Another backend
can replace `LlamaEmbedder` as long as it keeps `available()`, `id`, `dim`, `embed()` and `close()`.

### Prompt order

See "Prompt order (layout v2)" in `docs/MISTRAL.md`: persona and rules, then world and quest context, then the right-now block, then
the turns. That keeps llama.cpp's prompt cache (hybrid models such as Qwen3.5 and Gemma 4 lose every checkpoint after one changed early
token) and Mistral's cache valid.

### Actions

The same companion-action path as Mistral applies (see "Companion actions" in `docs/MISTRAL.md`): the decision is a separate 12-token
request to the local model, and the reply carries the `GAME ACTIONS` note. It is skipped when no action is offered. Measured on Gemma 4 E4B
(`scripts/Eval-MistralPrompt.mjs --actions --local <port>`, 64 replies): precision 100%, recall 81%. The reply waits for the decision (a short prompt
and a one-word answer, not yet timed on the player's hardware), so on a slow GPU this adds to the time before the first sound.

### Mature content

#### The Mature pack gates it

The setting ships ONLY with a separate, adult-flagged download, the Mature pack (its own Nexus page; the main mod page stays clean and
carries only the generative-AI tag). The pack holds the uncensored model files. Without it the setting, its help text and the 18+ notice do
not exist and nothing is applied:
- Detection: `bridge/mature-pack.mjs` (`detectMaturePack`) looks for the marker `manifest.mature.json` in the Local AI folder, beside
  `manifest.standard.json` and `manifest.lite.json` (same root: `<project>/local-ai`, or `CYBERPUNK_CONVAI_LOCAL_AI`, which the packaged
  service points at `app/local-ai`). The marker is `{version: 1, pack: 'mature', models: [{file, name, family}]}`; a valid marker is
  "installed" (the listed files are reported as `present`, not required, because a split model is joined at the first start); a missing,
  malformed or foreign marker, or a model path that leaves the folder, is not trusted. The Local AI detector never reads this marker.
- When: once at start and then from the settings poll at most every 5 s (one `stat` and a tiny read; never per frame, never per turn).
  `MatureContent` has two inputs, `requested` (the settings file) and `pack` (the scan); `enabled` is both. No marker means off even
  when the settings file says on, and the layer, the screen and the prewarm text are the ones of the setting being off (byte for byte).
  Finding or losing the pack flips it at once and drops prepared replies.
- Lua: the bridge publishes `maturePack` in `runtime/mistral-state.json` (`MistralControl.status`); `manager.mistral().maturePack` reads it.
  `mod/mcm.lua` adds the "Mature content" row (and its help) only when it is true. `manager.applySettings` answers "Unknown setting" for
  `matureContent` without the pack, so the setting cannot be saved by hand, and the snapshot reports it off without the pack even if the
  file says on. The 18+ line is only reachable with the pack.
- Packaging: `maturePack` in `packaging/release.config.json` and `maturePackage` in `packaging/build-release.mjs`. The package id is
  `mature`; it is built only with `--packages mature` and is NOT in the default set, so a plain build and the release workflow never
  produce it, and nothing of it (marker, README, Nexus text, models) is in the Runtime package or `release-plan.json`. It writes the model
  files into `app/local-ai/models/`, the marker, and `app/local-ai/mature/` (`README.md` from `packaging/MATURE_PACK_README.md`,
  `licenses/Apache-2.0.txt`, `THIRD-PARTY-NOTICES.txt`, `mature-pack.json`). The model list in the config is still PLACEHOLDERS; the
  build refuses to run until every entry is filled in and pinned by revision, size and hash, and it refuses a non-Apache-2.0 model.
- Pack texts: `packaging/MATURE_PACK_README.md` (ships in the pack) and `packaging/MATURE_PACK_NEXUS.md` (the Nexus description plus the
  page settings: adult flag and classifications, the generative-AI tag, the main mod as a requirement). Both say 18+, what it adds, that
  the hard limits stay, that it needs the main mod and a Local AI pack, and the install steps.

#### The setting

Settings > Development, right under Conversation provider (only with the pack): "Mature content" (key `matureContent`, off by default, an ordinary Apply setting; the
bridge reads it from `runtime/settings.json` when the file changes, never per turn, and drops prepared replies when it flips). It exists
only for this provider: the layer is built in `bridge/mature-content.mjs`, and `MATURE_PROVIDERS` is `{local: true, mistral: false,
groq: false, convai: false}`. The host asks for the layer per route (`TextProviderHost#matureLevel`), so a local turn that falls back to
the player's cloud provider is answered without it. While another provider answers, the setting's help says it applies to Local AI only.
Turning it on shows one line that the content is for adults (18+), in all 15 locales.

What it adds: one block of about 240 tokens at the END of the system head (`systemHead({mature})`), after the output rules and before
the format notes. That is the stable early text, so llama-server's prefix cache is kept (the layer is the same every turn for a given
model), the prewarm text is the same head, and `bridge/prompt-budget.mjs` never touches the head (it trims the world, memory, history,
notes and example lines). With the setting off the argument is absent and the prompt is byte for byte what it was (tested). On: strong
profanity, crude humour, graphic violence and gore, drugs and cyberware abuse, dark and morally grey themes, flirting and, where the
relationship facts and the character allow it, romance and sex between consenting adults. The character stays herself (personality,
boundaries, orientation; she may refuse) and follows the relationship facts already in the world block (the same save-confirmed
relationship state `bridge/relationship-routing.mjs` uses): without a fact that says she and V are together she is not V's lover.
Hard limits, last in the layer, for every model: nothing sexual with anyone under 18 or who seems under 18; nothing without consent or
glorifying sexual violence; no bestiality or incest; nothing sexual about real people; no real-world instructions for weapons, explosives
or drug synthesis; no hateful content against real protected groups.

Per model: `MODEL_ALLOWANCE` keys the allowance by model family, read from the loaded model's name (`server.status().model`: the pack
manifest's name or the file name). Levels: `full`, or `suggestive` (the sexual clause becomes "keep it suggestive, cut away"). Gemma 4
and Qwen3.5 are Apache-2.0 (full); Gemma 1 to 3n are under the Gemma Prohibited Use Policy, which bars "sexually explicit content,
including content created for the purposes of pornography or sexual gratification" (suggestive); an unknown model is suggestive; the
uncensored candidates (`Qwen3.5-*-Uncensored-HauhauCS-*`, `gemma-4-E4B-it-ultra-uncensored-heretic`, any name with uncensored,
abliterated or heretic) are full and flagged `uncensored`. Stock models still tend to refuse sexual content, so the full effect needs
an uncensored model, which is what the Mature pack carries (`docs/MATURE_MODELS_RESEARCH.md` on main). Such a model has no limits of its own, so
a cheap output screen (`screenMinors`, two regular expressions, microseconds) drops any sentence that names a minor and something
sexual together before it is voiced (a first sentence that flags is never committed to the voice) and logs the count, never the words.
It runs only with the setting on, and is a last net, not the control: the layer is.

Provider policies (read 2026-10-13; the pages were summarised by a small model, so re-read them before the Nexus release):
- Mistral, Usage Policy (legal.mistral.ai/terms/usage-policy, effective June 11, 2026): no sentence permits or bans adult sexual
  content as such. It bars "Content that enables or exploits individuals, including through human trafficking or sexual services." and
  intimate images "without the explicit consent of all individuals involved." Its Commercial Terms add no content line. `safe_prompt`:
  "Whether to inject a safety prompt before all conversations.", default `false`. Verdict: ambiguous, so Mistral stays off.
- Groq, Acceptable Use and Responsible AI Policy (console.groq.com/docs/legal/ai-policy, effective October 15, 2025): bars "non-consensual
  intimate imagery or sexually explicit content that is illegal;". Adult content is not mentioned; the Services Agreement defers to the
  model developer's terms. Verdict: ambiguous, so Groq stays off.
- Convai: never (a hosted service; the player's own key changes nothing).

Nexus Mods (help.nexusmods.com, not changed by this work): the Adult Content Guidelines (updated May 12, 2026) define adult content as
"content (mods, collections, videos, images, and text) that is considered unsuitable for minors", list Swearing or Profanity and
Sexualised content, and say "It is the responsibility of the uploader to tag and/or classify their files appropriately." The File
Submission Guidelines (updated September 29, 2026) say "Generative AI usage in mods or mod pages must have specific tags applied". No
rule speaks to an optional, off-by-default setting that lets an AI write adult text. Decision (made by the user): the setting ships only
with the separate Mature pack, which gets its own adult-flagged page (classified for Swearing or Profanity and Sexualised, and Extreme
Violence where the form asks, plus the generative-AI tag), so the uploader's duty to tag and classify is met by the page that carries the
adult content, and the main mod page needs only the generative-AI tag it needs anyway for AI dialogue.

Tests: `bridge/mature-content.test.mjs` (the setting, the provider gate, the pack gate, the table, the layer's size and hard limits, off
byte-identical, additive and prefix-stable, the budget never cutting it, which route gets it, the screen), `bridge/mature-pack.test.mjs`
(the marker detector), `bridge/manager.test.mjs` (the Lua side: row hidden and setting refused without the pack, forced off when the
pack disappears, the 18+ line) and `packaging/release.test.mjs` (the package definition, out of the default set and out of the Runtime
package, the builder refusing placeholders, the pack texts). Prompts only; no model is asked for adult text.

### Tests

`npm test` covers the supervisor against `bridge/fixtures/fake-llama-server.mjs`, the pack detector, the embedder, the shared host and its
routes, the prompt layout and the memory store (with a fake embedder). No test starts a real model. The fake server reports `/props`, counts
`/tokenize` and refuses an over-long prompt with the real 400 body (`FAKE_LLAMA_CTX`, `FAKE_LLAMA_CHARS_PER_TOKEN`).
`bridge/prompt-budget.test.mjs` covers the trimming and `bridge/local-context.test.mjs` the supervisor's context, the fitted turn, the cloud
fallback and its notice.

### Live checks (need the game and a GPU)

1. With the dev folder set: choose Local, Apply; the Local AI row shows Warming up, then Ready; talk to a companion; the reply streams
   and is spoken.
2. First start only: the shader compile takes about a minute and shows no error notice.
3. FPS and 1% lows in four states: baseline; model loaded and idle; 20 scripted turns; model unloaded after ten minutes. Idle must cost
   nothing (the supervisor has no polling).
4. Free video memory with OmniVoice chosen: standard where it fits, lite where it does not, cloud text with one notice where neither does.
5. Remove the pack (or point the folder somewhere empty): choosing Local gives one notice and Convai or Mistral answers.
6. Forget on the Memory page: ask the character what it remembers afterwards.
7. Stop the bridge: no `llama-server` process is left.
