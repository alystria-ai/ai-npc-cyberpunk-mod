# Local AI

The fully local conversation option: the characters' replies are written by a small language model that runs on the player's own
graphics card. It needs no account and no internet connection. This page has two parts: what a player sees, and notes for developers.
The design and the measurements behind it are in `docs/LOCAL_OPTION_DESIGN.md` and `docs/LOCAL_MODEL_CHOICE.md`.

## For players

### What it is

Choose **Local** as the Conversation provider (Settings > Conversation provider) and the characters answer with an AI model that runs on your
computer. Replies are spoken by the local voices (Pocket or OmniVoice) and the characters keep a memory of your talks, stored on your
computer. Convai free tier gives better quality responses; Local is for playing without an account or without the internet.

The models are optional downloads, like the OmniVoice pack: one zip file each, on the mod's Hugging Face page (https://huggingface.co/alystria-ai/cyberpunk-convai-packs, a folder per version). There are two, and you can install neither, one or both:

| Pack | Model | Download | Best for |
|---|---|---|---|
| **Local AI standard** | Gemma 4 E4B | about 5.3 GB | Named characters and companions: it stays closest to what the character knows and invents the least |
| **Local AI lite** | Qwen3.5-2B | about 1.5 GB | Smaller graphics cards, or a game that already uses most of the video memory. Plainer replies; fine for ordinary NPCs |

Extract each download into your Cyberpunk 2077 folder (the same way as the OmniVoice pack; there are no parts to join), then pick **Local** in Settings > Conversation provider.
There is no status row (removed 2026-10-14). While the model is not ready, the Local AI model row's name carries a bracket, "(Warming up)", "(Not enough memory)" or "(Unavailable)", and its help starts with the loading sentence; when it is ready or not installed the row needs no words.

The first start after installing takes about a minute while the graphics card prepares the model (the row name says "(Warming up)"). After
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

### Choosing the model

Settings > Conversation provider has a **Local AI model** row, right under Mature content. It lists every installed chat model by its name,
**sorted by file size, from the smallest to the largest** (models of the same size by name); the sizes are in the help text. There is
no "Auto" entry: the row always shows one concrete model as selected. Only one model is ever loaded.

- **The default.** Until you choose a model (and for a value an older version saved as `auto`), the largest installed model that fits
  the free graphics memory is used: the largest model file that fits, so the standard model when it fits and the lite one otherwise. The
  row shows that model as selected, so you see which one is meant, and the next **Apply** stores its id (an older `auto` is replaced
  silently; nothing changes for you). The mod reads the free memory when it starts a model, so the model shown is the one that would
  load now. With **Mature content** on, the default is the largest uncensored model that fits (the optional Mature packs' models, one per pack, either alone or both:
  the good one if it is installed and fits, else the lite one; and your own models marked `"uncensored": true`), and the ordinary models are used when none of them fits. With Mature content off, the
  default never picks an uncensored model.
- **Turning Mature content on** selects, in the same pending changes as Local AI itself (waiting for Apply), the largest uncensored
  model that fits (the Mature standard model if it is installed and fits, else the Mature lite one), if one is installed, and says so ("Uncensored model"). With no uncensored model installed (or none that fits) it
  leaves the model alone. Turning Mature content off puts the earlier model back, as it does the other choices.
- **Choosing a model** uses exactly that model, whatever fits better and whatever Mature content says (an uncensored model with
  Mature content off simply runs without the Mature rules).
- **Fallback.** A chosen model that is missing, does not fit the free graphics memory or did not start is replaced by the largest
  model that fits (with Mature content on and an uncensored model available: the largest uncensored one that fits), with one notice
  that names the model used: "The Local AI model you chose is missing, does not fit in the free graphics memory or did not start, so
  Gemma-4-E4B was used instead." It is not repeated at the next start.
  **Mature content never falls back to a censored model** (when a Mature model is installed): the fallbacks stay among the installed Mature models, good
  first, then lite. When even the lite model does not fit the free graphics memory it is loaded anyway, with part of its layers on the CPU
  (`offload`: the server is started without `-ngl` and with `-fit on`, so llama-server keeps as many layers on the card as fit; slower, but
  uncensored; the log says so). Only with no Mature model installed at all do the ordinary models answer, as before (the setting works
  with any model; a pinned Mature id with no Mature model installed gets the usual "missing" notice).
- **A saved choice that names a model no longer in any pack** (a Mature model of an older pack such as `mature:qwen3.5-9b-...`, a removed
  standard model) is mapped without any notice: `mature:*` to `mature:good` if it fits, else `mature:lite`; any other id to the default.
  The bridge maps it when a model loads; the game also saves the mapped id (`manager.lua` `repairGoneLocalModel`, when the bridge's state
  file is read again, at most every 1.5 s, and on any Apply). A model the player added by hand (`custom:`) that is gone keeps its notice.
- **Leaving Local AI unloads the model.** When the conversation provider changes away from Local AI, the llama-server of the chat model is
  stopped and its graphics memory and RAM are freed (at the next idle boundary when Local AI was answering, at once when the choice is
  withdrawn before it was applied; `MistralProvider.localUnused`). Choosing Local AI again loads it. The small memory embedder and the voice
  models are not touched.
- Models you add yourself (see "Add your own model" below) are listed among the others, in size order, with "(custom)". They take part
  in the default choice and the fallback like any other model, by size and fit. A custom model that is too large for the graphics card
  stays in the row, marked "too large for this graphics card"; it is never chosen as the default or the fallback, and choosing it
  falls back like any model that does not fit.
- A change applies when Local AI is the chosen provider, at an idle moment: the old server is stopped (its graphics memory is freed)
  and the new model loads. It waits for a reply in flight and never restarts in the middle of one, and it does nothing when the
  loaded model already satisfies the new choice. While another provider answers nothing loads; the next start reads the choice.
- The small CPU embedder for memory search is not part of the choice and stays as it is.

If Local AI cannot answer one particular turn (for example the model went away mid-reply), that turn is answered by your cloud provider
(Mistral with a saved key) and you see "Local AI could not answer that one, so a cloud provider did." at most
once every ten minutes. With no cloud account saved you see "Local AI could not answer that. Try again in a moment." instead of silence.
Local AI stays the chosen provider either way.

### Add your own model

You can add chat models of your own to the **Local AI model** row. There is no screen for it: you copy the model file into a folder and
list it in a small text file. The model then appears in the row after the built-in ones, marked "(custom)", and you can pick it there.
Only one model is ever loaded, so nothing else changes.

