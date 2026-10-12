# Fully local conversation option: design (2026-10-12)

Design and research only. Nothing here is in the mod yet. This is player option 2 from TODO.md, "Requested 2026-10-12": an
on-device LLM, speech-to-text, TTS, embedding model and vector memory, meant to rival Convai plus our local voice. FPS is the top
priority: no per-frame main-thread work, and no sustained GPU or CPU load while nobody is talking.

Related: `docs/MISTRAL.md` (the text-provider route this option copies), `docs/LOCAL_STT.md` (speech recognition, already built),
`docs/LOCAL_VOICES.md` (Pocket and OmniVoice), `docs/PACKAGING.md` (packages and the Omni pack).

## Recommendation in one table

| Part | Choice | Why |
|---|---|---|
| Runtime | **llama.cpp `llama-server`, Vulkan build** (b11560), a child process of the bridge on loopback, OpenAI-compatible streaming | One small binary set (32 MB zip, 88 MB unpacked, CPU backends included). Works on NVIDIA, AMD and Intel. Supports prompt caching, a RAM prompt cache across characters, and slot save/restore. The bridge's `streamChat` already speaks its protocol. |
| Where the LLM runs | **On the discrete GPU, fully offloaded, only in short bursts** | Measured: the GPU is 40-100x faster than this CPU for these prompts. CPU-only is not usable (warm replies took 11-26 s). Between replies the GPU does no LLM work; only the weights stay in VRAM. |
| LLM, standard tier | **Qwen3.5-4B Q4_K_M** (2.74 GB, Apache-2.0, 201 languages, thinking off) | Best mix of speed, VRAM (about 3.0 GB) and quality in the measured set. Warm reply 0.8-1.7 s end to end. |
| LLM, quality challenger | **Gemma 4 E4B QAT q4_0** (5.15 GB, Apache-2.0) | Replies were the most grounded (fewest invented facts) in a small sample, at the same VRAM. It needs twice the disk space and ran a little slower. Decide between it and Qwen3.5-4B in build step 1. |
| LLM, lite tier | **Qwen3.5-2B Q4_K_M** (1.28 GB, about 1.45 GB VRAM) | For 8 GB cards or a game that already fills VRAM. Fastest, but plainer and more confused. Good enough for ordinary NPCs. |
| Embeddings | **IBM granite-embedding-107m-multilingual, Q8_0 GGUF** (121 MB, Apache-2.0, 384 dimensions, 12 languages), served by a second `llama-server` on the **CPU with 1 thread** | 14 ms per query on one throttled core. Same retrieval hits as EmbeddingGemma on the test set, at a ninth of the cost. No new runtime. |
| Vector store | **Flat in-memory index** (Float32Array) in the bridge, saved as a small file per player | Memories per player number in the hundreds to low thousands. A brute-force scan of 5,000 x 384 took 7 ms in plain JS, and 500 entries take under 1 ms. No native module and nothing to compile. |
| STT | **Moonshine Tiny English, unchanged** (`docs/LOCAL_STT.md`) | Already measured and built: WER 11.4%, 3 ms to 0.45 s after speech ends, CPU, 1 thread. Multilingual voice input is an optional later pack. |
| TTS | **Pocket by default** (CPU, 0 VRAM); OmniVoice only when VRAM allows | The LLM and Omni would both be on the GPU. On a 12 GB card the game, the LLM and Omni together do not fit (see VRAM budget). |

Expected turn time on this laptop with the game closed, on the warm GPU path: about 1.2-2.3 s from the end of the player's
speech to first audio. That is speech recognition (3-450 ms), an embedding (14 ms), the full reply (0.8-1.7 s median) and Pocket's
first audio (0.15 s). Convai and Mistral are in the same range. With the game running it will be slower by an amount not yet
measured (see Risks and build step 2).

## Test machine and conditions

- ASUS ROG Strix G634JZ. i9-13980HX (8 P-cores + 16 E-cores, 32 threads). RTX 4080 Laptop, 12 GB (driver 581.29). 31.6 GB RAM.
- **Power: the Windows scheme reads Balanced, but the CPU ran at about 98% of nominal clock in every run, i.e. no turbo.** That
  matches the ASUS Silent profile (the Armoury mode could not be read: WMI access denied). The GPU drew 15-55 W of its 150 W cap.
  All CPU numbers below are therefore pessimistic. GPU numbers varied about 1.5x between runs an hour apart (generation 80 vs
  55 tokens/s), so treat them as a range.
- **The game was not running.** In game, the LLM shares the GPU with Cyberpunk, so expect slower replies, and a frame-time cost
  during each reply that has to be measured (build step 2).
