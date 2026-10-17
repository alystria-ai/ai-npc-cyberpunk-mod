# Bonsai 2 against the shipped Local AI models, 2026-10-17

Question: should PrismML's Bonsai 2 ternary models (released 2026-10-15 per the brief; the `prism-ml` repos were created 2026-09-23, Apache-2.0, Qwen3.5 derivatives)
replace the Local AI chat models (`docs/LOCAL_MODEL_CHOICE.md`) or the Mature packs? Developer-facing; nothing in `release.config.json`, the bridge or the
packs was changed. Same harness, prompts, rubric and judge as `LOCAL_MODEL_CHOICE.md`, run again now for every model so the comparison is like for like.

## Verdict

| Tier | Verdict | Why |
|---|---|---|
| **Lite (about 1.5 GB)** | **Switch: Qwen3.5-2B -> Bonsai 2 4B (`Q2_0`)** | Same VRAM (1.58 against 1.45 GB), same download (1.21 against 1.28 GB), same warm reply time (0.37-0.41 s against 0.32-0.42 s), and much better replies: overall 2.96 against 2.19, grounded 4.08 against 3.04, invented phrases 12 against 44. It runs on the shipped llama.cpp b11560 Vulkan build, no new runtime. Cost: the first turn of a character takes about 1.25 s instead of 0.52 s (slower prompt processing). |
| **Standard (about 3 GB)** | **Do not switch the 9B. Keep Gemma 4 E4B.** Bonsai 2 4B is an option only if VRAM matters more than grounding. | The 9B is 4x slower to decode on Vulkan (30 tokens/s, warm reply 1.2-1.4 s against 0.5 s) and does not score higher than Gemma (3.00 against 3.13; grounded 3.90 against 4.31). The 4B ties Gemma overall (2.96 against 3.13, inside the 0.3 noise) at half the VRAM (1.6 against 3.1 GB) and a quarter of the download, but it invents more (12 phrases against 3, grounded 4.08 against 4.31), uses the supplied context less (3.30 against 3.65) and answers Spanish worse (2.0 against 3.7). |
| **Mature lite / standard** | **No for both**, see "Mature" below | No credible uncensored Bonsai 2 at 9B or smaller runs on our runtime. Plain Bonsai does not refuse under the Mature layer, but the 4B is too tame and the 9B repeats "Fuck," as the first word of 46 of 72 replies. |
| **Bonsai 2 2B** | Not worth it | 2.06 overall, the same floor as Qwen3.5-2B (2.19), at 0.74 GB VRAM and 0.55 GB. Only useful if a half-gigabyte tier is ever wanted. |

## Compatibility

- **Repos (all official, `prism-ml`, Apache-2.0):** `Ternary-Bonsai-2-{9B,4B,2B}-gguf`, plus MLX versions (Mac) and a 27B. Each GGUF repo ships three packings of the
  same ternary weights: `PTQ1_0` (smallest), `PQ2_0` (their default) and `Q2_0`, an mmproj for vision, and optional MTP and DFlash2 draft files. The model card lists CUDA,
  Metal and CPU through PrismML's llama.cpp fork (`PrismML-Eng/llama.cpp`, branch `prism`); Vulkan is not mentioned.