**1. Find the Local AI folder.** In a normal install it is `red4ext\plugins\CyberpunkConvai\app\local-ai\` inside your Cyberpunk 2077
folder (the same folder the Local AI packs unpack into; it contains `manifest.standard.json` or `manifest.lite.json`). Make a folder
called `custom` inside it. Put your model file there. The mod never copies, moves or deletes your files.

**2. Write `manifest.custom.json`** next to the other manifests (a plain text file; a text editor is enough):

```json
{
  "version": 1,
  "models": [
    {
      "file": "custom/MyModel-Q4_K_M.gguf",
      "name": "My Model",
      "uncensored": false,
      "family": "llama",
      "contextSize": 8192,
      "chatTemplate": "chatml"
    }
  ]
}
```

| Key | Needed | Meaning |
|---|---|---|
| `file` | yes | Path of the `.gguf` file, relative to the Local AI folder, inside it (no drive letter, no `..`). |
| `name` | no | The name shown in the row, 1 to 60 characters. Default: the file name. |
| `uncensored` | no | `true` only if the model really has no content limits of its own. With **Mature content** on, the content rules read this flag (never the file name); the hard limits and the output screen still apply. Default `false`. |
| `auto` | no | Obsolete. Older versions used it to let the "Auto" entry pick the model. It is accepted without a message and ignored: every model takes part in the default choice by its size. You can delete it. |
| `family` | no | A short label such as `qwen` or `llama`. It is used for the Mature content rules; a model the mod does not know gets the restrained level. |
| `contextSize` | no | The context (in tokens, 2048 to 262144) the model starts with. A bigger context uses more graphics memory. Default: the same automatic choice as the built-in models (16,384 when it fits). |
| `chatTemplate` | no | The name of a built-in llama.cpp chat template (for example `chatml`, `llama3`, `gemma`), for a file that has no usable template of its own. Leave it out when the model has one. |

You can list up to 16 models. A wrong entry is skipped and the rest still work. Changes are picked up within a few seconds while the
game runs (the settings page shows the new list the next time it refreshes), and a model you pick loads the next time Local AI starts
or at the next idle moment.

**3. Choose it.** In Settings > Conversation provider, open **Local AI model** and pick "My Model (custom)", then **Apply**.

**What the mod checks.** When it looks at your manifest it checks, without loading anything:

- the file exists and is a GGUF file (it starts with the bytes `GGUF` and has a version llama.cpp reads);
- it is not an embedding model (those cannot chat). This is read from the file's architecture and pooling type;
- its size, from which the help text of the row tells you about how much graphics memory it needs ("needs about 5.2 GB of graphics memory");
- it can fit the card at all. A model that needs more than your graphics card's total memory is still listed, marked "too large for
  this graphics card", and the default choice and the fallback never pick it.

A model that fails a check is not offered. The row's help text names it ("Not usable: Embedder: an embedding model, not a chat model")
and the log says why in one line.

**Requirements for a model**

- A **GGUF** file of an architecture that the bundled llama.cpp (`llama-server`, Vulkan build) supports. The mod cannot check this
  in advance; a model it cannot load fails at the first start (see below).
- An **instruct or chat** model with a chat template. A base model (no "instruct" or "chat" in its name) answers badly or rambles.
  The template is read from the file; set `chatTemplate` only if the model has none.
- The **Q4_K_M** quantisation is the recommended size/quality trade. Smaller quants lose quality; bigger ones use more memory.
- A split model (`name-00001-of-00003.gguf`): list only the first part and keep all parts in the same folder.
- Do not use a model for an image (`mmproj`) or an embedding model.

**How much graphics memory a model needs.** About the file size plus 0.7 GB for a file under 3 GB, plus 1.2 GB from 3 GB up (room for the
conversation, which is kept in graphics memory too), on top of what the game and your voice use. Rough guide for Q4_K_M:

| Model size | File | Free graphics memory to plan for |
|---|---|---|
| 1B to 2B | about 1 to 1.5 GB | about 2 to 2.5 GB |
| 3B to 4B | about 2 to 2.7 GB | about 3 to 3.5 GB |
| 7B to 9B | about 4.4 to 5.5 GB | about 6 to 7 GB |
| 12B to 14B | about 7.5 to 9 GB | about 9 to 10.5 GB |

The table in "Which combination to pick" below shows what the voice and the game add. If your card is smaller than the model needs, it
is marked "too large" and cannot be used; if there is not enough memory free at the moment, the default is a smaller model and a model
you picked is replaced by the largest model that fits, with one notice naming it. A smaller `contextSize` (for example 8192) saves memory.

**Your models and the default choice.** Your models are treated like the built-in ones: the largest model that fits the free
graphics memory wins, and on equal sizes the built-in one comes first. With **Mature content** on, the uncensored models come first,
and a custom model counts as uncensored when its entry says `"uncensored": true`. A model you pick in the row is used whatever the
default would have chosen (as long as it fits). The older `"auto"` key has no effect any more.

**If a model will not start.** If the model's file is found but llama.cpp cannot load it (an unsupported architecture, a damaged file, not
enough memory once loaded), the mod shows "The Local AI model you chose is missing, does not fit in the free graphics memory or did not
start, so Gemma-4-E4B was used instead." once (it names the model that answers instead: the largest model that fits). The mod does not
try that model again until its file changes or you restart the game.

**If it does not show up.** Open the bridge log, `bridge.stderr.log`, in the `data` folder of the mod
(`red4ext\plugins\CyberpunkConvai\data\`), and look for lines starting with `[LocalAI] [custom models]`. Each problem is one line, for
example:

- `skipped "custom/x.bin": only .gguf files are accepted` - fix the entry in the manifest;
- `"My Model" is not usable: the file x.gguf was not found` - the path or the file name is wrong (Windows hides extensions: check
  that the file is not called `x.gguf.gguf` or `x.gguf.txt`);
- `"My Model" is too large for this graphics card` - pick a smaller model or quant;
- `manifest.custom.json is not valid JSON` - a comma or a quote is wrong; a free JSON checker finds it quickly.

Make sure the Local AI pack itself is installed (the **Local AI model** row only matters when Local is the Conversation provider) and
that the file is named `manifest.custom.json` (not `.txt`). An embedding model can only be spotted when its header says so; a file with
an unusual header may pass the check and then fail to start, which the notice above covers. Whether a model has a chat template is not
checked ahead of time.

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

Then set `conversationProvider` to `local` in Settings > Conversation provider (or in `settings.json`) and Apply. Nothing is copied into the
repository.

### The pack

`manifest.json` (version 1) in the pack folder names the files, relative to it (absolute paths and `..` are refused):
`server`, `standard: {file, name}`, `lite: {file, name}`, `embed: {file, dim, id}`. The two optional downloads each carry a fragment,
`manifest.standard.json` or `manifest.lite.json`, with the shared `server` and `embed` entries; the detector merges whatever it finds,
so either one alone works and a hand-deleted model only removes its own tier. Another model is only another manifest. Detection is in
`bridge/local-ai-pack.mjs` and is the same kind of check as `bridge/omni-pack.mjs`: it only stats files.

Packaging: `packaging/build-release.mjs --packages localai-standard` (or `localai-lite`) builds each download as ONE zip (no parts), and the release workflow
runs both as a matrix job (`localai`) that uploads each zip to the Hugging Face repository `alystria-ai/cyberpunk-convai-packs` (`docs/PACKAGING.md`). Every file is the unmodified upstream file, pinned by URL, revision and SHA-256 in the
`localAi` block of `packaging/release.config.json`: the `llama-server` Vulkan build b11560 (MIT; only `llama-server.exe` and its
DLLs are kept, no other command line tools), the Q8_0 granite embedding model (Apache-2.0), and one chat model: Gemma 4 E4B QAT q4_0
(Apache-2.0, 5.15 GB, shipped whole in a ZIP64 zip; `app/launcher/assemble-parts.mjs` only joins parts left by an earlier release) or Qwen3.5-2B Q4_K_M by
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
| `bridge/text-provider-host.mjs` | The host shared by Mistral and Local (see `docs/MISTRAL.md`). `localRoute` calls `server.ensure()` for a connection, no pacing, JSON-schema fact extraction, persona-prefix prewarm on an invitation. Background work never starts the server. |
| `bridge/memory-store.mjs` | The memory shared by the text providers. |

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

`bridge/prompt-budget.mjs` fits every Local request before it is sent (`budgetedChat`, wrapped around the route's `chat` in
`localRoute`). `buildMessages` leaves its arguments on the messages (a non-enumerable symbol property, never sent), so the
budget rebuilds the prompt with less in it instead of cutting a string.

- **The limit.** `n_ctx` from the server (`GET /props`, in the supervisor's handle as `contextSize`) minus a reply reserve (320 tokens) minus a safety
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
when a key is saved (`TextProviderHost#candidates`). The turn's reply is the cloud
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