- Everything downloaded is in `E:\CyberpunkConvai-offload\work\local-llm\` (one folder per download). Raw results and server logs
  are in `results\`. The bench scripts are in `bench\`.
  - `bench-llm.mjs` drives the **real Mistral prompt path** (`PersonaBook`, `MistralHost`, `MistralMemory`, the bridge's
    context builders and `cleanReply`) against a loopback `llama-server`.
  - `bench-embed.mjs` runs the embedding and retrieval test.
  - `run-bench.sh` starts the server and records VRAM and RSS.

### The realistic prompt

The bench uses the same scenarios as `scripts/Test-MistralPrompts.mjs`: Judy, Johnny and a street resident, 4 turns each, private
channel, Natural speech and Expressive emotions on, the follow-up hint every other turn, and quest, gear and location context.

| Piece | Size |
|---|---|
| System prompt, named character (persona, examples, rules) | 11.5-13.4k chars, about 3,000-3,400 tokens |
| System prompt, ordinary NPC | about 6.3k chars, about 1,600 tokens |
| Live context per turn | 2-5k chars, about 500-1,300 tokens |
| First turn of a character | 3,750-4,080 tokens (Judy 4,083) |
| Later turns, new tokens after the prompt-cache hit | about 1,100-1,900 (cache reused 2,400-2,900 tokens) |
| Reply | 25-70 tokens (the 1-3 sentence rule holds) |

## LLM benchmarks

### Raw throughput (llama-bench, tokens/s)

| Model | Backend | Prompt processing | Generation |
|---|---|---|---|
| Qwen3.5-2B Q4_K_M | CPU, 8 threads (no turbo) | 111 (pp512) | 13.6 |
| Qwen3-4B-Instruct-2507 Q4_K_M | CPU, 8 threads | 47 (pp512) | 7.9 |
| Qwen3-4B-Instruct-2507 Q4_K_M | CPU, 16 threads | 57 (pp512) | 7.3 |
| Qwen3.5-2B Q4_K_M | Intel iGPU (Vulkan0, UHD-class) | 148 | 6.6 |
| Qwen3.5-4B Q4_K_M | Intel iGPU | 59 | 4.2 |
| Qwen3.5-2B Q4_K_M | RTX 4080 Laptop, Vulkan | 6,190-9,600 | 107-163 |
| Qwen3.5-4B Q4_K_M | RTX 4080 Laptop, Vulkan | 2,650-4,480 | 62-86 |
| Qwen3-4B-Instruct-2507 Q4_K_M | RTX 4080 Laptop, Vulkan | 3,050-4,920 | 65-103 |
| Gemma 4 E4B QAT q4_0 | RTX 4080 Laptop, Vulkan | 474-2,300 (pp1536, high variance) | 55 |

The iGPU idea, which would leave the discrete GPU to the game, does not work on this HX laptop: its integrated GPU is too weak.
Laptops with a strong iGPU (Radeon 780M/890M, Intel Arc in H/V-series chips) may be different. Gaming laptops with HX CPUs mostly
have the weak one.

### Real conversation turns (bench-llm.mjs, the bridge's own prompt and memory)

TTFT = time to first token. "First sentence" is when the first sentence is complete. "Full reply" is the whole `MistralHost.reply`
call. "Warm" means turns 2-4 of a character, with the persona prefix cached. Medians across Judy, Johnny and the resident.

| Run | Cold first turn TTFT | Warm TTFT | Warm first sentence | Warm full reply | Generation | VRAM added | Server RSS |
|---|---|---|---|---|---|---|---|
| Qwen3.5-2B, CPU 8 threads | 25-70 s | 16.6 s (max 25.7) | 18.1 s | 24.3 s | 12.7 t/s | 0 | 2.4 GB |
| Qwen3.5-2B, Vulkan | 0.76-0.93 s | **0.41 s** | 0.54 s | **0.82 s** | 105 t/s | **1.45 GB** | 2.1 GB |
| Qwen3.5-4B, Vulkan (run 1) | 1.0-1.4 s* | **0.56 s** | 0.85 s | **1.14 s** | 80 t/s | **3.05 GB** | 4.6 GB |
| Qwen3.5-4B, Vulkan (run 2, warm start) | 1.9-2.2 s | 1.00 s | 1.22 s | 1.65 s | 56 t/s | 3.05 GB | 3.7 GB |
| Qwen3-4B-Instruct-2507, Vulkan | 1.3-1.6 s* | 0.51 s | 0.61 s | 1.15 s | 86 t/s | 3.66 GB | 4.3 GB |
| Gemma 4 E4B, Vulkan | 1.2-1.8 s* | 0.88 s (one 17.9 s spike) | 1.16 s | 1.73 s | 56 t/s | 3.12 GB | 3.7 GB |

\* The first request after a fresh install of the Vulkan build took **55-80 s**: the driver compiles the GPU pipelines once.
NVIDIA's shader cache keeps them, so the next launch's first request took 1.9 s. A later request with a new batch shape can
still compile once (the 17.9 s Gemma spike and a 3.2 s Qwen spike). This needs a warm-up pass (see Risks).

Other measurements:
- Model load: 3.6-4.1 s for the 2B on CPU from a warm file cache. 11.7 s (4B) and 26.6 s (Gemma, 5.2 GB) onto the GPU from the
  E: drive.
- Idle loaded server: 2-3% of one core (391-641 ms of CPU in 20 s) and no GPU work. VRAM stays held.

### Quality, from these 12-turn samples (not a judgement pass; build step 1 does that properly)

- **Qwen3.5-4B:** in character and short. Johnny's voice was good. It answered "Are you an AI?" well. It invents small details now
  and then ("Grandad's hair turned green").
- **Gemma 4 E4B:** the most natural and grounded. It invented the least, kept replies short and asked fitting questions back.
- **Qwen3-4B-Instruct-2507:** fluent, but invents the most ("old Man Hu, runs since '98"). It repeated itself across Johnny's turns,
  and asks a question in almost every reply. It is a full-attention model, so its KV cache costs about 0.6 GB more VRAM.
- **Qwen3.5-2B:** usable for street NPCs, but confused on named characters ("I've seen too much of what you've done"; the resident
  calls herself "a regular kid").
- None leaked tags, said "as an AI" or broke format, with the existing `MistralHost` rules, cleaning and retry. The prompt from
  `docs/MISTRAL.md` carries over unchanged.

### Other candidates (looked up, not benchmarked)

All of these have llama.cpp GGUFs.

- **Ministral 3 3B Instruct 2512** (Apache-2.0, 2.15 GB official GGUF, 11 languages). It is the same family as the cloud route's
  `ministral-*`, so options 2 and 3 would behave alike. Worth adding to the step-1 comparison.
- **Ministral 3 8B** is too big for the 12 GB budget next to the game.
- **Phi-4-mini** (MIT, 3.8B): weak multilingual support and no evidence for role-play.
- **Llama 3.2 3B:** the community licence has attribution and naming clauses, and the model is older.
- **SmolLM3-3B** (Apache-2.0): thinks by default.
- **LFM2.5-1.2B / LFM2-2.6B:** the LFM licence terms are unclear for redistribution.
- **Granite 4.0 H-micro** (Apache-2.0, hybrid).
- **Gemma 3/3n:** the older Gemma terms. Gemma 4 replaces them.
- **Qwen3.5-0.8B:** a possible floor for barks only.

### Why not CPU, and why not another runtime

- CPU prompt processing on this laptop was 47-111 tokens/s, and a turn needs 1,100-1,900 new tokens (4,000 on a character's first
  turn). Even with turbo (perhaps 2-3x faster) and the leaner prompt layout below (about 300 new tokens per turn), a 2B model
  would take 1-3 s to the first token. Generation at 25-35 tokens/s would add 2-4 s per reply. It would also hold 8 threads that
  the game uses in crowds. **CPU-only is not offered**; such players get options 1 and 3.
- **ONNX Runtime GenAI:** DirectML/CUDA builds, and model coverage lags (no Qwen3.5 hybrid). No RAM prompt cache across
  characters.
- **llama.cpp CUDA build:** 265 MB plus a 391 MB cudart download (NVIDIA only). It avoids the Vulkan first-run compile and is
  usually somewhat faster at prompt processing. Keep it as a fallback if the Vulkan warm-up proves unreliable.
- **Ollama / LM Studio:** a separate install and service, and not redistributable inside the mod.

## VRAM, RAM and CPU budget

The RTX 4080 Laptop has 12 GB. Cyberpunk at high settings with ray tracing commonly takes 8-11 GB of it. This was not measured
here; measure it on the player's own settings in build step 2.

| Component | VRAM | RAM | CPU while working | CPU idle |
|---|---|---|---|---|
| Qwen3.5-4B, 8k context | 3.05 GB | about 3.7-4.6 GB RSS: mapped weights plus a capped RAM prompt cache. `--cache-ram 1024` and `--no-mmap` should cut it; measure. | 1 driver thread | 2-3% of a core |
| Qwen3.5-2B, 8k context | 1.45 GB | about 2.1 GB | 1 thread | same |
| Gemma 4 E4B | 3.12 GB | about 3.7 GB | 1 thread | same |
| Embeddings (granite, CPU) | 0 | 260 MB | 1 thread, 14 ms per query | 0 (exits when idle) |
| Moonshine STT | 0 | about 250 MB, only around a recording | 1 thread, up to about 15% of a core while recording | 0 (exits after 90 s) |
| Pocket TTS | 0 | 418 MB weights, about 1.7 GB peak | 4 threads during a reply | 0 |
| OmniVoice (optional) | 1.9-2.4 GB | about 3.3 GB | GPU | 0 |

What fits on a 12 GB card with the game:
- **Game + 4B LLM + Pocket:** about 3 GB on top of the game. This is the standard local setup when the game leaves 3.5 GB free.
- **Game + 2B LLM + Pocket:** about 1.5 GB extra. For 8 GB cards, or a game that leaves 2-3.5 GB free.
- **Game + 4B LLM + Omni:** about 5.5 GB extra. Only on 16 GB+ cards. The bridge refuses the combination below that and keeps
  Pocket, with one notice, using the same busy-GPU rule Omni already has (`--gpu-busy-fraction`).
- The model tier is chosen at start from free VRAM: 4B if 3.5 GB or more is free, 2B if 2 GB or more. Below that the option is
  unavailable, and the notice offers options 1 and 3.

System RAM for the local option: about 4.5-5.5 GB more than option 1. Minimum 16 GB, 32 GB recommended.

**GPU contention with TTS.** Pocket is on the CPU, so the LLM and Pocket never fight over the GPU. They only share the CPU briefly:
Pocket's 4 threads plus the LLM's single driver thread. With Omni, the LLM reply (about 1 s) finishes before Omni renders, because
the reply is short and the host already waits for the complete text. So the two GPU bursts run back to back, not overlapped.
Don't stream Omni from the first LLM sentence while generation continues: two GPU jobs at once would slow both and deepen the
frame dip.

## Embeddings and vector memory

### Embedding benchmark (bench-embed.mjs, CPU, game closed, no turbo)

The test set is 14 short memories (12 English, 1 Spanish, 1 German) and 12 queries, including a Spanish and a German query.

| Model | Size | Dim | Threads | Embed one query | Embed 14 memories | Top-1 hits | Top-3 hits | RSS |
|---|---|---|---|---|---|---|---|---|
| **granite-embedding-107m-multilingual Q8_0** | 121 MB | 384 | 1 | **14 ms** (max 16) | 235 ms | 10/12 | 12/12 | 261 MB |
| same | | | 2 | 12 ms | 175 ms | 10/12 | 12/12 | 260 MB |
| EmbeddingGemma-300m Q8_0 | 334 MB | 768 | 1 | 128 ms | 1,693 ms | 10/12 | 12/12 | 244 MB |
| same | | | 2 | 73 ms | 1,004 ms | 10/12 | 12/12 | 245 MB |

The flat scan over 5,000 synthetic vectors in plain JS took 7 ms at 384 dimensions and 15-20 ms at 768.

Why granite:
- Apache-2.0. EmbeddingGemma is under the gated Gemma terms, and jina-v3 is non-commercial.
- 12 languages: en, de, es, fr, ja, pt, ar, cs, it, ko, nl, zh.
- Small, and fast on one thread.
- It runs in the same `llama-server` binary.

Fallbacks:
- **multilingual-e5-small** (MIT, 384 dimensions, about 100 languages, needs "query:"/"passage:" prefixes) if more languages
  matter.
- **potion-multilingual-128M** (Model2Vec static vectors, about 0.1 ms per query) if the 14 ms ever matters.

### Store

- Records: `<state folder>/local-memory/<player>.json`.
  - Each record is `{id, character, kind, text, created, updated, gameTime, importance, source, pinned}`.
  - `kind` is `fact`, `event`, `preference`, `relationship`, `promise` or `summary`.
  - `<player>` is the same player identity the Convai memory uses.
- Vectors: `<player>.f32`, row order matching the records, plus a header naming the embedding model and dimension. A model change
  re-embeds everything in the background, which takes about 14 ms per record.
- In memory: one Float32Array per player (normalised), and a character-to-rows map. Saves are atomic and debounced off the speech
  path, like `mistral-memory.json`.
- Caps: 2,000 records per character, 20,000 per player, 5 MB file. When over a cap, the oldest unpinned records with the lowest
  importance are folded into the character's summary.
- Options 2 and 3 share this store. On the cloud route (option 3) the extraction prompt below runs on Mistral or Groq. The
  embeddings stay local in both. `mistral-memory.json` (8 exchanges plus a summary) becomes the store's "recent history and
  summary" part, migrated once.

### Pipeline

**Every turn (hot path, about 15 ms in total):**
1. Embed V's line (14 ms). On voice turns, start this as soon as the final transcript exists.
2. Score every row of this character: cosine + 0.05 x recency (decays over about 30 in-game days) + 0.03 x importance + 0.1 if
   pinned. Keep the top 4 above about 0.40.
3. Add them to the prompt as "WHAT YOU REMEMBER OF V" (at most about 300 tokens), together with the character's summary.
4. Ordinary NPCs (ambient keys) keep only the short in-session history, as now. Vendors keep the existing vendor memory.

**After the conversation (off the hot path):** these steps run only when no turn has been in flight for 20 s, or the character
was dismissed, or after 6 new exchanges. They never run in combat (the battle lease) or while a reply is being spoken.
1. One request to the local LLM: "extract 0-3 lasting facts about V or about our relationship, from my point of view, as JSON".
   - Uses `response_format: json_schema`, which llama-server turns into a grammar, so the output always parses.
   - The prompt is about 600 tokens and the output about 120: roughly 0.3 s of GPU prompt work plus 1.5-2 s of generation.
     That is about the same GPU burst as a reply.
2. Embed each fact (14 ms each).
   - If cosine to an existing fact is 0.90 or more, update that record instead of adding a new one (newer wording, bump
     `updated`).
   - A fact that contradicts an older one (detected the same way, and the model marks it `replaces`) replaces it.
3. Every 8 rolled-out exchanges, refresh the summary (the existing `summaryMessages`, 110 words).
4. A turn that starts during this work aborts it (closing the HTTP stream cancels it in llama-server). It is retried at the next
   idle moment.

**Forget** (Memory page, one character or all) deletes the records, rows and summary. The character editor lists the records and
lets the player edit, pin or delete them. An edit re-embeds that one record.

World and quest knowledge stays in the existing knowledge service and context string. Retrieving from
`characters/world-knowledge.json` (9 MB) with the same embeddings is a possible later step, not part of this option.

## Prompt layout for caching

llama-server reuses the longest identical prefix of the previous request, and `--cache-ram` keeps several prompts in RAM, so
switching characters restores a persona without recomputing it. The measured turns reused 2,400-2,900 tokens and recomputed
1,100-1,900, because today's Mistral layout puts the whole live context (which includes a 2,100-character follow-up block every
other turn) in the last message. Order the local prompt from stable to volatile instead:

1. **System, static per character and settings:** persona, examples, output rules, and the Natural speech and Expressive emotion
   format notes. Those two notes, 1,042 and 1,393 characters, are identical every turn but are sent inside the live context
   today. This block is about 3,500 tokens and is prewarmed when the companion is invited.
2. **World block:** quest, journal, location and time of day, gear, relationship. It changes only on game events.
3. **Memory block:** summary plus the retrieved records.
4. **History:** the last 8 exchanges.
5. **Last user message:** the volatile hints (follow-up, game dialogue, battle and loot) and `V says: ...` plus the closing
   reminder.

Expected new tokens per warm turn: about 150-400 instead of 1,100-1,900. On the GPU that cuts prompt processing to under 0.15 s and
shortens each burst. It matters most on the lite tier and on slower GPUs.

**Hybrid model caveat (measured).** Qwen3.5 mixes recurrent (Gated DeltaNet) and attention layers. Gemma 4 uses sliding-window
attention. For both, llama.cpp can only resume from saved context checkpoints, not from any token.
- A test that put the alternating follow-up block inside the system prompt got **zero** cache reuse on every turn (warm TTFT
  45 s on CPU instead of 17 s).
- So the stable blocks must be byte-identical, and anything that changes per turn must come after them.
- Keep `--ctx-checkpoints` at its default (32) or above.
- For full certainty, save a persona snapshot per character with `/slots/0?action=save` after the prewarm and restore it at turn
  start. This works for recurrent state too.

Use the same layout for the Mistral route, so both routes keep one prompt builder. Whether Mistral's API caches prompt prefixes
was not checked.

## STT

Moonshine Tiny English int8 stays the default for this option. It is measured and built: WER 11.4-11.7%, final text 3 ms to
0.45 s, CPU, 1 thread, MIT, 124 MB, already in the Runtime package. The bridge's hook (`createLocalSpeech`, `voiceChannel({reply})`)
takes any text provider's `reply`, so the local LLM route uses it unchanged.

| Option | Size | Languages | Licence | CPU cost | Verdict |
|---|---|---|---|---|---|
| Moonshine Tiny en (current) | 124 MB | English | MIT | 0.18-0.45 s per clip | keep |
| Moonshine Base en | 141 MB | English | MIT | about 2x Tiny | no gain measured (`docs/LOCAL_STT.md`) |
| Whisper small (faster-whisper int8) | 484 MB | 99 | MIT | 8 s per clip measured | too slow |
| Whisper large-v3-turbo | about 800 MB | 99 | MIT | far slower than small on CPU | too slow without the GPU |
| Parakeet TDT 0.6B v3 (sherpa-onnx int8) | about 600-700 MB | 25 European | CC-BY-4.0 | not measured | **candidate for an optional multilingual voice pack** |
| SenseVoice-Small (sherpa-onnx int8) | about 230 MB | zh, en, ja, ko, yue | check | vendor claims 70 ms per 10 s | candidate for CJK |
| Moonshine tiny-ja/-ko/-zh/-ar/-uk/-vi | about 27M params each | one language each | "other" (not MIT), check before shipping | fast | only if the licence allows |

Multilingual voice input is not a hard requirement. Typed text in any language already works (Qwen3.5 covers 201 languages). A
later multilingual STT pack would take Parakeet v3 for European languages and possibly SenseVoice for CJK, measured with
`scripts/Bench-LocalStt.mjs` first.

## TTS

Unchanged: Pocket (CPU, first audio about 0.15 s) or OmniVoice (GPU, 1.2-2.5 s). This option makes Pocket the recommended voice,
because Omni and the LLM would compete for the same VRAM and GPU time; see the VRAM budget. The fallback rules in
`bridge/voice-selection.mjs` apply as they are. Convai's cloud voice is not available on this route, the same as with Mistral.

## How it plugs into the bridge

Today: `conversationProvider` is `convai | mistral`. `MistralHost` builds the prompt, streams the reply, cleans it and keeps
memory. `attachMistral(host, {provider, mistral, speech})` swaps the text path of both realtime hosts.

New value: **`local`**.

| Module (new or changed) | Job |
|---|---|
| `bridge/local-llm-server.mjs` (new) | Supervises `llama-server`. |
| `bridge/text-provider-host.mjs` (from `mistral-host.mjs`) | The common host: prompt, stream, clean, retry, memory hooks. Mistral keeps its pacing and zero-quota model skipping. Local turns pacing off and points `chat` at the supervisor's endpoint with its key. |
| `bridge/text-provider.mjs` (from `mistral-key.mjs`) | The provider state for `convai`, `mistral` and `local`: setting, applied value, one-time notices. The switch waits until no conversation is running, as Mistral's does. |
| `bridge/memory-store.mjs`, `bridge/local-embed.mjs` (new) | The store above and the embedding server (CPU build, `--embedding`, 1 thread, below-normal priority, exits 90 s after its last use like the STT worker). |
| `bridge/local-ai-pack.mjs` (new, like `omni-pack.mjs`) | Detects the pack and publishes `localPack: {installed, missing, tier}` in `runtime/mistral-state.json`, renamed to a provider state file. |
| `bridge/mistral-prompt.mjs` | Gains the stable-to-volatile layout (shared by both routes). |
| `bridge/convai-bridge.mjs` | Wires `attachTextProvider(host, {provider, hosts: {mistral, local}, speech})`. |
| `mod/` settings and locales | "Conversation provider: Convai / Free cloud / Fully local (needs the Local AI pack)", a model tier row (Auto / Small / Standard), and the status line. All 15 languages. The daily-limit notice offers options 2 and 3, per TODO. |

What `local-llm-server.mjs` does:
- Spawns `llama-server` from the pack with:
  - `--host 127.0.0.1`, a random free port and a random `--api-key` per session (the server's CORS is permissive, so the key
    stops a web page from using it);
  - `-ngl 99 -fa on -c 8192 -np 1 --reasoning off --cache-ram 1024 --ctx-checkpoints 32`;
  - a device chosen by name (the discrete GPU, never the iGPU);
  - below-normal process priority.
- Health-checks it and restarts it on a crash. After repeated failures the bridge falls back to option 1, with one notice.
- At first enable, and after each pack or driver change, runs a **warm-up**: requests at the batch sizes the bridge uses
  (512-token and 2,048-token prompt chunks, single-token generation), so the Vulkan pipelines compile before any player turn. It
  shows "Preparing local AI (first time, about a minute)". After that, a short warm-up at each start.
- **Persona prewarm** when a companion is invited or joins (like the Convai warm): one request with only the static system block
  and `max_tokens: 1`, then a slot snapshot.
- **Lifetime:** loaded while the provider is `local` and the game runs.
  - Weights are unloaded (process ended, VRAM freed) after 10 minutes with no companion and no conversation. The next talk
    reloads them, about 4-12 s, shown as the existing "Preparing connection" notice.
  - Never more than one LLM server at a time. It never loads while OmniVoice is loading (the existing `resident-model.lock`).
- Chooses the tier from free VRAM at start (read from `nvidia-smi`, or from Vulkan memory budget queries on AMD and Intel), and
  publishes it.

What stays the same:
- The reply result shape (`text`, `sessionID`, `timing`).
- `transformReply` (Natural speech, Expressive emotions), subtitles, Phone Chat, Pocket/Omni, lip sync and group rounds.
- The voice key through `createLocalSpeech`.
- Speculative preparation and look-ahead are refused, as with Mistral. Local is single-slot, and group rounds run speakers one
  after another.

### Character data and the editor

`PersonaBook` reads `characters/roster.json` (80 named profiles) and `characters/archetype-roster.json` (74 archetypes): the
backstory, speaking style and sample dialogues uploaded to Convai.

The editor (TODO: in game if possible, else a web page) writes overrides to `<state folder>/character-overrides.json`: bio, style,
rules, sample lines, keyed by profile. Memories are edited through `memory-store.mjs`.

`PersonaBook` merges the overrides over the roster. The persona block's hash is part of the prompt-cache and snapshot key, so an
edit only costs one re-prewarm. The same overrides feed option 3 (Mistral/Groq). Convai profiles are not changed by the editor.

## Packaging

**Local AI pack**, an optional download like the Omni pack, built by the workflow's next job:

| Content | Size |
|---|---|
| llama.cpp Vulkan build: `llama-server.exe`, its DLLs and the CPU backends; MIT licence | 32 MB zipped, 88 MB unpacked (about 60 MB after dropping the unused tools) |
| Qwen3.5-4B Q4_K_M | 2.74 GB, split into `.partN` ranges under 1 GB by the existing mechanism and joined on first start |
| Qwen3.5-2B Q4_K_M (lite tier, also the fallback) | 1.28 GB |
| granite-embedding-107m-multilingual Q8_0 | 121 MB |
| Licences: Apache-2.0 (Qwen, Granite), MIT (llama.cpp), and `THIRD-PARTY-NOTICES.txt` lines | small |
| **Total** | about 4.2 GB (both tiers), or about 2.9 GB standard-only and 1.45 GB lite-only as separate packs |

- If Gemma 4 E4B wins step 1, the standard pack becomes about 5.3 GB.
- All of these licences allow redistribution in the free mod. Unlike Omni's CC-BY-NC weights, they put no limit on the
  project's licence; the "keep a selectable Convai option" clause is unaffected.
- The Runtime package needs no change: Moonshine is already in it, and so is Node 24.21 (which has `node:sqlite`, but the flat
  index doesn't need it).

## Minimum PC spec (estimates; only this laptop was measured)

| Tier | GPU | VRAM free beyond the game | RAM | CPU | Disk |
|---|---|---|---|---|---|
| Fully local, standard (4B) | NVIDIA RTX 20-series or newer, or AMD RDNA2+ with working Vulkan | 3.5 GB (in practice a 12 GB card at the player's settings, or 16 GB with ray tracing) | 16 GB (32 recommended) | 6 cores | 3 GB pack |
| Fully local, lite (2B) | same | 2 GB (an 8 GB card at medium textures) | 16 GB | 6 cores | 1.5 GB pack |
| With OmniVoice as well | same | 5.5 GB+ (a 16 GB card) | 32 GB | 8 cores | plus the Omni pack |
| Not supported | no discrete GPU, under 8 GB VRAM, or a CPU-only machine | | | | use option 1 or 3 |

## Risks

1. **FPS during replies (the main unknown).** Each reply is a GPU burst of about 0.3-1.7 s, and memory extraction adds a similar
   burst off the hot path. Between bursts the LLM uses no GPU. How much the game's frame time spikes during a burst is unmeasured.
   - Mitigations to test in step 2:
     - Smaller compute chunks (`-ub 256` or `128`), so game frames interleave.
     - Windows GPU scheduling priority for the server process (`D3DKMTSetProcessSchedulingPriorityClass`, below normal).
     - No background extraction in combat or while speech plays.
     - The lite tier.
   - The acceptance rule: no change in average FPS or 1% lows while idle with the model resident, and a dip during a reply no
     worse than the one OmniVoice already causes.
2. **VRAM pressure.** 3 GB on a card the game nearly fills makes the game stream textures, which means stutter. Mitigations: the
   tier chosen by free VRAM, unload after 10 idle minutes, q8_0 KV cache and a 6k context if needed, and the Omni combination
   refused below 16 GB.
3. **Vulkan pipeline compile on first use: 55-80 s, measured.** Later one-off compiles of 3-18 s were also seen. Mitigations:
   - the install and first-enable warm-up over the bridge's batch shapes;
   - check that NVIDIA's shader cache keeps them across sessions and driver updates;
   - fallback: the CUDA build for NVIDIA (about 650 MB more).
4. **Quality.** Small models invent details and hold a persona less tightly than Convai. The existing rules, cleaning and retry
   kept every sampled reply in character. Retrieved memories make it better at remembering V than today's Mistral route, but not
   at world knowledge. Decide the model by a proper judged comparison (step 1).
5. **Hybrid model caching** (Qwen3.5, Gemma 4): resuming only works from checkpoints. The prompt layout and slot snapshots handle
   it, and it was verified with the bench (zero reuse with the wrong layout).
6. **Power profile and machine variance.** Silent mode halves or worse the numbers. GPU speed varied 1.5x between runs on this
   laptop. AMD and Intel GPUs were not tested.
7. **Security.** `llama-server` is an HTTP server with permissive CORS. Bind it to loopback, use a random port and a per-session
   API key, never log the key, and kill the process with the bridge.
8. **Antivirus.** Unsigned `llama-server.exe` and DLLs may be flagged. Ship the official release files unchanged, with their
   SHA-256 in the pack manifest.
9. **Disk and download size**: 1.5-5.3 GB depending on the tier and model.

## Build plan

1. **Pick the model (offline, no game).**
   - Extend `scripts/Test-MistralPrompts.mjs` with `--endpoint` and `--api-key`, or reuse `bench-llm.mjs`.
   - Run the 24-turn set on six characters for Qwen3.5-4B, Gemma 4 E4B, Ministral 3 3B and Qwen3.5-2B, in both the current and the
     stable-to-volatile layouts.
   - Judge with a Haiku fan-out (few agents, large batches, one rubric: in character, first person, grounded, no invented facts,
     length) and read a sample with the user.
   - Output: the default and lite models, and the prompt layout.
2. **In-game FPS and VRAM gate (needs the user; the game is launched by me, as usual).**
   - On the user's settings, measure FPS, 1% lows and VRAM in four states: baseline; model resident and idle; 20 scripted turns;
     memory extraction running.
   - Try `-ub` sizes and the GPU scheduling priority.
   - Pass or fail on the rule in Risk 1. If the 4B fails, the 2B is the 12 GB default. If both fail, the option needs a 16 GB card.
3. **`local-llm-server.mjs`:** spawn, port and key, health, warm-up, tier choice, prewarm and snapshots, idle unload, crash
   fallback, priority. Unit tests with a fake server binary.
4. **Generalise the text-provider host:** `mistral-host` and `mistral-key` become `text-provider-*`, with a `local` route (no
   pacing, loopback endpoint with key). Existing Mistral tests keep passing, and local tests are added.
5. **Prompt layout v2** (stable to volatile, format notes into the system block) for both routes. Re-run the Mistral prompt test
   to confirm the replies don't change.
6. **Memory:** `memory-store.mjs`, `local-embed.mjs`, retrieval in the prompt, JSON-schema extraction and summaries scheduled
   off the hot path, Forget, migration from `mistral-memory.json`, and use by option 3.
7. **Settings, notices and status** in all 15 languages: provider `local`, the tier row, pack status, "Preparing local AI", the
   fallback notices. The daily-limit notice offers options 2 and 3.
8. **Local AI pack:** build job, parts, manifest, licences, `local-ai-pack.mjs` detection. The install test loads the model,
   gives one reply and embeds one memory.
9. **Character editor hooks:** `character-overrides.json` merged by `PersonaBook` with the hash in the cache key; a memory list,
   edit and pin API for the editor UI.
10. **Live checks and docs.**
    - A `docs/LOCAL_OPTION.md` for players and developers.
    - TODO live-check lines: talk by text, voice and Phone Chat; Forget; character switch; a companion invite prewarm; idle
      unload and reload; the VRAM refusal; the FPS log.
11. **Later:** a multilingual STT pack (Parakeet v3, SenseVoice) measured with `Bench-LocalStt.mjs`, and optional retrieval
    over world knowledge.
