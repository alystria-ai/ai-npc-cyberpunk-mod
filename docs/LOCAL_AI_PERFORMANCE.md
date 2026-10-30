# Local AI performance: what is proven, what we use, what is left to measure

Written 2026-10-31 on branch `perf/local-ai-efficiency`. The question: what makes a llama.cpp chat backend fast and light next to a running game, and which of it do we
already have, which should we add, and which should we leave. Owner's order of priority: the frame rate first (no GPU or CPU work that stretches frames), response
latency equally, then everything else. The engine is llama.cpp `llama-server`, Vulkan build b11782 (`packaging/release.config.json`, "localAi.server").

How this was checked. The flag list and defaults were read from the llama.cpp server README on master and from `llama-server --help` of the b11560 build in `local-ai/llama-vulkan`
(b11782 itself was not run for this note: every flag below is also in the master README, and the bench script fails loudly when a build refuses a flag). Checkpoint behaviour
was read from `tools/server/server-context.cpp` on master. Earlier measurements of this project are cited with their dates. The first version of this note was written without
a GPU run because the owner's machine was in use. The measurements were then made on 2026-10-31 and are in "Measured" at the end.

## The short version

Most of the proven strategies are already in the launch line. What made the player's stutter (AetherAmoris, RTX 5090 Laptop, Gemma 4 12B) was reading about 5,000 to 6,500
prompt tokens again on every turn, and that was fixed on 29 Oct (stable world blocks, `--swa-full` where the card has room). KoboldCpp does not stutter for him because
it keeps the whole prompt cache and reuses the start of the prompt (its FastForwarding and ContextShift), and its sliding-window cache is off unless asked for, which is
the same thing `--swa-full` gives us. The measurements below found no variant that clearly wins, so this branch changes no default flag. It adds one switch, `CYBERPUNK_CONVAI_LOCAL_TUNING`, for the few flags that might still help and
are cheap to try, and a bench script that compares launch lines on a realistic mod conversation. A default is changed only when a bench run on a card shows a gain.

## The launch line today

`-m <model> -ngl 99 -fa on [--swa-full] -c <ctx> [-ctk q8_0 -ctv q8_0] -np 1 --reasoning off --cache-ram <n> --ctx-checkpoints 32 -fit off --device <id> --no-webui`.
An offloaded load drops `-ngl`, turns `-fit on` and adds `-fitt` and `-t`. The environment has `GGML_VK_FORCE_MAX_ALLOCATION_SIZE` at 64 MiB. The process runs at High priority
while a turn is served (docs/PROCESS_PRIORITY.md). `bridge/local-llm-server.mjs` `buildServerArgs`.

## Each technique