`conversationProvider` is `convai | mistral | local` (a saved `groq` from before 2026-10-14 reads as `convai`). `MistralProvider` (`bridge/mistral-key.mjs`) keeps `preference` (the
setting), `requested` and `applied`; a switch happens only at an idle boundary. `local` is requested while it works; after
`noteLocalFailure(reason)` it is Mistral when a key exists, else Convai, until the setting is chosen again. The status file
`runtime/mistral-state.json` carries `localAi`: `ready | warming | not-installed | no-memory | failed`, and `localModels`:
`[{id, name, sizeMiB}]`, the installed chat models for the model row (names and sizes, never paths).

### Model choice (developers)

- `bridge/local-model-choice.mjs` (pure, no I/O): `listLocalModels({pack, matureModels})` joins the Local AI packs' two models
  (ids `standard`, `lite`) with the Mature pack's two (`mature:lite` and `mature:good`, stable ids whatever the file is called; an entry whose file is absent, a third entry or an unknown tier is left out, and a name
  that does not say "uncensored" gets "(uncensored)" in the name the loaded server reports, so `allowanceFor` in
  `bridge/mature-content.mjs` reads it as the full level). `chooseLocalModel({models, pin, matureOn, freeMiB, sizeOf})` applies the
  rules above (largest file that fits, headroom by tier: file + 1.2 GB standard, + 0.7 GB lite, and for a Mature model by its tier: `good` takes the standard headroom, `lite` the lite one (a custom model by size, standard
  headroom from 3,000 MiB); unknown free memory takes the smallest model of the group) and reports `fellBack: 'missing' | 'low-memory'`
  when a pin was replaced. `stillSatisfies` says whether the loaded model already meets a changed choice.
- `bridge/local-llm-server.mjs`: the `selection` option (`() => {pin, matureOn, matureModels, customModels}`) is read when a start begins, never per turn.
  A pin that cannot be used emits `model-fallback` once per start. `reselect()` is called by the bridge when the choice changes while Local
  AI is the provider; it reloads only when the loaded model no longer satisfies the choice, only with nothing in flight (`end()` re-checks,
  and a choice that changed during a start is checked 250 ms after it is ready), by `stop()` followed by `ensure()`. The older `tier`
  option still works and is strict (that tier or an error, no memory check). `server.modelId` is the loaded id; `status()` is unchanged.
