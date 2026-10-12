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

### Tests

`npm test` covers the supervisor against `bridge/fixtures/fake-llama-server.mjs`, the pack detector, the embedder, the shared host and its
routes, the prompt layout and the memory store (with a fake embedder). No test starts a real model.

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