- **Stock llama.cpp runs only `Q2_0`.** The card says upstream rejects `PQ2_0` and `PTQ1_0` as unknown types (open upstream issue ggml-org/llama.cpp#29058). I did not test
  those two files; they would need the fork. The smallest-file numbers in the brief (2.0 GB for the 9B, 0.95 GB for the 4B) are the `PTQ1_0` files, which are
  fork-only. The `Q2_0` files are 2.56 GB (9B), 1.21 GB (4B), 0.55 GB (2B).
- **Our shipped runtime loads and runs `Q2_0` on Vulkan.** llama-server b11560 (the one in the pack) loads all three, outputs coherent text, and was used for
  every number below. The newest official release (b11706, Vulkan x64, 32,258,914 bytes, SHA-256 `0a3cbd78a90b1a478470ef2eed1a24872625644b4f20fdabe5652cf13977d2fc`,
  downloaded to `bonsai-eval\llama-b11706-vulkan\`, not over the shipped one) loads them too and gave the same speeds, so no runtime bump is needed.
- **Other GPUs:** the 4B `Q2_0` also loads and gives coherent text on this laptop's Intel Raptor Lake iGPU through Vulkan (8-9 tokens/s, the same as Qwen3.5-2B Q4_K_M there).
  AMD was not tested. Note an open upstream report of wrong quantized results on one Adreno phone GPU (#30654), unrelated to desktop cards but a reminder that
  `Q2_0` on Vulkan is young.
- **Speed quirk:** the 9B decodes at 30 tokens/s while the 4B does 131 and the 2B 225 (the sizes would suggest about 65). b11560 and b11706 are equally slow. The likely cause is
  an open upstream item, "vulkan: FWHT kernels for block widths above 512" (#29772): the 9B's hidden size is 4096, the 4B's 2560. This is my reading of the issue title, not
  verified. If it gets fixed upstream the 9B could become fast.
- **Thinking:** Bonsai 2 keeps Qwen3.5's template with thinking on by default. The harness (like the bridge's `local-llm-server.mjs`, `--reasoning off`) turns it off, and
  every request also sent `enable_thinking: false`. No thinking leak appeared in any of the 240 replies.
- **Not needed:** the CUDA-only fork, vision (mmproj), MTP and DFlash2. The fork has a Windows Vulkan build (`prism-b10777-e3de715`, 31 MB) that I did **not** download
  (outside the approved downloads); it is the way to try `PTQ1_0`, `PQ2_0`, MTP and the LoRA adapters below.

## Method

Exactly `LOCAL_MODEL_CHOICE.md`: six characters, 24 turns, the bridge's own prompt modules (working tree of 2026-10-17, so the prompt may differ slightly from the
2026-10-12 run), stable-first layout, Natural speech and Expressive emotions on, `llama-server` b11560 Vulkan `-ngl 99 -fa on -c 8192 -np 1 --reasoning off --cache-ram 1024`,
temperature 0.65, first attempt with no retry, one warm-up pass, two timed runs per model (48 replies). One model at a time on the RTX 4080 Laptop (12 GB), game
and bridge closed, 413-445 MiB used by the desktop before each load (GPU clocks reached 2,400 MHz at 120-160 W, so the laptop was not in Silent). Three blind Haiku
judges, 80 replies each (240 replies, five models mixed and shuffled, names hidden), the same five criteria and 1-5 scale. Gemma 4 E4B and Qwen3.5-2B were re-measured in the
same session (3.13 against 3.04 before, 2.19 against 2.33 before: inside the noise, so the scale holds). The judge prompt was rewritten from the old doc's description, not
reused verbatim.

Sampling note: every model got the harness's temperature 0.65. Bonsai's card suggests 0.7 / top_p 0.8 / top_k 20 / presence penalty 1.5 for non-thinking use; that was not tried.

## Scores (Haiku, 1-5, 48 replies per model)

| Model | Voice | Context | Grounded | Identity | Language | **Overall** | Run 1 / run 2 | Invented phrases | Replies grounded 3 or less | Overall 2 or less |
|---|---|---|---|---|---|---|---|---|---|---|
| **Gemma 4 E4B** (Standard now) | 3.10 | **3.65** | **4.31** | 5.00 | 4.54 | **3.13** | 3.08 / 3.17 | **3** | **5** | 11 |
| Bonsai 2 9B | **3.25** | 3.15 | 3.90 | 4.98 | 4.54 | 3.00 | 3.17 / 2.83 | 17 | 16 | 14 |
| Bonsai 2 4B | 3.19 | 3.30 | 4.08 | 5.00 | 4.33 | 2.96 | 2.79 / 3.13 | 12 | 13 | 15 |
| Qwen3.5-2B (Lite now) | 2.88 | 2.50 | 3.04 | 4.63 | 4.25 | 2.19 | 2.04 / 2.33 | 44 | 33 | 33 |
| Bonsai 2 2B | 2.63 | 2.10 | 3.23 | 4.83 | 4.25 | 2.06 | 2.08 / 2.04 | 25 | 26 | 38 |

Trust: two runs of the same model differ by up to 0.34 (Bonsai 4B), so Gemma, the 9B and the 4B are tied overall; the real gaps are Gemma's grounded lead (+0.2 to +0.4) and invention
count, and the 0.75 or more by which the 4B and 9B beat both 2B models. Gemma and Qwen 2B were judged in the same batches as Bonsai, so those gaps are like for like.

Overall score by turn kind (4 to 12 replies per cell, rough):

| Model | Small talk | Context question | Memory | "Are you an AI?" | Emotional | Combat | Spanish | Japanese |
|---|---|---|---|---|---|---|---|---|
| Gemma 4 E4B | 3.17 | 3.63 | 3.33 | 3.17 | 2.83 | 3.17 | 3.17 | 2.00 |
| Bonsai 2 9B | 3.33 | 2.75 | 3.00 | 3.50 | 3.00 | 3.67 | 2.67 | 1.75 |
| Bonsai 2 4B | 3.00 | 3.13 | 3.00 | 3.83 | 3.33 | 2.67 | 2.33 | 2.00 |
| Qwen3.5-2B | 2.50 | 2.25 | 2.33 | 2.33 | 2.17 | 2.50 | 1.67 | 1.50 |
| Bonsai 2 2B | 2.67 | 1.88 | 2.17 | 2.17 | 2.00 | 2.33 | 1.83 | 1.25 |

Spanish language score: Gemma 3.67, Bonsai 9B 3.67, Bonsai 4B 2.00, Qwen 2B 1.33, Bonsai 2B 1.33. Japanese: every model about 1.5 (all answered in English, as before).

Automatic checks (48 replies each, first attempt):

| Check | Gemma 4 E4B | Bonsai 9B | Bonsai 4B | Qwen3.5-2B | Bonsai 2B |
|---|---|---|---|---|---|
| Thinking leaks, "as an AI", prompt echo, errors, empty | 0 | 0 | 0 | 0 | 0 |
| More than 3 sentences (the host caps and retries) | 0 | 1 | 11 | 32 | 17 |
| Stray tag-like groups cleaned by the bridge | 0 | 4 | 0 | 0 | 1 |
| Speaker label at the start | 0 | 1 | 0 | 0 | 0 |
| Replies that wrote any emotion tag | 47 | 46 | 45 | 29 | 9 |
| Mean words per reply | 22.7 | 20.9 | 21.4 | 33.2 | 25.9 |
| Wrong language (heuristic, Spanish/Japanese turns) | 6 | 5 | 9 | 10 | 10 |

The 4B writes emotion tags as often as Gemma (45 of 48), where Qwen 2B writes them in 29 and Bonsai 2B in 9, so faces would be as lively as on the Standard tier. No model broke character.

What the 4B replies look like (run 1, tags stripped, Haiku overall in brackets):
- Judy, "what is the plan and where are we?": Gemma (4) "The plan is to meet at the Clouds basement... We're out in Japantown right now." Bonsai 4B (3) "We're in Japantown, Westbrook, meeting you at Clouds' basement. The plan is to finish that edit and get you out of this mess." Qwen 2B (1) "I'm at Japantown, fixing up some old equipment. The job is a standard Clouds project for now, but you're asking about the plan?" Bonsai 9B (2) "The plan is to get the Mox out of the mess..."
- Johnny, seeded memory: Gemma (4) and Bonsai 9B (4) repeat the Kabuki apartment; Bonsai 4B (3) "Quiet apartment in Kabuki. Leave the noise behind."; Qwen 2B (2) "You told me to leave Kabuki, but you're still here, stuck in this loop."
- Vendor, "do you remember my name?" (V said Dex): Bonsai 9B (3) "Yeah, Dex. I heard you say it loud enough to cut through the noise." Gemma (2), Bonsai 4B (2) and Qwen 2B (1) all say they do not remember.

## Latency, VRAM, load (warm GPU, game closed, balanced-or-faster power)

Stable layout, both runs together. "Warm" = turns 2-4 of a character.

| Model | File | Load to ready | VRAM added | Server RAM | Warm first token | Warm full reply (median, p90) | Decode | First turn of a character (4.4k tokens) |
|---|---|---|---|---|---|---|---|---|
| Gemma 4 E4B | 5.15 GB | 4.7 s | 3.09 GB | 4.0 GB | 0.15 s | 0.51-0.55 s, p90 0.64 | 87 tok/s | 1.0-1.1 s |
| Bonsai 2 9B Q2_0 | 2.56 GB | 3.8 s | 2.75 GB | 3.8 GB | 0.31 s | **1.21-1.36 s, p90 1.7** | **30 tok/s** | **2.6-2.7 s** |
| Bonsai 2 4B Q2_0 | 1.21 GB | 2.5 s | 1.58 GB | 2.7 GB | 0.16 s | 0.37-0.41 s, p90 0.52 | 131 tok/s | 1.2-1.3 s |
| Qwen3.5-2B Q4_K_M | 1.28 GB | 1.9 s | 1.45 GB | 2.5 GB | 0.09 s | 0.32-0.42 s, p90 0.4-0.5 | 172 tok/s | 0.52 s |
| Bonsai 2 2B Q2_0 | 0.55 GB | 1.9 s | 0.74 GB | 1.8 GB | 0.09 s | 0.21-0.26 s, p90 0.29 | 225 tok/s | 0.55 s |

- VRAM added = peak during the runs (8,192 context, one slot) minus the desktop's use before the load (in GB = MiB / 1000, the earlier doc's convention; the 9B was 2,752 MiB, the 4B 1,583 MiB).
- Prefix cache: 96-97% reuse on every model (the hybrid Qwen3.5 layout is unchanged by the ternary weights), 105-136 new tokens per warm turn.
- Latency is the 4B's one cost against the 2B it would replace: the first turn of a character (about 4,400 tokens of persona) is 1.2-1.3 s against 0.5 s. Prewarm on invitation hides it; the warm turns are equal.
- FPS: not measured (no game was run). The GPU burst per reply is the warm full reply time: 0.37-0.41 s for the 4B, 0.32-0.42 s for Qwen 2B, 0.51-0.55 s for Gemma, 1.2-1.4 s for the 9B (mean busy power 120 W, 129 W, 129 W and 124 W, so no extra draw per second; the 9B just holds the GPU about 3x longer than Gemma). The 4B tier fits beside OmniVoice where Gemma did not: LLM 1.6 GB instead of 3.1 GB (`LOCAL_MODEL_CHOICE.md`, "VRAM with OmniVoice").

## Pins to use if you switch

Verified against the Hugging Face API (LFS SHA-256) and by `sha256sum` of the downloaded files (all matched). Files in `E:\CyberpunkConvai-offload\work\bonsai-eval\dl-{9b,4b,2b}\`.

Lite tier (the switch):
```json
"lite": {
  "name": "Bonsai 2 4B",
  "repository": "prism-ml/Ternary-Bonsai-2-4B-gguf",
  "revision": "8d6557168168f91ea6697a4a49ed2ef622b53adb",
  "file": "Ternary-Bonsai-2-4B-Q2_0.gguf",
  "size": 1212103520,
  "sha256": "64a5183b44921bdb5ac4a6f5f92007821d6ebe5c66997d3c147fd214ab9433d4",
  "local": "dl-bonsai2-4b/Ternary-Bonsai-2-4B-Q2_0.gguf",
  "license": "Apache-2.0"
}
```
Not switched, for reference:

| Model | Repository | Revision | File | Size | SHA-256 |
|---|---|---|---|---|---|
| Bonsai 2 9B | `prism-ml/Ternary-Bonsai-2-9B-gguf` | `5b2abb02362efbed46bbe204014b02837778b2c2` | `Ternary-Bonsai-2-9B-Q2_0.gguf` | 2556640128 | `1f884aa56aacd2bbbb2e4b7abaead2b1102b74a9c75a23fc33dab916813a384d` |
| Bonsai 2 2B | `prism-ml/Ternary-Bonsai-2-2B-gguf` | `683f7be2629342a50987627b40881e54761a2430` | `Ternary-Bonsai-2-2B-Q2_0.gguf` | 546689504 | `c2893fa6f951daee8b7263d5f49b455e57989ef56417a22125b03566dc560650` |

If the lite tier moves to Bonsai 4B:
- Keep the pinned llama-server b11560; nothing else in the pack changes. The pack builder text still names Qwen3.5-2B in `packaging/build-release.mjs` (a header comment and
  the generated pack notes at line 711, which links `huggingface.co/Qwen/Qwen3.5-2B`), and docs (`LOCAL_AI.md`, `LOCAL_MODEL_CHOICE.md`) describe the lite tier as a 2B.
- The lite tier's budget is then about 1.6 GB (was 1.45 GB); `LOCAL_MODEL_CHOICE.md` called the tier "about 1.5 GB".
- Run the unit tests on the model-name lookups (`bridge/local-model-choice.test.mjs`, `local-ai-pack.test.mjs`) and re-judge after layout changes, as the earlier doc's follow-ups say.
- Before shipping, run the 4B once on an AMD Vulkan card. Intel and NVIDIA were checked; AMD was not.

## Mature

Brief: could Bonsai 2 (or an uncensored variant) replace the Mature packs (Mature lite: Qwen3.5-4B Uncensored HauhauCS Aggressive Q4_K_M, 2.71 GB; Mature standard:
Gemma 4 E4B MiniFantasy Q4_K_M, 5.34 GB)? Per the later instruction, only whether the model plays along, stays in character, gets the crude style right, and latency and VRAM
were measured here. The filter was not tested (it does not depend on the model).

**Uncensored Bonsai 2 variants on Hugging Face (searched 2026-10-17).** Almost all are 27B (Heretic and abliterated builds from OS-Software, BoldingBuilds, Hikari07jp; the most
downloaded has 211k downloads), a 27B file is far above the 2.5 GB limit and was not downloaded. At 9B or smaller the only Bonsai 2 option is AtomicChat's
"Uncensored LoRA" set (`AtomicChat/Ternary-Bonsai-2-{2B,4B,9B}-Uncensored-LoRA-GGUF`, created 2026-10-15; 18, 18 and 32 downloads, 0-1 likes; AtomicChat itself is an established
uploader with many popular repos). Each is a 1-3 MB rank-1 adapter that removes a "refusal direction" from the PrismML `PTQ1_0` pack at inference time. I downloaded the 4B adapter (the one
extra variant allowed): `AtomicChat/Ternary-Bonsai-2-4B-Uncensored-LoRA-GGUF`, revision `e90dcac166a947ddeb9375f72021ce8b4958d39a`, `Ternary-Bonsai-2-4B-Uncensored-LoRA.gguf`, 2,368,992 bytes,
SHA-256 `605e9dfba951a2ddd86b4975fcb2d064cebb6a284ebec396d5b93d58710138a9`.
**It does not load on our runtime**: both b11560 and b11706 stop with "LoRA tensor 'blk.0.ffn_down.weight' targets a prism.hadamard folded weight, which is not supported". It needs the PrismML
fork (which I did not download) and, per its card, the `PTQ1_0` base (also fork-only). So no variant could be measured. The adapter's own card says "research-grade".
(The result file `bonsai2-4b-lora` is NOT a LoRA run: the first attempt passed the argument wrongly and the adapter was never applied; it is a second sample of the plain 4B and is used below only as a repeat.)

**What plain Bonsai does under the Mature layer** (`scripts/Eval-MatureSamples.mjs --set brief --n 3`, the real layer and prompt, 72 replies per model, same machine, same session for
all four; Mature lite and standard re-run now because the prompt moved since round 3):

| Model | Crude word, adult prompts (of 36) | Crude word, neutral prompts (of 36) | Graphic, adult (of 36) | In-character deflection, adult | Strong words / reply | Replies opening with a swear word (of 72) | Words / reply |
|---|---|---|---|---|---|---|---|
| Gemma-4-E4B MiniFantasy (Mature standard now) | 32 | 14 | 5 | 1 | 0.90 | 1 | 37 |
| Qwen3.5-4B HauhauCS (Mature lite now) | 22 | 22 | 13 | 8 | 0.78 | 12 | 51 |
| Bonsai 2 9B | **34** | **28** | 6 | 8 | **1.19** | **50** | 29 |
| Bonsai 2 4B (two samples) | 10 and 12 | 16 and 14 | 1 and 0 | 13 and 14 | 0.43 and 0.35 | 7 | 30 |

Speed on the real 4,400-token prompt (median of 3, 90 tokens; GPU otherwise idle): Gemma MiniFantasy cold 1,194 ms, warm 108 ms, 81 tok/s; HauhauCS cold 1,183 ms, warm 159 ms, 89 tok/s;
Bonsai 9B cold 2,807 ms, warm 272 ms, **29.5 tok/s**; Bonsai 4B cold 1,129 ms, warm 149 ms, 133 tok/s. VRAM (same model and context, from the table above): 9B 2.75 GB, 4B 1.58 GB; the two
current Mature models were not re-measured here (files 5.34 GB and 2.71 GB).

- **Refusals: none.** 144 replies from the 4B and 9B contain no out-of-character refusal ("I can't", "as an AI"): the one regex hit is a swear plus "can't complain". Bonsai 2 is not safety-tuned
  against this layer, so an uncensored variant is not needed to make it play along. What it does is deflect in character ("I'm not taking you to bed. I don't do that kind of stuff"): 13-14 of 36 adult
  prompts for the 4B, against 8 for HauhauCS and 1 for MiniFantasy.
- **4B: too tame.** Crude word in 10-12 of 36 adult prompts (22 for HauhauCS, 32 for MiniFantasy), 0-1 graphic. It stays in voice but does not get the crude register, so it is not a Mature lite
  replacement. Its replicates agree, so this is not noise.
- **9B: crude but monotone.** It matches MiniFantasy on crude words (34 of 36, and 28 of 36 on neutral prompts, which is where the always-crude prompt should bite) but opens 46 of 72 replies with
  the word "Fuck" (50 of 72 with any swear) ("Fuck, it was pretty boring until I got bored enough to actually fuck something interesting." to "How was your day?"). That is the layer's word list taken literally and is
  not a style the player would want for 72 replies a day; replies are short (29 words), stay in character otherwise, and graphic count is middling (6). It is 2.5x slower to a warm first token than
  MiniFantasy and 2.7x slower to decode (30 against 81 tok/s), and takes 2.75 GB of VRAM; the download is 2.56 GB against 5.34 GB.
- **Verdict: no for Mature lite, no for Mature standard.** The 4B is not crude enough; the 9B is crude enough but its "Fuck," opener and 30 tok/s on Vulkan are worse than MiniFantasy on the
  Standard slot. The 9B is the only part worth a follow-up: a layer line that forbids opening with a swear word, re-sampled, could make it a smaller (2.56 GB against 5.34 GB) Mature standard, and
  the 30 tok/s may improve when upstream Vulkan handles the 4096-wide Hadamard blocks. That was not tried. The LoRA route needs the PrismML fork's Vulkan build and the `PTQ1_0` base: if you
  want it measured, approve those downloads (31 MB fork Vulkan build, 0.95 GB 4B `PTQ1_0`).

## Limits

- 48 judged replies per model, one judge model (rewritten prompt), temperature 0.65: treat differences under about 0.3 as noise. The scale held across the two sessions (Gemma 3.04 then 3.13; Qwen 2B 2.33 then 2.19).
- Only the `Q2_0` packing was run. `PQ2_0` and `PTQ1_0` are smaller or faster on the fork but cannot run on stock llama.cpp.
- Game closed, so no FPS or in-game VRAM figure; AMD GPUs untested; Japanese is English for every model (fix with the language note proposed earlier).
- The Mature figures are keyword counts over 72 replies per model, plus reading; they undercount phrases.

## Files

Raw results, server logs, judge batches and scores are in `E:\CyberpunkConvai-offload\work\bonsai-eval\` (`results\step1\*.json`, `results\step1\judge\`, `results\mature\`, `results\sha256.txt`). The harness
copies are in `scripts/bonsai-eval/` (`bench24.mjs` is the old harness with `--exe` and a new output folder; `run-step1.sh`, `run-mature.sh`, `quick.sh`, `build-judge.mjs`, `scores.mjs`, `aggregate.mjs`).
The downloaded files sit under `E:\CyberpunkConvai-offload\work\bonsai-eval\` as untrusted data: `dl-9b`, `dl-4b`, `dl-2b`, `dl-lora-4b`, `dl-llama` (b11706 zip) and `llama-b11706-vulkan`. Every `llama-server` this
work started has exited.