- `bridge/convai-bridge.mjs`: `syncLocalModelChoice` runs on the settings poll (it reads `localModel` from `settings.json` and compares it
  with Mature content and the Mature pack's presence; it re-lists the installed models and republishes the status at most every 5 s). The
  fallback becomes the `local-model-fallback` notice (`MistralProvider.noteLocalModelFallback`, sent as `keyNotice` on the next reply),
  once per distinct pin and reason until the pin changes.
- Custom models (`bridge/custom-models.mjs`, tests `custom-models.test.mjs`, `custom-model-choice.test.mjs` and the custom block at the end
  of `local-llm-server.test.mjs`): `CustomModelScanner.scan({totalVramMiB})` reads `manifest.custom.json` (the Local AI folder, else the
  dev folder when only that has it, like the Mature marker), validates each entry strictly (relative path inside the folder, `.gguf`, name
  of 1 to 60 characters, boolean `uncensored` (`auto` is obsolete: accepted whatever its value and dropped), `family` label, integer `contextSize` 2048 to 262144, `chatTemplate` name; at most
  16) and logs every bad entry once as `[custom models] ...` (a repeat of the same line is not logged again; nothing throws). Per file it
  stats (every look) and reads the first 2 MiB only when the size or time changed: the GGUF magic and version (2 or 3), then the
  key/value pairs up to the tokenizer for `general.architecture`, `<arch>.pooling_type` and `<arch>.context_length`. Reasons published
  with the status as `localModelProblems` (`[{name, reason}]`, reason `missing | bad-gguf | embedding | unreadable`, no paths):
  a missing file, a file under 1 MiB, wrong magic or version or no architecture, an encoder architecture (`bert`, `nomic-bert`,
  `jina-bert-*`, `modern-bert`, `neo-bert`, `eurobert`, `t5encoder`, `clip`, ...) or any `pooling_type` other than 0, and a read error. Not
  checked (documented limits): whether llama.cpp supports the architecture, whether the model has a chat template, and an embedding
  model whose header gives neither away. A model whose file plus the tier headroom is more than the card's total memory is listed with
  `tooLarge` (the total comes from `llama-server --list-devices` after the first start, else from one `nvidia-smi` call at most once a
  minute while the manifest lists models); `chooseLocalModel` never picks it, and a pin on it falls back with `low-memory`. The published
  list entry of a custom model also carries `custom: true` and `needMiB`, and `mcm.lua` adds the "(custom)" label and the memory line to the
  help. Ids are `custom:<file name>`. A custom model takes part in the default choice and the fallback like any other model (`autoEligible`
  and the `auto` flag are gone); with Mature content on, the uncensored models are tried first. The server starts a custom model with its `contextSize` (else the ladder) and
  `--chat-template`; the loaded server's `modelHints` (`{uncensored, family}`) reach `allowanceFor(name, hints)`, where the flag decides
  in both directions and the name is not read for it. A custom model that fails to start (or dies while warming up) is marked broken
  for that file size until `reset()` or a restart, a `model-fallback` event with reason `start-failed` is emitted once (the same
  `local-model-fallback` notice, which names the model used), and the start is repeated at once with the default choice. The fake server fixture refuses a model with
  `FAKE_LLAMA_EXIT_FOR_MODEL=<text in the path>`.
- The picker (2026-10-13, "no Auto"): `describeLocalModels` publishes the installed models sorted by file size, smallest first, equal sizes
  by name (`sortLocalModels`; `manager.lua` sorts again defensively). `defaultModelIds` (pure, no I/O) returns `{default, mature}`: the
  model the default rule would load now (what a saved `auto`, or a model that is gone, gets) and the largest uncensored model that fits
  (what turning Mature content on selects; null when none is installed or none fits). The bridge publishes them in `mistral-state.json`
  as `localModelDefault` and `localModelMatureDefault`, from the free memory the last start saw before it loaded its model
  (`LocalLlmServer.lastFreeMiB`), else the card's total (the same single `nvidia-smi` call as for custom models, at most once a minute and
  only while more than one model is installed); they are part of the list key, so a change republishes the status. No new polling.
  `chooseLocalModel` keeps `auto` as the internal "no choice" value (`AUTO_MODEL`, `normalisePin`): a legacy `localModel: "auto"` loads the
  default with no notice. The `model-fallback` event carries `model` (the name used); `MistralProvider.noteLocalModelFallback(model)` keeps
  it and the reply carries `keyNoticeModel` beside `keyNotice: 'local-model-fallback'`.
- Lua: `localModel` (an id, or `auto` for nothing chosen; `manager.lua` validates ids and `localModelChoices()` has no Auto entry).
  `mcm.lua` builds the row from `manager.localModelChoices()`, shows `manager.localModelDefaultId()` as selected for `auto` or a saved
  model that is gone (the saved value stays until Apply), and maps the selected position back to an id. `applySettings` replaces a saved or
  staged `auto` by the default model's id on any Apply (silently; with no model installed it stays `auto`). `matureTurnedOn` stages
  `manager.localModelMatureId()` (record `{before, set = <that id>}`), or nothing; a legacy Mature record with `set = 'auto'` is matched
  against the default model's position when turning Mature off. With no model installed the row has one placeholder, "No model installed".

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

#### Part of the main mod; the pack only adds models

The setting is part of the main mod. It is visible and usable without any other download, off by default, Local AI only, and turning it on
shows no notice (the user removed the 18+ notice on 2026-10-14; the help text says it is for adults, 18+). With the stock Local AI models it mostly changes language, violence and tone: those models are trained to refuse most
sexual content, so the full effect needs the uncensored models of the optional Mature packs (Mature lite and Mature standard, one model each, either alone). The packs no longer gate anything (it did until
2026-10-14). It changes the setting's help text, and since 2026-10-13 its models are loaded: they appear in the Local AI model row, and
with Mature content on the default choice and the fallback prefer the largest one that fits (see "Choosing the model"):
- Detection: `bridge/mature-pack.mjs` (`detectMaturePack`) looks for the markers `manifest.mature-lite.json` and `manifest.mature-standard.json` (one per pack, so either pack alone is detected and the two never overwrite each other; the earlier combined `manifest.mature.json` is still read) in the Local AI folder, beside
  `manifest.standard.json` and `manifest.lite.json` (same root: `<project>/local-ai`, or `CYBERPUNK_CONVAI_LOCAL_AI`, which the packaged
  service points at `app/local-ai`). A marker is `{version: 1, pack: 'mature', lite: {file, name, family}}` or `{... good: {...}}` (the combined one names both; at most two models come out, like the Local AI
  packs' two tiers, and the first marker that names a tier wins; since 2026-10-14 the old `models` list is no longer read, so a marker with only that is "installed" with no model to offer); a valid marker is
  "installed" (the listed files are reported as `present`; a model whose file is absent is not offered or loaded, and a model left in parts by an earlier release is
  joined by the launcher before the bridge starts); a missing,
  malformed or foreign marker, or a model path that leaves the folder, is not trusted. `detectLocalAiPack` never reads this marker; the model
  choice (`bridge/local-model-choice.mjs`) joins the marker's models that are present on disk with the pack's own two.
- When: once at start and then from the settings poll at most every 5 s (one `stat` and a tiny read; never per frame, never per turn).
  `MatureContent` has two inputs, `requested` (the settings file) and `pack` (the scan); `enabled` is `requested`. Finding or losing the
  pack changes only the pack flag (`setPack` says whether it changed), never the layer, the guard or the prepared replies.
- Lua: the bridge publishes `maturePack` in `runtime/mistral-state.json` (`MistralControl.status`); `manager.mistral().maturePack` reads it.
  `mod/mcm.lua` always builds the "Mature content" row. Its help ends with three plain sentences: that a safety check on messages and
  replies refuses anything romantic or sexual involving minors on every model, and either "The Mature pack (uncensored models) is
  installed." or "... is not installed. It is an optional download on the Hugging Face page of this mod.", plus "Choosing a cloud provider turns it off."
  (the old "Not using Local AI right now: no effect yet." line is gone, see below). `manager.applySettings` accepts `matureContent` whatever the pack says, and the snapshot reports the file's value.
- Distribution: the packs (one uncensored GGUF each) are distributed ONLY as optional files on this project's Hugging Face repository
  (`alystria-ai/cyberpunk-convai-packs`, `0.N/CyberpunkConvai-Mature-Lite-0.N.zip` and `...-Mature-Standard-0.N.zip`, each one zip, no parts), never on Nexus Mods and not on the
  GitHub release. `.github/workflows/release.yml` builds and uploads them only in its opt-in `mature` job (a matrix of `lite` and `standard`; the `mature` input is off by default and a tag push never runs it), and `packaging/build-release.mjs` builds each only with `--packages mature-lite` or `mature-standard`, never in the default set. Nothing of it is in the
  Runtime package or `release-plan.json`; its marker, README, release notes and models are not read by the runtime builder (tested). The
  main mod's own files (the bridge modules `mature-content`, `mature-guard`, `mature-guard-terms` and `mature-pack`, the Lua and locale
  strings) are in the Runtime and Scripts packages.