| Technique | Expected gain | Risk | Applies to us | Decision |
|---|---|---|---|---|
| Flash attention `-fa on` | Large. Measured 2026-10-29: `-fa off` halves the speed. Smaller KV and compute buffers. KoboldCpp has it on by default | None on Vulkan builds of the last year | Yes, all models | Already on. Keep |
| 8-bit KV cache `-ctk/-ctv q8_0` | Memory only. About 90 MiB on the lite model at 16k. KoboldCpp calls it `--quantkv 1` and leaves it off | Measured on this project: prefill a third slower on Vulkan | Yes | Keep as is: used only when the fit probe says the whole model does not fit with the 16-bit cache |
| Sliding-window cache, `--swa-full` | Gemma only. Lets any shared start of the prompt be reused, not only a saved checkpoint. 82 to 85 percent fewer prompt tokens per Judy turn (2026-10-29) | About 600 MiB more graphics memory for Gemma 4 E4B at 16k, so only when the probe says it fits | Gemma 4. Qwen and Bonsai have no such layers, the flag does nothing for them | Already done. Keep |
| ContextShift (KoboldCpp) | Keeps a long chat going without re-reading when the window is full | We never fill the window: the prompt budget (`bridge/prompt-budget.mjs`) cuts blocks in a fixed order first. Shifting also cannot work on Gemma's sliding-window cache. KoboldCpp itself says SWA and ContextShift do not mix | No | Not needed. `--context-shift` stays at its default (off) |
| Prefix identical from turn to turn (the thing KoboldCpp's FastForwarding relies on) | The biggest single lever: new tokens per turn fell from about 5,000 to 6,500 to about 950 | Needs care when blocks are added | Yes | Done 2026-10-29 (`topic-words.mjs`, `journal-history.mjs`, world blocks order). Keep every new block after the stable ones |
| Prompt cache in RAM `--cache-ram` | A character you left comes back without a full read | RAM, set from free memory (1 to 4 GiB) | Yes | Already set. Keep. llama-server's own default is now 8 GiB, which we do not want next to a game |
| `--cache-idle-slots` | Saves an idle slot into the cache when another prompt arrives | None | Default on, needs `--cache-ram` | Default stays |
| Context checkpoints `--ctx-checkpoints 32` | Needed by hybrid models (Qwen3.5, Bonsai) to resume a prompt at all, and by Gemma without `--swa-full` | Each checkpoint is 60 to 200 MiB of system RAM | Yes | Keep at 32 |
| Checkpoint spacing `-cms` (`--checkpoint-min-step`, default 8,192 in b11560 and on master) | Checkpoints are made at the start of the last user message and 4 and 4 plus a batch before the end of the prompt, plus one more whenever a prompt has gone 8,192 tokens past the last one. When the list is full, any checkpoint closer than that to an earlier one is erased. Our prompts are 2,000 to 8,500 tokens, so once 32 are held the early ones (the persona's, from the warm-up) can go and the next change in the middle of a prompt reads everything again. Only matters for hybrid models and Gemma without `--swa-full` | A small step makes more checkpoints, each one a copy of the recurrent or window state during the prompt read | Lite and Mature lite (Qwen based) and any Gemma that did not get `--swa-full` | Not changed. Switch added (`checkpoint-step=N`), compare 8,192, 256 and 0 in the bench (the "mixed" scenario fills the list) |
| `--cache-reuse N` (KV shifting) | Reuses a block of the old prompt that moved, for example after a changed middle block | Does nothing when the cache cannot shift, and Gemma (sliding window) and Qwen3.5 (recurrent) cannot. A shifted block is a tiny approximation of a fresh read | Only a custom full-attention model (Llama, Mistral, Qwen3 dense) | Not on. With a stable prefix the case is rare. Switch added (`cache-reuse=N`) for a player to try on such a model |
| Slot save and restore to disk (`--slot-save-path`) | Would remove the first-turn read of a character (the world blocks are 4,000 tokens) after a restart or an idle stop | Files of hundreds of MiB per character, stale when any early block differs, one more restore call that runs on the card | Possible | Not now. The first read is the same GPU work as a warm-up and happens once per talk. Revisit only if reports show the first turn is the stutter |
| Batch sizes `-b 2048 -ub 512` (defaults) | Larger `-ub` reads prompts faster, smaller leaves more room for the game between kernels | Measured 2026-10-29 with a second GPU process: 64 to 1024 all stretched the other process about 2.7 times for the whole read, no stall over 45 ms, and a smaller batch only read slower (888 / 1,256 / 2,285 / 2,670 tokens a second at 64 / 128 / 256 / 512) | Yes | Keep 512. `ubatch=1024` is in the bench for a last look on the 5090 |
| `-ngl 99 -fit off` and `-fit on -fitt` | `-fit` costs a second model load at start (it measures devices), so it stays off when everything is given. Offload keeps `-fitt` 1,792 MiB free for the game | None | Yes | Already done (docs/LOCAL_AI.md, offload). Keep |
| CPU threads `-t` | A fully offloaded Vulkan load does very little on the CPU, so more threads add nothing, but idle threads could spin | The offload cap exists (half the physical cores). For a GPU-only load there is no cap | Possible | Not changed. `threads=4` is in the bench with the CPU seconds of the server, to see whether it moves anything |
| `--poll N` (default 50) | How long idle CPU workers spin before sleeping. Zero is lighter on the game's CPU | Slower CPU work on an offloaded model | Offloaded loads only matter | Not changed. `poll=0` is in the bench |
| `--mlock`, `--no-mmap`, `-lm dio` | Keeps weights in RAM, or skips the page cache while loading | `mlock` pins RAM the game wants. A Vulkan load copies the weights to the card, so RAM residence does nothing for speed. `dio` depends on the drive and driver | No | Left alone |
| Warm-up `--warmup` (default on) | The first request after start would otherwise pay for shader and buffer set-up | None | Yes | Default stays. The mod's persona warm-up at the talk key is separate and stays |
| Speculative decoding, draft model or Gemma 4 multi-token prediction (`--spec-type draft-mtp`, a drafter file of its own) | Google quotes up to 3 times faster writing, third-party llama.cpp posts 1.8 to 2.5 times. Our replies are 30 to 80 tokens at 80 or more tokens a second, so the gain is about half a second a reply | An extra download and file per model, more graphics memory, no help for the prompt read (which is the stutter). Needs the packs changed, which is another branch's work | Gemma 4 standard and Mature good, if a drafter exists for the exact size | Not now. Candidate for a later pack. The bench can test it by hand with `name=` variants once a drafter file exists |
| N-gram speculation (`ngram-simple`, `ngram-mod`) | Helps text that repeats the prompt. In-character replies do not | Extra verification work on the card | Low | No |
| Backend (on-card) sampling `-bs` | Gemma has a 262,000 word vocabulary, so sampling on the CPU takes a visible part of each token | llama.cpp marks it experimental, supports only some samplers, and the Vulkan backend is the least tested | Possible | Not changed. `backend-sampling` is in the bench |
| Parallel slots | None for one player | Each slot holds its own cache and checkpoints | No | `-np 1` stays. Everything we send goes through one queue (docs/LOCAL_AI.md, "The single slot") |
| Vulkan against CUDA on NVIDIA | Measured here 2026-10-20 (`deliverables/cuda-vs-vulkan-2026-10-20.md`): CUDA read prompts 15 to 38 percent faster at the menu, 0 to 20 percent faster in the world, and wrote the same speed. Phoronix and NVIDIA forum posts show the same split: Vulkan (with the newest driver) close on prompt reading, CUDA ahead on writing | 265 MB plus 391 MB of CUDA files on top of the Vulkan build, and NVIDIA only. AMD and Intel players still need Vulkan | NVIDIA players | No. A shorter read would only shorten the stutter, not remove it, and the fix was reading less |
| GPU scheduling priority of the server | Would let the game's frames go first | Measured 2026-10-29 with a lower scheduling class: no gain. `--prio` and process priority are CPU matters | No | Nothing to change. High priority on the CPU side stays (owner rule) |

## Why KoboldCpp does not stutter for the player

KoboldCpp on the Custom provider receives the same prompts from the bridge. What differs is the server. By default it has flash attention, ContextShift and FastForwarding
(it keeps the cache of the last prompt and processes only what is new), batch size 512 (`--blasbatchsize`), a full-size cache because its SWA mode is off unless `--useswa`
is given, and `--smartcache` slots only when asked for. Before 29 Oct our server on Gemma read the whole 5,000 to 6,500 token world block again each turn, because Gemma's
window cache can only continue from a saved checkpoint and the text in front of the checkpoint changed every turn. That is the difference he saw. The 29 Oct work (stable
blocks, `--swa-full`) removed it, so the two now do the same work per turn. The matching measurements of the frame loop beside a prompt read (2026-10-30, docs/LOCAL_AI.md,
"Stutter right after typing, second look") found no launch change that would help further: the frames stretch 25 to 30 percent for the length of the read at any batch size
or priority, with no spike over 25 ms. An open item stays open: a PresentMon capture of a Judy turn on his PC, Local AI against Custom, same model.

## What this branch changed

- `bridge/local-launch-tuning.mjs` and the variable `CYBERPUNK_CONVAI_LOCAL_TUNING` (a list such as `checkpoint-step=256,poll=0`). Each entry becomes llama-server flags in
  `buildServerArgs` (`extraArgs`, placed before `--host`). Unknown names and out of range values are ignored. A knob that would repeat a flag already on the line is dropped
  (an offloaded load keeps its own `-t`). Nothing is on by default (`DEFAULT_TUNING` is empty), so the command line of every start is byte for byte what it was. One log line
  per start names what is applied: `[local] launch tuning (CYBERPUNK_CONVAI_LOCAL_TUNING): ...`. To go back, remove the variable.
- Knobs: `checkpoint-step` (`-cms`), `cache-reuse`, `threads` (`-t -tb`, GPU-only loads), `poll`, `ubatch` (`-ub`), `backend-sampling` (`-bs`).
- `scripts/Bench-LocalAiLaunch.mjs`: the measurement.
- Tests: `bridge/local-launch-tuning.test.mjs` (the parse, ranges, order, offload and repeat rules, the defaults, `buildServerArgs` with and without extras) and one test in
  `bridge/local-llm-server.test.mjs` (the variable reaches the command line and the log of a real supervisor start on the fake server, and is absent without it).

## Measured (2026-10-31, RTX 4080 Laptop 12 GB, llama.cpp b11782, Balanced power plan, game closed)

`scripts/Bench-LocalAiLaunch.mjs`, one server per variant, the same scripted Judy conversation (about 5,400 tokens of system message and history, the right-now block changing once). Other agents ran
small unit tests now and then, so differences under about 15 percent are noise. The first request of a talk reads the whole prompt in every variant: 3,052 new tokens (after the persona warm-up's 2,394),
and every later turn reads 77 to 131 new tokens. The switch scenario's return to Judy after Panam read 131 new tokens too, so the RAM prompt cache works.

Gemma 4 E4B standard (q4_0), 16,384 context, `--swa-full` on. Time to the first token in ms (median of the later turns) in the talk, switch and mixed scenarios, writing speed, graphics memory the
server took, CPU seconds over the three scenarios:

| Variant | talk | switch | mixed | tokens/s | VRAM MiB | CPU s |
|---|---|---|---|---|---|---|
| main (today) | 104 | 91 | 100 | 83.7 | 3,767 | 9.4 |
| kvq8 (8-bit cache) | 105 | 90 | 109 | 78.7 | 3,331 | 33 |
| checkpoint-step=256 | 94 | 90 | 109 | 83.9 | 3,767 | 8.8 |
| poll=0 | 108 | 110 | 119 | 81.3 | 3,767 | 10.0 |
| threads=4 | 106 | 108 | 89 | 83.0 | 3,767 | 8.7 |
| ubatch=1024 | 96 | 85 | 111 | 85.9 | 3,887 | 8.5 |
| backend-sampling | 227 | 271 | 218 | 90.4 | 3,770 | 12.3 |

Bonsai 2 4B lite (no `--swa-full`), same conversation, two runs with the order changed to see drift. Time to the first token 138 to 183 ms for every variant, with the same variant differing by up to 30
ms between runs (main 153, 140, 140 in talk, threads=4 141, 167, 158). New tokens per turn identical for `checkpoint-step` 8,192 (today), 256 and 0 in all three scenarios, graphics memory 1,831 MiB for
all, CPU seconds 5.6 to 10.6 with the highest in the first run of the session.

What this says:

- Every variant of Gemma is inside the noise on the time to the first token, which is about 100 ms at any turn after the first. There is nothing to win there, and the user-visible cost is the first read
  of a talk (see docs/PROMPT_GROWTH.md for turns 1 to 100).
- 8-bit cache: saves 436 MiB and costs 6 percent of the writing speed and 3.5 times the CPU seconds. The CPU cost makes it a bad default next to a game. It stays a fit-only measure.
- `ubatch=1024` costs 120 MiB for no change. `backend-sampling` writes 8 percent faster but doubles the time to the first token. Neither is wanted.
- `checkpoint-step`: no change in tokens read, so the spacing does not matter in a conversation of this length even for the lite model. The 8,192 default stays.
- `poll=0` and `threads=4`: no consistent gain (the lite model's second run had them slower than main), and the CPU seconds are not lower in any repeatable way. Left off.
- Decision: no default changed. The switch stays for a player or a later measurement on other hardware (an AMD or Intel card, an offloaded model), where `threads` and `poll` could differ.

## Measuring

`node scripts/Bench-LocalAiLaunch.mjs --engine <llama-server.exe> --model <gguf> --variants main,swaoff,kvq8,cms256,cms0,poll0,threads4,ub1024,bs --scenarios talk,switch,mixed --rounds 2 [--sliding]`

It starts one llama-server per variant (the real `buildServerArgs`, the real tuning module, the 64 MiB allocation environment), plays the same scripted conversation of Judy
(about 7,400 tokens of system message made by the real prompt builder, history growing by one exchange a turn, the right-now block changing once) and records, per request,
the first token time, the new and reused prompt tokens from llama-server's own timings, and the writing speed, and per variant the graphics memory taken, the load time and the
CPU seconds. Variants run round after round so a laptop that changes clocks hits all of them alike. It prints the power plan and whether the game is running. It stops each server
by pid. `--dry` prints the prompts' sizes and the command lines and starts nothing.

What would flip a default: `-cms` lower with fewer new tokens in the "mixed" scenario for the lite or Mature lite model and no slower first turn. `poll=0` or `threads=4` with
lower CPU seconds and the same writing speed. `ubatch=1024` or `bs` with a faster read or write on the 5090 at no memory cost. If nothing moves, the table above stands.

## Sources

- llama.cpp server README, flags and defaults: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- llama.cpp `tools/server/server-context.cpp` (checkpoint creation, the minimum step, restore threshold from the window size, cache reuse needs a cache that can shift): https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-context.cpp
- Sliding-window cache and checkpoints in llama.cpp (pull request 13194, the `--swa-full` note) and an explainer of why prompts are read again on SWA and hybrid models: https://particula.tech/blog/prompt-reprocessing-swa-hybrid-models-kv-cache
- Server refactor of the checkpoint logic (pull request 22114): https://github.com/ggml-org/llama.cpp/pull/22114
- KoboldCpp wiki (flash attention, ContextShift, SmartCache, `--useswa`, `--quantkv`, `--blasbatchsize`, threads): https://github.com/LostRuins/koboldcpp/wiki
- Gemma 4 multi-token prediction overview: https://ai.google.dev/gemma/docs/mtp/overview and a llama.cpp walkthrough: https://dev.to/everylocalai/how-to-get-2x-speed-on-gemma-4-with-multi-token-prediction-in-llamacpp-1b8e
- Vulkan against CUDA on NVIDIA: https://www.phoronix.com/news/NVIDIA-Vulkan-AI-ML-Success , https://github.com/ggml-org/llama.cpp/discussions/10879 , https://github.com/ggml-org/llama.cpp/issues/17273
- This project: docs/LOCAL_AI.md ("Judy's prompt was read again on every turn", "Stutter right after typing, second look", "The single slot", "A model load froze the game"),
  `deliverables/cuda-vs-vulkan-2026-10-20.md`.