- Packaging of the pack: `maturePack` in `packaging/release.config.json` and `maturePackage` in `packaging/build-release.mjs`. It writes the
  model files into `app/local-ai/models/`, the marker, and `app/local-ai/mature/` (`README.md` from `packaging/MATURE_PACK_README.md`,
  `licenses/Apache-2.0.txt`, `THIRD-PARTY-NOTICES.txt`, `mature-pack.json`). The config has exactly two models under `maturePack.tiers` (`lite`: Qwen3.5-4B-Uncensored-HauhauCS-Aggressive Q4_K_M, 2.71 GB; `good`:
  Gemma4-E4B-MiniFantasy-V1 Q4_K_M, 5.34 GB), pinned by repository, revision, size and SHA-256 from the Hugging Face file listing (2026-10-14;
  `remote` is the file's path inside the repository, when it is in a folder). The picks are from the third round (2026-10-14, `docs/MATURE_SAMPLES_V3_2026-10-14.md`:
  the lite one changed from Qwen3.5-4B-MiniFantasy to HauhauCS because it is the crudest light model with the always-on prompt); both were downloaded, checked against
  the SHA-256 and run with `scripts/Eval-MatureSamples.mjs` (the candidate research is in `docs/MATURE_MODELS_V2_2026-10-14.md`). The build refuses to run unless both are pinned,
  and it refuses a non-Apache-2.0 model or a third entry.
- Texts: `packaging/MATURE_PACK_README.md` (ships in the pack) and `packaging/MATURE_PACK_RELEASE_NOTES.md` (the text for the GitHub
  release: what it adds, that the setting is part of the main mod, that the hard limits stay on every model, that it needs the main mod and
  a Local AI pack, the install steps; it replaced the Nexus page text and its adult-flag and tag instructions).

#### The setting

Settings > Conversation provider, right under the provider row: "Mature content" (key `matureContent`, off by default, an ordinary Apply setting; the
bridge reads it from `runtime/settings.json` when the file changes, never per turn, and drops prepared replies when it flips). It exists
only for this provider: the layer is built in `bridge/mature-content.mjs`, and `MATURE_PROVIDERS` is `{local: true, mistral: false,
convai: false}`. The host asks for the layer per route (`TextProviderHost#matureLevel`), so a local turn that falls back to
the player's cloud provider is answered without it. The settings page keeps it off while a cloud provider (Convai free tier, Convai API key, Mistral)
is chosen: choosing one turns Mature content off in the drafts and puts back what turning it on changed, and load and Apply force it off (2026-10-14;
docs/MANAGER_UI.md, "Mature content and cloud providers exclude each other").
Turning it on shows no notice, neither on Apply nor in the status line (removed 2026-10-14); the help text (all 15 locales) says it is for adults (18+),
that it applies to Local AI only and that some things are never allowed.

What it adds: one block of about 430 tokens (o200k count) at the END of the system head (`systemHead({mature})`), after the output rules and before
the format notes. That is the stable early text, so llama-server's prefix cache is kept (the layer is the same every turn for a given
model), the prewarm text is the same head, and `bridge/prompt-budget.mjs` never touches the head (it trims the world, memory, history,
notes and example lines). With the setting off the argument is absent and the prompt is byte for byte what it was (tested). On (tone set by
the user on 2026-10-13: "it's adult after all"): characters speak plainly and graphically about sex, violence, gore and drugs when the talk
goes there (the real words, no euphemism, no fading to black, no disclaimers), swear freely, and are forward: they flirt openly, start things
and lean in instead of teasing and backing off, between consenting adults. Personality, voice and orientation shape HOW a character is
forward, not whether; the relationship facts already in the world block (the same save-confirmed relationship state
`bridge/relationship-routing.mjs` uses) set the tone (partner: intimate; friend: warm and playful; stranger or rival: bolder, rougher or
guarded) and no longer forbid flirting or sexual talk. The first version of the layer (the "you may refuse, tease or deflect" and "unless the
facts say you are together you are not V's lover" wording) is gone. The tone line also overrides the output rules' "stay vague, a question
back" for an adult moment, and the closing line of the user message (the last thing the model reads) gets one more sentence while the
setting is on (`matureClosing`: stay in it, answer directly and explicitly, no dodging, no question back; the suggestive level keeps "cut away
at the act"), because measured on the uncensored models (`docs/MATURE_SAMPLES_2026-10-13.md`) the persona and the output rules outweigh a layer
in the system message alone. The layer is about 430 tokens (the closing sentence adds about 45 to each turn).

#### Pushed harder (2026-10-14: "too tame")

The 2026-10-13 samples (`docs/MATURE_SAMPLES_2026-10-13.md`) had 1 graphic reply in 12, and Panam drifted to driving on every model although the save
says she is V's partner. What held the models back was in the prompt, not only in the models, and each piece is now answered while the setting is on
(off, every one of these is the old text, byte for byte; `bridge/mature-content.test.mjs` keeps the old rule texts verbatim):
- Output rule 3 ("one question at most", three sentences) gets "Four in an adult moment." and rule 6 no longer lists "a question back" as the way to
  stay vague: "(a shrug or a joke), but never about flirting, desire or sex" (`RULES` in `bridge/mistral-prompt.mjs`, new `mature` argument).
- The layer (full level) names the words ("cock, pussy, ass, fuck, cum"), says what to describe (what you do to V, what you want, how it feels), says a
  guarded profile is how the character flirts and never a reason to dodge, says V's partner is the most forward, and keeps an adult moment on the two of
  them: no quest, gear, car or road talk and no stand-ins for sex (the Panam driving drift). The HARD LIMITS line and the adults-only line are unchanged,
  word for word, and the guard is unchanged.
- The relationship text of a romantic partner (`bridge/romance-context.mjs`: warmth "at most a few words", "do not narrate actions or kisses; affection is
  not consent to a new intimate act", practical turns first) is swapped by `matureWorld` for a shorter text that makes the partner the one who leans in. The
  text of casual encounters, the ordinary text and the group text are not touched.
- The closing line names what to say: "answer head-on in plain, explicit words: what you do, what you want. No dodging, no joke, no question back."
- Cost: measured with tiktoken o200k over the 12 cells of the brief sample set (3 prompts x Judy, Panam, Evelyn, Johnny), a Mature turn was 4,319 tokens
  before and 4,360 after (+41, +0.9%); a partner turn is about 15 tokens smaller than before (the relationship swap saves about 65, the layer, closing sentence and rules add about 50). Off: 3,880 before and after, byte for byte (the 12 requests compared with `cmp`).

#### Crude on every turn (2026-10-14, round 3: "more crude the better")

The register no longer waits for a sexual line from V. While Mature content is on (Local AI, level full), the layer says the characters have free rein on every
turn, whatever V says: they swear freely and crudely, make dirty jokes and sexual remarks, flirt, tease and start things themselves, unprompted, in their own
character and voice (the persona shapes how, not whether), and are graphic in plain words when sex comes up. The closing line of the user message says the same in
one sentence ("on every turn, whatever V says, talk like a crude, dirty-minded adult in your own voice: swear, make a filthy remark, flirt, start something. When it
is sexual, be graphic and explicit. No dodging, no question back."); the suggestive level keeps "Sex stays suggestive, cut away at the act." The partner text of
`matureWorld` leans in "on any turn" and answers a practical question first "still in your own crude voice". The adults-only line and the HARD LIMITS line are the
same words as before, the guard is unchanged, and with the setting off the prompt is byte for byte the old one (12 requests of the old brief set compared with `cmp`;
the average prompt is 3,880 tokens before and after). Cost: a Mature turn is 4,360 tokens with round 2 and 4,411 with this round (+51, +1.2%) by tiktoken o200k.
Measured on five models (`docs/MATURE_SAMPLES_V3_2026-10-14.md`), the effect depends on the model: Gemma-4-E4B-MiniFantasy goes from a crude or explicit word in 8 of 36
neutral replies to 12 and in 5 of 36 adult-prompt replies to 20; the HauhauCS Qwen3.5-4B from 3 to 15 neutral and 10 to 21 adult. Ministral-3-8B-Nymphaea follows its
persona and barely moves. The light pick of the pack changed to HauhauCS for that reason.

#### Word palette (2026-10-14, round 4: "use more of the game's own slang")

One more line in the layer (`PALETTE` in `bridge/mature-content.mjs`, between the speech paragraph and the romance line): "Use words like these freely and often, in your
own voice, and any others you like (a palette, not a checklist: vary it, never the same word at the end of every reply, only where it sounds natural)", then 20 plain
crude and sexual words (fuck, shit, cunt, cock, pussy, tits, ass, cum, hard, wet, horny, suck, ride, bend over ...) and 20 words of Night City slang taken from the game's
own data (choom, gonk, preem, nova, delta, flatline, chrome, chromed-up, wetware, meat, eddies, joytoy, doll, dollhouse, BD, braindance, jack in, plug in, corpo,
ripperdoc; "joytoy" is the game's word for a sex worker, though the repo's lore files do not quote it). The suggestive level gets the swears and the slang, none of the
anatomical or act words. It is in the layer only, so it is on only while Mature is on and for the Local AI only; the closing sentence, the adults-only line, the HARD
LIMITS and the guard are unchanged, and with the setting off the prompt is byte for byte the old one (48 requests of the brief set compared with `cmp`, plus the
unit tests). Cost: the layer grows from 491 to 641 tokens with the Gemma tokenizer (488 to 636 with the Qwen3.5 one), about 150 tokens or 3% of a 4,400-token prompt.
Measured on the two picks (`docs/MATURE_SAMPLES_V4_2026-10-14.md`): a crude or explicit word in 32 of 36 adult replies and 22 of 36 neutral ones on Gemma (18 and 6 before),
27 and 23 on HauhauCS (18 and 15). A first palette that listed "choom, gonk, doll" first made Gemma end 15 of 72 replies with ", choom" as a sign-off; the shipped one puts
the vocative words last and tells the model to vary, which halves that (7 of 72). Read the samples: the small models sometimes misuse a slang word.

#### Models of the Mature packs (2026-10-14)

Two models, one per pack (Mature lite and Mature standard, each its own zip and marker; the normal Local AI packs likewise have `standard` and `lite`): `lite` and `good` (marker, ids `mature:lite` / `mature:good`, picker sorted small to large, the good one
preselected when it fits). The research and the picks are in `docs/MATURE_MODELS_V2_2026-10-14.md`. The old four-model test set (three Qwen3.5
"Uncensored HauhauCS Aggressive" sizes and the Gemma 4 heretic) is dropped except the HauhauCS 4B: community data says those remove refusals but add no erotic
skill, yet with the always-on crude prompt (round 3, `docs/MATURE_SAMPLES_V3_2026-10-14.md`) the 4B was the crudest light model measured, so it is the lite one.
Good: Gemma-4-E4B-MiniFantasy (the crudest strong-slot model measured; Ministral-3-8B-Nymphaea was not).
A one-time log line per bridge session says what the prompt got: `[MatureContent] layer applied (level full, model <name>)`, or
`layer NOT applied (provider <name> never gets it)` when the setting is on and a cloud provider answers. No words of a turn are ever logged.
The age guard (2026-10-14), before the hard limits: "You and V are adults, 18 or older, always ... do not play, pretend or imagine yourself or
V as a child, a teen or a student, or as younger in any way ... If V asks, refuse in one short line, in character." Hard limits, last in
the layer, for every model: nothing sexual with anyone under 18 or who seems under 18; nothing without consent or glorifying sexual
violence; no bestiality or incest; nothing sexual about real people; no real-world instructions for weapons, explosives or drug synthesis;
no hateful content against real protected groups.

Per model: `MODEL_ALLOWANCE` keys the allowance by model family, read from the loaded model's name (`server.status().model`: the pack
manifest's name or the file name). Levels: `full`, or `suggestive` (forward and hot as well, but "give no explicit description of the act itself: cut away there"). Gemma 4
and Qwen3.5 are Apache-2.0 (full); Gemma 1 to 3n are under the Gemma Prohibited Use Policy, which bars "sexually explicit content,
including content created for the purposes of pornography or sexual gratification" (suggestive); an unknown model is suggestive; the
uncensored candidates (`Qwen3.5-*-Uncensored-HauhauCS-*`, `gemma-4-E4B-it-ultra-uncensored-heretic`, any name with uncensored,
abliterated or heretic) are full and flagged `uncensored`.

#### The hard-limit guard

An uncensored model has no limits of its own and ignores the one in the prompt: in the 2026-10-13 test (`docs/MATURE_MODELS_RESEARCH.md`
on main) Mature Qwen3.5-4B went along with a romance-with-a-minor prompt 5 of 5 times and Mature Gemma E4B 3 to 4 of 5, with the limit
written in the prompt. So the limit is enforced in the bridge, on the text, by `bridge/mature-guard.mjs`. It runs for a turn on Local AI
when the setting is on (any model, stock models too) or when the model that answers is an uncensored one (the Mature pack's, or one the
player flagged uncensored) even with the setting off, and never otherwise. Add-on speakers (Skippy, Delamain) get the guard on the same
terms, but only the guard: the screens and the adults-only and hard-limit lines, never the crude persona layer (`guardOnly` in
`TextProviderHost`, `guardLayer()` in `bridge/mature-content.mjs`). With a stock model and the setting off nothing changes, byte for byte.
- Input screen (`MatureGuard.screenInput`, called by `TextProviderHost` before any model request, right after recall). V's message is
  read for a minor cue together with romantic or sexual intent in the same message: an age under 18 ("I'm fifteen", "16f", "my 14th
  birthday", "born in 2011", "she's 12", "a 13 year old"), a word for a child or teen, school words (grades, "high school", a uniform,
  "sweet sixteen"), a pretence or request to be or play younger ("pretend you're 15", "make yourself younger", "regress to 12", "ageplay"),
  with kissing, flirting, dating, cuddling, bed, undressing or sex. A hit skips the model entirely and the character answers with a short
  line of her own (`MatureGuard.refusalLine(profileKey)`: per-character pools for 14 characters, a generic pool for the rest, never the
  same line twice in a row, no minor or romantic word in any of them: tested). Nothing is stored: not V's message, not the refusal. A
  request to be or play younger is refused even without intent. The log line is "Mature guard: refused a message (input, n so far)": counters
  only, never the text.
- A window of earlier turns (`WINDOW`): the flags of V's last 10 messages (not the text; the refused ones too) and of the character's stored
  history, so a cue in one message and the romance in a later one, or the intent first and the cue next, still hits. A directed cue (V or
  the character is the minor) stays for 10 turns, a general one (a kid, a school) for 3 turns with sexual intent or romance aimed at a third
  person, and intent in the last 3 turns with a directed cue next.
- Output screen (`screenReply`, `flagsReply`): the first sentence before it is voiced (`feed.reject`) and the whole reply before it is
  stored. The same rule plus the window; a reply in which the character says she is under 18 is dropped too. A hit drops the reply, answers
  with the refusal, voices nothing of the dropped text and records nothing in the history, the memory or the summaries
  (`outcome.guarded`). Log: "Mature guard: refused a reply (output, n so far)".
- Reading the text (`normalize`): Unicode compatibility forms (full-width digits) and accents folded, invisible characters removed, spaced or
  dotted letters ("k i s s", "u.n.d.e.r.a.g.e") joined, look-alike Cyrillic and Greek letters inside a Latin word put back, digits and
  symbols inside a word read as letters ("s1xteen") and a symbol for a letter ("sch*olgirl") read as each vowel. English is written in the
  module; the 15 interface languages are in `bridge/mature-guard-terms.mjs` (per language: words for a person under 18, units for years,
  numbers 1 to 17 as words, school words, role-play markers, pronouns, sexual and romantic words, fixed expressions that carry a listed word
  without the meaning). The lists were drafted from a written spec by a small model and then curated by hand and against English: any term
  that is an everyday English word once accents are folded was removed or turned into a phrase (`bridge/mature-guard.test.mjs` fails on
  such a term), because the terms of all languages are searched together.
- Cost: regular expressions and string work only, compiled once (the word lists are tries); a fresh message of typical length takes about
  0.1 to 0.2 ms and one at the 1,200-character cap well under 3 ms (tested), the last 64 results are cached, there is no I/O, no model call and
  nothing per frame. It is deliberately over-strict: a false refusal costs one line of dialogue, a miss is the thing the guard exists to prevent.
- Known limits: it is a lexical screen. It does not judge non-consent or incest (only the prompt does), a minor in a language outside the 16,
  or in words the lists lack (slang, new euphemisms), can get past it, and the non-English lists are approximate (drafted by a small model,
  not reviewed by native speakers; Japanese, Korean and Chinese are matched without word boundaries). A child word and a romantic word in one
  message with no link between them ("my kid is in school and I'm going on a date tonight") is refused on purpose (the stress set in
  `bridge/mature-guard.fixtures.mjs` keeps the list of such messages explicit).

#### The guard against real models (2026-10-14)

`scripts/Eval-MatureGuard.mjs` starts a llama-server with a Mature model and sends the 180 adversarial and 169 benign scenarios of
`bridge/mature-guard.fixtures.mjs` through the bridge's own path (the prompt with the Mature layer, `TextProviderHost`, the local route, the
input screen, the output screen). It records only outcomes, never text: the model's reply is judged in memory (does it still contain
romantic or sexual words?) and dropped. Models: the Q4_K_M files of the 2026-10-13 test (`E:\CyberpunkConvai-offload\work\local-llm\mature\`, size and SHA-256
checked against `manifest.json`), 8,192-token context, `--reasoning off`.

| Model | Adversarial, the game's path (input + output) | Adversarial, input screen bypassed (output screen alone) | Benign |
|---|---|---|---|
| Mature Gemma E4B (heretic) | 180 of 180 refused at input, 0 got through | 66 dropped by the output screen, 112 the model deflected on its own, 2 got through | 126 of 169 run (the server went away after that): 125 passed, 1 reply dropped by the output screen |
| Mature Qwen3.5-4B (HauhauCS) | 180 of 180 refused at input, 0 got through | 106 dropped, 72 deflected, 2 got through | 55 of 169 run (the server went away after that): 54 passed, 1 reply dropped |
| Mature Qwen3.5-9B (HauhauCS) | not run yet (GPU runs paused for an in-game test session) | not run yet (GPU runs paused for an in-game test session) | not run yet (GPU runs paused for an in-game test session) |

On the game's path nothing got through: the input screen refused every payload before a model was asked, so the models never saw them. With
the input screen bypassed, the output screen alone drops the models' romantic replies in most cases; the 2 that got through each were
a reply that was romantic while V's message carried the cue in a form the window did not count as aimed at the character (a Polish "I'm 14"
and a leetspeak "teenager"). Both were fixed after the run (Polish and Czech "I have / you have" verbs now make an age direct, and a reply
to a message that named a minor is dropped if it has any romance in it: `reply-to-cue`); this was not re-run on a model.

False positives on the benign scenarios, measured without a model: 0 of 169 turns refused by the input screen (adult romance, minors
mentioned without romance, numbers that are not ages, Night City swearing, 15 languages; 102 of them written by a separate small model and never
tuned against). On a stress set of 47 harmless messages that put a child word beside a romantic word, 15 are refused on purpose
(`STRESS_REFUSED`). On the character files and the UI strings (213,689 sentences), the reply screen dropped 21 sentences, all statements of
the rule itself (the Mature help text, "children" next to "romanticizing" in research notes). With a model, one benign reply was dropped by the
output screen in each run (`b-nervous` on Gemma, `minor-hate-kids` on Qwen 4B).

Provider policies (read 2026-10-13; the pages were summarised by a small model, so re-read them before the release):
- Mistral, Usage Policy (legal.mistral.ai/terms/usage-policy, effective June 11, 2026): no sentence permits or bans adult sexual
  content as such. It bars "Content that enables or exploits individuals, including through human trafficking or sexual services." and
  intimate images "without the explicit consent of all individuals involved." Its Commercial Terms add no content line. `safe_prompt`:
  "Whether to inject a safety prompt before all conversations.", default `false`. Verdict: ambiguous, so Mistral stays off.
- Groq (Acceptable Use and Responsible AI Policy, read 2026-10-13): ambiguous, so it stayed off; Groq was removed as a provider on 2026-10-14.
- Convai: never (a hosted service; the player's own key changes nothing).

Nexus Mods (help.nexusmods.com, read 2026-10-13): the Adult Content Guidelines (updated May 12, 2026) define adult content as
"content (mods, collections, videos, images, and text) that is considered unsuitable for minors", list Swearing or Profanity and
Sexualised content, and say "It is the responsibility of the uploader to tag and/or classify their files appropriately." The File
Submission Guidelines (updated September 29, 2026) say "Generative AI usage in mods or mod pages must have specific tags applied". No
rule speaks to an optional, off-by-default setting that lets an AI write adult text. Decision (the user, 2026-10-14): the setting is part of
the main mod, off by default, with the guard and the adults-only help text; the uncensored models, the part that makes adult content likely, are
distributed only on the project's Hugging Face page (first decided as GitHub release only, moved on 2026-10-16), never on Nexus. Open for the user: whether the main Nexus page should now also be
classified for Swearing or Profanity because the setting is in it (the guidelines leave this to the uploader).

Tests: `bridge/mature-guard.test.mjs` (the guard: 180 adversarial and 169 benign scenarios in `bridge/mature-guard.fixtures.mjs`, the
stress set, normalisation, the window, replies, the refusal lines, the counters, the speed, the word lists against everyday English words),
`bridge/mature-content.test.mjs` (the setting, the provider gate, the pack not gating, the table, the layer's size and hard limits, off
byte-identical, additive and prefix-stable, the budget never cutting it, which route gets it, the host refusing and storing nothing),
`bridge/mature-pack.test.mjs` (the marker detector), `bridge/manager.test.mjs` (the Lua side: the row and setting without the pack, the help
text for each state, no notice on turning it on) and `packaging/release.test.mjs` (the package definition, out of the default set, the workflow and the
Runtime package, the builder refusing placeholders, the pack texts, GitHub-only wording). `scripts/Eval-MatureGuard.mjs` runs the fixtures
through a real model (see "The guard against real models"). Prompts only; no model is asked for adult text by the unit tests.

### Tests

`npm test` covers the supervisor against `bridge/fixtures/fake-llama-server.mjs`, the pack detector, the embedder, the shared host and its
routes, the prompt layout and the memory store (with a fake embedder). No test starts a real model. The fake server reports `/props`, counts
`/tokenize` and refuses an over-long prompt with the real 400 body (`FAKE_LLAMA_CTX`, `FAKE_LLAMA_CHARS_PER_TOKEN`).
`bridge/prompt-budget.test.mjs` covers the trimming and `bridge/local-context.test.mjs` the supervisor's context, the fitted turn, the cloud
fallback and its notice. `bridge/local-model-choice.test.mjs` covers the model choice (with and without the Mature pack, Mature content on
and off, a pin, a missing pin, the low-memory fallback) and `bridge/local-llm-server.test.mjs` the loaded model, the fallback event and the
idle reload.

### Live checks (need the game and a GPU)

1. With the dev folder set: choose Local, Apply; the Local AI model row name shows (Warming up), then no bracket; talk to a companion; the reply streams
   and is spoken.
2. First start only: the shader compile takes about a minute and shows no error notice.
3. FPS and 1% lows in four states: baseline; model loaded and idle; 20 scripted turns; model unloaded after ten minutes. Idle must cost
   nothing (the supervisor has no polling).
4. Free video memory with OmniVoice chosen: standard where it fits, lite where it does not, cloud text with one notice where neither does.
5. Remove the pack (or point the folder somewhere empty): choosing Local gives one notice and Convai or Mistral answers.
6. Forget on the Memory page: ask the character what it remembers afterwards.
7. Stop the bridge: no `llama-server` process is left.
